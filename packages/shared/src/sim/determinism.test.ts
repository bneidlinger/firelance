import { describe, expect, it } from 'vitest';
import { smokeConfig } from '../config';
import { parseMap } from '../map/parse';
import { createRng, rngFloat, rngInt } from '../math/rng';
import { stepWorld } from './step';
import type { InputCmd, PlayerId, World } from './world';
import { BTN_BLOCK, BTN_DASH, BTN_FIRE, createWorld, hashWorld, spawnPlayer } from './world';

// The determinism contract: same seed + same scripted inputs => bit-identical
// world state. This single test guards forever against wall-clock reads,
// Math.random leaks, and iteration-order dependence inside the sim — now
// including the full M1 combat/economy path (arrows, melee, deaths, gold).

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

function runScriptedMatch(ticks: number): { hashes: string[]; world: World } {
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
        current.set(id, { mx, my, ax, ay, b });
      }
    }
    stepWorld(world, current, smokeConfig, arena);
    if (world.tick % 100 === 0) hashes.push(hashWorld(world));
  }
  hashes.push(hashWorld(world));
  return { hashes, world };
}

describe('simulation determinism', () => {
  it('two identical 1000-tick combat runs produce identical world hashes', () => {
    const a = runScriptedMatch(1000);
    const b = runScriptedMatch(1000);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.hashes.length).toBeGreaterThan(5);
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

  it('gold conservation holds at the end of a combat run', () => {
    const { world } = runScriptedMatch(1000);
    let pooled = 0;
    for (const s of world.squads) pooled += s.keepGold;
    expect(pooled).toBe(world.goldMinted);
  });
});
