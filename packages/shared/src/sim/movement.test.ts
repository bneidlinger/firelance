import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import { parseMap } from '../map/parse';
import type { MoveState } from './systems/movement';
import { pushoutPairs, stepMovement } from './systems/movement';
import type { InputCmd } from './world';

const map = parseMap(
  'move-fixture',
  `
##########
#1..2..K.#
#..##....#
#..##..T.#
#3..4..K.#
#........#
#........#
##########
`,
);

const cfg = defaultConfig;
const DT = 1 / cfg.tick.simHz;
const R = cfg.player.radius;

function input(mx: number, my: number): InputCmd {
  return { mx, my, ax: 1, ay: 0, b: 0 };
}

function run(s: MoveState, cmd: InputCmd, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepMovement(s, cmd, cfg, map, DT);
}

describe('movement kernel', () => {
  it('normalizes diagonal input to moveSpeed', () => {
    const s: MoveState = { x: 5.5, y: 5.5, vx: 0, vy: 0 };
    stepMovement(s, input(1, 1), cfg, map, DT);
    const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
    expect(speed).toBeCloseTo(cfg.player.moveSpeed, 6);
  });

  it('stops at walls instead of tunneling', () => {
    const s: MoveState = { x: 5.5, y: 5.5, vx: 0, vy: 0 };
    run(s, input(-1, 0), 60); // 2s left at 5 u/s would reach x=-4.5 unimpeded
    // border wall occupies [0,1); circle rests at 1 + radius (+skin)
    expect(s.x).toBeGreaterThan(1 + R - 0.01);
    expect(s.x).toBeLessThan(1 + R + 0.01);
    expect(s.y).toBeCloseTo(5.5, 5);
  });

  it('slides along walls on diagonal input', () => {
    const s: MoveState = { x: 2.0, y: 5.5, vx: 0, vy: 0 };
    run(s, input(-1, 1), 60);
    // x clamps against the left border, y clamps against the bottom border
    expect(s.x).toBeCloseTo(1 + R, 2);
    expect(s.y).toBeCloseTo(7 - R, 2);
  });

  it('is a pure function of (state, input): two identical runs agree bit-exactly', () => {
    const a: MoveState = { x: 5.5, y: 5.5, vx: 0, vy: 0 };
    const b: MoveState = { x: 5.5, y: 5.5, vx: 0, vy: 0 };
    const cmds = [input(1, 0), input(1, 1), input(0, -1), input(-1, 0.5)];
    for (let i = 0; i < 200; i++) {
      const cmd = cmds[i % cmds.length]!;
      stepMovement(a, cmd, cfg, map, DT);
      stepMovement(b, cmd, cfg, map, DT);
    }
    expect(a.x).toBe(b.x);
    expect(a.y).toBe(b.y);
    expect(a.vx).toBe(b.vx);
    expect(a.vy).toBe(b.vy);
  });
});

describe('player pushout', () => {
  it('separates overlapping circles to exactly 2r apart', () => {
    const a: MoveState = { x: 5.0, y: 5.0, vx: 0, vy: 0 };
    const b: MoveState = { x: 5.3, y: 5.0, vx: 0, vy: 0 };
    pushoutPairs([a, b], R, map);
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    expect(d).toBeCloseTo(2 * R, 5);
    // symmetric push
    expect((a.x + b.x) / 2).toBeCloseTo(5.15, 5);
  });

  it('handles perfectly stacked circles deterministically', () => {
    const a: MoveState = { x: 5.0, y: 5.0, vx: 0, vy: 0 };
    const b: MoveState = { x: 5.0, y: 5.0, vx: 0, vy: 0 };
    pushoutPairs([a, b], R, map);
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    expect(d).toBeCloseTo(2 * R, 5);
    expect(a.x).toBeLessThan(b.x); // fallback axis is +x by index order
  });

  it('does not push players through walls; separation converges over ticks', () => {
    // a sits against the left border; b overlaps from the right. A single pass
    // can't fully separate them (the wall blocks half the push) — the pair
    // relaxes over successive ticks instead, like every other contact.
    const a: MoveState = { x: 1 + R + 0.001, y: 5.5, vx: 0, vy: 0 };
    const b: MoveState = { x: 1 + R + 0.3, y: 5.5, vx: 0, vy: 0 };
    for (let i = 0; i < 8; i++) pushoutPairs([a, b], R, map);
    // wall invariant: never inside the border wall
    expect(a.x).toBeGreaterThanOrEqual(1 + R - 1e-6);
    // b got squeezed outward and the pair is (near-)separated
    expect(b.x).toBeGreaterThan(1 + R + 0.3);
    expect(b.x - a.x).toBeGreaterThanOrEqual(2 * R - 0.02);
  });

  it('leaves non-overlapping circles untouched', () => {
    const a: MoveState = { x: 3, y: 5.5, vx: 0, vy: 0 };
    const b: MoveState = { x: 6, y: 5.5, vx: 0, vy: 0 };
    pushoutPairs([a, b], R, map);
    expect(a.x).toBe(3);
    expect(b.x).toBe(6);
  });
});
