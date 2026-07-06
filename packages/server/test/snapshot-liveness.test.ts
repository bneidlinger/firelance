import { describe, expect, it } from 'vitest';
import { getConfigPreset } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { decodeServerMsg, encodeMsg } from '@shared/net/codec';
import { PROTOCOL_VERSION } from '@shared/net/messages';
import type { ServerMsg, SnapMsg } from '@shared/net/messages';
import { Match } from '../src/match';
import { createLocalPair } from '../src/transport';

// Regression test for the frozen-entity investigation: a second client on a
// DIFFERENT squad must see another player's live position in its snapshot
// ents, tick after tick — not a stale value.

function connectClient(
  match: Match,
  name: string,
): { msgs: ServerMsg[]; send: (d: string) => void } {
  const pair = createLocalPair();
  const msgs: ServerMsg[] = [];
  pair.clientEnd.onMessage((d) => {
    const r = decodeServerMsg(d);
    if (r.ok) msgs.push(r.msg);
  });
  match.addConn(pair.serverEnd);
  pair.clientEnd.send(encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name }));
  return { msgs, send: (d: string) => pair.clientEnd.send(d) };
}

describe('snapshot liveness across squads', () => {
  it('observer on another squad sees the mover advance every snapshot tick', () => {
    const match = new Match({ cfg: getConfigPreset('smoke'), map: getMap('scrim_small'), seed: 1 });
    const mover = connectClient(match, 'mover'); // squad 0, id 1
    const observer = connectClient(match, 'observer'); // squad 1, id 2

    const moverId = (mover.msgs.find((m) => m.t === 'welcome') as { playerId: number }).playerId;

    // Drive the mover east with fresh inputs every tick for 60 ticks.
    for (let seq = 1; seq <= 60; seq++) {
      mover.send(encodeMsg({ t: 'input', seq, tick: seq, mx: 1, my: 0, ax: 1, ay: 0, b: 0 }));
      match.tick();
    }

    const observerSnaps = observer.msgs.filter((m): m is SnapMsg => m.t === 'snap');
    expect(observerSnaps.length).toBeGreaterThanOrEqual(25);

    const xs = observerSnaps.map((s) => s.ents.find((e) => e.i === moverId)?.x ?? -1);
    // The mover must appear in every observer snapshot...
    expect(xs.every((x) => x >= 0)).toBe(true);
    // ...and its x must advance across snapshots (5 u/s for 2s = ~10 units).
    const travelled = xs[xs.length - 1]! - xs[0]!;
    expect(travelled).toBeGreaterThan(8);
    // Strictly non-decreasing with at least 20 distinct positions (live, not stale).
    const distinct = new Set(xs.map((x) => x.toFixed(2)));
    expect(distinct.size).toBeGreaterThan(20);
  });
});
