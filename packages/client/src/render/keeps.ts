import { Container, Graphics } from 'pixi.js';
import { SQUAD_COLORS, TILE } from './scene';

// Keep status markers — DYNAMIC as of M3: hp bars burn down under siege, a
// fallen keep becomes a grey ruin, and an emergency rebuild moves the marker
// to its new site. Keep hp is public information (a burning keep is a map
// event), so every squad's marker shows its bar to everyone.

interface KeepSprite {
  root: Container;
  ring: Graphics;
  bar: Graphics;
  x: number;
  y: number;
  lastHp: number;
  /** ms timestamp of the last hp drop (drives the burning flash). */
  hitAtMs: number;
}

const BAR_W = 34;

export class KeepLayer {
  private sprites = new Map<number, KeepSprite>();

  constructor(
    private readonly container: Container,
    private readonly maxHp: number,
    private readonly interactRadius: number,
  ) {}

  clear(): void {
    for (const s of this.sprites.values()) s.root.destroy({ children: true });
    this.sprites.clear();
  }

  /** Create/update a squad's keep marker (position moves on rebuild). */
  update(squad: number, x: number, y: number, hp: number): void {
    let s = this.sprites.get(squad);
    if (!s) {
      const root = new Container();
      const ring = new Graphics();
      root.addChild(ring);
      const barBg = new Graphics();
      barBg.rect(-BAR_W / 2, 0, BAR_W, 5).fill({ color: 0x000000, alpha: 0.55 });
      barBg.position.set(0, -this.interactRadius * TILE - 12);
      root.addChild(barBg);
      const bar = new Graphics();
      bar.position.set(-BAR_W / 2, -this.interactRadius * TILE - 12);
      root.addChild(bar);
      this.container.addChild(root);
      s = { root, ring, bar, x: 0, y: 0, lastHp: -1, hitAtMs: -1e9 };
      this.sprites.set(squad, s);
    }
    if (s.x !== x || s.y !== y) {
      s.x = x;
      s.y = y;
      s.root.position.set(x * TILE, y * TILE);
      s.lastHp = -1; // force redraw at the new site
    }
    if (hp < s.lastHp && s.lastHp >= 0) s.hitAtMs = performance.now();
    if (hp === s.lastHp) return;
    s.lastHp = hp;

    const color = SQUAD_COLORS[squad] ?? 0xffffff;
    const g = s.ring;
    g.clear();
    if (hp > 0) {
      g.circle(0, 0, this.interactRadius * TILE).stroke({ width: 2, color, alpha: 0.55 });
      g.circle(0, 0, 4).fill(color);
      // Simple bastion square behind the dot so keeps read as buildings.
      g.rect(-7, -7, 14, 14).stroke({ width: 2, color, alpha: 0.9 });
    } else {
      // The ruin: broken grey ring + rubble X. Still a place — just a dead one.
      g.circle(0, 0, this.interactRadius * TILE).stroke({
        width: 1.5,
        color: 0x777770,
        alpha: 0.35,
      });
      g.moveTo(-8, -8).lineTo(8, 8).moveTo(8, -8).lineTo(-8, 8).stroke({
        width: 3,
        color: 0x777770,
        alpha: 0.8,
      });
    }

    const frac = Math.max(0, Math.min(1, hp / this.maxHp));
    s.bar.clear();
    if (hp > 0) {
      const barColor = frac > 0.55 ? 0x8fae6a : frac > 0.25 ? 0xe0b95e : 0xf05a4d;
      s.bar.rect(0, 0, BAR_W * frac, 5).fill(barColor);
    }
  }

  /** Burning flash after recent damage; call per frame. */
  frame(nowMs: number): void {
    for (const s of this.sprites.values()) {
      const since = nowMs - s.hitAtMs;
      s.root.tint = since < 450 && Math.sin(nowMs / 60) > 0 ? 0xffb0a0 : 0xffffff;
    }
  }
}
