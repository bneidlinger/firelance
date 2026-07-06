import type { GameConfig } from './types';

/** Full-length match values (25–35 min target once all systems land). */
export const defaultConfig: GameConfig = {
  name: 'default',
  tick: {
    simHz: 30,
    snapshotEveryTicks: 2,
  },
  match: {
    squads: 4,
    playersPerSquad: 3,
    durationSec: 30 * 60,
    countdownSec: 10,
  },
  player: {
    radius: 0.4,
    moveSpeed: 5,
    maxHp: 100,
    respawnSec: 8,
  },
};
