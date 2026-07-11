import { describe, expect, it } from 'vitest';
import { getConfigPreset, type GameConfig } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { decodeServerMsg, encodeMsg } from '@shared/net/codec';
import { PROTOCOL_VERSION, type SummaryMsg } from '@shared/net/messages';
import { Match } from '../src/match';
import { createLocalPair } from '../src/transport';

// The match-summary broadcast (M5 s4): 1Hz banked samples from goLive to
// matchEnd, big-beat marks, one message per match end, fresh series after
// the auto-restart. Driven over real conns with a hand-mutated ledger —
// this pins the SAMPLING, not the economy (banking.test owns that).

const fast: GameConfig = {
  ...getConfigPreset('smoke'),
  match: { ...getConfigPreset('smoke').match, durationSec: 5, restartSec: 1 },
};
const HZ = fast.tick.simHz;

function probe(match: Match): { summaries: SummaryMsg[] } {
  const pair = createLocalPair();
  const summaries: SummaryMsg[] = [];
  pair.clientEnd.onMessage((d) => {
    const decoded = decodeServerMsg(d);
    if (decoded.ok && decoded.msg.t === 'summary') summaries.push(decoded.msg);
  });
  match.addConn(pair.serverEnd);
  pair.clientEnd.send(encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name: 'watcher', bot: true }));
  return { summaries };
}

describe('gold-flow summary', () => {
  it('one summary per match end: 1Hz series, baseline + final, monotonic', () => {
    const match = new Match({ cfg: fast, map: getMap('scrim_small'), seed: 9 });
    const { summaries } = probe(match);

    // Bank something mid-match (direct ledger poke — sampling test only).
    for (let i = 0; i < HZ * 7; i++) {
      match.tick();
      if (match.world.tick === Math.floor(HZ * 2.5)) {
        match.world.squads[0]!.bankedGold = 120;
      }
    }

    expect(summaries).toHaveLength(1);
    const s = summaries[0]!;
    expect(s.everyTicks).toBe(HZ);
    expect(s.banked).toHaveLength(fast.match.squads);
    // durationSec 5 → baseline + 4 interval samples + the matchEnd word.
    for (const series of s.banked) expect(series).toHaveLength(6);
    // Monotonic by construction (banked never decreases).
    for (const series of s.banked) {
      for (let i = 1; i < series.length; i++) {
        expect(series[i]!).toBeGreaterThanOrEqual(series[i - 1]!);
      }
    }
    // The poke shows up and sticks to the end.
    expect(s.banked[0]![0]).toBe(0);
    expect(s.banked[0]![5]).toBe(120);
    expect(s.banked[1]![5]).toBe(0);
  });

  it('an elimination lands in the marks', () => {
    const match = new Match({ cfg: fast, map: getMap('scrim_small'), seed: 10 });
    const { summaries } = probe(match);
    for (let i = 0; i < HZ * 7; i++) {
      match.tick();
      if (match.world.tick === HZ * 2) {
        // Keepless and memberless: the elimination sweep takes squad 1.
        match.world.squads[1]!.keepHp = 0;
      }
    }
    expect(summaries).toHaveLength(1);
    const marks = summaries[0]!.marks;
    expect(marks.some((m) => m.k === 'eliminated' && m.squad === 1)).toBe(true);
  });

  it('the restart starts a fresh story', () => {
    const match = new Match({ cfg: fast, map: getMap('scrim_small'), seed: 11 });
    const { summaries } = probe(match);
    for (let i = 0; i < HZ * 14; i++) {
      match.tick();
      if (match.world.tick === HZ * 2 && summaries.length === 0) {
        match.world.squads[2]!.bankedGold = 300; // first match only
      }
    }
    expect(summaries).toHaveLength(2);
    const [a, b] = summaries;
    expect(a!.banked[2]![5]).toBe(300);
    expect(b!.banked[2]!.every((v) => v === 0)).toBe(true); // fresh ledger
    expect(b!.startTick).toBeGreaterThan(0);
    expect(b!.banked[0]).toHaveLength(6);
  });
});
