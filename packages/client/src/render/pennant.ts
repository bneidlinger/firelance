import type { Graphics } from 'pixi.js';
import { GOLD, INK } from './palette';

// The pennant: timber mast, gold finial, and a tapering 3-segment flag
// waving on a slow sine. The shared heraldry language for architecture —
// castles fly it (G2), watchtowers fly the mini (G3). AoE2's cheapest
// signature.

/** Draw into a per-frame-cleared Graphics. Local frame: pole base at (0,0),
 *  mast rising -y, flag flying +x. `h` mast height, `len` flag length, both
 *  px; `k` scales stroke weights/banner heft for mini flags (towers ~0.62).
 *  `t` advances ~nowMs/260 rad; give each caller a phase offset so the world
 *  doesn't metronome. The root joint is pinned to the mast — sway grows
 *  toward the free end. */
export function drawPennant(
  g: Graphics,
  h: number,
  len: number,
  color: number,
  t: number,
  k = 1,
): void {
  g.moveTo(0, 0)
    .lineTo(0, -h)
    .stroke({ width: 1.7 * k, color: INK, alpha: 0.95 });
  g.circle(0, -h, 1.3 * k).fill(GOLD.keep);
  const seg = len / 3;
  const top = -h + 1.2 * k;
  const dy = (j: number): number => Math.sin(t + j * 0.95) * 1.6 * k * (j / 3);
  const half = (j: number): number => (3.1 * (1 - j / 3) + 0.35) * k;
  g.moveTo(1 * k, top - half(0));
  for (let j = 1; j <= 3; j++) g.lineTo(1 * k + seg * j, top + dy(j) - half(j));
  for (let j = 3; j >= 0; j--) g.lineTo(1 * k + seg * j, top + dy(j) + half(j));
  // Ink outline: a gold banner over the gold squad's own stonework was
  // invisible without it (G3 verify) — and every other pairing sharpens.
  g.closePath()
    .fill(color)
    .stroke({ width: 0.9 * k, color: INK, alpha: 0.55 });
  g.moveTo(1 * k, top - half(0))
    .lineTo(1 * k, top + half(0))
    .stroke({ width: 1.2 * k, color: INK, alpha: 0.5 });
}
