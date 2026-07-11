import { describe, expect, it } from 'vitest';
import { getConfigPreset } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { decodeServerMsg, encodeMsg } from '@shared/net/codec';
import { PROTOCOL_VERSION } from '@shared/net/messages';
import type { ServerMsg, SnapMsg, WelcomeMsg } from '@shared/net/messages';
import { PHASE_ENDED, PHASE_LIVE } from '@shared/sim/world';
import { Match } from '../src/match';
import { createLocalPair } from '../src/transport';

// The auto-restart loop: live match ends → end screen holds for restartSec →
// fresh world, fresh welcomes, seats preserved (same squads and names, new
// player ids), input seq continuity intact.

describe('match auto-restart', () => {
  it('cycles ended → fresh world with re-seated players and new welcomes', () => {
    const cfg = getConfigPreset('smoke'); // 150s live + 5s end screen
    const map = getMap('scrim_small');
    let restarted = 0;
    const match = new Match({ cfg, map, seed: 9, onRestart: () => restarted++ });

    const msgs: ServerMsg[] = [];
    const pair = createLocalPair();
    pair.clientEnd.onMessage((d) => {
      const r = decodeServerMsg(d);
      if (r.ok) msgs.push(r.msg);
    });
    match.addConn(pair.serverEnd);
    pair.clientEnd.send(encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name: 'stayer' }));

    const firstWelcome = msgs.find((m): m is WelcomeMsg => m.t === 'welcome')!;
    const firstSeed = match.seed;

    // Run through live + ended + restart boundary.
    const liveTicks = cfg.match.durationSec * cfg.tick.simHz;
    const endTicks = cfg.match.restartSec * cfg.tick.simHz;
    for (let i = 0; i < liveTicks + endTicks + 40; i++) {
      // Keep sending inputs so seq continuity is exercised across the restart.
      pair.clientEnd.send(
        encodeMsg({ t: 'input', seq: i + 1, tick: i, mx: 0.5, my: 0, ax: 1, ay: 0, b: 0 }),
      );
      match.tick();
      if (restarted > 0) break;
    }

    expect(restarted).toBe(1);
    expect(match.seed).toBe(firstSeed + 1);
    expect(match.world.tick).toBeLessThan(100); // fresh world
    expect(match.world.phase).not.toBe(PHASE_ENDED);
    expect(match.playerCount).toBe(1);

    const welcomes = msgs.filter((m): m is WelcomeMsg => m.t === 'welcome');
    expect(welcomes.length).toBe(2);
    const second = welcomes[1]!;
    // Fresh world, fresh id space (the id may or may not coincide with the old one).
    expect(second.playerId).toBeGreaterThan(0);
    expect(second.squadId).toBe(firstWelcome.squadId); // seat kept its squad
    expect(second.roster.some((r) => r.name === 'stayer')).toBe(true);

    // The re-seated player keeps working. The contract: the restart gave the
    // seat a FRESH input slot, and the client's seq counter is monotonic per
    // page — it does NOT reset on the new welcome. That pairing is race-free:
    // an input still in flight when the slot resets always carries a lower
    // seq than the next one sent, so nothing can wedge the slot. (A client
    // that resets seq on welcome CAN wedge it: one in-flight high seq lands
    // in the fresh slot first and every post-reset input reads as stale —
    // a ghost seat that renders fine and controls nothing.)
    const p = match.world.players.get(second.playerId)!;
    expect(p).toBeDefined();
    const x0 = p.x;
    // Simulate the race: one final PRE-restart-epoch input arrives late,
    // AFTER the slot reset. The continuing counter must still win.
    const preRestartSeq = liveTicks + endTicks + 100; // above anything sent above
    pair.clientEnd.send(
      encodeMsg({
        t: 'input',
        seq: preRestartSeq,
        tick: match.world.tick,
        mx: 0,
        my: 0,
        ax: 1,
        ay: 0,
        b: 0,
      }),
    );
    match.tick();
    for (let i = 0; i < 60; i++) {
      pair.clientEnd.send(
        encodeMsg({
          t: 'input',
          seq: preRestartSeq + 1 + i, // monotonic continuation — MUST apply
          tick: match.world.tick,
          mx: 1,
          my: 0,
          ax: 1,
          ay: 0,
          b: 0,
        }),
      );
      match.tick();
    }
    expect(match.world.phase).toBe(PHASE_LIVE);
    expect(p.x).toBeGreaterThan(x0 + 5); // moved: seat plumbing survived the restart

    // The ack path must recover ABOVE the late fossil too: snapshots ack the
    // continuation seqs, so the client's pending buffer (trimmed by
    // seq > ackSeq) drains to its unacked tail instead of pinning at the
    // 120 cap replaying a dead epoch.
    const snaps = msgs.filter((m): m is SnapMsg => m.t === 'snap');
    expect(snaps[snaps.length - 1]!.ackSeq).toBeGreaterThan(preRestartSeq);
  });
});
