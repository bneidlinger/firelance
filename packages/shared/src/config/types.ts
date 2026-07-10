// Every gameplay tunable lives here. Sim systems receive GameConfig as a
// parameter — nothing under sim/ imports constants directly. Balancing the
// game means editing presets, never logic.
//
// Angles are stored as COSINES of the half-angle (e.g. 120° arc => cos(60°)
// = 0.5) so the sim tests membership with dot products and never calls trig.

export type ClassId = 'fighter' | 'ranger' | 'engineer';

export interface DashConfig {
  /** Dash travel speed (units/sec). Displacement = speed × duration. */
  speed: number;
  durationSec: number;
  cooldownSec: number;
}

export interface MeleeConfig {
  damage: number;
  /** Center-to-center reach (player radius added on top). */
  range: number;
  /** cos(halfArc): 0.5 => 120° total arc. */
  arcCosHalf: number;
  windupSec: number;
  activeSec: number;
  recoverySec: number;
  cooldownSec: number;
}

export interface BowConfig {
  damage: number;
  /** Projectile speed (units/sec). */
  speed: number;
  cooldownSec: number;
  /** Time-to-live; max range = speed × ttl. */
  ttlSec: number;
  /** Projectile collision radius. */
  radius: number;
}

export interface ShieldConfig {
  /** Damage multiplier for blocked hits (0.3 => 70% reduction). */
  damageFactor: number;
  /** Move speed multiplier while holding block. */
  moveFactor: number;
  /** cos(halfArc) of the protected frontal sector. */
  arcCosHalf: number;
}

export interface ClassKit {
  maxHp: number;
  moveSpeed: number;
  dash: DashConfig;
  melee?: MeleeConfig;
  bow?: BowConfig;
  shield?: ShieldConfig;
}

/** Cost/durability/cap for one placeable structure kind. */
export interface StructKindConfig {
  /** Build-supply consumed per placement. */
  cost: number;
  /** Hit points (firebomb.damage vs this sets the bombs-to-kill count). */
  hp: number;
  /** Per-squad cap on standing pieces of this kind (fortress-spam guard). */
  maxCount: number;
}

/** The Engineer's snare (doc §9.2/§12.1): invisible to enemies, consumed on
 *  the first enemy who steps on it once armed — damage plus a short root. */
export interface TrapConfig extends StructKindConfig {
  /** Damage to the victim who trips it (bypasses shields — it's under you). */
  damage: number;
  /** How long the victim is rooted (walk zeroed, dash blocked). */
  rootSec: number;
  /** Delay between placement and going live — no face-planting mid-duel. */
  armSec: number;
  /** Trigger distance from tile center to an enemy's center. */
  triggerRadius: number;
}

export interface BuildConfig {
  /** Build-supply each squad starts a live match with. */
  supplyStart: number;
  /** Build-supply a LIVING keep generates per second (stops when it falls). */
  supplyPerSec: number;
  /** Ceiling on a squad's build-supply pool. */
  supplyCap: number;
  /** Nothing may be placed within this many units of an ENEMY keep. */
  enemyKeepExclusion: number;
  /** How far in front of the builder a placement lands (units; all kinds). */
  reach: number;
  /** Per-builder cooldown between build actions (place OR repair). */
  cooldownSec: number;
  /** Structure damage per melee swing (desperation chip; all kinds). */
  meleeChip: number;
  /** All classes build walls; gate/tower/trap are Engineer-only (doc §9.2). */
  wall: StructKindConfig;
  gate: StructKindConfig;
  tower: StructKindConfig;
  trap: TrapConfig;
  repair: {
    /** Hp restored per build-button hit on a damaged own structure. */
    hpPerHit: number;
    /** Supply consumed per repair hit (doc §9.4: repairs eat supply). */
    cost: number;
    /** Engineer repair multiplier (doc: the specialist repairs faster). */
    engineerFactor: number;
  };
}

export interface GameConfig {
  /** Preset name, included in cfgHash so client/server mismatches fail loudly. */
  name: string;

  tick: {
    /** Server simulation rate (Hz). */
    simHz: number;
    /** Snapshots every N sim ticks (2 => 15Hz at 30Hz sim). */
    snapshotEveryTicks: number;
    /** Score/leaderboard broadcast every N sim ticks. */
    scoreEveryTicks: number;
  };

  match: {
    squads: number;
    playersPerSquad: number;
    /** Match length in seconds once live. */
    durationSec: number;
    /** Keep-placement window before the countdown: squads spawn at their map
     *  corners and may claim a keep site; unclaimed squads are auto-assigned
     *  when it expires. 0 = skip (auto-assign immediately, M0–M3 behavior). */
    placementSec: number;
    /** Countdown before the match goes live. */
    countdownSec: number;
    /** Pause on the end screen before the server restarts the match. */
    restartSec: number;
  };

  player: {
    radius: number;
    /** Fallback move speed; class kits override. */
    moveSpeed: number;
    /** Fallback max hp; class kits override. */
    maxHp: number;
    respawnSec: number;
  };

  classes: Record<ClassId, ClassKit>;

  combat: {
    friendlyFire: boolean;
    /** Hp/sec regenerated after not taking damage for regenDelaySec. */
    regenPerSec: number;
    regenDelaySec: number;
    /** Damage within this window before a death counts as an assist. */
    assistWindowSec: number;
  };

  bounty: {
    /** Base gold minted to the killer's squad keep per kill. */
    killGold: number;
    /** Bounty gained by the killer per kill. */
    killBounty: number;
    /** Bounty gained per assist (credit only — never gold; single-mint ledger). */
    assistBounty: number;
    /** Bounty gained per survivalTickSec survived while alive and live. */
    survivalBounty: number;
    survivalTickSec: number;
    /** Victim bounty × this mints to the killer's squad on top of killGold. */
    payoutFactor: number;
    /** Victim keeps this fraction of their bounty after dying. */
    deathDecayTo: number;
    /** Kills on victims alive less than this are worth zero (anti-farm). */
    freshSpawnSec: number;
    /** Reward multiplier for the Nth kill of the SAME victim inside the window. */
    repeatKillFactors: number[];
    repeatKillWindowSec: number;
    /** Bounty thresholds for tiers 0..5 (Nobody → Crownmarked). */
    tierThresholds: number[];
  };

  keep: {
    /** Structure hit points. Siege pacing hangs off this. */
    maxHp: number;
    /** Hit-test circle around the keep site center (bombs/melee). */
    radius: number;
    /** Structure damage per landed melee swing (desperation chip; bombs are the tool). */
    meleeDamage: number;
    /** Min seconds between under-attack alarms to the owning squad. */
    alarmCooldownSec: number;
    /** Stand-still channel to claim a keep site during the placement phase. */
    claimChannelSec: number;
    /** Carried gold consumed by the emergency rebuild (transfers INTO the new vault). */
    rebuildCost: number;
    /** Stand-still channel length for the rebuild. */
    rebuildChannelSec: number;
    /** The rebuilt keep starts at this fraction of maxHp. */
    rebuildHpFactor: number;
  };

  firebomb: {
    /** Structure damage at impact. */
    damage: number;
    /** Damage to players inside the blast (friendly fire still off). */
    playerDamage: number;
    /** Blast radius (units). */
    radius: number;
    /** Max throw distance; shorter aims land at the aim point. */
    range: number;
    /** Lob flight time — the dodge/scatter window. */
    flightSec: number;
    cooldownSec: number;
    /** Bombs carried; restocked while inside your own keep circle. */
    carried: number;
  };

  banking: {
    /** Gold loaded keep→carried per second while holding interact at own keep. */
    withdrawPerSec: number;
    /** Fraction of lifetime earnings locked in the keep as raid bait (the 75% rule). */
    reserveFraction: number;
    /** Interact range around keep and town tile centers. */
    interactRadius: number;
    /** Deposit channel length — stand still at a town holding interact. */
    bankChannelSec: number;
    /** Walk-speed penalty per 100 carried gold (0.03 => −3%/100g). Dash unaffected. */
    slowPer100Gold: number;
    /** Carrier speed never drops below this fraction. */
    minSpeedFactor: number;
    /** Walking this close to a loot sack picks it up. */
    sackPickupRadius: number;
  };

  vision: {
    /** Standard vision radius (units). */
    radius: number;
    /** Targets standing in forest are only visible inside this radius. */
    forestRadius: number;
  };

  build: BuildConfig;
}

export type GameConfigOverrides = DeepPartial<GameConfig>;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Seconds → whole sim ticks (rounded, min 1 for any positive duration). */
export function secToTicks(cfg: GameConfig, sec: number): number {
  const t = Math.round(sec * cfg.tick.simHz);
  return sec > 0 && t < 1 ? 1 : t;
}

export function getKit(cfg: GameConfig, cls: ClassId): ClassKit {
  return cfg.classes[cls];
}
