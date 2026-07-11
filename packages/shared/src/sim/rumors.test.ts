import { describe, expect, it } from 'vitest';
import { defineConfig, smokeConfig, type GameConfig } from '../config';
import { parseMap } from '../map/parse';
import type { SimEvent } from './events';
import { stepWorld } from './step';
import { mintGoldToKeep } from './systems/economy';
import type { InputCmd, Player, PlayerId, World } from './world';
import { createWorld, PHASE_LIVE, PHASE_PLACEMENT, spawnPlayer } from './world';

// The rumor mill (M5): who leaks, when, and how vaguely. The fuzz draw is a
// recentered sum of three uniforms, so |offset| ≤ 3σ is a HARD bound — these
// tests assert exact envelopes, not probabilistic ones.

const arena = parseMap(
  'rumor-arena',
  `
##################
#1..............2#
#..K..........K..#
#........T.......#
#..K..........K..#
#3..............4#
##################
`,
);

// Fast cadence + the default tier ladder [0,50,150,300,500,800].
const cfg: GameConfig = defineConfig({
  name: 'rumor-test',
  rumors: {
    enabled: true,
    intervalSec: 1, // 30 ticks
    bountyTier: 3,
    fuzzRadius: 3,
    fuzzTierFactor: 0.5,
    carrierTier: 4,
    carrierGold: 100,
    richKeepGold: 300,
    fadeSec: 12,
  },
});
const INTERVAL = 30;

function mkWorld(c: GameConfig = cfg): World {
  const w = createWorld(1, c, arena);
  w.phase = PHASE_LIVE;
  w.phaseEndsTick = 1_000_000;
  return w;
}

function mk(w: World, c: GameConfig, squad: number, name: string): Player {
  const k = w.squads[squad]!;
  return spawnPlayer(w, c, squad, name, true, 'ranger', k.keepX, k.keepY);
}

/** Step n ticks with idle inputs, returning every rumor event seen. */
function runRumors(w: World, c: GameConfig, n: number): Array<SimEvent & { k: 'rumor' }> {
  const idle = new Map<PlayerId, InputCmd>();
  const out: Array<SimEvent & { k: 'rumor' }> = [];
  for (let i = 0; i < n; i++) {
    for (const ev of stepWorld(w, idle, c, arena)) {
      if (ev.k === 'rumor') out.push(ev);
    }
  }
  return out;
}

describe('who leaks', () => {
  it('below the tier threshold nobody pings', () => {
    const w = mkWorld();
    const p = mk(w, cfg, 0, 'quiet');
    p.bounty = 149; // tier 2 (Wanted) — not yet gossip-worthy
    expect(runRumors(w, cfg, INTERVAL * 2)).toHaveLength(0);
  });

  it('a Hunted player pings every interval, within the hard 3σ envelope', () => {
    const w = mkWorld();
    const p = mk(w, cfg, 0, 'hunted');
    p.bounty = 300; // tier 3
    const rumors = runRumors(w, cfg, INTERVAL * 3);
    expect(rumors.length).toBe(3);
    for (const r of rumors) {
      expect(r.kind).toBe('bounty');
      expect(r.id).toBe(p.id);
      expect(r.squad).toBe(0);
      expect(r.tier).toBe(3);
      expect(Math.abs(r.x - p.x)).toBeLessThanOrEqual(3 * 3 + 1e-9);
      expect(Math.abs(r.y - p.y)).toBeLessThanOrEqual(3 * 3 + 1e-9);
    }
  });

  it('higher tiers leak sharper positions (fuzz shrinks by fuzzTierFactor per tier)', () => {
    const w = mkWorld();
    const p = mk(w, cfg, 0, 'crownmarked');
    p.bounty = 800; // tier 5: fuzz = 3 × 0.5² = 0.75, hard cap ±2.25
    const rumors = runRumors(w, cfg, INTERVAL * 4);
    expect(rumors.length).toBeGreaterThanOrEqual(3);
    for (const r of rumors) {
      expect(r.tier).toBe(5);
      expect(Math.abs(r.x - p.x)).toBeLessThanOrEqual(3 * 0.75 + 1e-9);
      expect(Math.abs(r.y - p.y)).toBeLessThanOrEqual(3 * 0.75 + 1e-9);
    }
  });

  it('a tier-4 heavy carrier pings as a carrier (the banking alert)', () => {
    const w = mkWorld();
    const p = mk(w, cfg, 1, 'mule');
    p.bounty = 500; // tier 4
    p.carried = 150; // ≥ carrierGold
    w.goldMinted += 150; // keep the ledger honest for this hand-load
    w.squads[1]!.lifetimeGold += 150;
    const rumors = runRumors(w, cfg, INTERVAL);
    expect(rumors.length).toBe(1);
    expect(rumors[0]!.kind).toBe('carrier');
  });

  it('a rich LIVING keep pings; a destroyed or modest one stays quiet', () => {
    const w = mkWorld();
    mintGoldToKeep(w, 2, 400); // ≥ richKeepGold 300
    mintGoldToKeep(w, 3, 100); // below
    const rumors = runRumors(w, cfg, INTERVAL);
    expect(rumors.length).toBe(1);
    expect(rumors[0]!.kind).toBe('richKeep');
    expect(rumors[0]!.squad).toBe(2);
    expect(rumors[0]!.id).toBe(-1);
    const s = w.squads[2]!;
    expect(Math.abs(rumors[0]!.x - s.keepX)).toBeLessThanOrEqual(3 * 3 + 1e-9);

    s.keepHp = 0; // the vault spilled elsewhere; ruins don't gossip
    expect(runRumors(w, cfg, INTERVAL * 2)).toHaveLength(0);
  });

  it('the dead never ping', () => {
    const w = mkWorld();
    const p = mk(w, cfg, 0, 'ghost');
    p.bounty = 800;
    p.alive = false;
    p.respawnAtTick = 1_000_000; // stay dead through the window
    expect(runRumors(w, cfg, INTERVAL * 2)).toHaveLength(0);
  });
});

describe('when it runs', () => {
  it('nothing pre-live, nothing when disabled', () => {
    const w = mkWorld();
    w.phase = PHASE_PLACEMENT;
    w.phaseEndsTick = 1_000_000;
    const p = mk(w, cfg, 0, 'early');
    p.bounty = 800;
    expect(runRumors(w, cfg, INTERVAL * 2)).toHaveLength(0);

    const w2 = mkWorld(smokeConfig); // rumors disabled in smoke
    const q = mk(w2, smokeConfig, 0, 'silent');
    q.bounty = 800;
    expect(runRumors(w2, smokeConfig, INTERVAL * 2)).toHaveLength(0);
  });

  it('subjects are staggered — two hunted players never chorus on one tick', () => {
    const w = mkWorld();
    const a = mk(w, cfg, 0, 'a');
    const b = mk(w, cfg, 1, 'b');
    a.bounty = 300;
    b.bounty = 300;
    const rumors = runRumors(w, cfg, INTERVAL * 2);
    expect(rumors.length).toBe(4);
    const ticksA = new Set(rumors.filter((r) => r.id === a.id).map((r) => r.tk % INTERVAL));
    const ticksB = new Set(rumors.filter((r) => r.id === b.id).map((r) => r.tk % INTERVAL));
    expect(ticksA.size).toBe(1); // fixed per-subject phase
    expect(ticksB.size).toBe(1);
    expect([...ticksA][0]).not.toBe([...ticksB][0]);
  });
});
