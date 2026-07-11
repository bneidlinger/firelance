import { describe, expect, it } from 'vitest';
import type { StructSnap } from '@shared/net/messages';
import { GhostMemory } from './ghosts';

// Last-known-position memory (M5 s3): remember under fog, verify-forget with
// eyes on, live wire always wins, secrets (traps) and own pieces never ghost.

const snap = (i: number, s: number, hp = 200, k = 0): StructSnap => ({
  i,
  k,
  s,
  tx: 10 + i,
  ty: 20,
  hp,
  mx: 200,
});

const FOGGED = (): boolean => false;
const VISIBLE = (): boolean => true;

describe('GhostMemory', () => {
  it('an enemy wall the fog re-covers becomes a ghost at its last-seen state', () => {
    const m = new GhostMemory();
    expect(m.update([snap(1, 2)], 0, VISIBLE)).toEqual([]); // live — no ghost
    const ghosts = m.update([], 0, FOGGED);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]!.i).toBe(1);
    expect(ghosts[0]!.hp).toBe(200);
  });

  it('the ghost shows the LAST look — damage seen before losing sight sticks', () => {
    const m = new GhostMemory();
    m.update([snap(1, 2, 200)], 0, VISIBLE);
    m.update([snap(1, 2, 85)], 0, VISIBLE); // watched it take a bomb
    const ghosts = m.update([], 0, FOGGED);
    expect(ghosts[0]!.hp).toBe(85);
  });

  it('eyes on an empty tile forgets the ghost — verified gone', () => {
    const m = new GhostMemory();
    m.update([snap(1, 2)], 0, VISIBLE);
    expect(m.update([], 0, FOGGED)).toHaveLength(1);
    expect(m.update([], 0, VISIBLE)).toHaveLength(0); // walked back, nothing there
    expect(m.size).toBe(0);
    expect(m.update([], 0, FOGGED)).toHaveLength(0); // stays forgotten
  });

  it('a reappearing structure renders live, not as a ghost', () => {
    const m = new GhostMemory();
    m.update([snap(1, 2)], 0, VISIBLE);
    m.update([], 0, FOGGED);
    expect(m.update([snap(1, 2, 120)], 0, VISIBLE)).toEqual([]); // live wins
    expect(m.size).toBe(1); // still remembered for the next fade
  });

  it('own structures and traps never ghost', () => {
    const m = new GhostMemory();
    m.update([snap(1, 0), snap(2, 2, 1, 3)], 0, VISIBLE); // own wall + enemy trap
    expect(m.update([], 0, FOGGED)).toHaveLength(0);
    expect(m.size).toBe(0);
  });

  it('forget(id) — a structDestroyed event kills the memory for good', () => {
    const m = new GhostMemory();
    m.update([snap(1, 2)], 0, VISIBLE);
    m.forget(1);
    expect(m.update([], 0, FOGGED)).toHaveLength(0);
  });

  it('clear() wipes everything (fresh match)', () => {
    const m = new GhostMemory();
    m.update([snap(1, 2), snap(2, 3)], 0, VISIBLE);
    m.clear();
    expect(m.update([], 0, FOGGED)).toHaveLength(0);
  });
});
