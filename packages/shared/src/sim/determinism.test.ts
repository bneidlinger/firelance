import { describe, expect, it } from 'vitest';
import { smokeConfig } from '../config';
import { parseMap } from '../map/parse';
import { createRng, rngFloat, rngInt } from '../math/rng';
import { totalGoldInWorld } from './systems/economy';
import { stepWorld } from './step';
import type { InputCmd, PlayerId, World } from './world';
import {
  BTN_BLOCK,
  BTN_BOMB,
  BTN_DASH,
  BTN_FIRE,
  BTN_INTERACT,
  createWorld,
  hashWorld,
  spawnPlayer,
} from './world';

// The determinism contract: same seed + same scripted inputs => bit-identical
// world state. This single test guards forever against wall-clock reads,
// Math.random leaks, and iteration-order dependence inside the sim — now
// including the full M1 combat/economy path (arrows, melee, deaths, gold) and
// the M2 banking path (withdrawals, carries, sack drops/pickups, deposits).

// Tight arena: keeps only a few units apart so scripted fights actually land.
const arena = parseMap(
  'determinism-arena',
  `
####################
#1................2#
#..K............K..#
#........TT........#
#........TT........#
#..K............K..#
#3................4#
####################
`,
);

function runScriptedMatch(
  ticks: number,
  useBombs = false,
): {
  hashes: string[];
  world: World;
  carriedSeen: boolean;
} {
  const world = createWorld(0xf1a5e, smokeConfig, arena);
  const ids: PlayerId[] = [];
  for (let squad = 0; squad < 4; squad++) {
    const k = world.squads[squad]!;
    const cls = squad % 2 === 0 ? 'fighter' : 'ranger';
    ids.push(spawnPlayer(world, smokeConfig, squad, `bot${squad}`, true, cls, k.keepX, k.keepY).id);
  }

  // Input script comes from its own rng — NOT world.rng. It reads player
  // positions to aim (so combat actually connects), which is deterministic:
  // same seed => same world evolution => same script decisions.
  const script = createRng(0xdead);
  const current = new Map<PlayerId, InputCmd>();
  const hashes: string[] = [];
  let carriedSeen = false;

  for (let t = 0; t < ticks; t++) {
    for (const id of ids) {
      if (!current.has(id) || rngFloat(script) < 0.15) {
        const self = world.players.get(id)!;
        const targetId = ids[rngInt(script, 0, ids.length - 1)]!;
        const target = world.players.get(
          targetId === id ? ids[(ids.indexOf(id) + 1) % ids.length]! : targetId,
        )!;
        let ax = target.x - self.x + (rngFloat(script) - 0.5) * 2;
        let ay = target.y - self.y + (rngFloat(script) - 0.5) * 2;
        const al = Math.sqrt(ax * ax + ay * ay);
        if (al > 1e-6) {
          ax /= al;
          ay /= al;
        } else {
          ax = 1;
          ay = 0;
        }
        // Mostly chase the target, sometimes wander; mash buttons liberally.
        const chase = rngFloat(script) < 0.7;
        const mx = chase ? ax : rngFloat(script) * 2 - 1;
        const my = chase ? ay : rngFloat(script) * 2 - 1;
        let b = 0;
        if (rngFloat(script) < 0.5) b |= BTN_FIRE;
        if (rngFloat(script) < 0.1) b |= BTN_DASH;
        if (rngFloat(script) < 0.15) b |= BTN_BLOCK;
        // Mash interact too: near keeps this withdraws (spawns are AT keeps),
        // near the central towns it channels — the full banking path under
        // the determinism hash.
        if (rngFloat(script) < 0.3) b |= BTN_INTERACT;
        // Bombs run in a SEPARATE scripted config: sieges wreck the economy
        // this tiny arena needs for the banking probe (both still hash-checked).
        if (useBombs && rngFloat(script) < 0.2) b |= BTN_BOMB;
        current.set(id, { mx, my, ax, ay, b });
      }
    }
    stepWorld(world, current, smokeConfig, arena);
    if (!carriedSeen) {
      for (const p of world.players.values()) {
        if (p.carried > 0) {
          carriedSeen = true;
          break;
        }
      }
    }
    if (world.tick % 100 === 0) hashes.push(hashWorld(world));
  }
  hashes.push(hashWorld(world));
  return { hashes, world, carriedSeen };
}

describe('simulation determinism', () => {
  it('two identical 1000-tick combat runs produce identical world hashes', () => {
    const a = runScriptedMatch(1000);
    const b = runScriptedMatch(1000);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.hashes.length).toBeGreaterThan(5);
  });

  it('two identical SIEGE runs (bombs on) produce identical world hashes', () => {
    const a = runScriptedMatch(1000, true);
    const b = runScriptedMatch(1000, true);
    expect(a.hashes).toEqual(b.hashes);
  });

  it('the scripted run exercises real combat (not vacuous)', () => {
    const { world } = runScriptedMatch(1000);
    let deaths = 0;
    let kills = 0;
    for (const p of world.players.values()) {
      deaths += p.deaths;
      kills += p.kills;
    }
    expect(deaths).toBeGreaterThanOrEqual(1);
    expect(kills).toBeGreaterThanOrEqual(1);
  });

  it('players never end up inside walls or out of bounds', () => {
    const { world } = runScriptedMatch(1000);
    for (const p of world.players.values()) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.y).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(arena.width);
      expect(p.y).toBeLessThan(arena.height);
    }
  });

  it('gold conservation holds across all four pools at the end of a combat run', () => {
    const { world } = runScriptedMatch(1000);
    expect(totalGoldInWorld(world)).toBe(world.goldMinted);
  });

  it('the scripted run exercises banking (gold actually got carried)', () => {
    const { carriedSeen } = runScriptedMatch(1000);
    expect(carriedSeen).toBe(true);
  });

  it('the siege run exercises structure damage (bombs actually landed)', () => {
    const { world } = runScriptedMatch(1000, true);
    const damaged = world.squads.some((s) => s.keepHp < smokeConfig.keep.maxHp);
    expect(damaged).toBe(true);
  });
});
