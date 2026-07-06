// The protocol contract shared by server, client, and bots. Continuous state
// flows via `snap`; discrete happenings via `ev`. JSON today — all encoding
// goes through codec.ts so a binary swap later touches exactly two functions.

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- client → server

export interface HelloMsg {
  t: 'hello';
  v: number;
  name: string;
  bot?: boolean;
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

export interface PingMsg {
  t: 'ping';
  /** Client wall-clock ms, echoed back verbatim. */
  ct: number;
}

export type ClientMsg = HelloMsg | InputMsg | PingMsg;

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
  roster: RosterEntry[];
}

/** Remote entity as serialized into a squad snapshot (quantized to 0.01). */
export interface EntitySnap {
  i: number;
  x: number;
  y: number;
}

/** The recipient's own authoritative state — full precision, feeds reconciliation. */
export interface YouSnap {
  x: number;
  y: number;
  vx: number;
  vy: number;
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

export type NetEvent =
  | { k: 'playerJoined'; id: number; squad: number; name: string; bot: boolean }
  | { k: 'playerLeft'; id: number };

export interface EvMsg {
  t: 'ev';
  tick: number;
  events: NetEvent[];
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

export type ServerMsg = WelcomeMsg | SnapMsg | EvMsg | PongMsg | ErrorMsg;
