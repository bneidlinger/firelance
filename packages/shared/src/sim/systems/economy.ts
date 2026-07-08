import type { GameConfig } from '../../config';
import type { LootSack, Player, SquadState, World } from '../world';

// The gold ledger. EVERY gold movement in the game routes through this file —
// that single chokepoint is what makes the conservation invariant
// (Σ minted === Σ keepGold + Σ carried + Σ banked + Σ sackGold) checkable
// every tick and impossible to silently violate. The four pools:
//   keepGold  — in the vault; raidable (M3 spills it); not the score
//   carried   — on a player's back; drops as a sack on death
//   banked    — deposited at a town; safe forever; THE score
//   sacks     — on the ground; anyone may take them (plunder is never taxed)

/** Mint new gold into a squad's keep vault. The only gold source in M1–M2. */
export function mintGoldToKeep(world: World, squadId: number, amount: number): void {
  if (amount <= 0) return;
  const squad = world.squads[squadId];
  if (!squad) return;
  world.goldMinted += amount;
  squad.keepGold += amount;
  squad.lifetimeGold += amount;
}

/** Sum of every gold pool in existence. Must equal world.goldMinted every tick. */
export function totalGoldInWorld(world: World): number {
  let sum = 0;
  for (const s of world.squads) sum += s.keepGold + s.bankedGold;
  for (const p of world.players.values()) sum += p.carried;
  for (const sack of world.sacks.values()) sum += sack.gold;
  return sum;
}

// ---------------------------------------------------------------- banking (M2)

/**
 * The 75% rule, enforced at the vault door: this much of the keep's gold may
 * leave right now. ceil(lifetime × reserveFraction) always stays home as raid
 * bait — but gold you LOOT off the ground never re-enters the keep, so
 * plundered wealth banks freely. Stealing is never taxed.
 */
export function withdrawableGold(cfg: GameConfig, squad: SquadState): number {
  const reserve = Math.ceil(squad.lifetimeGold * cfg.banking.reserveFraction);
  const w = squad.keepGold - reserve;
  return w > 0 ? w : 0;
}

/** Move up to `amount` keep→carried (bounded by the reserve rule). Returns moved gold. */
export function withdrawFromKeep(
  cfg: GameConfig,
  squad: SquadState,
  player: Player,
  amount: number,
): number {
  const take = Math.min(amount, withdrawableGold(cfg, squad));
  if (take <= 0) return 0;
  squad.keepGold -= take;
  player.carried += take;
  return take;
}

/** Deposit everything carried into the squad bank. Returns the banked amount. */
export function depositCarried(world: World, player: Player): number {
  const amount = player.carried;
  if (amount <= 0) return 0;
  player.carried = 0;
  world.squads[player.squad]!.bankedGold += amount;
  return amount;
}

/** Death spills the load: carried → a ground sack at the body. Null when empty-handed. */
export function dropCarriedAsSack(world: World, player: Player): LootSack | null {
  if (player.carried <= 0) return null;
  const sack: LootSack = {
    id: world.nextId++,
    x: player.x,
    y: player.y,
    gold: player.carried,
    bornTick: world.tick,
  };
  player.carried = 0;
  world.sacks.set(sack.id, sack);
  return sack;
}

/** Scoop a ground sack onto a player's back. */
export function pickupSack(world: World, player: Player, sack: LootSack): void {
  player.carried += sack.gold;
  world.sacks.delete(sack.id);
}

/**
 * Carrier walk-speed multiplier for a given load — the config slow curve.
 * Runs inside the PREDICTION path (client and server both), so: pure,
 * branch-simple, no trig. Dash is deliberately unaffected (the escape tool
 * stays; the walk home is what gets heavy).
 */
export function carrySpeedFactor(cfg: GameConfig, carried: number): number {
  if (carried <= 0) return 1;
  const f = 1 - (carried / 100) * cfg.banking.slowPer100Gold;
  const floor = cfg.banking.minSpeedFactor;
  return f < floor ? floor : f;
}

/** Bounty tier 0..5 (Nobody → Crownmarked) for HUD color/name lookups. */
export function bountyTier(cfg: GameConfig, bounty: number): number {
  const t = cfg.bounty.tierThresholds;
  let tier = 0;
  for (let i = 0; i < t.length; i++) {
    if (bounty >= t[i]!) tier = i;
  }
  return tier;
}

/**
 * Anti-farm reward multiplier for `killer` killing `victim` right now, and
 * bookkeeping for the diminishing-repeat-kill rule. Fresh spawns are worth
 * zero; the Nth repeat kill of the same victim inside the window decays
 * per cfg.bounty.repeatKillFactors.
 */
export function killRewardFactor(
  world: World,
  cfg: GameConfig,
  killer: Player,
  victim: Player,
): number {
  const hz = cfg.tick.simHz;
  const aliveTicks = world.tick - victim.spawnedAtTick;
  const fresh = aliveTicks < cfg.bounty.freshSpawnSec * hz;

  const windowTicks = cfg.bounty.repeatKillWindowSec * hz;
  const entry = killer.repeatKills.get(victim.id);
  let count = 1;
  if (entry && world.tick - entry.lastTick <= windowTicks) {
    count = entry.count + 1;
  }
  killer.repeatKills.set(victim.id, { count, lastTick: world.tick });

  if (fresh) return 0;
  const factors = cfg.bounty.repeatKillFactors;
  const idx = count - 1 < factors.length ? count - 1 : factors.length - 1;
  return factors[idx] ?? 0;
}

export interface KillEconomyResult {
  /** Total gold minted to the killer's squad (0 when farmed / no killer). */
  gold: number;
  /** Victim bounty at the moment of death, pre-decay (killfeed drama). */
  victimBounty: number;
}

/**
 * Settle the economy of a death: mint kill gold + bounty payout to the
 * killer's squad, raise the killer's own bounty, decay the victim's.
 * Killer-less deaths pay nobody and leave the victim's bounty intact —
 * dying to nothing must never dump a bounty (anti-farm).
 */
export function settleKillEconomy(
  world: World,
  cfg: GameConfig,
  killer: Player | null,
  victim: Player,
): KillEconomyResult {
  const victimBounty = victim.bounty;
  if (!killer || killer.squad === victim.squad) {
    return { gold: 0, victimBounty };
  }
  const factor = killRewardFactor(world, cfg, killer, victim);
  const gold = Math.round((cfg.bounty.killGold + victimBounty * cfg.bounty.payoutFactor) * factor);
  mintGoldToKeep(world, killer.squad, gold);
  killer.bounty += Math.round(cfg.bounty.killBounty * factor);
  victim.bounty = Math.floor(victimBounty * cfg.bounty.deathDecayTo);
  return { gold, victimBounty };
}
