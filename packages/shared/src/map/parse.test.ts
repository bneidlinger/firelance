import { describe, expect, it } from 'vitest';
import { parseMap } from './parse';
import { isWalkBlocked, isVisionBlocked } from './types';
import { scrimSmall } from './maps/scrim_small';
import { getMap } from './maps';

const TINY = `
##########
#1..2..K.#
#..##....#
#..##..T.#
#3..4..K.#
#........#
#..ff....#
##########
`;

describe('map parser', () => {
  it('parses the tiny fixture with correct flags and POIs', () => {
    const m = parseMap('tiny', TINY);
    expect(m.width).toBe(10);
    expect(m.height).toBe(8);
    expect(m.spawns).toHaveLength(4);
    expect(m.keeps).toHaveLength(2);
    expect(m.towns).toHaveLength(1);
    // border blocks walk + vision
    expect(isWalkBlocked(m, 0, 0)).toBe(true);
    expect(isVisionBlocked(m, 0, 0)).toBe(true);
    // inner wall block
    expect(isWalkBlocked(m, 3, 2)).toBe(true);
    // open ground
    expect(isWalkBlocked(m, 1, 5)).toBe(false);
    // forest: walkable, flagged, does not block vision rays
    expect(isWalkBlocked(m, 3, 6)).toBe(false);
    expect(m.forest[6 * m.width + 3]).toBe(1);
    expect(isVisionBlocked(m, 3, 6)).toBe(false);
    // out of bounds counts as blocked
    expect(isWalkBlocked(m, -1, 0)).toBe(true);
    expect(isWalkBlocked(m, 10, 0)).toBe(true);
  });

  it('rejects ragged rows', () => {
    expect(() => parseMap('bad', '####\n##\n####')).toThrow(/length/);
  });

  it('rejects unknown tiles', () => {
    expect(() => parseMap('bad', '##\n#x')).toThrow(/unknown tile/);
  });

  it('rejects maps missing spawns', () => {
    expect(() => parseMap('bad', '####\n#KT#\n####')).toThrow(/missing spawn/);
  });
});

describe('scrim_small', () => {
  it('is 96x96 with 4 spawns, 7 keep sites, 2 towns (one per river side)', () => {
    expect(scrimSmall.width).toBe(96);
    expect(scrimSmall.height).toBe(96);
    expect(scrimSmall.spawns).toHaveLength(4);
    // M4 placement: 4 corner defaults + near-town/bridge/forest-edge choices.
    expect(scrimSmall.keeps).toHaveLength(7);
    const has = (x: number, y: number): boolean =>
      scrimSmall.keeps.some((k) => k.x === x + 0.5 && k.y === y + 0.5);
    expect(has(44, 28)).toBe(true); // near the north town
    expect(has(24, 52)).toBe(true); // south of the west bridge
    expect(has(57, 71)).toBe(true); // south forest edge
    expect(scrimSmall.towns).toHaveLength(2);
    // Bank runs need a route CHOICE: one town north of the river, one south.
    const ys = scrimSmall.towns.map((t) => t.y).sort((a, b) => a - b);
    expect(ys[0]).toBeLessThan(46);
    expect(ys[1]).toBeGreaterThan(49);
  });

  it('the 3 new choice sites never steal a squad spawn-corner default', () => {
    // Placement auto-assign must reproduce the M0–M3 layout when nobody
    // claims: each spawn's nearest site is still its original corner keep.
    const corners = [
      { x: 16.5, y: 36.5 },
      { x: 78.5, y: 36.5 },
      { x: 16.5, y: 60.5 },
      { x: 80.5, y: 56.5 },
    ];
    scrimSmall.spawns.forEach((spawn, squad) => {
      let best = { x: 0, y: 0 };
      let bestD = Number.POSITIVE_INFINITY;
      for (const k of scrimSmall.keeps) {
        const d = (k.x - spawn.x) ** 2 + (k.y - spawn.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      expect([best.x, best.y]).toEqual([corners[squad]!.x, corners[squad]!.y]);
    });
  });

  it('river blocks walking but bridges are walkable', () => {
    // river spans rows 46-49; bridge columns are 22-27 and 68-73
    expect(isWalkBlocked(scrimSmall, 10, 47)).toBe(true); // water
    expect(isWalkBlocked(scrimSmall, 24, 47)).toBe(false); // west bridge
    expect(isWalkBlocked(scrimSmall, 70, 48)).toBe(false); // east bridge
    // water does not block vision rays
    expect(isVisionBlocked(scrimSmall, 10, 47)).toBe(false);
  });

  it('all spawn points and POIs are on walkable ground', () => {
    for (const p of [...scrimSmall.spawns, ...scrimSmall.keeps, ...scrimSmall.towns]) {
      expect(isWalkBlocked(scrimSmall, Math.floor(p.x), Math.floor(p.y))).toBe(false);
    }
  });

  it('is registered in the map registry', () => {
    expect(getMap('scrim_small')).toBe(scrimSmall);
    expect(() => getMap('nope')).toThrow(/Unknown map/);
  });
});
