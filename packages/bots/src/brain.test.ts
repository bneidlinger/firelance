import { describe, expect, it } from 'vitest';
import { getConfigPreset, getKit } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { identityVariant } from '@shared/map/variant';
import type { KeepSnap, SackSnap, ServerMsg, StructSnap, YouSnap } from '@shared/net/messages';
import { ST_CARRYING } from '@shared/net/messages';
import {
  BTN_BUILD,
  BTN_BUILD_GATE,
  BTN_BUILD_TOWER,
  BTN_BUILD_TRAP,
  BTN_INTERACT,
  PHASE_LIVE,
  PHASE_PLACEMENT,
} from '@shared/sim/world';
import { BotBrain } from './brain';

// Bot mind under a message-driven harness: we play "server", the brain plays
// itself. Covers spawn-camp etiquette (M1), the placement-phase claim errand,
// the engineer's build loop, and bump-repath around walls it cannot see (M4
// s5). Where movement matters the harness micro-sims it: apply the brain's
// own movement request to the `you` position and keep feeding snapshots —
// no world, no collision, just the contract "you asked, you moved".

const cfg = getConfigPreset('smoke');
const HZ = cfg.tick.simHz;
const PROTECT_TICKS = Math.round((cfg.player.respawnSec + cfg.bounty.freshSpawnSec) * HZ);
const scrim = getMap('scrim_small');

const BUILD_MASK = BTN_BUILD | BTN_BUILD_GATE | BTN_BUILD_TOWER | BTN_BUILD_TRAP;

interface WelcomeOpts {
  playerId?: number;
  squadId?: number;
  phase?: number;
  phaseEndsTick?: number;
  roster?: Array<{ id: number; squad: number; name: string; bot: boolean }>;
  keeps?: KeepSnap[];
}

function welcome(brain: BotBrain, o: WelcomeOpts = {}): void {
  brain.handleServer({
    t: 'welcome',
    playerId: o.playerId ?? 1,
    squadId: o.squadId ?? 0,
    mapId: 'scrim_small',
    variant: identityVariant(scrim),
    cfgName: cfg.name,
    cfgHash: 'x',
    tick: 0,
    tickRate: HZ,
    snapRate: HZ / 2,
    phase: o.phase ?? PHASE_LIVE,
    phaseEndsTick: o.phaseEndsTick ?? 100000,
    roster: o.roster ?? [
      { id: 1, squad: 0, name: 'me', bot: true },
      { id: 2, squad: 1, name: 'enemy', bot: true },
    ],
    keeps: o.keeps ?? [],
    resume: 'tok',
  });
}

interface SnapOpts {
  you?: Partial<YouSnap>;
  ents?: Array<{ i: number; x: number; y: number; st?: number }>;
  sacks?: SackSnap[];
  structures?: StructSnap[];
}

function snap(brain: BotBrain, tick: number, o: SnapOpts = {}): void {
  const you: YouSnap = {
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
    rebuildTicks: 0,
    bombs: 2,
    bombCd: 0,
    supply: 0,
    claimTicks: 0,
    rootTicks: 0,
    ...o.you,
  };
  const msg: ServerMsg = {
    t: 'snap',
    tick,
    ackSeq: 0,
    you,
    ents: (o.ents ?? []).map((e) => ({
      i: e.i,
      x: e.x,
      y: e.y,
      ax: 1,
      ay: 0,
      hp: 90,
      cls: 'ranger',
      st: e.st ?? 0,
    })),
    sacks: o.sacks ?? [],
    structures: o.structures ?? [],
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
  const nextToEnemy: SnapOpts = { ents: [{ i: 2, x: 26.5, y: 20.5 }] };

  it('attacks a visible enemy normally (control)', () => {
    const brain = new BotBrain(1);
    welcome(brain);
    snap(brain, 100, nextToEnemy);
    brain.think(100);
    expect(brain.fsmState).toBe('ATTACK');
  });

  it('ignores a freshly-killed enemy until the protection window lapses', () => {
    const brain = new BotBrain(1);
    welcome(brain);
    kill(brain, 100, 2);
    snap(brain, 150, nextToEnemy);
    brain.think(150);
    expect(brain.fsmState).toBe('ROAM');

    const after = 100 + PROTECT_TICKS + 1;
    snap(brain, after, nextToEnemy);
    brain.think(after);
    expect(brain.fsmState).toBe('ATTACK');
  });

  it('self-defense overrides etiquette: protected attackers get fought back', () => {
    const brain = new BotBrain(1);
    welcome(brain);
    kill(brain, 100, 2);
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
    snap(brain, 152, nextToEnemy);
    brain.think(152);
    expect(brain.fsmState).toBe('ATTACK');
  });

  it('carrying gold voids the protection: fresh carriers are fair game', () => {
    const brain = new BotBrain(1);
    welcome(brain);
    kill(brain, 100, 2);
    snap(brain, 150, { ents: [{ i: 2, x: 26.5, y: 20.5, st: ST_CARRYING }] });
    brain.think(150);
    expect(brain.fsmState).toBe('ATTACK');
  });
});

// The keep site on scrim with the most breathing room from its siblings —
// park the bot beside it with a tight clock and it's the only legal choice.
function mostIsolatedSite(): { x: number; y: number } {
  let best = scrim.keeps[0]!;
  let bestMin = -1;
  for (const a of scrim.keeps) {
    let minD = Number.POSITIVE_INFINITY;
    for (const b of scrim.keeps) {
      if (a === b) continue;
      minD = Math.min(minD, Math.hypot(a.x - b.x, a.y - b.y));
    }
    if (minD > bestMin) {
      bestMin = minD;
      best = a;
    }
  }
  return best;
}

describe('placement-phase claim (M4 s5)', () => {
  it('the claimer walks to a reachable site and channels the claim', () => {
    const site = mostIsolatedSite();
    const brain = new BotBrain(3);
    // Tight clock: walk budget only covers the adjacent site — deterministic
    // target no matter what the desire dice say.
    welcome(brain, { phase: PHASE_PLACEMENT, phaseEndsTick: 240 });
    let x = site.x + 6;
    let y = site.y;
    const speed = getKit(cfg, 'fighter').moveSpeed;
    let interacted = 0;
    for (let tick = 0; tick < 200; tick += 2) {
      snap(brain, tick, { you: { x, y, cls: 'fighter' } });
      const input = brain.think(tick);
      if (!input) continue;
      if ((input.b & BTN_INTERACT) !== 0) {
        interacted++;
        // Channeling = standing still. Any movement input would reset it.
        expect(Math.abs(input.mx)).toBeLessThan(0.01);
        expect(Math.abs(input.my)).toBeLessThan(0.01);
      }
      const l = Math.hypot(input.mx, input.my);
      if (l > 0.01) {
        x += (input.mx / l) * speed * (2 / HZ) * l;
        y += (input.my / l) * speed * (2 / HZ) * l;
      }
    }
    // It reached the site and held the channel for a sustained stretch.
    expect(Math.hypot(x - site.x, y - site.y)).toBeLessThan(2.5);
    expect(interacted).toBeGreaterThan(30); // >2s of held channel at 15Hz thinks
  });

  it('a non-claimer squadmate loiters and never channels', () => {
    const site = mostIsolatedSite();
    const brain = new BotBrain(3);
    welcome(brain, {
      phase: PHASE_PLACEMENT,
      phaseEndsTick: 240,
      playerId: 5,
      roster: [
        { id: 1, squad: 0, name: 'banker', bot: true }, // lower id = the claimer
        { id: 5, squad: 0, name: 'me', bot: true },
      ],
    });
    for (let tick = 0; tick < 120; tick += 2) {
      // Parked ON the site: a claimer would channel from here instantly.
      snap(brain, tick, { you: { x: site.x, y: site.y, cls: 'ranger' } });
      const input = brain.think(tick);
      if (input) expect(input.b & BTN_INTERACT).toBe(0);
    }
  });

  it('stands down once the squad has claimed', () => {
    const site = mostIsolatedSite();
    const brain = new BotBrain(3);
    welcome(brain, { phase: PHASE_PLACEMENT, phaseEndsTick: 240 });
    brain.handleServer({
      t: 'ev',
      tick: 10,
      events: [{ k: 'keepClaimed', tk: 10, squad: 0, x: site.x, y: site.y, by: 9 }],
    });
    for (let tick = 12; tick < 60; tick += 2) {
      snap(brain, tick, { you: { x: site.x, y: site.y, cls: 'fighter' } });
      const input = brain.think(tick);
      if (input) expect(input.b & BTN_INTERACT).toBe(0);
    }
  });
});

describe('engineer build loop (M4 s5)', () => {
  it('an engineer with supply walks its fort plan and presses a build button', () => {
    const site = mostIsolatedSite();
    const brain = new BotBrain(4);
    welcome(brain, {
      keeps: [{ squad: 0, x: site.x, y: site.y, hp: 1200 }],
      roster: [
        { id: 0, squad: 0, name: 'banker', bot: true },
        { id: 1, squad: 0, name: 'me', bot: true }, // middle bot = engineer
        { id: 9, squad: 0, name: 'aggro', bot: true },
      ],
    });
    let x = site.x;
    let y = site.y;
    const speed = getKit(cfg, 'engineer').moveSpeed;
    const presses: number[] = [];
    let sawBuildState = false;
    for (let tick = 0; tick < 600; tick += 2) {
      snap(brain, tick, { you: { x, y, cls: 'engineer', supply: 300 } });
      const input = brain.think(tick);
      if (brain.fsmState === 'BUILD') sawBuildState = true;
      if (!input) continue;
      if ((input.b & BUILD_MASK) !== 0) presses.push(input.b & BUILD_MASK);
      const l = Math.hypot(input.mx, input.my);
      if (l > 1) {
        x += (input.mx / l) * speed * (2 / HZ);
        y += (input.my / l) * speed * (2 / HZ);
      } else if (l > 0.01) {
        x += input.mx * speed * (2 / HZ);
        y += input.my * speed * (2 / HZ);
      }
    }
    expect(sawBuildState).toBe(true);
    expect(presses.length).toBeGreaterThan(0);
    // First slots in the plan are walls.
    expect(presses[0]).toBe(BTN_BUILD);
  });

  it('repairs a damaged own structure, and repair outranks new slots', () => {
    const site = mostIsolatedSite();
    const brain = new BotBrain(4);
    welcome(brain, {
      keeps: [{ squad: 0, x: site.x, y: site.y, hp: 1200 }],
      roster: [
        { id: 0, squad: 0, name: 'banker', bot: true },
        { id: 1, squad: 0, name: 'me', bot: true },
        { id: 9, squad: 0, name: 'aggro', bot: true },
      ],
    });
    // A half-dead own wall right next to us; we stand at ring distance.
    const wall: StructSnap = {
      i: 50,
      k: 0,
      s: 0,
      tx: Math.floor(site.x) + 1,
      ty: Math.floor(site.y) - 2,
      hp: 60,
      mx: 200,
    };
    const rx = wall.tx + 0.5 + 2; // 2u east of the wall tile center = press band
    const ry = wall.ty + 0.5;
    let pressed = 0;
    for (let tick = 0; tick < 40; tick += 2) {
      snap(brain, tick, {
        you: { x: rx, y: ry, cls: 'engineer', supply: 300 },
        structures: [wall],
      });
      const input = brain.think(tick);
      expect(brain.fsmState).toBe('BUILD');
      if (input && (input.b & BUILD_MASK) !== 0) {
        pressed++;
        expect(input.b & BUILD_MASK).toBe(BTN_BUILD); // repair = plain B
        // Aimed at the damaged wall, not some plan slot.
        expect(input.ax).toBeLessThan(0); // wall is due west of us
      }
    }
    expect(pressed).toBeGreaterThan(0);
  });

  it('non-engineers never enter BUILD', () => {
    const site = mostIsolatedSite();
    const brain = new BotBrain(4);
    welcome(brain, { keeps: [{ squad: 0, x: site.x, y: site.y, hp: 1200 }] });
    for (let tick = 0; tick < 60; tick += 2) {
      snap(brain, tick, { you: { x: site.x, y: site.y, cls: 'ranger', supply: 300 } });
      brain.think(tick);
      expect(brain.fsmState).not.toBe('BUILD');
    }
  });
});

describe('bump-repath around invisible walls (M4 s5)', () => {
  it('a bot stalled against nothing detours instead of treadmilling', () => {
    const brain = new BotBrain(5);
    welcome(brain);
    // Enemy 16u due east (outside engage range → SEEK, straight-line steer).
    // We freeze the bot's position: something unseen is in the way.
    const vertical: number[] = [];
    for (let tick = 0; tick < 260; tick += 2) {
      snap(brain, tick, {
        you: { x: 20.5, y: 8.5 },
        ents: [{ i: 2, x: 36.5, y: 8.5 }],
      });
      const input = brain.think(tick);
      if (input) vertical.push(Math.abs(input.my));
    }
    // Early thinks: dead-straight east (no vertical component).
    const early = vertical.slice(0, 15);
    expect(Math.max(...early)).toBeLessThan(0.1);
    // After the stall window trips, the detour shows a real vertical component.
    const late = vertical.slice(30);
    expect(Math.max(...late)).toBeGreaterThan(0.35);
  });
});

describe('rumor hunts (M5)', () => {
  /** keeps[0] plus its nearest fellow site ≥ 12u away — both walkable POIs. */
  function huntLeg(): { start: { x: number; y: number }; goal: { x: number; y: number } } {
    const start = scrim.keeps[0]!;
    let goal = scrim.keeps[1]!;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 1; i < scrim.keeps.length; i++) {
      const k = scrim.keeps[i]!;
      const d = Math.hypot(k.x - start.x, k.y - start.y);
      if (d >= 12 && d < best) {
        best = d;
        goal = k;
      }
    }
    return { start, goal };
  }

  it('a warm enemy rumor turns an idle roamer into a hunter that closes distance', () => {
    const { start, goal } = huntLeg();
    const brain = new BotBrain(11);
    welcome(brain);
    brain.handleServer({
      t: 'ev',
      tick: 100,
      events: [{ k: 'rumor', tk: 100, kind: 'bounty', id: 99, squad: 1, x: goal.x, y: goal.y, tier: 3 }],
    });
    let x = start.x;
    let y = start.y;
    const speed = getKit(cfg, 'fighter').moveSpeed;
    let sawHunt = false;
    for (let tick = 100; tick < 400; tick += 2) {
      snap(brain, tick, { you: { x, y } });
      const input = brain.think(tick);
      if (brain.fsmState === 'HUNT') sawHunt = true;
      if (!input) continue;
      const l = Math.hypot(input.mx, input.my);
      if (l > 0.01) {
        x += (input.mx / Math.max(1, l)) * speed * (2 / HZ);
        y += (input.my / Math.max(1, l)) * speed * (2 / HZ);
      }
    }
    expect(sawHunt).toBe(true);
    const before = Math.hypot(goal.x - start.x, goal.y - start.y);
    const after = Math.hypot(goal.x - x, goal.y - y);
    expect(after).toBeLessThan(before - 6); // the gossip moved somebody
  });

  it('gossip about our own squad is ignored', () => {
    const { start, goal } = huntLeg();
    const brain = new BotBrain(12);
    welcome(brain);
    brain.handleServer({
      t: 'ev',
      tick: 100,
      events: [{ k: 'rumor', tk: 100, kind: 'bounty', id: 1, squad: 0, x: goal.x, y: goal.y, tier: 3 }],
    });
    snap(brain, 102, { you: { x: start.x, y: start.y } });
    brain.think(102);
    expect(brain.fsmState).toBe('ROAM');
  });

  it('stale rumors expire instead of dragging bots across the map forever', () => {
    const { start, goal } = huntLeg();
    const brain = new BotBrain(13);
    welcome(brain);
    brain.handleServer({
      t: 'ev',
      tick: 100,
      events: [{ k: 'rumor', tk: 100, kind: 'bounty', id: 99, squad: 1, x: goal.x, y: goal.y, tier: 3 }],
    });
    // fadeSec 12 × 1.5 horizon = 540 ticks at 30Hz — think well past it.
    snap(brain, 700, { you: { x: start.x, y: start.y } });
    brain.think(700);
    expect(brain.fsmState).toBe('ROAM');
  });
});
