import type { GameConfig } from '../../config';
import { getKit, secToTicks } from '../../config';
import type { SimEvent } from '../events';
import type { World } from '../world';
import { ATK_IDLE, BTN_BOMB, PHASE_LIVE } from '../world';
import { applyDamage } from './combat';
import { damageKeep, keepsInRange } from './keep';
import { isBlocking } from './movement';

// Firebombs: THE anti-structure tool. A committed lob — the landing circle is
// locked at throw time and the flight is the defenders' scatter window. Heavy
// structure damage, light player splash (no friendly fire), useless in a
// duel — you carry them to crack keeps, not people. Restock happens at your
// own keep (banking.ts), which turns a siege into supply logistics.

export function stepBombs(world: World, cfg: GameConfig, events: SimEvent[]): void {
  const fb = cfg.firebomb;
  const flightTicks = secToTicks(cfg, fb.flightSec);

  // ---- throws: edge-triggered, gated like attacks (alive, live, committed).
  for (const p of world.players.values()) {
    if (p.bombCd > 0) p.bombCd--;
    const pressed = (p.input.b & BTN_BOMB) !== 0;
    const rising = pressed && (p.prevBombB & BTN_BOMB) === 0;
    p.prevBombB = p.input.b;
    if (!rising || !p.alive || world.phase !== PHASE_LIVE) continue;
    const kit = getKit(cfg, p.cls);
    if (
      p.bombs <= 0 ||
      p.bombCd > 0 ||
      p.atkPhase !== ATK_IDLE ||
      p.dashTicks > 0 ||
      isBlocking(p.input.b, kit.shield !== undefined, p.dashTicks)
    ) {
      continue;
    }
    p.bombs--;
    p.bombCd = secToTicks(cfg, fb.cooldownSec);
    const bomb = {
      id: world.nextId++,
      owner: p.id,
      squad: p.squad,
      x: p.x,
      y: p.y,
      tx: p.x + p.input.ax * fb.range,
      ty: p.y + p.input.ay * fb.range,
      landTick: world.tick + flightTicks,
      bornTick: world.tick,
    };
    world.bombs.set(bomb.id, bomb);
    events.push({
      k: 'bombSpawn',
      tk: world.tick,
      id: bomb.id,
      owner: bomb.owner,
      squad: bomb.squad,
      x: bomb.x,
      y: bomb.y,
      tx: bomb.tx,
      ty: bomb.ty,
      flightTicks,
    });
  }

  // ---- landings: structure damage first (a keep may die), then splash.
  for (const bomb of world.bombs.values()) {
    if (world.tick < bomb.landTick) continue;
    world.bombs.delete(bomb.id);
    events.push({
      k: 'bombEnd',
      tk: world.tick,
      id: bomb.id,
      squad: bomb.squad,
      x: bomb.tx,
      y: bomb.ty,
    });

    for (const keep of keepsInRange(world, cfg, bomb.tx, bomb.ty, fb.radius, bomb.squad)) {
      damageKeep(world, cfg, keep, fb.damage, events);
    }

    // Splash: enemies inside the circle. Blasts are omnidirectional — shields
    // don't help (applyDamage skips the block check for 'bomb'). A thrower who
    // died or left mid-flight burns nobody: no attacker, no credit, no damage.
    const attacker = world.players.get(bomb.owner);
    if (!attacker) continue;
    const blastR = fb.radius + cfg.player.radius;
    for (const victim of world.players.values()) {
      if (!victim.alive) continue;
      if (!cfg.combat.friendlyFire && victim.squad === bomb.squad) continue;
      const dx = victim.x - bomb.tx;
      const dy = victim.y - bomb.ty;
      if (dx * dx + dy * dy > blastR * blastR) continue;
      applyDamage(world, cfg, attacker, victim, fb.playerDamage, 'bomb', events);
    }
  }
}
