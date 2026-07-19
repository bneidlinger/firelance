import type { Graphics } from 'pixi.js';
import { GOLD, INK } from './palette';

// The pennant: timber mast, gold finial, and a tapering 3-segment flag
// waving on a slow sine. The shared heraldry language for architecture —
// castles fly it (G2), watchtowers will (G3). AoE2's cheapest signature.

/** Draw into a per-frame-cleared Graphics. Local frame: pole base at (0,0),
 *  mast rising -y, flag flying +x. `h` mast height, `len` flag length, both
 *  px. `t` advances ~nowMs/260 rad; give each caller a phase offset so the
 *  world doesn't metronome. The root joint is pinned to the mast — sway
 *  grows toward the free end. */
export function drawPennant(g: Graphics, h: number, len: number, color: number, t: number): void {
  g.moveTo(0, 0)
    .lineTo(0, -h)
    .stroke({ width: 1.7, color: INK, alpha: 0.95 });
  g.circle(0, -h, 1.3).fill(GOLD.keep);
  const seg = len / 3;
  const top = -h + 1.2;
  const dy = (k: number): number => Math.sin(t + k * 0.95) * 1.6 * (k / 3);
  const half = (k: number): number => 3.1 * (1 - k / 3) + 0.35;
  g.moveTo(1, top - half(0));
  for (let k = 1; k <= 3; k++) g.lineTo(1 + seg * k, top + dy(k) - half(k));
  for (let k = 3; k >= 0; k--) g.lineTo(1 + seg * k, top + dy(k) + half(k));
  g.closePath().fill(color);
  g.moveTo(1, top - half(0))
    .lineTo(1, top + half(0))
    .stroke({ width: 1.2, color: INK, alpha: 0.5 });
}
