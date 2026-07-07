import type { GameConfig } from '../../config';
import { getKit, secToTicks } from '../../config';
import type { SimEvent } from '../events';
import type { Player, World } from '../world';
import { PHASE_LIVE, SPAWN_OFFSETS } from '../world';

// Player lifecycle upkeep: out-of-combat regen, survival bounty accrual, and
// respawns at the squad keep. Runs after combat so a player who died this
// tick waits their full respawn timer.

export function stepLifecycle(world: World, cfg: GameConfig, events: SimEvent[]): void {
  const dt = 1 / cfg.tick.simHz;
  const regenDelayTicks = secToTicks(cfg, cfg.combat.regenDelaySec);
  const survivalTicks = secToTicks(cfg, cfg.bounty.survivalTickSec);

  for (const p of world.players.values()) {
    if (p.alive) {
      // Regen: hp trickles back after a quiet spell.
      const maxHp = getKit(cfg, p.cls).maxHp;
      if (p.hp < maxHp && world.tick - p.lastDamagedTick >= regenDelayTicks) {
        p.hp += cfg.combat.regenPerSec * dt;
        if (p.hp > maxHp) p.hp = maxHp;
      }
      // Survival bounty: staying alive slowly makes you worth hunting.
      if (world.phase === PHASE_LIVE) {
        const aliveTicks = world.tick - p.spawnedAtTick;
        if (aliveTicks > 0 && aliveTicks % survivalTicks === 0) {
          p.bounty += cfg.bounty.survivalBounty;
        }
      }
    } else if (world.phase === PHASE_LIVE && world.tick >= p.respawnAtTick) {
      respawnPlayer(world, cfg, p, events);
    }
  }
}

export function respawnPlayer(world: World, cfg: GameConfig, p: Player, events: SimEvent[]): void {
  const squad = world.squads[p.squad]!;
  const [ox, oy] = SPAWN_OFFSETS[p.id % SPAWN_OFFSETS.length]!;
  p.cls = p.pendingCls;
  p.x = squad.keepX + ox;
  p.y = squad.keepY + oy;
  p.vx = 0;
  p.vy = 0;
  p.dashTicks = 0;
  p.dashCd = 0;
  // No rising-edge dash out of the grave from a key held while dead.
  p.prevB = p.input.b;
  p.hp = getKit(cfg, p.cls).maxHp;
  p.alive = true;
  p.spawnedAtTick = world.tick;
  p.lastDamagedTick = -1_000_000;
  p.recentDamagers.clear();
  events.push({ k: 'respawn', tk: world.tick, id: p.id, squad: p.squad, x: p.x, y: p.y });
}
