import type { Vec2 } from '../math/vec2';

// 1 tile = 1 world unit. Maps are authored as ASCII grids (see parse.ts legend).
export interface MapData {
  id: string;
  width: number;
  height: number;
  /** 1 = blocks movement (#, ~). Row-major, index = y * width + x. */
  walk: Uint8Array;
  /** 1 = blocks vision rays (# only — water and forests don't block rays; forests use the forest rule). */
  vision: Uint8Array;
  /** 1 = forest tile (walkable; special vision rule applies later). */
  forest: Uint8Array;
  /** Keep-site tile centers. */
  keeps: Vec2[];
  /** Town/bank tile centers. */
  towns: Vec2[];
  /** Squad spawn points, index = squad id (0-based). */
  spawns: Vec2[];
}

export function tileIndex(map: MapData, tx: number, ty: number): number {
  return ty * map.width + tx;
}

/** Out-of-bounds counts as blocked. */
export function isWalkBlocked(map: MapData, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return true;
  return map.walk[ty * map.width + tx] === 1;
}

export function isVisionBlocked(map: MapData, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return true;
  return map.vision[ty * map.width + tx] === 1;
}
