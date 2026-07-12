import { Application, Container, Graphics } from 'pixi.js';
import type { MapData } from '@shared/map/types';

// Pixi scene: a world container (scaled TILE px per world unit) holding the
// static map layer and the entity layer, with a camera that follows a point.

export const TILE = 12;

const COLORS = {
  ground: 0x2f3428,
  groundAlt: 0x333929,
  forest: 0x22371f,
  water: 0x1f3a52,
  bridge: 0x7a6544,
  wall: 0x55554d,
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
    // Ground: the readability checker plus a deterministic per-tile micro-tint
    // (M6 s4) — hashed from coords, so it's identical every visit and NEVER
    // touches world.rng. Fields stop looking like graph paper.
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const base = (x + y) % 2 === 0 ? COLORS.ground : COLORS.groundAlt;
        const h = (((x * 73856093) ^ (y * 19349663)) >>> 0) % 5;
        const tinted = h === 0 ? base + 0x030402 : h === 1 ? base - 0x020302 : base;
        g.rect(x * TILE, y * TILE, TILE, TILE).fill(tinted);
      }
    }
    const forestG = new Graphics();
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = y * map.width + x;
        let color: number | null = null;
        if (map.vision[i] === 1) color = COLORS.wall;
        else if (map.walk[i] === 1) color = COLORS.water;
        if (color !== null) g.rect(x * TILE, y * TILE, TILE, TILE).fill(color);
        // Forests draw on their OWN layer so the canopy can breathe (a slow
        // whole-layer alpha sine — zero per-tile redraws).
        if (color === null && map.forest[i] === 1) {
          forestG.rect(x * TILE, y * TILE, TILE, TILE).fill(COLORS.forest);
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
          g.rect(x * TILE, y * TILE, TILE, TILE).fill(COLORS.bridge);
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
      poi.rect(t.x * TILE - 7, t.y * TILE - 7, 14, 14).fill(COLORS.town);
      poi.rect(t.x * TILE - 7, t.y * TILE - 7, 14, 14).stroke({ width: 2, color: 0x7a6544 });
      poi.circle(t.x * TILE, t.y * TILE, 3).fill(0x7a6544);
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
