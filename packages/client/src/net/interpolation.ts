import type { ClassId } from '@shared/config';
import type { EntitySnap, SackSnap, SnapMsg } from '@shared/net/messages';

// Remote entities render in the PAST: renderTick = estServerTick - interpDelay
// (~133ms at 4 ticks), lerped between the two bracketing snapshots. That
// buffer absorbs network jitter and one TCP retransmit. When the buffer runs
// dry we clamp to the newest snapshot (freeze) rather than extrapolate wildly.
// Positions and facing lerp; hp/class/state-flags step from the newer frame.

export interface RichEnt {
  x: number;
  y: number;
  ax: number;
  ay: number;
  hp: number;
  cls: ClassId;
  st: number;
  /** Carried gold — squadmates only (the server never sends it for enemies). */
  g?: number;
}

interface BufferedSnap {
  tick: number;
  ents: Map<number, EntitySnap>;
}

export interface InterpStats {
  bufferedSnaps: number;
  newestTick: number;
  /** Frames rendered while starved (renderTick beyond newest snapshot). */
  starvedFrames: number;
}

const MAX_BUFFER = 40;

export class Interpolation {
  private buffer: BufferedSnap[] = [];
  /** Ground sacks from the newest snapshot — static objects, no lerp needed. */
  sacks: SackSnap[] = [];
  readonly stats: InterpStats = { bufferedSnaps: 0, newestTick: 0, starvedFrames: 0 };

  /** Drop all buffered state (match restart / fresh welcome). */
  clear(): void {
    this.buffer = [];
    this.sacks = [];
    this.stats.bufferedSnaps = 0;
    this.stats.newestTick = 0;
  }

  addSnapshot(snap: SnapMsg): void {
    const ents = new Map<number, EntitySnap>();
    for (const e of snap.ents) ents.set(e.i, e);
    // Snapshots arrive in order on TCP, but be safe about duplicates.
    const last = this.buffer[this.buffer.length - 1];
    if (last && snap.tick <= last.tick) return;
    this.buffer.push({ tick: snap.tick, ents });
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    this.sacks = snap.sacks;
    this.stats.bufferedSnaps = this.buffer.length;
    this.stats.newestTick = snap.tick;
  }

  /**
   * Every visible entity at (fractional) renderTick. Entities absent from the
   * newest bracketing snapshot are dropped — that's how despawns/fog-exits
   * materialize with no delta bookkeeping.
   */
  sample(renderTick: number): Map<number, RichEnt> {
    const out = new Map<number, RichEnt>();
    if (this.buffer.length === 0) return out;

    // Find the pair (a, b) with a.tick <= renderTick <= b.tick.
    let a = this.buffer[0]!;
    let b = this.buffer[this.buffer.length - 1]!;
    if (renderTick >= b.tick) {
      // Starved: clamp to newest.
      if (renderTick > b.tick + 0.01) this.stats.starvedFrames++;
      for (const [id, e] of b.ents) out.set(id, rich(e, e, 1));
      return out;
    }
    if (renderTick <= a.tick) {
      for (const [id, e] of a.ents) out.set(id, rich(e, e, 1));
      return out;
    }
    for (let i = this.buffer.length - 2; i >= 0; i--) {
      if (this.buffer[i]!.tick <= renderTick) {
        a = this.buffer[i]!;
        b = this.buffer[i + 1]!;
        break;
      }
    }

    const span = b.tick - a.tick;
    const alpha = span > 0 ? (renderTick - a.tick) / span : 1;
    for (const [id, eb] of b.ents) {
      const ea = a.ents.get(id);
      // Just appeared between a and b (spawn / fog entry): no history to lerp.
      out.set(id, rich(ea ?? eb, eb, alpha));
    }
    return out;
  }

  /** Trim history the render cursor has passed (call occasionally). */
  trim(renderTick: number): void {
    while (this.buffer.length > 2 && this.buffer[1]!.tick < renderTick - 2) {
      this.buffer.shift();
    }
    this.stats.bufferedSnaps = this.buffer.length;
  }
}

function rich(ea: EntitySnap, eb: EntitySnap, alpha: number): RichEnt {
  let ax = ea.ax + (eb.ax - ea.ax) * alpha;
  let ay = ea.ay + (eb.ay - ea.ay) * alpha;
  const l = Math.hypot(ax, ay);
  if (l > 1e-6) {
    ax /= l;
    ay /= l;
  } else {
    ax = eb.ax;
    ay = eb.ay;
  }
  return {
    x: ea.x + (eb.x - ea.x) * alpha,
    y: ea.y + (eb.y - ea.y) * alpha,
    ax,
    ay,
    // Discrete fields step from the newer frame — no fractional hp bars.
    hp: eb.hp,
    cls: eb.cls,
    st: eb.st,
    g: eb.g,
  };
}
