import type { ClassId, GameConfig } from '@shared/config';
import type { MapData } from '@shared/map/types';
import { applyVariant, deriveVariant } from '@shared/map/variant';
import { stepWorld } from '@shared/sim/step';
import { removePlayerSpillingGold } from '@shared/sim/systems/economy';
import type { InputCmd, Player, PlayerId } from '@shared/sim/world';
import { createWorld, hashWorld, spawnPlayer } from '@shared/sim/world';

// Replay: (seed, joins/leaves/class-switches at their exact ticks, per-tick
// sanitized inputs) reproduces a match bit-exactly thanks to sim determinism.
// Exact-tick joins matter as of M1: players and projectiles share the
// world.nextId sequence, so a join replayed at the wrong tick shifts every
// later projectile id and the hash diverges — by design, loudly.

export interface ReplayJoin {
  tick: number;
  id: PlayerId;
  squad: number;
  name: string;
  bot: boolean;
  cls: ClassId;
  x: number;
  y: number;
}

export interface ReplayRecord {
  version: 2;
  seed: number;
  cfgName: string;
  mapId: string;
  joins: ReplayJoin[];
  leaves: Array<{ tick: number; id: PlayerId }>;
  classes: Array<{ tick: number; id: PlayerId; cls: ClassId }>;
  /** frames[i] = inputs applied on tick frames[i].tick. Sparse: empty ticks omitted. */
  frames: Array<{ tick: number; inputs: Array<[PlayerId, InputCmd]> }>;
}

export class ReplayRecorder {
  private readonly record: ReplayRecord;

  constructor(seed: number, cfgName: string, mapId: string) {
    this.record = {
      version: 2,
      seed,
      cfgName,
      mapId,
      joins: [],
      leaves: [],
      classes: [],
      frames: [],
    };
  }

  /** Call at join time; `tick` is world.tick when the player was created. */
  recordJoin(p: Player): void {
    this.record.joins.push({
      tick: p.spawnedAtTick,
      id: p.id,
      squad: p.squad,
      name: p.name,
      bot: p.bot,
      cls: p.cls,
      x: p.x,
      y: p.y,
    });
  }

  recordLeave(id: PlayerId, tick: number): void {
    this.record.leaves.push({ tick, id });
  }

  recordClass(id: PlayerId, cls: ClassId, tick: number): void {
    this.record.classes.push({ tick, id, cls });
  }

  recordTick(tick: number, inputs: Map<PlayerId, InputCmd>): void {
    if (inputs.size === 0) return;
    this.record.frames.push({ tick, inputs: [...inputs.entries()] });
  }

  toRecord(): ReplayRecord {
    return this.record;
  }

  serialize(): string {
    return JSON.stringify(this.record);
  }
}

/**
 * Re-run a recorded match and return the final world hash. Joins/leaves/class
 * switches apply between ticks exactly where they happened live. Takes the
 * BASE map: the per-match variant re-derives from the recorded seed here,
 * exactly as the live Match derived it.
 */
export function replayToHash(
  record: ReplayRecord,
  cfg: GameConfig,
  baseMap: MapData,
  ticks: number,
): string {
  const map = applyVariant(baseMap, deriveVariant(record.seed, cfg, baseMap));
  const world = createWorld(record.seed, cfg, map);
  let joinIdx = 0;
  let leaveIdx = 0;
  let classIdx = 0;
  let frameIdx = 0;
  const empty = new Map<PlayerId, InputCmd>();

  for (let t = 0; t <= ticks; t++) {
    // Apply connection-level happenings recorded at world.tick === t.
    while (joinIdx < record.joins.length && record.joins[joinIdx]!.tick === t) {
      const j = record.joins[joinIdx++]!;
      const p = spawnPlayer(world, cfg, j.squad, j.name, j.bot, j.cls, j.x, j.y);
      if (p.id !== j.id) {
        throw new Error(`replay join id mismatch: allocated ${p.id}, recorded ${j.id}`);
      }
    }
    while (leaveIdx < record.leaves.length && record.leaves[leaveIdx]!.tick === t) {
      // Same spill-then-delete the live server applies — a leave replayed as a
      // bare delete would destroy the sack and fork the hash.
      removePlayerSpillingGold(world, record.leaves[leaveIdx++]!.id);
    }
    while (classIdx < record.classes.length && record.classes[classIdx]!.tick === t) {
      const c = record.classes[classIdx++]!;
      const p = world.players.get(c.id);
      if (p) p.pendingCls = c.cls;
    }
    if (t === ticks) break;

    let inputs = empty;
    const frame = record.frames[frameIdx];
    if (frame && frame.tick === t + 1) {
      inputs = new Map(frame.inputs);
      frameIdx++;
    }
    stepWorld(world, inputs, cfg, map);
  }
  return hashWorld(world);
}
