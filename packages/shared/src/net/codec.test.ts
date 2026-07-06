import { describe, expect, it } from 'vitest';
import { decodeClientMsg, decodeServerMsg, encodeMsg } from './codec';
import type { ClientMsg, ServerMsg } from './messages';
import { PROTOCOL_VERSION } from './messages';

const CLIENT_SAMPLES: ClientMsg[] = [
  { t: 'hello', v: PROTOCOL_VERSION, name: 'Brandon' },
  { t: 'hello', v: PROTOCOL_VERSION, name: 'bot1', bot: true },
  { t: 'input', seq: 12, tick: 340, mx: 1, my: -1, ax: 0.6, ay: 0.8, b: 5 },
  { t: 'ping', ct: 123456.78 },
];

const SERVER_SAMPLES: ServerMsg[] = [
  {
    t: 'welcome',
    playerId: 3,
    squadId: 1,
    mapId: 'scrim_small',
    cfgName: 'prototype',
    cfgHash: 'abc123',
    tick: 42,
    tickRate: 30,
    snapRate: 15,
    roster: [{ id: 3, squad: 1, name: 'Brandon', bot: false }],
  },
  {
    t: 'snap',
    tick: 100,
    ackSeq: 55,
    you: { x: 5.123456, y: 9.87, vx: 5, vy: 0 },
    ents: [{ i: 4, x: 10.25, y: 20.5 }],
  },
  { t: 'ev', tick: 100, events: [{ k: 'playerJoined', id: 9, squad: 2, name: 'x', bot: true }] },
  { t: 'pong', ct: 123, tick: 101 },
  { t: 'error', reason: 'room full' },
];

describe('codec round-trips', () => {
  it.each(CLIENT_SAMPLES.map((m) => [m.t, m] as const))('client %s', (_t, msg) => {
    const decoded = decodeClientMsg(encodeMsg(msg));
    expect(decoded).toEqual({ ok: true, msg });
  });

  it.each(SERVER_SAMPLES.map((m) => [m.t, m] as const))('server %s', (_t, msg) => {
    const decoded = decodeServerMsg(encodeMsg(msg));
    expect(decoded).toEqual({ ok: true, msg });
  });
});

describe('codec rejects malformed input', () => {
  it('non-JSON', () => {
    expect(decodeClientMsg('not json{').ok).toBe(false);
  });

  it('non-string frames (binary)', () => {
    expect(decodeClientMsg(Buffer.from([1, 2, 3]) as unknown as string).ok).toBe(false);
  });

  it('arrays and primitives', () => {
    expect(decodeClientMsg('[1,2]').ok).toBe(false);
    expect(decodeClientMsg('42').ok).toBe(false);
    expect(decodeClientMsg('null').ok).toBe(false);
  });

  it('unknown message kinds and cross-direction kinds', () => {
    expect(decodeClientMsg('{"t":"launch_missiles"}').ok).toBe(false);
    expect(decodeClientMsg(encodeMsg({ t: 'pong', ct: 1, tick: 1 })).ok).toBe(false);
    expect(decodeServerMsg(encodeMsg({ t: 'ping', ct: 1 })).ok).toBe(false);
  });

  it('input with non-finite fields', () => {
    expect(
      decodeClientMsg('{"t":"input","seq":null,"tick":1,"mx":0,"my":0,"ax":1,"ay":0,"b":0}').ok,
    ).toBe(false);
    expect(
      decodeClientMsg('{"t":"input","seq":1,"tick":1,"mx":"NaN","my":0,"ax":1,"ay":0,"b":0}').ok,
    ).toBe(false);
  });

  it('hello with bad names', () => {
    expect(decodeClientMsg('{"t":"hello","v":1,"name":""}').ok).toBe(false);
    expect(decodeClientMsg(`{"t":"hello","v":1,"name":"${'x'.repeat(50)}"}`).ok).toBe(false);
  });

  it('oversized frames', () => {
    const huge = `{"t":"ping","ct":1,"pad":"${'x'.repeat(70000)}"}`;
    expect(decodeClientMsg(huge).ok).toBe(false);
  });
});
