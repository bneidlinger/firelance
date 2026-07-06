import type { GameConfig } from '@shared/config';
import type { MapData } from '@shared/map/types';
import type { YouSnap } from '@shared/net/messages';
import { stepMovement, type MoveState } from '@shared/sim/systems/movement';
import type { InputCmd } from '@shared/sim/world';

// Client-side prediction of OWN movement only — the file the game-feel bet
// rides on. Flow:
//   local input sampled  -> apply the SHARED movement kernel immediately, buffer it
//   snapshot arrives     -> rebase to the server's authoritative `you` state,
//                           replay all inputs newer than ackSeq through the
//                           same kernel, and fold any difference into a
//                           decaying visual offset (or hard-snap if huge).
// Dash/knockback state joins MoveState in M1; damage/deaths are never predicted.

interface PendingInput {
  seq: number;
  cmd: InputCmd;
}

export interface PredictionStats {
  reconciles: number;
  /** Reconcile error absorbed smoothly (units, last / max). */
  lastError: number;
  maxError: number;
  /** Hard position snaps (should be 0 during normal play — acceptance metric). */
  snapCorrections: number;
  pendingInputs: number;
}

const HARD_SNAP_DIST = 2.0; // beyond this, don't smooth — teleport (respawn etc.)
const SMOOTH_HALFLIFE_MS = 60; // visual error decays fast but not instantly

export class Prediction {
  private state: MoveState = { x: 0, y: 0, vx: 0, vy: 0 };
  private pending: PendingInput[] = [];
  private smoothX = 0;
  private smoothY = 0;
  private initialized = false;
  readonly stats: PredictionStats = {
    reconciles: 0,
    lastError: 0,
    maxError: 0,
    snapCorrections: 0,
    pendingInputs: 0,
  };

  constructor(
    private readonly cfg: GameConfig,
    private readonly map: MapData,
  ) {}

  /** Apply a locally sampled input immediately (called at the sim rate, 30Hz). */
  applyLocalInput(seq: number, cmd: InputCmd): void {
    if (!this.initialized) return;
    stepMovement(this.state, cmd, this.cfg, this.map, 1 / this.cfg.tick.simHz);
    this.pending.push({ seq, cmd });
    if (this.pending.length > 120) this.pending.shift(); // safety bound (4s)
    this.stats.pendingInputs = this.pending.length;
  }

  /** Rebase to the authoritative state and replay unacked inputs. */
  onSnapshot(you: YouSnap, ackSeq: number): void {
    if (!this.initialized) {
      this.state = { x: you.x, y: you.y, vx: you.vx, vy: you.vy };
      this.initialized = true;
      return;
    }
    this.pending = this.pending.filter((p) => p.seq > ackSeq);
    this.stats.pendingInputs = this.pending.length;

    const replayed: MoveState = { x: you.x, y: you.y, vx: you.vx, vy: you.vy };
    for (const p of this.pending) {
      stepMovement(replayed, p.cmd, this.cfg, this.map, 1 / this.cfg.tick.simHz);
    }

    const errX = this.state.x - replayed.x;
    const errY = this.state.y - replayed.y;
    const err = Math.hypot(errX, errY);
    this.stats.reconciles++;
    this.stats.lastError = err;
    if (err > this.stats.maxError) this.stats.maxError = err;

    if (err > HARD_SNAP_DIST) {
      // Teleport-scale difference (respawn, huge correction): snap, no smoothing.
      this.smoothX = 0;
      this.smoothY = 0;
      this.stats.snapCorrections++;
    } else {
      // Fold the error into the visual offset so the camera never pops.
      this.smoothX += errX;
      this.smoothY += errY;
    }
    this.state = replayed;
  }

  /** Decay the visual error offset; call once per rendered frame. */
  frame(dtMs: number): void {
    const decay = Math.pow(0.5, dtMs / SMOOTH_HALFLIFE_MS);
    this.smoothX *= decay;
    this.smoothY *= decay;
    if (Math.abs(this.smoothX) < 1e-4) this.smoothX = 0;
    if (Math.abs(this.smoothY) < 1e-4) this.smoothY = 0;
  }

  get ready(): boolean {
    return this.initialized;
  }

  /** Authoritative-predicted position (for aim math). */
  get predicted(): MoveState {
    return this.state;
  }

  /** Render position = predicted + decaying error offset. */
  renderPos(): { x: number; y: number } {
    return { x: this.state.x + this.smoothX, y: this.state.y + this.smoothY };
  }
}
