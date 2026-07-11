import { describe, expect, it } from 'vitest';
import { getConfigPreset, secToTicks, type GameConfig } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { parseMap } from '@shared/map/parse';
import { applyVariant, deriveVariant } from '@shared/map/variant';
import { decodeServerMsg, encodeMsg } from '@shared/net/codec';
import { PROTOCOL_VERSION, type WelcomeMsg } from '@shared/net/messages';
import type { SimEvent } from '@shared/sim/events';
import { stepWorld } from '@shared/sim/step';
import { mintGoldToKeep } from '@shared/sim/systems/economy';
import type { InputCmd, PlayerId } from '@shared/sim/world';
import { BTN_INTERACT, createWorld, PHASE_LIVE, spawnPlayer } from '@shared/sim/world';
import { runInProcessMatch } from '../src/harness';
import { Match } from '../src/match';
import { createLocalPair, type LocalPair } from '../src/transport';

// M5 per-match map variation, through the REAL server plumbing: the welcome
// descriptor, the placement auto-assign onto the drawn board, the restart
// re-draw (THE "consecutive matches differ" mechanism), closed towns, and
// replay determinism across the variant derivation.

const base = getMap('vale_full');
const protoCfg = getConfigPreset('prototype'); // variation is ON here

/** smoke-fast cfg with variation ON: live in 1 tick, restart quickly. */
const fastCfg: GameConfig = {
  ...getConfigPreset('smoke'),
  match: { ...getConfigPreset('smoke').match, durationSec: 4, restartSec: 1 },
  variation: { enabled: true, extraSites: 3, townsActive: 2, shuffleSpawns: true },
};

function probeConn(match: Match, name: string): { pair: LocalPair; welcomes: WelcomeMsg[] } {
  const pair = createLocalPair();
  const welcomes: WelcomeMsg[] = [];
  pair.clientEnd.onMessage((d) => {
    const decoded = decodeServerMsg(d);
    if (decoded.ok && decoded.msg.t === 'welcome') welcomes.push(decoded.msg);
  });
  match.addConn(pair.serverEnd);
  pair.clientEnd.send(encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name, bot: true }));
  return { pair, welcomes };
}

describe('welcome carries the map draw', () => {
  it('variant matches deriveVariant(seed) and match.map is the applied base', () => {
    const match = new Match({ cfg: protoCfg, map: base, seed: 11 });
    const { welcomes } = probeConn(match, 'probe');
    expect(welcomes).toHaveLength(1);

    const expected = deriveVariant(11, protoCfg, base);
    expect(welcomes[0]!.variant).toEqual(expected);

    const applied = applyVariant(base, expected);
    expect(match.map.keeps).toEqual(applied.keeps);
    expect(match.map.towns).toEqual(applied.towns);
    expect(match.map.spawns).toEqual(applied.spawns);
    // vale under default knobs: 4 anchors + 3 extras, 2 of 3 towns.
    expect(match.map.keeps).toHaveLength(7);
    expect(match.map.towns).toHaveLength(2);
  });
});

describe('placement auto-assign on a drawn board', () => {
  it('every squad lands on a DISTINCT active site', () => {
    const match = new Match({ cfg: fastCfg, map: base, seed: 3 });
    probeConn(match, 'seat'); // restart/phase flow needs an occupied seat
    for (let i = 0; i < 5; i++) match.tick(); // placement 0 + countdown 0 → live

    expect(match.world.phase).toBe(PHASE_LIVE);
    const activePos = new Set(match.map.keeps.map((k) => `${k.x},${k.y}`));
    const sites = new Set<number>();
    for (const s of match.world.squads) {
      expect(s.claimedSite).toBeGreaterThanOrEqual(0);
      expect(s.claimedSite).toBeLessThan(match.map.keeps.length);
      sites.add(s.claimedSite);
      expect(activePos.has(`${s.keepX},${s.keepY}`)).toBe(true);
    }
    expect(sites.size).toBe(match.world.squads.length);
  });
});

describe('restart re-draws the board', () => {
  it('the next welcome carries deriveVariant(seed+1) — a different draw', () => {
    const seed = 3;
    const match = new Match({ cfg: fastCfg, map: base, seed });
    const { welcomes } = probeConn(match, 'stayer');

    // 4s live + 1s end screen at 30Hz, with margin.
    const ticks = secToTicks(fastCfg, 7);
    for (let i = 0; i < ticks; i++) match.tick();

    expect(welcomes.length).toBeGreaterThanOrEqual(2);
    const first = welcomes[0]!.variant;
    const second = welcomes[1]!.variant;
    expect(first).toEqual(deriveVariant(seed, fastCfg, base));
    expect(second).toEqual(deriveVariant(seed + 1, fastCfg, base));
    // The gate: consecutive matches on this server open on different boards.
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first));
    // And the match's own map moved with it.
    expect(match.map.keeps).toEqual(applyVariant(base, second).keeps);
  });
});

describe('closed towns are just ground', () => {
  // Two towns, far enough apart that their interact circles never overlap.
  const arena = parseMap(
    'twin-town',
    `
####################
#1..K...T...T..K..2#
#3................4#
####################
`,
  );

  it('the deposit channel completes at an open town and never starts at a closed one', () => {
    const cfg = getConfigPreset('smoke');
    const closed = applyVariant(arena, {
      keeps: arena.keeps.map((_, i) => i),
      towns: [0], // town[1] does not exist this match
      spawns: arena.spawns.map((_, i) => i),
    });
    const w = createWorld(1, cfg, closed);
    w.phase = PHASE_LIVE;
    w.phaseEndsTick = 1_000_000;

    const p = spawnPlayer(w, cfg, 0, 'carrier', true, 'ranger', 4.5, 1.5);
    // Load through the real withdraw path at the squad's keep (site 0).
    mintGoldToKeep(w, 0, 400);
    const HOLD_E: InputCmd = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_INTERACT };
    const inputs = new Map<PlayerId, InputCmd>([[p.id, HOLD_E]]);
    const channelTicks = secToTicks(cfg, cfg.banking.bankChannelSec);
    const events: SimEvent[] = [];
    const run = (n: number): void => {
      for (let i = 0; i < n; i++) events.push(...stepWorld(w, inputs, cfg, closed));
    };
    run(30);
    expect(p.carried).toBeGreaterThan(0);

    // Standing at the CLOSED town, holding the channel: nothing ever banks.
    p.x = arena.towns[1]!.x;
    p.y = arena.towns[1]!.y;
    events.length = 0;
    run(channelTicks * 3);
    expect(events.filter((e) => e.k === 'banked')).toHaveLength(0);
    expect(p.bankTicks).toBe(0);

    // Same stance at the OPEN town: the channel completes.
    p.x = closed.towns[0]!.x;
    p.y = closed.towns[0]!.y;
    run(channelTicks + 2);
    expect(events.filter((e) => e.k === 'banked')).toHaveLength(1);
  });
});

describe('variation-on bot match (turbo)', () => {
  it('vale draw: invariants clean, replay re-derives the same board', async () => {
    const r = await runInProcessMatch({
      bots: 12,
      simSeconds: 45,
      seed: 5,
      cfg: protoCfg,
      mapId: 'vale_full',
    });
    expect(r.violations).toEqual([]);
    // Replay determinism THROUGH the variant derivation (replayToHash takes
    // the base map and must land on the identical board).
    expect(r.replayHash).toBe(r.finalHash);
  }, 30_000);
});
