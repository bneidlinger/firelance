import type { ClassId, GameConfig } from '@shared/config';
import type { MapData } from '@shared/map/types';
import type { YouSnap } from '@shared/net/messages';
import {
  createMoveState,
  kitMoveParams,
  stepMovement,
  type MoveParams,
  type MoveState,
} from '@shared/sim/systems/movement';
import type { InputCmd } from '@shared/sim/world';

// Client-side prediction of OWN movement only — the file the game-feel bet
// rides on. Flow:
//   local input sampled  -> apply the SHARED movement kernel immediately, buffer it
//   snapshot arrives     -> rebase to the server's authoritative `you` state
//                           (now including dash state — dashes are predicted),
//                           replay all inputs newer than ackSeq through the
//                           same kernel, and fold any difference into a
//                           decaying visual offset (or hard-snap if huge).
// Deaths are never predicted: while `you.alive` is false prediction freezes,
// and the respawn teleport arrives as a clean hard snap.

interface PendingInput {
  seq: number;
  cmd: InputCmd;
}

export interface PredictionStats {
  reconciles: number;
  /** Reconcile error absorbed smoothly (units, last / max). */
  lastError: number;
  maxError: number;
  /** Hard position snaps (respawns excepted — those are intentional). */
  snapCorrections: number;
  pendingInputs: number;
}

const HARD_SNAP_DIST = 2.0; // beyond this, don't smooth — teleport (respawn etc.)
const SMOOTH_HALFLIFE_MS = 60; // visual error decays fast but not instantly

export class Prediction {
  private state: MoveState = createMoveState(0, 0);
  private pending: PendingInput[] = [];
  private smoothX = 0;
  private smoothY = 0;
  private initialized = false;
  private params: MoveParams;
  private cls: ClassId;
  private aliveState = true;
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
    initialCls: ClassId = 'ranger',
  ) {
    this.cls = initialCls;
    this.params = kitMoveParams(cfg, initialCls);
  }

  get alive(): boolean {
    return this.aliveState;
  }

  get classId(): ClassId {
    return this.cls;
  }

  /** Apply a locally sampled input immediately (called at the sim rate, 30Hz). */
  applyLocalInput(seq: number, cmd: InputCmd): void {
    if (!this.initialized || !this.aliveState) return;
    stepMovement(this.state, cmd, this.params, this.map, 1 / this.cfg.tick.simHz);
    this.pending.push({ seq, cmd });
    if (this.pending.length > 120) this.pending.shift(); // safety bound (4s)
    this.stats.pendingInputs = this.pending.length;
  }

  /** Rebase to the authoritative state and replay unacked inputs. */
  onSnapshot(you: YouSnap, ackSeq: number): void {
    if (you.cls !== this.cls) {
      this.cls = you.cls;
      this.params = kitMoveParams(this.cfg, you.cls);
    }

    const authoritative: MoveState = {
      x: you.x,
      y: you.y,
      vx: you.vx,
      vy: you.vy,
      dashTicks: you.dashTicks,
      dashDx: you.dashDx,
      dashDy: you.dashDy,
      dashCd: you.dashCd,
      prevB: you.prevB,
    };

    if (!this.initialized) {
      this.state = authoritative;
      this.initialized = true;
      this.aliveState = you.alive;
      return;
    }

    // Death/respawn boundaries: no prediction across them, clean snaps.
    if (!you.alive) {
      this.aliveState = false;
      this.state = authoritative;
      this.pending = [];
      this.stats.pendingInputs = 0;
      this.smoothX = 0;
      this.smoothY = 0;
      return;
    }
    if (!this.aliveState) {
      // Just respawned: adopt the server position outright.
      this.aliveState = true;
      this.state = authoritative;
      this.pending = [];
      this.stats.pendingInputs = 0;
      this.smoothX = 0;
      this.smoothY = 0;
      return;
    }

    this.pending = this.pending.filter((p) => p.seq > ackSeq);
    this.stats.pendingInputs = this.pending.length;

    const replayed = authoritative;
    const preX = this.state.x;
    const preY = this.state.y;
    for (const p of this.pending) {
      stepMovement(replayed, p.cmd, this.params, this.map, 1 / this.cfg.tick.simHz);
    }

    const errX = preX - replayed.x;
    const errY = preY - replayed.y;
    const err = Math.hypot(errX, errY);
    this.stats.reconciles++;
    this.stats.lastError = err;
    if (err > this.stats.maxError) this.stats.maxError = err;

    if (err > HARD_SNAP_DIST) {
      // Teleport-scale difference (huge correction): snap, no smoothing.
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

  /** Authoritative-predicted state (for aim math and dash HUD). */
  get predicted(): MoveState {
    return this.state;
  }

  /** Render position = predicted + decaying error offset. */
  renderPos(): { x: number; y: number } {
    return { x: this.state.x + this.smoothX, y: this.state.y + this.smoothY };
  }
}
