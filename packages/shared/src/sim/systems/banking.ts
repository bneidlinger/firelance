import type { GameConfig } from '../../config';
import { secToTicks } from '../../config';
import type { MapData } from '../../map/types';
import type { SimEvent } from '../events';
import type { World } from '../world';
import { ATK_IDLE, BTN_FIRE, BTN_INTERACT, PHASE_LIVE } from '../world';
import { depositCarried, pickupSack, withdrawFromKeep } from './economy';

// The banking run, tick by tick. Three interactions, all driven by position +
// the interact button (gold mutations route through economy.ts):
//   withdraw — hold interact inside your own keep's radius: gold trickles
//              keep→carried at withdrawPerSec, stopping at the reserve floor.
//              Walking while loading is allowed; the RISK is the journey.
//   deposit  — hold interact inside a town's radius: a stand-still channel.
//              Any movement input, dash, attack, or point of damage resets it.
//              Completing it banks EVERYTHING carried — the payoff moment.
//   pickup   — walking over a ground sack scoops it automatically, any squad.
//              Runs even for non-interacting players (loot is irresistible).
//
// Runs after attacks/projectiles (same-tick damage must break the channel)
// and before lifecycle (a player who died this tick never banks).

const STILL_EPS = 0.01; // move input below this counts as standing still

export function stepBanking(world: World, cfg: GameConfig, map: MapData, events: SimEvent[]): void {
  if (world.phase !== PHASE_LIVE) return;

  const interactR2 = cfg.banking.interactRadius * cfg.banking.interactRadius;
  const pickupR2 = cfg.banking.sackPickupRadius * cfg.banking.sackPickupRadius;
  const channelTicks = secToTicks(cfg, cfg.banking.bankChannelSec);
  const hz = cfg.tick.simHz;
  const withdrawPerTick = Math.max(1, Math.round(cfg.banking.withdrawPerSec / hz));

  for (const p of world.players.values()) {
    if (!p.alive) continue;

    // ---- sack pickup: automatic on contact, friend or foe.
    for (const sack of world.sacks.values()) {
      const dx = sack.x - p.x;
      const dy = sack.y - p.y;
      if (dx * dx + dy * dy > pickupR2) continue;
      const gold = sack.gold;
      pickupSack(world, p, sack);
      events.push({
        k: 'sackTaken',
        tk: world.tick,
        id: sack.id,
        by: p.id,
        squad: p.squad,
        gold,
        x: sack.x,
        y: sack.y,
      });
    }

    if ((p.input.b & BTN_INTERACT) === 0) {
      p.bankTicks = 0;
      continue;
    }

    // ---- withdraw: trickle-load at your own keep.
    const squad = world.squads[p.squad]!;
    {
      const dx = squad.keepX - p.x;
      const dy = squad.keepY - p.y;
      if (dx * dx + dy * dy <= interactR2) {
        withdrawFromKeep(cfg, squad, p, withdrawPerTick);
      }
    }

    // ---- deposit: stand-still channel at any town.
    let atTown = false;
    for (const t of map.towns) {
      const dx = t.x - p.x;
      const dy = t.y - p.y;
      if (dx * dx + dy * dy <= interactR2) {
        atTown = true;
        break;
      }
    }
    if (!atTown || p.carried <= 0) {
      p.bankTicks = 0;
      continue;
    }
    const still =
      p.input.mx > -STILL_EPS &&
      p.input.mx < STILL_EPS &&
      p.input.my > -STILL_EPS &&
      p.input.my < STILL_EPS &&
      p.dashTicks <= 0;
    const fighting = p.atkPhase !== ATK_IDLE || (p.input.b & BTN_FIRE) !== 0;
    const damagedThisTick = p.lastDamagedTick === world.tick;
    if (!still || fighting || damagedThisTick) {
      p.bankTicks = 0;
      continue;
    }
    p.bankTicks++;
    if (p.bankTicks >= channelTicks) {
      p.bankTicks = 0;
      const amount = depositCarried(world, p);
      events.push({
        k: 'banked',
        tk: world.tick,
        squad: p.squad,
        by: p.id,
        amount,
        x: p.x,
        y: p.y,
      });
    }
  }
}
