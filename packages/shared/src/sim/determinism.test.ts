import { describe, expect, it } from 'vitest';
import { smokeConfig } from '../config';
import { scrimSmall } from '../map/maps/scrim_small';
import { createRng, rngFloat, rngInt } from '../math/rng';
import { stepWorld } from './step';
import type { InputCmd, PlayerId, World } from './world';
import { createWorld, hashWorld, spawnPlayer } from './world';

// The determinism contract: same seed + same scripted inputs => bit-identical
// world state. This single test guards forever against wall-clock reads,
// Math.random leaks, and iteration-order dependence inside the sim.

const DIRS: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

function runScriptedMatch(ticks: number): { hashes: string[]; world: World } {
  const world = createWorld(0xf1a5e, smokeConfig);
  const players: PlayerId[] = [];
  for (let squad = 0; squad < 4; squad++) {
    const s = scrimSmall.spawns[squad]!;
    players.push(spawnPlayer(world, squad, `bot${squad}`, true, s.x, s.y).id);
  }

  // Input script comes from its own rng — NOT world.rng — so the script is
  // identical across runs regardless of what the sim consumes.
  const script = createRng(0xdead);
  const current = new Map<PlayerId, InputCmd>();
  const hashes: string[] = [];

  for (let t = 0; t < ticks; t++) {
    for (const id of players) {
      if (!current.has(id) || rngFloat(script) < 0.05) {
        const [mx, my] = DIRS[rngInt(script, 0, DIRS.length - 1)]!;
        current.set(id, { mx, my, ax: 1, ay: 0, b: 0 });
      }
    }
    stepWorld(world, current, smokeConfig, scrimSmall);
    if (world.tick % 100 === 0) hashes.push(hashWorld(world));
  }
  hashes.push(hashWorld(world));
  return { hashes, world };
}

describe('simulation determinism', () => {
  it('two identical 1000-tick runs produce identical world hashes', () => {
    const a = runScriptedMatch(1000);
    const b = runScriptedMatch(1000);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.hashes.length).toBeGreaterThan(5);
  });

  it('players actually moved during the scripted run (test is not vacuous)', () => {
    const { world } = runScriptedMatch(1000);
    let moved = 0;
    for (const p of world.players.values()) {
      const spawn = scrimSmall.spawns[p.squad]!;
      if (Math.hypot(p.x - spawn.x, p.y - spawn.y) > 1) moved++;
    }
    expect(moved).toBeGreaterThanOrEqual(3);
  });

  it('players never end up inside walls or out of bounds', () => {
    const { world } = runScriptedMatch(1000);
    for (const p of world.players.values()) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.y).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(scrimSmall.width);
      expect(p.y).toBeLessThan(scrimSmall.height);
    }
  });
});
