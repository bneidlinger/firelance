import type { DeepPartial, GameConfig } from './types';
import { defaultConfig } from './default';

export type {
  ClassId,
  ClassKit,
  GameConfig,
  GameConfigOverrides,
  MeleeConfig,
  BowConfig,
  DashConfig,
  ShieldConfig,
  BuildConfig,
  StructKindConfig,
  TrapConfig,
} from './types';
export { getKit, secToTicks } from './types';
export { defaultConfig } from './default';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, overrides: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (value === undefined) continue;
    const baseValue = out[key];
    if (isPlainObject(baseValue) && isPlainObject(value)) {
      out[key] = deepMerge(baseValue, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Build a config preset by deep-merging overrides onto the default. */
export function defineConfig(overrides: DeepPartial<GameConfig>): GameConfig {
  return deepMerge(defaultConfig, overrides);
}

/** Compressed preset for fast playtest iteration (~8 min matches).
 *  Inherits variation ON — playtest nights get a fresh board every match;
 *  pinned-seed tests that want the authored layout override it off. */
export const prototypeConfig: GameConfig = defineConfig({
  name: 'prototype',
  match: { durationSec: 8 * 60, placementSec: 20, countdownSec: 5 },
});

/** Tiny preset for CI smoke matches (2–3 min game time, instant start).
 *  Variation off: smoke asserts against the authored layout. */
export const smokeConfig: GameConfig = defineConfig({
  name: 'smoke',
  match: { durationSec: 150, placementSec: 0, countdownSec: 0, restartSec: 5 },
  // Fast respawns keep combat flowing in compressed matches.
  player: { respawnSec: 4 },
  variation: { enabled: false },
  // Smoke is the pure combat-sanity arena — no gossip steering the bots.
  rumors: { enabled: false },
});

/** Browser-verification preset: placement long enough for a scripted claim
 *  walk, short enough that live-phase checks start promptly. Never used for
 *  real matches or CI. Variation off: automation scripts walk known routes. */
export const verifyConfig: GameConfig = defineConfig({
  name: 'verify',
  match: { durationSec: 8 * 60, placementSec: 30, countdownSec: 5 },
  variation: { enabled: false },
});

/** M5 browser-verification preset: variation ON with a full match cycle
 *  (placement → live → restart) inside ~2 wall-minutes, so an automation
 *  session can watch CONSECUTIVE matches draw different boards. Rumors are
 *  spiced hot (fast cadence, low thresholds) so pings appear within the
 *  first minute — numbers are for VERIFICATION, tuning lives in default. */
export const verify5Config: GameConfig = defineConfig({
  name: 'verify5',
  match: { durationSec: 90, placementSec: 15, countdownSec: 3, restartSec: 8 },
  rumors: { intervalSec: 8, richKeepGold: 200, carrierGold: 100 },
});

const presets: Record<string, GameConfig> = {
  default: defaultConfig,
  prototype: prototypeConfig,
  smoke: smokeConfig,
  verify: verifyConfig,
  verify5: verify5Config,
};

export function getConfigPreset(name: string): GameConfig {
  const cfg = presets[name];
  if (!cfg) {
    throw new Error(`Unknown config preset "${name}" (have: ${Object.keys(presets).join(', ')})`);
  }
  return cfg;
}

/** FNV-1a over the JSON of a config. Sent in `welcome`; mismatch = loud failure. */
export function configHash(cfg: GameConfig): string {
  const s = JSON.stringify(cfg);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
