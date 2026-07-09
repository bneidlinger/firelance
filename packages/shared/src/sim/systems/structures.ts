import type { GameConfig } from '../../config';
import { secToTicks } from '../../config';
import type { MapData } from '../../map/types';
import { isWalkBlocked, tileIndex } from '../../map/types';
import type { SimEvent } from '../events';
import type { Structure, World } from '../world';
import { ATK_IDLE, BTN_BUILD, PHASE_LIVE, STRUCT_WALL } from '../world';

// Structures: the first placeable, destroyable, grid-occupying entities in the
// game (walls now; gates/towers/traps land in later M4 slices). They join TWO
// grids the sim already had — movement collision and vision rays — through one
// derived tile-occupancy set the server rebuilds each tick and the client
// rebuilds from its snapshot, so wall prediction is bit-identical for free.
//
// Build supply is a per-squad resource, NOT gold: it can never touch the score
// ledger (design §9.4). A living keep trickles it; the keep's death stops the
// tap. The pool is a pure sink — supply spent into a wall is gone (no refund).

/** The movement+vision blocker layer: tile indices occupied by a live structure. */
export type Occupancy = ReadonlySet<number>;

/** Rebuild the occupancy set from every standing structure. Cheap (O(structures)). */
export function buildOccupancy(world: World, width: number): Set<number> {
  const occ = new Set<number>();
  for (const s of world.structures.values()) {
    if (s.hp > 0) occ.add(s.ty * width + s.tx);
  }
  return occ;
}

/** How many standing walls a squad owns (the fortress-spam cap counts these). */
export function wallCount(world: World, squadId: number): number {
  let n = 0;
  for (const s of world.structures.values()) {
    if (s.squad === squadId && s.kind === STRUCT_WALL && s.hp > 0) n++;
  }
  return n;
}

/**
 * The single entry point for structure damage — mirrors damageKeep. On death a
 * structure leaves the world and emits a positional event; no under-attack
 * alarm (walls are cheap and expendable, the keep alarm is the one that matters).
 */
export function damageStructure(
  world: World,
  s: Structure,
  amount: number,
  events: SimEvent[],
): void {
  if (s.hp <= 0 || amount <= 0) return;
  s.hp -= amount;
  if (s.hp > 0) return;
  s.hp = 0;
  world.structures.delete(s.id);
  events.push({
    k: 'structDestroyed',
    tk: world.tick,
    id: s.id,
    squad: s.squad,
    kind: s.kind,
    x: s.tx + 0.5,
    y: s.ty + 0.5,
  });
}

/**
 * Enemy structures whose tile the blast circle (center x,y radius reach)
 * overlaps — precise circle-vs-tile-AABB, mirrors keepsInRange. Own structures
 * are spared (friendly fire is off for buildings too).
 */
export function structuresInRange(
  world: World,
  x: number,
  y: number,
  reach: number,
  attackerSquad: number,
): Structure[] {
  const hit: Structure[] = [];
  const r2 = reach * reach;
  for (const s of world.structures.values()) {
    if (s.squad === attackerSquad || s.hp <= 0) continue;
    // Closest point on the tile AABB [tx,tx+1]×[ty,ty+1] to the blast center.
    const nx = x < s.tx ? s.tx : x > s.tx + 1 ? s.tx + 1 : x;
    const ny = y < s.ty ? s.ty : y > s.ty + 1 ? s.ty + 1 : y;
    const dx = x - nx;
    const dy = y - ny;
    if (dx * dx + dy * dy <= r2) hit.push(s);
  }
  return hit;
}

/** The tile a builder is aiming at: one buildReach step along the aim vector. */
export function buildTargetTile(
  cfg: GameConfig,
  x: number,
  y: number,
  ax: number,
  ay: number,
): { tx: number; ty: number } {
  const reach = cfg.build.wall.buildReach;
  return { tx: Math.floor(x + ax * reach), ty: Math.floor(y + ay * reach) };
}

/**
 * Is the target tile a legal wall site? Rejects: solid terrain (#/~/OOB),
 * forest, an existing structure, a keep site or town tile, the exclusion zone
 * around any enemy keep, and any tile a living player currently stands on
 * (building must never trap someone).
 */
export function canBuildWallAt(
  world: World,
  cfg: GameConfig,
  map: MapData,
  occ: Occupancy,
  squadId: number,
  tx: number,
  ty: number,
): boolean {
  if (isWalkBlocked(map, tx, ty)) return false;
  const ti = tileIndex(map, tx, ty);
  if (map.forest[ti] === 1) return false;
  if (occ.has(ti)) return false;

  for (const s of world.squads) {
    if (s.keepHp > 0 && Math.floor(s.keepX) === tx && Math.floor(s.keepY) === ty) return false;
  }
  for (const t of map.towns) {
    if (Math.floor(t.x) === tx && Math.floor(t.y) === ty) return false;
  }

  const ex = cfg.build.enemyKeepExclusion;
  const ex2 = ex * ex;
  const cx = tx + 0.5;
  const cy = ty + 0.5;
  for (const s of world.squads) {
    if (s.id === squadId || s.keepHp <= 0) continue;
    const dx = s.keepX - cx;
    const dy = s.keepY - cy;
    if (dx * dx + dy * dy < ex2) return false;
  }

  for (const p of world.players.values()) {
    if (p.alive && Math.floor(p.x) === tx && Math.floor(p.y) === ty) return false;
  }
  return true;
}

/**
 * Supply generation + build placement. Runs after banking (build is another
 * stand-and-interact action) and mutates the passed occupancy set as walls go
 * up so two squadmates can't both drop a wall on the same tile in one tick.
 */
export function stepStructures(
  world: World,
  cfg: GameConfig,
  map: MapData,
  occ: Set<number>,
  events: SimEvent[],
): void {
  // ---- supply: a living keep trickles into its squad's pool, clamped to cap.
  if (world.phase === PHASE_LIVE) {
    const perTick = cfg.build.supplyPerSec / cfg.tick.simHz;
    const cap = cfg.build.supplyCap;
    for (const s of world.squads) {
      if (s.keepHp <= 0 || s.supply >= cap) continue;
      const add = Math.min(perTick, cap - s.supply);
      s.supply += add;
      s.supplyMinted += add;
    }
  }

  // ---- build intent: edge-triggered, gated like a bomb throw (alive, live,
  // idle, off cooldown, affordable, under the cap, on a legal tile).
  const wall = cfg.build.wall;
  const cdTicks = secToTicks(cfg, wall.buildCooldownSec);
  for (const p of world.players.values()) {
    if (p.buildCd > 0) p.buildCd--;
    const rising = (p.input.b & BTN_BUILD) !== 0 && (p.prevBuildB & BTN_BUILD) === 0;
    p.prevBuildB = p.input.b;
    if (!rising || !p.alive || world.phase !== PHASE_LIVE) continue;
    if (p.buildCd > 0 || p.dashTicks > 0 || p.atkPhase !== ATK_IDLE) continue;
    const squad = world.squads[p.squad];
    if (!squad || squad.supply < wall.cost || wallCount(world, p.squad) >= wall.maxCount) continue;
    const { tx, ty } = buildTargetTile(cfg, p.x, p.y, p.input.ax, p.input.ay);
    if (!canBuildWallAt(world, cfg, map, occ, p.squad, tx, ty)) continue;

    squad.supply -= wall.cost;
    p.buildCd = cdTicks;
    const st: Structure = {
      id: world.nextId++,
      kind: STRUCT_WALL,
      squad: p.squad,
      tx,
      ty,
      hp: wall.hp,
      maxHp: wall.hp,
    };
    world.structures.set(st.id, st);
    occ.add(tileIndex(map, tx, ty));
    events.push({
      k: 'structBuilt',
      tk: world.tick,
      id: st.id,
      squad: p.squad,
      kind: STRUCT_WALL,
      x: tx + 0.5,
      y: ty + 0.5,
    });
  }
}
