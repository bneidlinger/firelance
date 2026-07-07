import type { GameConfig } from '../config';
import { kitMoveParams, type MoveParams } from './systems/movement';
import type { ClassId } from '../config';
import type { MapData } from '../map/types';
import type { SimEvent } from './events';
import type { InputCmd, PlayerId, World } from './world';
import { PHASE_ENDED } from './world';
import { pushoutPairs, stepMovement } from './systems/movement';
import { stepAttacks } from './systems/attacks';
import { stepProjectiles } from './systems/projectiles';
import { stepLifecycle } from './systems/lifecycle';
import { stepPhase } from './systems/phase';

/**
 * The authoritative simulation entry point. Runs ONLY on the server; the
 * client reuses individual kernels (movement, projectile kinematics) but never
 * steps the whole world.
 *
 * System order:
 *   applyInputs → movement → pushout → attacks → projectiles → lifecycle
 *   (regen/bounty/respawn) → phase (countdown/live/ended)
 * Ended worlds freeze everything except the phase clock — the end screen is a
 * still frame until the server rebuilds the match.
 */
export function stepWorld(
  world: World,
  inputs: Map<PlayerId, InputCmd>,
  cfg: GameConfig,
  map: MapData,
): SimEvent[] {
  world.tick++;
  const dt = 1 / cfg.tick.simHz;
  const events: SimEvent[] = [];

  if (world.phase !== PHASE_ENDED) {
    // Apply fresh inputs (players keep their last input when none arrived —
    // TCP delays inputs, it never drops them) and integrate movement.
    const paramsByClass = new Map<ClassId, MoveParams>();
    const alive: Array<{ x: number; y: number }> = [];
    for (const p of world.players.values()) {
      const cmd = inputs.get(p.id);
      if (cmd) p.input = cmd;
      if (!p.alive) continue;
      let params = paramsByClass.get(p.cls);
      if (!params) {
        params = kitMoveParams(cfg, p.cls);
        paramsByClass.set(p.cls, params);
      }
      stepMovement(p, p.input, params, map, dt);
      alive.push(p);
    }

    // Bodies occupy space: body-blocking bridges/gates is design-load-bearing.
    pushoutPairs(alive, cfg.player.radius, map);

    stepAttacks(world, cfg, map, events);
    stepProjectiles(world, cfg, map, events);
    stepLifecycle(world, cfg, events);
  }

  stepPhase(world, cfg, events);

  return events;
}
