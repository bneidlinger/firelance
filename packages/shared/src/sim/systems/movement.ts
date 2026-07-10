import type { ClassId, GameConfig } from '../../config';
import { getKit, secToTicks } from '../../config';
import type { MapData } from '../../map/types';
import { isWalkBlocked } from '../../map/types';
import type { InputCmd } from '../world';
import { BTN_BLOCK, BTN_DASH } from '../world';

// THE prediction kernel. This exact function runs on the server (authoritative)
// and on the client (replaying pending inputs during reconciliation). It must
// stay pure over (state, input, params, map, dt, speedFactor) and use only
// IEEE-deterministic math (+ - * / sqrt). No trig, no rng, no wall-clock.
//
// M1: dash (edge-triggered displacement, no i-frames) and shield-block move
// slow live INSIDE the kernel — both change position, so both must be
// predicted or every dash would rubber-band under latency.
// M2: carried gold slows walking, so the carry factor enters the kernel the
// same way — callers derive it via carrySpeedFactor(cfg, carried) from their
// own authoritative view (server: player state; client: acked `you`). Walk
// speed only; dash displacement stays full-strength on purpose.

export interface MoveState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Ticks remaining in the active dash (0 = not dashing). */
  dashTicks: number;
  dashDx: number;
  dashDy: number;
  /** Cooldown ticks until the next dash. */
  dashCd: number;
  /** Previous tick's buttons — dash triggers on the rising edge only. */
  prevB: number;
}

export function createMoveState(x: number, y: number): MoveState {
  return { x, y, vx: 0, vy: 0, dashTicks: 0, dashDx: 0, dashDy: 0, dashCd: 0, prevB: 0 };
}

/** Everything class-dependent the kernel needs, precomputed to ticks. */
export interface MoveParams {
  radius: number;
  moveSpeed: number;
  dashSpeed: number;
  dashDurTicks: number;
  dashCdTicks: number;
  hasShield: boolean;
  blockMoveFactor: number;
}

export function kitMoveParams(cfg: GameConfig, cls: ClassId): MoveParams {
  const kit = getKit(cfg, cls);
  return {
    radius: cfg.player.radius,
    moveSpeed: kit.moveSpeed,
    dashSpeed: kit.dash.speed,
    dashDurTicks: secToTicks(cfg, kit.dash.durationSec),
    dashCdTicks: secToTicks(cfg, kit.dash.cooldownSec),
    hasShield: kit.shield !== undefined,
    blockMoveFactor: kit.shield?.moveFactor ?? 1,
  };
}

/** Single source of truth for "is this player blocking" (kernel + combat + net). */
export function isBlocking(b: number, hasShield: boolean, dashTicks: number): boolean {
  return hasShield && (b & BTN_BLOCK) !== 0 && dashTicks <= 0;
}

const SKIN = 1e-4; // keep circles a hair off walls so re-tests don't jitter

/** Solid = static blocker (#/~/OOB) OR a live structure occupying this tile.
 *  The occupancy set is prediction-shared — the client rebuilds it from its
 *  snapshot, so walls collide bit-for-bit with the server. */
function solid(map: MapData, occ: ReadonlySet<number> | null, tx: number, ty: number): boolean {
  if (isWalkBlocked(map, tx, ty)) return true;
  return occ !== null && occ.has(ty * map.width + tx);
}

export function stepMovement(
  s: MoveState,
  input: InputCmd,
  params: MoveParams,
  map: MapData,
  dt: number,
  speedFactor = 1,
  occ: ReadonlySet<number> | null = null,
): void {
  const r = params.radius;

  // Cooldowns tick down unconditionally.
  if (s.dashCd > 0) s.dashCd--;

  // Dash trigger: rising edge of the dash button, off cooldown, not mid-dash.
  // Direction = movement input, falling back to aim when standing still.
  if (
    (input.b & BTN_DASH) !== 0 &&
    (s.prevB & BTN_DASH) === 0 &&
    s.dashCd <= 0 &&
    s.dashTicks <= 0
  ) {
    let dx = input.mx;
    let dy = input.my;
    let l = Math.sqrt(dx * dx + dy * dy);
    if (l < 1e-6) {
      dx = input.ax;
      dy = input.ay;
      l = Math.sqrt(dx * dx + dy * dy);
    }
    if (l > 1e-6) {
      s.dashTicks = params.dashDurTicks;
      s.dashDx = dx / l;
      s.dashDy = dy / l;
      s.dashCd = params.dashCdTicks + params.dashDurTicks;
    }
  }

  if (s.dashTicks > 0) {
    // Mid-dash: fixed displacement along the locked direction; input ignored.
    s.dashTicks--;
    s.vx = s.dashDx * params.dashSpeed;
    s.vy = s.dashDy * params.dashSpeed;
  } else {
    // Desired velocity from input (clamped, normalized when diagonal).
    let mx = input.mx < -1 ? -1 : input.mx > 1 ? 1 : input.mx;
    let my = input.my < -1 ? -1 : input.my > 1 ? 1 : input.my;
    const l = Math.sqrt(mx * mx + my * my);
    if (l > 1) {
      mx /= l;
      my /= l;
    }
    const speed =
      (isBlocking(input.b, params.hasShield, s.dashTicks)
        ? params.moveSpeed * params.blockMoveFactor
        : params.moveSpeed) * speedFactor;
    s.vx = mx * speed;
    s.vy = my * speed;
  }

  // Axis-separated move + resolve: X first, then Y. Produces natural wall slide.
  moveAxis(s, s.vx * dt, 0, r, map, occ);
  moveAxis(s, 0, s.vy * dt, r, map, occ);

  s.prevB = input.b;
}

function moveAxis(
  s: MoveState,
  dx: number,
  dy: number,
  r: number,
  map: MapData,
  occ: ReadonlySet<number> | null,
): void {
  if (dx !== 0) {
    const nx = s.x + dx;
    const yMin = Math.floor(s.y - r);
    const yMax = Math.floor(s.y + r);
    if (dx > 0) {
      const col = Math.floor(nx + r);
      if (anyBlockedInColumn(map, col, yMin, yMax, occ)) {
        s.x = col - r - SKIN;
      } else {
        s.x = nx;
      }
    } else {
      const col = Math.floor(nx - r);
      if (anyBlockedInColumn(map, col, yMin, yMax, occ)) {
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
      if (anyBlockedInRow(map, row, xMin, xMax, occ)) {
        s.y = row - r - SKIN;
      } else {
        s.y = ny;
      }
    } else {
      const row = Math.floor(ny - r);
      if (anyBlockedInRow(map, row, xMin, xMax, occ)) {
        s.y = row + 1 + r + SKIN;
      } else {
        s.y = ny;
      }
    }
  }
}

function anyBlockedInColumn(
  map: MapData,
  col: number,
  yMin: number,
  yMax: number,
  occ: ReadonlySet<number> | null,
): boolean {
  for (let ty = yMin; ty <= yMax; ty++) {
    if (solid(map, occ, col, ty)) return true;
  }
  return false;
}

function anyBlockedInRow(
  map: MapData,
  row: number,
  xMin: number,
  xMax: number,
  occ: ReadonlySet<number> | null,
): boolean {
  for (let tx = xMin; tx <= xMax; tx++) {
    if (solid(map, occ, tx, row)) return true;
  }
  return false;
}

/**
 * Pairwise circle separation. Server-only system (NOT part of the prediction
 * kernel — remote players aren't predicted, so contact divergence is small and
 * reconciliation absorbs it). 12 players = 66 pairs; plain O(n²) is fine.
 *
 * Occupancy is per-BODY as of M4 s3 (gates): pass `occFor` to give each body
 * its own blocker set — a shove must never push someone out of a gateway
 * their squad may stand in, nor INTO a tile blocked for them.
 */
export function pushoutPairs(
  bodies: Array<{ x: number; y: number }>,
  r: number,
  map: MapData,
  occ: ReadonlySet<number> | null = null,
  occFor: ((index: number) => ReadonlySet<number> | null) | null = null,
): void {
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
      resolveStaticOverlap(a, r, map, occFor ? occFor(i) : occ);
      resolveStaticOverlap(b, r, map, occFor ? occFor(j) : occ);
    }
  }
}

/** Nudge a circle out of any solid tile (wall or structure) it overlaps. */
function resolveStaticOverlap(
  s: { x: number; y: number },
  r: number,
  map: MapData,
  occ: ReadonlySet<number> | null,
): void {
  const txMin = Math.floor(s.x - r);
  const txMax = Math.floor(s.x + r);
  const tyMin = Math.floor(s.y - r);
  const tyMax = Math.floor(s.y + r);
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      if (!solid(map, occ, tx, ty)) continue;
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
