import { Container, Graphics } from 'pixi.js';
import type { EmitSpec } from '../fx/config';
import { FX } from '../fx/config';
import { ParticlePool } from './particlepool';
import { TILE } from './scene';

// Pixi face of the particle pool: ONE Graphics redrawn per frame for ALL
// particles — hundreds of tiny fills beat hundreds of display objects, each
// of which would carry its own transform and draw call.

export class ParticleLayer {
  readonly pool: ParticlePool;
  private readonly gfx = new Graphics();
  private lastMs = -1;

  constructor(container: Container, cap = FX.particles.cap) {
    this.pool = new ParticlePool(cap);
    container.addChild(this.gfx);
  }

  emit(xUnits: number, yUnits: number, spec: EmitSpec): void {
    this.pool.emit(xUnits * TILE, yUnits * TILE, spec, TILE, performance.now());
  }

  frame(nowMs: number): void {
    // Own dt clock: rAF stalls in occluded windows and fx.frame only gets
    // `now` — clamp like the main loop so a tab-back doesn't teleport dots.
    const dtMs = this.lastMs < 0 ? 16 : Math.min(100, nowMs - this.lastMs);
    this.lastMs = nowMs;
    this.pool.step(nowMs, dtMs);
    this.gfx.clear();
    for (const p of this.pool.slots) {
      if (!p.alive) continue;
      const fade = 1 - p.t;
      this.gfx
        .circle(p.xPx, p.yPx, p.sizePx * (0.4 + 0.6 * fade))
        .fill({ color: p.color, alpha: fade });
    }
  }

  stats(): { alive: number; emitted: number; stolen: number } {
    return { alive: this.pool.aliveCount(), emitted: this.pool.emitted, stolen: this.pool.stolen };
  }

  /** Teardown (welcome/restart re-creates the layer, matching FxLayer). */
  clear(): void {
    this.pool.clear();
    this.gfx.destroy();
  }
}
