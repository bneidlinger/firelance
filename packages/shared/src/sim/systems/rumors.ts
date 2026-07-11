import type { GameConfig } from '../../config';
import { secToTicks } from '../../config';
import type { MapData } from '../../map/types';
import { rngFloat } from '../../math/rng';
import type { RngState } from '../../math/rng';
import type { SimEvent } from '../events';
import type { World } from '../world';
import { PHASE_LIVE } from '../world';
import { bountyTier } from './economy';

// The rumor mill (M5, doc §7.2/§12/§18.1): information as pressure. Every
// intervalSec — staggered per subject so pings trickle instead of chorusing —
// three kinds of secret leak to the WHOLE map as fuzzed positions:
//   bounty   — tier ≥ bountyTier (Hunted+): "seen near..."
//   carrier  — tier ≥ carrierTier hauling ≥ carrierGold: the banking alert
//   richKeep — a living keep with vault ≥ richKeepGold: turtles buy attention
// The fuzz is a per-axis sum-of-three-uniforms (σ = fuzzRadius, hard ±3σ cap,
// no trig) drawn from world.rng — rumors are part of the deterministic sim.
// Stateless by design: the stagger derives from (tick, subject id), so
// serializeWorld needs no new fields.

/** Pseudo-gaussian offset: Irwin-Hall n=3 recentered, scaled to σ = fuzz. */
function fuzzed(rng: RngState, v: number, fuzz: number, lo: number, hi: number): number {
  const g = rngFloat(rng) + rngFloat(rng) + rngFloat(rng) - 1.5; // σ = 0.5, |g| ≤ 1.5
  const out = v + g * 2 * fuzz;
  return out < lo ? lo : out > hi ? hi : out;
}

export function stepRumors(world: World, cfg: GameConfig, map: MapData, events: SimEvent[]): void {
  if (!cfg.rumors.enabled || world.phase !== PHASE_LIVE) return;
  const interval = secToTicks(cfg, cfg.rumors.intervalSec);
  const maxX = map.width - 0.5;
  const maxY = map.height - 0.5;

  for (const p of world.players.values()) {
    if (!p.alive) continue;
    // Per-subject phase offset: the town crier names one name at a time.
    if ((world.tick + p.id * 37) % interval !== 0) continue;
    const tier = bountyTier(cfg, p.bounty);
    const carrier = tier >= cfg.rumors.carrierTier && p.carried >= cfg.rumors.carrierGold;
    if (tier < cfg.rumors.bountyTier && !carrier) continue;
    // Higher tiers leak sharper positions (doc: "stronger regional hints").
    const fuzz =
      cfg.rumors.fuzzRadius *
      Math.pow(cfg.rumors.fuzzTierFactor, Math.max(0, tier - cfg.rumors.bountyTier));
    events.push({
      k: 'rumor',
      tk: world.tick,
      kind: carrier ? 'carrier' : 'bounty',
      id: p.id,
      squad: p.squad,
      x: fuzzed(world.rng, p.x, fuzz, 0.5, maxX),
      y: fuzzed(world.rng, p.y, fuzz, 0.5, maxY),
      tier,
    });
  }

  // Rich keeps gossip on their own SLOWER clock — a vault sits fat for
  // minutes at a time; player-cadence pings drowned the killfeed.
  const richInterval = secToTicks(cfg, cfg.rumors.richKeepIntervalSec);
  for (const s of world.squads) {
    if (s.eliminated || s.keepHp <= 0 || s.keepGold < cfg.rumors.richKeepGold) continue;
    // Offset keeps squad pings off the player-ping ticks (and each other's).
    if ((world.tick + (s.id + 101) * 53) % richInterval !== 0) continue;
    events.push({
      k: 'rumor',
      tk: world.tick,
      kind: 'richKeep',
      id: -1,
      squad: s.id,
      x: fuzzed(world.rng, s.keepX, cfg.rumors.fuzzRadius, 0.5, maxX),
      y: fuzzed(world.rng, s.keepY, cfg.rumors.fuzzRadius, 0.5, maxY),
      tier: 0,
    });
  }
}
