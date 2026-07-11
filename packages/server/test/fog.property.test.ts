import { describe, expect, it } from 'vitest';
import { getConfigPreset } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { createRng, rngFloat, rngInt } from '@shared/math/rng';
import { isVisibleToSquad } from '@shared/sim/vision';
import { createWorld, spawnPlayer, PHASE_LIVE, STRUCT_TRAP, STRUCT_WALL } from '@shared/sim/world';
import { isWalkBlocked } from '@shared/map/types';
import { buildOccupancy } from '@shared/sim/systems/structures';
import { buildSquadEnts, buildSquadSacks, buildSquadStructures } from '../src/snapshot';

// THE anti-wallhack property test: across 1,000 randomized world states, a
// squad snapshot must NEVER serialize an enemy the squad cannot see, must
// ALWAYS contain every living ally, and must never contain the dead. Same
// rules for ground sacks (M2), plus the info-leak rule: an enemy entity must
// never carry the `g` (carried gold) field — that number is squad-private.
// M4 s4 adds structures: own always; enemy walls serialized ⇔ visible; enemy
// TRAPS never, visible tile or not. The snapshot builder and the visibility
// function can only drift apart by failing this test loudly.

const cfg = getConfigPreset('smoke');
const map = getMap('scrim_small');

describe('fog property test (1,000 seeded states)', () => {
  it('no invisible enemy serialized; allies always present; the dead stay gone', () => {
    const rng = createRng(0xf00f);
    let enemiesSerialized = 0;
    let enemiesHidden = 0;
    let enemyTrapsChecked = 0;

    for (let iter = 0; iter < 1000; iter++) {
      const world = createWorld(iter, cfg, map);
      world.phase = PHASE_LIVE;

      // 12 players, random walkable spots, ~15% dead, ~30% carrying gold.
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
        if (rngFloat(rng) < 0.3) p.carried = rngInt(rng, 1, 900);
      }

      // A few ground sacks scattered on walkable tiles.
      const sackCount = rngInt(rng, 0, 4);
      for (let i = 0; i < sackCount; i++) {
        let x = 0;
        let y = 0;
        for (;;) {
          x = rngInt(rng, 1, map.width - 2);
          y = rngInt(rng, 1, map.height - 2);
          if (!isWalkBlocked(map, x, y)) break;
        }
        const id = world.nextId++;
        world.sacks.set(id, { id, x: x + 0.5, y: y + 0.5, gold: rngInt(rng, 1, 500), bornTick: 0 });
      }

      // A few structures: walls (positional fog) and traps (squad-secret).
      const structCount = rngInt(rng, 0, 5);
      for (let i = 0; i < structCount; i++) {
        let x = 0;
        let y = 0;
        for (;;) {
          x = rngInt(rng, 1, map.width - 2);
          y = rngInt(rng, 1, map.height - 2);
          if (!isWalkBlocked(map, x, y)) break;
        }
        const id = world.nextId++;
        const kind = rngFloat(rng) < 0.5 ? STRUCT_TRAP : STRUCT_WALL;
        const hp = kind === STRUCT_TRAP ? cfg.build.trap.hp : cfg.build.wall.hp;
        world.structures.set(id, {
          id,
          kind,
          squad: rngInt(rng, 0, 3),
          by: -1,
          tx: x,
          ty: y,
          hp,
          maxHp: hp,
          bornTick: 0,
        });
      }

      // ~15% of iterations: squad 3 is eliminated — spectators skip fog.
      const spectating = rngFloat(rng) < 0.15;
      if (spectating) {
        world.squads[3]!.keepHp = 0;
        world.squads[3]!.eliminated = true;
      }

      // The oracle must see through the same walls the snapshot builder does:
      // entity/sack visibility consults structure occupancy (walls occlude,
      // traps deliberately don't); structure visibility is terrain-only.
      const occ = buildOccupancy(world, map.width);

      for (let squad = 0; squad < 4; squad++) {
        const ents = buildSquadEnts(world, map, cfg, squad);
        const sent = new Set(ents.map((e) => e.i));

        if (spectating && squad === 3) {
          // Eliminated = pure audience: every living body serialized, dead none.
          for (const p of world.players.values()) {
            expect(sent.has(p.id), `spectator missing ${p.id}`).toBe(p.alive);
          }
          const sackSent = new Set(buildSquadSacks(world, map, cfg, squad).map((s) => s.i));
          for (const s of world.sacks.values()) {
            expect(sackSent.has(s.id), `spectator missing sack ${s.id}`).toBe(true);
          }
          // Spectators see all structures — traps included (they're out).
          const structSent = new Set(buildSquadStructures(world, map, cfg, squad).map((s) => s.i));
          for (const s of world.structures.values()) {
            expect(structSent.has(s.id), `spectator missing structure ${s.id}`).toBe(true);
          }
          continue;
        }

        for (const e of ents) {
          const p = world.players.get(e.i)!;
          if (p.squad !== squad) {
            expect(e.g, `enemy ${e.i} leaked carried gold to squad ${squad}`).toBeUndefined();
          } else if (p.carried > 0) {
            expect(e.g, `ally ${e.i} carried amount missing`).toBe(p.carried);
          }
        }

        for (const p of world.players.values()) {
          const included = sent.has(p.id);
          if (!p.alive) {
            expect(included, `dead player ${p.id} serialized for squad ${squad}`).toBe(false);
          } else if (p.squad === squad) {
            expect(included, `living ally ${p.id} missing for squad ${squad}`).toBe(true);
          } else if (included) {
            enemiesSerialized++;
            expect(
              isVisibleToSquad(world, map, cfg, squad, p.x, p.y, occ),
              `INVISIBLE enemy ${p.id} serialized for squad ${squad} (wallhack!)`,
            ).toBe(true);
          } else {
            enemiesHidden++;
            expect(
              isVisibleToSquad(world, map, cfg, squad, p.x, p.y, occ),
              `visible enemy ${p.id} NOT serialized for squad ${squad} (ghost!)`,
            ).toBe(false);
          }
        }

        // Sacks obey the same fog: serialized ⇔ visible.
        const sackSent = new Set(buildSquadSacks(world, map, cfg, squad).map((s) => s.i));
        for (const s of world.sacks.values()) {
          const vis = isVisibleToSquad(world, map, cfg, squad, s.x, s.y, occ);
          expect(
            sackSent.has(s.id),
            `sack ${s.id} ${vis ? 'hidden from' : 'leaked to'} squad ${squad}`,
          ).toBe(vis);
        }

        // Structures: own always; enemy walls ⇔ visible; enemy traps NEVER.
        const structSent = new Set(buildSquadStructures(world, map, cfg, squad).map((s) => s.i));
        for (const s of world.structures.values()) {
          if (s.squad === squad) {
            expect(structSent.has(s.id), `own structure ${s.id} missing for squad ${squad}`).toBe(
              true,
            );
          } else if (s.kind === STRUCT_TRAP) {
            enemyTrapsChecked++;
            expect(
              structSent.has(s.id),
              `enemy TRAP ${s.id} leaked to squad ${squad} — the whole mechanic is dead`,
            ).toBe(false);
          } else {
            const vis = isVisibleToSquad(world, map, cfg, squad, s.tx + 0.5, s.ty + 0.5);
            expect(
              structSent.has(s.id),
              `wall ${s.id} ${vis ? 'hidden from' : 'leaked to'} squad ${squad}`,
            ).toBe(vis);
          }
        }
      }
    }

    // The property run must exercise BOTH branches heavily or it proves nothing.
    expect(enemiesSerialized).toBeGreaterThan(500);
    expect(enemiesHidden).toBeGreaterThan(5000);
    expect(enemyTrapsChecked).toBeGreaterThan(500);
  });
});
