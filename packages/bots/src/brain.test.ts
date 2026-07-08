import { describe, expect, it } from 'vitest';
import { getConfigPreset } from '@shared/config';
import type { SackSnap, ServerMsg } from '@shared/net/messages';
import { ST_CARRYING } from '@shared/net/messages';
import { BotBrain } from './brain';

// Spawn-camp etiquette: after seeing a kill, bots leave the victim alone for
// respawn + fresh-spawn protection (those kills pay zero anyway) — unless the
// victim shoots first, or walks around carrying gold.

const cfg = getConfigPreset('smoke');
const HZ = cfg.tick.simHz;
const PROTECT_TICKS = Math.round((cfg.player.respawnSec + cfg.bounty.freshSpawnSec) * HZ);

function welcome(brain: BotBrain): void {
  brain.handleServer({
    t: 'welcome',
    playerId: 1,
    squadId: 0,
    mapId: 'scrim_small',
    cfgName: cfg.name,
    cfgHash: 'x',
    tick: 0,
    tickRate: HZ,
    snapRate: HZ / 2,
    phase: 1,
    phaseEndsTick: 100000,
    roster: [
      { id: 1, squad: 0, name: 'me', bot: true },
      { id: 2, squad: 1, name: 'enemy', bot: true },
    ],
    resume: 'tok',
  });
}

/** Snapshot placing the enemy right next to us, in the open. */
function snap(brain: BotBrain, tick: number, enemySt = 0): void {
  const sacks: SackSnap[] = [];
  const msg: ServerMsg = {
    t: 'snap',
    tick,
    ackSeq: 0,
    you: {
      x: 20.5,
      y: 20.5,
      vx: 0,
      vy: 0,
      dashTicks: 0,
      dashDx: 0,
      dashDy: 0,
      dashCd: 0,
      prevB: 0,
      hp: 90,
      alive: true,
      respIn: 0,
      atkPhase: 0,
      atkTicks: 0,
      atkCd: 0,
      cls: 'ranger',
      bounty: 0,
      carried: 0,
      bankTicks: 0,
    },
    ents: [{ i: 2, x: 26.5, y: 20.5, ax: 1, ay: 0, hp: 90, cls: 'ranger', st: enemySt }],
    sacks,
  };
  brain.handleServer(msg);
}

function kill(brain: BotBrain, tick: number, victim: number): void {
  brain.handleServer({
    t: 'ev',
    tick,
    events: [
      {
        k: 'kill',
        tk: tick,
        killer: 3,
        victim,
        gold: 0,
        victimBounty: 0,
        droppedGold: 0,
        assists: [],
      },
    ],
  });
}

describe('bot spawn etiquette', () => {
  it('attacks a visible enemy normally (control)', () => {
    const brain = new BotBrain(1);
    welcome(brain);
    snap(brain, 100);
    brain.think(100);
    expect(brain.fsmState).toBe('ATTACK');
  });

  it('ignores a freshly-killed enemy until the protection window lapses', () => {
    const brain = new BotBrain(1);
    welcome(brain);
    kill(brain, 100, 2);
    // "Respawned" enemy stands next to us, still inside the window.
    snap(brain, 150);
    brain.think(150);
    expect(brain.fsmState).toBe('ROAM');

    // Window over: fair game again.
    const after = 100 + PROTECT_TICKS + 1;
    snap(brain, after);
    brain.think(after);
    expect(brain.fsmState).toBe('ATTACK');
  });

  it('self-defense overrides etiquette: protected attackers get fought back', () => {
    const brain = new BotBrain(1);
    welcome(brain);
    kill(brain, 100, 2);
    // The fresh spawn shoots US.
    brain.handleServer({
      t: 'ev',
      tick: 150,
      events: [
        {
          k: 'hit',
          tk: 150,
          attacker: 2,
          victim: 1,
          amount: 26,
          hp: 64,
          kind: 'arrow',
          blocked: false,
          x: 20.5,
          y: 20.5,
        },
      ],
    });
    snap(brain, 152);
    brain.think(152);
    expect(brain.fsmState).toBe('ATTACK');
  });

  it('carrying gold voids the protection: fresh carriers are fair game', () => {
    const brain = new BotBrain(1);
    welcome(brain);
    kill(brain, 100, 2);
    snap(brain, 150, ST_CARRYING);
    brain.think(150);
    expect(brain.fsmState).toBe('ATTACK');
  });
});
