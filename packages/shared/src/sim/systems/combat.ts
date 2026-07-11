import type { GameConfig } from '../../config';
import { getKit, secToTicks } from '../../config';
import type { SimEvent } from '../events';
import type { Player, PlayerId, World } from '../world';
import { ATK_IDLE } from '../world';
import { isBlocking } from './movement';
import { dropCarriedAsSack, settleKillEconomy } from './economy';

// Damage application and death resolution — the single path every point of
// damage takes regardless of source (arrow, melee; firebomb in M3). Keeping
// one entry point is what makes shield math, assist credit, and the death
// economy impossible to fork.

/**
 * Apply damage from attacker to victim. Handles shield blocking, hit events,
 * assist bookkeeping, and death. Callers guarantee: victim alive, attacker
 * alive at fire time (bombs: at THROW time), phase is live, and squads differ
 * (unless friendlyFire). `attacker` is null ONLY for a trap whose builder has
 * left the match — the trap still bites, the kill just credits nobody.
 */
export function applyDamage(
  world: World,
  cfg: GameConfig,
  attacker: Player | null,
  victim: Player,
  rawAmount: number,
  kind: 'arrow' | 'melee' | 'bomb' | 'trap',
  events: SimEvent[],
): void {
  if (!victim.alive) return;
  if (!cfg.combat.friendlyFire && attacker && attacker.squad === victim.squad) return;

  // Shield: victim blocking and the attacker sits inside the frontal sector.
  // Bomb blasts are omnidirectional and traps bite from below — no sector to
  // hide behind for either.
  const shield = kind === 'bomb' || kind === 'trap' ? undefined : getKit(cfg, victim.cls).shield;
  let blocked = false;
  if (shield && attacker && isBlocking(victim.input.b, true, victim.dashTicks)) {
    const dx = attacker.x - victim.x;
    const dy = attacker.y - victim.y;
    const l = Math.sqrt(dx * dx + dy * dy);
    if (l > 1e-6) {
      const dot = (dx / l) * victim.input.ax + (dy / l) * victim.input.ay;
      blocked = dot >= shield.arcCosHalf;
    }
  }

  const amount = blocked ? rawAmount * shield!.damageFactor : rawAmount;
  victim.hp -= amount;
  victim.lastDamagedTick = world.tick;
  if (attacker) victim.recentDamagers.set(attacker.id, world.tick);

  events.push({
    k: 'hit',
    tk: world.tick,
    attacker: attacker ? attacker.id : -1,
    victim: victim.id,
    amount,
    hp: victim.hp > 0 ? victim.hp : 0,
    kind,
    blocked,
    x: victim.x,
    y: victim.y,
  });

  if (victim.hp <= 0) {
    processDeath(world, cfg, victim, attacker, events);
  }
}

/** Resolve a death: state teardown, assists, economy settlement, kill event. */
export function processDeath(
  world: World,
  cfg: GameConfig,
  victim: Player,
  killer: Player | null,
  events: SimEvent[],
): void {
  victim.alive = false;
  victim.hp = 0;
  victim.deaths++;
  victim.respawnAtTick = world.tick + secToTicks(cfg, cfg.player.respawnSec);
  // Cancel whatever the victim was doing mid-death.
  victim.dashTicks = 0;
  victim.rootTicks = 0;
  victim.atkPhase = ATK_IDLE;
  victim.atkTicks = 0;
  victim.atkHitIds = [];
  victim.bankTicks = 0;
  // Dying with gold on your back spills it — the moment banking runs go wrong.
  const sack = dropCarriedAsSack(world, victim);

  // Assists: enemies who damaged the victim inside the window, minus the killer.
  const windowTicks = secToTicks(cfg, cfg.combat.assistWindowSec);
  const assists: PlayerId[] = [];
  for (const [attackerId, tick] of victim.recentDamagers) {
    if (world.tick - tick > windowTicks) continue;
    if (killer && attackerId === killer.id) continue;
    const assister = world.players.get(attackerId);
    if (!assister || assister.squad === victim.squad) continue;
    assists.push(attackerId);
  }
  victim.recentDamagers.clear();

  const { gold, victimBounty } = settleKillEconomy(world, cfg, killer, victim);
  if (killer && killer.squad !== victim.squad) {
    killer.kills++;
    // Assist credit is bounty-only — gold mints exactly once per kill.
    const scale = gold > 0 ? 1 : 0; // farmed kills credit nothing
    for (const id of assists) {
      const assister = world.players.get(id)!;
      assister.assists++;
      assister.bounty += cfg.bounty.assistBounty * scale;
    }
  }

  events.push({
    k: 'kill',
    tk: world.tick,
    killer: killer && killer.squad !== victim.squad ? killer.id : null,
    victim: victim.id,
    gold,
    victimBounty,
    droppedGold: sack?.gold ?? 0,
    assists,
  });
}
