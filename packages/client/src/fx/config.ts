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
  combat: {
    /** Own-hp fraction under which the vignette pulses and the heart thumps. */
    lowHpFrac: 0.3,
    heartbeatGapMs: 900,
    footstepGapMs: 280,
    /** Own-death desaturate pulse duration (CSS class on #app). */
    desatMs: 650,
  },
  moments: {
    /** Keep hp fraction under which it smokes (matches the red bar tier). */
    keepCriticalFrac: 0.25,
    /** Mean ms between smoke wisps off a critical keep. */
    smokeEveryMs: 180,
    /** Transient center-banner duration. */
    bannerMs: 2200,
    /** End-screen banked-gold count-up duration. */
    countUpMs: 1200,
    /** Own-keep alarm pointer lifetime after a keepHit. */
    alarmPointerMs: 6000,
    /** Deposit channel: pitch step per quarter of the channel. */
    channelPitchStep: 0.13,
  },
  world: {
    /** Mean ms between water sparkles near the listener. */
    waterGlintEveryMs: 90,
    /** Water sparkles only spawn within this range of the player (units). */
    waterGlintRange: 26,
    /** Mean ms between gold glints at each town. */
    townGlintEveryMs: 1500,
    /** Forest canopy breath: alpha = base ± amp on a slow sine. */
    forestBreathPeriodMs: 1900,
    forestBreathBase: 0.88,
    forestBreathAmp: 0.08,
  },
  movement: {
    /** Walk bob: radians of phase per world unit walked, and scale amplitude.
     *  Driven by DISTANCE, not time — it reads as gait, and a standing body
     *  holds still. */
    bobPerUnit: 2.6,
    bobAmp: 0.045,
    /** Mean ms between gold glints on a carrier. */
    glintEveryMs: 320,
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
    /** Steel meets flesh: chunkier than an arrow, same red family. */
    meleeFlesh: {
      count: 10,
      colors: [0xf05a4d, 0xc23a30, 0xffffff],
      speed: [2, 8],
      life: [180, 380],
      size: [1.2, 2.6],
      gravity: 16,
      drag: 5,
    } as EmitSpec,
    /** Shield says no: steel sparks, cold palette, no gravity — they fly. */
    blockWedge: {
      count: 7,
      colors: [0x9db4c9, 0xd8e4ef, 0xffffff],
      speed: [4, 10],
      life: [120, 260],
      size: [1, 2],
      drag: 7,
    } as EmitSpec,
    /** Masonry chips off a struck wall/gate/tower. */
    structChip: {
      count: 6,
      colors: [0x8a8a80, 0x6b6b60, 0xa89f8a],
      speed: [1.5, 5],
      life: [200, 420],
      size: [1, 2.2],
      gravity: 10,
      drag: 4,
    } as EmitSpec,
    /** Iron jaws bite: metal + rust burst, meaner than a hit. */
    trapJaws: {
      count: 12,
      colors: [0xb0b0a8, 0xd8543e, 0x707068],
      speed: [3, 10],
      life: [160, 360],
      size: [1, 2.4],
      gravity: 12,
      drag: 6,
    } as EmitSpec,
    /** A body breaks into shards — call sites override colors with the
     *  victim's squad color. */
    deathShatter: {
      count: 14,
      colors: [0xffffff],
      speed: [2, 9],
      life: [260, 600],
      size: [1.5, 3],
      gravity: 12,
      drag: 3.5,
    } as EmitSpec,
    /** Kicked-up earth behind a dash. */
    dashDust: {
      count: 3,
      colors: [0xb9ad98, 0x8f8574],
      speed: [0.5, 2.5],
      life: [180, 360],
      size: [1, 2],
      drag: 3,
    } as EmitSpec,
    /** Dash afterimage: one near-still squad-tinted dot per frame — call
     *  sites override colors. */
    dashTrail: {
      count: 1,
      colors: [0xffffff],
      speed: [0, 0.5],
      life: [140, 220],
      size: [2.5, 3.5],
    } as EmitSpec,
    /** Gold winks off a carried purse; floats UP (negative gravity). */
    carryGlint: {
      count: 1,
      colors: [0xf2d68c, 0xffe9b0, 0xffffff],
      speed: [0.3, 1.2],
      life: [240, 420],
      size: [1, 1.8],
      gravity: -2,
      drag: 2,
    } as EmitSpec,
    /** A critical keep smolders: slow grey wisps drifting up. */
    smoke: {
      count: 1,
      colors: [0x6b6b64, 0x55554d, 0x8a8a80],
      speed: [0.4, 1.1],
      angle: [-2.2, -0.9], // upward cone (screen-up is -y)
      life: [700, 1400],
      size: [2, 3.6],
      gravity: -1.2,
      drag: 1.2,
    } as EmitSpec,
    /** Sun catches a wave: one pale-blue wink on open water. */
    waterGlint: {
      count: 1,
      colors: [0x9db4c9, 0xd8e4ef, 0x6f95b8],
      speed: [0.1, 0.5],
      life: [420, 800],
      size: [1, 1.8],
      drag: 1,
    } as EmitSpec,
    /** Gold fountains out of a completed deposit. */
    coinBurst: {
      count: 12,
      colors: [0xf2d68c, 0xffe9b0, 0xd5aa54],
      speed: [2, 7],
      angle: [Math.PI + 0.5, Math.PI * 2 - 0.5], // up-and-out arc
      life: [300, 650],
      size: [1.2, 2.4],
      gravity: 16,
      drag: 1.5,
    } as EmitSpec,
  },
};
