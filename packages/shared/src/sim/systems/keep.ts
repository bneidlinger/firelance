import type { GameConfig } from '../../config';
import { secToTicks } from '../../config';
import type { SimEvent } from '../events';
import type { SquadState, World } from '../world';
import { spillVault } from './economy';

// The single entry point for structure damage (bombs, melee chip; siege tools
// in M4). Owns the under-attack alarm throttle and the destruction moment:
// vault spills onto the ground, respawns stop (lifecycle gates on keepHp),
// the squad fights on in exile.

export function damageKeep(
  world: World,
  cfg: GameConfig,
  squad: SquadState,
  amount: number,
  events: SimEvent[],
): void {
  if (squad.keepHp <= 0 || amount <= 0) return;
  squad.keepHp -= amount;

  if (squad.keepHp > 0) {
    // Under-attack alarm to the owners, throttled so a bombardment doesn't spam.
    const cdTicks = secToTicks(cfg, cfg.keep.alarmCooldownSec);
    if (world.tick - squad.lastAlarmTick >= cdTicks) {
      squad.lastAlarmTick = world.tick;
      events.push({
        k: 'keepHit',
        tk: world.tick,
        squad: squad.id,
        hp: squad.keepHp,
        x: squad.keepX,
        y: squad.keepY,
      });
    }
    return;
  }

  squad.keepHp = 0;
  const spilled = spillVault(world, squad);
  events.push({
    k: 'keepDestroyed',
    tk: world.tick,
    squad: squad.id,
    x: squad.keepX,
    y: squad.keepY,
    spilled,
  });
}

/** Enemy keeps standing within `reach` of a point (attack hit-testing). */
export function keepsInRange(
  world: World,
  cfg: GameConfig,
  x: number,
  y: number,
  reach: number,
  attackerSquad: number,
): SquadState[] {
  const hit: SquadState[] = [];
  const r = reach + cfg.keep.radius;
  for (const s of world.squads) {
    if (s.id === attackerSquad || s.keepHp <= 0) continue;
    const dx = s.keepX - x;
    const dy = s.keepY - y;
    if (dx * dx + dy * dy <= r * r) hit.push(s);
  }
  return hit;
}
