import { describe, expect, it } from 'vitest';
import { FX } from '../fx/config';
import { loadLevels, panFor, saveLevels, Throttle, type AudioLevels } from './mixer';

// Audio policy (M6 s1): pan clamps, the spam gate's exact window behavior,
// and settings persistence surviving garbage storage.

describe('panFor', () => {
  it('centers at zero offset and scales linearly to the range edge', () => {
    expect(panFor(0)).toBe(0);
    expect(panFor(FX.audio.panRangeUnits / 2)).toBeCloseTo(FX.audio.panMax / 2, 5);
    expect(panFor(FX.audio.panRangeUnits)).toBeCloseTo(FX.audio.panMax, 5);
    expect(panFor(-FX.audio.panRangeUnits)).toBeCloseTo(-FX.audio.panMax, 5);
  });

  it('clamps beyond the range instead of hard-panning', () => {
    expect(panFor(1000)).toBe(FX.audio.panMax);
    expect(panFor(-1000)).toBe(-FX.audio.panMax);
  });
});

describe('Throttle', () => {
  it('gates same-name repeats inside the window and frees them after', () => {
    const th = new Throttle();
    expect(th.allow('meleeHit', 1000, 55)).toBe(true);
    expect(th.allow('meleeHit', 1030, 55)).toBe(false);
    expect(th.allow('meleeHit', 1056, 55)).toBe(true);
  });

  it('a denied attempt does not reset the window', () => {
    const th = new Throttle();
    th.allow('coin', 1000, 90);
    expect(th.allow('coin', 1080, 90)).toBe(false);
    expect(th.allow('coin', 1091, 90)).toBe(true); // 91ms after the PLAYED one
  });

  it('names throttle independently', () => {
    const th = new Throttle();
    expect(th.allow('shoot', 1000, 55)).toBe(true);
    expect(th.allow('arrowHit', 1001, 55)).toBe(true);
  });
});

const memStorage = (): Pick<Storage, 'getItem' | 'setItem'> & { mem: Map<string, string> } => {
  const mem = new Map<string, string>();
  return {
    mem,
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
};

describe('audio levels persistence', () => {
  it('empty storage yields the defaults', () => {
    expect(loadLevels(memStorage())).toEqual(FX.audio.defaults);
    expect(loadLevels(null)).toEqual(FX.audio.defaults);
  });

  it('round-trips saved levels', () => {
    const store = memStorage();
    const levels: AudioLevels = { master: 0.25, sfx: 0.8, ambient: 0 };
    saveLevels(store, levels);
    expect(loadLevels(store)).toEqual(levels);
  });

  it('survives garbage and clamps out-of-range values per-field', () => {
    const store = memStorage();
    store.mem.set('fl.audio.v1', 'not json{');
    expect(loadLevels(store)).toEqual(FX.audio.defaults);
    store.mem.set('fl.audio.v1', JSON.stringify({ master: 7, sfx: 'loud' }));
    const got = loadLevels(store);
    expect(got.master).toBe(1); // clamped
    expect(got.sfx).toBe(FX.audio.defaults.sfx); // garbage → that field's default
    expect(got.ambient).toBe(FX.audio.defaults.ambient); // missing → default
  });
});
