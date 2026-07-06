import type { InputMsg } from '@shared/net/messages';
import type { InputCmd } from '@shared/sim/world';

// Latest-wins input slot per player. TCP never drops inputs, only delays them;
// when none arrived for a tick the sim reuses the player's previous input.

export interface InputSlot {
  latest: InputCmd | null;
  latestSeq: number;
  /** Seq acked back to this client in its snapshots. */
  appliedSeq: number;
}

export function createInputSlot(): InputSlot {
  return { latest: null, latestSeq: 0, appliedSeq: 0 };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Server-side trust boundary: clamp movement, re-normalize aim, mask buttons.
 * The sanitized command is what gets recorded into replays, so replay
 * determinism never depends on client-supplied garbage.
 */
export function sanitizeInput(m: InputMsg): InputCmd {
  let ax = clamp(m.ax, -1, 1);
  let ay = clamp(m.ay, -1, 1);
  const l = Math.sqrt(ax * ax + ay * ay);
  if (l > 1e-6) {
    ax /= l;
    ay /= l;
  } else {
    ax = 1;
    ay = 0;
  }
  return {
    mx: clamp(m.mx, -1, 1),
    my: clamp(m.my, -1, 1),
    ax,
    ay,
    b: m.b & 0xff,
  };
}

export function acceptInput(slot: InputSlot, m: InputMsg): void {
  if (m.seq <= slot.latestSeq) return; // stale or duplicate
  slot.latestSeq = m.seq;
  slot.latest = sanitizeInput(m);
}
