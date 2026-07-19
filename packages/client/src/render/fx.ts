import { Container, Graphics } from 'pixi.js';
import { FX } from '../fx/config';
import { ARMORY, INK, PROPS, TERRAIN } from './palette';
import { TILE } from './scene';

// Transient world-space effects: hit sparks, arrow impacts, death markers —
// and, on the decal instance (G3), the long-lived scars: scorch, rubble,
// stumps, hut ruins. Fire-and-forget; each effect owns a tiny fade-out life.
// An optional cap bounds the pool: past it the OLDEST effect is dropped
// early, so a demolition derby can't grow the layer without limit.

interface Effect {
  gfx: Graphics;
  bornMs: number;
  lifeMs: number;
  grow: number;
}

export class FxLayer {
  private effects: Effect[] = [];

  constructor(
    private readonly container: Container,
    private readonly cap?: number,
  ) {}

  clear(): void {
    for (const e of this.effects) e.gfx.destroy();
    this.effects = [];
  }

  /** Pool size probe (soaks assert the decal cap holds). */
  count(): number {
    return this.effects.length;
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

  /** A dead wall/gate/tower (G3): strewn masonry that outlives the fight.
   *  Hash-shaped from coords so the same corpse looks the same to everyone. */
  rubblePile(x: number, y: number, lifeMs: number): void {
    const h = ((Math.round(x * 7) * 73856093) ^ (Math.round(y * 7) * 19349663)) >>> 0;
    const g = new Graphics();
    g.ellipse(1, 1.5, 8.5, 6).fill({ color: 0x000000, alpha: 0.18 });
    for (let i = 0; i < 6; i++) {
      const hh = (h >> (i * 4)) & 0xff;
      const a = (hh / 255) * Math.PI * 2;
      const d = 2 + (hh % 5);
      const rx = Math.cos(a) * d;
      const ry = Math.sin(a) * d * 0.75;
      g.rect(rx - 1.6, ry - 1.2, 3.2, 2.4).fill({
        color: i % 2 === 0 ? TERRAIN.rock : PROPS.ruin,
        alpha: 0.9,
      });
      g.rect(rx - 1.6, ry - 1.2, 3.2, 2.4).stroke({ width: 0.7, color: INK, alpha: 0.5 });
    }
    g.circle(-4, 3, 1).fill({ color: PROPS.neutral, alpha: 0.8 });
    g.circle(5, -2.5, 0.9).fill({ color: PROPS.neutral, alpha: 0.7 });
    this.add(g, x, y, lifeMs, 1.0);
  }

  /** A felled tree (G3): stump rings + the trunk laid along a hash angle. */
  stump(x: number, y: number, lifeMs: number): void {
    const h = ((Math.round(x * 7) * 40503) ^ (Math.round(y * 7) * 97531)) >>> 0;
    const ang = ((h % 360) / 180) * Math.PI;
    const tx = Math.cos(ang);
    const ty = Math.sin(ang);
    const g = new Graphics();
    g.ellipse(tx * 8 + 1, ty * 8 + 1.5, 7.5, 3.5).fill({ color: 0x000000, alpha: 0.15 });
    g.moveTo(tx * 3, ty * 3)
      .lineTo(tx * 13, ty * 13)
      .stroke({ width: 3.4, color: PROPS.trunk });
    g.moveTo(tx * 3.5 - ty * 0.7, ty * 3.5 + tx * 0.7)
      .lineTo(tx * 12 - ty * 0.7, ty * 12 + tx * 0.7)
      .stroke({ width: 1, color: ARMORY.WOOD, alpha: 0.8 });
    g.circle(tx * 14 + 2, ty * 14 - 1, 2.4).fill({ color: PROPS.oak, alpha: 0.55 });
    g.circle(tx * 12 - 2, ty * 12 + 2.5, 1.9).fill({ color: PROPS.oak, alpha: 0.45 });
    g.circle(0, 0, 3).fill(PROPS.trunk);
    g.circle(0, 0, 2.1).fill({ color: ARMORY.LEATHER, alpha: 0.95 });
    g.circle(0, 0, 0.9).fill({ color: PROPS.trunk, alpha: 0.9 });
    this.add(g, x, y, lifeMs, 1.0);
  }

  /** A collapsed cottage (G3): charred footprint, fallen beams, thatch. */
  hutRuin(x: number, y: number, lifeMs: number): void {
    const g = new Graphics();
    g.rect(-7, -6, 14, 12).fill({ color: INK, alpha: 0.5 });
    g.rect(-7, -6, 14, 12).stroke({ width: 1, color: PROPS.hutEdge, alpha: 0.8 });
    g.moveTo(-6, -4).lineTo(5, 4).stroke({ width: 2, color: PROPS.hutEdge, alpha: 0.9 });
    g.moveTo(6, -5).lineTo(-3, 3).stroke({ width: 1.6, color: PROPS.trunk, alpha: 0.85 });
    g.circle(-4, 4.5, 1.6).fill({ color: PROPS.thatch, alpha: 0.6 });
    g.circle(5.5, -1.5, 1.3).fill({ color: PROPS.thatch, alpha: 0.5 });
    g.circle(1.5, 6, 1.2).fill({ color: PROPS.ruin, alpha: 0.7 });
    this.add(g, x, y, lifeMs, 1.0);
  }

  /** Additive flash disc (G4): block clangs, trap snaps, writ pops. Never a
   *  filter — stacked alpha discs on blendMode 'add' ARE the glow. */
  flash(x: number, y: number, r: number, color: number, lifeMs: number): void {
    const g = new Graphics();
    g.blendMode = 'add';
    g.circle(0, 0, r).fill({ color, alpha: 0.5 });
    g.circle(0, 0, r * 0.45).fill({ color: 0xffffff, alpha: 0.45 });
    this.add(g, x, y, lifeMs, 1.5);
  }

  /** Additive expanding ring — the bomb's pressure wave (G4). */
  blastRing(x: number, y: number, r: number, color: number, lifeMs: number): void {
    const g = new Graphics();
    g.blendMode = 'add';
    g.circle(0, 0, r).stroke({ width: 3, color, alpha: 0.7 });
    g.circle(0, 0, r * 0.7).stroke({ width: 1.5, color: 0xffffff, alpha: 0.4 });
    this.add(g, x, y, lifeMs, 2.6);
  }

  /** Additive muzzle fan at a loose (G4) — the shot's birth certificate.
   *  Warm for arrows, steel-blue for bolts. */
  muzzleFlash(x: number, y: number, dx: number, dy: number, color: number): void {
    const g = new Graphics();
    g.blendMode = 'add';
    const a = Math.atan2(dy, dx);
    for (const spread of [-0.35, 0, 0.35]) {
      const len = spread === 0 ? 9 : 6.5;
      g.moveTo(Math.cos(a + spread) * 2, Math.sin(a + spread) * 2).lineTo(
        Math.cos(a + spread) * len,
        Math.sin(a + spread) * len,
      );
    }
    g.stroke({ width: 2, color, alpha: 0.65 });
    g.circle(dx * 2.5, dy * 2.5, 2.2).fill({ color: 0xffffff, alpha: 0.5 });
    this.add(g, x, y, FX.arcade.muzzleMs, 1.35);
  }

  private add(g: Graphics, x: number, y: number, lifeMs: number, grow: number): void {
    if (this.cap !== undefined && this.effects.length >= this.cap) {
      const oldest = this.effects.shift()!;
      oldest.gfx.destroy();
    }
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
