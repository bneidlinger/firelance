import { Container, Graphics, Text } from 'pixi.js';
import type { ClassId, GameConfig } from '@shared/config';
import { getKit } from '@shared/config';
import type { RosterEntry } from '@shared/net/messages';
import {
  ST_ACTIVE,
  ST_BANKING,
  ST_BLOCKING,
  ST_CARRYING,
  ST_DASHING,
  ST_WINDUP,
} from '@shared/net/messages';
import type { RichEnt } from '../net/interpolation';
import { SQUAD_COLORS, TILE } from './scene';

// Placeholder-art entity rendering, combat edition: squad-colored circles with
// facing, hp bars, shield/windup/swing/dash state visuals, and damage flashes.
// Readability first; the concept art's look is a post-fun-proof concern.

interface Sprite {
  root: Container;
  body: Graphics;
  state: Graphics; // per-frame redraw: shield arc, swing wedge, dash streak
  hpFill: Graphics;
  label: Text;
  cls: ClassId | null;
  flashUntil: number;
  baseColor: number;
}

export interface OwnVisual {
  x: number;
  y: number;
  ax: number;
  ay: number;
  hp: number;
  cls: ClassId;
  st: number;
  g?: number;
}

const HP_W = 26;

export class EntityLayer {
  private sprites = new Map<number, Sprite>();

  constructor(
    private readonly container: Container,
    private readonly cfg: GameConfig,
  ) {}

  clear(): void {
    for (const s of this.sprites.values()) s.root.destroy({ children: true });
    this.sprites.clear();
  }

  /** Brief white flash on a hit victim (called from hit events). */
  flash(id: number): void {
    const s = this.sprites.get(id);
    if (s) s.flashUntil = performance.now() + 110;
  }

  private ensure(id: number, entry: RosterEntry | undefined, isSelf: boolean): Sprite {
    let s = this.sprites.get(id);
    if (s) return s;
    const color = SQUAD_COLORS[entry?.squad ?? 0] ?? 0xffffff;
    const root = new Container();
    const state = new Graphics();
    root.addChild(state);
    const body = new Graphics();
    root.addChild(body);

    const hpBg = new Graphics();
    hpBg.rect(-HP_W / 2, 0, HP_W, 3.5).fill({ color: 0x000000, alpha: 0.55 });
    hpBg.position.set(0, -TILE * 0.4 - 10);
    root.addChild(hpBg);
    const hpFill = new Graphics();
    hpFill.rect(0, 0, 1, 3.5).fill(0xffffff);
    hpFill.position.set(-HP_W / 2, -TILE * 0.4 - 10);
    root.addChild(hpFill);

    const label = new Text({
      text: entry?.name ?? `#${id}`,
      style: {
        fontSize: 11,
        fill: isSelf ? 0xf4ead8 : 0xb9ad98,
        fontFamily: 'Consolas, monospace',
      },
    });
    label.anchor.set(0.5, 1);
    label.position.set(0, -TILE * 0.4 - 12);
    root.addChild(label);

    this.container.addChild(root);
    s = { root, body, state, hpFill, label, cls: null, flashUntil: 0, baseColor: color };
    this.sprites.set(id, s);
    return s;
  }

  /** Redraw the body when class changes (fighters read heavier than rangers). */
  private drawBody(s: Sprite, cls: ClassId, isSelf: boolean, bot: boolean): void {
    if (s.cls === cls) return;
    s.cls = cls;
    const g = s.body;
    g.clear();
    const r = this.cfg.player.radius * TILE;
    g.circle(0, 0, r).fill(s.baseColor);
    if (cls === 'fighter') {
      g.circle(0, 0, r - 1.5).stroke({ width: 2.5, color: 0x00000, alpha: 0.35 });
    } else if (cls === 'engineer') {
      // The builder's mark: a square frame inside the circle.
      g.rect(-r * 0.45, -r * 0.45, r * 0.9, r * 0.9).stroke({
        width: 1.5,
        color: 0x000000,
        alpha: 0.4,
      });
    }
    if (isSelf) {
      g.circle(0, 0, r + 2.5).stroke({ width: 2, color: 0xf4ead8 });
    } else if (bot) {
      g.circle(0, 0, r).stroke({ width: 1, color: 0x000000, alpha: 0.45 });
    }
  }

  /** Per-frame state visuals: facing tick, shield arc, swing wedge, dash streak. */
  private drawState(s: Sprite, e: { ax: number; ay: number; st: number; cls: ClassId }): void {
    const g = s.state;
    g.clear();
    const r = this.cfg.player.radius * TILE;
    const angle = Math.atan2(e.ay, e.ax);

    // Facing tick (always).
    g.moveTo(0, 0)
      .lineTo(e.ax * r, e.ay * r)
      .stroke({ width: 2, color: 0x14170f, alpha: 0.7 });

    if (e.st & ST_BLOCKING) {
      // Shield arc across the protected 120° frontal sector.
      g.arc(0, 0, r + 3, angle - Math.PI / 3, angle + Math.PI / 3).stroke({
        width: 3.5,
        color: 0x9db4c9,
      });
    }
    if (e.st & ST_WINDUP && e.cls === 'fighter') {
      const melee = getKit(this.cfg, 'fighter').melee!;
      const reach = (melee.range + this.cfg.player.radius) * TILE;
      const half = Math.acos(melee.arcCosHalf);
      g.moveTo(0, 0)
        .arc(0, 0, reach, angle - half, angle + half)
        .lineTo(0, 0)
        .fill({ color: 0xf05a4d, alpha: 0.14 });
    }
    if (e.st & ST_ACTIVE && e.cls === 'fighter') {
      const melee = getKit(this.cfg, 'fighter').melee!;
      const reach = (melee.range + this.cfg.player.radius) * TILE;
      const half = Math.acos(melee.arcCosHalf);
      g.moveTo(0, 0)
        .arc(0, 0, reach, angle - half, angle + half)
        .lineTo(0, 0)
        .fill({ color: 0xffe9b0, alpha: 0.4 });
    }
    if (e.st & ST_DASHING) {
      g.moveTo(-e.ax * r * 2.4, -e.ay * r * 2.4)
        .lineTo(0, 0)
        .stroke({ width: r, color: 0xffffff, alpha: 0.25 });
    }
    if (e.st & ST_CARRYING) {
      // The sack on their back: a gold diamond trailing opposite the facing.
      // Everyone can SEE a carrier — only the amount is squad-private.
      const bx = -e.ax * (r + 3);
      const by = -e.ay * (r + 3);
      g.moveTo(bx, by - 4)
        .lineTo(bx + 4, by)
        .lineTo(bx, by + 4)
        .lineTo(bx - 4, by)
        .closePath()
        .fill(0xf2d68c)
        .stroke({ width: 1, color: 0x7a6544 });
    }
    if (e.st & ST_BANKING) {
      // Deposit channel in progress — the "interrupt me!" beacon.
      const pulse = 0.55 + 0.35 * Math.sin(performance.now() / 120);
      g.circle(0, 0, r + 6).stroke({ width: 2.5, color: 0xf2d68c, alpha: pulse });
    }
  }

  private drawHp(s: Sprite, hp: number, cls: ClassId): void {
    const maxHp = getKit(this.cfg, cls).maxHp;
    const frac = Math.max(0, Math.min(1, hp / maxHp));
    s.hpFill.clear();
    const color = frac > 0.55 ? 0x8fae6a : frac > 0.28 ? 0xe0b95e : 0xf05a4d;
    s.hpFill.rect(0, 0, HP_W * frac, 3.5).fill(color);
  }

  /** Upsert every visible entity, drop everything no longer visible. */
  sync(
    visible: Map<number, RichEnt>,
    roster: Map<number, RosterEntry>,
    ownId: number,
    own: OwnVisual | null,
  ): void {
    const now = performance.now();
    const seen = new Set<number>();
    for (const [id, e] of visible) {
      if (id === ownId) continue; // own entity renders from prediction below
      seen.add(id);
      const entry = roster.get(id);
      const s = this.ensure(id, entry, false);
      this.drawBody(s, e.cls, false, entry?.bot ?? false);
      this.drawState(s, e);
      this.drawHp(s, e.hp, e.cls);
      // Squadmates broadcast their load next to their name (escort intel).
      const base = entry?.name ?? `#${id}`;
      const want = e.g !== undefined && e.g > 0 ? `${base} ◆${e.g}` : base;
      if (s.label.text !== want) s.label.text = want;
      // Damage flash: brief warm tint on the whole sprite.
      s.root.tint = now < s.flashUntil ? 0xffb0a0 : 0xffffff;
      s.root.position.set(e.x * TILE, e.y * TILE);
    }
    if (own) {
      seen.add(ownId);
      const entry = roster.get(ownId);
      const s = this.ensure(ownId, entry, true);
      this.drawBody(s, own.cls, true, false);
      this.drawState(s, own);
      this.drawHp(s, own.hp, own.cls);
      s.root.tint = now < s.flashUntil ? 0xffb0a0 : 0xffffff;
      s.root.position.set(own.x * TILE, own.y * TILE);
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
