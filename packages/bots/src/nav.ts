import type { MapData } from '@shared/map/types';
import { isWalkBlocked } from '@shared/map/types';
import type { RngState } from '@shared/math/rng';
import { rngInt } from '@shared/math/rng';

// Grid A* over the shared map. 8-directional with corner-cut prevention.
// 96×96 = 9216 nodes; a simple binary heap is more than enough.

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
): Waypoint[] | null {
  const w = map.width;
  const h = map.height;
  if (isWalkBlocked(map, sx, sy) || isWalkBlocked(map, tx, ty)) return null;
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
        if (isWalkBlocked(map, nx, ny)) continue;
        // No cutting corners: diagonal moves need both orthogonal tiles open.
        if (dx !== 0 && dy !== 0) {
          if (isWalkBlocked(map, cx + dx, cy) || isWalkBlocked(map, cx, cy + dy)) continue;
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
): Waypoint | null {
  for (let tries = 0; tries < 60; tries++) {
    const tx = rngInt(rng, 1, map.width - 2);
    const ty = rngInt(rng, 1, map.height - 2);
    if (isWalkBlocked(map, tx, ty)) continue;
    const dx = tx - fx;
    const dy = ty - fy;
    if (dx * dx + dy * dy < minDist * minDist) continue;
    return { x: tx + 0.5, y: ty + 0.5 };
  }
  return null;
}
