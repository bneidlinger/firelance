import type { GameConfig } from '../config';
import type { RngState } from '../math/rng';
import { createRng } from '../math/rng';

export type PlayerId = number;

/** One tick's worth of intent from a player. Everything the sim knows about a client. */
export interface InputCmd {
  /** Move direction, each axis in [-1, 1]; normalized inside movement. */
  mx: number;
  my: number;
  /** Aim unit vector (used as data — never re-derived via trig in the sim). */
  ax: number;
  ay: number;
  /** Button bitmask: 1 fire, 2 alt, 4 dash, 8 interact (all unused in M0). */
  b: number;
}

export const IDLE_INPUT: InputCmd = Object.freeze({ mx: 0, my: 0, ax: 1, ay: 0, b: 0 });

export interface Player {
  id: PlayerId;
  squad: number;
  name: string;
  bot: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Last applied input; server reuses it when a fresh one hasn't arrived (TCP delay). */
  input: InputCmd;
}

export interface SquadState {
  id: number;
  // Gold/keep state lands in M1 — kept minimal so M0 tests stay honest.
}

export interface World {
  tick: number;
  rng: RngState;
  nextId: number;
  players: Map<PlayerId, Player>;
  squads: SquadState[];
}

export function createWorld(seed: number, cfg: GameConfig): World {
  const squads: SquadState[] = [];
  for (let i = 0; i < cfg.match.squads; i++) squads.push({ id: i });
  return {
    tick: 0,
    rng: createRng(seed),
    nextId: 1,
    players: new Map(),
    squads,
  };
}

export function spawnPlayer(
  world: World,
  squad: number,
  name: string,
  bot: boolean,
  x: number,
  y: number,
): Player {
  const p: Player = {
    id: world.nextId++,
    squad,
    name,
    bot,
    x,
    y,
    vx: 0,
    vy: 0,
    input: { ...IDLE_INPUT },
  };
  world.players.set(p.id, p);
  return p;
}

/**
 * Stable serialization for determinism hashing and replay verification.
 * Full float precision (JSON round-trips doubles exactly in JS).
 */
export function serializeWorld(world: World): string {
  const players = [...world.players.values()].map((p) => ({
    id: p.id,
    squad: p.squad,
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
  }));
  return JSON.stringify({ tick: world.tick, rng: world.rng.s, nextId: world.nextId, players });
}

/** FNV-1a hash of the serialized world — the determinism fingerprint. */
export function hashWorld(world: World): string {
  const s = serializeWorld(world);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
