import { Container, Graphics } from 'pixi.js';
import type { StructSnap } from '@shared/net/messages';
import { STRUCT_GATE, STRUCT_HUT, STRUCT_TOWER, STRUCT_TRAP, STRUCT_TREE } from '@shared/sim/world';
import { FX } from '../fx/config';
import { ARMORY, INK, KHAKI, mix, PROPS, SQUAD_COLORS, TERRAIN } from './palette';
import { drawPennant } from './pennant';
import { TILE } from './scene';

// Structures (M4 → G3): architecture with mass. Walls are stone COURSES that
// belong to a squad — a stone body tinted toward the squad hue under a bold
// squad edge, merlon notches along the cap — instead of squad plastic. Gates
// hang timber doors between their posts (YOUR squad's sit ajar: the walkable
// read, louder than a gap). Towers get height — an offset platform over a
// darker base — and fly the shared mini-pennant. Damage plays in three acts
// at the familiar thresholds: hairline crack → crack web + edge chips →
// gap-toothed silhouette + dust. Traps and every fog/friend-or-foe rule are
// untouched. Renders straight from the newest snapshot's visible set; fog
// entry/exit is presence/absence, no lerp. Grounded (G1) under the codex
// sun; every shape hash is from tile coords — same ruin for every client.

interface StructSprite {
  g: Graphics;
  hp: number;
  squad: number;
  arming: boolean;
  /** Drawn from ghost memory (M5) — dimmed last-known state, not live wire. */
  ghost: boolean;
  /** Live towers only: the mini pennant, redrawn per frame. */
  flag: Graphics | null;
}

export class StructureLayer {
  private sprites = new Map<number, StructSprite>();

  constructor(
    private readonly container: Container,
    /** Fired when a LIVE piece's hp drops between snapshots (M6 s2): there is
     *  no per-hit structure event on the wire — the snapshot diff IS the hit
     *  detector, so chip dust costs zero protocol. */
    private readonly onChip?: (x: number, y: number) => void,
  ) {}

  clear(): void {
    for (const s of this.sprites.values()) s.g.destroy({ children: true });
    this.sprites.clear();
  }

  /** Per frame: wave the tower pennants (G3). Ghost towers stay bare — a
   *  waving flag would read as live intel. */
  frame(nowMs: number): void {
    for (const [id, sp] of this.sprites) {
      if (!sp.flag) continue;
      sp.flag.clear();
      drawPennant(
        sp.flag,
        8,
        6.5,
        SQUAD_COLORS[sp.squad] ?? PROPS.neutral,
        nowMs / 260 + id * 0.73,
        0.62,
      );
    }
  }

  sync(structs: StructSnap[], ownSquad: number, ghosts: StructSnap[] = []): void {
    const seen = new Set<number>();
    const put = (s: StructSnap, ghost: boolean): void => {
      seen.add(s.i);
      const sp = this.sprites.get(s.i);
      // Redraw on hp change (damage tint), owner change, a trap arming, or a
      // live piece fading into memory (and back).
      if (
        sp &&
        sp.hp === s.hp &&
        sp.squad === s.s &&
        sp.arming === (s.ar === 1) &&
        sp.ghost === ghost
      ) {
        return;
      }
      if (sp) {
        if (!ghost && !sp.ghost && s.hp < sp.hp) this.onChip?.(s.tx + 0.5, s.ty + 0.5);
        sp.g.destroy({ children: true });
        this.sprites.delete(s.i);
      }
      const g = this.draw(s, ownSquad);
      g.position.set(s.tx * TILE, s.ty * TILE);
      // A ghost is a memory: faded, and visually behind whatever is live.
      if (ghost) g.alpha = 0.42;
      let flag: Graphics | null = null;
      if (s.k === STRUCT_TOWER && !ghost) {
        flag = new Graphics();
        flag.position.set(TILE / 2 - 0.9, TILE / 2 - 1.1);
        g.addChild(flag);
      }
      this.container.addChild(g);
      this.sprites.set(s.i, { g, hp: s.hp, squad: s.s, arming: s.ar === 1, ghost, flag });
    };
    for (const s of structs) put(s, false);
    for (const s of ghosts) if (!seen.has(s.i)) put(s, true);
    for (const [id, sp] of this.sprites) {
      if (!seen.has(id)) {
        sp.g.destroy({ children: true });
        this.sprites.delete(id);
      }
    }
  }

  private draw(s: StructSnap, ownSquad: number): Graphics {
    const g = new Graphics();
    const base = SQUAD_COLORS[s.s] ?? PROPS.neutral;
    const own = s.s === ownSquad;
    const frac = Math.max(0, Math.min(1, s.mx > 0 ? s.hp / s.mx : 1));
    const fillAlpha = (own ? 0.85 : 0.7) * (0.4 + 0.6 * frac);
    const h = ((s.tx * 73856093) ^ (s.ty * 19349663)) >>> 0;
    // Masonry that belongs to a squad: stone, leaning toward the banner.
    const stone = mix(TERRAIN.rock, base, FX.architecture.squadTint);

    if (s.k === STRUCT_GATE) {
      // Stone posts + lintel; timber doors hang between them. Own gates sit
      // AJAR — literally walkable, and now it looks it. Enemy doors close.
      g.rect(0.5, 0.5, 3, TILE - 1).fill({ color: stone, alpha: fillAlpha });
      g.rect(TILE - 3.5, 0.5, 3, TILE - 1).fill({ color: stone, alpha: fillAlpha });
      g.rect(2, 1.5, TILE - 4, 3).fill({ color: stone, alpha: fillAlpha });
      g.rect(0.5, 0.5, TILE - 1, TILE - 1).stroke({
        width: own ? 2 : 1.5,
        color: base,
        alpha: 0.95,
      });
      const c = TILE / 2;
      if (own) {
        g.poly([4, c + 2.6, 4, c - 2.6, 8.6, c - 6.2, 8.6, c - 1]).fill({
          color: TERRAIN.bridge,
          alpha: 0.95,
        });
        g.poly([4, c + 2.6, 4, c - 2.6, 8.6, c - 6.2, 8.6, c - 1]).stroke({
          width: 0.8,
          color: INK,
          alpha: 0.8,
        });
        g.poly([TILE - 4, c + 2.6, TILE - 4, c - 2.6, TILE - 8.6, c - 6.2, TILE - 8.6, c - 1]).fill(
          { color: TERRAIN.bridge, alpha: 0.95 },
        );
        g.poly([
          TILE - 4,
          c + 2.6,
          TILE - 4,
          c - 2.6,
          TILE - 8.6,
          c - 6.2,
          TILE - 8.6,
          c - 1,
        ]).stroke({ width: 0.8, color: INK, alpha: 0.8 });
      } else {
        g.rect(3.8, c - 2.6, TILE - 7.6, 5.2).fill({ color: TERRAIN.plank, alpha: 0.95 });
        g.rect(3.8, c - 2.6, TILE - 7.6, 5.2).stroke({ width: 0.9, color: INK, alpha: 0.85 });
        g.moveTo(c - 3.2, c - 2.2)
          .lineTo(c - 3.2, c + 2.2)
          .moveTo(c + 3.2, c - 2.2)
          .lineTo(c + 3.2, c + 2.2)
          .stroke({ width: 1.2, color: ARMORY.STEEL_DARK, alpha: 0.95 });
        g.moveTo(c, c - 2.4)
          .lineTo(c, c + 2.4)
          .stroke({ width: 0.8, color: INK, alpha: 0.7 });
      }
      g.circle(4.1, c + 2, 0.8).fill(ARMORY.STEEL_DARK);
      g.circle(TILE - 4.1, c + 2, 0.8).fill(ARMORY.STEEL_DARK);
      g.moveTo(1, 1.6)
        .lineTo(TILE - 1, 1.6)
        .stroke({ width: 1.2, color: 0xffffff, alpha: FX.grounding.edgeLitAlpha });
      g.moveTo(1, TILE - 1.6)
        .lineTo(TILE - 1, TILE - 1.6)
        .stroke({ width: 1.2, color: INK, alpha: FX.grounding.edgeShadeAlpha });
      this.acts(g, frac, h);
    } else if (s.k === STRUCT_TRAP) {
      // A caltrop lying flat: X of spikes + a hub. Deliberately small and
      // ground-hugging — the server only ever sends it to the owning squad
      // (and spectators), so this is squad-private HUD, not world geometry.
      const c = TILE / 2;
      const armed = s.ar !== 1;
      const a = armed ? 0.9 : 0.45;
      g.moveTo(c - 4, c - 4)
        .lineTo(c + 4, c + 4)
        .moveTo(c + 4, c - 4)
        .lineTo(c - 4, c + 4)
        .stroke({ width: 2, color: base, alpha: a });
      g.circle(c, c, 1.8).fill({ color: base, alpha: a });
      if (!armed) {
        // Arming: a dashed ring reads as "not live yet" at a glance.
        const r = 6.5;
        for (let i = 0; i < 8; i += 2) {
          const a0 = (i / 8) * Math.PI * 2;
          const a1 = ((i + 1) / 8) * Math.PI * 2;
          g.moveTo(c + r * Math.cos(a0), c + r * Math.sin(a0))
            .arc(c, c, r, a0, a1)
            .stroke({ width: 1, color: base, alpha: 0.6 });
        }
      }
      return g; // no shared damage acts — a trap is 1hp, whole or gone
    } else if (s.k === STRUCT_TREE) {
      // A lone oak: shadow, trunk, crown. The crown thins as it takes damage —
      // the chopping is visible from across a field. Nobody owns an oak, so
      // no squad edge and no damage acts (its read is the crown itself).
      const c = TILE / 2;
      g.ellipse(c + TILE * 0.14, c + TILE * 0.22, TILE * 0.36, TILE * 0.21).fill({
        color: 0x000000,
        alpha: FX.grounding.shadowAlpha,
      });
      g.circle(c, c, TILE * 0.16).fill(PROPS.trunk);
      const crownR = TILE * (0.26 + 0.26 * frac);
      g.circle(c - TILE * 0.1, c - TILE * 0.08, crownR).fill({ color: PROPS.oak, alpha: 0.95 });
      g.circle(c + TILE * 0.12, c + TILE * 0.04, crownR * 0.8).fill({
        color: PROPS.oak,
        alpha: 0.95,
      });
      g.circle(c - TILE * 0.06, c - TILE * 0.14, crownR * 0.7).fill({
        color: PROPS.oakLit,
        alpha: 0.9,
      });
      return g;
    } else if (s.k === STRUCT_HUT) {
      // A cottage: mud walls under a thatch roof, a stone chimney for the
      // smoke to rise from. Shares the damage acts — "one more bomb" reads
      // on architecture of any owner.
      g.ellipse(TILE / 2 + 1.5, TILE - 1.5, TILE * 0.52, TILE * 0.16).fill({
        color: 0x000000,
        alpha: FX.grounding.shadowAlpha,
      });
      g.rect(1.5, 2, TILE - 3, TILE - 4).fill({ color: PROPS.hutWall, alpha: 0.95 });
      g.rect(1.5, 2, TILE - 3, TILE - 4).stroke({ width: 1.2, color: PROPS.hutEdge, alpha: 0.9 });
      g.rect(0.5, TILE * 0.3, TILE - 1, TILE * 0.42).fill({ color: PROPS.thatch, alpha: 0.95 });
      // NW sun: the eave catches light above the ridge, the footing sits in ink.
      g.moveTo(1, TILE * 0.33)
        .lineTo(TILE - 1, TILE * 0.33)
        .stroke({ width: 1.1, color: 0xffffff, alpha: FX.grounding.edgeLitAlpha });
      g.moveTo(1, TILE / 2)
        .lineTo(TILE - 1, TILE / 2)
        .stroke({ width: 1.4, color: PROPS.thatchRidge, alpha: 0.9 });
      g.rect(TILE * 0.62, TILE * 0.3 - 2.4, 3, 3.6).fill(TERRAIN.rockShade);
      g.rect(TILE * 0.62, TILE * 0.3 - 2.4, 3, 3.6).stroke({ width: 0.7, color: INK, alpha: 0.7 });
      g.moveTo(TILE * 0.62, TILE * 0.3 - 2.1)
        .lineTo(TILE * 0.62 + 3, TILE * 0.3 - 2.1)
        .stroke({ width: 0.8, color: 0xffffff, alpha: FX.grounding.edgeLitAlpha });
      g.moveTo(2, TILE - 2.4)
        .lineTo(TILE - 2, TILE - 2.4)
        .stroke({ width: 1.2, color: INK, alpha: FX.grounding.edgeShadeAlpha });
      this.acts(g, frac, h);
    } else if (s.k === STRUCT_TOWER) {
      // A lookout with height: darker base circle under an up-left offset
      // platform (parallax on the cheap), parapet notches, braces, sentry —
      // and the squad's mini-pennant on the wind (added as a child in sync).
      const c = TILE / 2;
      const R = TILE / 2 - 1;
      g.ellipse(c + 2.2, c + 2.8, TILE * 0.54, TILE * 0.34).fill({
        color: 0x000000,
        alpha: FX.grounding.shadowAlpha,
      });
      g.circle(c + 1.1, c + 1.4, R).fill({
        color: mix(TERRAIN.rockShade, base, 0.15),
        alpha: fillAlpha,
      });
      const px = c - 0.9;
      const py = c - 1.1;
      g.circle(px, py, R - 1).fill({ color: stone, alpha: fillAlpha });
      g.circle(px, py, R - 1).stroke({ width: own ? 2 : 1.5, color: base, alpha: 0.95 });
      // moveTo first — arc() chains onto the open path (connector-line bug).
      const ta0 = -Math.PI * 0.95;
      const tr = R - 2.8;
      g.moveTo(px + Math.cos(ta0) * tr, py + Math.sin(ta0) * tr)
        .arc(px, py, tr, ta0, -Math.PI * 0.4)
        .stroke({ width: 1.2, color: 0xffffff, alpha: FX.grounding.edgeLitAlpha });
      for (let i = 0; i < 4; i++) {
        const pa = (i / 4) * Math.PI * 2 + Math.PI / 4;
        g.circle(px + Math.cos(pa) * (R - 1.6), py + Math.sin(pa) * (R - 1.6), 0.9).fill({
          color: INK,
          alpha: 0.4,
        });
      }
      g.moveTo(px - (R - 3.4), py - (R - 3.4))
        .lineTo(px + (R - 3.4), py + (R - 3.4))
        .moveTo(px + (R - 3.4), py - (R - 3.4))
        .lineTo(px - (R - 3.4), py + (R - 3.4))
        .stroke({ width: 1, color: INK, alpha: 0.35 });
      g.circle(px, py, 1.6).fill({ color: INK, alpha: 0.7 });
      this.acts(g, frac, h);
    } else {
      // The wall: coursed stone under the squad's cap. Seams hash-offset per
      // tile so a run reads as masonry, not wallpaper.
      g.rect(1, 1, TILE - 2, TILE - 2).fill({ color: stone, alpha: fillAlpha });
      g.rect(0.5, 0.5, TILE - 1, TILE - 1).stroke({
        width: own ? 2 : 1.5,
        color: base,
        alpha: 0.95,
      });
      const y1 = 6 + (h % 3);
      const y2 = 12 + ((h >> 3) % 3);
      g.moveTo(2, y1)
        .lineTo(TILE - 2, y1)
        .moveTo(2, y2)
        .lineTo(TILE - 2, y2)
        .stroke({ width: 1, color: INK, alpha: 0.4 });
      // Brick bond: one joint per course, offset so they never align.
      g.moveTo(4 + (h % 6), 2.2)
        .lineTo(4 + (h % 6), y1)
        .moveTo(12 - ((h >> 2) % 5), y1)
        .lineTo(12 - ((h >> 2) % 5), y2)
        .moveTo(5 + ((h >> 4) % 7), y2)
        .lineTo(5 + ((h >> 4) % 7), TILE - 2.2)
        .stroke({ width: 1, color: INK, alpha: 0.3 });
      // Merlon notches under the lit cap — the wall silhouette.
      for (const mx of [3.4, TILE / 2 - 1, TILE - 5.4]) {
        g.rect(mx + (h % 2), 2.6, 2, 1.7).fill({ color: INK, alpha: 0.35 });
      }
      g.moveTo(1.5, 2)
        .lineTo(TILE - 1.5, 2)
        .stroke({ width: 1.2, color: 0xffffff, alpha: FX.grounding.edgeLitAlpha });
      g.moveTo(1.5, TILE - 2)
        .lineTo(TILE - 1.5, TILE - 2)
        .stroke({ width: 1.2, color: INK, alpha: FX.grounding.edgeShadeAlpha });
      this.acts(g, frac, h);
    }

    return g;
  }

  /** Damage in three acts, shared by every architecture kind: a hairline,
   *  then a web with chipped edges, then bites out of the silhouette with
   *  dust at the footing. Hash varies the geometry per tile. */
  private acts(g: Graphics, frac: number, h: number): void {
    if (frac >= 0.75) return;
    const c = TILE / 2;
    if (h % 2 === 0) {
      g.moveTo(3, 2.5)
        .lineTo(c - 1, c - 2)
        .lineTo(c - 4, c + 3)
        .stroke({ width: 1, color: INK, alpha: 0.6 });
    } else {
      g.moveTo(TILE - 3.5, 3)
        .lineTo(c + 1, c)
        .lineTo(c + 4, TILE - 4)
        .stroke({ width: 1, color: INK, alpha: 0.6 });
    }
    if (frac >= 0.5) return;
    g.moveTo(c - 1, c - 2)
      .lineTo(c + 4, c - 5)
      .moveTo(c - 1, c - 2)
      .lineTo(c + 3, c + 1)
      .stroke({ width: 1, color: INK, alpha: 0.55 });
    g.rect((h % 5) + 2, 0.6, 3, 1.6).fill({ color: INK, alpha: 0.5 });
    g.rect(TILE - 2.2, ((h >> 2) % 6) + 3, 1.6, 3).fill({ color: INK, alpha: 0.5 });
    if (frac >= 0.25) return;
    g.poly([5 + (h % 4), 1, 9 + (h % 4), 1, 7.5 + (h % 4), 4.5]).fill({ color: INK, alpha: 0.7 });
    g.poly([TILE - 1, 6, TILE - 1, 10, TILE - 4.5, 8]).fill({ color: INK, alpha: 0.65 });
    g.circle(3 + (h % 3), TILE - 2.5, 0.8).fill({ color: KHAKI, alpha: 0.5 });
    g.circle(c, TILE - 1.8, 0.7).fill({ color: KHAKI, alpha: 0.45 });
    g.circle(TILE - 4, TILE - 2.8, 0.6).fill({ color: KHAKI, alpha: 0.4 });
  }
}
