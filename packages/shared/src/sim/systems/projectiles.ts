import type { GameConfig } from '../../config';
import type { MapData } from '../../map/types';
import { isVisionBlocked } from '../../map/types';
import type { SimEvent } from '../events';
import type { Player, World } from '../world';
import { applyDamage } from './combat';

// Projectile flight: swept segment per tick so fast arrows can't tunnel
// through a player between ticks. Arrows are stopped by vision-blocking tiles
// (walls) and fly over water/forest. A projectile born this tick doesn't move
// this tick — clients integrate flight as pos(t) = spawn + dir·speed·(t−born)/hz
// and the two formulas must agree exactly.

export function stepProjectiles(
  world: World,
  cfg: GameConfig,
  map: MapData,
  events: SimEvent[],
  occ: ReadonlySet<number> | null = null,
): void {
  if (world.projectiles.size === 0) return;
  const dt = 1 / cfg.tick.simHz;

  for (const proj of [...world.projectiles.values()]) {
    if (proj.bornTick === world.tick) continue;

    const x1 = proj.x + proj.dx * proj.speed * dt;
    const y1 = proj.y + proj.dy * proj.speed * dt;

    // Earliest collision along the segment: walls (terrain + structures) vs players.
    const tWall = wallHitParam(map, proj.x, proj.y, x1, y1, occ);
    let tBest = tWall ?? 2;
    let hitWall = tWall !== null;
    let victim: Player | null = null;

    for (const p of world.players.values()) {
      if (!p.alive || p.id === proj.owner) continue;
      if (!cfg.combat.friendlyFire && p.squad === proj.squad) continue;
      const t = segmentCircleHit(
        proj.x,
        proj.y,
        x1 - proj.x,
        y1 - proj.y,
        p.x,
        p.y,
        cfg.player.radius + proj.radius,
      );
      if (t !== null && t < tBest) {
        tBest = t;
        victim = p;
        hitWall = false;
      }
    }

    if (victim !== null || hitWall) {
      const ix = proj.x + (x1 - proj.x) * tBest;
      const iy = proj.y + (y1 - proj.y) * tBest;
      world.projectiles.delete(proj.id);
      events.push({
        k: 'projEnd',
        tk: world.tick,
        id: proj.id,
        squad: proj.squad,
        x: ix,
        y: iy,
        hit: victim?.id,
      });
      if (victim) {
        const owner = world.players.get(proj.owner);
        if (owner) applyDamage(world, cfg, owner, victim, proj.damage, 'arrow', events);
      }
      continue;
    }

    proj.x = x1;
    proj.y = y1;
    proj.ticksLeft--;
    if (proj.ticksLeft <= 0) {
      world.projectiles.delete(proj.id);
      events.push({
        k: 'projEnd',
        tk: world.tick,
        id: proj.id,
        squad: proj.squad,
        x: proj.x,
        y: proj.y,
      });
    }
  }
}

/**
 * Param t ∈ [0,1] at which the segment enters a vision-blocking tile, or null.
 * Amanatides–Woo traversal, arithmetic only.
 */
function vBlocked(map: MapData, occ: ReadonlySet<number> | null, tx: number, ty: number): boolean {
  if (isVisionBlocked(map, tx, ty)) return true;
  return occ !== null && occ.has(ty * map.width + tx);
}

function wallHitParam(
  map: MapData,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  occ: ReadonlySet<number> | null,
): number | null {
  let tx = Math.floor(x0);
  let ty = Math.floor(y0);
  if (vBlocked(map, occ, tx, ty)) return 0;
  const txEnd = Math.floor(x1);
  const tyEnd = Math.floor(y1);
  if (tx === txEnd && ty === tyEnd) return null;

  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Number.POSITIVE_INFINITY;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Number.POSITIVE_INFINITY;
  let tMaxX = dx !== 0 ? (dx > 0 ? (tx + 1 - x0) / dx : (tx - x0) / dx) : Number.POSITIVE_INFINITY;
  let tMaxY = dy !== 0 ? (dy > 0 ? (ty + 1 - y0) / dy : (ty - y0) / dy) : Number.POSITIVE_INFINITY;

  for (let i = map.width + map.height; i > 0; i--) {
    let t: number;
    if (tMaxX < tMaxY) {
      t = tMaxX;
      tMaxX += tDeltaX;
      tx += stepX;
    } else {
      t = tMaxY;
      tMaxY += tDeltaY;
      ty += stepY;
    }
    if (t > 1) return null;
    if (vBlocked(map, occ, tx, ty)) return t;
    if (tx === txEnd && ty === tyEnd) return null;
  }
  return null;
}

/**
 * Earliest t ∈ [0,1] where segment P0 + t·D touches the circle (cx,cy,r),
 * or null. Starting inside the circle counts as t = 0.
 */
function segmentCircleHit(
  px: number,
  py: number,
  dx: number,
  dy: number,
  cx: number,
  cy: number,
  r: number,
): number | null {
  const mx = px - cx;
  const my = py - cy;
  const a = dx * dx + dy * dy;
  const c = mx * mx + my * my - r * r;
  if (c <= 0) return 0; // started inside
  if (a === 0) return null; // zero-length segment outside the circle
  const b = 2 * (mx * dx + my * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}
