import type { GameConfig } from '../config';
import { createRng, rngInt } from '../math/rng';
import { distSq } from '../math/vec2';
import type { MapData } from './types';

// Per-match map variation (M5): a seeded draw of WHICH keep sites exist,
// WHICH towns are open, and WHO musters at WHICH spawn corner this match —
// the doc §13.2/§18.4 answer to solved openings. The variant is a pure
// function of (seed, cfg, map): the server derives it, ships the DESCRIPTOR
// in the welcome (never the seed — the seed would let a hacked client run the
// sim's rng forward), and client/bots apply it to their local copy of the
// base map. Everything downstream — sim systems, claim AI, POI rendering —
// keeps consuming plain MapData and never learns variation exists.
//
// Fairness rule: each squad's ANCHOR site (nearest free site to its spawn,
// greedy in squad order — the exact assignKeeps walk) is always active, so
// the placement-deadline auto-assign lands every squad somewhere sane no
// matter the draw. Extra sites and towns are where the variety lives.

export interface MapVariant {
  /** Active keep-site indices into the BASE map's keeps (ascending). */
  keeps: number[];
  /** Open town indices into the BASE map's towns (ascending). */
  towns: number[];
  /** spawns[i] = base spawn index squad i musters at (always a full
   *  permutation of the base spawn list, even with fewer squads). */
  spawns: number[];
}

/** The authored map, exactly: every site, every town, spawns in order. */
export function identityVariant(map: MapData): MapVariant {
  return {
    keeps: map.keeps.map((_, i) => i),
    towns: map.towns.map((_, i) => i),
    spawns: map.spawns.map((_, i) => i),
  };
}

/**
 * Deterministic per-match draw. Draw ORDER is a compatibility contract
 * (spawn shuffle → extra sites → towns): reordering it re-rolls every
 * recorded match, exactly like touching the sim's rng stream would.
 */
export function deriveVariant(seed: number, cfg: GameConfig, map: MapData): MapVariant {
  if (!cfg.variation.enabled) return identityVariant(map);
  // Own rng stream, decorrelated from world.rng (createRng(seed)) so variant
  // draws never share state with sim draws for the same seed.
  const rng = createRng((seed ^ 0x51ce5eed) >>> 0);

  // ---- spawn corners: full permutation; squad i takes entry i.
  const spawns = map.spawns.map((_, i) => i);
  if (cfg.variation.shuffleSpawns) {
    for (let i = spawns.length - 1; i > 0; i--) {
      const j = rngInt(rng, 0, i);
      const tmp = spawns[i]!;
      spawns[i] = spawns[j]!;
      spawns[j] = tmp;
    }
  }

  // ---- anchor sites: the greedy nearest-free-site walk assignKeeps and the
  // placement auto-assign both use, run over the SHUFFLED spawns — so the
  // active set always contains every squad's default landing spot.
  const anchors = new Set<number>();
  for (let s = 0; s < cfg.match.squads; s++) {
    const spawnIdx = spawns[s % spawns.length]!;
    const spawn = map.spawns[spawnIdx] ?? map.spawns[0]!;
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let k = 0; k < map.keeps.length; k++) {
      if (anchors.has(k)) continue;
      const d = distSq(spawn.x, spawn.y, map.keeps[k]!.x, map.keeps[k]!.y);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) anchors.add(best);
  }

  // ---- extra sites: draw from the non-anchor pool (shuffle, take N).
  const pool: number[] = [];
  for (let k = 0; k < map.keeps.length; k++) if (!anchors.has(k)) pool.push(k);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rngInt(rng, 0, i);
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  const extras = pool.slice(0, Math.max(0, Math.min(cfg.variation.extraSites, pool.length)));
  const keeps = [...anchors, ...extras].sort((a, b) => a - b);

  // ---- towns: draw N open ones (min 1 — banking must exist somewhere).
  const townPool = map.towns.map((_, i) => i);
  for (let i = townPool.length - 1; i > 0; i--) {
    const j = rngInt(rng, 0, i);
    const tmp = townPool[i]!;
    townPool[i] = townPool[j]!;
    townPool[j] = tmp;
  }
  const townCount = Math.max(1, Math.min(cfg.variation.townsActive, map.towns.length));
  const towns = townPool.slice(0, townCount).sort((a, b) => a - b);

  return { keeps, towns, spawns };
}

/**
 * Materialize a variant as plain MapData. Tile layers are SHARED references
 * (terrain never varies); only the POI lists swap. Throws on indices the base
 * map doesn't have — a server/client MAP drift (stale bundle) must fail as
 * loudly as a config drift does.
 */
export function applyVariant(base: MapData, v: MapVariant): MapData {
  const pick = <T>(arr: T[], idxs: number[], what: string): T[] =>
    idxs.map((i) => {
      const item = arr[i];
      if (item === undefined) {
        throw new Error(`map ${base.id}: variant ${what} index ${i} out of range (rebuild client?)`);
      }
      return item;
    });
  return {
    ...base,
    keeps: pick(base.keeps, v.keeps, 'keep'),
    towns: pick(base.towns, v.towns, 'town'),
    spawns: pick(base.spawns, v.spawns, 'spawn'),
  };
}
