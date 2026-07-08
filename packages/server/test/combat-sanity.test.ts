import { describe, expect, it } from 'vitest';
import { runInProcessMatch } from '../src/harness';

// The M1+M2 acceptance run: full 12-bot compressed matches across 3 seeds,
// with sanity bounds that catch a broken combat-and-banking ecology without
// pretending to measure fun — every bot fights, arrows land at
// plausible-not-aimbot rates, no squad is shut out, gold flows and balances
// across all four pools, bank runs actually complete, replay reproduces.

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

      // Ranger arrows land, but nowhere near aimbot rates (dodgeability
      // proxy). Ceiling is 0.62 as of M3: siegers deliberately orbit in the
      // open and eat arrows while bombing — willing targets inflate rates
      // without saying anything about dodgeability for players who dodge.
      for (const p of r.playerSummary.filter((p) => p.cls === 'ranger')) {
        const shots = r.combat.shotsByPlayer[p.name] ?? 0;
        if (shots < 20) continue; // too few shots for a stable rate
        const rate = (r.combat.hitsByPlayer[p.name] ?? 0) / shots;
        expect(rate, `${p.name} hit rate ${(rate * 100).toFixed(0)}%`).toBeGreaterThan(0.05);
        expect(rate, `${p.name} hit rate ${(rate * 100).toFixed(0)}%`).toBeLessThan(0.62);
      }

      // No squad shut out; combat actually happened at scale.
      expect(r.combat.totalKills).toBeGreaterThan(10);
      for (let s = 0; s < 4; s++) {
        expect(r.combat.killsBySquad[s], `squad ${s} kills`).toBeGreaterThan(0);
      }

      // The economy moved.
      expect(r.combat.goldMinted).toBeGreaterThan(200);

      // M2: bank runs COMPLETE. Bots withdraw, survive the walk often enough,
      // and finish the stand-still channel — the whole loop, under fire.
      // (Empirical floor: seeds 7/42/1337 land 4-5 deposits, 3-4 squads each.)
      expect(r.combat.bankDeposits, 'no deposit channel ever completed').toBeGreaterThanOrEqual(2);
      const bankedTotal = r.combat.bankedBySquad.reduce((a, b) => a + b, 0);
      expect(bankedTotal, 'banked total').toBeGreaterThan(400);
      const squadsBanked = r.combat.bankedBySquad.filter((g) => g > 0).length;
      expect(squadsBanked, 'squads that banked at least once').toBeGreaterThanOrEqual(2);
    },
    60_000,
  );
});
