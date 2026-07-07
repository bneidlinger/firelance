import type { GameConfig } from '@shared/config';
import { getKit } from '@shared/config';
import type { MapData } from '@shared/map/types';
import type { EntitySnap, YouSnap } from '@shared/net/messages';
import { ST_ACTIVE, ST_BLOCKING, ST_DASHING, ST_WINDUP } from '@shared/net/messages';
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
  return st;
}

export function buildSquadEnts(
  world: World,
  map: MapData,
  cfg: GameConfig,
  squadId: number,
): EntitySnap[] {
  const ents: EntitySnap[] = [];
  for (const p of world.players.values()) {
    if (!p.alive) continue; // the dead exist only in events/roster
    if (p.squad !== squadId && !isVisibleToSquad(world, map, cfg, squadId, p.x, p.y)) continue;
    ents.push({
      i: p.id,
      x: q(p.x),
      y: q(p.y),
      ax: q(p.input.ax),
      ay: q(p.input.ay),
      hp: Math.ceil(p.hp),
      cls: p.cls,
      st: stateFlags(cfg, p),
    });
  }
  return ents;
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
  };
}
