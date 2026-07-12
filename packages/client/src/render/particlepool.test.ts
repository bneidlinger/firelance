import { describe, expect, it } from 'vitest';
import type { EmitSpec } from '../fx/config';
import { ParticlePool } from './particlepool';

// The juice-kit pool contract (M6 s1): fixed slots, ring-steal on exhaustion,
// zero allocation after boot, and integration that a renderer can trust.

const SPEC: EmitSpec = {
  count: 4,
  colors: [0xff0000],
  speed: [2, 2],
  life: [200, 200],
  size: [1, 1],
};

const mid = (): number => 0.5;

describe('ParticlePool', () => {
  it('emits into free slots and counts them alive', () => {
    const pool = new ParticlePool(16);
    pool.emit(0, 0, SPEC, 12, 1000, mid);
    expect(pool.aliveCount()).toBe(4);
    expect(pool.emitted).toBe(4);
    expect(pool.stolen).toBe(0);
  });

  it('expires particles past their life and reuses the slots without stealing', () => {
    const pool = new ParticlePool(8);
    pool.emit(0, 0, SPEC, 12, 1000, mid);
    pool.step(1300, 16); // t = 1.5 — all dead
    expect(pool.aliveCount()).toBe(0);
    pool.emit(0, 0, { ...SPEC, count: 8 }, 12, 1400, mid);
    expect(pool.aliveCount()).toBe(8);
    expect(pool.stolen).toBe(0); // dead slots are free, not stolen
  });

  it('overwrites the oldest emission when the pool is exhausted', () => {
    const pool = new ParticlePool(8);
    pool.emit(0, 0, { ...SPEC, count: 8 }, 12, 1000, mid);
    pool.emit(0, 0, { ...SPEC, count: 2, colors: [0x00ff00] }, 12, 1050, mid);
    expect(pool.stolen).toBe(2);
    expect(pool.aliveCount()).toBe(8); // cap holds
    const greens = pool.slots.filter((p) => p.color === 0x00ff00);
    expect(greens).toHaveLength(2);
    // The ring stole the FIRST two written, not the newest.
    expect(pool.slots[0]!.color).toBe(0x00ff00);
    expect(pool.slots[1]!.color).toBe(0x00ff00);
    expect(pool.slots[2]!.color).toBe(0xff0000);
  });

  it('integrates velocity and expires on schedule', () => {
    const pool = new ParticlePool(4);
    // rand = 0 → angle 0 (east), speed = min = 2 u/s × 12 px/u = 24 px/s.
    pool.emit(120, 240, { ...SPEC, count: 1, speed: [2, 4] }, 12, 0, () => 0);
    pool.step(100, 100); // halfway through the 200ms life
    const p = pool.slots[0]!;
    expect(p.alive).toBe(true);
    expect(p.xPx).toBeCloseTo(120 + 24 * 0.1, 5);
    expect(p.yPx).toBeCloseTo(240, 5);
    pool.step(201, 1); // past the 200ms life
    expect(p.alive).toBe(false);
  });

  it('applies gravity downward and drag as decay', () => {
    const pool = new ParticlePool(4);
    const spec: EmitSpec = { ...SPEC, count: 1, gravity: 10, drag: 3 };
    pool.emit(0, 0, spec, 12, 0, () => 0);
    const p = pool.slots[0]!;
    const vx0 = p.vxPx;
    pool.step(100, 100);
    expect(p.vyPx).toBeGreaterThan(0); // gravity pulls +y (world south)
    expect(Math.abs(p.vxPx)).toBeLessThan(Math.abs(vx0)); // drag bleeds speed
  });

  it('clear kills everything', () => {
    const pool = new ParticlePool(8);
    pool.emit(0, 0, SPEC, 12, 1000, mid);
    pool.clear();
    expect(pool.aliveCount()).toBe(0);
  });
});
