import { Container, Graphics } from 'pixi.js';
import { TILE } from './scene';

// Firebomb rendering on the delayed interp timeline: a lobbed dot that rises
// and falls along the throw line, its ground shadow, and — most importantly —
// the DANGER CIRCLE at the locked landing point. The flight time is the
// defenders' scatter window; the circle is what they scatter from.

interface FlyingBomb {
  id: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  bornTick: number;
  flightTicks: number;
  gone: boolean;
  root: Container;
  dot: Graphics;
  shadow: Graphics;
  danger: Graphics;
}

export class BombLayer {
  private bombs = new Map<number, FlyingBomb>();

  constructor(
    private readonly container: Container,
    private readonly blastRadius: number,
  ) {}

  clear(): void {
    for (const b of this.bombs.values()) b.root.destroy({ children: true });
    this.bombs.clear();
  }

  onSpawn(ev: {
    id: number;
    x: number;
    y: number;
    tx: number;
    ty: number;
    tk: number;
    flightTicks: number;
  }): void {
    if (this.bombs.has(ev.id)) return;
    const root = new Container();

    const danger = new Graphics();
    danger.circle(0, 0, this.blastRadius * TILE).stroke({ width: 2, color: 0xf05a4d, alpha: 0.8 });
    danger.circle(0, 0, this.blastRadius * TILE).fill({ color: 0xf05a4d, alpha: 0.12 });
    danger.position.set(ev.tx * TILE, ev.ty * TILE);
    root.addChild(danger);

    const shadow = new Graphics();
    shadow.ellipse(0, 0, 4, 2.5).fill({ color: 0x000000, alpha: 0.4 });
    root.addChild(shadow);

    const dot = new Graphics();
    dot.circle(0, 0, 4).fill(0x2b2b26).stroke({ width: 1.5, color: 0xf05a4d });
    // A little fuse spark.
    dot.circle(2.5, -3.5, 1.4).fill(0xffd27a);
    root.addChild(dot);

    this.container.addChild(root);
    this.bombs.set(ev.id, {
      id: ev.id,
      x: ev.x,
      y: ev.y,
      tx: ev.tx,
      ty: ev.ty,
      bornTick: ev.tk,
      flightTicks: ev.flightTicks,
      gone: false,
      root,
      dot,
      shadow,
      danger,
    });
  }

  onEnd(id: number): void {
    const b = this.bombs.get(id);
    if (b) b.gone = true; // remove once the delayed timeline catches up
  }

  frame(renderTick: number, nowMs: number): void {
    for (const [id, b] of this.bombs) {
      const t = (renderTick - b.bornTick) / b.flightTicks;
      if (t >= 1.15 || (b.gone && t >= 1)) {
        b.root.destroy({ children: true });
        this.bombs.delete(id);
        continue;
      }
      const clamped = Math.max(0, Math.min(1, t));
      const gx = (b.x + (b.tx - b.x) * clamped) * TILE;
      const gy = (b.y + (b.ty - b.y) * clamped) * TILE;
      // The lob: fake height as a sine hump, drawn as a y-offset.
      const height = Math.sin(clamped * Math.PI) * 1.6 * TILE;
      b.shadow.position.set(gx, gy);
      b.dot.position.set(gx, gy - height);
      b.danger.alpha = 0.5 + 0.5 * Math.sin(nowMs / 90); // urgent pulse
    }
  }
}
