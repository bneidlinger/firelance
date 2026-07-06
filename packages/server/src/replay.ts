import type { GameConfig } from '@shared/config';
import type { MapData } from '@shared/map/types';
import { stepWorld } from '@shared/sim/step';
import type { InputCmd, Player, PlayerId } from '@shared/sim/world';
import { createWorld, hashWorld } from '@shared/sim/world';

// Replay v0: (seed, roster, per-tick sanitized inputs) reproduces a match
// bit-exactly thanks to sim determinism. A failing smoke test dumps one of
// these; re-running it under the debugger is the cheapest bug reproduction
// in the whole architecture.

export interface ReplayJoin {
  tick: number;
  id: PlayerId;
  squad: number;
  name: string;
  bot: boolean;
  x: number;
  y: number;
}

export interface ReplayRecord {
  version: 1;
  seed: number;
  cfgName: string;
  mapId: string;
  joins: ReplayJoin[];
  leaves: Array<{ tick: number; id: PlayerId }>;
  /** frames[i] = inputs applied on tick frames[i].tick. Sparse: empty ticks omitted. */
  frames: Array<{ tick: number; inputs: Array<[PlayerId, InputCmd]> }>;
}

export class ReplayRecorder {
  private readonly record: ReplayRecord;

  constructor(seed: number, cfgName: string, mapId: string) {
    this.record = { version: 1, seed, cfgName, mapId, joins: [], leaves: [], frames: [] };
  }

  recordJoin(p: Player): void {
    // M0: joins happen before tick 0 in harness runs; tick recorded for later.
    this.record.joins.push({
      tick: 0,
      id: p.id,
      squad: p.squad,
      name: p.name,
      bot: p.bot,
      x: p.x,
      y: p.y,
    });
  }

  recordLeave(id: PlayerId, tick: number): void {
    this.record.leaves.push({ tick, id });
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
 * Re-run a recorded match and return the final world hash. M0 supports the
 * harness shape: all joins at tick 0, no mid-match leaves.
 */
export function replayToHash(
  record: ReplayRecord,
  cfg: GameConfig,
  map: MapData,
  ticks: number,
): string {
  const world = createWorld(record.seed, cfg);
  for (const j of record.joins) {
    // Re-create players with the same ids the original run allocated.
    world.players.set(j.id, {
      id: j.id,
      squad: j.squad,
      name: j.name,
      bot: j.bot,
      x: j.x,
      y: j.y,
      vx: 0,
      vy: 0,
      input: { mx: 0, my: 0, ax: 1, ay: 0, b: 0 },
    });
    if (j.id >= world.nextId) world.nextId = j.id + 1;
  }
  let frameIdx = 0;
  const empty = new Map<PlayerId, InputCmd>();
  for (let t = 1; t <= ticks; t++) {
    let inputs = empty;
    const frame = record.frames[frameIdx];
    if (frame && frame.tick === t) {
      inputs = new Map(frame.inputs);
      frameIdx++;
    }
    stepWorld(world, inputs, cfg, map);
  }
  return hashWorld(world);
}
