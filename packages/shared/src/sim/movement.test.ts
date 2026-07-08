import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../config';
import { parseMap } from '../map/parse';
import type { MoveState } from './systems/movement';
import {
  createMoveState,
  isBlocking,
  kitMoveParams,
  pushoutPairs,
  stepMovement,
} from './systems/movement';
import type { InputCmd } from './world';
import { BTN_BLOCK, BTN_DASH } from './world';

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
const RANGER = kitMoveParams(cfg, 'ranger');
const FIGHTER = kitMoveParams(cfg, 'fighter');

function input(mx: number, my: number, b = 0, ax = 1, ay = 0): InputCmd {
  return { mx, my, ax, ay, b };
}

function run(s: MoveState, cmd: InputCmd, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepMovement(s, cmd, RANGER, map, DT);
}

describe('movement kernel', () => {
  it('normalizes diagonal input to the class move speed', () => {
    const s = createMoveState(5.5, 5.5);
    stepMovement(s, input(1, 1), RANGER, map, DT);
    const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
    expect(speed).toBeCloseTo(RANGER.moveSpeed, 6);
  });

  it('speedFactor scales walking exactly (the M2 carry slow enters the kernel)', () => {
    const s = createMoveState(5.5, 5.5);
    stepMovement(s, input(1, 0), RANGER, map, DT, 0.7);
    expect(s.vx).toBeCloseTo(RANGER.moveSpeed * 0.7, 6);
    // Identical calls with the same factor on both "sides" are bit-identical —
    // the client predicts carriers through this exact path.
    const a = createMoveState(5.5, 5.5);
    const b = createMoveState(5.5, 5.5);
    for (let i = 0; i < 30; i++) {
      stepMovement(a, input(1, 0.3), RANGER, map, DT, 0.62);
      stepMovement(b, input(1, 0.3), RANGER, map, DT, 0.62);
    }
    expect(a).toEqual(b);
  });

  it('speedFactor does NOT slow the dash (the escape tool keeps full strength)', () => {
    const slow = createMoveState(5.5, 6.5);
    const fast = createMoveState(5.5, 5.5);
    stepMovement(slow, input(1, 0, BTN_DASH), RANGER, map, DT, 0.5);
    stepMovement(fast, input(1, 0, BTN_DASH), RANGER, map, DT, 1);
    expect(slow.vx).toBeCloseTo(fast.vx, 6);
    expect(slow.vx).toBeCloseTo(RANGER.dashSpeed, 6);
  });

  it('stops at walls instead of tunneling', () => {
    const s = createMoveState(5.5, 5.5);
    run(s, input(-1, 0), 60); // 2s left at 5 u/s would reach x=-4.5 unimpeded
    // border wall occupies [0,1); circle rests at 1 + radius (+skin)
    expect(s.x).toBeGreaterThan(1 + R - 0.01);
    expect(s.x).toBeLessThan(1 + R + 0.01);
    expect(s.y).toBeCloseTo(5.5, 5);
  });

  it('slides along walls on diagonal input', () => {
    const s = createMoveState(2.0, 5.5);
    run(s, input(-1, 1), 60);
    // x clamps against the left border, y clamps against the bottom border
    expect(s.x).toBeCloseTo(1 + R, 2);
    expect(s.y).toBeCloseTo(7 - R, 2);
  });

  it('is a pure function of (state, input): two identical runs agree bit-exactly', () => {
    const a = createMoveState(5.5, 5.5);
    const b = createMoveState(5.5, 5.5);
    const cmds = [
      input(1, 0),
      input(1, 1, BTN_DASH),
      input(0, -1),
      input(-1, 0.5, BTN_BLOCK),
      input(0, 0),
      input(1, 0, BTN_DASH),
    ];
    for (let i = 0; i < 300; i++) {
      const cmd = cmds[i % cmds.length]!;
      stepMovement(a, cmd, FIGHTER, map, DT);
      stepMovement(b, cmd, FIGHTER, map, DT);
    }
    expect(a).toEqual(b);
  });
});

// Long open corridor: dashes travel multiple units and need runway.
const corridor = parseMap(
  'dash-corridor',
  `
########################################
#1.2.3.4.K.K.T.........................#
#......................................#
########################################
`,
);

describe('dash', () => {
  it('displaces along the move direction and stops when the dash ends', () => {
    const s = createMoveState(5, 2.5);
    stepMovement(s, input(1, 0, BTN_DASH), RANGER, corridor, DT);
    expect(s.dashTicks).toBe(RANGER.dashDurTicks - 1); // triggered, first tick consumed
    const expected = RANGER.dashSpeed * RANGER.dashDurTicks * DT;
    // Hold the button; edge triggering must NOT restart the dash.
    for (let i = 0; i < RANGER.dashDurTicks - 1; i++) {
      stepMovement(s, input(1, 0, BTN_DASH), RANGER, corridor, DT);
    }
    expect(s.x).toBeCloseTo(5 + expected, 4);
    expect(s.dashTicks).toBe(0);
    expect(s.dashCd).toBeGreaterThan(0);
  });

  it('is edge-triggered: holding the button gives exactly one dash per press', () => {
    // Short-cooldown variant so a held button WOULD re-dash if edge detection broke.
    const params = { ...RANGER, dashCdTicks: 3 };
    const s = createMoveState(5, 2.5);
    for (let i = 0; i < 30; i++) stepMovement(s, input(1, 0, BTN_DASH), params, corridor, DT);
    const oneDash = params.dashSpeed * params.dashDurTicks * DT;
    const walk = params.moveSpeed * (30 - params.dashDurTicks) * DT;
    expect(s.x).toBeCloseTo(5 + oneDash + walk, 3);
  });

  it('release and re-press dashes again only after the cooldown', () => {
    const s = createMoveState(2, 2);
    stepMovement(s, input(1, 0, BTN_DASH), RANGER, map, DT);
    expect(s.dashTicks).toBeGreaterThan(0);
    // finish dash, release button
    for (let i = 0; i < RANGER.dashDurTicks; i++) stepMovement(s, input(0, 0, 0), RANGER, map, DT);
    // re-press immediately: cooldown blocks it
    stepMovement(s, input(1, 0, BTN_DASH), RANGER, map, DT);
    expect(s.dashTicks).toBe(0);
    // wait out the cooldown, re-press: dashes
    for (let i = 0; i < RANGER.dashCdTicks + 1; i++)
      stepMovement(s, input(0, 0, 0), RANGER, map, DT);
    stepMovement(s, input(1, 0, BTN_DASH), RANGER, map, DT);
    expect(s.dashTicks).toBeGreaterThan(0);
  });

  it('falls back to aim direction when standing still', () => {
    const s = createMoveState(5.5, 5.5);
    stepMovement(s, input(0, 0, BTN_DASH, 0, -1), RANGER, map, DT);
    expect(s.dashDy).toBe(-1);
    expect(s.vy).toBeLessThan(0);
  });

  it('cannot dash through walls', () => {
    const s = createMoveState(2.0, 5.5);
    stepMovement(s, input(-1, 0, BTN_DASH), RANGER, map, DT);
    for (let i = 0; i < 10; i++) stepMovement(s, input(-1, 0, 0), RANGER, map, DT);
    expect(s.x).toBeGreaterThan(1); // clamped at the border wall, not inside it
  });
});

describe('shield block', () => {
  it('slows fighters while held', () => {
    const s = createMoveState(5.5, 5.5);
    stepMovement(s, input(1, 0, BTN_BLOCK), FIGHTER, map, DT);
    expect(s.vx).toBeCloseTo(FIGHTER.moveSpeed * FIGHTER.blockMoveFactor, 6);
  });

  it('does nothing for shieldless classes', () => {
    const s = createMoveState(5.5, 5.5);
    stepMovement(s, input(1, 0, BTN_BLOCK), RANGER, map, DT);
    expect(s.vx).toBeCloseTo(RANGER.moveSpeed, 6);
  });

  it('isBlocking is false mid-dash or without a shield', () => {
    expect(isBlocking(BTN_BLOCK, true, 0)).toBe(true);
    expect(isBlocking(BTN_BLOCK, true, 3)).toBe(false);
    expect(isBlocking(BTN_BLOCK, false, 0)).toBe(false);
    expect(isBlocking(0, true, 0)).toBe(false);
  });
});

describe('player pushout', () => {
  it('separates overlapping circles to exactly 2r apart', () => {
    const a = createMoveState(5.0, 5.0);
    const b = createMoveState(5.3, 5.0);
    pushoutPairs([a, b], R, map);
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    expect(d).toBeCloseTo(2 * R, 5);
    // symmetric push
    expect((a.x + b.x) / 2).toBeCloseTo(5.15, 5);
  });

  it('handles perfectly stacked circles deterministically', () => {
    const a = createMoveState(5.0, 5.0);
    const b = createMoveState(5.0, 5.0);
    pushoutPairs([a, b], R, map);
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    expect(d).toBeCloseTo(2 * R, 5);
    expect(a.x).toBeLessThan(b.x); // fallback axis is +x by index order
  });

  it('does not push players through walls; separation converges over ticks', () => {
    // a sits against the left border; b overlaps from the right. A single pass
    // can't fully separate them (the wall blocks half the push) — the pair
    // relaxes over successive ticks instead, like every other contact.
    const a = createMoveState(1 + R + 0.001, 5.5);
    const b = createMoveState(1 + R + 0.3, 5.5);
    for (let i = 0; i < 8; i++) pushoutPairs([a, b], R, map);
    // wall invariant: never inside the border wall
    expect(a.x).toBeGreaterThanOrEqual(1 + R - 1e-6);
    // b got squeezed outward and the pair is (near-)separated
    expect(b.x).toBeGreaterThan(1 + R + 0.3);
    expect(b.x - a.x).toBeGreaterThanOrEqual(2 * R - 0.02);
  });

  it('leaves non-overlapping circles untouched', () => {
    const a = createMoveState(3, 5.5);
    const b = createMoveState(6, 5.5);
    pushoutPairs([a, b], R, map);
    expect(a.x).toBe(3);
    expect(b.x).toBe(6);
  });
});
