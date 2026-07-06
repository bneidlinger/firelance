import { describe, expect, it } from 'vitest';
import { createRng, rngFloat, rngInt, rngPick } from './rng';

describe('mulberry32 rng', () => {
  it('same seed produces the same sequence', () => {
    const a = createRng(1234);
    const b = createRng(1234);
    for (let i = 0; i < 1000; i++) {
      expect(rngFloat(a)).toBe(rngFloat(b));
    }
  });

  it('different seeds diverge', () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 10 }, () => rngFloat(a));
    const seqB = Array.from({ length: 10 }, () => rngFloat(b));
    expect(seqA).not.toEqual(seqB);
  });

  it('rngFloat stays in [0, 1)', () => {
    const r = createRng(42);
    for (let i = 0; i < 10_000; i++) {
      const v = rngFloat(r);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('rngInt covers the inclusive range', () => {
    const r = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(rngInt(r, 3, 6));
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it('rngPick only returns array members and rejects empty arrays', () => {
    const r = createRng(9);
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 100; i++) expect(arr).toContain(rngPick(r, arr));
    expect(() => rngPick(r, [])).toThrow();
  });
});
