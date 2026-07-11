import { Container, Graphics } from 'pixi.js';
import type { StructSnap } from '@shared/net/messages';
import { STRUCT_GATE, STRUCT_TOWER, STRUCT_TRAP } from '@shared/sim/world';
import { SQUAD_COLORS, TILE } from './scene';

// Structures (M4): squad-colored tiles. Walls read as stone, gates as a
// door (posts + crossbar — YOUR squad walks through its own), towers as a
// round lookout with braces, traps as a low caltrop only your squad ever
// receives (dimmed + dashed ring while still arming). Own pieces bright with
// a bold edge; enemy pieces (only sent once seen) a shade dimmer. Damage dims
// the fill and cracks it. Renders straight from the newest snapshot's visible
// set, exactly like sacks: fog entry/exit is just presence/absence, no lerp.

interface StructSprite {
  g: Graphics;
  hp: number;
  squad: number;
  arming: boolean;
  /** Drawn from ghost memory (M5) — dimmed last-known state, not live wire. */
  ghost: boolean;
}

export class StructureLayer {
  private sprites = new Map<number, StructSprite>();

  constructor(private readonly container: Container) {}

  clear(): void {
    for (const s of this.sprites.values()) s.g.destroy();
    this.sprites.clear();
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
        sp.g.destroy();
        this.sprites.delete(s.i);
      }
      const g = this.draw(s, ownSquad);
      g.position.set(s.tx * TILE, s.ty * TILE);
      // A ghost is a memory: faded, and visually behind whatever is live.
      if (ghost) g.alpha = 0.42;
      this.container.addChild(g);
      this.sprites.set(s.i, { g, hp: s.hp, squad: s.s, arming: s.ar === 1, ghost });
    };
    for (const s of structs) put(s, false);
    for (const s of ghosts) if (!seen.has(s.i)) put(s, true);
    for (const [id, sp] of this.sprites) {
      if (!seen.has(id)) {
        sp.g.destroy();
        this.sprites.delete(id);
      }
    }
  }

  private draw(s: StructSnap, ownSquad: number): Graphics {
    const g = new Graphics();
    const base = SQUAD_COLORS[s.s] ?? 0x8a8a80;
    const own = s.s === ownSquad;
    const frac = Math.max(0, Math.min(1, s.mx > 0 ? s.hp / s.mx : 1));
    const fillAlpha = (own ? 0.85 : 0.7) * (0.4 + 0.6 * frac);

    if (s.k === STRUCT_GATE) {
      // A door: two posts + a crossbar with a visible gap under it. Own gates
      // are literally walkable — the open middle says so.
      g.rect(0.5, 0.5, 3, TILE - 1).fill({ color: base, alpha: fillAlpha });
      g.rect(TILE - 3.5, 0.5, 3, TILE - 1).fill({ color: base, alpha: fillAlpha });
      g.rect(2, 1.5, TILE - 4, 3).fill({ color: base, alpha: fillAlpha });
      g.rect(0.5, 0.5, TILE - 1, TILE - 1).stroke({
        width: own ? 2 : 1.5,
        color: base,
        alpha: 0.95,
      });
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
      return g; // no shared crack overlay — a trap is 1hp, whole or gone
    } else if (s.k === STRUCT_TOWER) {
      // A lookout: round platform + cross braces; a dot for the sentry.
      g.circle(TILE / 2, TILE / 2, TILE / 2 - 1).fill({ color: base, alpha: fillAlpha });
      g.circle(TILE / 2, TILE / 2, TILE / 2 - 1).stroke({
        width: own ? 2 : 1.5,
        color: base,
        alpha: 0.95,
      });
      g.moveTo(2.5, 2.5)
        .lineTo(TILE - 2.5, TILE - 2.5)
        .moveTo(TILE - 2.5, 2.5)
        .lineTo(2.5, TILE - 2.5)
        .stroke({ width: 1, color: 0x14170f, alpha: 0.35 });
      g.circle(TILE / 2, TILE / 2, 1.6).fill({ color: 0x14170f, alpha: 0.7 });
    } else {
      // The wall: stone tile with mortar seams.
      g.rect(1, 1, TILE - 2, TILE - 2).fill({ color: base, alpha: fillAlpha });
      g.rect(0.5, 0.5, TILE - 1, TILE - 1).stroke({
        width: own ? 2 : 1.5,
        color: base,
        alpha: 0.95,
      });
      g.moveTo(2, TILE / 2)
        .lineTo(TILE - 2, TILE / 2)
        .stroke({ width: 1, color: 0x14170f, alpha: 0.4 });
      g.moveTo(TILE / 2, 2)
        .lineTo(TILE / 2, TILE - 2)
        .stroke({ width: 1, color: 0x14170f, alpha: 0.25 });
    }

    // A crack once it's below half — the "one more bomb" tell (any kind).
    if (frac < 0.5) {
      g.moveTo(3, 2)
        .lineTo(TILE - 4, TILE - 3)
        .stroke({ width: 1, color: 0x14170f, alpha: 0.55 });
    }
    return g;
  }
}
