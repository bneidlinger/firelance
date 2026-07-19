import { Application, Container, Graphics } from 'pixi.js';
import type { MapData } from '@shared/map/types';
import { FX } from '../fx/config';
import { GOLD, INK, SQUAD_COLORS, TERRAIN as COLORS } from './palette';

// Pixi scene: a world container (scaled TILE px per world unit) holding the
// static map layer and the entity layer, with a camera that follows a point.
// Colors live in the codex (render/palette.ts); the bake obeys the codex sun
// (NW — lit edges up-left, shadows fall south-east).

// 12 → 15 → 19 → 23: each step by playtest feel (this one Brandon's call
// after real playtime — "another 20% closer"). Character linework is
// radius-relative and terrain is TILE-relative; the handful of px-composed
// details (castle hall, bank) scale via S = TILE / 19 at their sites.
export const TILE = 23;

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
    await app.init({ resizeTo: window, background: INK, antialias: true });
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

    // --- G5: the bridge ledger, scouted before anything paints — the plank
    // pass draws from it and the roads route through it.
    const bridges: Array<{ x: number; y: number; horiz: boolean }> = [];
    for (let y = 1; y < map.height - 1; y++) {
      for (let x = 1; x < map.width - 1; x++) {
        const i = y * map.width + x;
        if (map.walk[i] === 1) continue;
        const left = map.walk[i - 1] === 1 && map.vision[i - 1] === 0;
        const right = map.walk[i + 1] === 1 && map.vision[i + 1] === 0;
        const up = map.walk[i - map.width] === 1 && map.vision[i - map.width] === 0;
        const down = map.walk[i + map.width] === 1 && map.vision[i + map.width] === 0;
        if ((left && right) || (up && down)) bridges.push({ x, y, horiz: left && right });
      }
    }

    // --- G5: dirt roads — the worked land. Towns link to each other and to
    // nearby keep sites, detouring over bridges when a straight line would
    // ford the river; water and rock refuse the paint outright. PURELY
    // visual — no walk or speed meaning, and the sim never sees them.
    const blockedAt = (tx: number, ty: number): boolean =>
      tx < 0 ||
      ty < 0 ||
      tx >= map.width ||
      ty >= map.height ||
      map.walk[ty * map.width + tx] === 1;
    const isBridgeTile = (tx: number, ty: number): boolean =>
      bridges.some((b) => b.x === tx && b.y === ty);
    const segClear = (ax: number, ay: number, bx: number, by: number): boolean => {
      const len = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(2, Math.ceil(len / 0.4));
      for (let s = 0; s <= steps; s++) {
        const tx = Math.floor(ax + ((bx - ax) * s) / steps);
        const ty = Math.floor(ay + ((by - ay) * s) / steps);
        if (blockedAt(tx, ty) && !isBridgeTile(tx, ty)) return false;
      }
      return true;
    };
    const routes: Array<Array<{ x: number; y: number }>> = [];
    const addRoute = (a: { x: number; y: number }, b: { x: number; y: number }): void => {
      if (segClear(a.x, a.y, b.x, b.y)) {
        routes.push([a, b]);
        return;
      }
      let best: { x: number; y: number } | null = null;
      let bestLen = Infinity;
      for (const br of bridges) {
        const w = { x: br.x + 0.5, y: br.y + 0.5 };
        if (segClear(a.x, a.y, w.x, w.y) && segClear(w.x, w.y, b.x, b.y)) {
          const l = Math.hypot(w.x - a.x, w.y - a.y) + Math.hypot(b.x - w.x, b.y - w.y);
          if (l < bestLen) {
            bestLen = l;
            best = w;
          }
        }
      }
      if (best) routes.push([a, best, b]);
    };
    for (let i = 0; i < map.towns.length; i++)
      for (let j = i + 1; j < map.towns.length; j++) addRoute(map.towns[i]!, map.towns[j]!);
    // Site spurs: the vale is big (corner sites sit ~55u from a town), so
    // allow long spurs but pave only the four shortest — a worked land, not
    // a road web.
    const spurs: Array<{
      k: { x: number; y: number };
      t: { x: number; y: number };
      d: number;
    }> = [];
    for (const k of map.keeps) {
      let nearest: { x: number; y: number } | null = null;
      let nd = Infinity;
      for (const t of map.towns) {
        const d = Math.hypot(t.x - k.x, t.y - k.y);
        if (d < nd) {
          nd = d;
          nearest = t;
        }
      }
      if (nearest && nd < 58) spurs.push({ k, t: nearest, d: nd });
    }
    spurs.sort((a, b) => a.d - b.d);
    for (const s of spurs.slice(0, 4)) addRoute(s.k, s.t);
    let rseg = 0;
    for (const route of routes) {
      for (let v = 0; v + 1 < route.length; v++) {
        const a = route[v]!;
        const b = route[v + 1]!;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1) continue;
        rseg++;
        const steps = Math.ceil(len / 0.3);
        for (let s = 0; s <= steps; s++) {
          const h = (((s * 73856093) ^ (rseg * 19349663)) >>> 0) % 997;
          const t = s / steps;
          const wx = a.x + (b.x - a.x) * t + ((h % 7) / 7 - 0.5) * 0.5;
          const wy = a.y + (b.y - a.y) * t + (((h >> 3) % 7) / 7 - 0.5) * 0.5;
          if (blockedAt(Math.floor(wx), Math.floor(wy))) continue;
          g.circle(wx * TILE, wy * TILE, TILE * (0.26 + ((h >> 5) % 4) * 0.03)).fill({
            color: h % 3 === 0 ? COLORS.roadWorn : COLORS.road,
            alpha: 0.4,
          });
        }
        // Wheel ruts: sparse paired dashes along the direction of travel.
        const ux = (b.x - a.x) / len;
        const uy = (b.y - a.y) / len;
        for (let d = 1.2; d < len - 1; d += 2.6) {
          const h = ((Math.round(d * 41) * 40503) ^ (rseg * 97531)) >>> 0;
          if (h % 3 === 0) continue;
          const cx0 = a.x + ux * d;
          const cy0 = a.y + uy * d;
          if (blockedAt(Math.floor(cx0), Math.floor(cy0))) continue;
          for (const side of [-1, 1]) {
            const ox = -uy * 0.14 * side;
            const oy = ux * 0.14 * side;
            g.moveTo((cx0 + ox - ux * 0.32) * TILE, (cy0 + oy - uy * 0.32) * TILE)
              .lineTo((cx0 + ox + ux * 0.32) * TILE, (cy0 + oy + uy * 0.32) * TILE)
              .stroke({ width: 1.3, color: COLORS.rail, alpha: 0.3 });
          }
        }
      }
    }

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
            h % 3 === 0 ? COLORS.rock + 0x040404 : h % 3 === 1 ? COLORS.rock - 0x030303 : COLORS.rock;
          g.rect(x * TILE, y * TILE, TILE, TILE).fill(tint);
          if (!isRock(x, y - 1))
            g.rect(x * TILE, y * TILE, TILE, TILE * 0.18).fill({ color: COLORS.rockLit, alpha: 0.9 });
          if (!isRock(x, y + 1))
            g.rect(x * TILE, (y + 0.85) * TILE, TILE, TILE * 0.15).fill({
              color: COLORS.rockShade,
              alpha: 0.9,
            });
          if (h === 4) {
            g.moveTo((x + 0.25) * TILE, (y + 0.3) * TILE)
              .lineTo((x + 0.55) * TILE, (y + 0.7) * TILE)
              .stroke({ width: 1.2, color: COLORS.rockShade, alpha: 0.8 });
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

    // --- G5, the countryside pass: strata on the cliffs, a worked shoreline
    // (foam over the water, mud dither on the bank), lilies on still water, a
    // darker floor under the woods, dithered seams where mottle blocks meet,
    // and flowering meadows. All baked, all hashed from coords — zero
    // per-frame cost by construction.
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const h = (((x * 83492791) ^ (y * 297121507)) >>> 0) % 9973;
        const px = x * TILE;
        const py = y * TILE;
        if (isRock(x, y)) {
          if (isRock(x, y - 1) && isRock(x, y + 1) && h % 5 === 2) {
            // Strata: one lit seam across interior rock — geology, not tiles.
            const sy = py + TILE * (0.3 + ((h >> 4) % 4) * 0.12);
            g.moveTo(px + 1, sy)
              .lineTo(px + TILE - 1, sy + ((h >> 6) % 2 === 0 ? 1 : -1))
              .stroke({ width: 1, color: COLORS.rockLit, alpha: 0.5 });
          }
          continue;
        }
        if (isWater(x, y)) {
          const bank =
            !isWater(x - 1, y) || !isWater(x + 1, y) || !isWater(x, y - 1) || !isWater(x, y + 1);
          if (bank && h % 3 !== 0) {
            // Foam: short pale dashes hugging the shore.
            const fy = py + 2 + ((h >> 3) % 3);
            g.moveTo(px + 2 + (h % 5), fy)
              .lineTo(px + 2 + (h % 5) + TILE * 0.3, fy)
              .stroke({ width: 1, color: COLORS.foam, alpha: 0.22 });
          } else if (!bank && h % 41 === 7) {
            // A lily on still water.
            g.circle(px + TILE * 0.4, py + TILE * 0.45, TILE * 0.14).fill({
              color: COLORS.forestLit,
              alpha: 0.8,
            });
            g.moveTo(px + TILE * 0.4, py + TILE * 0.45)
              .lineTo(px + TILE * 0.52, py + TILE * 0.38)
              .stroke({ width: 1.2, color: COLORS.water, alpha: 0.9 });
          }
          continue;
        }
        if (map.forest[y * map.width + x] === 1) {
          // Forest floor: the wood is darker at its feet.
          g.rect(px, py, TILE, TILE).fill({ color: 0x000000, alpha: 0.09 });
          continue;
        }
        const nearWater =
          isWater(x - 1, y) || isWater(x + 1, y) || isWater(x, y - 1) || isWater(x, y + 1);
        if (nearWater) {
          // Shore collar: mud dither where grass gives way to the bank.
          for (let k = 0; k < 4; k++) {
            const hh = (h >> (k * 3)) & 0x1f;
            g.rect(px + (hh % 8) * (TILE / 8), py + ((hh >> 2) % 8) * (TILE / 8), 1.6, 1.6).fill({
              color: k % 2 === 0 ? COLORS.plank : COLORS.groundDeep,
              alpha: 0.35,
            });
          }
        }
        const blk = ((((x >> 2) * 2654435761) ^ ((y >> 2) * 40503)) >>> 0) % 3;
        const blkW = (((((x - 1) >> 2) * 2654435761) ^ ((y >> 2) * 40503)) >>> 0) % 3;
        if (x > 0 && blk !== blkW && (x & 3) === 0) {
          // The AoE2 trick at our scale: a checker dither where mottle blocks
          // meet, so tone changes read as ground, not as tiles.
          for (let k = 0; k < 5; k++) {
            const hh = (h >> k) & 7;
            g.rect(px - 1 + (k & 1) * 2, py + k * (TILE / 5) + (hh % 3), 2, 2).fill({
              color: blk === 0 ? COLORS.groundAlt : COLORS.ground,
              alpha: 0.5,
            });
          }
        }
      }
    }
    // Meadows: rare flowering patches on open ground (8×8-block hash draw).
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = y * map.width + x;
        if (map.walk[i] === 1 || map.vision[i] === 1 || map.forest[i] === 1) continue;
        const bh = ((((x >> 3) * 2654435761) ^ ((y >> 3) * 97531)) >>> 0) % 11;
        if (bh !== 4) continue;
        const h = (((x * 40503) ^ (y * 73856093)) >>> 0) % 977;
        g.circle((x + 0.5) * TILE, (y + 0.5) * TILE, TILE * 0.55).fill({
          color: COLORS.grass,
          alpha: 0.09,
        });
        if (h % 3 === 1) {
          const fx2 = (x + 0.2 + (h % 6) * 0.11) * TILE;
          const fy2 = (y + 0.2 + ((h >> 3) % 6) * 0.11) * TILE;
          g.moveTo(fx2, fy2 + 2.6)
            .lineTo(fx2, fy2 + 0.8)
            .stroke({ width: 0.9, color: COLORS.grass, alpha: 0.8 });
          g.circle(fx2, fy2, 1.2).fill({
            color: h % 2 === 0 ? COLORS.flowerGold : COLORS.flowerPale,
            alpha: 0.9,
          });
          g.circle(fx2, fy2, 0.5).fill({ color: GOLD.trim, alpha: 0.9 });
        }
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
            .circle((x + 0.64) * TILE, (y + 0.68) * TILE, TILE * 0.62)
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

    // Bridges: walkable tiles flanked by water read as planks — drawn from
    // the ledger scouted above (the same one the roads route through).
    for (const b of bridges) {
      const px = b.x * TILE;
      const py = b.y * TILE;
      g.rect(px, py, TILE, TILE).fill(COLORS.bridge);
      const seam = { width: 1.2, color: COLORS.plank, alpha: 0.8 };
      const rail = { width: 2, color: COLORS.rail, alpha: 0.9 };
      if (b.horiz) {
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
    this.mapLayer.addChild(g);
    this.mapLayer.addChild(forestG);
    this.forestG = forestG;

    // POI markers. Rings on towns trace the ACTUAL interact radius — "stand
    // inside the gold circle" is the whole banking tutorial. LIVE squad keeps
    // render in KeepLayer (dynamic hp/position as of M3); the static map only
    // marks unclaimed SITES faintly (rebuild spots).
    const poi = new Graphics();
    for (const k of map.keeps) {
      // Unclaimed keep sites (G2): faint foundation stones — a place waiting
      // for a castle, quieter than any claimed keep. The whisper of a ring
      // stays as the rebuild-channel hint.
      const kx = k.x * TILE;
      const ky = k.y * TILE;
      const d = TILE * 0.75;
      for (const [sx, sy] of [
        [-d, -d],
        [d, -d],
        [-d, d],
        [d, d],
      ] as Array<[number, number]>) {
        poi.rect(kx + sx - 2.5, ky + sy - 2.5, 5, 5).fill({ color: COLORS.stone, alpha: 0.35 });
        poi.rect(kx + sx - 2.5, ky + sy - 2.5, 5, 5).stroke({ width: 1, color: INK, alpha: 0.3 });
      }
      poi.rect(kx - 6, ky - 6, 12, 12).stroke({ width: 1.2, color: COLORS.stone, alpha: 0.3 });
      poi
        .circle(kx, ky, interactRadius * TILE * 0.55)
        .stroke({ width: 1.2, color: GOLD.keep, alpha: 0.12 });
    }
    for (const t of map.towns) {
      // The bank (G2): a stone front with a gold-trimmed vault door and a
      // hanging coin sign — the same gold-anchored silhouette as the old
      // square, so banking wayfinding doesn't move. The interact circle
      // stays the whole tutorial: stand inside the gold ring.
      const tx = t.x * TILE;
      const ty = t.y * TILE;
      const S = TILE / 19; // bank composed at 19px/tile; S rides the zoom
      poi.ellipse(tx + 2 * S, ty + 5.5 * S, TILE * 0.58, TILE * 0.2).fill({
        color: 0x000000,
        alpha: FX.grounding.shadowAlpha,
      });
      poi.rect(tx - 9.5 * S, ty - 7.5 * S, 19 * S, 13 * S).fill(COLORS.rockLit);
      poi.rect(tx - 9.5 * S, ty - 7.5 * S, 19 * S, 13 * S).stroke({
        width: 1.2,
        color: INK,
        alpha: 0.7,
      });
      poi
        .moveTo(tx - 8.5 * S, ty - 6.2 * S)
        .lineTo(tx + 8.5 * S, ty - 6.2 * S)
        .stroke({ width: 1.2, color: 0xffffff, alpha: FX.grounding.edgeLitAlpha });
      poi
        .moveTo(tx - 8.5 * S, ty - 4.4 * S)
        .lineTo(tx + 8.5 * S, ty - 4.4 * S)
        .stroke({ width: 2, color: GOLD.keep, alpha: 0.95 });
      poi.rect(tx - 2.8 * S, ty - 1 * S, 5.6 * S, 6.5 * S).fill(GOLD.town);
      poi.rect(tx - 2.8 * S, ty - 1 * S, 5.6 * S, 6.5 * S).stroke({ width: 1.2, color: GOLD.trim });
      poi.circle(tx, ty + 1.8 * S, 1.1 * S).fill(GOLD.trim);
      poi
        .moveTo(tx + 8.5 * S, ty - 4.5 * S)
        .lineTo(tx + 12 * S, ty - 4.5 * S)
        .stroke({ width: 1.2, color: INK, alpha: 0.8 });
      poi.rect(tx + 9.6 * S, ty - 4 * S, 4.6 * S, 4.6 * S).fill(GOLD.town);
      poi.rect(tx + 9.6 * S, ty - 4 * S, 4.6 * S, 4.6 * S).stroke({ width: 1, color: GOLD.trim });
      poi.circle(tx + 11.9 * S, ty - 1.7 * S, 1.2 * S).fill(GOLD.trim);
      poi
        .moveTo(tx - 8 * S, ty + 5 * S)
        .lineTo(tx + 8 * S, ty + 5 * S)
        .stroke({ width: 1.2, color: INK, alpha: FX.grounding.edgeShadeAlpha });
      poi
        .circle(tx, ty, interactRadius * TILE)
        .stroke({ width: 2.5, color: GOLD.town, alpha: 0.75 });
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
