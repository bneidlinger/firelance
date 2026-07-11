// The protocol contract shared by server, client, and bots. Continuous state
// flows via `snap`; discrete happenings via `ev`; public standings via
// `score`. JSON today — all encoding goes through codec.ts so a binary swap
// later touches exactly two functions.

import type { ClassId } from '../config';
import type { MapVariant } from '../map/variant';
import type { SimEvent } from '../sim/events';

export const PROTOCOL_VERSION = 10;

// ---------------------------------------------------------------- client → server

export interface HelloMsg {
  t: 'hello';
  v: number;
  name: string;
  bot?: boolean;
  /** Preferred class; server assigns a squad-balanced default when absent. */
  cls?: ClassId;
  /** Resume token from a previous welcome: reclaim the SAME player (body,
   *  gold, bounty) within the grace window after a refresh/disconnect. */
  resume?: string;
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

/** A squad keep as of the welcome: authoritative position + hp. During the
 *  placement phase only CLAIMED squads appear (the rest have no keep yet);
 *  from the countdown on, every squad has an entry. Replaces the client
 *  re-deriving keep sites itself — claims made that derivation wrong. */
export interface KeepSnap {
  squad: number;
  x: number;
  y: number;
  hp: number;
}

export interface WelcomeMsg {
  t: 'welcome';
  playerId: number;
  squadId: number;
  mapId: string;
  /** This match's map draw — apply to the base map via applyVariant BEFORE
   *  using keeps/towns/spawns for anything (M5: sites/towns/spawn corners
   *  vary per match; the descriptor travels, the seed never does). */
  variant: MapVariant;
  cfgName: string;
  cfgHash: string;
  tick: number;
  tickRate: number;
  snapRate: number;
  phase: number;
  phaseEndsTick: number;
  roster: RosterEntry[];
  /** Claimed/final keep positions — see KeepSnap for the placement-phase rule. */
  keeps: KeepSnap[];
  /** Present this in a future hello to reclaim this seat (refresh survival). */
  resume: string;
}

// Entity state flags (EntitySnap.st bitmask).
export const ST_BLOCKING = 1;
export const ST_WINDUP = 2;
export const ST_ACTIVE = 4;
export const ST_DASHING = 8;
export const ST_CARRYING = 16;
export const ST_BANKING = 32;
export const ST_REBUILDING = 64;
export const ST_ROOTED = 128;

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
  /** ST_* bitmask: blocking / windup / active / dashing / carrying / banking. */
  st: number;
  /** Carried gold — present for SQUADMATES only. Enemies get the ST_CARRYING
   *  flag (you can see the sack on their back) but never the amount. */
  g?: number;
}

/** A visible ground loot sack (dropped carried gold). */
export interface SackSnap {
  i: number;
  x: number;
  y: number;
  /** Gold inside — public once you can see the sack (size it up, then fight over it). */
  g: number;
}

/**
 * A visible structure. Fog rules: own squad always; enemy structures only
 * once a squadmate has eyes on the tile (design §12.1 lists built structures
 * as hidden information) — EXCEPT traps, which are never serialized to enemy
 * squads at all: eyes on the tile show you the ground, not the snare in it.
 */
export interface StructSnap {
  i: number;
  /** Kind: 0 wall, 1 gate, 2 tower, 3 trap (own squad only). */
  k: number;
  /** Owning squad — colors it; not secret once seen. */
  s: number;
  /** Grid tile (integers); the segment fills [tx,tx+1]×[ty,ty+1]. */
  tx: number;
  ty: number;
  /** Current / max hp — drives a damage tint. */
  hp: number;
  mx: number;
  /** Traps only: 1 while still arming (own squad renders it dimmed). */
  ar?: 1;
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
  /** Carried gold — drives the HUD weight readout AND client-side carry-slow
   *  prediction (the kernel needs the same factor the server applies). */
  carried: number;
  /** Deposit channel progress in ticks (0 = idle); pairs with cfg.banking.bankChannelSec. */
  bankTicks: number;
  /** Rebuild channel progress in ticks (0 = idle); pairs with cfg.keep.rebuildChannelSec. */
  rebuildTicks: number;
  /** Firebombs on hand. */
  bombs: number;
  /** Ticks until the next bomb throw. */
  bombCd: number;
  /** Your squad's build-supply pool (drives the build HUD; cap is cfg.build.supplyCap). */
  supply: number;
  /** Keep-site claim channel progress in ticks (placement phase; 0 = idle);
   *  pairs with cfg.keep.claimChannelSec. */
  claimTicks: number;
  /** Ticks left snared by a trap (0 = free) — mirrors into the prediction
   *  kernel so the pin replays exactly, and drives the SNARED HUD strip. */
  rootTicks: number;
}

export interface SnapMsg {
  t: 'snap';
  tick: number;
  /** Last input seq the server applied for THIS recipient. */
  ackSeq: number;
  you: YouSnap;
  /** Everything this squad can currently see (full visible set, no deltas). */
  ents: EntitySnap[];
  /** Ground sacks this squad can currently see (same fog rules as entities). */
  sacks: SackSnap[];
  /** Structures this squad can currently see (own always; enemy once eyes-on). */
  structures: StructSnap[];
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

/**
 * Standings — bounty and BANKED gold are public information by design (banked
 * is the score). Keep-vault contents are squad-private from M2 on (the design
 * doc lists "vault values" as hidden info): `g` (keep gold) and `wd`
 * (withdrawable now, after the reserve rule) are present ONLY on the
 * recipient's own squad entry. M3 adds `kh` (keep hp — PUBLIC: a burning keep
 * is a map event, and vultures circling a weak one is the point), `el`
 * (eliminated), and own-squad `rb` (rebuilds left). ~2Hz.
 */
export interface ScoreMsg {
  t: 'score';
  tick: number;
  phase: number;
  phaseEndsTick: number;
  players: Array<{ id: number; b: number; k: number; d: number; a: number }>;
  squads: Array<{
    id: number;
    bk: number;
    kh: number;
    el: boolean;
    g?: number;
    wd?: number;
    rb?: number;
  }>;
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
