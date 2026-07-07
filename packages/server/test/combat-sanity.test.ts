import { describe, expect, it } from 'vitest';
import { runInProcessMatch } from '../src/harness';

// The M1 acceptance run: full 12-bot compressed matches across 3 seeds, with
// sanity bounds that catch a broken combat ecology without pretending to
// measure fun — every bot fights, arrows land at plausible-not-aimbot rates,
// no squad is shut out, gold flows and balances, replay reproduces.

describe('12-bot compressed match sanity (3 seeds)', () => {
  it.each([[7], [42], [1337]])(
    'seed %i: balanced ledger, active bots, sane hit rates',
    async (seed) => {
      const r = await runInProcessMatch({ bots: 12, simSeconds: 150, seed });

      // Invariants (gold conservation every tick, replay hash, bounds) all clean.
      expect(r.violations).toEqual([]);
      expect(r.players).toBe(12);

      // Everybody fought.
      for (const p of r.playerSummary) {
        const shots = r.combat.shotsByPlayer[p.name] ?? 0;
        expect(shots, `${p.name} (${p.cls}) never attacked`).toBeGreaterThan(0);
      }

      // Ranger arrows land, but nowhere near aimbot rates (dodgeability proxy).
      for (const p of r.playerSummary.filter((p) => p.cls === 'ranger')) {
        const shots = r.combat.shotsByPlayer[p.name] ?? 0;
        if (shots < 20) continue; // too few shots for a stable rate
        const rate = (r.combat.hitsByPlayer[p.name] ?? 0) / shots;
        expect(rate, `${p.name} hit rate ${(rate * 100).toFixed(0)}%`).toBeGreaterThan(0.05);
        expect(rate, `${p.name} hit rate ${(rate * 100).toFixed(0)}%`).toBeLessThan(0.55);
      }

      // No squad shut out; combat actually happened at scale.
      expect(r.combat.totalKills).toBeGreaterThan(10);
      for (let s = 0; s < 4; s++) {
        expect(r.combat.killsBySquad[s], `squad ${s} kills`).toBeGreaterThan(0);
      }

      // The economy moved.
      expect(r.combat.goldMinted).toBeGreaterThan(200);
    },
    60_000,
  );
});
