// Every gameplay tunable lives here. Sim systems receive GameConfig as a
// parameter — nothing under sim/ imports constants directly. Balancing the
// game means editing presets, never logic.

export interface GameConfig {
  /** Preset name, included in cfgHash so client/server mismatches fail loudly. */
  name: string;

  tick: {
    /** Server simulation rate (Hz). */
    simHz: number;
    /** Snapshots every N sim ticks (2 => 15Hz at 30Hz sim). */
    snapshotEveryTicks: number;
  };

  match: {
    squads: number;
    playersPerSquad: number;
    /** Match length in seconds once live. */
    durationSec: number;
    /** Countdown before the match goes live. */
    countdownSec: number;
  };

  player: {
    radius: number;
    /** Units (tiles) per second. */
    moveSpeed: number;
    maxHp: number;
    respawnSec: number;
  };
}

export type GameConfigOverrides = DeepPartial<GameConfig>;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
