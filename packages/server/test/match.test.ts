import { describe, expect, it } from 'vitest';
import { getConfigPreset } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { encodeMsg } from '@shared/net/codec';
import { PROTOCOL_VERSION } from '@shared/net/messages';
import { runInProcessMatch } from '../src/harness';
import { Match } from '../src/match';
import { createLocalPair } from '../src/transport';

describe('in-process smoke match (turbo)', () => {
  it('4 bots roam 60 sim-seconds: no violations, replay matches live', async () => {
    const result = await runInProcessMatch({ bots: 4, simSeconds: 60, seed: 12345 });
    expect(result.violations).toEqual([]);
    expect(result.players).toBe(4);
    expect(result.ticks).toBe(1800);
    expect(result.stats.snapshotsSent).toBeGreaterThan(0);
    expect(result.stats.inputsAccepted).toBeGreaterThan(0);
    expect(result.replayHash).toBe(result.finalHash);
    // bots actually roam (not vacuous)
    const moved = result.playerSummary.filter((p) => p.distFromSpawn > 3);
    expect(moved.length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('same seed twice produces identical final hashes (end-to-end determinism)', async () => {
    const a = await runInProcessMatch({ bots: 4, simSeconds: 30, seed: 777 });
    const b = await runInProcessMatch({ bots: 4, simSeconds: 30, seed: 777 });
    expect(a.violations).toEqual([]);
    expect(a.finalHash).toBe(b.finalHash);
  }, 30_000);

  it('different seeds diverge', async () => {
    const a = await runInProcessMatch({ bots: 4, simSeconds: 20, seed: 1 });
    const b = await runInProcessMatch({ bots: 4, simSeconds: 20, seed: 2 });
    expect(a.finalHash).not.toBe(b.finalHash);
  }, 30_000);
});

describe('match connection handling', () => {
  function makeMatch(): Match {
    return new Match({ cfg: getConfigPreset('smoke'), map: getMap('scrim_small'), seed: 1 });
  }

  it('drops connections whose first frame is not a valid hello', () => {
    const match = makeMatch();
    const pair = createLocalPair();
    match.addConn(pair.serverEnd);
    pair.clientEnd.send('garbage{{{');
    expect(pair.clientEnd.closed).toBe(true);
    expect(match.playerCount).toBe(0);
  });

  it('rejects protocol version mismatches with an error message', () => {
    const match = makeMatch();
    const pair = createLocalPair();
    const received: string[] = [];
    pair.clientEnd.onMessage((d) => received.push(d));
    match.addConn(pair.serverEnd);
    pair.clientEnd.send(JSON.stringify({ t: 'hello', v: 999, name: 'old-client' }));
    expect(received.some((d) => d.includes('protocol mismatch'))).toBe(true);
    expect(match.playerCount).toBe(0);
  });

  it('rejects joins beyond capacity', () => {
    const match = makeMatch();
    const capacity = 12;
    for (let i = 0; i < capacity; i++) {
      const pair = createLocalPair();
      match.addConn(pair.serverEnd);
      pair.clientEnd.send(encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name: `p${i}`, bot: true }));
    }
    expect(match.playerCount).toBe(capacity);
    const extra = createLocalPair();
    const received: string[] = [];
    extra.clientEnd.onMessage((d) => received.push(d));
    match.addConn(extra.serverEnd);
    extra.clientEnd.send(encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name: 'late', bot: true }));
    expect(match.playerCount).toBe(capacity);
    expect(received.some((d) => d.includes('match full'))).toBe(true);
  });

  it('spreads players round-robin across squads and answers pings', () => {
    const match = makeMatch();
    const pings: string[] = [];
    for (let i = 0; i < 4; i++) {
      const pair = createLocalPair();
      if (i === 0) pair.clientEnd.onMessage((d) => pings.push(d));
      match.addConn(pair.serverEnd);
      pair.clientEnd.send(encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name: `p${i}` }));
      if (i === 0) pair.clientEnd.send(encodeMsg({ t: 'ping', ct: 424242 }));
    }
    const squads = new Set([...match.world.players.values()].map((p) => p.squad));
    expect(squads.size).toBe(4);
    expect(pings.some((d) => d.includes('"pong"') && d.includes('424242'))).toBe(true);
  });

  it('bot disconnects remove the body immediately', () => {
    const match = makeMatch();
    const pair = createLocalPair();
    match.addConn(pair.serverEnd);
    pair.clientEnd.send(encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name: 'ghost', bot: true }));
    expect(match.playerCount).toBe(1);
    pair.clientEnd.close();
    expect(match.playerCount).toBe(0);
    expect(match.world.players.size).toBe(0);
  });

  it('human disconnects free the seat but park the body for resume', () => {
    const match = makeMatch();
    const pair = createLocalPair();
    match.addConn(pair.serverEnd);
    pair.clientEnd.send(encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name: 'ghost' }));
    expect(match.playerCount).toBe(1);
    pair.clientEnd.close();
    expect(match.playerCount).toBe(0);
    expect(match.world.players.size).toBe(1); // body waits out the grace window
  });
});
