import type { GameConfig } from '../../config';
import { getKit, secToTicks } from '../../config';
import type { MapData } from '../../map/types';
import type { SimEvent } from '../events';
import type { Player, World } from '../world';
import {
  ATK_ACTIVE,
  ATK_IDLE,
  ATK_RECOVERY,
  ATK_WINDUP,
  BTN_FIRE,
  PHASE_LIVE,
  STRUCT_HUT,
  STRUCT_TREE,
} from '../world';
import { tileRayClear } from '../vision';
import { applyDamage } from './combat';
import { damageKeep, keepsInRange } from './keep';
import { isBlocking } from './movement';
import { damageStructure, structuresInRange } from './structures';

// Attack intent → attack state machines → damage/projectiles.
//   Fighter melee: windup (the dodgeable telegraph, aim locked at start)
//                  → active (sector hit test each tick, one hit per swing)
//                  → recovery → cooldown.
//   Ranger bow:    instant release on fire, rate-limited by cooldown; the
//                  arrow itself is the telegraph (projectiles.ts flies it).
// Firing requires: live phase, alive, idle, off cooldown, not dashing, not
// blocking. Holding fire re-attacks at the cooldown rate (bot- and
// human-friendly; no click spam advantage).

export function stepAttacks(
  world: World,
  cfg: GameConfig,
  map: MapData,
  events: SimEvent[],
  occ: ReadonlySet<number> | null = null,
): void {
  for (const p of world.players.values()) {
    if (!p.alive) continue;
    if (p.atkCd > 0) p.atkCd--;

    const kit = getKit(cfg, p.cls);

    // Advance the melee state machine.
    if (p.atkPhase !== ATK_IDLE) {
      p.atkTicks--;
      if (p.atkTicks <= 0) {
        if (p.atkPhase === ATK_WINDUP) {
          p.atkPhase = ATK_ACTIVE;
          p.atkTicks = secToTicks(cfg, kit.melee!.activeSec);
          p.atkHitIds = [];
        } else if (p.atkPhase === ATK_ACTIVE) {
          p.atkPhase = ATK_RECOVERY;
          p.atkTicks = secToTicks(cfg, kit.melee!.recoverySec);
        } else {
          p.atkPhase = ATK_IDLE;
          p.atkTicks = 0;
          p.atkCd = secToTicks(cfg, kit.melee!.cooldownSec);
        }
      }
    }

    // Melee active window: sector hit test every active tick.
    if (p.atkPhase === ATK_ACTIVE && kit.melee) {
      meleeHitTest(world, cfg, map, p, events, occ);
    }

    // Fire intent.
    if (
      world.phase === PHASE_LIVE &&
      (p.input.b & BTN_FIRE) !== 0 &&
      p.atkPhase === ATK_IDLE &&
      p.atkCd <= 0 &&
      p.dashTicks <= 0 &&
      !isBlocking(p.input.b, kit.shield !== undefined, p.dashTicks)
    ) {
      if (kit.melee) {
        p.atkPhase = ATK_WINDUP;
        p.atkTicks = secToTicks(cfg, kit.melee.windupSec);
        // Swing direction locks NOW — the windup telegraph is honest.
        p.atkDirX = p.input.ax;
        p.atkDirY = p.input.ay;
        p.atkHitIds = [];
        events.push({
          k: 'swing',
          tk: world.tick,
          id: p.id,
          x: p.x,
          y: p.y,
          dx: p.atkDirX,
          dy: p.atkDirY,
        });
      } else if (kit.bow) {
        spawnArrow(world, cfg, p, events);
        p.atkCd = secToTicks(cfg, kit.bow.cooldownSec);
      }
    }
  }
}

function meleeHitTest(
  world: World,
  cfg: GameConfig,
  map: MapData,
  attacker: Player,
  events: SimEvent[],
  occ: ReadonlySet<number> | null,
): void {
  const melee = getKit(cfg, attacker.cls).melee!;
  const reach = melee.range + cfg.player.radius;
  for (const victim of world.players.values()) {
    if (victim.id === attacker.id || !victim.alive) continue;
    if (!cfg.combat.friendlyFire && victim.squad === attacker.squad) continue;
    if (attacker.atkHitIds.includes(victim.id)) continue;
    const dx = victim.x - attacker.x;
    const dy = victim.y - attacker.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > reach * reach) continue;
    if (d2 > 1e-12) {
      const d = Math.sqrt(d2);
      const dot = (dx / d) * attacker.atkDirX + (dy / d) * attacker.atkDirY;
      if (dot < melee.arcCosHalf) continue;
    }
    // No swinging through walls or structures (tile-thin corners would poke otherwise).
    if (!tileRayClear(map, attacker.x, attacker.y, victim.x, victim.y, occ)) continue;
    attacker.atkHitIds.push(victim.id);
    applyDamage(world, cfg, attacker, victim, melee.damage, 'melee', events);
  }

  // Desperation chip vs enemy keeps: swords CAN bring one down, at ~20x the
  // bomb count — the firebomb stays the siege tool. Keeps use negative pseudo
  // ids in atkHitIds so a swing still lands once per target.
  for (const keep of keepsInRange(world, cfg, attacker.x, attacker.y, reach, attacker.squad)) {
    const pseudoId = -(keep.id + 1);
    if (attacker.atkHitIds.includes(pseudoId)) continue;
    const dx = keep.keepX - attacker.x;
    const dy = keep.keepY - attacker.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > 1e-12) {
      const d = Math.sqrt(d2);
      const dot = (dx / d) * attacker.atkDirX + (dy / d) * attacker.atkDirY;
      if (dot < melee.arcCosHalf) continue;
    }
    if (!tileRayClear(map, attacker.x, attacker.y, keep.keepX, keep.keepY, occ)) continue;
    attacker.atkHitIds.push(pseudoId);
    damageKeep(world, cfg, keep, cfg.keep.meleeDamage, events);
  }

  // Chip vs enemy structures — one hit per swing per target. Distinct pseudo-id
  // namespace (offset 1e6) so a swing that clips both a keep and a wall lands on
  // each. LOS uses terrain only (occ omitted): a wall must not occlude ITSELF.
  for (const s of structuresInRange(world, attacker.x, attacker.y, reach, attacker.squad)) {
    const pseudoId = -(s.id + 1_000_000);
    if (attacker.atkHitIds.includes(pseudoId)) continue;
    const cx = s.tx + 0.5;
    const cy = s.ty + 0.5;
    const dx = cx - attacker.x;
    const dy = cy - attacker.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > 1e-12) {
      const d = Math.sqrt(d2);
      const dot = (dx / d) * attacker.atkDirX + (dy / d) * attacker.atkDirY;
      if (dot < melee.arcCosHalf) continue;
    }
    if (!tileRayClear(map, attacker.x, attacker.y, cx, cy)) continue;
    attacker.atkHitIds.push(pseudoId);
    // The axe-vs-architecture table: trees chop fast, huts demolish slowly,
    // player-built pieces keep the flat desperation chip.
    const chip =
      s.kind === STRUCT_TREE
        ? cfg.props.treeMelee
        : s.kind === STRUCT_HUT
          ? cfg.props.hutMelee
          : cfg.build.meleeChip;
    damageStructure(world, s, chip, events);
  }
}

function spawnArrow(world: World, cfg: GameConfig, shooter: Player, events: SimEvent[]): void {
  const bow = getKit(cfg, shooter.cls).bow!;
  // Muzzle just outside the shooter's own body so the arrow can't hit them.
  const off = cfg.player.radius + bow.radius + 0.05;
  const ttl = secToTicks(cfg, bow.ttlSec);
  const proj = {
    id: world.nextId++,
    owner: shooter.id,
    squad: shooter.squad,
    x: shooter.x + shooter.input.ax * off,
    y: shooter.y + shooter.input.ay * off,
    dx: shooter.input.ax,
    dy: shooter.input.ay,
    speed: bow.speed,
    damage: bow.damage,
    radius: bow.radius,
    ticksLeft: ttl,
    bornTick: world.tick,
    // Arrow vs crossbow bolt, decided at fire time: what this projectile does
    // to countryside props if it dies in one (projectiles.ts).
    propFactor: shooter.cls === 'engineer' ? cfg.props.boltFactor : cfg.props.arrowFactor,
  };
  world.projectiles.set(proj.id, proj);
  events.push({
    k: 'projSpawn',
    tk: world.tick,
    id: proj.id,
    owner: proj.owner,
    squad: proj.squad,
    x: proj.x,
    y: proj.y,
    dx: proj.dx,
    dy: proj.dy,
    speed: proj.speed,
    ttl,
  });
}
