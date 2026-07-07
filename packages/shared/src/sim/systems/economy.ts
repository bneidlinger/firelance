import type { GameConfig } from '../../config';
import type { Player, World } from '../world';

// The gold ledger. EVERY gold movement in the game routes through this file —
// that single chokepoint is what makes the conservation invariant
// (Σ minted === Σ keepGold + Σ carried + Σ banked + Σ groundLoot, M1: keeps
// only) checkable every tick and impossible to silently violate.

/** Mint new gold into a squad's keep vault. The only source of gold in M1. */
export function mintGoldToKeep(world: World, squadId: number, amount: number): void {
  if (amount <= 0) return;
  const squad = world.squads[squadId];
  if (!squad) return;
  world.goldMinted += amount;
  squad.keepGold += amount;
}

/** Sum of every gold pool in existence (grows per milestone: carried, banked, loot). */
export function totalGoldInWorld(world: World): number {
  let sum = 0;
  for (const s of world.squads) sum += s.keepGold;
  return sum;
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
