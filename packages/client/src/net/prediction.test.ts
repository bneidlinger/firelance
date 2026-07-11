import { describe, expect, it } from 'vitest';
import { getConfigPreset } from '@shared/config';
import { getMap } from '@shared/map/maps';
import type { YouSnap } from '@shared/net/messages';
import type { InputCmd } from '@shared/sim/world';
import { Prediction } from './prediction';

// The client half of the restart input-epoch contract (main.ts 'welcome' +
// match.ts restart()): the server resets its input slot on EVERY welcome, the
// client keeps ONE monotonic seq per page and swaps in a FRESH Prediction.
// These tests pin the drain arithmetic that pairing relies on — and the pin
// that bites if either half breaks it (pendingInputs stuck at the 120 cap,
// lastError 0, every reconcile replaying a dead epoch).

const cfg = getConfigPreset('smoke');
const map = getMap('scrim_small');

const IDLE: InputCmd = { mx: 0, my: 0, ax: 1, ay: 0, b: 0 };

function you(over: Partial<YouSnap> = {}): YouSnap {
  return {
    x: 10,
    y: 10,
    vx: 0,
    vy: 0,
    dashTicks: 0,
    dashDx: 0,
    dashDy: 0,
    dashCd: 0,
    prevB: 0,
    hp: 100,
    alive: true,
    respIn: 0,
    atkPhase: 0,
    atkTicks: 0,
    atkCd: 0,
    cls: 'ranger',
    bounty: 0,
    carried: 0,
    bankTicks: 0,
    rebuildTicks: 0,
    bombs: 0,
    bombCd: 0,
    supply: 0,
    claimTicks: 0,
    rootTicks: 0,
    ...over,
  };
}

describe('prediction pending-input drain', () => {
  it('drains to the unacked tail as snapshots ack (post-restart shape)', () => {
    const pred = new Prediction(cfg, map);
    pred.onSnapshot(you(), 0); // initialize

    // Fresh Prediction after a restart welcome: the page seq counter does NOT
    // reset, so the very first inputs of the new epoch carry high seqs.
    for (let seq = 14001; seq <= 14010; seq++) pred.applyLocalInput(seq, IDLE);
    expect(pred.stats.pendingInputs).toBe(10);
    expect(pred.stats.pendingSeqLo).toBe(14001);
    expect(pred.stats.pendingSeqHi).toBe(14010);

    // The fresh slot hasn't applied anything yet — an ack of 0 drops nothing.
    pred.onSnapshot(you(), 0);
    expect(pred.stats.pendingInputs).toBe(10);

    // Slot caught up: pending collapses to the unacked (~RTT-sized) tail.
    pred.onSnapshot(you(), 14008);
    expect(pred.stats.pendingInputs).toBe(2);
    expect(pred.stats.ackSeq).toBe(14008);
    expect(pred.stats.pendingSeqLo).toBe(14009);
    expect(pred.stats.pendingSeqHi).toBe(14010);
  });

  it('caps the buffer at 120 while acks stall, keeping the newest window', () => {
    const pred = new Prediction(cfg, map);
    pred.onSnapshot(you(), 0);
    for (let seq = 1; seq <= 150; seq++) pred.applyLocalInput(seq, IDLE);
    expect(pred.stats.pendingInputs).toBe(120);
    expect(pred.stats.pendingSeqLo).toBe(31); // oldest 30 shifted out
    expect(pred.stats.pendingSeqHi).toBe(150);
  });

  it('pins at the cap when reused across an ack-epoch reset — why welcome swaps in a fresh one', () => {
    // The 2026-07-09 field bug, kept as documentation: a prediction REUSED
    // across a restart (or a client that resets its seq counter) holds seqs
    // the new epoch's acks can never reach. Trimming keeps seq > ackSeq, so
    // the fossils survive every snapshot: pendingInputs sits on the 120 cap,
    // lastError reads 0 (idle fossils replay to the same spot), and every
    // reconcile burns 120 replay steps while masking real desyncs.
    const stale = new Prediction(cfg, map);
    stale.onSnapshot(you(), 0);
    for (let seq = 14000; seq < 14150; seq++) stale.applyLocalInput(seq, IDLE);
    expect(stale.stats.pendingInputs).toBe(120);

    stale.onSnapshot(you(), 3); // reset slot acks restart tiny
    expect(stale.stats.pendingInputs).toBe(120); // nothing drains…
    stale.onSnapshot(you(), 50);
    expect(stale.stats.pendingInputs).toBe(120); // …and never will
    expect(stale.stats.pendingSeqLo).toBe(14030); // the fossil window, intact
    expect(stale.stats.ackSeq).toBe(50); // pinned below it forever
    expect(stale.stats.lastError).toBe(0); // the silent version of the failure

    // The contract fix: the welcome handler builds a FRESH Prediction and the
    // page seq continues monotonically — the reset slot acks the continuation
    // directly and the buffer stays RTT-sized.
    const fresh = new Prediction(cfg, map);
    fresh.onSnapshot(you(), 0);
    for (let seq = 14150; seq <= 14152; seq++) fresh.applyLocalInput(seq, IDLE);
    fresh.onSnapshot(you(), 14151);
    expect(fresh.stats.pendingInputs).toBe(1);
    expect(fresh.stats.pendingSeqLo).toBe(14152);
    expect(fresh.stats.pendingSeqHi).toBe(14152);
  });
});
