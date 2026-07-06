import type { GameConfig } from '@shared/config';
import type { EntitySnap } from '@shared/net/messages';
import type { World } from '@shared/sim/world';

// Pure per-squad snapshot builder. From M1 this is where fog-of-war interest
// management lives: the server only SERIALIZES what a squad can see, so
// wallhacks are architecturally impossible rather than patched later. M0 stubs
// visibility to "everything" but the per-squad shape (and its unit tests) are
// already load-bearing.

function q(v: number): number {
  // Quantize remote coords to 0.01 units — plenty below perceptible at 12px/unit.
  return Math.round(v * 100) / 100;
}

export function buildSquadEnts(world: World, _squadId: number, _cfg: GameConfig): EntitySnap[] {
  const ents: EntitySnap[] = [];
  for (const p of world.players.values()) {
    // M1: if (!isVisibleToSquad(world, squadId, p, cfg, map)) continue;
    ents.push({ i: p.id, x: q(p.x), y: q(p.y) });
  }
  return ents;
}
