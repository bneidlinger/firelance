import type { GameConfig } from './types';

/** Full-length match values (25–35 min target once all systems land). */
export const defaultConfig: GameConfig = {
  name: 'default',
  tick: {
    simHz: 30,
    snapshotEveryTicks: 2,
    scoreEveryTicks: 15, // 2Hz
  },
  match: {
    squads: 4,
    playersPerSquad: 3,
    durationSec: 30 * 60,
    placementSec: 30,
    countdownSec: 10,
    restartSec: 30,
  },
  player: {
    radius: 0.4,
    moveSpeed: 5,
    maxHp: 100,
    respawnSec: 8,
  },
  classes: {
    // Fighter: frontline. Slightly faster than the ranger so melee can close;
    // tanks arrows behind the shield, deletes rangers in three clean swings.
    fighter: {
      maxHp: 130,
      moveSpeed: 5.2,
      dash: { speed: 18, durationSec: 0.16, cooldownSec: 3 },
      melee: {
        damage: 34,
        range: 1.8,
        arcCosHalf: 0.5, // 120°
        windupSec: 0.22, // the dodgeable telegraph
        activeSec: 0.15,
        recoverySec: 0.25,
        cooldownSec: 0.2, // gap after recovery before the next windup
      },
      shield: { damageFactor: 0.3, moveFactor: 0.45, arcCosHalf: 0.5 },
    },
    // Ranger: dodgeable-projectile damage at range. Arrow flight time from
    // 10–12 units (~0.75s) leaves room to strafe on reaction at fakelag 120.
    ranger: {
      maxHp: 90,
      moveSpeed: 5,
      dash: { speed: 20, durationSec: 0.15, cooldownSec: 2.5 },
      bow: { damage: 26, speed: 14, cooldownSec: 0.75, ttlSec: 1.6, radius: 0.15 },
    },
    // Engineer: the building specialist (M4 s3). Crossbow: flatter and faster
    // than the bow (harder to dodge) but ~half the dps — a support sidearm,
    // not a duelist's weapon. The real kit is B/G/T + 2x repairs.
    engineer: {
      maxHp: 100,
      moveSpeed: 5,
      dash: { speed: 18, durationSec: 0.15, cooldownSec: 3 },
      bow: { damage: 20, speed: 17, cooldownSec: 1.1, ttlSec: 0.75, radius: 0.15 },
    },
  },
  combat: {
    friendlyFire: false,
    regenPerSec: 10,
    regenDelaySec: 6,
    assistWindowSec: 8,
  },
  bounty: {
    killGold: 50,
    killBounty: 30,
    assistBounty: 15,
    survivalBounty: 1,
    survivalTickSec: 5,
    payoutFactor: 1,
    deathDecayTo: 0.25,
    freshSpawnSec: 10,
    repeatKillFactors: [1, 0.5, 0.25, 0],
    repeatKillWindowSec: 90,
    tierThresholds: [0, 50, 150, 300, 500, 800],
  },
  keep: {
    maxHp: 1200,
    radius: 1.3,
    meleeDamage: 8,
    alarmCooldownSec: 5,
    claimChannelSec: 3,
    rebuildCost: 250,
    rebuildChannelSec: 8,
    rebuildHpFactor: 0.6,
  },
  // ~8 committed bombs to crack a keep (3 besiegers ≈ 40s under fire, plus
  // restock trips) — a siege is a decision, not a drive-by.
  firebomb: {
    damage: 150,
    playerDamage: 15,
    radius: 1.6,
    range: 7,
    flightSec: 0.6,
    cooldownSec: 3,
    carried: 2,
  },
  banking: {
    withdrawPerSec: 300,
    reserveFraction: 0.25,
    interactRadius: 2.5,
    bankChannelSec: 4,
    slowPer100Gold: 0.035, // 500g = −17.5%; floor at 1430g+
    minSpeedFactor: 0.5,
    sackPickupRadius: 0.9,
  },
  vision: {
    radius: 14,
    forestRadius: 4,
  },
  // Build supply trickles from a LIVING keep (design Q#11): lose the keep, lose
  // the tap. supplyStart ≈ 3 walls up front; a wall eats 2 firebombs (hp 200 vs
  // firebomb 150). maxCount + cost + cooldown throttle fortress spam — the M4
  // gate ("walls change siege texture WITHOUT stalemating") lives in these numbers.
  build: {
    supplyStart: 120,
    supplyPerSec: 2,
    supplyCap: 300,
    enemyKeepExclusion: 6,
    reach: 2,
    cooldownSec: 1.5,
    meleeChip: 8,
    wall: { cost: 40, hp: 200, maxCount: 8 },
    // Engineer-only. Gate: a door for your squad's bodies, a wall for everyone
    // else's (and for ALL vision/arrows). Tower: a static extra pair of eyes —
    // player vision rules from a fixed post, NO auto-attack (design doc).
    gate: { cost: 60, hp: 200, maxCount: 2 },
    tower: { cost: 80, hp: 150, maxCount: 2 },
    // Repairs eat supply (doc §9.4). Engineer patches 2x per hit — the
    // specialist keeps a fort standing on half the supply bill.
    repair: { hpPerHit: 25, cost: 4, engineerFactor: 2 },
  },
};
