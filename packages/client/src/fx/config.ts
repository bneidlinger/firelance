// Every juice knob in one place (M6 s1). Client-render-side ONLY — GameConfig
// stays sim-pure, and nothing in here may reach prediction, occupancy, or aim.

export interface EmitSpec {
  /** Particles per emit call. */
  count: number;
  /** Palette; each particle picks uniformly. */
  colors: number[];
  /** Launch speed range, world units/sec. */
  speed: [number, number];
  /** Emission arc in radians; omit for a full circle. */
  angle?: [number, number];
  /** Lifetime range, ms. */
  life: [number, number];
  /** Dot radius range, px. */
  size: [number, number];
  /** Downward acceleration, world units/sec² (arcs debris to the ground). */
  gravity?: number;
  /** Velocity damping per second (0 = coasts forever, ~6 = dies on the spot). */
  drag?: number;
}

export const FX = {
  particles: {
    /** Fixed pool; when full, fresh bursts overwrite the oldest embers. */
    cap: 512,
  },
  floatText: {
    pool: 12,
    lifeMs: 1000,
    riseUnits: 1.4,
  },
  audio: {
    /** World units at which positioned sounds go silent. */
    earshot: 26,
    /** Horizontal offset (units) that reaches full stereo separation. */
    panRangeUnits: 14,
    /** Hard cap on |pan| — a fully hard-panned note reads as a dead channel. */
    panMax: 0.8,
    /** Same-name sounds inside this window collapse into one voice: a 12-bot
     *  brawl phase-stacks identical synth notes into a buzz otherwise. */
    minGapMs: 55,
    gapOverrides: { coin: 90, rumor: 400 } as Record<string, number>,
    defaults: { master: 0.5, sfx: 1, ambient: 1 },
  },
  emit: {
    /** Arrow dies in terrain: pale splinters, quick and dry. */
    arrowThud: {
      count: 6,
      colors: [0xe8dcc0, 0xcbb894],
      speed: [2, 7],
      life: [140, 300],
      size: [1, 2],
      drag: 6,
    } as EmitSpec,
    /** Arrow finds a body: brief red spray that falls. */
    arrowFlesh: {
      count: 8,
      colors: [0xf05a4d, 0xc23a30, 0xffffff],
      speed: [3, 9],
      life: [160, 340],
      size: [1, 2.2],
      gravity: 14,
      drag: 5,
    } as EmitSpec,
  },
};
