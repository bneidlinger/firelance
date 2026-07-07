import { describe, expect, it } from 'vitest';
import { smokeConfig as cfg } from '../config';
import { parseMap } from '../map/parse';
import type { SimEvent } from './events';
import { processDeath } from './systems/combat';
import { bountyTier, settleKillEconomy, totalGoldInWorld } from './systems/economy';
import { stepWorld } from './step';
import type { Player, World } from './world';
import { createWorld, PHASE_LIVE, spawnPlayer } from './world';

// The gold ledger and bounty rules — the economic core the design doc calls
// the emotional engine, plus every anti-farm protection it demands.

const arena = parseMap(
  'econ-arena',
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

function mkWorld(): World {
  const w = createWorld(1, cfg, arena);
  w.phase = PHASE_LIVE;
  w.phaseEndsTick = 1_000_000;
  return w;
}

function mk(w: World, squad: number, name: string): Player {
  const k = w.squads[squad]!;
  return spawnPlayer(w, cfg, squad, name, true, 'ranger', k.keepX, k.keepY);
}

/** Age a player past the fresh-spawn window without ticking the world. */
function mature(w: World, p: Player): void {
  p.spawnedAtTick = w.tick - cfg.bounty.freshSpawnSec * cfg.tick.simHz - 1;
}

describe('gold ledger', () => {
  it('kill mints killGold + victim bounty to the killer squad keep', () => {
    const w = mkWorld();
    const killer = mk(w, 0, 'killer');
    const victim = mk(w, 1, 'victim');
    mature(w, victim);
    victim.bounty = 100;

    const r = settleKillEconomy(w, cfg, killer, victim);
    expect(r.gold).toBe(cfg.bounty.killGold + 100 * cfg.bounty.payoutFactor);
    expect(w.squads[0]!.keepGold).toBe(r.gold);
    expect(w.goldMinted).toBe(r.gold);
    expect(totalGoldInWorld(w)).toBe(w.goldMinted); // conservation
    expect(killer.bounty).toBe(cfg.bounty.killBounty);
    expect(victim.bounty).toBe(Math.floor(100 * cfg.bounty.deathDecayTo));
  });

  it('killer-less deaths pay nobody and leave the bounty intact', () => {
    const w = mkWorld();
    const victim = mk(w, 1, 'victim');
    mature(w, victim);
    victim.bounty = 500;
    const events: SimEvent[] = [];
    processDeath(w, cfg, victim, null, events);
    expect(w.goldMinted).toBe(0);
    expect(victim.bounty).toBe(500); // dying to nothing never dumps a bounty
    const kill = events.find((e) => e.k === 'kill');
    expect(kill && kill.k === 'kill' && kill.killer).toBeNull();
  });
});

describe('anti-farm rules', () => {
  it('fresh spawns are worth zero', () => {
    const w = mkWorld();
    const killer = mk(w, 0, 'killer');
    const victim = mk(w, 1, 'victim'); // spawnedAtTick = now
    victim.bounty = 300;
    const r = settleKillEconomy(w, cfg, killer, victim);
    expect(r.gold).toBe(0);
    expect(killer.bounty).toBe(0);
    expect(w.goldMinted).toBe(0);
  });

  it('repeat kills on the same victim decay by the factor table', () => {
    const w = mkWorld();
    const killer = mk(w, 0, 'killer');
    const victim = mk(w, 1, 'victim');
    const golds: number[] = [];
    for (let i = 0; i < 4; i++) {
      mature(w, victim);
      victim.bounty = 0;
      golds.push(settleKillEconomy(w, cfg, killer, victim).gold);
      w.tick += 10; // well inside the repeat window
    }
    const base = cfg.bounty.killGold;
    expect(golds).toEqual([
      Math.round(base * 1),
      Math.round(base * 0.5),
      Math.round(base * 0.25),
      0,
    ]);
  });

  it('the repeat-kill window expires and rewards recover', () => {
    const w = mkWorld();
    const killer = mk(w, 0, 'killer');
    const victim = mk(w, 1, 'victim');
    mature(w, victim);
    settleKillEconomy(w, cfg, killer, victim);
    // Far beyond the window: full price again.
    w.tick += cfg.bounty.repeatKillWindowSec * cfg.tick.simHz + 10;
    mature(w, victim);
    const r = settleKillEconomy(w, cfg, killer, victim);
    expect(r.gold).toBe(cfg.bounty.killGold);
  });

  it('assists earn bounty credit only — gold mints exactly once', () => {
    const w = mkWorld();
    const killer = mk(w, 0, 'killer');
    const helper = mk(w, 2, 'helper');
    const victim = mk(w, 1, 'victim');
    mature(w, victim);
    victim.hp = 5;
    victim.recentDamagers.set(helper.id, w.tick - 5); // helper chipped in recently
    const events: SimEvent[] = [];
    processDeath(w, cfg, victim, killer, events);

    const kill = events.find((e) => e.k === 'kill');
    expect(kill && kill.k === 'kill' ? kill.assists : []).toEqual([helper.id]);
    expect(helper.assists).toBe(1);
    expect(helper.bounty).toBe(cfg.bounty.assistBounty);
    // Only the killer's squad got gold; the ledger balances.
    expect(w.squads[2]!.keepGold).toBe(0);
    expect(w.squads[0]!.keepGold).toBe(w.goldMinted);
  });

  it('stale damage outside the assist window earns nothing', () => {
    const w = mkWorld();
    const killer = mk(w, 0, 'killer');
    const helper = mk(w, 2, 'helper');
    const victim = mk(w, 1, 'victim');
    mature(w, victim);
    w.tick = 10_000;
    victim.recentDamagers.set(helper.id, w.tick - cfg.combat.assistWindowSec * cfg.tick.simHz - 5);
    const events: SimEvent[] = [];
    processDeath(w, cfg, victim, killer, events);
    expect(helper.assists).toBe(0);
  });
});

describe('bounty accrual', () => {
  it('survival ticks bounty upward while alive and live', () => {
    const w = mkWorld();
    const p = mk(w, 0, 'survivor');
    const interval = cfg.bounty.survivalTickSec * cfg.tick.simHz;
    for (let i = 0; i < interval * 3; i++) stepWorld(w, new Map(), cfg, arena);
    expect(p.bounty).toBe(3 * cfg.bounty.survivalBounty);
  });

  it('bountyTier maps thresholds to tiers 0..5', () => {
    const t = cfg.bounty.tierThresholds; // [0, 50, 150, 300, 500, 800]
    expect(bountyTier(cfg, 0)).toBe(0);
    expect(bountyTier(cfg, t[1]! - 1)).toBe(0);
    expect(bountyTier(cfg, t[1]!)).toBe(1);
    expect(bountyTier(cfg, t[3]!)).toBe(3);
    expect(bountyTier(cfg, t[5]! + 500)).toBe(5);
  });
});
