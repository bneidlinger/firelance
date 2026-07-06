// Mulberry32 — small, fast, seedable PRNG. The ONLY source of randomness
// allowed inside the simulation (world.rng). State is a single uint32 so it
// serializes into replays/snapshots trivially.
export interface RngState {
  s: number;
}

export function createRng(seed: number): RngState {
  return { s: seed >>> 0 };
}

/** Advances state; returns float in [0, 1). */
export function rngFloat(rng: RngState): number {
  rng.s = (rng.s + 0x6d2b79f5) >>> 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Integer in [min, max] inclusive. */
export function rngInt(rng: RngState, min: number, max: number): number {
  return min + Math.floor(rngFloat(rng) * (max - min + 1));
}

/** Pick a random element; throws on empty array. */
export function rngPick<T>(rng: RngState, arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('rngPick on empty array');
  return arr[rngInt(rng, 0, arr.length - 1)] as T;
}
