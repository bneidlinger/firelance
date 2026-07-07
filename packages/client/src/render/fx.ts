import { Container, Graphics } from 'pixi.js';
import { TILE } from './scene';

// Transient world-space effects: hit sparks, arrow impacts, death markers.
// Fire-and-forget; each effect owns a tiny fade-out life.

interface Effect {
  gfx: Graphics;
  bornMs: number;
  lifeMs: number;
  grow: number;
}

export class FxLayer {
  private effects: Effect[] = [];

  constructor(private readonly container: Container) {}

  clear(): void {
    for (const e of this.effects) e.gfx.destroy();
    this.effects = [];
  }

  hitSpark(x: number, y: number, blocked: boolean): void {
    const g = new Graphics();
    const color = blocked ? 0x9db4c9 : 0xffffff;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      g.moveTo(0, 0).lineTo(Math.cos(a) * 6, Math.sin(a) * 6);
    }
    g.stroke({ width: 1.5, color });
    this.add(g, x, y, 160, 1.6);
  }

  arrowImpact(x: number, y: number): void {
    const g = new Graphics();
    g.circle(0, 0, 2.5).fill({ color: 0xe8dcc0, alpha: 0.9 });
    this.add(g, x, y, 200, 1.8);
  }

  death(x: number, y: number, color: number): void {
    const g = new Graphics();
    g.moveTo(-6, -6).lineTo(6, 6).moveTo(6, -6).lineTo(-6, 6).stroke({ width: 3, color });
    g.circle(0, 0, 8).stroke({ width: 1.5, color, alpha: 0.6 });
    this.add(g, x, y, 1100, 1.15);
  }

  respawnRing(x: number, y: number, color: number): void {
    const g = new Graphics();
    g.circle(0, 0, 6).stroke({ width: 2, color, alpha: 0.9 });
    this.add(g, x, y, 450, 2.4);
  }

  private add(g: Graphics, x: number, y: number, lifeMs: number, grow: number): void {
    g.position.set(x * TILE, y * TILE);
    this.container.addChild(g);
    this.effects.push({ gfx: g, bornMs: performance.now(), lifeMs, grow });
  }

  frame(nowMs: number): void {
    this.effects = this.effects.filter((e) => {
      const t = (nowMs - e.bornMs) / e.lifeMs;
      if (t >= 1) {
        e.gfx.destroy();
        return false;
      }
      e.gfx.alpha = 1 - t;
      const s = 1 + (e.grow - 1) * t;
      e.gfx.scale.set(s);
      return true;
    });
  }
}
