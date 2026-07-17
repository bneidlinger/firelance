import { describe, expect, it } from 'vitest';
import { getConfigPreset, type GameConfig } from '@shared/config';
import { runInProcessMatch } from '../src/harness';

// The M3 acceptance run: one full prototype-length 12-bot match on a pinned
// seed. Determinism makes this exact: on the pinned seed the bots besiege,
// crack multiple keeps, complete an emergency rebuild, and eliminate squads
// until the early last-squad-standing end. If a behavior change breaks any
// beat of that arc, this test names it. (Turbo: ~8 sim-minutes in a few
// wall-seconds.) Re-pinned 7 → 4 for M4 s2 (placement shifts the timeline),
// 4 → 20 for M4 s5 (claim/build/bump behaviors shift every bot's rng stream;
// the rebuild beat stays ~30% seed-luck). 20 → 17 for the Lived-In Vale
// interlude (walls/gates joined the ranged-damage table at 240 hp — stray
// siege arrows now wear architecture, which shifts every fight's timing;
// 4/16/17/19/21/25/26/28/29 pass, 17 has the richest arc: 5 destructions,
// 2 rebuilds, 3 eliminations). Expect to re-pin on any bot-behavior change.
//
// Variation and rumors forced OFF: this pins a bot-behavior ARC on the
// authored layout with no gossip steering anyone. M5's map draw and rumor
// systems get their own tests (variation.test.ts, rumors.test.ts).
const cfg: GameConfig = {
  ...getConfigPreset('prototype'),
  variation: { ...getConfigPreset('prototype').variation, enabled: false },
  rumors: { ...getConfigPreset('prototype').rumors, enabled: false },
  // Props off, same policy as variation/rumors: pinned arcs run bare ground.
  props: { ...getConfigPreset('prototype').props, enabled: false },
};

describe('full siege arc (prototype config, pinned seed)', () => {
  it('seed 17: keeps fall, a squad rebuilds, eliminations end the match early', async () => {
    const r = await runInProcessMatch({
      bots: 12,
      simSeconds: 505,
      seed: 17,
      cfg,
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
