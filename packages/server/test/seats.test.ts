import { describe, expect, it } from 'vitest';
import { BotBrain } from '@bots/brain';
import { LocalBotDriver } from '@bots/localdriver';
import { getConfigPreset } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { decodeServerMsg, encodeMsg } from '@shared/net/codec';
import type { ServerMsg, WelcomeMsg } from '@shared/net/messages';
import { PROTOCOL_VERSION } from '@shared/net/messages';
import { totalGoldInWorld } from '@shared/sim/systems/economy';
import { hashWorld } from '@shared/sim/world';
import { Match } from '../src/match';
import { replayToHash } from '../src/replay';
import { runTurboTicks } from '../src/ticker';
import { createLocalPair, type LocalPair } from '../src/transport';

// Seat lifecycle for real playtests: humans evict bots from full matches,
// refreshes resume the same body via token (through the disconnect race),
// abandoned bodies wait out a grace window then leave WITHOUT destroying
// carried gold — and the whole leave path replays bit-identically.

const cfg = getConfigPreset('smoke');
const map = getMap('scrim_small');

interface TestClient {
  pair: LocalPair;
  msgs: ServerMsg[];
  welcome(): WelcomeMsg;
}

function connect(
  match: Match,
  name: string,
  opts: { bot?: boolean; resume?: string } = {},
): TestClient {
  const pair = createLocalPair();
  const msgs: ServerMsg[] = [];
  pair.clientEnd.onMessage((d) => {
    const r = decodeServerMsg(d);
    if (r.ok) msgs.push(r.msg);
  });
  match.addConn(pair.serverEnd);
  pair.clientEnd.send(
    encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name, bot: opts.bot, resume: opts.resume }),
  );
  return {
    pair,
    msgs,
    welcome() {
      const w = msgs.find((m) => m.t === 'welcome');
      expect(w, `${name} never got a welcome`).toBeDefined();
      return w as WelcomeMsg;
    },
  };
}

function mkMatch(): Match {
  return new Match({ cfg, map, seed: 5 });
}

describe('bot eviction: humans take seats back', () => {
  it('a human joining a bot-padded full match evicts a bot and keeps balance', () => {
    const match = mkMatch();
    for (let i = 0; i < 11; i++) connect(match, `b${i}`, { bot: true });
    const human1 = connect(match, 'alice');
    expect(match.playerCount).toBe(12);
    expect(human1.welcome().playerId).toBeGreaterThan(0);

    // Full of 11 bots + alice: bob must displace a bot, not bounce.
    const human2 = connect(match, 'bob');
    expect(human2.welcome()).toBeDefined();
    expect(match.playerCount).toBe(12);
    expect(match.botSeats).toBe(10);
    // Squads stay 3/3/3/3 after the swap.
    const perSquad = new Map<number, number>();
    for (const p of match.world.players.values()) {
      perSquad.set(p.squad, (perSquad.get(p.squad) ?? 0) + 1);
    }
    expect([...perSquad.values()]).toEqual([3, 3, 3, 3]);
  });

  it('bots never evict anyone, and human-full matches still reject', () => {
    const match = mkMatch();
    for (let i = 0; i < 12; i++) connect(match, `h${i}`);
    const lateBot = connect(match, 'latebot', { bot: true });
    expect(lateBot.msgs.some((m) => m.t === 'error' && m.reason === 'match full')).toBe(true);
    const lateHuman = connect(match, 'latehuman');
    expect(lateHuman.msgs.some((m) => m.t === 'error' && m.reason === 'match full')).toBe(true);
    expect(match.playerCount).toBe(12);
  });

  it('an evicted bot carrying gold spills it as a sack (nothing is destroyed)', () => {
    const match = mkMatch();
    for (let i = 0; i < 12; i++) connect(match, `b${i}`, { bot: true });
    match.tick(); // countdown 0 ⇒ live; goLive zeroes the economy first
    // Hand a carried load to the bot the eviction rule will pick (newest on a
    // fullest squad = highest player id).
    const victim = [...match.world.players.values()].reduce((a, b) => (a.id > b.id ? a : b));
    victim.carried = 350;
    match.world.goldMinted += 350;

    connect(match, 'alice');
    expect(match.world.players.has(victim.id)).toBe(false);
    const sacks = [...match.world.sacks.values()];
    expect(sacks).toHaveLength(1);
    expect(sacks[0]!.gold).toBe(350);
    expect(totalGoldInWorld(match.world)).toBe(match.world.goldMinted);
  });
});

describe('resume tokens: refresh keeps your body', () => {
  it('disconnect parks the body; resume within grace reclaims the SAME player', () => {
    const match = mkMatch();
    const alice = connect(match, 'alice');
    const w1 = alice.welcome();
    match.tick(); // live

    const body = match.world.players.get(w1.playerId)!;
    body.carried = 220;
    match.world.goldMinted += 220;

    alice.pair.clientEnd.close();
    expect(match.playerCount).toBe(0);
    // The body (and its gold) is still on the field, at risk.
    expect(match.world.players.has(w1.playerId)).toBe(true);
    expect(match.world.players.get(w1.playerId)!.carried).toBe(220);

    for (let i = 0; i < 30; i++) match.tick(); // well inside the grace window

    const alice2 = connect(match, 'alice', { resume: w1.resume });
    const w2 = alice2.welcome();
    expect(w2.playerId).toBe(w1.playerId);
    expect(w2.squadId).toBe(w1.squadId);
    expect(match.world.players.get(w1.playerId)!.carried).toBe(220);
    expect(match.playerCount).toBe(1);

    // The reset input slot accepts the refreshed client's restarted seq.
    alice2.pair.clientEnd.send(
      encodeMsg({ t: 'input', seq: 1, tick: match.world.tick, mx: 1, my: 0, ax: 1, ay: 0, b: 0 }),
    );
    const x0 = match.world.players.get(w1.playerId)!.x;
    for (let i = 0; i < 10; i++) match.tick();
    expect(match.world.players.get(w1.playerId)!.x).toBeGreaterThan(x0);
  });

  it('the refresh race: resume while the old socket is still open swaps the conn', () => {
    const match = mkMatch();
    const alice = connect(match, 'alice');
    const w1 = alice.welcome();

    // New tab connects BEFORE the old socket closes (the classic F5 race).
    const alice2 = connect(match, 'alice', { resume: w1.resume });
    expect(alice2.welcome().playerId).toBe(w1.playerId);
    expect(match.playerCount).toBe(1);
    expect(alice.pair.clientEnd.closed).toBe(true); // old conn force-closed

    // The old socket's close event must NOT kill the swapped seat.
    match.tick();
    expect(match.playerCount).toBe(1);
    expect(match.world.players.has(w1.playerId)).toBe(true);

    // And the new conn still receives snapshots (seat is truly live).
    const before = alice2.msgs.filter((m) => m.t === 'snap').length;
    match.tick();
    match.tick();
    expect(alice2.msgs.filter((m) => m.t === 'snap').length).toBeGreaterThan(before);
  });

  it('grace expiry removes the body, spills its gold, and tells everyone', () => {
    const match = mkMatch();
    const alice = connect(match, 'alice');
    const bob = connect(match, 'bob');
    const w1 = alice.welcome();
    match.tick();

    const body = match.world.players.get(w1.playerId)!;
    body.carried = 180;
    match.world.goldMinted += 180;
    alice.pair.clientEnd.close();

    for (let i = 0; i < 61 * cfg.tick.simHz; i++) match.tick();

    expect(match.world.players.has(w1.playerId)).toBe(false);
    expect([...match.world.sacks.values()].some((s) => s.gold === 180)).toBe(true);
    expect(totalGoldInWorld(match.world)).toBe(match.world.goldMinted);
    expect(
      bob.msgs.some(
        (m) => m.t === 'ev' && m.events.some((e) => e.k === 'playerLeft' && e.id === w1.playerId),
      ),
    ).toBe(true);

    // The stale token now falls through to a fresh join with a new body.
    const alice2 = connect(match, 'alice', { resume: w1.resume });
    expect(alice2.welcome().playerId).not.toBe(w1.playerId);
  });
});

describe('leave-while-carrying is replay-faithful', () => {
  it('a bot disconnecting mid-carry spills a sack, and the replay hash still matches', async () => {
    const match = new Match({ cfg, map, seed: 7, record: true });
    const clientEnds: LocalPair['clientEnd'][] = [];
    for (let i = 0; i < 12; i++) {
      const pair = createLocalPair();
      clientEnds.push(pair.clientEnd);
      match.addConn(pair.serverEnd);
      new LocalBotDriver(pair.clientEnd, new BotBrain(7 * 1009 + i * 7919), `bot${i + 1}`).start();
    }

    // Run until some bot is carrying (bankers withdraw within a couple of
    // minutes on this seed), then yank that bot's connection mid-run.
    let carrierId = -1;
    let dropped = 0;
    await runTurboTicks(150 * cfg.tick.simHz, () => {
      match.tick();
      if (carrierId === -1) {
        for (const p of match.world.players.values()) {
          if (p.alive && p.carried > 0) {
            carrierId = p.id;
            dropped = p.carried;
            clientEnds[carrierId - 1]!.close(); // ids are join-ordered from 1
            break;
          }
        }
      }
    });

    expect(carrierId, 'no bot ever carried gold — precondition failed').toBeGreaterThan(0);
    expect(match.world.players.has(carrierId)).toBe(false);
    expect(dropped).toBeGreaterThan(0);
    expect(totalGoldInWorld(match.world)).toBe(match.world.goldMinted);

    // The recorded leave replays through the same spill path: hashes agree.
    const live = hashWorld(match.world);
    const replayed = replayToHash(match.recorder!.toRecord(), cfg, map, match.world.tick);
    expect(replayed).toBe(live);
  }, 30_000);
});
