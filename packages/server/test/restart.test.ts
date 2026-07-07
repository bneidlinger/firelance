import { describe, expect, it } from 'vitest';
import { getConfigPreset } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { decodeServerMsg, encodeMsg } from '@shared/net/codec';
import { PROTOCOL_VERSION } from '@shared/net/messages';
import type { ServerMsg, WelcomeMsg } from '@shared/net/messages';
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

    // The re-seated player keeps working: inputs still land after restart.
    const p = match.world.players.get(second.playerId)!;
    expect(p).toBeDefined();
    const x0 = p.x;
    for (let i = 0; i < 60; i++) {
      pair.clientEnd.send(
        encodeMsg({
          t: 'input',
          seq: 100_000 + i,
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
  });
});
