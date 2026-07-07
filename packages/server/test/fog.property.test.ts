import { describe, expect, it } from 'vitest';
import { getConfigPreset } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { createRng, rngFloat, rngInt } from '@shared/math/rng';
import { isVisibleToSquad } from '@shared/sim/vision';
import { createWorld, spawnPlayer, PHASE_LIVE } from '@shared/sim/world';
import { isWalkBlocked } from '@shared/map/types';
import { buildSquadEnts } from '../src/snapshot';

// THE anti-wallhack property test: across 1,000 randomized world states, a
// squad snapshot must NEVER serialize an enemy the squad cannot see, must
// ALWAYS contain every living ally, and must never contain the dead. The
// snapshot builder and the visibility function can only drift apart by
// failing this test loudly.

const cfg = getConfigPreset('smoke');
const map = getMap('scrim_small');

describe('fog property test (1,000 seeded states)', () => {
  it('no invisible enemy serialized; allies always present; the dead stay gone', () => {
    const rng = createRng(0xf00f);
    let enemiesSerialized = 0;
    let enemiesHidden = 0;

    for (let iter = 0; iter < 1000; iter++) {
      const world = createWorld(iter, cfg, map);
      world.phase = PHASE_LIVE;

      // 12 players, random walkable spots, ~15% dead.
      for (let i = 0; i < 12; i++) {
        const squad = i % 4;
        let x = 0;
        let y = 0;
        for (;;) {
          x = rngInt(rng, 1, map.width - 2);
          y = rngInt(rng, 1, map.height - 2);
          if (!isWalkBlocked(map, x, y)) break;
        }
        const p = spawnPlayer(world, cfg, squad, `p${i}`, true, 'ranger', x + 0.5, y + 0.5);
        if (rngFloat(rng) < 0.15) p.alive = false;
      }

      for (let squad = 0; squad < 4; squad++) {
        const ents = buildSquadEnts(world, map, cfg, squad);
        const sent = new Set(ents.map((e) => e.i));

        for (const p of world.players.values()) {
          const included = sent.has(p.id);
          if (!p.alive) {
            expect(included, `dead player ${p.id} serialized for squad ${squad}`).toBe(false);
          } else if (p.squad === squad) {
            expect(included, `living ally ${p.id} missing for squad ${squad}`).toBe(true);
          } else if (included) {
            enemiesSerialized++;
            expect(
              isVisibleToSquad(world, map, cfg, squad, p.x, p.y),
              `INVISIBLE enemy ${p.id} serialized for squad ${squad} (wallhack!)`,
            ).toBe(true);
          } else {
            enemiesHidden++;
            expect(
              isVisibleToSquad(world, map, cfg, squad, p.x, p.y),
              `visible enemy ${p.id} NOT serialized for squad ${squad} (ghost!)`,
            ).toBe(false);
          }
        }
      }
    }

    // The property run must exercise BOTH branches heavily or it proves nothing.
    expect(enemiesSerialized).toBeGreaterThan(500);
    expect(enemiesHidden).toBeGreaterThan(5000);
  });
});
