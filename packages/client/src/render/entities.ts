import { Container, Graphics, Text } from 'pixi.js';
import type { RosterEntry } from '@shared/net/messages';
import { SQUAD_COLORS, TILE } from './scene';

// Placeholder-art entity rendering: squad-colored circles + name labels.
// Readability first; the concept art's look is a post-fun-proof concern.

interface Sprite {
  root: Container;
  label: Text;
}

export class EntityLayer {
  private sprites = new Map<number, Sprite>();

  constructor(
    private readonly container: Container,
    private readonly radiusUnits: number,
  ) {}

  private ensure(id: number, entry: RosterEntry | undefined, isSelf: boolean): Sprite {
    let s = this.sprites.get(id);
    if (s) return s;
    const color = SQUAD_COLORS[entry?.squad ?? 0] ?? 0xffffff;
    const root = new Container();
    const g = new Graphics();
    const r = this.radiusUnits * TILE;
    g.circle(0, 0, r).fill(color);
    if (isSelf) {
      g.circle(0, 0, r + 2.5).stroke({ width: 2, color: 0xf4ead8 });
    } else if (entry?.bot) {
      g.circle(0, 0, r).stroke({ width: 1, color: 0x000000, alpha: 0.45 });
    }
    // Facing tick so movement direction reads at a glance.
    g.moveTo(0, 0).lineTo(r, 0).stroke({ width: 2, color: 0x14170f, alpha: 0.7 });
    root.addChild(g);
    const label = new Text({
      text: entry?.name ?? `#${id}`,
      style: {
        fontSize: 11,
        fill: isSelf ? 0xf4ead8 : 0xb9ad98,
        fontFamily: 'Consolas, monospace',
      },
    });
    label.anchor.set(0.5, 1);
    label.position.set(0, -r - 4);
    root.addChild(label);
    this.container.addChild(root);
    s = { root, label };
    this.sprites.set(id, s);
    return s;
  }

  /** Upsert every visible entity, drop everything no longer visible. */
  sync(
    visible: Map<number, { x: number; y: number }>,
    roster: Map<number, RosterEntry>,
    ownId: number,
    ownPos: { x: number; y: number } | null,
  ): void {
    const seen = new Set<number>();
    for (const [id, pos] of visible) {
      if (id === ownId) continue; // own entity renders from prediction below
      seen.add(id);
      const s = this.ensure(id, roster.get(id), false);
      s.root.position.set(pos.x * TILE, pos.y * TILE);
    }
    if (ownPos) {
      seen.add(ownId);
      const s = this.ensure(ownId, roster.get(ownId), true);
      s.root.position.set(ownPos.x * TILE, ownPos.y * TILE);
    }
    for (const [id, s] of this.sprites) {
      if (!seen.has(id)) {
        s.root.destroy({ children: true });
        this.sprites.delete(id);
      }
    }
  }

  remove(id: number): void {
    const s = this.sprites.get(id);
    if (s) {
      s.root.destroy({ children: true });
      this.sprites.delete(id);
    }
  }
}
