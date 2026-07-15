import { describe, expect, it } from 'vitest';
import { getConfigPreset, type GameConfig } from '@shared/config';
import { runInProcessMatch } from '../src/harness';

// The M4 s5 acceptance run: 12 bots on the FULL-SIZE map with the complete
// building ecology live — placement claims, engineer forts, traps biting,
// banking across real distances — all under the every-tick invariant suite.
// (Pinned seed: same policy as siege-arc; expect to re-pin on bot changes.
// Seed 24 at 300 sim-seconds: structs [24,4,4,17], 4 claims, 5 trap bites.)
//
// Variation, rumors, and countryside props forced OFF — this pins the
// authored vale layout with no gossip steering and no semi-random obstacles;
// the M5 systems and props get their own tests.
const cfg: GameConfig = {
  ...getConfigPreset('prototype'),
  variation: { ...getConfigPreset('prototype').variation, enabled: false },
  rumors: { ...getConfigPreset('prototype').rumors, enabled: false },
  props: { ...getConfigPreset('prototype').props, enabled: false },
};

describe('vale_full 12-bot ecology (pinned seed)', () => {
  it('seed 24: claims, forts, trap bites, and banking — invariants clean', async () => {
    const r = await runInProcessMatch({
      bots: 12,
      simSeconds: 300,
      seed: 24,
      cfg,
      mapId: 'vale_full',
    });

    expect(r.violations).toEqual([]);

    // Every squad chose its ground DELIBERATELY (no deadline auto-assigns).
    expect(r.combat.claims).toBe(4);

    // The engineers actually engineer: walls, doors, eyes, and snares.
    const [walls, gates, towers, traps] = r.combat.structuresBuilt;
    expect(walls, 'walls built').toBeGreaterThanOrEqual(10);
    expect(gates, 'gates built').toBeGreaterThanOrEqual(2);
    expect(towers, 'towers built').toBeGreaterThanOrEqual(2);
    expect(traps, 'traps built').toBeGreaterThanOrEqual(6);

    // And the snares close on somebody.
    expect(r.combat.trapTriggers, 'trap bites').toBeGreaterThanOrEqual(1);

    // The rest of the ecology survives the bigger map: fights and banking.
    expect(r.combat.totalKills).toBeGreaterThan(10);
    expect(r.combat.bankDeposits).toBeGreaterThanOrEqual(2);
  }, 40_000);
});
