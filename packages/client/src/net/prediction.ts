import type { ClassId, GameConfig } from '@shared/config';
import type { MapData } from '@shared/map/types';
import type { YouSnap } from '@shared/net/messages';
import { carrySpeedFactor } from '@shared/sim/systems/economy';
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
  /** Last snapshot ack + the seq window still buffered. Healthy: ackSeq rides
   *  just under pendingSeqHi and the window stays ~RTT-sized. A gap that never
   *  closes (ackSeq pinned below pendingSeqLo) is a stale input epoch — the
   *  restart-contract failure this pair exists to expose. */
  ackSeq: number;
  pendingSeqLo: number;
  pendingSeqHi: number;
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
  /** Carried gold from the last acked snapshot — the carry-slow the server is
   *  applying to us. Lags the trickle by one RTT; smoothing absorbs the sliver. */
  private carried = 0;
  /** Structure occupancy from the latest snapshot — walls the client predicts
   *  against (own walls are always in the snapshot, so the common case is exact). */
  private occ: ReadonlySet<number> | null = null;
  readonly stats: PredictionStats = {
    reconciles: 0,
    lastError: 0,
    maxError: 0,
    snapCorrections: 0,
    pendingInputs: 0,
    ackSeq: 0,
    pendingSeqLo: 0,
    pendingSeqHi: 0,
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

  /** Feed the newest snapshot's structure occupancy so wall collision predicts. */
  setOccupancy(occ: ReadonlySet<number> | null): void {
    this.occ = occ;
  }

  get classId(): ClassId {
    return this.cls;
  }

  /** Apply a locally sampled input immediately (called at the sim rate, 30Hz). */
  applyLocalInput(seq: number, cmd: InputCmd): void {
    if (!this.initialized || !this.aliveState) return;
    const factor = carrySpeedFactor(this.cfg, this.carried);
    stepMovement(this.state, cmd, this.params, this.map, 1 / this.cfg.tick.simHz, factor, this.occ);
    this.pending.push({ seq, cmd });
    if (this.pending.length > 120) this.pending.shift(); // safety bound (4s)
    this.syncPendingStats();
  }

  /** pending is seq-ordered (push-only), so the window is just the ends. */
  private syncPendingStats(): void {
    this.stats.pendingInputs = this.pending.length;
    this.stats.pendingSeqLo = this.pending[0]?.seq ?? 0;
    this.stats.pendingSeqHi = this.pending[this.pending.length - 1]?.seq ?? 0;
  }

  /** Rebase to the authoritative state and replay unacked inputs. */
  onSnapshot(you: YouSnap, ackSeq: number): void {
    this.stats.ackSeq = ackSeq;
    if (you.cls !== this.cls) {
      this.cls = you.cls;
      this.params = kitMoveParams(this.cfg, you.cls);
    }
    this.carried = you.carried;

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
      // Trap roots replay through the kernel like dashes do. The trigger
      // itself can't be predicted (the trap is invisible by design) — the
      // one-time stop it causes arrives here as a normal reconcile.
      rootTicks: you.rootTicks,
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
      this.syncPendingStats();
      this.smoothX = 0;
      this.smoothY = 0;
      return;
    }
    if (!this.aliveState) {
      // Just respawned: adopt the server position outright.
      this.aliveState = true;
      this.state = authoritative;
      this.pending = [];
      this.syncPendingStats();
      this.smoothX = 0;
      this.smoothY = 0;
      return;
    }

    this.pending = this.pending.filter((p) => p.seq > ackSeq);
    this.syncPendingStats();

    const replayed = authoritative;
    const preX = this.state.x;
    const preY = this.state.y;
    const factor = carrySpeedFactor(this.cfg, this.carried);
    for (const p of this.pending) {
      stepMovement(
        replayed,
        p.cmd,
        this.params,
        this.map,
        1 / this.cfg.tick.simHz,
        factor,
        this.occ,
      );
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
