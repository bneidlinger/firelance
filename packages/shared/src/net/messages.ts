// The protocol contract shared by server, client, and bots. Continuous state
// flows via `snap`; discrete happenings via `ev`; public standings via
// `score`. JSON today — all encoding goes through codec.ts so a binary swap
// later touches exactly two functions.

import type { ClassId } from '../config';
import type { SimEvent } from '../sim/events';

export const PROTOCOL_VERSION = 2;

// ---------------------------------------------------------------- client → server

export interface HelloMsg {
  t: 'hello';
  v: number;
  name: string;
  bot?: boolean;
  /** Preferred class; server assigns a squad-balanced default when absent. */
  cls?: ClassId;
}

export interface InputMsg {
  t: 'input';
  /** Client-side monotonically increasing sequence (acked in snapshots). */
  seq: number;
  /** Client's estimate of the server tick this input targets. */
  tick: number;
  mx: number;
  my: number;
  ax: number;
  ay: number;
  b: number;
}

/** Class switch request; applies at the next respawn (or instantly pre-live). */
export interface ClassMsg {
  t: 'class';
  cls: ClassId;
}

export interface PingMsg {
  t: 'ping';
  /** Client wall-clock ms, echoed back verbatim. */
  ct: number;
}

export type ClientMsg = HelloMsg | InputMsg | ClassMsg | PingMsg;

// ---------------------------------------------------------------- server → client

export interface RosterEntry {
  id: number;
  squad: number;
  name: string;
  bot: boolean;
}

export interface WelcomeMsg {
  t: 'welcome';
  playerId: number;
  squadId: number;
  mapId: string;
  cfgName: string;
  cfgHash: string;
  tick: number;
  tickRate: number;
  snapRate: number;
  phase: number;
  phaseEndsTick: number;
  roster: RosterEntry[];
}

// Entity state flags (EntitySnap.st bitmask).
export const ST_BLOCKING = 1;
export const ST_WINDUP = 2;
export const ST_ACTIVE = 4;
export const ST_DASHING = 8;

/** Remote entity as serialized into a squad snapshot (coords quantized to 0.01). */
export interface EntitySnap {
  i: number;
  x: number;
  y: number;
  /** Facing (aim) unit vector, quantized. */
  ax: number;
  ay: number;
  /** Whole-number hp for bars; max derives from cls client-side. */
  hp: number;
  cls: ClassId;
  /** ST_* bitmask: blocking / melee windup / melee active / dashing. */
  st: number;
}

/**
 * The recipient's own authoritative state — full precision. The MoveState
 * mirror feeds prediction reconciliation; the rest drives the HUD and
 * client-side fire gating (muzzle prediction).
 */
export interface YouSnap {
  x: number;
  y: number;
  vx: number;
  vy: number;
  dashTicks: number;
  dashDx: number;
  dashDy: number;
  dashCd: number;
  prevB: number;
  hp: number;
  alive: boolean;
  /** Ticks until respawn (0 while alive). */
  respIn: number;
  atkPhase: number;
  atkTicks: number;
  atkCd: number;
  cls: ClassId;
  bounty: number;
}

export interface SnapMsg {
  t: 'snap';
  tick: number;
  /** Last input seq the server applied for THIS recipient. */
  ackSeq: number;
  you: YouSnap;
  /** Everything this squad can currently see (full visible set, no deltas). */
  ents: EntitySnap[];
}

/** Sim events plus match-level joins/leaves; fog policy applied server-side. */
export type NetEvent =
  | SimEvent
  | { k: 'playerJoined'; tk: number; id: number; squad: number; name: string; bot: boolean }
  | { k: 'playerLeft'; tk: number; id: number };

export interface EvMsg {
  t: 'ev';
  tick: number;
  events: NetEvent[];
}

/** Public standings — bounty is public information by design. ~2Hz. */
export interface ScoreMsg {
  t: 'score';
  tick: number;
  phase: number;
  phaseEndsTick: number;
  players: Array<{ id: number; b: number; k: number; d: number; a: number }>;
  squads: Array<{ id: number; g: number }>;
}

export interface PongMsg {
  t: 'pong';
  ct: number;
  tick: number;
}

export interface ErrorMsg {
  t: 'error';
  reason: string;
}

export type ServerMsg = WelcomeMsg | SnapMsg | EvMsg | ScoreMsg | PongMsg | ErrorMsg;
