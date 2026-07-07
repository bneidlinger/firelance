import { describe, expect, it } from 'vitest';
import { getConfigPreset } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { decodeServerMsg, encodeMsg } from '@shared/net/codec';
import { PROTOCOL_VERSION } from '@shared/net/messages';
import type { ServerMsg, SnapMsg } from '@shared/net/messages';
import { Match } from '../src/match';
import { createLocalPair } from '../src/transport';

// Fog-aware liveness: an enemy must be ABSENT from snapshots while out of
// vision, APPEAR the moment it walks into range, and then advance live tick
// after tick — not as a stale value. (M0's frozen-entity regression test,
// upgraded for live fog filtering.)

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

describe('fog-filtered snapshot liveness', () => {
  it('enemy is hidden at range, appears entering vision, then advances live', () => {
    const cfg = getConfigPreset('smoke');
    const match = new Match({ cfg, map: getMap('scrim_small'), seed: 1 });
    const mover = connectClient(match, 'mover'); // squad 0
    const observer = connectClient(match, 'observer'); // squad 1

    const moverId = (mover.msgs.find((m) => m.t === 'welcome') as { playerId: number }).playerId;
    const k0 = match.world.squads[0]!;
    const k1 = match.world.squads[1]!;
    // The scrim map pairs squads 0/1 with keeps on the same row, far apart.
    expect(Math.abs(k1.keepY - k0.keepY)).toBeLessThan(2);
    const gap = Math.abs(k1.keepX - k0.keepX);
    expect(gap).toBeGreaterThan(cfg.vision.radius * 2); // fog actually separates them

    // Drive the mover straight at the observer's keep with fresh inputs.
    for (let seq = 1; seq <= 400; seq++) {
      mover.send(encodeMsg({ t: 'input', seq, tick: seq, mx: 1, my: 0, ax: 1, ay: 0, b: 0 }));
      match.tick();
    }

    const observerSnaps = observer.msgs.filter((m): m is SnapMsg => m.t === 'snap');
    expect(observerSnaps.length).toBeGreaterThanOrEqual(190);

    const presence = observerSnaps.map((s) => s.ents.find((e) => e.i === moverId));
    const firstSeen = presence.findIndex((e) => e !== undefined);
    // Hidden at spawn (fog works)...
    expect(firstSeen).toBeGreaterThan(10);
    // ...but discovered well before the walk ends (fog isn't over-filtering).
    expect(firstSeen).toBeLessThan(presence.length - 20);
    // Absent in EVERY snapshot before first sighting.
    for (let i = 0; i < firstSeen; i++) expect(presence[i]).toBeUndefined();

    // From first sighting on: present and advancing (live, not stale).
    const visibleXs = presence
      .slice(firstSeen)
      .filter((e) => e !== undefined)
      .map((e) => e.x);
    expect(visibleXs.length).toBeGreaterThan(20);
    for (let i = 1; i < visibleXs.length; i++) {
      // Small tolerance: end-of-walk body contact can jitter via pushout.
      expect(visibleXs[i]!).toBeGreaterThanOrEqual(visibleXs[i - 1]! - 0.02);
    }
    const distinct = new Set(visibleXs.map((x) => x.toFixed(2)));
    expect(distinct.size).toBeGreaterThan(15);

    // Sighting distance sanity: first visible position is near the vision edge.
    const firstX = visibleXs[0]!;
    expect(Math.abs(k1.keepX - firstX)).toBeLessThanOrEqual(cfg.vision.radius + 2);
  });

  it('allies always serialize regardless of distance', () => {
    const cfg = getConfigPreset('smoke');
    const match = new Match({ cfg, map: getMap('scrim_small'), seed: 2 });
    // First four joins spread across squads 0-3; the fifth lands on squad 0.
    const a = connectClient(match, 'allyA'); // squad 0
    connectClient(match, 'b'); // squad 1
    connectClient(match, 'c'); // squad 2
    connectClient(match, 'd'); // squad 3
    const e = connectClient(match, 'allyE'); // squad 0 again
    const idA = (a.msgs.find((m) => m.t === 'welcome') as { playerId: number }).playerId;
    const idE = (e.msgs.find((m) => m.t === 'welcome') as { playerId: number }).playerId;

    // Send A far away from the shared keep for 300 ticks.
    for (let seq = 1; seq <= 300; seq++) {
      a.send(encodeMsg({ t: 'input', seq, tick: seq, mx: 0, my: -1, ax: 0, ay: -1, b: 0 }));
      match.tick();
    }
    const eSnaps = e.msgs.filter((m): m is SnapMsg => m.t === 'snap');
    const lastSnap = eSnaps[eSnaps.length - 1]!;
    // Both squadmates present in E's final snapshot: E itself and distant A.
    expect(lastSnap.ents.some((x) => x.i === idA)).toBe(true);
    expect(lastSnap.ents.some((x) => x.i === idE)).toBe(true);
  });
});
