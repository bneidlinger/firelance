import { getMap } from '@shared/map/maps';
import type { MapData } from '@shared/map/types';
import type { InputMsg, ServerMsg } from '@shared/net/messages';
import { createRng, type RngState } from '@shared/math/rng';
import { findPath, randomWalkableTile, type Waypoint } from './nav';

// Transport-agnostic bot mind. Consumes decoded server messages (only what the
// server actually sends — bots live under the same fog as humans, which makes
// every bot match a continuous protocol test) and produces input messages.
//
// M0 behavior: ROAM — wander between random waypoints via A*, with a stall
// detector that repaths when bumping into things nav can't see (other bodies).
// SEEK/ATTACK/FLEE arrive in Milestone 1.

const THINK_EVERY_TICKS = 6; // ~5Hz at 30Hz sim
const WAYPOINT_REACHED = 0.7;
const STALL_WINDOW_TICKS = 45; // 1.5s
const STALL_MIN_MOVE = 0.5;

export class BotBrain {
  private readonly rng: RngState;
  private map: MapData | null = null;
  private myId = -1;
  private x = 0;
  private y = 0;
  private hasPos = false;
  private path: Waypoint[] | null = null;
  private wpIdx = 0;
  private seq = 0;
  private lastThinkTick = -1_000_000;
  private stallX = 0;
  private stallY = 0;
  private stallTick = -1;
  private lastMove = { mx: 0, my: 0 };

  constructor(seed: number) {
    this.rng = createRng(seed);
  }

  get id(): number {
    return this.myId;
  }

  handleServer(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.myId = msg.playerId;
        this.map = getMap(msg.mapId);
        break;
      case 'snap':
        this.x = msg.you.x;
        this.y = msg.you.y;
        this.hasPos = true;
        break;
      case 'error':
        // Server rejected us; nothing to do — the driver sees the close.
        break;
      case 'ev':
      case 'pong':
        break;
    }
  }

  /**
   * Produce the next input, or null when it's not time to think yet.
   * `approxTick` is the server tick from the latest snapshot.
   */
  think(approxTick: number): InputMsg | null {
    if (!this.map || !this.hasPos) return null;
    if (approxTick - this.lastThinkTick < THINK_EVERY_TICKS) return null;
    this.lastThinkTick = approxTick;

    // Stall detection: while following a path, if we barely moved over the
    // window, the path is blocked by something nav can't see — repath.
    if (this.path) {
      if (this.stallTick < 0) {
        this.stallTick = approxTick;
        this.stallX = this.x;
        this.stallY = this.y;
      } else if (approxTick - this.stallTick >= STALL_WINDOW_TICKS) {
        const moved = Math.hypot(this.x - this.stallX, this.y - this.stallY);
        if (moved < STALL_MIN_MOVE) this.path = null;
        this.stallTick = approxTick;
        this.stallX = this.x;
        this.stallY = this.y;
      }
    }

    if (!this.path || this.wpIdx >= this.path.length) {
      this.pickNewDestination();
    }

    let mx = 0;
    let my = 0;
    if (this.path && this.wpIdx < this.path.length) {
      let wp = this.path[this.wpIdx]!;
      let dx = wp.x - this.x;
      let dy = wp.y - this.y;
      if (dx * dx + dy * dy < WAYPOINT_REACHED * WAYPOINT_REACHED) {
        this.wpIdx++;
        if (this.wpIdx < this.path.length) {
          wp = this.path[this.wpIdx]!;
          dx = wp.x - this.x;
          dy = wp.y - this.y;
        } else {
          dx = 0;
          dy = 0;
        }
      }
      const l = Math.sqrt(dx * dx + dy * dy);
      if (l > 1e-6) {
        mx = dx / l;
        my = dy / l;
      }
    }
    this.lastMove = { mx, my };

    return {
      t: 'input',
      seq: ++this.seq,
      tick: approxTick,
      mx,
      my,
      ax: this.lastMove.mx !== 0 || this.lastMove.my !== 0 ? this.lastMove.mx : 1,
      ay: this.lastMove.my,
      b: 0,
    };
  }

  private pickNewDestination(): void {
    if (!this.map) return;
    this.path = null;
    this.wpIdx = 0;
    const target = randomWalkableTile(this.map, this.rng, this.x, this.y, 15);
    if (!target) return;
    const path = findPath(
      this.map,
      Math.floor(this.x),
      Math.floor(this.y),
      Math.floor(target.x),
      Math.floor(target.y),
    );
    if (path && path.length > 0) {
      this.path = path;
      this.wpIdx = 0;
      this.stallTick = -1;
    }
  }
}
