import type { GameConfig } from '../../config';
import { secToTicks } from '../../config';
import type { MapData } from '../../map/types';
import type { SimEvent } from '../events';
import type { Player, SquadState, World } from '../world';
import { ATK_IDLE, BTN_FIRE, BTN_INTERACT, PHASE_LIVE } from '../world';
import { depositCarried, payRebuildCost, pickupSack, withdrawFromKeep } from './economy';

// The interaction system, tick by tick. Everything driven by position + the
// interact button (gold mutations route through economy.ts):
//   withdraw — hold interact inside your own keep's radius: gold trickles
//              keep→carried at withdrawPerSec, stopping at the reserve floor.
//              Walking while loading is allowed; the RISK is the journey.
//   deposit  — hold interact inside a town's radius: a stand-still channel.
//              Any movement input, dash, attack, or point of damage resets it.
//              Completing it banks EVERYTHING carried — the payoff moment.
//   pickup   — walking over a ground sack scoops it automatically, any squad.
//              Runs even for non-interacting players (loot is irresistible).
//   restock  — standing inside your own (living) keep circle refills bombs.
//   rebuild  — M3 exile comeback: hold interact at an UNOCCUPIED keep site
//              with the cost on your back; same stand-still channel rules.
//              The cost transfers into the new vault — born as raid bait.
//
// Runs after attacks/projectiles/bombs (same-tick damage must break channels)
// and before lifecycle (a player who died this tick never banks).

const STILL_EPS = 0.01; // move input below this counts as standing still

export function stepBanking(world: World, cfg: GameConfig, map: MapData, events: SimEvent[]): void {
  if (world.phase !== PHASE_LIVE) return;

  const interactR2 = cfg.banking.interactRadius * cfg.banking.interactRadius;
  const pickupR2 = cfg.banking.sackPickupRadius * cfg.banking.sackPickupRadius;
  const channelTicks = secToTicks(cfg, cfg.banking.bankChannelSec);
  const rebuildTicksTotal = secToTicks(cfg, cfg.keep.rebuildChannelSec);
  const hz = cfg.tick.simHz;
  const withdrawPerTick = Math.max(1, Math.round(cfg.banking.withdrawPerSec / hz));

  for (const p of world.players.values()) {
    if (!p.alive) continue;
    const squad = world.squads[p.squad]!;

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

    const nearOwnKeep = (() => {
      const dx = squad.keepX - p.x;
      const dy = squad.keepY - p.y;
      return dx * dx + dy * dy <= interactR2;
    })();

    // ---- restock: automatic inside your own (living) keep circle.
    if (nearOwnKeep && squad.keepHp > 0 && p.bombs < cfg.firebomb.carried) {
      p.bombs = cfg.firebomb.carried;
    }

    if ((p.input.b & BTN_INTERACT) === 0) {
      p.bankTicks = 0;
      p.rebuildTicks = 0;
      continue;
    }

    // ---- withdraw: trickle-load at your own keep (walking allowed).
    if (nearOwnKeep && squad.keepHp > 0) {
      withdrawFromKeep(cfg, squad, p, withdrawPerTick);
    }

    // Shared channel-break rules: any movement, dash, attack, or damage.
    const still =
      p.input.mx > -STILL_EPS &&
      p.input.mx < STILL_EPS &&
      p.input.my > -STILL_EPS &&
      p.input.my < STILL_EPS &&
      p.dashTicks <= 0;
    const fighting = p.atkPhase !== ATK_IDLE || (p.input.b & BTN_FIRE) !== 0;
    const broken = !still || fighting || p.lastDamagedTick === world.tick;

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
    if (atTown && p.carried > 0 && !broken) {
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
    } else {
      p.bankTicks = 0;
    }

    // ---- rebuild: the exile comeback channel at an unoccupied keep site.
    let rebuilding = false;
    if (
      squad.keepHp <= 0 &&
      squad.rebuildsLeft > 0 &&
      p.carried >= cfg.keep.rebuildCost &&
      !broken
    ) {
      const site = unoccupiedSiteNear(world, map, p, interactR2);
      if (site) {
        rebuilding = true;
        p.rebuildTicks++;
        if (p.rebuildTicks >= rebuildTicksTotal) {
          p.rebuildTicks = 0;
          completeRebuild(world, cfg, squad, p, site, events);
        }
      }
    }
    if (!rebuilding) p.rebuildTicks = 0;
  }
}

/** A keep SITE within reach that no living keep currently occupies (your own
 *  ruin qualifies — rebuilding on the ashes is allowed). */
function unoccupiedSiteNear(
  world: World,
  map: MapData,
  p: Player,
  interactR2: number,
): { x: number; y: number } | null {
  for (const site of map.keeps) {
    const dx = site.x - p.x;
    const dy = site.y - p.y;
    if (dx * dx + dy * dy > interactR2) continue;
    let occupied = false;
    for (const s of world.squads) {
      if (s.keepHp <= 0) continue;
      const ddx = s.keepX - site.x;
      const ddy = s.keepY - site.y;
      if (ddx * ddx + ddy * ddy < 4) {
        occupied = true;
        break;
      }
    }
    if (!occupied) return site;
  }
  return null;
}

function completeRebuild(
  world: World,
  cfg: GameConfig,
  squad: SquadState,
  builder: Player,
  site: { x: number; y: number },
  events: SimEvent[],
): void {
  payRebuildCost(world, builder, cfg.keep.rebuildCost);
  squad.rebuildsLeft--;
  squad.keepX = site.x;
  squad.keepY = site.y;
  squad.keepHp = Math.round(cfg.keep.maxHp * cfg.keep.rebuildHpFactor);
  squad.lastAlarmTick = -1_000_000;
  // The dead can come home: fresh respawn timers from the completion moment
  // (no instant teleport-army — the comeback arrives in waves).
  const respawnTicks = secToTicks(cfg, cfg.player.respawnSec);
  for (const q of world.players.values()) {
    if (q.squad === squad.id && !q.alive) {
      q.respawnAtTick = world.tick + respawnTicks;
    }
  }
  events.push({
    k: 'keepRebuilt',
    tk: world.tick,
    squad: squad.id,
    x: site.x,
    y: site.y,
    by: builder.id,
  });
}
