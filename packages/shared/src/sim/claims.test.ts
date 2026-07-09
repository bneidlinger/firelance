import { describe, expect, it } from 'vitest';
import { defineConfig, secToTicks } from '../config';
import { parseMap } from '../map/parse';
import { stepWorld } from './step';
import type { InputCmd, PlayerId, World } from './world';
import {
  BTN_INTERACT,
  createWorld,
  hashWorld,
  PHASE_COUNTDOWN,
  PHASE_LIVE,
  PHASE_PLACEMENT,
  spawnPlayer,
} from './world';

// M4 slice 2: the keep-placement claim. Bots never claim (that's s5), so the
// mechanic lives or dies here — channel rules, contested sites, one claim per
// squad, the deadline auto-assign, and the goLive teleport to the chosen site.

// 6 sites for 4 squads: 4 corner defaults + 2 central "choice" sites.
// Defaults by nearest-to-spawn: sq0→(3,2) sq1→(10,2) sq2→(3,4) sq3→(10,4).
const arena = parseMap(
  'claims-arena',
  `
##############
#1..........2#
#..K......K..#
#.....TT.....#
#..K......K..#
#....K..K....#
#3..........4#
##############
`,
);

// Site indices follow scan order (row-major): 0:(3,2) 1:(10,2) 2:(3,4)
// 3:(10,4) 4:(5,5) 5:(8,5) — asserted below so a parser change fails loudly.
const CENTRAL_A = 4;

const CFG = defineConfig({
  name: 'claims-test',
  match: { durationSec: 150, placementSec: 10, countdownSec: 0, restartSec: 5 },
  keep: { claimChannelSec: 1 },
});

const CHANNEL = secToTicks(CFG, CFG.keep.claimChannelSec); // 30 ticks
const PLACEMENT = secToTicks(CFG, CFG.match.placementSec);

function still(b = BTN_INTERACT): InputCmd {
  return { mx: 0, my: 0, ax: 1, ay: 0, b };
}

function run(w: World, inputs: Map<PlayerId, InputCmd>, n: number): ReturnType<typeof stepWorld> {
  const events: ReturnType<typeof stepWorld> = [];
  for (let i = 0; i < n; i++) events.push(...stepWorld(w, inputs, CFG, arena));
  return events;
}

it('the arena parses sites in the order the tests assume', () => {
  expect(arena.keeps.map((k) => `${k.x},${k.y}`)).toEqual([
    '3.5,2.5',
    '10.5,2.5',
    '3.5,4.5',
    '10.5,4.5',
    '5.5,5.5',
    '8.5,5.5',
  ]);
});

describe('claim channel', () => {
  it('holding interact at an unclaimed site plants the keep after the channel', () => {
    const w = createWorld(1, CFG, arena);
    const site = arena.keeps[CENTRAL_A]!;
    const p = spawnPlayer(w, CFG, 0, 'claimer', false, 'ranger', site.x, site.y);
    const events = run(w, new Map([[p.id, still()]]), CHANNEL);
    expect(w.squads[0]!.claimedSite).toBe(CENTRAL_A);
    expect(w.squads[0]!.keepX).toBe(site.x);
    expect(w.squads[0]!.keepY).toBe(site.y);
    const claim = events.find((e) => e.k === 'keepClaimed');
    expect(claim && claim.k === 'keepClaimed' ? claim.by : null).toBe(p.id);
    expect(p.claimTicks).toBe(0); // consumed on completion
  });

  it('movement input resets the channel', () => {
    const w = createWorld(1, CFG, arena);
    const site = arena.keeps[CENTRAL_A]!;
    const p = spawnPlayer(w, CFG, 0, 'fidget', false, 'ranger', site.x, site.y);
    run(w, new Map([[p.id, still()]]), CHANNEL - 5);
    expect(p.claimTicks).toBe(CHANNEL - 5);
    run(w, new Map([[p.id, { ...still(), mx: 1 }]]), 1); // one step of movement
    expect(p.claimTicks).toBe(0);
    expect(w.squads[0]!.claimedSite).toBe(-1);
  });

  it('claims only run during the placement phase', () => {
    const w = createWorld(1, CFG, arena);
    run(w, new Map(), PLACEMENT); // expire placement (countdown 0 ⇒ live)
    expect(w.phase).toBe(PHASE_LIVE);
    const site = arena.keeps[5]!; // central B stays unclaimed by auto-assign
    const p = spawnPlayer(w, CFG, 0, 'late', false, 'ranger', site.x, site.y);
    const before = w.squads[0]!.claimedSite;
    run(w, new Map([[p.id, still()]]), CHANNEL * 2);
    expect(p.claimTicks).toBe(0);
    expect(w.squads[0]!.claimedSite).toBe(before);
  });

  it('a contested site goes to whoever finishes first; one claim per squad, final', () => {
    const w = createWorld(1, CFG, arena);
    const site = arena.keeps[CENTRAL_A]!;
    // Same tile, same tick-perfect channels; lower id processes first and wins.
    const a = spawnPlayer(w, CFG, 0, 'first', false, 'ranger', site.x, site.y);
    const b = spawnPlayer(w, CFG, 1, 'second', false, 'ranger', site.x + 0.5, site.y);
    const inputs = new Map([
      [a.id, still()],
      [b.id, still()],
    ]);
    const events = run(w, inputs, CHANNEL);
    expect(w.squads[0]!.claimedSite).toBe(CENTRAL_A);
    expect(w.squads[1]!.claimedSite).toBe(-1);
    expect(events.filter((e) => e.k === 'keepClaimed').length).toBe(1);

    // The loser can walk next door and claim the other central site...
    b.x = arena.keeps[5]!.x;
    b.y = arena.keeps[5]!.y;
    run(w, inputs, CHANNEL);
    expect(w.squads[1]!.claimedSite).toBe(5);

    // ...but the winner is done for the match: channeling elsewhere is inert.
    a.x = arena.keeps[0]!.x;
    a.y = arena.keeps[0]!.y;
    run(w, inputs, CHANNEL * 2);
    expect(a.claimTicks).toBe(0);
    expect(w.squads[0]!.claimedSite).toBe(CENTRAL_A);
  });
});

describe('placement deadline', () => {
  it('auto-assigns every unclaimed squad its nearest free site (the M0–M3 default)', () => {
    const w = createWorld(1, CFG, arena);
    const events = run(w, new Map(), PLACEMENT);
    expect(events.filter((e) => e.k === 'keepClaimed' && e.by === null).length).toBe(4);
    expect(w.squads.map((s) => s.claimedSite)).toEqual([0, 1, 2, 3]);
    // countdown 0 ⇒ the same tick cascaded straight into live.
    expect(w.phase).toBe(PHASE_LIVE);
  });

  it('a human claim displaces the default: the losing squad gets its next-nearest', () => {
    const w = createWorld(1, CFG, arena);
    // Squad 0 steals squad 1's DEFAULT corner site (10,2).
    const thief = spawnPlayer(w, CFG, 0, 'thief', false, 'ranger', 10.5, 2.5);
    run(w, new Map([[thief.id, still()]]), CHANNEL);
    expect(w.squads[0]!.claimedSite).toBe(1);
    run(w, new Map(), PLACEMENT); // expire the window
    const sites = w.squads.map((s) => s.claimedSite);
    expect(new Set(sites).size).toBe(4); // all unique
    expect(sites[0]).toBe(1);
    expect(sites[1]).not.toBe(1); // squad 1 was displaced somewhere else
    expect(w.squads[1]!.claimedSite).toBeGreaterThanOrEqual(0);
  });

  it('goLive teleports the squad to its CHOSEN keep, not the default', () => {
    const w = createWorld(1, CFG, arena);
    const site = arena.keeps[CENTRAL_A]!;
    const p = spawnPlayer(w, CFG, 0, 'settler', false, 'ranger', site.x, site.y);
    run(w, new Map([[p.id, still()]]), CHANNEL);
    p.x = 1.5; // wander off after claiming
    p.y = 1.5;
    run(w, new Map(), PLACEMENT);
    expect(w.phase).toBe(PHASE_LIVE);
    expect(Math.hypot(p.x - site.x, p.y - site.y)).toBeLessThan(2);
  });
});

describe('claims stay deterministic', () => {
  it('two identical claim-and-expire runs hash-match tick for tick', () => {
    const runOnce = (): string[] => {
      const w = createWorld(7, CFG, arena);
      const a = spawnPlayer(w, CFG, 0, 'a', false, 'ranger', 5.5, 5.5);
      const b = spawnPlayer(w, CFG, 1, 'b', false, 'ranger', 8.5, 5.5);
      const hashes: string[] = [];
      for (let t = 0; t < PLACEMENT + 30; t++) {
        const inputs = new Map<PlayerId, InputCmd>();
        if (t > 3) inputs.set(a.id, still());
        if (t > 10) inputs.set(b.id, still());
        stepWorld(w, inputs, CFG, arena);
        hashes.push(hashWorld(w));
      }
      return hashes;
    };
    expect(runOnce()).toEqual(runOnce());
  });
});

describe('phase plumbing', () => {
  it('emits countdown and live phase events in order when durations are nonzero', () => {
    const cfg = defineConfig({
      name: 'claims-flow',
      match: { durationSec: 150, placementSec: 1, countdownSec: 1, restartSec: 5 },
    });
    const w = createWorld(1, cfg, arena);
    const events: ReturnType<typeof stepWorld> = [];
    for (let i = 0; i < secToTicks(cfg, 2.5); i++) {
      events.push(...stepWorld(w, new Map(), cfg, arena));
    }
    const phases = events.filter((e) => e.k === 'phase').map((e) => e.phase);
    expect(phases).toEqual([PHASE_COUNTDOWN, PHASE_LIVE]);
    expect(w.phase).toBe(PHASE_LIVE);
  });

  it('a fresh world always starts in placement', () => {
    const w = createWorld(1, CFG, arena);
    expect(w.phase).toBe(PHASE_PLACEMENT);
    expect(w.squads.every((s) => s.claimedSite === -1)).toBe(true);
  });
});
