import { Sprite, Texture } from 'pixi.js';
import type { Container } from 'pixi.js';
import type { GameConfig } from '@shared/config';
import type { MapData } from '@shared/map/types';
import { canSeePoint } from '@shared/sim/vision';
import { TILE } from './scene';

// Fog-of-war mask drawn from THE SAME shared visibility function the server
// filters snapshots with — what you see and what you receive cannot disagree.
// One canvas pixel per tile, scaled up with linear filtering for soft edges;
// terrain stays readable under the veil (the map is known, activity is not).

const HIDDEN_ALPHA = 168; // 0-255
const UPDATE_EVERY_MS = 66; // ~15Hz, matching the snapshot cadence

export class FogLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly texture: Texture;
  readonly sprite: Sprite;
  private lastUpdate = 0;

  constructor(
    parent: Container,
    private readonly map: MapData,
    private readonly cfg: GameConfig,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = map.width;
    this.canvas.height = map.height;
    this.ctx = this.canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(map.width, map.height);
    // Start fully veiled.
    for (let i = 0; i < map.width * map.height; i++) {
      this.image.data[i * 4 + 3] = HIDDEN_ALPHA;
    }
    this.ctx.putImageData(this.image, 0, 0);
    this.texture = Texture.from(this.canvas);
    this.sprite = new Sprite(this.texture);
    this.sprite.scale.set(TILE);
    parent.addChild(this.sprite);
  }

  /**
   * Recompute the mask from the squad's living viewers (own predicted pos +
   * ally snapshot positions). Throttled to snapshot cadence.
   */
  update(now: number, viewers: Array<{ x: number; y: number }>): void {
    if (now - this.lastUpdate < UPDATE_EVERY_MS) return;
    this.lastUpdate = now;

    const { map, cfg, image } = this;
    const data = image.data;
    const r = Math.ceil(cfg.vision.radius);

    // Veil everything, then carve out what any viewer can see.
    for (let i = 0; i < map.width * map.height; i++) data[i * 4 + 3] = HIDDEN_ALPHA;

    for (const v of viewers) {
      const x0 = Math.max(0, Math.floor(v.x) - r);
      const x1 = Math.min(map.width - 1, Math.floor(v.x) + r);
      const y0 = Math.max(0, Math.floor(v.y) - r);
      const y1 = Math.min(map.height - 1, Math.floor(v.y) + r);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const idx = ty * map.width + tx;
          if (data[idx * 4 + 3] === 0) continue; // already visible
          if (canSeePoint(map, cfg, v.x, v.y, tx + 0.5, ty + 0.5)) {
            data[idx * 4 + 3] = 0;
          }
        }
      }
    }

    this.ctx.putImageData(image, 0, 0);
    this.texture.source.update();
  }

  destroy(): void {
    this.sprite.destroy({ texture: true });
  }
}
