import { describe, expect, it } from 'vitest';
import { smokeConfig } from '../config';
import { secToTicks } from '../config';
import { parseMap } from '../map/parse';
import { tileIndex } from '../map/types';
import { stepWorld } from './step';
import { isVisibleToSquad } from './vision';
import {
  buildOccupancy,
  canBuildStructAt,
  damageStructure,
  moveOccupancyFor,
  structuresInRange,
} from './systems/structures';
import { createMoveState, kitMoveParams, stepMovement } from './systems/movement';
import type { InputCmd, Player, Structure, World } from './world';
import {
  BTN_BUILD,
  BTN_BUILD_TRAP,
  BTN_DASH,
  PHASE_LIVE,
  STRUCT_TRAP,
  createWorld,
  hashWorld,
  serializeWorld,
  spawnPlayer,
} from './world';

// M4 slice 4: traps. Bots never build (that's s5), so the snare's whole
// contract lives here — Engineer-only placement, the it-blocks-NOTHING rule
// (occupancy, vision), arming, the one-victim trigger (damage + root + kill
// credit to the builder), the kernel-side root, and determinism. The
// enemy-never-sees-it fog rule is enforced server-side (snapshot + event
// tests in packages/server).

// Same arena as structures.test.ts: keeps (3,5)/(16,5)/(3,9)/(16,9), towns
// (6,3)/(7,3), forest (6,4)/(7,4), water (9,7)/(10,7). The lane y=1..2 around
// x=8..11 is outside every enemy-keep exclusion for squad 0.
const arena = parseMap(
  'trap-arena',
  `
####################
#1................2#
#..................#
#.....TT...........#
#.....ff...........#
#..K............K..#
#..................#
#........~~........#
#..................#
#..K............K..#
#3................4#
####################
`,
);

const CFG = smokeConfig;
const TRAP = CFG.build.trap;
const ARM_TICKS = secToTicks(CFG, TRAP.armSec);
const ROOT_TICKS = secToTicks(CFG, TRAP.rootSec);

function liveWorld(seed = 1): World {
  const w = createWorld(seed, CFG, arena);
  w.phase = PHASE_LIVE;
  w.phaseEndsTick = 1_000_000;
  return w;
}

function input(id: number, cmd: Partial<InputCmd>): Map<number, InputCmd> {
  return new Map([[id, { mx: 0, my: 0, ax: 1, ay: 0, b: 0, ...cmd }]]);
}

/** Plant a trap directly (already armed unless bornTick says otherwise). */
function addTrap(w: World, squad: number, tx: number, ty: number, by = -1, bornTick?: number): Structure {
  const s: Structure = {
    id: w.nextId++,
    kind: STRUCT_TRAP,
    squad,
    by,
    tx,
    ty,
    hp: TRAP.hp,
    maxHp: TRAP.hp,
    bornTick: bornTick ?? w.tick - ARM_TICKS, // armed NOW by default
  };
  w.structures.set(s.id, s);
  return s;
}

function trapCount(w: World): number {
  let n = 0;
  for (const s of w.structures.values()) if (s.kind === STRUCT_TRAP) n++;
  return n;
}

describe('trap placement', () => {
  it('the Engineer plants with V: supply spent, structBuilt kind 3; others cannot', () => {
    const w = liveWorld();
    const ranger = spawnPlayer(w, CFG, 0, 'r', false, 'ranger', 8.5, 3.5);
    stepWorld(w, input(ranger.id, { ax: 0, ay: -1, b: BTN_BUILD_TRAP }), CFG, arena);
    expect(w.structures.size).toBe(0); // not the specialist's trade

    const eng = spawnPlayer(w, CFG, 0, 'e', false, 'engineer', 8.5, 3.5);
    const before = w.squads[0]!.supply;
    const events = stepWorld(w, input(eng.id, { ax: 0, ay: -1, b: BTN_BUILD_TRAP }), CFG, arena);
    expect(trapCount(w)).toBe(1);
    const trap = [...w.structures.values()][0]!;
    expect(trap.kind).toBe(STRUCT_TRAP);
    expect(trap.by).toBe(eng.id);
    expect(trap.bornTick).toBe(w.tick);
    expect(w.squads[0]!.supply).toBeCloseTo(
      before + CFG.build.supplyPerSec / CFG.tick.simHz - TRAP.cost,
      5,
    );
    expect(events.some((e) => e.k === 'structBuilt' && e.kind === STRUCT_TRAP)).toBe(true);
  });

  it('per-squad cap holds, and an occupied tile refuses BOTH a second trap and a wall', () => {
    const w = liveWorld();
    const eng = spawnPlayer(w, CFG, 0, 'e', false, 'engineer', 8.5, 3.5);
    w.squads[0]!.supply = 10_000;
    // Five standing traps on (9..13,1); the engineer aims at the FREE (8,1).
    for (let i = 0; i < TRAP.maxCount; i++) addTrap(w, 0, 9 + i, 1);
    stepWorld(w, input(eng.id, { ax: 0, ay: -1, b: BTN_BUILD_TRAP }), CFG, arena);
    expect(trapCount(w)).toBe(TRAP.maxCount); // cap said no, not the tile

    // A trap's tile is out of the occupancy sets but still an occupied tile:
    // nothing stacks on it — the validator's direct scan covers trap tiles.
    const occ = buildOccupancy(w, arena.width);
    expect(canBuildStructAt(w, CFG, arena, occ, 0, 9, 1)).toBe(false);
    // Integration: a wall press aimed at a trap tile raises nothing.
    const eng2 = spawnPlayer(w, CFG, 0, 'e2', false, 'engineer', 9.5, 3.5);
    stepWorld(w, input(eng2.id, { ax: 0, ay: -1, b: BTN_BUILD }), CFG, arena);
    expect(occAt(w, 9, 1)).toBe(false); // no wall went up on the trap tile
  });
});

function occAt(w: World, tx: number, ty: number): boolean {
  return buildOccupancy(w, arena.width).has(tileIndex(arena, tx, ty));
}

describe('a trap blocks nothing', () => {
  it('is absent from both occupancy sets and never occludes vision', () => {
    const w = liveWorld();
    addTrap(w, 0, 10, 2);
    const ti = tileIndex(arena, 10, 2);
    expect(buildOccupancy(w, arena.width).has(ti)).toBe(false);
    for (let s = 0; s < 4; s++) {
      expect(moveOccupancyFor(w, arena.width, s).has(ti)).toBe(false);
    }
    // An enemy looking straight across the trap tile still sees past it.
    spawnPlayer(w, CFG, 1, 'eye', false, 'ranger', 8.5, 2.5);
    expect(isVisibleToSquad(w, arena, CFG, 1, 12.5, 2.5, buildOccupancy(w, arena.width))).toBe(
      true,
    );
  });

  it('an enemy walks clean across the tile when the trap is still arming', () => {
    const w = liveWorld();
    const enemy = spawnPlayer(w, CFG, 1, 'walker', false, 'ranger', 8.5, 2.5);
    addTrap(w, 0, 10, 2, -1, w.tick); // fresh: arming for ARM_TICKS
    const x0 = enemy.x;
    for (let i = 0; i < 12; i++) stepWorld(w, input(enemy.id, { mx: 1 }), CFG, arena);
    expect(enemy.x).toBeGreaterThan(x0 + 1.5); // sailed across (10,2), no clamp
    expect(enemy.hp).toBe(getMaxHp(enemy));
    expect(trapCount(w)).toBe(1); // and the arming trap did NOT fire
  });
});

function getMaxHp(p: Player): number {
  return CFG.classes[p.cls].maxHp;
}

describe('arming and trigger', () => {
  it('fires only once armed, then: damage, root, consumed, one victim only', () => {
    const w = liveWorld();
    const builder = spawnPlayer(w, CFG, 0, 'b', false, 'engineer', 3.5, 2.5);
    // Both enemies inside the trigger circle, exactly 0.8 apart so the pair
    // sits ON the pushout boundary — no drift, fully deterministic geometry.
    const victim = spawnPlayer(w, CFG, 1, 'v', false, 'ranger', 10.1, 2.5);
    const bystander = spawnPlayer(w, CFG, 1, 'v2', false, 'ranger', 10.9, 2.5);
    const trap = addTrap(w, 0, 10, 2, builder.id, w.tick);

    // Both enemies stand IN the circle for the whole arm window: nothing.
    let all: ReturnType<typeof stepWorld> = [];
    for (let i = 0; i < ARM_TICKS - 1; i++) {
      all = stepWorld(w, new Map(), CFG, arena);
      expect(all.some((e) => e.k === 'trapTriggered')).toBe(false);
    }
    expect(w.structures.has(trap.id)).toBe(true);

    // The arming tick: it bites the FIRST enemy (join order), exactly one.
    const events = stepWorld(w, new Map(), CFG, arena);
    const trig = events.filter((e) => e.k === 'trapTriggered');
    expect(trig.length).toBe(1);
    expect(trig[0]!.k === 'trapTriggered' && trig[0]!.victim).toBe(victim.id);
    expect(w.structures.has(trap.id)).toBe(false); // consumed, not "destroyed"
    expect(events.some((e) => e.k === 'structDestroyed')).toBe(false);
    expect(victim.hp).toBe(getMaxHp(victim) - TRAP.damage);
    expect(victim.rootTicks).toBe(ROOT_TICKS);
    expect(bystander.hp).toBe(getMaxHp(bystander)); // the snare closes on one leg
    expect(bystander.rootTicks).toBe(0);
    const hit = events.find((e) => e.k === 'hit');
    expect(hit && hit.k === 'hit' && hit.kind === 'trap' && hit.attacker === builder.id).toBe(
      true,
    );
  });

  it('never bites its own squad', () => {
    const w = liveWorld();
    const mate = spawnPlayer(w, CFG, 0, 'mate', false, 'ranger', 10.5, 2.5);
    addTrap(w, 0, 10, 2);
    for (let i = 0; i < 30; i++) stepWorld(w, new Map(), CFG, arena);
    expect(mate.hp).toBe(getMaxHp(mate));
    expect(trapCount(w)).toBe(1);
  });

  it('a dash into an armed trap is cut short — the snare ends the dash', () => {
    const w = liveWorld();
    spawnPlayer(w, CFG, 0, 'b', false, 'engineer', 3.5, 2.5);
    const victim = spawnPlayer(w, CFG, 1, 'v', false, 'ranger', 10.5, 2.5);
    addTrap(w, 0, 10, 2);
    victim.dashTicks = 5;
    victim.dashDx = 0;
    victim.dashDy = 0; // zero-vector dash: stays put, keeps the dash state
    stepWorld(w, new Map(), CFG, arena);
    expect(victim.rootTicks).toBe(ROOT_TICKS);
    expect(victim.dashTicks).toBe(0);
  });
});

describe('the root pins through the kernel', () => {
  it('rooted: no walking, no dash start; free again the tick it expires', () => {
    const w = liveWorld();
    const victim = spawnPlayer(w, CFG, 1, 'v', false, 'ranger', 10.5, 2.5);
    addTrap(w, 0, 10, 2);
    stepWorld(w, new Map(), CFG, arena); // trigger
    expect(victim.rootTicks).toBe(ROOT_TICKS);

    const x0 = victim.x;
    const y0 = victim.y;
    for (let i = 0; i < ROOT_TICKS; i++) {
      stepWorld(w, input(victim.id, { mx: 1, my: 0, b: BTN_DASH }), CFG, arena);
    }
    expect(victim.x).toBeCloseTo(x0, 9);
    expect(victim.y).toBeCloseTo(y0, 9);
    expect(victim.rootTicks).toBe(0);

    // Root spent — the same input moves them immediately the next tick.
    stepWorld(w, input(victim.id, { mx: 1, my: 0, b: 0 }), CFG, arena);
    expect(victim.x).toBeGreaterThan(x0);
  });

  it('kernel unit: rootTicks zeroes velocity, blocks dash, and self-decrements', () => {
    const params = kitMoveParams(CFG, 'ranger');
    const s = createMoveState(10.5, 2.5);
    s.rootTicks = 3;
    const dt = 1 / CFG.tick.simHz;
    const cmd: InputCmd = { mx: 1, my: 0, ax: 1, ay: 0, b: BTN_DASH };
    for (let i = 0; i < 3; i++) stepMovement(s, cmd, params, arena, dt);
    expect(s.x).toBe(10.5);
    expect(s.dashTicks).toBe(0);
    expect(s.rootTicks).toBe(0);
    // Note: the dash button was HELD through the root, so no rising edge
    // remains — walking resumes. (A fresh tap after the root dashes fine.)
    stepMovement(s, { ...cmd, b: 0 }, params, arena, dt);
    stepMovement(s, cmd, params, arena, dt);
    expect(s.dashTicks).toBeGreaterThan(0);
  });
});

describe('kill credit', () => {
  it('a lethal trap pays the builder like any kill', () => {
    const w = liveWorld();
    const builder = spawnPlayer(w, CFG, 0, 'b', false, 'engineer', 3.5, 2.5);
    const victim = spawnPlayer(w, CFG, 1, 'v', false, 'ranger', 10.5, 2.5);
    victim.hp = TRAP.damage - 1;
    victim.spawnedAtTick = -10_000; // dodge the fresh-spawn anti-farm rule
    addTrap(w, 0, 10, 2, builder.id);
    const goldBefore = w.squads[0]!.keepGold;

    const events = stepWorld(w, new Map(), CFG, arena);
    const kill = events.find((e) => e.k === 'kill');
    expect(kill && kill.k === 'kill' && kill.killer).toBe(builder.id);
    expect(victim.alive).toBe(false);
    expect(victim.rootTicks).toBe(0); // death clears the snare
    expect(builder.kills).toBe(1);
    expect(w.squads[0]!.keepGold).toBeGreaterThan(goldBefore);
  });

  it('an orphaned trap (builder left) still bites — credit goes to nobody', () => {
    const w = liveWorld();
    const builder = spawnPlayer(w, CFG, 0, 'b', false, 'engineer', 3.5, 2.5);
    const victim = spawnPlayer(w, CFG, 1, 'v', false, 'ranger', 10.5, 2.5);
    victim.hp = 1;
    victim.spawnedAtTick = -10_000;
    addTrap(w, 0, 10, 2, builder.id);
    w.players.delete(builder.id); // the leave path removes the body; trap stays

    const events = stepWorld(w, new Map(), CFG, arena);
    expect(victim.alive).toBe(false);
    const hit = events.find((e) => e.k === 'hit');
    expect(hit && hit.k === 'hit' && hit.attacker).toBe(-1);
    const kill = events.find((e) => e.k === 'kill');
    expect(kill && kill.k === 'kill' && kill.killer).toBe(null);
  });
});

describe('counterplay and determinism', () => {
  it('splash finds and clears a trap (structuresInRange + 1hp)', () => {
    const w = liveWorld();
    const trap = addTrap(w, 0, 10, 2);
    // Enemy blast centered a tile away still overlaps the trap tile AABB.
    const hit = structuresInRange(w, 11.2, 2.5, CFG.firebomb.radius, 1);
    expect(hit).toContain(trap);
    const events: ReturnType<typeof stepWorld> = [];
    damageStructure(w, trap, CFG.firebomb.damage, events);
    expect(w.structures.has(trap.id)).toBe(false);
    expect(events.some((e) => e.k === 'structDestroyed' && e.kind === STRUCT_TRAP)).toBe(true);
  });

  it('identical trap scripts hash-match tick for tick; root state is serialized', () => {
    const run = (): string[] => {
      const w = liveWorld(7);
      const eng = spawnPlayer(w, CFG, 0, 'e', false, 'engineer', 8.5, 3.5);
      const enemy = spawnPlayer(w, CFG, 1, 'x', false, 'fighter', 10.5, 1.5);
      const hashes: string[] = [];
      for (let t = 0; t < 120; t++) {
        const inputs = new Map<number, InputCmd>();
        // Engineer: plant north onto (8,1) at t=0, then hold ground.
        inputs.set(eng.id, {
          mx: 0,
          my: 0,
          ax: 0,
          ay: -1,
          b: t === 0 ? BTN_BUILD_TRAP : 0,
        });
        // Enemy: walk west along the lane and STOP inside the trigger circle
        // (~x 8.07 after 14 ticks) — standing there when the trap arms.
        inputs.set(enemy.id, { mx: t < 14 ? -1 : 0, my: 0, ax: -1, ay: 0, b: 0 });
        stepWorld(w, inputs, CFG, arena);
        hashes.push(hashWorld(w));
      }
      // The script must actually exercise the mechanism.
      expect(enemy.hp).toBe(getMaxHp(enemy) - TRAP.damage);
      expect(serializeWorld(w)).toContain('"rot":');
      return hashes;
    };
    expect(run()).toEqual(run());
  });
});
