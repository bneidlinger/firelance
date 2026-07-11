import { describe, expect, it } from 'vitest';
import { decodeClientMsg, decodeServerMsg, encodeMsg } from './codec';
import type { ClientMsg, ServerMsg } from './messages';
import { PROTOCOL_VERSION } from './messages';

const CLIENT_SAMPLES: ClientMsg[] = [
  { t: 'hello', v: PROTOCOL_VERSION, name: 'Brandon' },
  { t: 'hello', v: PROTOCOL_VERSION, name: 'bot1', bot: true, cls: 'ranger' },
  { t: 'hello', v: PROTOCOL_VERSION, name: 'Brandon', resume: 'a-resume-token' },
  { t: 'input', seq: 12, tick: 340, mx: 1, my: -1, ax: 0.6, ay: 0.8, b: 5 },
  { t: 'class', cls: 'fighter' },
  { t: 'ping', ct: 123456.78 },
];

const SERVER_SAMPLES: ServerMsg[] = [
  {
    t: 'welcome',
    playerId: 3,
    squadId: 1,
    mapId: 'scrim_small',
    variant: { keeps: [0, 1, 2, 4, 6], towns: [1], spawns: [2, 0, 3, 1] },
    cfgName: 'prototype',
    cfgHash: 'abc123',
    tick: 42,
    tickRate: 30,
    snapRate: 15,
    phase: 2,
    phaseEndsTick: 14400,
    roster: [{ id: 3, squad: 1, name: 'Brandon', bot: false }],
    keeps: [{ squad: 1, x: 78.5, y: 36.5, hp: 1200 }],
    resume: 'f00f-1234-token',
  },
  {
    t: 'snap',
    tick: 100,
    ackSeq: 55,
    you: {
      x: 5.123456,
      y: 9.87,
      vx: 5,
      vy: 0,
      dashTicks: 0,
      dashDx: 1,
      dashDy: 0,
      dashCd: 12,
      prevB: 1,
      hp: 87.5,
      alive: true,
      respIn: 0,
      atkPhase: 0,
      atkTicks: 0,
      atkCd: 3,
      cls: 'ranger',
      bounty: 140,
      carried: 320,
      bankTicks: 45,
      rebuildTicks: 0,
      bombs: 2,
      bombCd: 12,
      supply: 160,
      claimTicks: 0,
      rootTicks: 18,
    },
    ents: [
      { i: 4, x: 10.25, y: 20.5, ax: 0.6, ay: 0.8, hp: 90, cls: 'fighter', st: 1 },
      { i: 5, x: 11, y: 20, ax: 1, ay: 0, hp: 90, cls: 'ranger', st: 16, g: 250 },
    ],
    sacks: [{ i: 12, x: 40.5, y: 61.25, g: 480 }],
    structures: [
      { i: 30, k: 0, s: 2, tx: 42, ty: 60, hp: 200, mx: 200 },
      { i: 31, k: 0, s: 2, tx: 43, ty: 60, hp: 85, mx: 200 },
      { i: 32, k: 3, s: 2, tx: 44, ty: 60, hp: 1, mx: 1, ar: 1 },
    ],
  },
  {
    t: 'ev',
    tick: 100,
    events: [
      { k: 'playerJoined', tk: 100, id: 9, squad: 2, name: 'x', bot: true },
      {
        k: 'projSpawn',
        tk: 99,
        id: 77,
        owner: 3,
        squad: 1,
        x: 5,
        y: 9,
        dx: 0.6,
        dy: 0.8,
        speed: 14,
        ttl: 48,
      },
      {
        k: 'kill',
        tk: 100,
        killer: 3,
        victim: 4,
        gold: 140,
        victimBounty: 90,
        droppedGold: 480,
        assists: [5],
      },
      { k: 'banked', tk: 101, squad: 2, by: 7, amount: 600, x: 48.5, y: 70.5 },
      { k: 'sackTaken', tk: 102, id: 12, by: 8, squad: 3, gold: 480, x: 40.5, y: 61.25 },
      {
        k: 'bombSpawn',
        tk: 103,
        id: 90,
        owner: 3,
        squad: 1,
        x: 5,
        y: 9,
        tx: 11,
        ty: 10,
        flightTicks: 18,
      },
      { k: 'bombEnd', tk: 121, id: 90, squad: 1, x: 11, y: 10 },
      { k: 'keepHit', tk: 121, squad: 2, hp: 1050, x: 79.5, y: 36.5 },
      { k: 'keepDestroyed', tk: 500, squad: 2, x: 79.5, y: 36.5, spilled: 730 },
      { k: 'keepRebuilt', tk: 900, squad: 2, x: 16.5, y: 60.5, by: 7 },
      { k: 'eliminated', tk: 1200, squad: 3 },
      { k: 'rumor', tk: 1250, kind: 'bounty', id: 7, squad: 2, x: 61.2, y: 40.9, tier: 3 },
      { k: 'rumor', tk: 1260, kind: 'richKeep', id: -1, squad: 1, x: 20.1, y: 88.4, tier: 0 },
      { k: 'trapTriggered', tk: 1300, id: 32, squad: 2, victim: 4, x: 44.5, y: 60.5 },
      {
        k: 'hit',
        tk: 1300,
        attacker: -1,
        victim: 4,
        amount: 35,
        hp: 55,
        kind: 'trap',
        blocked: false,
        x: 44.5,
        y: 60.5,
      },
    ],
  },
  {
    t: 'score',
    tick: 105,
    phase: 1,
    phaseEndsTick: 14400,
    players: [{ id: 3, b: 140, k: 2, d: 1, a: 0 }],
    squads: [
      { id: 0, bk: 900, kh: 1200, el: false, g: 250, wd: 100, rb: 1 },
      { id: 1, bk: 400, kh: 0, el: true },
    ],
  },
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

  it('bad class ids', () => {
    expect(decodeClientMsg('{"t":"hello","v":1,"name":"x","cls":"wizard"}').ok).toBe(false);
    expect(decodeClientMsg('{"t":"class","cls":"wizard"}').ok).toBe(false);
    expect(decodeClientMsg('{"t":"class","cls":42}').ok).toBe(false);
  });

  it('welcome without a map variant (pre-v10 server)', () => {
    const legacy = { ...SERVER_SAMPLES[0]! } as Record<string, unknown>;
    delete legacy.variant;
    expect(decodeServerMsg(JSON.stringify(legacy)).ok).toBe(false);
  });

  it('bad resume tokens', () => {
    expect(decodeClientMsg('{"t":"hello","v":1,"name":"x","resume":42}').ok).toBe(false);
    expect(decodeClientMsg(`{"t":"hello","v":1,"name":"x","resume":"${'t'.repeat(100)}"}`).ok).toBe(
      false,
    );
  });

  it('oversized frames', () => {
    const huge = `{"t":"ping","ct":1,"pad":"${'x'.repeat(70000)}"}`;
    expect(decodeClientMsg(huge).ok).toBe(false);
  });
});
