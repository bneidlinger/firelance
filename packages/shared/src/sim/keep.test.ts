import { describe, expect, it } from 'vitest';
import { smokeConfig as cfg } from '../config';
import { secToTicks } from '../config';
import { parseMap } from '../map/parse';
import type { SimEvent } from './events';
import { stepWorld } from './step';
import { processDeath } from './systems/combat';
import { mintGoldToKeep, settleKillEconomy, totalGoldInWorld } from './systems/economy';
import type { InputCmd, Player, PlayerId, World } from './world';
import { BTN_BOMB, BTN_INTERACT, createWorld, PHASE_ENDED, PHASE_LIVE, spawnPlayer } from './world';

// Milestone 3's dramatic arc, through real stepWorld ticks: firebombs crack a
// keep → the vault hits the ground → respawns stop and the squad fights in
// exile → one emergency rebuild buys the comeback — or elimination ends the
// story. Conservation across every pool is asserted after each scenario tick.

const arena = parseMap(
  'keep-arena',
  `
####################
#1................2#
#..K............K..#
#.........T........#
#..K............K..#
#3................4#
####################
`,
);

const FLIGHT_TICKS = secToTicks(cfg, cfg.firebomb.flightSec);
const REBUILD_TICKS = secToTicks(cfg, cfg.keep.rebuildChannelSec);

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

function run(w: World, inputs: Map<PlayerId, InputCmd>, n: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    events.push(...stepWorld(w, inputs, cfg, arena));
    expect(totalGoldInWorld(w), `conservation @ tick ${w.tick}`).toBe(w.goldMinted);
  }
  return events;
}

/** Stand a thrower exactly bomb-range away from a keep, aiming dead-on. */
function throwerAt(w: World, squad: number, targetSquad: number): Player {
  const t = w.squads[targetSquad]!;
  const p = mk(w, squad, `sapper${squad}`);
  p.x = t.keepX - cfg.firebomb.range;
  p.y = t.keepY;
  return p;
}

const THROW: InputCmd = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_BOMB };

describe('firebombs', () => {
  it('throws are edge-triggered, consume ammo, fly, then blast the keep', () => {
    const w = mkWorld();
    const p = throwerAt(w, 0, 1);
    const target = w.squads[1]!;
    const hp0 = target.keepHp;

    const events = run(w, new Map([[p.id, THROW]]), 1);
    expect(p.bombs).toBe(cfg.firebomb.carried - 1);
    expect(w.bombs.size).toBe(1);
    expect(events.some((e) => e.k === 'bombSpawn')).toBe(true);

    // Holding the button is NOT a re-throw (edge-triggered) — and the cooldown
    // guards the next press anyway.
    run(w, new Map([[p.id, THROW]]), FLIGHT_TICKS - 1);
    expect(p.bombs).toBe(cfg.firebomb.carried - 1);

    const landEvents = run(w, new Map([[p.id, THROW]]), 1);
    expect(w.bombs.size).toBe(0);
    expect(landEvents.some((e) => e.k === 'bombEnd')).toBe(true);
    expect(target.keepHp).toBe(hp0 - cfg.firebomb.damage);
    expect(landEvents.some((e) => e.k === 'keepHit' && e.squad === 1)).toBe(true);
  });

  it('splashes enemies in the circle — straight through a raised shield', () => {
    const w = mkWorld();
    const p = throwerAt(w, 0, 1);
    const victim = mk(w, 1, 'defender', 'fighter');
    victim.x = w.squads[1]!.keepX;
    victim.y = w.squads[1]!.keepY;
    victim.spawnedAtTick = -10_000;
    const bystander = mk(w, 0, 'friend');
    bystander.x = victim.x;
    bystander.y = victim.y + 0.5;
    const hp0 = victim.hp;

    // Defender blocks facing the thrower — shields don't stop a blast.
    const block: InputCmd = { mx: 0, my: 0, ax: -1, ay: 0, b: 2 };
    const inputs = new Map([
      [p.id, THROW],
      [victim.id, block],
    ]);
    const allyHp0 = bystander.hp;
    const events = run(w, inputs, FLIGHT_TICKS + 1);
    const hit = events.find((e) => e.k === 'hit' && e.kind === 'bomb');
    expect(hit && hit.k === 'hit' ? hit.blocked : true).toBe(false);
    expect(victim.hp).toBeCloseTo(hp0 - cfg.firebomb.playerDamage, 5);
    expect(bystander.hp).toBe(allyHp0); // thrower's ally: untouched
  });

  it('never damages the thrower squad structures or allies (no friendly fire)', () => {
    const w = mkWorld();
    const p = throwerAt(w, 1, 1); // aiming at their OWN keep
    const own = w.squads[1]!;
    const hp0 = own.keepHp;
    run(w, new Map([[p.id, THROW]]), FLIGHT_TICKS + 1);
    expect(own.keepHp).toBe(hp0);
  });

  it('restocks inside your own living keep circle — not at a ruin', () => {
    const w = mkWorld();
    const p = mk(w, 0, 'runner');
    p.bombs = 0;
    run(w, new Map([[p.id, IDLE]]), 1); // standing at own keep
    expect(p.bombs).toBe(cfg.firebomb.carried);

    p.bombs = 0;
    w.squads[0]!.keepHp = 0;
    run(w, new Map([[p.id, IDLE]]), 5);
    expect(p.bombs).toBe(0); // no keep, no armory
  });
});

describe('melee chip and the alarm', () => {
  it('a sword swing chips the keep once per swing', () => {
    const w = mkWorld();
    const p = mk(w, 0, 'axeman', 'fighter');
    const target = w.squads[1]!;
    p.x = target.keepX - (cfg.classes.fighter.melee!.range + cfg.keep.radius);
    p.y = target.keepY;
    p.spawnedAtTick = -10_000;
    const hp0 = target.keepHp;
    const swing: InputCmd = { mx: 0, my: 0, ax: 1, ay: 0, b: 1 };
    run(w, new Map([[p.id, swing]]), 20); // one full swing cycle
    expect(target.keepHp).toBe(hp0 - cfg.keep.meleeDamage);
  });

  it('alarms throttle: a bombardment sends one keepHit per cooldown window', () => {
    const w = mkWorld();
    const a = throwerAt(w, 0, 1);
    const b = throwerAt(w, 2, 1);
    b.y += 1; // no pushout stacking
    const inputs = new Map([
      [a.id, THROW],
      [b.id, THROW],
    ]);
    const events = run(w, inputs, FLIGHT_TICKS + 2);
    // (The cramped arena lets blast b clip squad 3's keep too — filter to the
    // besieged squad; ITS two same-tick blasts must produce exactly one alarm.)
    const alarms = events.filter((e) => e.k === 'keepHit' && e.squad === 1);
    expect(alarms).toHaveLength(1);
    expect(w.squads[1]!.keepHp).toBe(cfg.keep.maxHp - 2 * cfg.firebomb.damage);
  });
});

describe('destruction: the vault hits the ground', () => {
  function destroyKeep(w: World, squad: number, attackerSquad = 0): SimEvent[] {
    w.squads[squad]!.keepHp = 1; // one blast finishes it
    const p = throwerAt(w, attackerSquad, squad);
    return run(w, new Map([[p.id, THROW]]), FLIGHT_TICKS + 1);
  }

  it('spills the ENTIRE vault as sacks at the ruin and stops respawns', () => {
    const w = mkWorld();
    mintGoldToKeep(w, 1, 950);
    const defender = mk(w, 1, 'defender');
    defender.spawnedAtTick = -10_000;
    // Stand clear of the ruin: a body ON the site would auto-loot the spill
    // the instant it lands (learned that the hard way).
    defender.y -= 3;

    const events = destroyKeep(w, 1);
    const destroyed = events.find((e) => e.k === 'keepDestroyed');
    expect(destroyed && destroyed.k === 'keepDestroyed' ? destroyed.spilled : 0).toBe(950);
    expect(w.squads[1]!.keepGold).toBe(0);
    expect([...w.sacks.values()].reduce((s, k) => s + k.gold, 0)).toBe(950);

    // Kill the defender: the timer expires but nobody comes back.
    const ev2: SimEvent[] = [];
    processDeath(w, cfg, defender, null, ev2);
    run(w, new Map(), secToTicks(cfg, cfg.player.respawnSec) + 60);
    expect(defender.alive).toBe(false);
  });

  it("exile kills mint to the killer's BACK, not the ruined vault (§8.5)", () => {
    const w = mkWorld();
    const killer = mk(w, 1, 'exile');
    const victim = mk(w, 2, 'victim');
    victim.spawnedAtTick = -10_000;
    victim.bounty = 100;
    w.squads[1]!.keepHp = 0; // exiled

    const r = settleKillEconomy(w, cfg, killer, victim);
    expect(r.gold).toBeGreaterThan(0);
    expect(killer.carried).toBe(r.gold);
    expect(w.squads[1]!.keepGold).toBe(0);
    expect(totalGoldInWorld(w)).toBe(w.goldMinted);
  });
});

describe('the emergency rebuild', () => {
  function exiledBuilderAtOwnRuin(w: World): Player {
    const squad = w.squads[0]!;
    squad.keepHp = 0;
    const p = mk(w, 0, 'builder');
    p.carried = cfg.keep.rebuildCost + 50;
    w.goldMinted += p.carried;
    // Standing at the old site — their own ruin is a legal rebuild spot.
    p.x = squad.keepX;
    p.y = squad.keepY;
    return p;
  }

  const CHANNEL: InputCmd = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_INTERACT };

  it('channels at the ruin, pays the cost INTO the new vault, wakes the dead', () => {
    const w = mkWorld();
    const p = exiledBuilderAtOwnRuin(w);
    const squad = w.squads[0]!;
    const deadMate = mk(w, 0, 'fallen');
    const ev: SimEvent[] = [];
    processDeath(w, cfg, deadMate, null, ev);
    run(w, new Map(), secToTicks(cfg, cfg.player.respawnSec) + 30);
    expect(deadMate.alive).toBe(false); // gated: no keep

    const events = run(w, new Map([[p.id, CHANNEL]]), REBUILD_TICKS);
    expect(events.some((e) => e.k === 'keepRebuilt')).toBe(true);
    expect(squad.keepHp).toBe(Math.round(cfg.keep.maxHp * cfg.keep.rebuildHpFactor));
    expect(squad.rebuildsLeft).toBe(0);
    expect(p.carried).toBe(50); // cost left the back...
    expect(squad.keepGold).toBe(cfg.keep.rebuildCost); // ...and seeded the vault
    expect(totalGoldInWorld(w)).toBe(w.goldMinted);

    // The fallen come home on a fresh timer.
    run(w, new Map(), secToTicks(cfg, cfg.player.respawnSec) + 2);
    expect(deadMate.alive).toBe(true);
  });

  it('needs the cost on your back, an unoccupied site, and is single-use', () => {
    const w = mkWorld();
    const p = exiledBuilderAtOwnRuin(w);
    const squad = w.squads[0]!;

    // Test pokes re-derive the ledger total afterward — incremental
    // adjustments fight the live withdraw trickle.
    const resync = (): void => {
      w.goldMinted = totalGoldInWorld(w);
    };

    // Broke: nothing happens.
    p.carried = cfg.keep.rebuildCost - 1;
    resync();
    run(w, new Map([[p.id, CHANNEL]]), 30);
    expect(p.rebuildTicks).toBe(0);

    // Funded but standing at an ENEMY's living keep site: rejected.
    p.carried = cfg.keep.rebuildCost;
    resync();
    p.x = w.squads[1]!.keepX;
    p.y = w.squads[1]!.keepY;
    run(w, new Map([[p.id, CHANNEL]]), 30);
    expect(p.rebuildTicks).toBe(0);

    // Back home: works once...
    p.x = squad.keepX;
    p.y = squad.keepY;
    run(w, new Map([[p.id, CHANNEL]]), REBUILD_TICKS + 2);
    expect(squad.keepHp).toBeGreaterThan(0);

    // ...and never again: second destruction is final.
    squad.keepHp = 0;
    p.carried = cfg.keep.rebuildCost;
    resync();
    run(w, new Map([[p.id, CHANNEL]]), REBUILD_TICKS + 30);
    expect(squad.keepHp).toBe(0);
    expect(p.rebuildTicks).toBe(0);
  });

  it('movement breaks the rebuild channel like any other channel', () => {
    const w = mkWorld();
    const p = exiledBuilderAtOwnRuin(w);
    run(w, new Map([[p.id, CHANNEL]]), REBUILD_TICKS - 10);
    expect(p.rebuildTicks).toBe(REBUILD_TICKS - 10);
    const creep: InputCmd = { mx: 0.5, my: 0, ax: 1, ay: 0, b: BTN_INTERACT };
    run(w, new Map([[p.id, creep]]), 1);
    expect(p.rebuildTicks).toBe(0);
  });
});

describe('elimination and the early end', () => {
  it('no keep + nobody alive = eliminated; last squad standing ends the match', () => {
    const w = mkWorld();
    // Populate two squads; squads 2/3 stay empty (living keeps keep them "in").
    const a = mk(w, 0, 'a');
    const b = mk(w, 1, 'b');
    a.spawnedAtTick = -10_000;
    b.spawnedAtTick = -10_000;
    w.squads[1]!.bankedGold = 300;
    w.goldMinted += 300;

    // Squad 1 loses its keep, then its last member: eliminated.
    w.squads[1]!.keepHp = 0;
    const ev: SimEvent[] = [];
    processDeath(w, cfg, b, null, ev);
    let events = run(w, new Map(), 1);
    expect(events.some((e) => e.k === 'eliminated' && e.squad === 1)).toBe(true);
    expect(w.squads[1]!.eliminated).toBe(true);
    expect(w.phase).toBe(PHASE_LIVE); // three contenders remain (0, 2, 3)

    // Squads 2 and 3 fall too (empty squads with dead keeps eliminate instantly).
    w.squads[2]!.keepHp = 0;
    w.squads[3]!.keepHp = 0;
    events = run(w, new Map(), 1);
    expect(w.phase).toBe(PHASE_ENDED);
    // Winners: the sole survivor — NOT the eliminated squad with 300 banked.
    expect(w.winners).toEqual([0]);
    const end = events.find((e) => e.k === 'matchEnd');
    expect(end && end.k === 'matchEnd' ? end.standings[0]!.squad : -1).toBe(0);
    expect(
      end && end.k === 'matchEnd' ? end.standings.find((s) => s.squad === 1)?.eliminated : false,
    ).toBe(true);
  });
});
