import { Container, Text } from 'pixi.js';
import { FX } from '../fx/config';
import { FloatTextCore } from './floatcore';
import { TILE } from './scene';

// Pixi Text is expensive to construct (canvas measure + texture upload), so
// the pool is built once and reuse only mutates text/fill/position. Lives on
// the ABOVE-FOG ping layer: floating gold text is an announcement (banked
// events are public by design), not sight — fog must not swallow it.

export class FloatTextLayer {
  readonly core: FloatTextCore;
  private readonly texts: Text[];

  constructor(container: Container) {
    this.core = new FloatTextCore(
      FX.floatText.pool,
      FX.floatText.lifeMs,
      FX.floatText.riseUnits * TILE,
    );
    this.texts = this.core.items.map(() => {
      const t = new Text({
        text: '',
        style: {
          fontFamily: 'ui-monospace, Consolas, monospace',
          fontSize: 13,
          fontWeight: 'bold',
          fill: 0xffffff,
          stroke: { color: 0x000000, width: 3 },
        },
      });
      t.anchor.set(0.5, 1);
      t.visible = false;
      container.addChild(t);
      return t;
    });
  }

  show(xUnits: number, yUnits: number, text: string, color: number): void {
    // Tiny x jitter so two payouts at the same spot don't print on top of
    // each other (double-kill at a choke, back-to-back bank deposits).
    const jitter = (Math.random() - 0.5) * 8;
    const idx = this.core.spawn(
      xUnits * TILE + jitter,
      yUnits * TILE,
      text,
      color,
      performance.now(),
    );
    const t = this.texts[idx]!;
    t.text = text;
    t.style.fill = color;
    t.visible = true;
  }

  frame(nowMs: number): void {
    this.core.step(nowMs);
    for (let i = 0; i < this.core.items.length; i++) {
      const it = this.core.items[i]!;
      const t = this.texts[i]!;
      if (!it.active) {
        t.visible = false;
        continue;
      }
      const pose = this.core.pose(it, nowMs);
      t.position.set(pose.x, pose.y);
      t.alpha = pose.alpha;
      t.visible = true;
    }
  }

  stats(): { active: number; spawned: number; stolen: number } {
    return {
      active: this.core.activeCount(),
      spawned: this.core.spawned,
      stolen: this.core.stolen,
    };
  }

  /** Teardown (welcome/restart re-creates the layer, matching FxLayer). */
  clear(): void {
    this.core.clear();
    for (const t of this.texts) t.destroy();
  }
}
