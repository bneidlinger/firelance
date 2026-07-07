import { describe, expect, it } from 'vitest';
import { getKit, secToTicks, smokeConfig as cfg } from '../config';
import { parseMap } from '../map/parse';
import type { SimEvent } from './events';
import { stepWorld } from './step';
import type { Player, World } from './world';
import { BTN_BLOCK, BTN_FIRE, createWorld, PHASE_LIVE, spawnPlayer } from './world';

// Arrow flight: swept collision (no tunneling), wall stops, TTL fades,
// friendly-fire pass-through, shield interaction — all via the real stepWorld.

const arena = parseMap(
  'proj-arena',
  `
##############################
#1..........................2#
#..K......................K..#
#............####............#
#............####............#
#..K......................K..#
#3...........T..............4#
##############################
`,
);

const bow = getKit(cfg, 'ranger').bow!;

function rig(): {
  world: World;
  events: SimEvent[];
  step: (n?: number) => void;
} {
  const world = createWorld(1, cfg, arena);
  world.phase = PHASE_LIVE;
  world.phaseEndsTick = 1_000_000;
  const events: SimEvent[] = [];
  return {
    world,
    events,
    step: (n = 1) => {
      for (let i = 0; i < n; i++) events.push(...stepWorld(world, new Map(), cfg, arena));
    },
  };
}

function shooter(w: World, squad: number, x: number, y: number, ax = 1, ay = 0): Player {
  const p = spawnPlayer(w, cfg, squad, `r${squad}`, true, 'ranger', x, y);
  p.input = { mx: 0, my: 0, ax, ay, b: BTN_FIRE };
  return p;
}

function idle(
  w: World,
  squad: number,
  x: number,
  y: number,
  cls: 'fighter' | 'ranger' = 'fighter',
): Player {
  const p = spawnPlayer(w, cfg, squad, `p${squad}`, true, cls, x, y);
  p.input = { mx: 0, my: 0, ax: 1, ay: 0, b: 0 };
  return p;
}

describe('projectile flight', () => {
  it('spawns on fire with a projSpawn event and integrates at bow speed', () => {
    const { world, events, step } = rig();
    shooter(world, 0, 5, 5.5);
    step();
    const spawn = events.find((e) => e.k === 'projSpawn');
    expect(spawn).toBeDefined();
    expect(world.projectiles.size).toBe(1);
    const proj = [...world.projectiles.values()][0]!;
    const x0 = proj.x;
    step();
    expect(proj.x).toBeCloseTo(x0 + bow.speed / cfg.tick.simHz, 6);
    expect(proj.y).toBeCloseTo(5.5, 6);
  });

  it('hits an enemy dead ahead: damage, hit event, projEnd with victim id', () => {
    const { world, events, step } = rig();
    shooter(world, 0, 5, 5.5);
    const v = idle(world, 1, 12, 5.5);
    step(secToTicks(cfg, 1)); // one second: 14 units of flight covers 7
    const hit = events.find((e) => e.k === 'hit');
    expect(hit && hit.k === 'hit' && hit.kind).toBe('arrow');
    expect(v.hp).toBeCloseTo(getKit(cfg, 'fighter').maxHp - bow.damage, 5);
    const end = events.find((e) => e.k === 'projEnd');
    expect(end && end.k === 'projEnd' && end.hit).toBe(v.id);
  });

  it('never tunnels: a fast arrow cannot skip a body between ticks', () => {
    const { world, events, step } = rig();
    const s = shooter(world, 0, 5, 5.5);
    idle(world, 1, 12, 5.5);
    // Silly-fast arrow: 90 units/tick would jump clean past the victim without sweeping.
    s.input = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_FIRE };
    step(); // spawn
    const proj = [...world.projectiles.values()][0]!;
    proj.speed = 2700; // 90 units per tick
    step();
    expect(events.some((e) => e.k === 'hit')).toBe(true);
  });

  it('a near miss stays a miss (hit radius = player + arrow radius)', () => {
    const { world, events, step } = rig();
    shooter(world, 0, 5, 5.5);
    const v = idle(world, 1, 12, 5.5 + cfg.player.radius + bow.radius + 0.1);
    step(secToTicks(cfg, 1));
    expect(events.some((e) => e.k === 'hit')).toBe(false);
    expect(v.hp).toBe(getKit(cfg, 'fighter').maxHp);
  });

  it('stops at walls with a projEnd at the surface', () => {
    const { world, events, step } = rig();
    // Wall block spans x=13..16, y=3..4; shoot one arrow into it along y=3.5.
    const s = shooter(world, 0, 5, 3.5);
    step();
    s.input = { mx: 0, my: 0, ax: 1, ay: 0, b: 0 };
    step(secToTicks(cfg, 1.2));
    const end = events.find((e) => e.k === 'projEnd');
    expect(end).toBeDefined();
    if (end && end.k === 'projEnd') {
      expect(end.hit).toBeUndefined();
      expect(end.x).toBeGreaterThan(12.4);
      expect(end.x).toBeLessThan(13.4); // stopped entering the wall, not inside it
    }
    expect(world.projectiles.size).toBe(0);
  });

  it('expires at TTL with a projEnd fade when nothing is hit', () => {
    const { world, events, step } = rig();
    const s = shooter(world, 0, 5, 5.5);
    step();
    s.input = { mx: 0, my: 0, ax: 1, ay: 0, b: 0 }; // stop firing after one arrow
    const ttl = secToTicks(cfg, bow.ttlSec);
    step(ttl + 2);
    const ends = events.filter((e) => e.k === 'projEnd');
    expect(ends).toHaveLength(1);
    expect(ends[0] && ends[0].k === 'projEnd' ? ends[0].hit : -1).toBeUndefined();
    expect(world.projectiles.size).toBe(0);
  });

  it('passes through allies and hits the enemy behind them', () => {
    const { world, events, step } = rig();
    shooter(world, 0, 5, 5.5);
    const ally = idle(world, 0, 9, 5.5);
    const enemy = idle(world, 1, 13, 5.5);
    step(secToTicks(cfg, 1));
    expect(ally.hp).toBe(getKit(cfg, 'fighter').maxHp);
    expect(enemy.hp).toBeLessThan(getKit(cfg, 'fighter').maxHp);
    const hit = events.find((e) => e.k === 'hit');
    expect(hit && hit.k === 'hit' && hit.victim).toBe(enemy.id);
  });

  it('a frontal shield soaks most arrow damage', () => {
    const { world, events, step } = rig();
    shooter(world, 0, 5, 5.5);
    const v = idle(world, 1, 12, 5.5, 'fighter');
    v.input = { mx: 0, my: 0, ax: -1, ay: 0, b: BTN_BLOCK }; // shield toward shooter
    step(secToTicks(cfg, 1));
    const hit = events.find((e) => e.k === 'hit');
    expect(hit && hit.k === 'hit' && hit.blocked).toBe(true);
    const shield = getKit(cfg, 'fighter').shield!;
    expect(v.hp).toBeCloseTo(getKit(cfg, 'fighter').maxHp - bow.damage * shield.damageFactor, 5);
  });

  it('cooldown paces fire: holding the button yields arrows at the bow rate', () => {
    const { world, events, step } = rig();
    shooter(world, 0, 5, 5.5);
    step(secToTicks(cfg, 3));
    const spawns = events.filter((e) => e.k === 'projSpawn').length;
    const expected = Math.floor(secToTicks(cfg, 3) / (secToTicks(cfg, bow.cooldownSec) + 1)) + 1;
    expect(Math.abs(spawns - expected)).toBeLessThanOrEqual(1);
  });
});
