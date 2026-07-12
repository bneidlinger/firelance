import type { EmitSpec } from '../fx/config';

// Fixed-slot particle pool (M6 s1) — pure data, no Pixi, so node tests can
// drive it. The ring cursor overwrites the oldest emission when full: a fresh
// burst always beats a fading ember, and nothing allocates after construction.

export interface Particle {
  alive: boolean;
  xPx: number;
  yPx: number;
  vxPx: number;
  vyPx: number;
  bornMs: number;
  lifeMs: number;
  sizePx: number;
  color: number;
  gravityPx: number;
  drag: number;
  /** Life progress 0..1, written by step() — renderers derive alpha/scale. */
  t: number;
}

const freshParticle = (): Particle => ({
  alive: false,
  xPx: 0,
  yPx: 0,
  vxPx: 0,
  vyPx: 0,
  bornMs: 0,
  lifeMs: 1,
  sizePx: 1,
  color: 0xffffff,
  gravityPx: 0,
  drag: 0,
  t: 0,
});

export class ParticlePool {
  readonly slots: Particle[];
  private cursor = 0;
  emitted = 0;
  stolen = 0;

  constructor(readonly cap: number) {
    this.slots = Array.from({ length: cap }, freshParticle);
  }

  /** Spawn spec.count particles at a pixel position. `unitPx` converts the
   *  spec's world-unit speeds/gravity to pixels; `rand` injectable for tests. */
  emit(
    xPx: number,
    yPx: number,
    spec: EmitSpec,
    unitPx: number,
    nowMs: number,
    rand: () => number = Math.random,
  ): void {
    const [a0, a1] = spec.angle ?? [0, Math.PI * 2];
    for (let i = 0; i < spec.count; i++) {
      const p = this.slots[this.cursor]!;
      if (p.alive) this.stolen++;
      this.cursor = (this.cursor + 1) % this.cap;
      const a = a0 + (a1 - a0) * rand();
      const sp = (spec.speed[0] + (spec.speed[1] - spec.speed[0]) * rand()) * unitPx;
      p.alive = true;
      p.xPx = xPx;
      p.yPx = yPx;
      p.vxPx = Math.cos(a) * sp;
      p.vyPx = Math.sin(a) * sp;
      p.bornMs = nowMs;
      p.lifeMs = spec.life[0] + (spec.life[1] - spec.life[0]) * rand();
      p.sizePx = spec.size[0] + (spec.size[1] - spec.size[0]) * rand();
      p.color = spec.colors[Math.floor(rand() * spec.colors.length)] ?? 0xffffff;
      p.gravityPx = (spec.gravity ?? 0) * unitPx;
      p.drag = spec.drag ?? 0;
      p.t = 0;
      this.emitted++;
    }
  }

  /** Integrate + expire; returns the live count. */
  step(nowMs: number, dtMs: number): number {
    const dt = dtMs / 1000;
    let alive = 0;
    for (const p of this.slots) {
      if (!p.alive) continue;
      p.t = (nowMs - p.bornMs) / p.lifeMs;
      if (p.t >= 1) {
        p.alive = false;
        continue;
      }
      const damp = p.drag > 0 ? Math.exp(-p.drag * dt) : 1;
      p.vxPx *= damp;
      p.vyPx = p.vyPx * damp + p.gravityPx * dt;
      p.xPx += p.vxPx * dt;
      p.yPx += p.vyPx * dt;
      alive++;
    }
    return alive;
  }

  aliveCount(): number {
    let n = 0;
    for (const p of this.slots) if (p.alive) n++;
    return n;
  }

  clear(): void {
    for (const p of this.slots) p.alive = false;
  }
}
