import { describe, expect, it } from 'vitest';
import { smokeConfig as cfg } from '../config';
import { parseMap } from '../map/parse';
import { canSeePoint, isVisibleToSquad, tileRayClear } from './vision';
import { createWorld, PHASE_LIVE, spawnPlayer } from './world';

// The one visibility function. Wall rays, radii, and the forest rule — the
// same code path the server filters snapshots with and the client draws
// fog from.

const arena = parseMap(
  'vision-arena',
  `
##############################
#1..........................2#
#..K.......#..............K..#
#..........#.......T.........#
#....fffffff.................#
#....fffffff.................#
#..K......................K..#
#3..........................4#
##############################
`,
);

describe('tileRayClear', () => {
  it('clear across open ground', () => {
    expect(tileRayClear(arena, 2.5, 1.5, 9.5, 1.5)).toBe(true);
  });

  it('blocked by a wall tile between the points', () => {
    // Wall column x=11 spans y=2..3.
    expect(tileRayClear(arena, 9.5, 2.5, 13.5, 2.5)).toBe(false);
    expect(tileRayClear(arena, 9.5, 3.5, 13.5, 3.5)).toBe(false);
  });

  it('clear around the wall (different row)', () => {
    expect(tileRayClear(arena, 9.5, 1.5, 13.5, 1.5)).toBe(true);
  });

  it('same tile and adjacent tiles are trivially clear', () => {
    expect(tileRayClear(arena, 2.2, 1.2, 2.8, 1.8)).toBe(true);
    expect(tileRayClear(arena, 2.5, 1.5, 3.5, 1.5)).toBe(true);
  });

  it('forest does NOT block rays (concealment, not walls)', () => {
    // Across the forest block rows 4-5.
    expect(tileRayClear(arena, 3.5, 4.5, 14.5, 4.5)).toBe(true);
  });
});

describe('canSeePoint', () => {
  const R = cfg.vision.radius;
  const FR = cfg.vision.forestRadius;

  it('within radius on open ground: visible', () => {
    expect(canSeePoint(arena, cfg, 2.5, 6.5, 2.5 + R - 1, 6.5)).toBe(true);
  });

  it('beyond radius: hidden', () => {
    expect(canSeePoint(arena, cfg, 2.5, 6.5, 2.5 + R + 1, 6.5)).toBe(false);
  });

  it('behind a wall inside radius: hidden', () => {
    expect(canSeePoint(arena, cfg, 9.5, 2.5, 13.5, 2.5)).toBe(false);
  });

  it('forest rule: a target in trees is hidden beyond forestRadius…', () => {
    // Target inside the forest block (rows 4-5, x=5..11).
    expect(canSeePoint(arena, cfg, 6.5 + FR + 1, 4.5, 6.5, 4.5)).toBe(false);
  });

  it('…but revealed up close', () => {
    expect(canSeePoint(arena, cfg, 6.5 + FR - 1, 4.5, 6.5, 4.5)).toBe(true);
  });

  it('a viewer INSIDE forest sees out normally (treeline ambush)', () => {
    expect(canSeePoint(arena, cfg, 6.5, 4.5, 6.5 + R - 2, 6.5)).toBe(true);
  });
});

describe('isVisibleToSquad', () => {
  it('any living member grants vision; dead members do not', () => {
    const w = createWorld(1, cfg, arena);
    w.phase = PHASE_LIVE;
    const a = spawnPlayer(w, cfg, 0, 'a', true, 'ranger', 2.5, 6.5);
    const target = { x: 2.5 + cfg.vision.radius - 1, y: 6.5 };
    expect(isVisibleToSquad(w, arena, cfg, 0, target.x, target.y)).toBe(true);
    a.alive = false;
    expect(isVisibleToSquad(w, arena, cfg, 0, target.x, target.y)).toBe(false);
    // A second living member restores the squad's sight.
    spawnPlayer(w, cfg, 0, 'b', true, 'ranger', 2.5, 6.5);
    expect(isVisibleToSquad(w, arena, cfg, 0, target.x, target.y)).toBe(true);
  });
});
