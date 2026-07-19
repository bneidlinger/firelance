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
  ST_ROOTED,
  ST_WINDUP,
} from '@shared/net/messages';
import { bountyTier } from '@shared/sim/systems/economy';
import { FX } from '../fx/config';
import type { RichEnt } from '../net/interpolation';
import {
  ALARM,
  ARMORY,
  FIRE,
  GOLD,
  KHAKI,
  PARCHMENT,
  SQUAD_COLORS,
  TIER_COLORS,
} from './palette';
import { TILE } from './scene';

// Procedural top-down soldiers (character pass). The squad-colored disc STAYS
// the dominant read — friend-or-foe at a glance outranks costume — and the
// class is worn on top of it: steel helm/pauldrons/shield/sword for the
// fighter, hood/quiver/bow for the ranger, cap/pack/crossbow for the engineer.
// The body rotates to facing (the helmet leads, the weapon is the aim line);
// boots step with the distance-driven gait phase along the MOVE direction, so
// strafing reads as strafing. Still Pixi primitives only — no asset files.

// The armory palette lives in the codex (render/palette.ts) with everything
// else: muted steel, oiled leather, bow wood — nothing saturated enough to
// fight a squad color.
const {
  STEEL,
  STEEL_DARK,
  STEEL_EDGE,
  STEEL_BRIGHT,
  BLADE,
  GUARD,
  LEATHER,
  PACK,
  PACK_EDGE,
  WOOD,
  FLETCH,
  HOOD,
  COWL_SHADOW,
  BOOT,
  SHIELD_RAISED,
} = ARMORY;

type Pose = 'idle' | 'windup' | 'active' | 'block';

interface Sprite {
  root: Container;
  shadow: Graphics;
  /** Boots, drawn in root space along the movement direction (not facing). */
  feet: Graphics;
  /** Rotates to facing and carries the gait bob; body + gear live inside. */
  bodyWrap: Container;
  body: Graphics;
  /** Weapon layer: redrawn only when the pose bucket changes. */
  gear: Graphics;
  state: Graphics; // per-frame redraw: shield arc, swing wedge, dash streak
  /** Static codex-sun overlay ABOVE the body: shade crescent + rim glint. */
  sun: Graphics;
  hpFill: Graphics;
  label: Text;
  /** The writ over their head: ★bounty in tier color. Hidden at 0. */
  writ: Text;
  writKey: string; // bounty|tier — the Text re-renders only when this changes
  writTier: number;
  bodyKey: string; // cls|self|bot — body redraws only when this changes
  poseKey: string; // cls|pose|ready — gear redraws only when this changes
  cls: ClassId | null;
  flashUntil: number;
  baseColor: number;
  // Walk bob (M6 s2): phase advances with DISTANCE walked, so it reads as
  // gait and a standing body holds still.
  lastX: number;
  lastY: number;
  bobPhase: number;
  /** Last walking direction — the boots keep pointing there at rest. */
  moveAng: number;
  /** Was stepping last frame (lets idle frames skip the feet redraw). */
  stepping: boolean;
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
  /** Local fire-gate mirror: false while the bow/crossbow is rearming, so the
   *  nocked arrow visibly returns when the next shot is live. */
  atkReady?: boolean;
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
    const r = this.cfg.player.radius * TILE;
    const root = new Container();

    // Bottom-up: shadow grounds the body, state visuals radiate from under it,
    // boots slide under the disc, then the rotating body itself.
    const shadow = new Graphics();
    shadow
      .ellipse(r * 0.12, r * 0.24, r * 1.15, r * 0.8)
      .fill({ color: 0x000000, alpha: FX.character.shadowAlpha });
    root.addChild(shadow);
    const state = new Graphics();
    root.addChild(state);
    const feet = new Graphics();
    root.addChild(feet);
    const bodyWrap = new Container();
    const body = new Graphics();
    const gear = new Graphics();
    bodyWrap.addChild(body);
    bodyWrap.addChild(gear);
    root.addChild(bodyWrap);
    // The codex sun (NW; render/palette.ts), drawn ONCE and layered ABOVE the
    // rotated body so it actually lands on the disc: shade crescent lower-
    // right, rim glint upper-left. It used to be redrawn every frame in the
    // state layer UNDER the opaque torso — invisible since the modern pass;
    // G1's pixel probe caught it. Unrotated: the sun must not spin with aim.
    const sun = new Graphics();
    sun
      .arc(0, 0, r * 0.98, -Math.PI * 0.2, Math.PI * 0.7)
      .arc(0, 0, r * 0.55, Math.PI * 0.7, -Math.PI * 0.2, true)
      .closePath()
      .fill({ color: 0x000000, alpha: FX.character.shadeAlpha });
    const ga0 = -Math.PI * 0.9;
    sun
      .moveTo(Math.cos(ga0) * r * 0.78, Math.sin(ga0) * r * 0.78)
      .arc(0, 0, r * 0.78, ga0, -Math.PI * 0.45)
      .stroke({
        width: r * 0.16,
        color: 0xffffff,
        alpha: FX.character.glintAlpha,
      });
    root.addChild(sun);

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
        fill: isSelf ? PARCHMENT : KHAKI,
        fontFamily: 'Consolas, monospace',
      },
    });
    label.anchor.set(0.5, 1);
    label.position.set(0, -TILE * 0.4 - 12);
    root.addChild(label);

    // The writ: the price on their head, nailed one line above the name. The
    // soft under-shadow keeps a khaki 9px number readable over sunlit grass.
    const writ = new Text({
      text: '',
      style: {
        fontSize: 9,
        fill: TIER_COLORS[0]!,
        fontFamily: 'Consolas, monospace',
        dropShadow: { color: 0x000000, alpha: 0.6, blur: 1, distance: 1, angle: Math.PI / 2 },
      },
    });
    writ.anchor.set(0.5, 1);
    writ.position.set(0, -TILE * 0.4 - 27);
    writ.visible = false;
    root.addChild(writ);

    this.container.addChild(root);
    s = {
      root,
      shadow,
      feet,
      bodyWrap,
      body,
      gear,
      state,
      sun,
      hpFill,
      label,
      writ,
      writKey: '',
      writTier: 0,
      bodyKey: '',
      poseKey: '',
      cls: null,
      flashUntil: 0,
      baseColor: color,
      lastX: NaN,
      lastY: NaN,
      bobPhase: 0,
      moveAng: 0,
      stepping: true, // force the first feet draw
    };
    this.sprites.set(id, s);
    return s;
  }

  /** Advance the gait phase by distance moved and squash the body a touch.
   *  Teleports (respawn, first sight) don't spin the phase. */
  private bob(s: Sprite, px: number, py: number): boolean {
    const dx = px - s.lastX;
    const dy = py - s.lastY;
    const moved = Math.hypot(dx, dy);
    let moving = false;
    if (moved > 0.01 && moved < TILE * 2) {
      s.bobPhase += (moved / TILE) * FX.movement.bobPerUnit;
      s.bodyWrap.scale.set(1 + Math.sin(s.bobPhase) * FX.movement.bobAmp);
      s.moveAng = Math.atan2(dy, dx);
      moving = true;
    } else if (!(moved > 0.01)) {
      s.bodyWrap.scale.set(1);
    }
    s.lastX = px;
    s.lastY = py;
    return moving;
  }

  /** Two boots under the disc: they slide fore/aft along the MOVE direction
   *  on the gait phase, and tuck to a neutral stance at rest. */
  private drawFeet(s: Sprite, moving: boolean): void {
    if (!moving && !s.stepping) return; // still standing — boots already drawn
    s.stepping = moving;
    const g = s.feet;
    g.clear();
    const r = this.cfg.player.radius * TILE;
    const fx = Math.cos(s.moveAng);
    const fy = Math.sin(s.moveAng);
    const step = moving ? Math.sin(s.bobPhase) * FX.character.strideAmp * r : 0;
    // Perpendicular stance width; opposite feet swing opposite directions.
    g.circle(-fy * r * 0.5 + fx * step, fx * r * 0.5 + fy * step, FX.character.bootR * r).fill(
      BOOT,
    );
    g.circle(fy * r * 0.5 - fx * step, -fx * r * 0.5 - fy * step, FX.character.bootR * r).fill(
      BOOT,
    );
  }

  /** Redraw the body when class/self/bot changes. Local frame: +X is forward.
   *  Worn kit (pack, quiver, helm) rotates with the body; that's correct —
   *  it's ON them. World lighting (the torso shade) is the static sun
   *  overlay above this layer — see ensure. */
  private drawBody(s: Sprite, cls: ClassId, isSelf: boolean, bot: boolean): void {
    const key = `${cls}|${isSelf ? 1 : 0}|${bot ? 1 : 0}`;
    if (s.bodyKey === key) return;
    s.bodyKey = key;
    s.cls = cls;
    const g = s.body;
    g.clear();
    const r = this.cfg.player.radius * TILE;

    // Back-worn kit first, so the torso overlaps its front edge.
    if (cls === 'engineer') {
      g.roundRect(-r * 1.08, -r * 0.45, r * 0.75, r * 0.9, r * 0.2).fill(PACK);
      g.roundRect(-r * 1.08, -r * 0.45, r * 0.75, r * 0.9, r * 0.2).stroke({
        width: r * 0.17,
        color: PACK_EDGE,
      });
    } else if (cls === 'ranger') {
      // Quiver over the shoulder-blade, pale fletchings at its mouth.
      g.moveTo(-r * 0.4, -r * 0.5)
        .lineTo(-r * 1.0, -r * 0.85)
        .stroke({ width: r * 0.44, color: PACK });
      g.circle(-r * 1.0, -r * 0.85, r * 0.18).fill(FLETCH);
    }

    // Torso: THE squad-color disc, unchanged size — an honest hitbox. The dark
    // contour pops the silhouette off the ground; kit worn over it.
    g.circle(0, 0, r).fill(s.baseColor);
    g.circle(0, 0, r).stroke({
      width: FX.character.outlineW * r,
      color: FX.character.outlineColor,
      alpha: FX.character.outlineAlpha,
    });

    if (cls === 'fighter') {
      // Pauldrons across both shoulders — tucked inside the rim so the squad
      // color stays a continuous ring; friend-or-foe outranks costume.
      g.circle(-r * 0.1, -r * 0.62, r * 0.27).fill(STEEL);
      g.circle(-r * 0.1, r * 0.62, r * 0.27).fill(STEEL);
      g.circle(-r * 0.1, -r * 0.62, r * 0.27).stroke({ width: r * 0.14, color: STEEL_EDGE });
      g.circle(-r * 0.1, r * 0.62, r * 0.27).stroke({ width: r * 0.14, color: STEEL_EDGE });
      // Steel helm, nose-guard forward: the aim IS the face.
      g.circle(r * 0.18, 0, r * 0.55).fill(STEEL);
      g.moveTo(r * 0.3, 0)
        .lineTo(r * 0.8, 0)
        .stroke({ width: r * 0.2, color: STEEL_DARK });
      g.circle(r * 0.02, -r * 0.2, r * 0.14).fill({ color: STEEL_BRIGHT, alpha: 0.9 });
    } else if (cls === 'ranger') {
      // Hood: a teardrop — the point trails behind the head.
      g.circle(-r * 0.14, 0, r * 0.42).fill(HOOD);
      g.circle(r * 0.15, 0, r * 0.55).fill(HOOD);
      // The face is a shadow inside the cowl.
      g.circle(r * 0.42, 0, r * 0.24).fill(COWL_SHADOW);
      g.circle(r * 0.0, -r * 0.2, r * 0.12).fill({ color: 0x8fa578, alpha: 0.7 });
    } else {
      // Leather cap, goggles resting up on the brim.
      g.circle(r * 0.15, 0, r * 0.52).fill(LEATHER);
      g.circle(r * 0.02, -r * 0.17, r * 0.14).fill(0x3a3f45);
      g.circle(r * 0.02, r * 0.17, r * 0.14).fill(0x3a3f45);
      g.circle(r * 0.02, -r * 0.17, r * 0.14).stroke({ width: r * 0.09, color: STEEL });
      g.circle(r * 0.02, r * 0.17, r * 0.14).stroke({ width: r * 0.09, color: STEEL });
    }

    if (isSelf) {
      g.circle(0, 0, r * 1.35).stroke({ width: r * 0.28, color: 0xf4ead8 });
    }
  }

  /** The weapon layer, in the rotated body frame. Redrawn per pose bucket:
   *  the fighter's sword pulls back on windup and crosses on the strike; the
   *  ranger's nocked arrow (and the engineer's loaded bolt) is the aim line
   *  and visibly returns when the fire gate re-arms. */
  private drawGear(s: Sprite, cls: ClassId, pose: Pose, ready: boolean): void {
    const key = `${cls}|${pose}|${ready ? 1 : 0}`;
    if (s.poseKey === key) return;
    s.poseKey = key;
    const g = s.gear;
    g.clear();
    const r = this.cfg.player.radius * TILE;

    if (cls === 'fighter') {
      // Shield on the left arm; braced across the front while blocking. (The
      // 120° state arc stays the authoritative cover telegraph — this is the
      // physical shield inside it.)
      if (pose === 'block') {
        g.arc(0, 0, r * 1.12, -1.05, 1.05).stroke({ width: r * 0.5, color: SHIELD_RAISED });
      } else {
        // Slung on the arm, inside the rim — the squad ring stays unbroken.
        g.arc(0, 0, r * 0.9, -1.42, -0.5).stroke({ width: r * 0.32, color: STEEL });
      }
      // Sword in the right hand.
      const hx = r * 0.1;
      const hy = r * 0.9;
      const ang =
        pose === 'windup' ? 1.65 : pose === 'active' ? -0.45 : pose === 'block' ? 1.0 : 0.32;
      const len = r * 1.65;
      g.moveTo(hx, hy)
        .lineTo(hx + Math.cos(ang) * len, hy + Math.sin(ang) * len)
        .stroke({ width: r * 0.3, color: BLADE });
      const gx = hx + Math.cos(ang) * r * 0.4;
      const gy = hy + Math.sin(ang) * r * 0.4;
      const px = Math.cos(ang + Math.PI / 2) * r * 0.3;
      const py = Math.sin(ang + Math.PI / 2) * r * 0.3;
      g.moveTo(gx + px, gy + py)
        .lineTo(gx - px, gy - py)
        .stroke({ width: r * 0.22, color: GUARD });
    } else if (cls === 'ranger') {
      // Bow bulging forward, string as the chord behind it.
      g.arc(r * 0.35, 0, r * 0.85, -1.1, 1.1).stroke({ width: r * 0.26, color: WOOD });
      const ex = r * 0.35 + Math.cos(1.1) * r * 0.85;
      const ey = Math.sin(1.1) * r * 0.85;
      g.moveTo(ex, -ey)
        .lineTo(ex, ey)
        .stroke({ width: r * 0.12, color: FLETCH, alpha: 0.8 });
      if (ready) {
        g.moveTo(-r * 0.15, 0)
          .lineTo(r * 1.5, 0)
          .stroke({ width: r * 0.17, color: FLETCH });
        g.moveTo(r * 1.5, 0)
          .lineTo(r * 1.15, -r * 0.18)
          .moveTo(r * 1.5, 0)
          .lineTo(r * 1.15, r * 0.18)
          .stroke({ width: r * 0.15, color: FLETCH });
      }
    } else {
      // Crossbow: stock + steel crossarm, bolt tip winking when loaded.
      g.moveTo(r * 0.15, 0)
        .lineTo(r * 1.3, 0)
        .stroke({ width: r * 0.3, color: PACK });
      g.moveTo(r * 0.95, -r * 0.55)
        .lineTo(r * 0.95, r * 0.55)
        .stroke({ width: r * 0.24, color: STEEL });
      if (ready) g.circle(r * 1.42, 0, r * 0.16).fill(FLETCH);
    }
  }

  /** Melee pose from the state bits; only the fighter carries a sword. */
  private pose(st: number, cls: ClassId): Pose {
    if (cls !== 'fighter') return 'idle';
    if (st & ST_ACTIVE) return 'active';
    if (st & ST_WINDUP) return 'windup';
    if (st & ST_BLOCKING) return 'block';
    return 'idle';
  }

  /** Per-frame state visuals: shield arc, swing wedge, dash streak. Facing
   *  itself is carried by the rotated body (helmet + weapon) now. */
  private drawState(s: Sprite, e: { ax: number; ay: number; st: number; cls: ClassId }): void {
    const g = s.state;
    g.clear();
    const r = this.cfg.player.radius * TILE;
    const angle = Math.atan2(e.ay, e.ax);

    // World lighting lives on the static `sun` overlay above the body (see
    // ensure) — this layer keeps only the dynamic telegraphs.

    if (e.st & ST_BLOCKING) {
      // Shield arc across the protected 120° frontal sector.
      g.arc(0, 0, r * 1.4, angle - Math.PI / 3, angle + Math.PI / 3).stroke({
        width: r * 0.55,
        color: SHIELD_RAISED,
      });
    }
    if (e.st & ST_WINDUP && e.cls === 'fighter') {
      const melee = getKit(this.cfg, 'fighter').melee!;
      const reach = (melee.range + this.cfg.player.radius) * TILE;
      const half = Math.acos(melee.arcCosHalf);
      g.moveTo(0, 0)
        .arc(0, 0, reach, angle - half, angle + half)
        .lineTo(0, 0)
        .fill({ color: ALARM, alpha: 0.14 });
    }
    if (e.st & ST_ACTIVE && e.cls === 'fighter') {
      const melee = getKit(this.cfg, 'fighter').melee!;
      const reach = (melee.range + this.cfg.player.radius) * TILE;
      const half = Math.acos(melee.arcCosHalf);
      g.moveTo(0, 0)
        .arc(0, 0, reach, angle - half, angle + half)
        .lineTo(0, 0)
        .fill({ color: GOLD.bright, alpha: 0.4 });
    }
    if (e.st & ST_DASHING) {
      g.moveTo(-e.ax * r * 2.4, -e.ay * r * 2.4)
        .lineTo(0, 0)
        .stroke({ width: r, color: 0xffffff, alpha: 0.25 });
    }
    if (e.st & ST_CARRYING) {
      // The sack on their back: a gold diamond trailing opposite the facing,
      // swaying a touch with the gait. Everyone can SEE a carrier — only the
      // amount is squad-private.
      const sway = Math.sin(s.bobPhase) * r * 0.2;
      const bx = -e.ax * r * 1.4 - e.ay * sway;
      const by = -e.ay * r * 1.4 + e.ax * sway;
      const d = r * 0.66;
      g.moveTo(bx, by - d)
        .lineTo(bx + d, by)
        .lineTo(bx, by + d)
        .lineTo(bx - d, by)
        .closePath()
        .fill(GOLD.town)
        .stroke({ width: r * 0.17, color: GOLD.trim });
    }
    if (e.st & ST_BANKING) {
      // Deposit channel in progress — the "interrupt me!" beacon.
      const pulse = 0.55 + 0.35 * Math.sin(performance.now() / 120);
      g.circle(0, 0, r * 1.8).stroke({ width: r * 0.4, color: GOLD.town, alpha: pulse });
    }
    if (e.st & ST_ROOTED) {
      // Snared: jagged shackle at the feet. Public state — a pinned target is
      // an invitation for BOTH sides.
      const rr = r * 1.28;
      for (let i = 0; i < 6; i++) {
        const a0 = (i / 6) * Math.PI * 2;
        const a1 = ((i + 0.5) / 6) * Math.PI * 2;
        g.moveTo(rr * Math.cos(a0), rr * Math.sin(a0))
          .lineTo(rr * 0.6 * Math.cos(a1), rr * 0.6 * Math.sin(a1))
          .stroke({ width: r * 0.33, color: FIRE.ember, alpha: 0.9 });
      }
    }
  }

  private drawHp(s: Sprite, hp: number, cls: ClassId): void {
    const maxHp = getKit(this.cfg, cls).maxHp;
    const frac = Math.max(0, Math.min(1, hp / maxHp));
    s.hpFill.clear();
    const color = frac > 0.55 ? 0x8fae6a : frac > 0.28 ? 0xe0b95e : 0xf05a4d;
    s.hpFill.rect(0, 0, HP_W * frac, 3.5).fill(color);
  }

  /** The bounty writ above the name. Bounty is public info by design — the
   *  tag is the targeting read ("which head pays?"): tier color and a size
   *  that creeps up with the tier, so a Crownmarked purse outshouts the name.
   *  No bounty, no clutter. Re-renders only when the number or tier moves. */
  private drawWrit(s: Sprite, bounty: number): void {
    const tier = bounty > 0 ? bountyTier(this.cfg, bounty) : 0;
    const key = bounty > 0 ? `${bounty}|${tier}` : '';
    if (s.writKey === key) return;
    s.writKey = key;
    s.writTier = tier;
    if (bounty <= 0) {
      s.writ.visible = false;
      return;
    }
    s.writ.text = `★${bounty}`;
    s.writ.style.fontSize = 9 + tier;
    s.writ.style.fontWeight = tier >= 3 ? 'bold' : 'normal';
    s.writ.style.fill = TIER_COLORS[tier]!;
    s.writ.visible = true;
  }

  /** Everything a sprite does each frame, self and remote alike. */
  private present(
    s: Sprite,
    e: { x: number; y: number; ax: number; ay: number; st: number; cls: ClassId },
    ready: boolean,
    now: number,
  ): void {
    this.drawGear(s, e.cls, this.pose(e.st, e.cls), ready);
    this.drawState(s, e);
    // Infamous+ writs smolder — a slow alpha breath (never a shake), the same
    // "interrupt me" language as the banking beacon.
    if (s.writ.visible) {
      s.writ.alpha = s.writTier >= 4 ? 0.74 + 0.26 * Math.sin(now / 280) : 1;
    }
    s.bodyWrap.rotation = Math.atan2(e.ay, e.ax);
    // Damage flash: brief warm tint on the whole sprite.
    s.root.tint = now < s.flashUntil ? 0xffb0a0 : 0xffffff;
    s.root.position.set(e.x * TILE, e.y * TILE);
    const moving = this.bob(s, e.x * TILE, e.y * TILE);
    this.drawFeet(s, moving);
  }

  /** Upsert every visible entity, drop everything no longer visible. */
  sync(
    visible: Map<number, RichEnt>,
    roster: Map<number, RosterEntry>,
    ownId: number,
    own: OwnVisual | null,
    bounties: ReadonlyMap<number, number>,
  ): void {
    const now = performance.now();
    const seen = new Set<number>();
    for (const [id, e] of visible) {
      if (id === ownId) continue; // own entity renders from prediction below
      seen.add(id);
      const entry = roster.get(id);
      const s = this.ensure(id, entry, false);
      this.drawBody(s, e.cls, false, entry?.bot ?? false);
      this.drawHp(s, e.hp, e.cls);
      this.drawWrit(s, bounties.get(id) ?? 0);
      // Squadmates broadcast their load next to their name (escort intel).
      const base = entry?.name ?? `#${id}`;
      const want = e.g !== undefined && e.g > 0 ? `${base} ◆${e.g}` : base;
      if (s.label.text !== want) s.label.text = want;
      // Remote fire gates aren't known — their arrow stays nocked.
      this.present(s, e, true, now);
    }
    if (own) {
      seen.add(ownId);
      const entry = roster.get(ownId);
      const s = this.ensure(ownId, entry, true);
      this.drawBody(s, own.cls, true, false);
      this.drawHp(s, own.hp, own.cls);
      // You wear your own writ too — the price others see is the pressure.
      this.drawWrit(s, bounties.get(ownId) ?? 0);
      this.present(s, own, own.atkReady ?? true, now);
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
