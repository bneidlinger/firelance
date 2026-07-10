import type { GameConfig } from '../config';
import { kitMoveParams, type MoveParams } from './systems/movement';
import type { ClassId } from '../config';
import type { MapData } from '../map/types';
import type { SimEvent } from './events';
import type { InputCmd, PlayerId, World } from './world';
import { PHASE_ENDED } from './world';
import { pushoutPairs, stepMovement } from './systems/movement';
import { carrySpeedFactor } from './systems/economy';
import { stepAttacks } from './systems/attacks';
import { stepProjectiles } from './systems/projectiles';
import { stepBombs } from './systems/bombs';
import { stepBanking } from './systems/banking';
import { stepClaims } from './systems/claims';
import { stepLifecycle } from './systems/lifecycle';
import { stepPhase } from './systems/phase';
import { buildOccupancy, moveOccupancyFor, stepStructures } from './systems/structures';

/**
 * The authoritative simulation entry point. Runs ONLY on the server; the
 * client reuses individual kernels (movement, projectile kinematics) but never
 * steps the whole world.
 *
 * System order:
 *   applyInputs → movement → pushout → attacks → projectiles → bombs
 *   (throws + blasts; damage may destroy keeps AND walls) → claims
 *   (placement-phase keep-site channels) → banking (withdraw/deposit/pickup/
 *   restock/rebuild; after combat so same-tick damage breaks channels) →
 *   structures (supply trickle + wall placement) → lifecycle (regen/bounty/
 *   respawn, gated on a living keep) → phase (placement/countdown/live/
 *   elimination/ended). Movement/vision consult a per-tick structure-occupancy
 *   set built at the top of the step.
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
    // Structures occupy tiles this tick. TWO layers (M4 s3): the FULL set for
    // vision rays, projectiles, and melee LOS — and a per-squad MOVE set that
    // excludes that squad's own gates (a door for your bodies, a wall for
    // theirs). The client rebuilds both identically from its snapshot, so
    // wall collision AND gate-walking predict bit-exactly. stepStructures
    // mutates the full set as new pieces go up (they block next tick).
    const occ = buildOccupancy(world, map.width);
    const occMove: Array<Set<number>> = [];
    for (let s = 0; s < world.squads.length; s++) {
      occMove.push(moveOccupancyFor(world, map.width, s));
    }

    // Apply fresh inputs (players keep their last input when none arrived —
    // TCP delays inputs, it never drops them) and integrate movement.
    const paramsByClass = new Map<ClassId, MoveParams>();
    const alive: Array<{ x: number; y: number; squad: number }> = [];
    for (const p of world.players.values()) {
      const cmd = inputs.get(p.id);
      if (cmd) p.input = cmd;
      if (!p.alive) continue;
      let params = paramsByClass.get(p.cls);
      if (!params) {
        params = kitMoveParams(cfg, p.cls);
        paramsByClass.set(p.cls, params);
      }
      stepMovement(
        p,
        p.input,
        params,
        map,
        dt,
        carrySpeedFactor(cfg, p.carried),
        occMove[p.squad] ?? occ,
      );
      alive.push(p);
    }

    // Bodies occupy space: body-blocking bridges/gates is design-load-bearing.
    pushoutPairs(alive, cfg.player.radius, map, occ, (i) => occMove[alive[i]!.squad] ?? occ);

    stepAttacks(world, cfg, map, events, occ);
    stepProjectiles(world, cfg, map, events, occ);
    stepBombs(world, cfg, events);
    stepClaims(world, cfg, map, events);
    stepBanking(world, cfg, map, events);
    stepStructures(world, cfg, map, occ, events);
    stepLifecycle(world, cfg, events);
  }

  stepPhase(world, cfg, map, events);

  return events;
}
