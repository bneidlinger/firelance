import { describe, expect, it } from 'vitest';
import { prototypeConfig, secToTicks, smokeConfig } from '../config';
import { parseMap } from '../map/parse';
import type { SimEvent } from './events';
import { stepWorld } from './step';
import type { World } from './world';
import {
  BTN_FIRE,
  createWorld,
  PHASE_COUNTDOWN,
  PHASE_ENDED,
  PHASE_LIVE,
  spawnPlayer,
} from './world';

// Match flow: countdown (free-move warmup, combat gated) → live (hard reset,
// timer) → ended (winner by BANKED gold — M2's core rule switch; keep gold is
// just unsecured wealth). The server-level auto-restart is tested in
// packages/server/test.

const arena = parseMap(
  'flow-arena',
  `
############
#1........2#
#..K....K..#
#....T.....#
#..K....K..#
#3........4#
############
`,
);

function run(world: World, cfg: typeof smokeConfig, n: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < n; i++) events.push(...stepWorld(world, new Map(), cfg, arena));
  return events;
}

describe('countdown → live', () => {
  it('starts in countdown and goes live exactly at countdownSec', () => {
    const cfg = prototypeConfig; // 5s countdown
    const w = createWorld(1, cfg, arena);
    expect(w.phase).toBe(PHASE_COUNTDOWN);
    const cd = secToTicks(cfg, cfg.match.countdownSec);
    run(w, cfg, cd - 1);
    expect(w.phase).toBe(PHASE_COUNTDOWN);
    const events = run(w, cfg, 1);
    expect(w.phase).toBe(PHASE_LIVE);
    expect(events.some((e) => e.k === 'phase' && e.phase === PHASE_LIVE)).toBe(true);
    expect(w.phaseEndsTick).toBe(w.tick + secToTicks(cfg, cfg.match.durationSec));
  });

  it('combat is disabled during the countdown', () => {
    const cfg = prototypeConfig;
    const w = createWorld(1, cfg, arena);
    const p = spawnPlayer(w, cfg, 0, 'eager', true, 'ranger', 5.5, 3.5);
    p.input = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_FIRE };
    run(w, cfg, 10); // still countdown
    expect(w.projectiles.size).toBe(0);
  });

  it('going live teleports everyone home and zeroes the economy', () => {
    const cfg = prototypeConfig;
    const w = createWorld(1, cfg, arena);
    const p = spawnPlayer(w, cfg, 0, 'wanderer', true, 'ranger', 5.5, 3.5);
    p.bounty = 99;
    p.kills = 3;
    w.squads[0]!.keepGold = 500; // pollute pre-live state
    w.squads[0]!.bankedGold = 200;
    w.squads[0]!.lifetimeGold = 700;
    p.carried = 50;
    w.goldMinted = 750;
    p.input = { mx: 1, my: 0, ax: 1, ay: 0, b: 0 };
    run(w, cfg, secToTicks(cfg, cfg.match.countdownSec) + 1);
    expect(w.phase).toBe(PHASE_LIVE);
    const keep = w.squads[0]!;
    expect(Math.hypot(p.x - keep.keepX, p.y - keep.keepY)).toBeLessThan(2);
    expect(p.bounty).toBe(0);
    expect(p.kills).toBe(0);
    expect(p.carried).toBe(0);
    expect(w.goldMinted).toBe(0);
    expect(keep.keepGold).toBe(0);
    expect(keep.bankedGold).toBe(0);
    expect(keep.lifetimeGold).toBe(0);
    expect(w.sacks.size).toBe(0);
  });
});

describe('live → ended', () => {
  it('ends at durationSec with winners = most BANKED gold and sorted standings', () => {
    const cfg = smokeConfig; // countdown 0, 150s
    const w = createWorld(1, cfg, arena);
    spawnPlayer(w, cfg, 0, 'a', true, 'ranger', 3.5, 2.5);
    run(w, cfg, 2); // now live (countdown 0 ⇒ tick 1 transition)
    expect(w.phase).toBe(PHASE_LIVE);
    w.squads[2]!.bankedGold = 300; // hand the lead to squad 2
    w.goldMinted = 300;
    const endTick = w.phaseEndsTick;
    const events = run(w, cfg, endTick - w.tick);
    expect(w.phase).toBe(PHASE_ENDED);
    expect(w.winners).toEqual([2]);
    const end = events.find((e) => e.k === 'matchEnd');
    expect(end && end.k === 'matchEnd' ? end.standings[0]!.squad : -1).toBe(2);
    expect(end && end.k === 'matchEnd' ? end.winners : []).toEqual([2]);
  });

  it('a fat vault loses to a modest bank — only banked gold wins', () => {
    const cfg = smokeConfig;
    const w = createWorld(1, cfg, arena);
    run(w, cfg, 2);
    w.squads[0]!.keepGold = 5000; // hoarder: rich and unsecured
    w.squads[0]!.lifetimeGold = 5000;
    w.squads[2]!.bankedGold = 100; // banker: modest but safe
    w.goldMinted = 5100;
    run(w, cfg, w.phaseEndsTick - w.tick);
    expect(w.winners).toEqual([2]);
  });

  it('ties produce multiple winners', () => {
    const cfg = smokeConfig;
    const w = createWorld(1, cfg, arena);
    run(w, cfg, 2);
    w.squads[1]!.bankedGold = 100;
    w.squads[3]!.bankedGold = 100;
    w.goldMinted = 200;
    run(w, cfg, w.phaseEndsTick - w.tick);
    expect(w.winners).toEqual([1, 3]);
  });

  it('the ended world is frozen: no movement, no combat, tick still advances', () => {
    const cfg = smokeConfig;
    const w = createWorld(1, cfg, arena);
    const p = spawnPlayer(w, cfg, 0, 'a', true, 'ranger', 3.5, 2.5);
    run(w, cfg, 2);
    run(w, cfg, w.phaseEndsTick - w.tick); // reach ended
    expect(w.phase).toBe(PHASE_ENDED);
    const frozen = { x: p.x, y: p.y };
    p.input = { mx: 1, my: 1, ax: 1, ay: 0, b: BTN_FIRE };
    const t0 = w.tick;
    run(w, cfg, 10);
    expect(w.tick).toBe(t0 + 10);
    expect(p.x).toBe(frozen.x);
    expect(p.y).toBe(frozen.y);
    expect(w.projectiles.size).toBe(0);
  });
});
