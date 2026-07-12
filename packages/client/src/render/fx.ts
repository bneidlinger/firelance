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

  /** A rumor ping (M5): concentric rings the size of the FUZZ — the circle
   *  IS the uncertainty. Long life; the slow fade is the staleness readout. */
  rumorPing(x: number, y: number, radiusUnits: number, color: number, lifeMs: number): void {
    const g = new Graphics();
    const r = Math.max(2, radiusUnits) * TILE;
    g.circle(0, 0, r).stroke({ width: 2, color, alpha: 0.45 });
    g.circle(0, 0, r * 0.55).stroke({ width: 1.5, color, alpha: 0.3 });
    g.circle(0, 0, 3.5).fill({ color, alpha: 0.85 });
    this.add(g, x, y, lifeMs, 1.12);
  }

  /** Firebomb blast: flash disc + flying embers. `big` for keep-fall drama. */
  explosion(x: number, y: number, big = false): void {
    const s = big ? 2.2 : 1;
    const flash = new Graphics();
    flash.circle(0, 0, 12 * s).fill({ color: 0xffd27a, alpha: 0.85 });
    flash.circle(0, 0, 7 * s).fill({ color: 0xffffff, alpha: 0.9 });
    this.add(flash, x, y, big ? 500 : 260, 2.6);
    const embers = new Graphics();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.3;
      embers
        .moveTo(Math.cos(a) * 4 * s, Math.sin(a) * 4 * s)
        .lineTo(Math.cos(a) * 13 * s, Math.sin(a) * 13 * s);
    }
    embers.stroke({ width: 2, color: 0xf05a4d });
    this.add(embers, x, y, big ? 700 : 380, 1.9);
  }

  /** Bomb scar: a dark stain that outlives the flash and fades slowly —
   *  the ground remembers where the siege happened. `big` for keep-falls. */
  scorch(x: number, y: number, big = false): void {
    const s = big ? 1.8 : 1;
    const g = new Graphics();
    g.circle(0, 0, 10 * s).fill({ color: 0x14170f, alpha: 0.5 });
    g.circle(0, 0, 6 * s).fill({ color: 0x0a0c08, alpha: 0.6 });
    g.circle(0, 0, 3 * s).fill({ color: 0x2a2118, alpha: 0.7 });
    this.add(g, x, y, big ? 14000 : 9000, 1.04);
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
