import type { GameConfig } from '../../config';
import { secToTicks } from '../../config';
import type { MapData } from '../../map/types';
import type { SimEvent } from '../events';
import type { SquadState, World } from '../world';
import { ATK_IDLE, BTN_FIRE, BTN_INTERACT, PHASE_PLACEMENT } from '../world';

// The keep-placement claim (M4): during the placement phase, any squad member
// may stand at an unclaimed keep site and hold interact — a stand-still
// channel, same break rules as banking (movement, dash, fighting; damage
// can't happen pre-live). Completing it plants the squad's keep there, once
// per squad, first squad to finish wins a contested site. Squads that never
// claim get auto-assigned when the phase expires (phase.ts owns that).

const STILL_EPS = 0.01;

/** Is this site index already claimed by any squad? */
export function siteClaimed(world: World, siteIdx: number): boolean {
  for (const s of world.squads) {
    if (s.claimedSite === siteIdx) return true;
  }
  return false;
}

/** Nearest unclaimed site within reach of (x,y), or -1. */
export function claimableSiteNear(
  world: World,
  map: MapData,
  x: number,
  y: number,
  reachR2: number,
): number {
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < map.keeps.length; i++) {
    if (siteClaimed(world, i)) continue;
    const site = map.keeps[i]!;
    const dx = site.x - x;
    const dy = site.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= reachR2 && d2 < bestD) {
      bestD = d2;
      best = i;
    }
  }
  return best;
}

/** Plant a squad's keep on a site: the single mutation path for claims —
 *  the channel completion AND the deadline auto-assign both route through here. */
export function plantKeep(
  world: World,
  squad: SquadState,
  map: MapData,
  siteIdx: number,
  by: number | null,
  events: SimEvent[],
): void {
  const site = map.keeps[siteIdx]!;
  squad.claimedSite = siteIdx;
  squad.keepX = site.x;
  squad.keepY = site.y;
  events.push({ k: 'keepClaimed', tk: world.tick, squad: squad.id, x: site.x, y: site.y, by });
}

export function stepClaims(world: World, cfg: GameConfig, map: MapData, events: SimEvent[]): void {
  if (world.phase !== PHASE_PLACEMENT) return;

  const reachR2 = cfg.banking.interactRadius * cfg.banking.interactRadius;
  const channelTicks = secToTicks(cfg, cfg.keep.claimChannelSec);

  for (const p of world.players.values()) {
    if (!p.alive) continue;
    const squad = world.squads[p.squad]!;

    // One claim per squad, final — and channels need the button held.
    if (squad.claimedSite >= 0 || (p.input.b & BTN_INTERACT) === 0) {
      p.claimTicks = 0;
      p.claimSiteIdx = -1;
      continue;
    }

    // Same stand-still rules as the bank channel (banking.ts): any movement
    // input, dash, or fire intent resets. No damage pre-live, so no damage rule.
    const still =
      p.input.mx > -STILL_EPS &&
      p.input.mx < STILL_EPS &&
      p.input.my > -STILL_EPS &&
      p.input.my < STILL_EPS &&
      p.dashTicks <= 0;
    const fighting = p.atkPhase !== ATK_IDLE || (p.input.b & BTN_FIRE) !== 0;

    const siteIdx = still && !fighting ? claimableSiteNear(world, map, p.x, p.y, reachR2) : -1;
    // Progress is PER SITE: retargeting (including "my site just got sniped")
    // restarts the channel — 29 ticks on one hill must never finish another.
    if (siteIdx !== p.claimSiteIdx) {
      p.claimTicks = 0;
      p.claimSiteIdx = siteIdx;
    }
    if (siteIdx < 0) continue;

    p.claimTicks++;
    if (p.claimTicks >= channelTicks) {
      p.claimTicks = 0;
      p.claimSiteIdx = -1;
      plantKeep(world, squad, map, siteIdx, p.id, events);
    }
  }
}
