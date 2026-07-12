// World-anchored rising text ("+140g") lifecycle — pure, no Pixi, so node
// tests can pin the pool policy and the rise/fade math. The Pixi Text pool
// in floattext.ts is index-parallel to `items`.

export interface FloatItem {
  active: boolean;
  xPx: number;
  yPx: number;
  text: string;
  color: number;
  bornMs: number;
}

export interface FloatPose {
  x: number;
  y: number;
  alpha: number;
  done: boolean;
}

export class FloatTextCore {
  readonly items: FloatItem[];
  private cursor = 0;
  spawned = 0;
  stolen = 0;

  constructor(
    readonly poolSize: number,
    readonly lifeMs: number,
    readonly risePx: number,
  ) {
    this.items = Array.from({ length: poolSize }, () => ({
      active: false,
      xPx: 0,
      yPx: 0,
      text: '',
      color: 0xffffff,
      bornMs: 0,
    }));
  }

  /** Claims the next ring slot (stealing the oldest if all are live) and
   *  returns its index so the renderer can update its paired Text. */
  spawn(xPx: number, yPx: number, text: string, color: number, nowMs: number): number {
    const idx = this.cursor;
    const it = this.items[idx]!;
    if (it.active) this.stolen++;
    this.cursor = (this.cursor + 1) % this.poolSize;
    it.active = true;
    it.xPx = xPx;
    it.yPx = yPx;
    it.text = text;
    it.color = color;
    it.bornMs = nowMs;
    this.spawned++;
    return idx;
  }

  /** Ease-out rise, late fade. `t` clamps at 1 so a stale frame after a long
   *  rAF stall can't fade past zero or overshoot the rise. */
  pose(it: FloatItem, nowMs: number): FloatPose {
    const t = Math.min(1, (nowMs - it.bornMs) / this.lifeMs);
    const rise = 1 - (1 - t) * (1 - t);
    return {
      x: it.xPx,
      y: it.yPx - this.risePx * rise,
      alpha: t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45,
      done: t >= 1,
    };
  }

  step(nowMs: number): void {
    for (const it of this.items) {
      if (it.active && nowMs - it.bornMs >= this.lifeMs) it.active = false;
    }
  }

  activeCount(): number {
    let n = 0;
    for (const it of this.items) if (it.active) n++;
    return n;
  }

  clear(): void {
    for (const it of this.items) it.active = false;
  }
}
