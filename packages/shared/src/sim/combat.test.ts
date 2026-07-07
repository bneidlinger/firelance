import { describe, expect, it } from 'vitest';
import { getKit, secToTicks, smokeConfig as cfg } from '../config';
import { parseMap } from '../map/parse';
import type { SimEvent } from './events';
import { stepWorld } from './step';
import type { Player, World } from './world';
import {
  ATK_ACTIVE,
  ATK_IDLE,
  ATK_RECOVERY,
  ATK_WINDUP,
  BTN_BLOCK,
  BTN_FIRE,
  createWorld,
  PHASE_LIVE,
  spawnPlayer,
} from './world';

// Melee state machine, shield math, death, respawn, regen — stepped through
// the REAL stepWorld so system ordering is part of what's under test.

const arena = parseMap(
  'combat-arena',
  `
####################
#1................2#
#..K............K..#
#....######........#
#........T.........#
#..K............K..#
#3................4#
####################
`,
);

interface Rig {
  world: World;
  events: SimEvent[];
  step: (n?: number) => void;
}

/** World forced straight to LIVE so hand-placed positions survive. */
function rig(): Rig {
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

function fighter(w: World, squad: number, x: number, y: number): Player {
  return spawnPlayer(w, cfg, squad, `f${squad}`, true, 'fighter', x, y);
}

function ranger(w: World, squad: number, x: number, y: number): Player {
  return spawnPlayer(w, cfg, squad, `r${squad}`, true, 'ranger', x, y);
}

const melee = getKit(cfg, 'fighter').melee!;
const WINDUP = secToTicks(cfg, melee.windupSec);
const ACTIVE = secToTicks(cfg, melee.activeSec);

describe('melee state machine', () => {
  it('windup → active (hit lands once) → recovery → idle+cooldown', () => {
    const { world, events, step } = rig();
    const a = fighter(world, 0, 8, 4.5);
    const v = ranger(world, 1, 9.5, 4.5); // 1.5 away, in reach
    a.input = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_FIRE };
    v.input = { mx: 0, my: 0, ax: -1, ay: 0, b: 0 };

    step();
    expect(a.atkPhase).toBe(ATK_WINDUP);
    expect(events.some((e) => e.k === 'swing' && e.id === a.id)).toBe(true);
    expect(v.hp).toBe(getKit(cfg, 'ranger').maxHp); // windup does no damage

    step(WINDUP);
    expect(a.atkPhase).toBe(ATK_ACTIVE);
    const hits = events.filter((e) => e.k === 'hit' && e.attacker === a.id);
    expect(hits).toHaveLength(1);
    expect(v.hp).toBeCloseTo(getKit(cfg, 'ranger').maxHp - melee.damage, 5);

    step(ACTIVE);
    expect(a.atkPhase).toBe(ATK_RECOVERY);
    // Still exactly one hit: one swing, one hit per victim.
    expect(events.filter((e) => e.k === 'hit' && e.attacker === a.id)).toHaveLength(1);

    step(secToTicks(cfg, melee.recoverySec));
    expect(a.atkPhase).toBe(ATK_IDLE);
    expect(a.atkCd).toBeGreaterThan(0);
  });

  it('respects the 120° arc: targets behind or far off-axis are safe', () => {
    const { world, events, step } = rig();
    const a = fighter(world, 0, 8, 4.5);
    const behind = ranger(world, 1, 6.5, 4.5); // dead behind the +x swing
    a.input = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_FIRE };
    behind.input = { mx: 0, my: 0, ax: 1, ay: 0, b: 0 };
    step(WINDUP + ACTIVE + 2);
    expect(events.filter((e) => e.k === 'hit')).toHaveLength(0);
    expect(behind.hp).toBe(getKit(cfg, 'ranger').maxHp);
  });

  it('hits a target 45° off-axis (inside the arc)', () => {
    const { world, events, step } = rig();
    const a = fighter(world, 0, 8, 4.5);
    // 45°: offset (1.06, 1.06) ≈ dist 1.5
    const v = ranger(world, 1, 9.06, 5.56);
    a.input = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_FIRE };
    v.input = { mx: 0, my: 0, ax: -1, ay: 0, b: 0 };
    step(WINDUP + ACTIVE + 2);
    expect(events.filter((e) => e.k === 'hit')).toHaveLength(1);
  });

  it('swing direction locks at windup start (turning later does not re-aim)', () => {
    const { world, events, step } = rig();
    const a = fighter(world, 0, 8, 4.5);
    const v = ranger(world, 1, 9.5, 4.5);
    a.input = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_FIRE };
    v.input = { mx: 0, my: 0, ax: -1, ay: 0, b: 0 };
    step(2); // windup underway, dir locked +x
    a.input = { mx: 0, my: 0, ax: -1, ay: 0, b: 0 }; // spin around mid-windup
    step(WINDUP + ACTIVE);
    // The locked +x swing still connects with the target in front.
    expect(events.filter((e) => e.k === 'hit')).toHaveLength(1);
  });

  it('cannot swing through walls', () => {
    const { world, events, step } = rig();
    // Wall row y=3 spans x=5..10 in the arena; straddle it vertically.
    const a = fighter(world, 0, 7.5, 2.6);
    const v = ranger(world, 1, 7.5, 4.4); // 1.8 apart, wall tile (7,3) between
    a.input = { mx: 0, my: 0, ax: 0, ay: 1, b: BTN_FIRE };
    v.input = { mx: 0, my: 0, ax: 0, ay: -1, b: 0 };
    step(WINDUP + ACTIVE + 2);
    expect(events.filter((e) => e.k === 'hit')).toHaveLength(0);
  });
});

describe('shield block', () => {
  function blockRig(victimFacingX: number): { events: SimEvent[]; v: Player; run: () => void } {
    const { world, events, step } = rig();
    const a = fighter(world, 0, 8, 4.5);
    const v = fighter(world, 1, 9.5, 4.5);
    a.input = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_FIRE };
    v.input = { mx: 0, my: 0, ax: victimFacingX, ay: 0, b: BTN_BLOCK };
    return { events, v, run: () => step(WINDUP + ACTIVE + 2) };
  }

  it('frontal block reduces damage by the shield factor', () => {
    const { events, v, run } = blockRig(-1); // facing the attacker
    run();
    const hit = events.find((e) => e.k === 'hit');
    expect(hit && hit.k === 'hit' && hit.blocked).toBe(true);
    const expected =
      getKit(cfg, 'fighter').maxHp - melee.damage * getKit(cfg, 'fighter').shield!.damageFactor;
    expect(v.hp).toBeCloseTo(expected, 5);
  });

  it('a shield facing the wrong way blocks nothing', () => {
    const { events, v, run } = blockRig(1); // facing away
    run();
    const hit = events.find((e) => e.k === 'hit');
    expect(hit && hit.k === 'hit' && hit.blocked).toBe(false);
    expect(v.hp).toBeCloseTo(getKit(cfg, 'fighter').maxHp - melee.damage, 5);
  });

  it('blocking suppresses your own attack', () => {
    const { world, step } = rig();
    const a = fighter(world, 0, 8, 4.5);
    ranger(world, 1, 9.5, 4.5);
    a.input = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_FIRE | BTN_BLOCK };
    step(5);
    expect(a.atkPhase).toBe(ATK_IDLE); // never started the swing
  });
});

describe('death, respawn, regen', () => {
  it('lethal damage kills, emits a kill event, and schedules the respawn', () => {
    const { world, events, step } = rig();
    const a = fighter(world, 0, 8, 4.5);
    const v = ranger(world, 1, 9.5, 4.5);
    v.hp = 10;
    a.input = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_FIRE };
    v.input = { mx: 0, my: 0, ax: -1, ay: 0, b: 0 };
    step(WINDUP + 1);
    expect(v.alive).toBe(false);
    expect(v.deaths).toBe(1);
    expect(a.kills).toBe(1);
    const kill = events.find((e) => e.k === 'kill');
    expect(kill && kill.k === 'kill' && kill.killer).toBe(a.id);
    expect(v.respawnAtTick).toBe(world.tick + secToTicks(cfg, cfg.player.respawnSec));
  });

  it('respawns at the squad keep with full hp after the timer', () => {
    const { world, events, step } = rig();
    const a = fighter(world, 0, 8, 4.5);
    const v = ranger(world, 1, 9.5, 4.5);
    v.hp = 1;
    a.input = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_FIRE };
    step(WINDUP + 1);
    expect(v.alive).toBe(false);
    step(secToTicks(cfg, cfg.player.respawnSec) + 1);
    expect(v.alive).toBe(true);
    expect(v.hp).toBe(getKit(cfg, 'ranger').maxHp);
    const keep = world.squads[1]!;
    expect(Math.hypot(v.x - keep.keepX, v.y - keep.keepY)).toBeLessThan(2);
    expect(events.some((e) => e.k === 'respawn' && e.id === v.id)).toBe(true);
  });

  it('dead players do not move, attack, or get hit', () => {
    const { world, events, step } = rig();
    const a = fighter(world, 0, 8, 4.5);
    const v = ranger(world, 1, 9.5, 4.5);
    v.hp = 1;
    a.input = { mx: 0, my: 0, ax: 1, ay: 0, b: BTN_FIRE };
    step(WINDUP + 1);
    expect(v.alive).toBe(false);
    const deadPos = { x: v.x, y: v.y };
    v.input = { mx: 1, my: 0, ax: 1, ay: 0, b: BTN_FIRE };
    const hitsBefore = events.filter((e) => e.k === 'hit').length;
    step(3);
    expect(v.x).toBe(deadPos.x);
    expect(v.atkPhase).toBe(ATK_IDLE);
    expect(events.filter((e) => e.k === 'hit').length).toBe(hitsBefore);
  });

  it('hp regenerates after the quiet delay, up to max', () => {
    const { world, step } = rig();
    const p = ranger(world, 0, 8, 4.5);
    p.hp = 50;
    p.lastDamagedTick = world.tick;
    const delay = secToTicks(cfg, cfg.combat.regenDelaySec);
    step(delay - 1);
    expect(p.hp).toBe(50); // still in the post-damage window
    step(30); // one second of regen
    expect(p.hp).toBeCloseTo(50 + cfg.combat.regenPerSec, 1);
    step(30 * 60); // a minute: clamped at max
    expect(p.hp).toBe(getKit(cfg, 'ranger').maxHp);
  });
});
