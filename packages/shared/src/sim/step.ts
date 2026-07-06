import type { GameConfig } from '../config';
import type { MapData } from '../map/types';
import type { SimEvent } from './events';
import type { InputCmd, PlayerId, World } from './world';
import { pushoutPairs, stepMovement } from './systems/movement';

/**
 * The authoritative simulation entry point. Runs ONLY on the server; the
 * client reuses individual kernels (movement, projectile kinematics) but never
 * steps the whole world.
 *
 * System order (grows each milestone):
 *   applyInputs → movement → pushout → [projectiles → melee → combat → gold
 *   → bounty → banking → respawn → wincheck]
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

  // Apply fresh inputs (players keep their last input when none arrived —
  // TCP delays inputs, it never drops them) and integrate movement.
  for (const p of world.players.values()) {
    const cmd = inputs.get(p.id);
    if (cmd) p.input = cmd;
    stepMovement(p, p.input, cfg, map, dt);
  }

  // Bodies occupy space: body-blocking bridges/gates is design-load-bearing.
  pushoutPairs([...world.players.values()], cfg.player.radius, map);

  return events;
}
