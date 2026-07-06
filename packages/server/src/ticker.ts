export interface TickerStats {
  ticks: number;
  /** Milliseconds of sim time discarded because we fell too far behind. */
  droppedMs: number;
}

/**
 * Drift-corrected fixed-rate driver: setTimeout chain + hrtime accumulator.
 * Runs up to `maxCatchUp` sim ticks per wake-up; beyond that it drops time
 * (with a warning) instead of spiraling.
 */
export class RealtimeTicker {
  private timer: NodeJS.Timeout | null = null;
  private last = 0n;
  private acc = 0;
  private running = false;
  readonly stats: TickerStats = { ticks: 0, droppedMs: 0 };

  constructor(
    private readonly hz: number,
    private readonly cb: () => void,
    private readonly maxCatchUp = 5,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = process.hrtime.bigint();
    const stepMs = 1000 / this.hz;
    const loop = (): void => {
      if (!this.running) return;
      const now = process.hrtime.bigint();
      this.acc += Number(now - this.last) / 1e6;
      this.last = now;
      let n = 0;
      while (this.acc >= stepMs && n < this.maxCatchUp) {
        this.acc -= stepMs;
        this.stats.ticks++;
        this.cb();
        n++;
      }
      if (this.acc >= stepMs) {
        // Still behind after max catch-up: drop the debt, keep cadence honest.
        this.stats.droppedMs += this.acc;
        console.warn(`[ticker] fell behind, dropped ${this.acc.toFixed(1)}ms of sim time`);
        this.acc = 0;
      }
      this.timer = setTimeout(loop, Math.max(0, stepMs - this.acc));
    };
    this.timer = setTimeout(loop, stepMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Turbo driver for headless matches: ticks as fast as the CPU allows, yielding
 * to the event loop every 512 ticks so timers/sockets stay serviced.
 */
export async function runTurboTicks(ticks: number, cb: () => void): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    cb();
    if ((i & 511) === 511) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
