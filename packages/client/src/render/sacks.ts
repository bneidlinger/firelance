import { Container, Graphics, Text } from 'pixi.js';
import type { SackSnap } from '@shared/net/messages';
import { TILE } from './scene';

// Ground loot sacks: gold-colored diamonds sized by value, with the amount
// printed underneath — a visible pile of someone's ruined bank run. Renders
// straight from the newest snapshot's visible set (sacks never move; fog
// entry/exit is just presence/absence, same as entities).

interface SackSprite {
  root: Container;
  gold: number;
}

export class SackLayer {
  private sprites = new Map<number, SackSprite>();

  constructor(private readonly container: Container) {}

  clear(): void {
    for (const s of this.sprites.values()) s.root.destroy({ children: true });
    this.sprites.clear();
  }

  sync(sacks: SackSnap[], nowMs: number): void {
    const seen = new Set<number>();
    for (const sack of sacks) {
      seen.add(sack.i);
      let s = this.sprites.get(sack.i);
      if (s && s.gold !== sack.g) {
        // Amount changed (merged drops on the same spot): redraw.
        s.root.destroy({ children: true });
        this.sprites.delete(sack.i);
        s = undefined;
      }
      if (!s) {
        s = { root: this.build(sack), gold: sack.g };
        this.sprites.set(sack.i, s);
        this.container.addChild(s.root);
        s.root.position.set(sack.x * TILE, sack.y * TILE);
      }
      // Gentle pulse so piles catch the eye through the grass.
      const pulse = 1 + 0.08 * Math.sin(nowMs / 280 + sack.i);
      s.root.scale.set(pulse);
    }
    for (const [id, s] of this.sprites) {
      if (!seen.has(id)) {
        s.root.destroy({ children: true });
        this.sprites.delete(id);
      }
    }
  }

  private build(sack: SackSnap): Container {
    const root = new Container();
    const g = new Graphics();
    // Radius grows with value: 100g reads small, 1000g reads like a heist.
    const r = Math.min(10, 3.5 + Math.sqrt(sack.g) * 0.18);
    g.moveTo(0, -r)
      .lineTo(r, 0)
      .lineTo(0, r)
      .lineTo(-r, 0)
      .closePath()
      .fill(0xf2d68c)
      .stroke({ width: 1.5, color: 0x7a6544 });
    g.circle(0, 0, r + 3).stroke({ width: 1, color: 0xf2d68c, alpha: 0.35 });
    root.addChild(g);
    const label = new Text({
      text: `${sack.g}g`,
      style: { fontSize: 10, fill: 0xf2d68c, fontFamily: 'Consolas, monospace' },
    });
    label.anchor.set(0.5, 0);
    label.position.set(0, r + 4);
    root.addChild(label);
    return root;
  }
}
