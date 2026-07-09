import { describe, expect, it } from 'vitest';
import { smokeConfig } from '../config';
import { parseMap } from '../map/parse';
import { tileIndex } from '../map/types';
import type { SimEvent } from './events';
import { stepWorld } from './step';
import { isVisibleToSquad, tileRayClear } from './vision';
import {
  buildOccupancy,
  buildTargetTile,
  canBuildWallAt,
  damageStructure,
  structuresInRange,
  wallCount,
} from './systems/structures';
import { createMoveState, kitMoveParams, stepMovement } from './systems/movement';
import type { InputCmd, Structure, World } from './world';
import {
  BTN_BOMB,
  BTN_BUILD,
  BTN_FIRE,
  PHASE_LIVE,
  STRUCT_WALL,
  createWorld,
  hashWorld,
  spawnPlayer,
} from './world';

// M4 slice 1: walls. The bot harness never builds, so wall mechanics live or
// die HERE — placement rules, the collision + vision occupancy layer, arrows as
// cover, firebomb/melee destruction, the build-supply ledger, and determinism.

// Open arena: 4 corner keeps, a town pair, a water strip, a forest patch — one
// of each rejection case for the placement validator. Keeps at (3,5)/(16,5)/
// (3,9)/(16,9); towns (6,3)/(7,3); forest (6,4)/(7,4); water (9,7)/(10,7).
const arena = parseMap(
  'wall-arena',
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

function liveWorld(seed = 1): World {
  const w = createWorld(seed, CFG, arena);
  // Skip the countdown warmup: drop straight into a live match with the
  // starting supply stock and phase-end far away.
  w.phase = PHASE_LIVE;
  w.phaseEndsTick = 1_000_000;
  return w;
}

function input(id: number, cmd: Partial<InputCmd>): Map<number, InputCmd> {
  return new Map([[id, { mx: 0, my: 0, ax: 1, ay: 0, b: 0, ...cmd }]]);
}

function addWall(
  w: World,
  squad: number,
  tx: number,
  ty: number,
  hp = CFG.build.wall.hp,
): Structure {
  const s: Structure = {
    id: w.nextId++,
    kind: STRUCT_WALL,
    squad,
    tx,
    ty,
    hp,
    maxHp: CFG.build.wall.hp,
  };
  w.structures.set(s.id, s);
  return s;
}

describe('build-supply ledger', () => {
  it('a living keep trickles supply, clamped to the cap', () => {
    const w = liveWorld();
    const start = w.squads[0]!.supply;
    expect(start).toBe(CFG.build.supplyStart);
    for (let i = 0; i < 30; i++) stepWorld(w, new Map(), CFG, arena); // 1 sim-second
    expect(w.squads[0]!.supply).toBeCloseTo(start + CFG.build.supplyPerSec, 3);
    expect(w.squads[0]!.supply).toBeLessThanOrEqual(w.squads[0]!.supplyMinted + 1e-9);

    // Clamp at the cap — never overfills.
    w.squads[0]!.supply = CFG.build.supplyCap - 0.01;
    for (let i = 0; i < 30; i++) stepWorld(w, new Map(), CFG, arena);
    expect(w.squads[0]!.supply).toBeLessThanOrEqual(CFG.build.supplyCap + 1e-9);
  });

  it('a destroyed keep stops the supply tap', () => {
    const w = liveWorld();
    w.squads[0]!.keepHp = 0;
    const frozen = w.squads[0]!.supply;
    for (let i = 0; i < 30; i++) stepWorld(w, new Map(), CFG, arena);
    expect(w.squads[0]!.supply).toBe(frozen);
  });
});

describe('wall placement', () => {
  it('BTN_BUILD raises a wall in front, spends supply, and emits an event', () => {
    const w = liveWorld();
    const p = spawnPlayer(w, CFG, 0, 'builder', false, 'ranger', 9.5, 6.5);
    const target = buildTargetTile(CFG, 9.5, 6.5, 0, -1); // 2 tiles up: (9,4)
    const supplyBefore = w.squads[0]!.supply;

    const events = stepWorld(w, input(p.id, { ax: 0, ay: -1, b: BTN_BUILD }), CFG, arena);

    expect(w.structures.size).toBe(1);
    const wall = [...w.structures.values()][0]!;
    expect([wall.tx, wall.ty]).toEqual([target.tx, target.ty]);
    expect(wall.squad).toBe(0);
    expect(wall.hp).toBe(CFG.build.wall.hp);
    // Generation (+perTick) then the cost is spent, same tick.
    expect(w.squads[0]!.supply).toBeCloseTo(
      supplyBefore + CFG.build.supplyPerSec / CFG.tick.simHz - CFG.build.wall.cost,
      2,
    );
    expect(events.some((e) => e.k === 'structBuilt')).toBe(true);
    expect(w.players.get(p.id)!.buildCd).toBeGreaterThan(0); // on cooldown now
  });

  it('rejects a placement the squad cannot afford', () => {
    const w = liveWorld();
    const p = spawnPlayer(w, CFG, 0, 'builder', false, 'ranger', 9.5, 6.5);
    w.squads[0]!.supply = CFG.build.wall.cost - 5;
    stepWorld(w, input(p.id, { ax: 0, ay: -1, b: BTN_BUILD }), CFG, arena);
    expect(w.structures.size).toBe(0);
  });

  it('honours the per-squad wall cap', () => {
    const w = liveWorld();
    const p = spawnPlayer(w, CFG, 0, 'builder', false, 'ranger', 9.5, 6.5);
    for (let i = 0; i < CFG.build.wall.maxCount; i++) addWall(w, 0, 3 + i, 2);
    expect(wallCount(w, 0)).toBe(CFG.build.wall.maxCount);
    w.squads[0]!.supply = 1000;
    stepWorld(w, input(p.id, { ax: 0, ay: -1, b: BTN_BUILD }), CFG, arena);
    expect(w.structures.size).toBe(CFG.build.wall.maxCount); // no new wall
  });

  it('the placement validator rejects terrain, structures, keeps, towns, and the enemy exclusion zone', () => {
    const w = liveWorld();
    const occ = new Set<number>();
    expect(canBuildWallAt(w, CFG, arena, occ, 0, 9, 7)).toBe(false); // water
    expect(canBuildWallAt(w, CFG, arena, occ, 0, 6, 4)).toBe(false); // forest
    expect(canBuildWallAt(w, CFG, arena, occ, 0, 3, 5)).toBe(false); // a keep site
    expect(canBuildWallAt(w, CFG, arena, occ, 0, 6, 3)).toBe(false); // a town
    expect(canBuildWallAt(w, CFG, arena, occ, 0, 15, 5)).toBe(false); // hugging enemy keep (16,5)

    // A player standing on the tile blocks it (never trap someone in a wall).
    spawnPlayer(w, CFG, 0, 'x', false, 'ranger', 9.5, 6.5);
    expect(canBuildWallAt(w, CFG, arena, occ, 0, 9, 6)).toBe(false);

    // An open tile clear of every rule — legal. (8,2) is ≥6 from all three
    // enemy keeps at (16.5,5.5)/(3.5,9.5)/(16.5,9.5).
    expect(canBuildWallAt(w, CFG, arena, occ, 0, 8, 2)).toBe(true);
    // ...until a structure already sits there.
    occ.add(tileIndex(arena, 8, 2));
    expect(canBuildWallAt(w, CFG, arena, occ, 0, 8, 2)).toBe(false);
  });
});

describe('walls as blockers', () => {
  it('occupancy reflects only living structures', () => {
    const w = liveWorld();
    const a = addWall(w, 0, 8, 6);
    addWall(w, 0, 9, 6);
    let occ = buildOccupancy(w, arena.width);
    expect(occ.has(tileIndex(arena, 8, 6))).toBe(true);
    expect(occ.size).toBe(2);
    a.hp = 0; // a corpse leaves the occupancy set
    occ = buildOccupancy(w, arena.width);
    expect(occ.has(tileIndex(arena, 8, 6))).toBe(false);
    expect(occ.size).toBe(1);
  });

  it('a wall stops movement that would otherwise pass', () => {
    const occ = new Set<number>([tileIndex(arena, 8, 6)]);
    const params = kitMoveParams(CFG, 'ranger');
    const cmd: InputCmd = { mx: 1, my: 0, ax: 1, ay: 0, b: 0 };

    const blocked = createMoveState(6.5, 6.5);
    for (let i = 0; i < 40; i++) stepMovement(blocked, cmd, params, arena, 1 / 30, 1, occ);
    expect(blocked.x).toBeLessThan(8); // never enters the wall tile

    const free = createMoveState(6.5, 6.5);
    for (let i = 0; i < 40; i++) stepMovement(free, cmd, params, arena, 1 / 30, 1, null);
    expect(free.x).toBeGreaterThan(8); // no wall — walks right through
  });

  it('a wall blocks vision rays and hides enemies behind it', () => {
    const w = liveWorld();
    spawnPlayer(w, CFG, 0, 'seer', false, 'ranger', 5.5, 6.5);
    const occ = new Set<number>([tileIndex(arena, 8, 6)]);
    expect(tileRayClear(arena, 5.5, 6.5, 11.5, 6.5, null)).toBe(true);
    expect(tileRayClear(arena, 5.5, 6.5, 11.5, 6.5, occ)).toBe(false);
    // An enemy at (11.5,6.5) is unseen through the wall, seen without it.
    expect(isVisibleToSquad(w, arena, CFG, 0, 11.5, 6.5, occ)).toBe(false);
    expect(isVisibleToSquad(w, arena, CFG, 0, 11.5, 6.5, null)).toBe(true);
  });

  it('an arrow is stopped by a wall (cover), not delivered to the target', () => {
    const build = (withWall: boolean): number => {
      const w = liveWorld();
      const shooter = spawnPlayer(w, CFG, 0, 'archer', false, 'ranger', 5.5, 6.5);
      const target = spawnPlayer(w, CFG, 1, 'target', false, 'ranger', 11.5, 6.5);
      if (withWall) addWall(w, 1, 8, 6);
      stepWorld(w, input(shooter.id, { ax: 1, ay: 0, b: BTN_FIRE }), CFG, arena);
      for (let i = 0; i < 25; i++) stepWorld(w, new Map(), CFG, arena);
      return w.players.get(target.id)!.hp;
    };
    expect(build(true)).toBe(CFG.classes.ranger.maxHp); // wall ate the arrow
    expect(build(false)).toBeLessThan(CFG.classes.ranger.maxHp); // clean line — hit
  });
});

describe('wall destruction', () => {
  it('a firebomb chews a wall, and two bring it down', () => {
    const w = liveWorld();
    const wall = addWall(w, 1, 12, 6); // enemy (squad 1) wall at max throw range
    const thrower = spawnPlayer(w, CFG, 0, 'sieger', false, 'ranger', 5.5, 6.5);
    // Lob lands at x = 5.5 + 1*range = 12.5 (aim kept unit) → on the wall tile.
    stepWorld(w, input(thrower.id, { ax: 1, ay: 0, b: BTN_BOMB }), CFG, arena);
    for (let i = 0; i < 25; i++) stepWorld(w, new Map(), CFG, arena);
    expect(wall.hp).toBeCloseTo(CFG.build.wall.hp - CFG.firebomb.damage, 5);
    expect(w.structures.has(wall.id)).toBe(true);

    // The kill blow via the damage entry point directly (deterministic).
    const events: SimEvent[] = [];
    damageStructure(w, wall, CFG.firebomb.damage, events);
    expect(w.structures.has(wall.id)).toBe(false);
    expect(events.some((e) => e.k === 'structDestroyed')).toBe(true);
  });

  it('structuresInRange spares the thrower’s own walls (no friendly fire)', () => {
    const w = liveWorld();
    addWall(w, 0, 12, 6); // own wall
    addWall(w, 1, 12, 7); // enemy wall next to it
    const hit = structuresInRange(w, 12.5, 6.5, CFG.firebomb.radius, 0);
    expect(hit.length).toBe(1);
    expect(hit[0]!.squad).toBe(1);
  });
});

describe('structures stay deterministic', () => {
  it('two identical build-and-siege scripts hash-match tick for tick', () => {
    const run = (): string[] => {
      const w = liveWorld(7);
      const builder = spawnPlayer(w, CFG, 0, 'b', false, 'ranger', 9.5, 6.5);
      const sieger = spawnPlayer(w, CFG, 1, 's', false, 'ranger', 9.5, 8.5);
      const hashes: string[] = [];
      for (let t = 0; t < 60; t++) {
        const inputs = new Map<number, InputCmd>();
        // Builder drops walls upward on a cadence; sieger firebombs upward.
        if (t % 12 === 0) inputs.set(builder.id, { mx: 0, my: 0, ax: 0, ay: -1, b: BTN_BUILD });
        if (t % 20 === 0) inputs.set(sieger.id, { mx: 0, my: 0, ax: 0, ay: -1, b: BTN_BOMB });
        stepWorld(w, inputs, CFG, arena);
        hashes.push(hashWorld(w));
      }
      return hashes;
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    expect(a.length).toBe(60);
  });
});
