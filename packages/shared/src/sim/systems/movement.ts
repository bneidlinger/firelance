import type { GameConfig } from '../../config';
import type { MapData } from '../../map/types';
import { isWalkBlocked } from '../../map/types';
import type { InputCmd } from '../world';

// THE prediction kernel. This exact function runs on the server (authoritative)
// and on the client (replaying pending inputs during reconciliation). It must
// stay pure over (state, input, cfg, map, dt) and use only IEEE-deterministic
// math (+ - * / sqrt). No trig, no rng, no wall-clock.

export interface MoveState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const SKIN = 1e-4; // keep circles a hair off walls so re-tests don't jitter

export function stepMovement(
  s: MoveState,
  input: InputCmd,
  cfg: GameConfig,
  map: MapData,
  dt: number,
): void {
  const r = cfg.player.radius;
  const speed = cfg.player.moveSpeed;

  // Desired velocity from input (clamped, normalized when diagonal).
  let mx = input.mx < -1 ? -1 : input.mx > 1 ? 1 : input.mx;
  let my = input.my < -1 ? -1 : input.my > 1 ? 1 : input.my;
  const l = Math.sqrt(mx * mx + my * my);
  if (l > 1) {
    mx /= l;
    my /= l;
  }
  s.vx = mx * speed;
  s.vy = my * speed;

  // Axis-separated move + resolve: X first, then Y. Produces natural wall slide.
  moveAxis(s, s.vx * dt, 0, r, map);
  moveAxis(s, 0, s.vy * dt, r, map);
}

function moveAxis(s: MoveState, dx: number, dy: number, r: number, map: MapData): void {
  if (dx !== 0) {
    const nx = s.x + dx;
    const yMin = Math.floor(s.y - r);
    const yMax = Math.floor(s.y + r);
    if (dx > 0) {
      const col = Math.floor(nx + r);
      if (anyBlockedInColumn(map, col, yMin, yMax)) {
        s.x = col - r - SKIN;
      } else {
        s.x = nx;
      }
    } else {
      const col = Math.floor(nx - r);
      if (anyBlockedInColumn(map, col, yMin, yMax)) {
        s.x = col + 1 + r + SKIN;
      } else {
        s.x = nx;
      }
    }
  }
  if (dy !== 0) {
    const ny = s.y + dy;
    const xMin = Math.floor(s.x - r);
    const xMax = Math.floor(s.x + r);
    if (dy > 0) {
      const row = Math.floor(ny + r);
      if (anyBlockedInRow(map, row, xMin, xMax)) {
        s.y = row - r - SKIN;
      } else {
        s.y = ny;
      }
    } else {
      const row = Math.floor(ny - r);
      if (anyBlockedInRow(map, row, xMin, xMax)) {
        s.y = row + 1 + r + SKIN;
      } else {
        s.y = ny;
      }
    }
  }
}

function anyBlockedInColumn(map: MapData, col: number, yMin: number, yMax: number): boolean {
  for (let ty = yMin; ty <= yMax; ty++) {
    if (isWalkBlocked(map, col, ty)) return true;
  }
  return false;
}

function anyBlockedInRow(map: MapData, row: number, xMin: number, xMax: number): boolean {
  for (let tx = xMin; tx <= xMax; tx++) {
    if (isWalkBlocked(map, tx, row)) return true;
  }
  return false;
}

/**
 * Pairwise circle separation. Server-only system (NOT part of the prediction
 * kernel — remote players aren't predicted, so contact divergence is small and
 * reconciliation absorbs it). 12 players = 66 pairs; plain O(n²) is fine.
 */
export function pushoutPairs(bodies: MoveState[], r: number, map: MapData): void {
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i]!;
      const b = bodies[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      const minDist = r * 2;
      if (d2 >= minDist * minDist) continue;
      let nx: number;
      let ny: number;
      let d = Math.sqrt(d2);
      if (d === 0) {
        // Perfectly stacked: deterministic fallback axis (index order).
        nx = 1;
        ny = 0;
        d = 0;
      } else {
        nx = dx / d;
        ny = dy / d;
      }
      const push = (minDist - d) / 2;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
      resolveStaticOverlap(a, r, map);
      resolveStaticOverlap(b, r, map);
    }
  }
}

/** Nudge a circle out of any wall tile it overlaps (post-pushout cleanup). */
function resolveStaticOverlap(s: MoveState, r: number, map: MapData): void {
  const txMin = Math.floor(s.x - r);
  const txMax = Math.floor(s.x + r);
  const tyMin = Math.floor(s.y - r);
  const tyMax = Math.floor(s.y + r);
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      if (!isWalkBlocked(map, tx, ty)) continue;
      // Closest point on tile AABB to circle center.
      const cx = s.x < tx ? tx : s.x > tx + 1 ? tx + 1 : s.x;
      const cy = s.y < ty ? ty : s.y > ty + 1 ? ty + 1 : s.y;
      const dx = s.x - cx;
      const dy = s.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      if (d2 === 0) {
        // Center exactly on the tile edge/corner: push straight up as fallback.
        s.y = ty - r - SKIN;
        continue;
      }
      const d = Math.sqrt(d2);
      const push = r - d + SKIN;
      s.x += (dx / d) * push;
      s.y += (dy / d) * push;
    }
  }
}
