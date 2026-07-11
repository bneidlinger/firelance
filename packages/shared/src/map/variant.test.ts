import { describe, expect, it } from 'vitest';
import { defaultConfig, smokeConfig, type GameConfig } from '../config';
import { assignKeeps } from '../sim/world';
import { getMap } from './maps';
import { applyVariant, deriveVariant, identityVariant, type MapVariant } from './variant';

// The M5 per-match map draw. These pin the three contracts everything else
// leans on: (1) the draw is a pure function of (seed, cfg, map); (2) fairness
// — every squad's greedy anchor site is always active, so the placement
// auto-assign can never strand a squad; (3) the draw actually varies between
// consecutive seeds (the server restarts with seed+1 — that step IS the
// "two matches play differently" gate).

const vale = getMap('vale_full');
const scrim = getMap('scrim_small');
const cfg = defaultConfig; // variation ON: 4 anchors + 3 extras, 2 towns, shuffle

/** The greedy nearest-free-site walk (assignKeeps order) over the BASE map —
 *  recomputed independently so the test doesn't trust deriveVariant's own. */
function anchorsFor(v: MapVariant, squads: number): number[] {
  const taken = new Set<number>();
  const out: number[] = [];
  for (let s = 0; s < squads; s++) {
    const spawn = vale.spawns[v.spawns[s % v.spawns.length]!]!;
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let k = 0; k < vale.keeps.length; k++) {
      if (taken.has(k)) continue;
      const d = (vale.keeps[k]!.x - spawn.x) ** 2 + (vale.keeps[k]!.y - spawn.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    taken.add(best);
    out.push(best);
  }
  return out;
}

describe('deriveVariant', () => {
  it('is the identity when variation is disabled', () => {
    expect(deriveVariant(123, smokeConfig, vale)).toEqual(identityVariant(vale));
    expect(deriveVariant(123, smokeConfig, scrim)).toEqual(identityVariant(scrim));
  });

  it('is deterministic: same seed, same draw', () => {
    for (const seed of [1, 7, 999, 123456]) {
      expect(deriveVariant(seed, cfg, vale)).toEqual(deriveVariant(seed, cfg, vale));
    }
  });

  it('draws valid, sorted, in-range subsets with a true spawn permutation', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const v = deriveVariant(seed, cfg, vale);
      // vale: 4 anchors + extraSites 3 of the 6 remaining = 7 active sites.
      expect(v.keeps).toHaveLength(7);
      expect(v.towns).toHaveLength(2);
      expect([...v.keeps].sort((a, b) => a - b)).toEqual(v.keeps);
      expect(new Set(v.keeps).size).toBe(v.keeps.length);
      for (const i of v.keeps) expect(i).toBeGreaterThanOrEqual(0);
      for (const i of v.keeps) expect(i).toBeLessThan(vale.keeps.length);
      expect(new Set(v.towns).size).toBe(2);
      for (const i of v.towns) expect(i).toBeLessThan(vale.towns.length);
      expect([...v.spawns].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    }
  });

  it('every squad anchor site is active, and auto-assign lands exactly on it', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const v = deriveVariant(seed, cfg, vale);
      const anchors = anchorsFor(v, cfg.match.squads);
      for (const a of anchors) expect(v.keeps).toContain(a);
      // The greedy walk over the ACTIVE set must coincide with the anchor
      // walk over ALL sites — the fairness proof that the deadline
      // auto-assign never hands a squad something worse than its default.
      const assigned = assignKeeps(applyVariant(vale, v), cfg.match.squads);
      assigned.forEach((pos, s) => {
        expect(pos).toEqual(vale.keeps[anchors[s]!]!);
      });
    }
  });

  it('scrim_small: all 7 sites and both towns stay active (pool ≤ knobs); only spawns shuffle', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const v = deriveVariant(seed, cfg, scrim);
      expect(v.keeps).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(v.towns).toEqual([0, 1]);
    }
  });

  it('varies across seeds — and between CONSECUTIVE seeds (the restart step)', () => {
    const draws = new Set<string>();
    let consecutiveDiffer = 0;
    let prev = '';
    for (let seed = 1; seed <= 50; seed++) {
      const key = JSON.stringify(deriveVariant(seed, cfg, vale));
      draws.add(key);
      if (seed > 1 && key !== prev) consecutiveDiffer++;
      prev = key;
    }
    expect(draws.size).toBeGreaterThanOrEqual(40); // of 50 — near-unique boards
    expect(consecutiveDiffer).toBeGreaterThanOrEqual(45); // of 49 restart steps
  });

  it('townsActive clamps to at least one open town', () => {
    const greedy: GameConfig = { ...cfg, variation: { ...cfg.variation, townsActive: 0 } };
    for (let seed = 1; seed <= 10; seed++) {
      expect(deriveVariant(seed, greedy, vale).towns).toHaveLength(1);
    }
  });
});

describe('applyVariant', () => {
  it('materializes the descriptor and SHARES tile layers with the base', () => {
    const v = deriveVariant(5, cfg, vale);
    const m = applyVariant(vale, v);
    expect(m.keeps).toEqual(v.keeps.map((i) => vale.keeps[i]!));
    expect(m.towns).toEqual(v.towns.map((i) => vale.towns[i]!));
    expect(m.spawns).toEqual(v.spawns.map((i) => vale.spawns[i]!));
    expect(m.walk).toBe(vale.walk);
    expect(m.vision).toBe(vale.vision);
    expect(m.forest).toBe(vale.forest);
    expect(m.id).toBe(vale.id);
  });

  it('round-trips the identity variant', () => {
    const m = applyVariant(vale, identityVariant(vale));
    expect(m.keeps).toEqual(vale.keeps);
    expect(m.towns).toEqual(vale.towns);
    expect(m.spawns).toEqual(vale.spawns);
  });

  it('throws loudly on indices the base map does not have (map drift)', () => {
    const bad = identityVariant(vale);
    bad.keeps = [0, 99];
    expect(() => applyVariant(vale, bad)).toThrow(/out of range/);
  });
});
