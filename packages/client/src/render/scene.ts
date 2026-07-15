import { Application, Container, Graphics } from 'pixi.js';
import type { MapData } from '@shared/map/types';

// Pixi scene: a world container (scaled TILE px per world unit) holding the
// static map layer and the entity layer, with a camera that follows a point.

export const TILE = 19;

const COLORS = {
  ground: 0x2f3428,
  groundAlt: 0x333929,
  groundDeep: 0x2c3226,
  grass: 0x475639,
  stone: 0x596052,
  forest: 0x22371f,
  forestLit: 0x2e4a28,
  water: 0x1f3a52,
  waterShallow: 0x25425a,
  waterLine: 0x14202e,
  ripple: 0x3d5f7d,
  bridge: 0x7a6544,
  plank: 0x5f4c33,
  rail: 0x4a3a26,
  wall: 0x55554d,
  wallLit: 0x6d6d62,
  wallShade: 0x3a3a34,
  keep: 0xd5aa54,
  town: 0xf2d68c,
};

export const SQUAD_COLORS = [0xf05a4d, 0x5686bf, 0x8fae6a, 0xe0b95e];

export class Scene {
  readonly app: Application;
  readonly world = new Container();
  readonly mapLayer = new Container();
  readonly keepLayer = new Container();
  /** Ground stains (bomb scorch): under structures — the wall stands ON the
   *  scar, and bodies walk over it. */
  readonly decalLayer = new Container();
  readonly structureLayer = new Container();
  readonly sackLayer = new Container();
  readonly entityLayer = new Container();
  readonly projectileLayer = new Container();
  readonly bombLayer = new Container();
  readonly fxLayer = new Container();
  readonly fogLayer = new Container();
  /** ABOVE fog: rumor pings are gossip, not sight — they mark places nobody
   *  can see. Anything vision-gated stays below the fog. */
  readonly pingLayer = new Container();

  private constructor(app: Application) {
    this.app = app;
    // Draw order: terrain, keep markers, WALLS (sit on the ground), ground loot,
    // bodies, arrows over bodies, bombs arc over everything mortal, sparks, fog,
    // then rumor pings over the fog itself.
    this.world.addChild(this.mapLayer);
    this.world.addChild(this.keepLayer);
    this.world.addChild(this.decalLayer);
    this.world.addChild(this.structureLayer);
    this.world.addChild(this.sackLayer);
    this.world.addChild(this.entityLayer);
    this.world.addChild(this.projectileLayer);
    this.world.addChild(this.bombLayer);
    this.world.addChild(this.fxLayer);
    this.world.addChild(this.fogLayer);
    this.world.addChild(this.pingLayer);
    app.stage.addChild(this.world);
  }

  static async create(mount: HTMLElement): Promise<Scene> {
    const app = new Application();
    await app.init({ resizeTo: window, background: 0x14170f, antialias: true });
    mount.appendChild(app.canvas);
    return new Scene(app);
  }

  buildMap(map: MapData, interactRadius = 2.5): void {
    this.mapLayer.removeChildren();
    this.forestG = null;
    const g = new Graphics();
    // Ground: organic mottling, all of it hashed from coords — identical every
    // visit, NEVER world.rng. The per-tile checker read as graph paper (and
    // dated the whole frame); tone now drifts in soft 4×4-block patches with
    // per-tile grain on top.
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const blk = ((((x >> 2) * 2654435761) ^ ((y >> 2) * 40503)) >>> 0) % 3;
        const base = blk === 0 ? COLORS.ground : blk === 1 ? COLORS.groundAlt : COLORS.groundDeep;
        const h = (((x * 73856093) ^ (y * 19349663)) >>> 0) % 5;
        const tinted = h === 0 ? base + 0x030402 : h === 1 ? base - 0x020302 : base;
        g.rect(x * TILE, y * TILE, TILE, TILE).fill(tinted);
      }
    }
    // Terrain predicates (rock wins over water, matching the fill precedence).
    const isRock = (tx: number, ty: number): boolean =>
      tx >= 0 &&
      ty >= 0 &&
      tx < map.width &&
      ty < map.height &&
      map.vision[ty * map.width + tx] === 1;
    const isWater = (tx: number, ty: number): boolean =>
      tx >= 0 &&
      ty >= 0 &&
      tx < map.width &&
      ty < map.height &&
      map.walk[ty * map.width + tx] === 1 &&
      map.vision[ty * map.width + tx] === 0;
    const isForest = (tx: number, ty: number): boolean =>
      tx >= 0 &&
      ty >= 0 &&
      tx < map.width &&
      ty < map.height &&
      map.forest[ty * map.width + tx] === 1 &&
      !isRock(tx, ty) &&
      !isWater(tx, ty);

    // Rock and water, with the same hashed-from-coords determinism as the
    // ground. Rock reads as height: lit top edge, shaded under-edge, the odd
    // crack. Water reads as depth: shallow rim against every bank, deeper
    // interior, per-tile tint, sparse static ripples (the live near-player
    // glints animate on top).
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const h = (((x * 83492791) ^ (y * 297121507)) >>> 0) % 9;
        if (isRock(x, y)) {
          const tint =
            h % 3 === 0 ? COLORS.wall + 0x040404 : h % 3 === 1 ? COLORS.wall - 0x030303 : COLORS.wall;
          g.rect(x * TILE, y * TILE, TILE, TILE).fill(tint);
          if (!isRock(x, y - 1))
            g.rect(x * TILE, y * TILE, TILE, TILE * 0.18).fill({ color: COLORS.wallLit, alpha: 0.9 });
          if (!isRock(x, y + 1))
            g.rect(x * TILE, (y + 0.85) * TILE, TILE, TILE * 0.15).fill({
              color: COLORS.wallShade,
              alpha: 0.9,
            });
          if (h === 4) {
            g.moveTo((x + 0.25) * TILE, (y + 0.3) * TILE)
              .lineTo((x + 0.55) * TILE, (y + 0.7) * TILE)
              .stroke({ width: 1.2, color: COLORS.wallShade, alpha: 0.8 });
          }
          // Dark edge wherever rock meets anything else: tiles fuse into ONE
          // ruin instead of a stack of bricks.
          const rln = { width: 2, color: 0x2e2e2a, alpha: 0.7 };
          if (!isRock(x, y - 1))
            g.moveTo(x * TILE, y * TILE + 1)
              .lineTo((x + 1) * TILE, y * TILE + 1)
              .stroke(rln);
          if (!isRock(x, y + 1))
            g.moveTo(x * TILE, (y + 1) * TILE - 1)
              .lineTo((x + 1) * TILE, (y + 1) * TILE - 1)
              .stroke(rln);
          if (!isRock(x - 1, y))
            g.moveTo(x * TILE + 1, y * TILE)
              .lineTo(x * TILE + 1, (y + 1) * TILE)
              .stroke(rln);
          if (!isRock(x + 1, y))
            g.moveTo((x + 1) * TILE - 1, y * TILE)
              .lineTo((x + 1) * TILE - 1, (y + 1) * TILE)
              .stroke(rln);
        } else if (isWater(x, y)) {
          const shore =
            !isWater(x - 1, y) || !isWater(x + 1, y) || !isWater(x, y - 1) || !isWater(x, y + 1);
          const base = shore ? COLORS.waterShallow : COLORS.water;
          const tinted = h % 3 === 0 ? base + 0x020304 : h % 3 === 1 ? base - 0x010203 : base;
          g.rect(x * TILE, y * TILE, TILE, TILE).fill(tinted);
          if (h === 2) {
            const rx = (x + 0.15 + (h % 5) * 0.08) * TILE;
            const ry = (y + 0.3 + ((x + y) % 4) * 0.12) * TILE;
            g.moveTo(rx, ry)
              .lineTo(rx + TILE * 0.45, ry)
              .stroke({ width: 1.4, color: COLORS.ripple, alpha: 0.35 });
          }
        }
      }
    }

    // Waterline: a dark line hugging every grassy bank — the crisp edge that
    // makes the two water tones read as depth instead of tiles. Cliff faces
    // skip it (rock's own shading is the edge there).
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (!isWater(x, y)) continue;
        const px = x * TILE;
        const py = y * TILE;
        const wln = { width: 2, color: COLORS.waterLine, alpha: 0.65 };
        if (!isWater(x, y - 1) && !isRock(x, y - 1))
          g.moveTo(px, py + 1)
            .lineTo(px + TILE, py + 1)
            .stroke(wln);
        if (!isWater(x, y + 1) && !isRock(x, y + 1))
          g.moveTo(px, py + TILE - 1)
            .lineTo(px + TILE, py + TILE - 1)
            .stroke(wln);
        if (!isWater(x - 1, y) && !isRock(x - 1, y))
          g.moveTo(px + 1, py)
            .lineTo(px + 1, py + TILE)
            .stroke(wln);
        if (!isWater(x + 1, y) && !isRock(x + 1, y))
          g.moveTo(px + TILE - 1, py)
            .lineTo(px + TILE - 1, py + TILE)
            .stroke(wln);
      }
    }

    // Forests draw on their OWN layer so the canopy can breathe (a slow
    // whole-layer alpha sine — zero per-tile redraws). The canopy is hashed
    // overlapping blobs now, not square tiles: shadows fall first (onto the
    // ground and water the canopy overhangs), then the crowns, then dappled
    // highlight tops.
    const forestG = new Graphics();
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (!isForest(x, y)) continue;
        if (!(isForest(x - 1, y) && isForest(x + 1, y) && isForest(x, y - 1) && isForest(x, y + 1))) {
          forestG
            .circle((x + 0.36) * TILE, (y + 0.68) * TILE, TILE * 0.62)
            .fill({ color: 0x000000, alpha: 0.12 });
        }
      }
    }
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (!isForest(x, y)) continue;
        const h = (((x * 265443577) ^ (y * 97531)) >>> 0) % 12;
        const jx = ((h % 5) / 5 - 0.4) * 0.24;
        const jy = ((h % 7) / 7 - 0.43) * 0.24;
        // Big enough that neighbors always merge — the wood is one canopy with
        // scalloped edges, not a punch card of trees.
        forestG
          .circle((x + 0.5 + jx) * TILE, (y + 0.5 + jy) * TILE, TILE * (0.72 + (h % 4) * 0.07))
          .fill(COLORS.forest);
      }
    }
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (!isForest(x, y)) continue;
        const h = (((x * 265443577) ^ (y * 97531)) >>> 0) % 12;
        // Sparse, jittered crown highlights — a dappled canopy, no grid.
        if (h % 4 !== 1) continue;
        forestG
          .circle(
            (x + 0.5 + ((h % 5) - 2) * 0.09) * TILE,
            (y + 0.38 - (h % 3) * 0.06) * TILE,
            TILE * (0.28 + (h % 3) * 0.05),
          )
          .fill({ color: COLORS.forestLit, alpha: 0.45 });
      }
    }
    // Ground detail: soft dapples blur the last of the tile grid, grass tufts
    // and pebbles give the fields texture. Never on water or walls; tufts and
    // stones skip the forest floor (they'd hide under canopy anyway).
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = y * map.width + x;
        if (map.walk[i] === 1 || map.vision[i] === 1) continue;
        const h = (((x * 40503) ^ (y * 73856093)) >>> 0) % 977;
        if (h % 11 === 3) {
          const ox = ((h % 7) / 7 - 0.5) * 0.8;
          const oy = ((h % 5) / 5 - 0.5) * 0.8;
          g.circle((x + 0.5 + ox) * TILE, (y + 0.5 + oy) * TILE, TILE * (0.35 + (h % 3) * 0.12)).fill(
            { color: h % 2 === 0 ? 0x000000 : 0x4a5238, alpha: 0.05 },
          );
        }
        if (map.forest[i] === 1) continue;
        if (h % 13 === 5) {
          const bx = (x + 0.2 + (h % 6) * 0.1) * TILE;
          const by = (y + 0.25 + (h % 8) * 0.08) * TILE;
          const l = TILE * (0.14 + (h % 3) * 0.04);
          const blade = { width: 1.1, color: COLORS.grass, alpha: 0.75 };
          g.moveTo(bx, by)
            .lineTo(bx - l * 0.5, by - l)
            .stroke(blade);
          g.moveTo(bx, by)
            .lineTo(bx, by - l * 1.25)
            .stroke(blade);
          g.moveTo(bx, by)
            .lineTo(bx + l * 0.55, by - l * 0.9)
            .stroke(blade);
        }
        if (h % 37 === 11) {
          const sx = (x + 0.3 + (h % 5) * 0.1) * TILE;
          const sy = (y + 0.4 + (h % 3) * 0.12) * TILE;
          g.circle(sx, sy, TILE * 0.09).fill({ color: COLORS.stone, alpha: 0.9 });
          g.circle(sx + 0.6, sy + 0.8, TILE * 0.09).stroke({
            width: 0.8,
            color: 0x2c2f28,
            alpha: 0.4,
          });
        }
      }
    }

    // Bridges: walkable tiles surrounded by water read as planks.
    // (The parser doesn't export them separately; infer from the ASCII '=' being
    // walkable while orthogonal water sits beside it — cheap visual pass.)
    for (let y = 1; y < map.height - 1; y++) {
      for (let x = 1; x < map.width - 1; x++) {
        const i = y * map.width + x;
        if (map.walk[i] === 1) continue;
        const left = map.walk[i - 1] === 1 && map.vision[i - 1] === 0;
        const right = map.walk[i + 1] === 1 && map.vision[i + 1] === 0;
        const up = map.walk[i - map.width] === 1 && map.vision[i - map.width] === 0;
        const down = map.walk[i + map.width] === 1 && map.vision[i + map.width] === 0;
        if ((left && right) || (up && down)) {
          const px = x * TILE;
          const py = y * TILE;
          g.rect(px, py, TILE, TILE).fill(COLORS.bridge);
          const seam = { width: 1.2, color: COLORS.plank, alpha: 0.8 };
          const rail = { width: 2, color: COLORS.rail, alpha: 0.9 };
          if (left && right) {
            // Water flanks east–west: traffic runs vertically, planks lie
            // across it, rails guard the water sides.
            for (let k = 1; k <= 3; k++) {
              const ly = py + (TILE * k) / 4;
              g.moveTo(px + 1.5, ly)
                .lineTo(px + TILE - 1.5, ly)
                .stroke(seam);
            }
            g.moveTo(px + 1, py)
              .lineTo(px + 1, py + TILE)
              .stroke(rail);
            g.moveTo(px + TILE - 1, py)
              .lineTo(px + TILE - 1, py + TILE)
              .stroke(rail);
          } else {
            for (let k = 1; k <= 3; k++) {
              const lx = px + (TILE * k) / 4;
              g.moveTo(lx, py + 1.5)
                .lineTo(lx, py + TILE - 1.5)
                .stroke(seam);
            }
            g.moveTo(px, py + 1)
              .lineTo(px + TILE, py + 1)
              .stroke(rail);
            g.moveTo(px, py + TILE - 1)
              .lineTo(px + TILE, py + TILE - 1)
              .stroke(rail);
          }
        }
      }
    }
    this.mapLayer.addChild(g);
    this.mapLayer.addChild(forestG);
    this.forestG = forestG;

    // POI markers. Rings on towns trace the ACTUAL interact radius — "stand
    // inside the gold circle" is the whole banking tutorial. LIVE squad keeps
    // render in KeepLayer (dynamic hp/position as of M3); the static map only
    // marks unclaimed SITES faintly (rebuild spots).
    const poi = new Graphics();
    for (const k of map.keeps) {
      poi
        .circle(k.x * TILE, k.y * TILE, interactRadius * TILE * 0.55)
        .stroke({ width: 1.5, color: COLORS.keep, alpha: 0.22 });
    }
    for (const t of map.towns) {
      // A bank: gold square vault + coin dot, inside its interact circle.
      // (Sized off TILE — these were designed at 12px/tile and stayed there.)
      const vw = TILE * 0.58;
      poi.rect(t.x * TILE - vw / 2, t.y * TILE - vw / 2, vw, vw).fill(COLORS.town);
      poi
        .rect(t.x * TILE - vw / 2, t.y * TILE - vw / 2, vw, vw)
        .stroke({ width: 2, color: 0x7a6544 });
      poi.circle(t.x * TILE, t.y * TILE, TILE * 0.16).fill(0x7a6544);
      poi
        .circle(t.x * TILE, t.y * TILE, interactRadius * TILE)
        .stroke({ width: 2.5, color: COLORS.town, alpha: 0.75 });
    }
    map.spawns.forEach((s, squad) => {
      poi
        .circle(s.x * TILE, s.y * TILE, TILE)
        .stroke({ width: 2, color: SQUAD_COLORS[squad]!, alpha: 0.7 });
    });
    this.mapLayer.addChild(poi);
  }

  private forestG: Graphics | null = null;

  /** The canopy breathes (M6 s4); call per frame. */
  forestBreath(nowMs: number, base: number, amp: number, periodMs: number): void {
    if (this.forestG) {
      this.forestG.alpha = base + amp * Math.sin((nowMs / periodMs) * Math.PI * 2);
    }
  }

  follow(x: number, y: number): void {
    this.world.position.set(
      this.app.renderer.width / 2 - x * TILE,
      this.app.renderer.height / 2 - y * TILE,
    );
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.world.position.x) / TILE,
      y: (sy - this.world.position.y) / TILE,
    };
  }
}
