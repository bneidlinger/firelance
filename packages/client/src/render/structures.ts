import { Container, Graphics } from 'pixi.js';
import type { StructSnap } from '@shared/net/messages';
import { SQUAD_COLORS, TILE } from './scene';

// Walls (M4 s1): squad-colored stone tiles. Own walls read bright with a bold
// edge; enemy walls (only sent once you've seen them) sit a shade dimmer.
// Damage darkens the fill and cracks it — a wall about to fall looks it.
// Renders straight from the newest snapshot's visible set, exactly like sacks:
// fog entry/exit is just presence/absence, no lerp.

interface StructSprite {
  g: Graphics;
  hp: number;
  squad: number;
}

export class StructureLayer {
  private sprites = new Map<number, StructSprite>();

  constructor(private readonly container: Container) {}

  clear(): void {
    for (const s of this.sprites.values()) s.g.destroy();
    this.sprites.clear();
  }

  sync(structs: StructSnap[], ownSquad: number): void {
    const seen = new Set<number>();
    for (const s of structs) {
      seen.add(s.i);
      let sp = this.sprites.get(s.i);
      // Redraw on hp change (damage tint) or owner change; else leave it be.
      if (sp && sp.hp === s.hp && sp.squad === s.s) continue;
      if (sp) {
        sp.g.destroy();
        this.sprites.delete(s.i);
      }
      const g = this.draw(s, ownSquad);
      g.position.set(s.tx * TILE, s.ty * TILE);
      this.container.addChild(g);
      this.sprites.set(s.i, { g, hp: s.hp, squad: s.s });
    }
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
    // Fill dims as the wall takes damage; enemy walls a touch fainter than own.
    g.rect(1, 1, TILE - 2, TILE - 2).fill({
      color: base,
      alpha: (own ? 0.85 : 0.7) * (0.4 + 0.6 * frac),
    });
    g.rect(0.5, 0.5, TILE - 1, TILE - 1).stroke({ width: own ? 2 : 1.5, color: base, alpha: 0.95 });
    // Mortar seams so it reads as stone, not a floor tile.
    g.moveTo(2, TILE / 2)
      .lineTo(TILE - 2, TILE / 2)
      .stroke({ width: 1, color: 0x14170f, alpha: 0.4 });
    g.moveTo(TILE / 2, 2)
      .lineTo(TILE / 2, TILE - 2)
      .stroke({ width: 1, color: 0x14170f, alpha: 0.25 });
    // A crack once it's below half — the "one more bomb" tell.
    if (frac < 0.5) {
      g.moveTo(3, 2)
        .lineTo(TILE - 4, TILE - 3)
        .stroke({ width: 1, color: 0x14170f, alpha: 0.55 });
    }
    return g;
  }
}
