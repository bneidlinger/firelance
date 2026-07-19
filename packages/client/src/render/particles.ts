import { Container, Graphics } from 'pixi.js';
import type { EmitSpec } from '../fx/config';
import { FX } from '../fx/config';
import { ParticlePool } from './particlepool';
import { TILE } from './scene';

// Pixi face of the particle pool: ONE Graphics redrawn per frame for ALL
// particles — hundreds of tiny fills beat hundreds of display objects, each
// of which would carry its own transform and draw call. G4 adds a second
// pool+Graphics pair composited with blendMode 'add': specs flagged
// `additive` glow instead of paint. Same steal-oldest rules, separate cap,
// so a firefight's glow can't starve the matter and vice versa.

export class ParticleLayer {
  readonly pool: ParticlePool;
  readonly poolAdd: ParticlePool;
  private readonly gfx = new Graphics();
  private readonly gfxAdd = new Graphics();
  private lastMs = -1;

  constructor(container: Container, cap = FX.particles.cap, capAdd = FX.particles.capAdd) {
    this.pool = new ParticlePool(cap);
    this.poolAdd = new ParticlePool(capAdd);
    this.gfxAdd.blendMode = 'add';
    container.addChild(this.gfx);
    container.addChild(this.gfxAdd);
  }

  emit(xUnits: number, yUnits: number, spec: EmitSpec): void {
    const pool = spec.additive === true ? this.poolAdd : this.pool;
    pool.emit(xUnits * TILE, yUnits * TILE, spec, TILE, performance.now());
  }

  frame(nowMs: number): void {
    // Own dt clock: rAF stalls in occluded windows and fx.frame only gets
    // `now` — clamp like the main loop so a tab-back doesn't teleport dots.
    const dtMs = this.lastMs < 0 ? 16 : Math.min(100, nowMs - this.lastMs);
    this.lastMs = nowMs;
    this.pool.step(nowMs, dtMs);
    this.poolAdd.step(nowMs, dtMs);
    this.redraw(this.gfx, this.pool);
    this.redraw(this.gfxAdd, this.poolAdd);
  }

  private redraw(gfx: Graphics, pool: ParticlePool): void {
    gfx.clear();
    for (const p of pool.slots) {
      if (!p.alive) continue;
      const fade = 1 - p.t;
      gfx.circle(p.xPx, p.yPx, p.sizePx * (0.4 + 0.6 * fade)).fill({ color: p.color, alpha: fade });
    }
  }

  /** Both pools summed — soak scripts keep reading one shape. */
  stats(): { alive: number; emitted: number; stolen: number } {
    return {
      alive: this.pool.aliveCount() + this.poolAdd.aliveCount(),
      emitted: this.pool.emitted + this.poolAdd.emitted,
      stolen: this.pool.stolen + this.poolAdd.stolen,
    };
  }

  /** Teardown (welcome/restart re-creates the layer, matching FxLayer). */
  clear(): void {
    this.pool.clear();
    this.poolAdd.clear();
    this.gfx.destroy();
    this.gfxAdd.destroy();
  }
}
