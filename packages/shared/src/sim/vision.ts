import type { GameConfig } from '../config';
import type { MapData } from '../map/types';
import { isVisionBlocked } from '../map/types';
import type { World } from './world';

// The ONE visibility function. The server filters snapshots through it (so
// wallhacks are architecturally impossible) and the client draws its fog mask
// from it (so what you see and what you receive can never disagree).
//
// Model: tile-granular. A point is visible to a viewer when
//   - within vision.radius, AND
//   - the tile ray between them crosses no vision-blocking tile (walls), AND
//   - if the target stands in forest: viewer is within vision.forestRadius
//     (forests conceal at range but not up close; rays still apply).
// Viewers inside forest see out normally — hiding in the treeline works.

/**
 * True when no vision-blocking tile lies strictly between the two points.
 * Amanatides–Woo grid traversal; start tile never blocks, end tile does
 * (a target inside a wall is not visible).
 */
export function tileRayClear(
  map: MapData,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  let tx = Math.floor(x0);
  let ty = Math.floor(y0);
  const txEnd = Math.floor(x1);
  const tyEnd = Math.floor(y1);
  if (tx === txEnd && ty === tyEnd) return true;

  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  // Param t along the ray at which we cross the next x/y tile boundary.
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Number.POSITIVE_INFINITY;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Number.POSITIVE_INFINITY;
  let tMaxX = dx !== 0 ? (dx > 0 ? (tx + 1 - x0) / dx : (tx - x0) / dx) : Number.POSITIVE_INFINITY;
  let tMaxY = dy !== 0 ? (dy > 0 ? (ty + 1 - y0) / dy : (ty - y0) / dy) : Number.POSITIVE_INFINITY;

  // Hard bound: a ray can cross at most w+h tiles.
  for (let i = map.width + map.height; i > 0; i--) {
    if (tMaxX < tMaxY) {
      tMaxX += tDeltaX;
      tx += stepX;
    } else {
      tMaxY += tDeltaY;
      ty += stepY;
    }
    if (isVisionBlocked(map, tx, ty)) return false;
    if (tx === txEnd && ty === tyEnd) return true;
  }
  return false;
}

/** Can a single viewer at (vx,vy) see the point (px,py)? */
export function canSeePoint(
  map: MapData,
  cfg: GameConfig,
  vx: number,
  vy: number,
  px: number,
  py: number,
): boolean {
  const dx = px - vx;
  const dy = py - vy;
  const d2 = dx * dx + dy * dy;
  const r = cfg.vision.radius;
  if (d2 > r * r) return false;
  const ti = Math.floor(py) * map.width + Math.floor(px);
  if (map.forest[ti] === 1) {
    const fr = cfg.vision.forestRadius;
    if (d2 > fr * fr) return false;
  }
  return tileRayClear(map, vx, vy, px, py);
}

/** Union of what every living member of the squad can see. */
export function isVisibleToSquad(
  world: World,
  map: MapData,
  cfg: GameConfig,
  squadId: number,
  px: number,
  py: number,
): boolean {
  for (const p of world.players.values()) {
    if (p.squad !== squadId || !p.alive) continue;
    if (canSeePoint(map, cfg, p.x, p.y, px, py)) return true;
  }
  return false;
}
