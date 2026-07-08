import { describe, expect, it } from 'vitest';
import { smokeConfig as cfg } from '../config';
import { secToTicks } from '../config';
import { parseMap } from '../map/parse';
import type { SimEvent } from './events';
import { stepWorld } from './step';
import {
  carrySpeedFactor,
  mintGoldToKeep,
  totalGoldInWorld,
  withdrawableGold,
} from './systems/economy';
import type { InputCmd, Player, PlayerId, World } from './world';
import { BTN_FIRE, BTN_INTERACT, createWorld, PHASE_LIVE, spawnPlayer } from './world';

// Milestone 2's core loop, end to end through real stepWorld ticks: withdraw
// (trickle + the 75/25 reserve floor) → the slow walk → the stand-still
// deposit channel (and everything that breaks it) → drop-on-death sacks →
// plunder. Gold conservation across all four pools is asserted after every
// scenario; the determinism suite covers the same paths under the hash.

// Keeps far enough from the town that interact circles never overlap.
const arena = parseMap(
  'bank-arena',
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

const WITHDRAW_PER_TICK = Math.max(1, Math.round(cfg.banking.withdrawPerSec / cfg.tick.simHz));
const CHANNEL_TICKS = secToTicks(cfg, cfg.banking.bankChannelSec);
const TOWN = arena.towns[0]!;

function mkWorld(): World {
  const w = createWorld(1, cfg, arena);
  w.phase = PHASE_LIVE;
  w.phaseEndsTick = 1_000_000;
  return w;
}

function mk(w: World, squad: number, name: string, cls: 'fighter' | 'ranger' = 'ranger'): Player {
  const k = w.squads[squad]!;
  return spawnPlayer(w, cfg, squad, name, true, cls, k.keepX, k.keepY);
}

const IDLE: InputCmd = { mx: 0, my: 0, ax: 1, ay: 0, b: 0 };
const HOLD_E: InputCmd = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_INTERACT };

/** Step the world n ticks with fixed per-player inputs, collecting events. */
function run(w: World, inputs: Map<PlayerId, InputCmd>, n: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    events.push(...stepWorld(w, inputs, cfg, arena));
    expect(totalGoldInWorld(w), `conservation @ tick ${w.tick}`).toBe(w.goldMinted);
  }
  return events;
}

/** Teleport a player next to the town (inside the interact circle). */
function placeAtTown(p: Player): void {
  p.x = TOWN.x + 0.6;
  p.y = TOWN.y;
}

/**
 * Load a carrier through the REAL withdraw path (mint plenty → trickle at the
 * keep for exactly gold/rate ticks), then walk-teleport them to the town.
 * Every intermediate state is one the live game can produce.
 */
function loadedAtTown(w: World, squad: number, gold: number): Player {
  expect(gold % WITHDRAW_PER_TICK).toBe(0); // keep test loads rate-aligned
  const p = mk(w, squad, `carrier${squad}`);
  mintGoldToKeep(w, squad, gold * 2); // allowance 1.5×gold — floor never hit
  run(w, new Map([[p.id, HOLD_E]]), gold / WITHDRAW_PER_TICK);
  expect(p.carried).toBe(gold);
  placeAtTown(p);
  return p;
}

describe('withdraw: the vault trickle and the 75/25 reserve', () => {
  it('holding interact at the keep loads withdrawPerSec, stopping exactly at the floor', () => {
    const w = mkWorld();
    const p = mk(w, 0, 'banker');
    mintGoldToKeep(w, 0, 1000);
    const squad = w.squads[0]!;
    expect(withdrawableGold(cfg, squad)).toBe(750); // reserve = ceil(1000 × 0.25)

    run(w, new Map([[p.id, HOLD_E]]), 1);
    expect(p.carried).toBe(WITHDRAW_PER_TICK);

    run(w, new Map([[p.id, HOLD_E]]), 200); // way past empty
    expect(p.carried).toBe(750);
    expect(squad.keepGold).toBe(250); // the raid bait never leaves
    expect(withdrawableGold(cfg, squad)).toBe(0);
  });

  it('earning more re-opens the allowance (floor is 25% of LIFETIME, not of balance)', () => {
    const w = mkWorld();
    const p = mk(w, 0, 'banker');
    mintGoldToKeep(w, 0, 1000);
    run(w, new Map([[p.id, HOLD_E]]), 200);
    expect(p.carried).toBe(750);

    mintGoldToKeep(w, 0, 400); // lifetime 1400 ⇒ reserve 350; keep 250+400=650
    expect(withdrawableGold(cfg, w.squads[0]!)).toBe(300);
    run(w, new Map([[p.id, HOLD_E]]), 200);
    expect(p.carried).toBe(1050);
    expect(w.squads[0]!.keepGold).toBe(350);
  });

  it('no interact, or away from the keep, moves nothing', () => {
    const w = mkWorld();
    const p = mk(w, 0, 'idler');
    mintGoldToKeep(w, 0, 500);
    run(w, new Map([[p.id, IDLE]]), 30);
    expect(p.carried).toBe(0);

    placeAtTown(p); // interact far from home does not withdraw
    run(w, new Map([[p.id, HOLD_E]]), 30);
    expect(p.carried).toBe(0);
    expect(w.squads[0]!.keepGold).toBe(500);
  });

  it('withdrawing at an ENEMY keep does nothing (only your own vault opens)', () => {
    const w = mkWorld();
    const thief = mk(w, 1, 'thief');
    mintGoldToKeep(w, 0, 500);
    const victim = w.squads[0]!;
    thief.x = victim.keepX;
    thief.y = victim.keepY;
    run(w, new Map([[thief.id, HOLD_E]]), 30);
    expect(thief.carried).toBe(0);
    expect(victim.keepGold).toBe(500);
  });
});

describe('carry slow curve', () => {
  it('matches the config curve and clamps at the floor', () => {
    expect(carrySpeedFactor(cfg, 0)).toBe(1);
    expect(carrySpeedFactor(cfg, 100)).toBeCloseTo(1 - cfg.banking.slowPer100Gold, 10);
    expect(carrySpeedFactor(cfg, 500)).toBeCloseTo(1 - 5 * cfg.banking.slowPer100Gold, 10);
    expect(carrySpeedFactor(cfg, 100000)).toBe(cfg.banking.minSpeedFactor);
  });

  it('a loaded carrier covers less ground than an empty twin (through stepWorld)', () => {
    const w = mkWorld();
    const light = mk(w, 0, 'light');
    const heavy = mk(w, 2, 'heavy');
    // Same row, far apart (no pushout interaction); both walk east.
    light.x = 3.5;
    light.y = 2.5;
    heavy.x = 3.5;
    heavy.y = 4.5;
    heavy.carried = 1000;
    w.goldMinted += 1000; // keep the ledger honest for the run() assertion
    const east: InputCmd = { mx: 1, my: 0, ax: 1, ay: 0, b: 0 };
    const inputs = new Map([
      [light.id, east],
      [heavy.id, east],
    ]);
    run(w, inputs, 30);
    const lightDist = light.x - 3.5;
    const heavyDist = heavy.x - 3.5;
    expect(heavyDist).toBeLessThan(lightDist * 0.75);
    expect(heavyDist).toBeGreaterThan(lightDist * carrySpeedFactor(cfg, 1000) - 0.01);
  });
});

describe('deposit channel: 4 seconds of standing very still', () => {
  it('completes after exactly bankChannelSec and banks everything carried', () => {
    const w = mkWorld();
    const p = loadedAtTown(w, 0, 600);
    const inputs = new Map([[p.id, HOLD_E]]);
    run(w, inputs, CHANNEL_TICKS - 1);
    expect(p.bankTicks).toBe(CHANNEL_TICKS - 1);
    expect(w.squads[0]!.bankedGold).toBe(0);

    const events = run(w, inputs, 1);
    expect(p.carried).toBe(0);
    expect(p.bankTicks).toBe(0);
    expect(w.squads[0]!.bankedGold).toBe(600);
    const banked = events.find((e) => e.k === 'banked');
    expect(banked && banked.k === 'banked' ? banked.amount : 0).toBe(600);
    expect(banked && banked.k === 'banked' ? banked.squad : -1).toBe(0);
  });

  it('movement input resets the channel to zero (no partial credit)', () => {
    const w = mkWorld();
    const p = loadedAtTown(w, 0, 600);
    run(w, new Map([[p.id, HOLD_E]]), CHANNEL_TICKS - 5);
    expect(p.bankTicks).toBe(CHANNEL_TICKS - 5);

    const creep: InputCmd = { mx: 0.4, my: 0, ax: 1, ay: 0, b: BTN_INTERACT };
    run(w, new Map([[p.id, creep]]), 1);
    expect(p.bankTicks).toBe(0);
    run(w, new Map([[p.id, HOLD_E]]), CHANNEL_TICKS - 1); // restart from scratch
    expect(w.squads[0]!.bankedGold).toBe(0);
    run(w, new Map([[p.id, HOLD_E]]), 1);
    expect(w.squads[0]!.bankedGold).toBe(600);
  });

  it('attacking mid-channel resets it (you cannot bank sword-first)', () => {
    const w = mkWorld();
    const p = loadedAtTown(w, 0, 600);
    run(w, new Map([[p.id, HOLD_E]]), 10);
    expect(p.bankTicks).toBe(10);
    const firing: InputCmd = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_INTERACT | BTN_FIRE };
    run(w, new Map([[p.id, firing]]), 1);
    expect(p.bankTicks).toBe(0);
  });

  it('releasing interact or stepping outside the circle resets it', () => {
    const w = mkWorld();
    const p = loadedAtTown(w, 0, 600);
    run(w, new Map([[p.id, HOLD_E]]), 10);
    run(w, new Map([[p.id, IDLE]]), 1);
    expect(p.bankTicks).toBe(0);

    run(w, new Map([[p.id, HOLD_E]]), 10);
    p.x = TOWN.x + cfg.banking.interactRadius + 1; // shoved/teleported out
    run(w, new Map([[p.id, HOLD_E]]), 1);
    expect(p.bankTicks).toBe(0);
  });

  it('a contesting attacker breaks the channel with every landed hit', () => {
    const w = mkWorld();
    const p = loadedAtTown(w, 0, 600);
    const bully = mk(w, 1, 'bully', 'fighter');
    bully.x = p.x + 1.2;
    bully.y = p.y;
    const swingAt: InputCmd = { mx: 0, my: 0, ax: -1, ay: 0, b: BTN_FIRE };
    const inputs = new Map([
      [p.id, HOLD_E],
      [bully.id, swingAt],
    ]);
    // Fighter swings land every ~25 ticks — far inside the 120-tick channel.
    // Watch a long stretch: the deposit must never complete under pressure.
    for (let i = 0; i < 4 * CHANNEL_TICKS; i++) {
      run(w, inputs, 1);
      expect(w.squads[0]!.bankedGold).toBe(0);
      if (!p.alive) break; // 34 dmg per swing eventually kills the 90hp ranger
    }

    if (p.alive) {
      // Peace restored: remove the bully, channel completes cleanly.
      w.players.delete(bully.id);
      run(w, new Map([[p.id, HOLD_E]]), CHANNEL_TICKS);
      expect(w.squads[0]!.bankedGold).toBe(600);
    } else {
      // Died channeling: the load hit the ground instead of the bank.
      expect(w.squads[0]!.bankedGold).toBe(0);
      expect([...w.sacks.values()].reduce((s, k) => s + k.gold, 0)).toBe(600);
    }
  });

  it('empty-handed channeling does nothing (no zero-gold banked events)', () => {
    const w = mkWorld();
    const p = mk(w, 0, 'poser');
    placeAtTown(p);
    const events = run(w, new Map([[p.id, HOLD_E]]), CHANNEL_TICKS + 10);
    expect(events.some((e) => e.k === 'banked')).toBe(false);
    expect(p.bankTicks).toBe(0);
  });
});

describe('sacks: dying with gold, and everyone scrambling for it', () => {
  it('a killed carrier drops exactly their load as a sack; the kill event says so', () => {
    const w = mkWorld();
    const carrier = loadedAtTown(w, 0, 400);
    carrier.spawnedAtTick = -10_000; // past fresh-spawn protection

    const killer = mk(w, 1, 'killer', 'fighter');
    killer.x = carrier.x + 1.2;
    killer.y = carrier.y;
    const swing: InputCmd = { mx: 0, my: 0, ax: -1, ay: 0, b: BTN_FIRE };
    const inputs = new Map([
      [carrier.id, HOLD_E],
      [killer.id, swing],
    ]);
    let events: SimEvent[] = [];
    for (let i = 0; i < 300 && carrier.alive; i++) events.push(...run(w, inputs, 1));

    expect(carrier.alive).toBe(false);
    expect(carrier.carried).toBe(0);
    const sacks = [...w.sacks.values()];
    expect(sacks).toHaveLength(1);
    expect(sacks[0]!.gold).toBe(400);
    expect(Math.hypot(sacks[0]!.x - carrier.x, sacks[0]!.y - carrier.y)).toBeLessThan(0.01);
    const kill = events.find((e) => e.k === 'kill');
    expect(kill && kill.k === 'kill' ? kill.droppedGold : -1).toBe(400);
  });

  it('anyone walks over a sack and takes it — including the squad that dropped it', () => {
    const w = mkWorld();
    const owner = mk(w, 0, 'owner');
    w.sacks.set(w.nextId++, { id: w.nextId - 1, x: 9.5, y: 4.6, gold: 250, bornTick: 0 });
    w.goldMinted += 250;
    owner.x = 9.5;
    owner.y = 5.9; // just outside pickup range
    const north: InputCmd = { mx: 0, my: -1, ax: 0, ay: -1, b: 0 };
    const events = run(w, new Map([[owner.id, north]]), 20);
    expect(owner.carried).toBe(250);
    expect(w.sacks.size).toBe(0);
    const taken = events.find((e) => e.k === 'sackTaken');
    expect(taken && taken.k === 'sackTaken' ? taken.gold : 0).toBe(250);
  });

  it('plunder is never taxed: loot banks in full with zero lifetime earnings', () => {
    const w = mkWorld();
    const vulture = mk(w, 3, 'vulture');
    w.sacks.set(w.nextId++, {
      id: w.nextId - 1,
      x: TOWN.x + 0.6,
      y: TOWN.y,
      gold: 999,
      bornTick: 0,
    });
    w.goldMinted += 999;
    placeAtTown(vulture);
    // Walks over the sack standing at the town, then channels it straight in.
    run(w, new Map([[vulture.id, HOLD_E]]), CHANNEL_TICKS + 5);
    expect(w.squads[3]!.bankedGold).toBe(999);
    expect(w.squads[3]!.lifetimeGold).toBe(0); // never earned a coin — kept it all
  });
});
