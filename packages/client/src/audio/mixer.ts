import { FX } from '../fx/config';

// Pure audio policy (M6 s1): stereo pan math, the same-sound spam gate, and
// volume-level persistence — everything the WebAudio layer decides that a
// node test can pin without an AudioContext.

/** Stereo pan from the listener-relative x offset: full separation at
 *  panRangeUnits, clamped to panMax (a hard-panned note reads as a dead
 *  channel, not as direction). */
export function panFor(dxUnits: number): number {
  const raw = (dxUnits / FX.audio.panRangeUnits) * FX.audio.panMax;
  return Math.max(-FX.audio.panMax, Math.min(FX.audio.panMax, raw));
}

/** One voice per sound name per window — 12 bots phase-stack identical synth
 *  notes into a buzz otherwise. Callers pass the per-name gap. */
export class Throttle {
  private readonly lastAt = new Map<string, number>();

  allow(name: string, nowMs: number, gapMs: number): boolean {
    const last = this.lastAt.get(name);
    if (last !== undefined && nowMs - last < gapMs) return false;
    this.lastAt.set(name, nowMs);
    return true;
  }
}

export type AudioChannel = 'master' | 'sfx' | 'ambient';

export interface AudioLevels {
  master: number;
  sfx: number;
  ambient: number;
}

const STORE_KEY = 'fl.audio.v1';

const clamp01 = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback;

export function loadLevels(storage: Pick<Storage, 'getItem'> | null): AudioLevels {
  const d = FX.audio.defaults;
  try {
    const raw = storage?.getItem(STORE_KEY);
    if (!raw) return { ...d };
    const p = JSON.parse(raw) as Partial<AudioLevels>;
    return {
      master: clamp01(p.master, d.master),
      sfx: clamp01(p.sfx, d.sfx),
      ambient: clamp01(p.ambient, d.ambient),
    };
  } catch {
    return { ...d };
  }
}

export function saveLevels(storage: Pick<Storage, 'setItem'> | null, levels: AudioLevels): void {
  try {
    storage?.setItem(STORE_KEY, JSON.stringify(levels));
  } catch {
    // Private-mode storage quota — volumes just won't persist.
  }
}
