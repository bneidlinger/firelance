// Procedural SFX: a tiny WebAudio synth, zero assets. Every sound is a few
// oscillator/noise notes with pitch slides and exponential decay — readable
// hit feedback is part of the M1 fun verdict, art fidelity is not.

type Wave = OscillatorType | 'noise';

interface Note {
  wave: Wave;
  /** Start/end frequency (Hz); slides exponentially across the duration. */
  f0: number;
  f1?: number;
  /** Duration seconds. */
  d: number;
  /** Peak gain 0..1. */
  g: number;
  /** Start delay seconds. */
  at?: number;
  /** Lowpass cutoff for noise. */
  lp?: number;
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    const len = ctx.sampleRate;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Call once from a user gesture (browsers gate audio until then). */
export function unlockAudio(): void {
  const c = ensureCtx();
  if (c && c.state === 'suspended') void c.resume();
}

function play(notes: Note[], volume = 1): void {
  const c = ensureCtx();
  if (!c || !master || c.state !== 'running') return;
  const t0 = c.currentTime;
  for (const n of notes) {
    const at = t0 + (n.at ?? 0);
    const gain = c.createGain();
    gain.gain.setValueAtTime(n.g * volume, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + n.d);
    gain.connect(master);

    if (n.wave === 'noise') {
      const src = c.createBufferSource();
      src.buffer = noiseBuf!;
      src.loop = true;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(n.lp ?? 2000, at);
      src.connect(lp);
      lp.connect(gain);
      src.start(at);
      src.stop(at + n.d);
    } else {
      const osc = c.createOscillator();
      osc.type = n.wave;
      osc.frequency.setValueAtTime(n.f0, at);
      if (n.f1 && n.f1 !== n.f0) osc.frequency.exponentialRampToValueAtTime(n.f1, at + n.d);
      osc.connect(gain);
      osc.start(at);
      osc.stop(at + n.d);
    }
  }
}

export type SfxName =
  | 'shoot'
  | 'arrowHit'
  | 'swing'
  | 'meleeHit'
  | 'block'
  | 'death'
  | 'coin'
  | 'pickup'
  | 'banked'
  | 'bombThrow'
  | 'bombBoom'
  | 'alarm'
  | 'keepFall'
  | 'rebuilt'
  | 'respawn'
  | 'dash'
  | 'countdown'
  | 'live'
  | 'matchEnd'
  | 'ownDeath'
  | 'trapSnap'
  | 'rumor';

const SOUNDS: Record<SfxName, Note[]> = {
  shoot: [
    { wave: 'noise', f0: 0, d: 0.07, g: 0.5, lp: 5000 },
    { wave: 'square', f0: 880, f1: 340, d: 0.09, g: 0.25 },
  ],
  arrowHit: [
    { wave: 'noise', f0: 0, d: 0.09, g: 0.7, lp: 2600 },
    { wave: 'triangle', f0: 300, f1: 140, d: 0.1, g: 0.5 },
  ],
  swing: [{ wave: 'noise', f0: 0, d: 0.13, g: 0.35, lp: 1200 }],
  meleeHit: [
    { wave: 'sine', f0: 160, f1: 70, d: 0.14, g: 0.9 },
    { wave: 'noise', f0: 0, d: 0.08, g: 0.5, lp: 1800 },
  ],
  block: [
    { wave: 'square', f0: 1300, f1: 900, d: 0.06, g: 0.4 },
    { wave: 'sine', f0: 520, f1: 300, d: 0.12, g: 0.4 },
  ],
  death: [
    { wave: 'sawtooth', f0: 300, f1: 60, d: 0.4, g: 0.5 },
    { wave: 'noise', f0: 0, d: 0.25, g: 0.35, lp: 900 },
  ],
  ownDeath: [
    { wave: 'sawtooth', f0: 240, f1: 40, d: 0.7, g: 0.6 },
    { wave: 'sine', f0: 120, f1: 40, d: 0.7, g: 0.5 },
  ],
  coin: [
    { wave: 'square', f0: 990, d: 0.07, g: 0.3 },
    { wave: 'square', f0: 1320, d: 0.12, g: 0.3, at: 0.07 },
  ],
  // Heavier clink than `coin` — a whole sack changing hands.
  pickup: [
    { wave: 'square', f0: 660, d: 0.06, g: 0.3 },
    { wave: 'square', f0: 990, d: 0.08, g: 0.32, at: 0.05 },
    { wave: 'noise', f0: 0, d: 0.07, g: 0.2, lp: 5200 },
  ],
  // The payoff chime: gold is SAFE. Rising triad, brighter than matchEnd.
  banked: [
    { wave: 'triangle', f0: 659, d: 0.1, g: 0.4 },
    { wave: 'triangle', f0: 880, d: 0.1, g: 0.4, at: 0.09 },
    { wave: 'triangle', f0: 1319, d: 0.28, g: 0.42, at: 0.18 },
    { wave: 'square', f0: 1319, d: 0.1, g: 0.12, at: 0.18 },
  ],
  // A heavy lob leaving the hand.
  bombThrow: [
    { wave: 'noise', f0: 0, d: 0.16, g: 0.3, lp: 900 },
    { wave: 'sine', f0: 220, f1: 340, d: 0.18, g: 0.3 },
  ],
  // The blast: deep thump + debris.
  bombBoom: [
    { wave: 'sine', f0: 110, f1: 34, d: 0.42, g: 1.0 },
    { wave: 'noise', f0: 0, d: 0.3, g: 0.65, lp: 1400 },
    { wave: 'square', f0: 70, f1: 40, d: 0.2, g: 0.3 },
  ],
  // Jaws closing: a metallic clack + short low thunk. Sharper than meleeHit —
  // it should read as MECHANISM, not muscle.
  trapSnap: [
    { wave: 'square', f0: 2200, f1: 700, d: 0.05, g: 0.5 },
    { wave: 'noise', f0: 0, d: 0.06, g: 0.55, lp: 6000 },
    { wave: 'sine', f0: 180, f1: 60, d: 0.16, g: 0.7, at: 0.03 },
  ],
  // Under-attack klaxon: two urgent low blasts.
  alarm: [
    { wave: 'square', f0: 392, f1: 330, d: 0.16, g: 0.4 },
    { wave: 'square', f0: 392, f1: 330, d: 0.22, g: 0.4, at: 0.22 },
  ],
  // A keep coming down: long rumble under a falling tone.
  keepFall: [
    { wave: 'sawtooth', f0: 180, f1: 40, d: 0.9, g: 0.55 },
    { wave: 'noise', f0: 0, d: 1.1, g: 0.6, lp: 500 },
    { wave: 'sine', f0: 55, f1: 30, d: 1.0, g: 0.7 },
  ],
  // The comeback: solid rising fourth, sturdier than `banked`.
  rebuilt: [
    { wave: 'triangle', f0: 392, d: 0.16, g: 0.45 },
    { wave: 'triangle', f0: 523, d: 0.3, g: 0.45, at: 0.15 },
    { wave: 'noise', f0: 0, d: 0.12, g: 0.2, lp: 2000, at: 0.15 },
  ],
  respawn: [
    { wave: 'triangle', f0: 330, f1: 660, d: 0.18, g: 0.35 },
    { wave: 'triangle', f0: 495, f1: 990, d: 0.2, g: 0.25, at: 0.06 },
  ],
  // Gossip on the wind: two soft falling notes, quiet by design — a rumor
  // whispers, the alarm shouts.
  rumor: [
    { wave: 'sine', f0: 620, f1: 470, d: 0.12, g: 0.18 },
    { wave: 'sine', f0: 470, f1: 380, d: 0.16, g: 0.14, at: 0.12 },
  ],
  dash: [{ wave: 'noise', f0: 0, d: 0.1, g: 0.3, lp: 3400 }],
  countdown: [{ wave: 'square', f0: 660, d: 0.09, g: 0.3 }],
  live: [
    { wave: 'square', f0: 660, d: 0.1, g: 0.35 },
    { wave: 'square', f0: 990, d: 0.22, g: 0.35, at: 0.1 },
  ],
  matchEnd: [
    { wave: 'triangle', f0: 523, d: 0.16, g: 0.4 },
    { wave: 'triangle', f0: 659, d: 0.16, g: 0.4, at: 0.15 },
    { wave: 'triangle', f0: 784, d: 0.34, g: 0.4, at: 0.3 },
  ],
};

/**
 * Play a named sound; world-positioned sounds fade with distance from the
 * listener and cut off entirely beyond earshot.
 */
export function sfx(
  name: SfxName,
  at?: { x: number; y: number },
  listener?: { x: number; y: number },
): void {
  let volume = 1;
  if (at && listener) {
    const d = Math.hypot(at.x - listener.x, at.y - listener.y);
    const EARSHOT = 26;
    if (d > EARSHOT) return;
    volume = Math.max(0.12, 1 - d / EARSHOT);
  }
  play(SOUNDS[name], volume);
}
