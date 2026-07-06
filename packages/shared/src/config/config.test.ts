import { describe, expect, it } from 'vitest';
import {
  configHash,
  defaultConfig,
  defineConfig,
  getConfigPreset,
  prototypeConfig,
  smokeConfig,
} from './index';

describe('config presets', () => {
  it('deep-merges overrides without touching unrelated branches', () => {
    const cfg = defineConfig({ match: { durationSec: 60 } });
    expect(cfg.match.durationSec).toBe(60);
    expect(cfg.match.squads).toBe(defaultConfig.match.squads);
    expect(cfg.player.moveSpeed).toBe(defaultConfig.player.moveSpeed);
    // base is untouched
    expect(defaultConfig.match.durationSec).not.toBe(60);
  });

  it('presets resolve by name', () => {
    expect(getConfigPreset('default')).toBe(defaultConfig);
    expect(getConfigPreset('prototype')).toBe(prototypeConfig);
    expect(getConfigPreset('smoke')).toBe(smokeConfig);
    expect(() => getConfigPreset('nope')).toThrow(/Unknown config preset/);
  });

  it('prototype and smoke are compressed variants', () => {
    expect(prototypeConfig.match.durationSec).toBeLessThan(defaultConfig.match.durationSec);
    expect(smokeConfig.match.durationSec).toBeLessThan(prototypeConfig.match.durationSec);
    expect(smokeConfig.match.countdownSec).toBe(0);
  });

  it('configHash is stable for equal configs and differs across presets', () => {
    expect(configHash(defaultConfig)).toBe(configHash(defineConfig({})));
    expect(configHash(defaultConfig)).not.toBe(configHash(prototypeConfig));
  });
});
