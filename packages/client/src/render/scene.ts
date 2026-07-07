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
  readonly entityLayer = new Container();
  readonly projectileLayer = new Container();
  readonly fxLayer = new Container();
  readonly fogLayer = new Container();

  private constructor(app: Application) {
    this.app = app;
    // Draw order: terrain, bodies, arrows over bodies, sparks, fog veils all.
    this.world.addChild(this.mapLayer);
    this.world.addChild(this.entityLayer);
    this.world.addChild(this.projectileLayer);
    this.world.addChild(this.fxLayer);
    this.world.addChild(this.fogLayer);
    app.stage.addChild(this.world);
  }

  static async create(mount: HTMLElement): Promise<Scene> {
    const app = new Application();
    await app.init({ resizeTo: window, background: 0x14170f, antialias: true });
    mount.appendChild(app.canvas);
    return new Scene(app);
  }

  buildMap(map: MapData): void {
    this.mapLayer.removeChildren();
    const g = new Graphics();
    // Ground with a subtle checker so motion is readable even in open fields.
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const base = (x + y) % 2 === 0 ? COLORS.ground : COLORS.groundAlt;
        g.rect(x * TILE, y * TILE, TILE, TILE).fill(base);
      }
    }
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = y * map.width + x;
        let color: number | null = null;
        if (map.vision[i] === 1) color = COLORS.wall;
        else if (map.walk[i] === 1) color = COLORS.water;
        else if (map.forest[i] === 1) color = COLORS.forest;
        if (color !== null) g.rect(x * TILE, y * TILE, TILE, TILE).fill(color);
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

    // POI markers
    const poi = new Graphics();
    for (const k of map.keeps) {
      poi
        .circle(k.x * TILE, k.y * TILE, TILE * 1.4)
        .stroke({ width: 2, color: COLORS.keep, alpha: 0.9 });
      poi.circle(k.x * TILE, k.y * TILE, 3).fill(COLORS.keep);
    }
    for (const t of map.towns) {
      poi.rect(t.x * TILE - 6, t.y * TILE - 6, 12, 12).fill(COLORS.town);
      poi
        .circle(t.x * TILE, t.y * TILE, TILE * 2)
        .stroke({ width: 2, color: COLORS.town, alpha: 0.5 });
    }
    map.spawns.forEach((s, squad) => {
      poi
        .circle(s.x * TILE, s.y * TILE, TILE)
        .stroke({ width: 2, color: SQUAD_COLORS[squad]!, alpha: 0.7 });
    });
    this.mapLayer.addChild(poi);
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
