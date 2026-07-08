import { describe, expect, it } from 'vitest';
import { getConfigPreset } from '@shared/config';
import { runInProcessMatch } from '../src/harness';

// The M3 acceptance run: one full prototype-length 12-bot match on a pinned
// seed. Determinism makes this exact: on seed 7 the bots besiege, crack
// multiple keeps, complete an emergency rebuild, and eliminate squads until
// the early last-squad-standing end. If a behavior change breaks any beat of
// that arc, this test names it. (Turbo: ~8 sim-minutes in a few wall-seconds.)

describe('full siege arc (prototype config, pinned seed)', () => {
  it('seed 7: keeps fall, a squad rebuilds, eliminations end the match early', async () => {
    const r = await runInProcessMatch({
      bots: 12,
      simSeconds: 480,
      seed: 7,
      cfg: getConfigPreset('prototype'),
    });

    // Invariants held every tick through the whole arc (conservation across
    // spills, respawn gating, reserve floor pre-destruction, replay match).
    expect(r.violations).toEqual([]);

    // The arc actually happened.
    expect(r.combat.bombsThrown, 'bombs thrown').toBeGreaterThanOrEqual(10);
    expect(r.combat.keepsDestroyed, 'keeps destroyed').toBeGreaterThanOrEqual(2);
    expect(r.combat.rebuilds, 'emergency rebuilds').toBeGreaterThanOrEqual(1);
    expect(r.combat.eliminations, 'eliminations').toBeGreaterThanOrEqual(1);

    // Banking kept working under siege pressure.
    expect(r.combat.bankDeposits).toBeGreaterThanOrEqual(2);
  }, 40_000);
});
