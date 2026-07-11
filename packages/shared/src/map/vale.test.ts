import { describe, expect, it } from 'vitest';
import { getMap } from './maps';
import { isWalkBlocked } from './types';
import { assignKeeps } from '../sim/world';

// vale_full geometry contract. The map is hand-editable ASCII (authored via
// scripts/gen-vale-map.ts, tweakable in place) — these tests keep edits
// honest: every landmark must stay mutually reachable, and the greedy
// auto-assign must keep giving each squad its corner default so a no-claims
// match still opens with a sane spread.

const map = getMap('vale_full');

describe('vale_full geometry', () => {
  it('has the doc §13.1 inventory', () => {
    expect(map.width).toBe(128);
    expect(map.height).toBe(128);
    expect(map.keeps.length).toBe(10);
    expect(map.towns.length).toBe(3);
    expect(map.spawns.length).toBe(4);
  });

  it('every keep, town, and spawn is reachable from spawn 1 (flood fill)', () => {
    const w = map.width;
    const seen = new Uint8Array(w * map.height);
    const s0 = map.spawns[0]!;
    const q = [Math.floor(s0.y) * w + Math.floor(s0.x)];
    seen[q[0]!] = 1;
    while (q.length) {
      const i = q.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= map.height) continue;
        const ni = ny * w + nx;
        if (seen[ni] || isWalkBlocked(map, nx, ny)) continue;
        seen[ni] = 1;
        q.push(ni);
      }
    }
    const landmarks = [...map.keeps, ...map.towns, ...map.spawns];
    for (const p of landmarks) {
      expect(
        seen[Math.floor(p.y) * w + Math.floor(p.x)],
        `landmark (${p.x},${p.y}) unreachable`,
      ).toBe(1);
    }
  });

  it('greedy auto-assign gives each squad its corner default, in order', () => {
    const assigned = assignKeeps(map, 4);
    expect(assigned.map((k) => [k.x, k.y])).toEqual([
      [20.5, 20.5],
      [107.5, 20.5],
      [20.5, 107.5],
      [107.5, 107.5],
    ]);
  });

  it('keep sites keep their doc §8.1 hygiene: none inside a town tile or water', () => {
    for (const k of map.keeps) {
      expect(isWalkBlocked(map, Math.floor(k.x), Math.floor(k.y))).toBe(false);
      for (const t of map.towns) {
        expect(Math.hypot(t.x - k.x, t.y - k.y)).toBeGreaterThan(3);
      }
    }
  });
});
