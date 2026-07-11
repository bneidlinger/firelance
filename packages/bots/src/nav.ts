import type { MapData } from '@shared/map/types';
import { isWalkBlocked } from '@shared/map/types';
import type { RngState } from '@shared/math/rng';
import { rngInt } from '@shared/math/rng';

// Grid A* over the shared map. 8-directional with corner-cut prevention.
// 128×128 = 16384 nodes; a simple binary heap is more than enough.
//
// M4 s5: every helper takes an optional `blocked` tile-index set — the bot's
// view of DYNAMIC blockers (structures from its fog-filtered snapshot, minus
// its own gates, plus short-lived bump-memory tiles for walls it can't see
// yet). Same threading pattern as the sim's occupancy param: terrain is the
// map's truth, blocked is the caller's.

/** Static terrain OR caller-known dynamic blocker. */
function navBlocked(
  map: MapData,
  blocked: ReadonlySet<number> | null,
  tx: number,
  ty: number,
): boolean {
  if (isWalkBlocked(map, tx, ty)) return true;
  return blocked !== null && blocked.has(ty * map.width + tx);
}

/**
 * True when no WALK-blocking tile lies between the two points (Amanatides–Woo,
 * same traversal as vision's tileRayClear but over the walk grid). The
 * distinction matters at rivers: water is see-through but not walkable —
 * direct-steering on a VISION ray marches bots into the bank forever. Same
 * story for structures: a wall you can see over is still a wall.
 */
export function walkRayClear(
  map: MapData,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  blocked: ReadonlySet<number> | null = null,
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
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Number.POSITIVE_INFINITY;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Number.POSITIVE_INFINITY;
  let tMaxX = dx !== 0 ? (dx > 0 ? (tx + 1 - x0) / dx : (tx - x0) / dx) : Number.POSITIVE_INFINITY;
  let tMaxY = dy !== 0 ? (dy > 0 ? (ty + 1 - y0) / dy : (ty - y0) / dy) : Number.POSITIVE_INFINITY;

  for (let i = map.width + map.height; i > 0; i--) {
    if (tMaxX < tMaxY) {
      tMaxX += tDeltaX;
      tx += stepX;
    } else {
      tMaxY += tDeltaY;
      ty += stepY;
    }
    if (navBlocked(map, blocked, tx, ty)) return false;
    if (tx === txEnd && ty === tyEnd) return true;
  }
  return false;
}

interface Heap {
  idx: number[];
  f: number[];
}

function heapPush(h: Heap, idx: number, f: number): void {
  h.idx.push(idx);
  h.f.push(f);
  let i = h.idx.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (h.f[parent]! <= h.f[i]!) break;
    [h.f[parent], h.f[i]] = [h.f[i]!, h.f[parent]!];
    [h.idx[parent], h.idx[i]] = [h.idx[i]!, h.idx[parent]!];
    i = parent;
  }
}

function heapPop(h: Heap): number {
  const top = h.idx[0]!;
  const lastIdx = h.idx.pop()!;
  const lastF = h.f.pop()!;
  if (h.idx.length > 0) {
    h.idx[0] = lastIdx;
    h.f[0] = lastF;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let s = i;
      if (l < h.idx.length && h.f[l]! < h.f[s]!) s = l;
      if (r < h.idx.length && h.f[r]! < h.f[s]!) s = r;
      if (s === i) break;
      [h.f[s], h.f[i]] = [h.f[i]!, h.f[s]!];
      [h.idx[s], h.idx[i]] = [h.idx[i]!, h.idx[s]!];
      i = s;
    }
  }
  return top;
}

const SQRT2 = Math.SQRT2;

export interface Waypoint {
  x: number;
  y: number;
}

/** A* from tile (sx,sy) to (tx,ty); returns tile-center waypoints or null. */
export function findPath(
  map: MapData,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  blocked: ReadonlySet<number> | null = null,
): Waypoint[] | null {
  const w = map.width;
  const h = map.height;
  // Start tile is exempt from the dynamic set (we may be STANDING on a tile
  // we just bump-marked); a blocked goal is unreachable by definition.
  if (isWalkBlocked(map, sx, sy) || navBlocked(map, blocked, tx, ty)) return null;
  const start = sy * w + sx;
  const goal = ty * w + tx;
  if (start === goal) return [];

  const g = new Float64Array(w * h).fill(Number.POSITIVE_INFINITY);
  const came = new Int32Array(w * h).fill(-1);
  const closed = new Uint8Array(w * h);
  g[start] = 0;
  const heap: Heap = { idx: [], f: [] };
  const hCost = (i: number): number => {
    const x = i % w;
    const y = (i - x) / w;
    const dx = Math.abs(x - tx);
    const dy = Math.abs(y - ty);
    return (dx > dy ? dx - dy : dy - dx) + SQRT2 * (dx < dy ? dx : dy);
  };
  heapPush(heap, start, hCost(start));

  while (heap.idx.length > 0) {
    const cur = heapPop(heap);
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (navBlocked(map, blocked, nx, ny)) continue;
        // No cutting corners: diagonal moves need both orthogonal tiles open.
        if (dx !== 0 && dy !== 0) {
          if (navBlocked(map, blocked, cx + dx, cy) || navBlocked(map, blocked, cx, cy + dy))
            continue;
        }
        const ni = ny * w + nx;
        if (closed[ni]) continue;
        const step = dx !== 0 && dy !== 0 ? SQRT2 : 1;
        const ng = g[cur]! + step;
        if (ng < g[ni]!) {
          g[ni] = ng;
          came[ni] = cur;
          heapPush(heap, ni, ng + hCost(ni));
        }
      }
    }
  }

  if (came[goal] === -1) return null;
  const path: Waypoint[] = [];
  let cur = goal;
  while (cur !== start) {
    const x = cur % w;
    path.push({ x: x + 0.5, y: (cur - x) / w + 0.5 });
    cur = came[cur]!;
  }
  path.reverse();
  return path;
}

/** Random walkable tile at least `minDist` tiles from (fx,fy). */
export function randomWalkableTile(
  map: MapData,
  rng: RngState,
  fx: number,
  fy: number,
  minDist: number,
  blocked: ReadonlySet<number> | null = null,
): Waypoint | null {
  for (let tries = 0; tries < 60; tries++) {
    const tx = rngInt(rng, 1, map.width - 2);
    const ty = rngInt(rng, 1, map.height - 2);
    if (navBlocked(map, blocked, tx, ty)) continue;
    const dx = tx - fx;
    const dy = ty - fy;
    if (dx * dx + dy * dy < minDist * minDist) continue;
    return { x: tx + 0.5, y: ty + 0.5 };
  }
  return null;
}
