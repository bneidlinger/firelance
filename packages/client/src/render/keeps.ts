import { Container, Graphics } from 'pixi.js';
import { FX } from '../fx/config';
import { GOLD, INK, PROPS, SQUAD_COLORS, TERRAIN } from './palette';
import { drawPennant } from './pennant';
import { TILE } from './scene';

// Keep architecture (G2) — the emotional center gets a body. DYNAMIC since
// M3: hp burns down under siege, a fallen keep becomes a ruin, an emergency
// rebuild moves the marker. Keep hp is public information (a burning keep is
// a map event), so every squad's castle shows its damage to everyone.
//
// The castle: flagstone courtyard, four corner posts wearing squad caps, a
// stone hall under a NW-lit roof (codex sun), a gold vault door facing
// south, and the new long-range friend-or-foe read — a squad pennant waving
// over the hall, phase-offset per squad so the world doesn't metronome.
// Damage tells the siege architecture-first at the hp-bar's own color
// thresholds; the ruin is collapsed masonry under a bare, tilted mast.
// Everything stays inside the interact ring (still the claim/deposit
// tutorial) and the hp bar stays the authoritative read. Deterministic per
// squad — nothing here touches world.rng.

interface KeepSprite {
  root: Container;
  ring: Graphics;
  /** Per-frame redraw: the waving pennant (cleared while the keep is dead). */
  flag: Graphics;
  bar: Graphics;
  x: number;
  y: number;
  lastHp: number;
  /** ms timestamp of the last hp drop (drives the burning flash). */
  hitAtMs: number;
}

const BAR_W = 34;
// Castle metrics (px; composed for TILE=19, ~3 tiles across).
const YARD_R = TILE * 1.42;
const POST_D = YARD_R * 0.72;
const POST = TILE * 0.3;
const HALL_HW = 9;
const HALL_TOP = -9;
const HALL_BOT = 5;
const POLE_H = TILE * 1.1;

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
      const flag = new Graphics();
      flag.position.set(0, HALL_TOP);
      root.addChild(flag);
      const barBg = new Graphics();
      barBg.rect(-BAR_W / 2, 0, BAR_W, 5).fill({ color: 0x000000, alpha: 0.55 });
      barBg.position.set(0, -this.interactRadius * TILE - 12);
      root.addChild(barBg);
      const bar = new Graphics();
      bar.position.set(-BAR_W / 2, -this.interactRadius * TILE - 12);
      root.addChild(bar);
      this.container.addChild(root);
      s = { root, ring, flag, bar, x: 0, y: 0, lastHp: -1, hitAtMs: -1e9 };
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

    const color = SQUAD_COLORS[squad] ?? PROPS.neutral;
    const g = s.ring;
    g.clear();
    if (hp > 0) {
      g.circle(0, 0, this.interactRadius * TILE).stroke({ width: 2, color, alpha: 0.55 });
      this.drawCastle(g, color, hp / this.maxHp, squad);
    } else {
      this.drawRuin(g);
    }

    const frac = Math.max(0, Math.min(1, hp / this.maxHp));
    s.bar.clear();
    if (hp > 0) {
      const barColor = frac > 0.55 ? 0x8fae6a : frac > 0.25 ? 0xe0b95e : 0xf05a4d;
      s.bar.rect(0, 0, BAR_W * frac, 5).fill(barColor);
    }
  }

  /** The standing castle; damage escalates architecture-first at the hp
   *  bar's own thresholds (cracks → broken post + roof notch → breach). */
  private drawCastle(g: Graphics, color: number, frac: number, squad: number): void {
    const litA = FX.grounding.edgeLitAlpha;

    // Grounded (G1): the whole works casts SE shade, then the courtyard.
    g.ellipse(3, 4.5, YARD_R * 1.02, YARD_R * 0.8).fill({
      color: 0x000000,
      alpha: FX.grounding.shadowAlpha,
    });
    g.circle(0, 0, YARD_R).fill(TERRAIN.stone);
    // Flagstone mottle, hash-seeded by squad: same castle on every client.
    for (let i = 0; i < 5; i++) {
      const h = (((squad + 1) * 2654435761) ^ (i * 40503)) >>> 0;
      const a = ((h % 360) / 180) * Math.PI;
      const rr = YARD_R * (0.25 + ((h >> 4) % 50) / 100);
      g.circle(Math.cos(a) * rr, Math.sin(a) * rr, TILE * (0.18 + ((h >> 8) % 3) * 0.07)).fill({
        color: (h & 1) === 1 ? TERRAIN.rockShade : TERRAIN.rockLit,
        alpha: 0.14,
      });
    }
    g.circle(0, 0, YARD_R * 0.62).stroke({ width: 1, color: INK, alpha: 0.2 });
    g.circle(0, 0, YARD_R).stroke({ width: 1.6, color: INK, alpha: 0.55 });
    // moveTo first: Pixi chains arc() onto the open path — without it the
    // stroke drags a connector line across the yard (seen live, G2 verify).
    const ra0 = -Math.PI * 0.95;
    g.moveTo(Math.cos(ra0) * (YARD_R - 1), Math.sin(ra0) * (YARD_R - 1))
      .arc(0, 0, YARD_R - 1, ra0, -Math.PI * 0.4)
      .stroke({ width: 1.4, color: 0xffffff, alpha: litA * 0.8 });

    // Corner posts with squad caps; sieges knock them down NE-first.
    const posts: Array<[number, number]> = [
      [POST_D, -POST_D],
      [-POST_D, -POST_D],
      [-POST_D, POST_D],
      [POST_D, POST_D],
    ];
    const broken = frac <= 0.25 ? 2 : frac <= 0.55 ? 1 : 0;
    posts.forEach(([px, py], i) => {
      if (i < broken) {
        // A stub and its scatter — the post lost the argument.
        g.rect(px - POST / 2, py - 1, POST, POST * 0.5).fill({ color: PROPS.ruin, alpha: 0.9 });
        g.circle(px + 3.2, py + 3, 1.2).fill({ color: PROPS.ruin, alpha: 0.8 });
        g.circle(px - 2.6, py + 4, 0.9).fill({ color: PROPS.ruin, alpha: 0.7 });
        return;
      }
      g.rect(px - POST / 2, py - POST / 2, POST, POST).fill(TERRAIN.rock);
      g.rect(px - POST / 2, py - POST / 2, POST, POST).stroke({ width: 1, color: INK, alpha: 0.6 });
      g.moveTo(px - POST / 2 + 0.5, py - POST / 2 + 0.9)
        .lineTo(px + POST / 2 - 0.5, py - POST / 2 + 0.9)
        .stroke({ width: 1, color: 0xffffff, alpha: litA });
      g.circle(px, py + 0.5, 1.6).fill(color);
    });

    // The hall: stone walls under a NW-lit roof, vault door facing south.
    g.rect(-HALL_HW, -2, HALL_HW * 2, HALL_BOT + 2).fill(TERRAIN.rock);
    g.rect(-HALL_HW, -2, HALL_HW * 2, HALL_BOT + 2).stroke({ width: 1, color: INK, alpha: 0.7 });
    g.rect(-HALL_HW - 1, HALL_TOP, HALL_HW * 2 + 2, 8).fill(TERRAIN.rockShade);
    g.rect(-HALL_HW - 1, HALL_TOP, HALL_HW * 2 + 2, 3).fill({
      color: TERRAIN.rockLit,
      alpha: 0.8,
    });
    g.rect(-HALL_HW - 1, HALL_TOP, HALL_HW * 2 + 2, 8).stroke({ width: 1, color: INK, alpha: 0.8 });
    g.moveTo(-HALL_HW, HALL_BOT - 0.6)
      .lineTo(HALL_HW, HALL_BOT - 0.6)
      .stroke({ width: 1.2, color: INK, alpha: FX.grounding.edgeShadeAlpha });
    g.rect(-2.6, 1, 5.2, 4).fill(GOLD.trim);
    g.rect(-2.6, 1, 5.2, 4).stroke({ width: 1, color: GOLD.keep });

    // The siege, written on the masonry.
    if (frac <= 0.75) {
      g.moveTo(-14, 7).lineTo(-6, 3).lineTo(-9, -2).stroke({ width: 1.2, color: INK, alpha: 0.6 });
      g.moveTo(4, -1).lineTo(7, 3).stroke({ width: 1, color: INK, alpha: 0.55 });
    }
    if (frac <= 0.55) {
      g.moveTo(12, 9).lineTo(7, 6).lineTo(9, 12).stroke({ width: 1.2, color: INK, alpha: 0.6 });
      g.rect(4, HALL_TOP, 4, 3).fill({ color: INK, alpha: 0.6 });
    }
    if (frac <= 0.25) {
      // The breach: a hole where the roof was, soot down the wall. (The
      // critical-keep smoke wisps key off the same threshold in main.)
      g.moveTo(-6, HALL_TOP + 1)
        .lineTo(2, HALL_TOP)
        .lineTo(3, -4)
        .lineTo(-4, -3)
        .closePath()
        .fill({ color: INK, alpha: 0.8 });
      g.moveTo(-3, -2).lineTo(-3, 4).stroke({ width: 1.4, color: INK, alpha: 0.5 });
      g.moveTo(1, -3).lineTo(1, 3).stroke({ width: 1.1, color: INK, alpha: 0.45 });
      for (let i = 0; i < 4; i++) {
        const h = (((squad + 3) * 73856093) ^ (i * 19349663)) >>> 0;
        const a = ((h % 360) / 180) * Math.PI;
        const rr = YARD_R * (0.45 + ((h >> 5) % 40) / 100);
        g.circle(Math.cos(a) * rr, Math.sin(a) * rr, 1.1 + (h % 2) * 0.5).fill({
          color: PROPS.ruin,
          alpha: 0.8,
        });
      }
    }
  }

  /** Collapsed masonry: still a place — just a dead one. */
  private drawRuin(g: Graphics): void {
    g.circle(0, 0, this.interactRadius * TILE).stroke({
      width: 1.5,
      color: PROPS.ruin,
      alpha: 0.35,
    });
    // Scorched yard, its rim broken into remnant arcs.
    g.circle(0, 0, YARD_R * 0.9).fill({ color: INK, alpha: 0.3 });
    // Remnant rim arcs — moveTo first (see the connector-line note above).
    for (const [a0, a1, al] of [
      [-Math.PI * 0.85, -Math.PI * 0.3, 0.55],
      [Math.PI * 0.05, Math.PI * 0.5, 0.5],
      [Math.PI * 0.7, Math.PI * 0.95, 0.45],
    ] as Array<[number, number, number]>) {
      g.moveTo(Math.cos(a0) * YARD_R, Math.sin(a0) * YARD_R)
        .arc(0, 0, YARD_R, a0, a1)
        .stroke({ width: 1.6, color: PROPS.ruin, alpha: al });
    }
    // Every post a stub; the hall a charred shell under a fallen slab.
    for (const [px, py] of [
      [POST_D, -POST_D],
      [-POST_D, -POST_D],
      [-POST_D, POST_D],
      [POST_D, POST_D],
    ] as Array<[number, number]>) {
      g.rect(px - POST / 2, py - 1, POST, POST * 0.5).fill({ color: PROPS.ruin, alpha: 0.75 });
      g.circle(px + 2.8, py + 3, 1).fill({ color: PROPS.ruin, alpha: 0.6 });
    }
    g.rect(-HALL_HW, HALL_TOP, HALL_HW * 2, HALL_BOT - HALL_TOP).fill({ color: INK, alpha: 0.45 });
    g.rect(-HALL_HW, HALL_TOP, HALL_HW * 2, HALL_BOT - HALL_TOP).stroke({
      width: 1.2,
      color: PROPS.ruin,
      alpha: 0.7,
    });
    g.moveTo(-HALL_HW, HALL_BOT)
      .lineTo(HALL_HW - 2, HALL_TOP + 2)
      .stroke({ width: 2.2, color: PROPS.ruin, alpha: 0.5 });
    // The mast survives, tilted and bare — the flag is what died.
    g.moveTo(0, HALL_TOP)
      .lineTo(5.5, HALL_TOP - POLE_H * 0.75)
      .stroke({ width: 1.6, color: INK, alpha: 0.85 });
  }

  /** Per frame: burning flash after recent damage + the waving pennant. */
  frame(nowMs: number): void {
    for (const [squad, s] of this.sprites) {
      const since = nowMs - s.hitAtMs;
      s.root.tint = since < 450 && Math.sin(nowMs / 60) > 0 ? 0xffb0a0 : 0xffffff;
      s.flag.clear();
      if (s.lastHp > 0) {
        drawPennant(
          s.flag,
          POLE_H,
          TILE * 0.75,
          SQUAD_COLORS[squad] ?? PROPS.neutral,
          nowMs / 260 + squad * 1.9,
        );
      }
    }
  }
}
