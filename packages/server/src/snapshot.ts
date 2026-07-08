import type { GameConfig } from '@shared/config';
import { getKit } from '@shared/config';
import type { MapData } from '@shared/map/types';
import type { EntitySnap, SackSnap, YouSnap } from '@shared/net/messages';
import {
  ST_ACTIVE,
  ST_BANKING,
  ST_BLOCKING,
  ST_CARRYING,
  ST_DASHING,
  ST_REBUILDING,
  ST_WINDUP,
} from '@shared/net/messages';
import { isVisibleToSquad } from '@shared/sim/vision';
import { isBlocking } from '@shared/sim/systems/movement';
import type { Player, World } from '@shared/sim/world';
import { ATK_ACTIVE, ATK_WINDUP } from '@shared/sim/world';

// Pure per-squad snapshot builder — fog-of-war interest management is LIVE
// here as of M1. The server only serializes what a squad can currently see,
// so wallhacks are architecturally impossible rather than patched later.
// Allies always serialize; enemies pass isVisibleToSquad — the same function
// the client uses to draw its fog mask.

function q(v: number): number {
  // Quantize remote coords to 0.01 units — plenty below perceptible at 12px/unit.
  return Math.round(v * 100) / 100;
}

function stateFlags(cfg: GameConfig, p: Player): number {
  let st = 0;
  const hasShield = getKit(cfg, p.cls).shield !== undefined;
  if (isBlocking(p.input.b, hasShield, p.dashTicks)) st |= ST_BLOCKING;
  if (p.atkPhase === ATK_WINDUP) st |= ST_WINDUP;
  if (p.atkPhase === ATK_ACTIVE) st |= ST_ACTIVE;
  if (p.dashTicks > 0) st |= ST_DASHING;
  // Carrying/banking/rebuilding are visible STATES (the sack on the back, the
  // channel kneel) — the amount stays squad-private (see the `g` rule below).
  if (p.carried > 0) st |= ST_CARRYING;
  if (p.bankTicks > 0) st |= ST_BANKING;
  if (p.rebuildTicks > 0) st |= ST_REBUILDING;
  return st;
}

/** Eliminated squads spectate: their snapshots skip fog entirely. They're out
 *  of the match — let them watch the ending they're part of. */
function isSpectator(world: World, squadId: number): boolean {
  return world.squads[squadId]?.eliminated === true;
}

export function buildSquadEnts(
  world: World,
  map: MapData,
  cfg: GameConfig,
  squadId: number,
): EntitySnap[] {
  const ents: EntitySnap[] = [];
  const spectator = isSpectator(world, squadId);
  for (const p of world.players.values()) {
    if (!p.alive) continue; // the dead exist only in events/roster
    const ally = p.squad === squadId;
    if (!ally && !spectator && !isVisibleToSquad(world, map, cfg, squadId, p.x, p.y)) continue;
    const snap: EntitySnap = {
      i: p.id,
      x: q(p.x),
      y: q(p.y),
      ax: q(p.input.ax),
      ay: q(p.input.ay),
      hp: Math.ceil(p.hp),
      cls: p.cls,
      st: stateFlags(cfg, p),
    };
    // Squadmates share exact load; enemies only ever see the flag.
    if (ally && p.carried > 0) snap.g = p.carried;
    ents.push(snap);
  }
  return ents;
}

/** Ground sacks this squad can see — same visibility function as entities. */
export function buildSquadSacks(
  world: World,
  map: MapData,
  cfg: GameConfig,
  squadId: number,
): SackSnap[] {
  const sacks: SackSnap[] = [];
  const spectator = isSpectator(world, squadId);
  for (const s of world.sacks.values()) {
    if (!spectator && !isVisibleToSquad(world, map, cfg, squadId, s.x, s.y)) continue;
    sacks.push({ i: s.id, x: q(s.x), y: q(s.y), g: s.gold });
  }
  return sacks;
}

export function buildYou(world: World, p: Player): YouSnap {
  return {
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    dashTicks: p.dashTicks,
    dashDx: p.dashDx,
    dashDy: p.dashDy,
    dashCd: p.dashCd,
    prevB: p.prevB,
    hp: p.hp,
    alive: p.alive,
    respIn: p.alive ? 0 : Math.max(0, p.respawnAtTick - world.tick),
    atkPhase: p.atkPhase,
    atkTicks: p.atkTicks,
    atkCd: p.atkCd,
    cls: p.cls,
    bounty: p.bounty,
    carried: p.carried,
    bankTicks: p.bankTicks,
    rebuildTicks: p.rebuildTicks,
    bombs: p.bombs,
    bombCd: p.bombCd,
  };
}
