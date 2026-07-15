import type { GameConfig, StructKindConfig } from '../../config';
import { secToTicks } from '../../config';
import type { MapData } from '../../map/types';
import { isWalkBlocked, tileIndex } from '../../map/types';
import type { SimEvent } from '../events';
import type { Structure, StructureKind, World } from '../world';
import {
  ATK_IDLE,
  BTN_BUILD,
  BTN_BUILD_GATE,
  BTN_BUILD_TOWER,
  BTN_BUILD_TRAP,
  PHASE_LIVE,
  STRUCT_GATE,
  STRUCT_TOWER,
  STRUCT_TRAP,
  STRUCT_WALL,
} from '../world';
import { applyDamage } from './combat';

// Structures: placeable, destroyable, grid-occupying entities. M4 s1 shipped
// walls; s3 adds the Engineer's gate (a door for the owning squad's bodies —
// a wall for everyone else's, and for ALL vision/arrows) and watchtower (a
// static extra viewer — information, never damage). Occupancy splits in two:
//   buildOccupancy     — the FULL set; vision rays, projectiles, melee LOS.
//   moveOccupancyFor   — per squad; excludes that squad's own living gates.
// Both are derived fresh from world.structures, and the client rebuilds the
// identical sets from its snapshot, so gate-walking predicts bit-exactly.
// s4 traps are in NEITHER set: a trap blocks nothing and occludes nothing —
// an enemy must be able to walk onto it (that's the whole point), and a tile
// you can stand on must never eat arrows or sight lines. Keeping traps out of
// both sets is also what keeps prediction honest: enemies never receive traps
// in their snapshot, so a trap that collided would desync every client.
//
// Build supply is a per-squad resource, NOT gold: it can never touch the score
// ledger (design §9.4). A living keep trickles it; the keep's death stops the
// tap. Placements AND repairs spend it — a pure sink (no refunds).

/** The vision/combat blocker layer: tile indices occupied by a live structure. */
export type Occupancy = ReadonlySet<number>;

/** Rebuild the full occupancy set from every standing structure (traps never
 *  block or occlude — see the header note). */
export function buildOccupancy(world: World, width: number): Set<number> {
  const occ = new Set<number>();
  for (const s of world.structures.values()) {
    if (s.hp > 0 && s.kind !== STRUCT_TRAP) occ.add(s.ty * width + s.tx);
  }
  return occ;
}

/** Movement blockers for ONE squad: everything except its own living gates
 *  (a door for your bodies, a wall for theirs) — and traps, which block nobody. */
export function moveOccupancyFor(world: World, width: number, squad: number): Set<number> {
  const occ = new Set<number>();
  for (const s of world.structures.values()) {
    if (s.hp <= 0 || s.kind === STRUCT_TRAP) continue;
    if (s.kind === STRUCT_GATE && s.squad === squad) continue;
    occ.add(s.ty * width + s.tx);
  }
  return occ;
}

/** Standing structures of one kind a squad owns (per-kind caps count these). */
export function structCount(world: World, squadId: number, kind: StructureKind): number {
  let n = 0;
  for (const s of world.structures.values()) {
    if (s.squad === squadId && s.kind === kind && s.hp > 0) n++;
  }
  return n;
}

export function structKindConfig(cfg: GameConfig, kind: StructureKind): StructKindConfig {
  return kind === STRUCT_WALL
    ? cfg.build.wall
    : kind === STRUCT_GATE
      ? cfg.build.gate
      : kind === STRUCT_TOWER
        ? cfg.build.tower
        : cfg.build.trap;
}

/**
 * The single entry point for structure damage — mirrors damageKeep. On death a
 * structure leaves the world and emits a positional event; no under-attack
 * alarm (structures are expendable, the keep alarm is the one that matters).
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

/** The tile a builder is aiming at: one build-reach step along the aim vector. */
export function buildTargetTile(
  cfg: GameConfig,
  x: number,
  y: number,
  ax: number,
  ay: number,
): { tx: number; ty: number } {
  const reach = cfg.build.reach;
  return { tx: Math.floor(x + ax * reach), ty: Math.floor(y + ay * reach) };
}

/**
 * Is the target tile a legal build site (any kind)? Rejects: solid terrain
 * (#/~/OOB), forest, an existing structure (the direct scan also covers
 * traps, which the occupancy set deliberately omits), a keep site or town
 * tile, the exclusion zone around any enemy keep, and any tile a living
 * player currently stands on (building must never trap someone — walls, that
 * is; actual traps don't block).
 */
export function canBuildStructAt(
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
  if (structureAt(world, tx, ty)) return false;

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

/** Live structure on this exact tile, if any. */
export function structureAt(world: World, tx: number, ty: number): Structure | null {
  for (const s of world.structures.values()) {
    if (s.hp > 0 && s.tx === tx && s.ty === ty) return s;
  }
  return null;
}

/** The build intents, in priority order (a tick with several bits pressed
 *  takes the first that's legal). Gate/tower/trap are the Engineer's trade. */
const BUILDABLES: ReadonlyArray<{ btn: number; kind: StructureKind; engineerOnly: boolean }> = [
  { btn: BTN_BUILD, kind: STRUCT_WALL, engineerOnly: false },
  { btn: BTN_BUILD_GATE, kind: STRUCT_GATE, engineerOnly: true },
  { btn: BTN_BUILD_TOWER, kind: STRUCT_TOWER, engineerOnly: true },
  { btn: BTN_BUILD_TRAP, kind: STRUCT_TRAP, engineerOnly: true },
];
const BUILD_MASK = BTN_BUILD | BTN_BUILD_GATE | BTN_BUILD_TOWER | BTN_BUILD_TRAP;

/**
 * Armed-trap trigger scan: the first enemy standing inside an armed trap's
 * trigger circle trips it. The trap is CONSUMED (one bite, no damageStructure
 * detour — a trigger is not a destruction), the victim takes shield-bypassing
 * damage credited to the builder (an Engineer's trap kill pays like any kill),
 * and gets rooted — the kernel pins them, prediction included. One victim per
 * trap: the snare closes on a leg, not a squad.
 */
function stepTrapTriggers(world: World, cfg: GameConfig, events: SimEvent[]): void {
  const trap = cfg.build.trap;
  const armTicks = secToTicks(cfg, trap.armSec);
  const rootTicks = secToTicks(cfg, trap.rootSec);
  const r2 = trap.triggerRadius * trap.triggerRadius;
  for (const s of world.structures.values()) {
    if (s.kind !== STRUCT_TRAP || s.hp <= 0) continue;
    if (world.tick < s.bornTick + armTicks) continue;
    const cx = s.tx + 0.5;
    const cy = s.ty + 0.5;
    for (const p of world.players.values()) {
      if (!p.alive || p.squad === s.squad) continue;
      const dx = p.x - cx;
      const dy = p.y - cy;
      if (dx * dx + dy * dy > r2) continue;
      world.structures.delete(s.id);
      p.rootTicks = rootTicks;
      p.dashTicks = 0; // the snare ends a dash mid-flight
      events.push({
        k: 'trapTriggered',
        tk: world.tick,
        id: s.id,
        squad: s.squad,
        victim: p.id,
        x: cx,
        y: cy,
      });
      // Builder gone (left the match) => ownerless bite: full damage, no credit.
      const builder = world.players.get(s.by) ?? null;
      applyDamage(world, cfg, builder, p, trap.damage, 'trap', events);
      break;
    }
  }
}

/**
 * Trap triggers + supply generation + build placement + repair. Runs after
 * movement AND pushout (a shove onto a trap tile trips it) and mutates the
 * passed occupancy set as pieces go up, so two squadmates can't both drop
 * one on the same tile in one tick.
 */
export function stepStructures(
  world: World,
  cfg: GameConfig,
  map: MapData,
  occ: Set<number>,
  events: SimEvent[],
): void {
  // ---- traps bite first: positions are final for this tick, and a trap
  // placed later this tick can't fire anyway (it still has to arm).
  if (world.phase === PHASE_LIVE) stepTrapTriggers(world, cfg, events);

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

  const cdTicks = secToTicks(cfg, cfg.build.cooldownSec);
  for (const p of world.players.values()) {
    if (p.buildCd > 0) p.buildCd--;
    const pressed = p.input.b & BUILD_MASK & ~(p.prevBuildB & BUILD_MASK);
    p.prevBuildB = p.input.b;
    if (pressed === 0 || !p.alive || world.phase !== PHASE_LIVE) continue;
    if (p.buildCd > 0 || p.dashTicks > 0 || p.atkPhase !== ATK_IDLE) continue;
    const squad = world.squads[p.squad];
    if (!squad) continue;
    const { tx, ty } = buildTargetTile(cfg, p.x, p.y, p.input.ax, p.input.ay);

    // ---- repair: ANY build press aimed at a damaged OWN structure patches it
    // (doc §9.1: every class does basic repairs; the Engineer does them 2x).
    const target = structureAt(world, tx, ty);
    if (target && target.squad === p.squad) {
      if (target.hp >= target.maxHp || squad.supply < cfg.build.repair.cost) continue;
      const factor = p.cls === 'engineer' ? cfg.build.repair.engineerFactor : 1;
      const heal = Math.min(cfg.build.repair.hpPerHit * factor, target.maxHp - target.hp);
      target.hp += heal;
      squad.supply -= cfg.build.repair.cost;
      p.buildCd = cdTicks;
      events.push({
        k: 'structRepaired',
        tk: world.tick,
        id: target.id,
        squad: p.squad,
        by: p.id,
        hp: target.hp,
        x: tx + 0.5,
        y: ty + 0.5,
      });
      continue;
    }

    // ---- placement: first pressed intent this player may legally afford.
    for (const b of BUILDABLES) {
      if ((pressed & b.btn) === 0) continue;
      if (b.engineerOnly && p.cls !== 'engineer') continue;
      const kindCfg = structKindConfig(cfg, b.kind);
      if (squad.supply < kindCfg.cost) continue;
      if (structCount(world, p.squad, b.kind) >= kindCfg.maxCount) continue;
      if (!canBuildStructAt(world, cfg, map, occ, p.squad, tx, ty)) continue;

      squad.supply -= kindCfg.cost;
      p.buildCd = cdTicks;
      const st: Structure = {
        id: world.nextId++,
        kind: b.kind,
        squad: p.squad,
        by: p.id,
        tx,
        ty,
        hp: kindCfg.hp,
        maxHp: kindCfg.hp,
        bornTick: world.tick,
      };
      world.structures.set(st.id, st);
      // Traps stay out of the blocker layer — everything else blocks now.
      if (b.kind !== STRUCT_TRAP) occ.add(tileIndex(map, tx, ty));
      events.push({
        k: 'structBuilt',
        tk: world.tick,
        id: st.id,
        squad: p.squad,
        kind: b.kind,
        x: tx + 0.5,
        y: ty + 0.5,
      });
      break;
    }
  }
}
