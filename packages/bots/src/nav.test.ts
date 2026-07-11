import { describe, expect, it } from 'vitest';
import { parseMap } from '@shared/map/parse';
import { findPath, randomWalkableTile, walkRayClear } from './nav';
import { createRng } from '@shared/math/rng';

// M4 s5: nav takes an optional dynamic blocked-tile set (structures the bot
// can see + bump memory). Terrain stays the map's truth; blocked is the
// caller's. These tests pin that a blocked line actually reroutes A*, kills
// direct-steer rays, and poisons roam destinations.

// 20×11 open arena with a border wall (parser demands the full landmark
// inventory — spawns, keeps, a town — none of which these tests touch).
const arena = parseMap(
  'nav-arena',
  `
####################
#1........2.......K#
#..................#
#K................T#
#..................#
#..................#
#..................#
#K.................#
#..................#
#3.......4........K#
####################
`,
);

const ti = (x: number, y: number): number => y * arena.width + x;

/** A vertical "wall" of blocked tiles at x=10, y 1..9 with NO gap. */
function wallLine(gapY = -1): Set<number> {
  const s = new Set<number>();
  for (let y = 1; y <= 9; y++) if (y !== gapY) s.add(ti(10, y));
  return s;
}

describe('nav with dynamic blockers', () => {
  it('walkRayClear: a blocked tile kills the straight line', () => {
    expect(walkRayClear(arena, 3.5, 5.5, 16.5, 5.5)).toBe(true);
    expect(walkRayClear(arena, 3.5, 5.5, 16.5, 5.5, wallLine())).toBe(false);
    // A gap right on the ray lets it through.
    expect(walkRayClear(arena, 3.5, 5.5, 16.5, 5.5, wallLine(5))).toBe(true);
  });

  it('findPath: routes through the gap, fails when sealed', () => {
    const through = findPath(arena, 3, 5, 16, 5, wallLine(2));
    expect(through).not.toBeNull();
    // The detour must actually pass the gap tile row.
    expect(through!.some((w) => Math.floor(w.x) === 10 && Math.floor(w.y) === 2)).toBe(true);

    const sealed = findPath(arena, 3, 5, 16, 5, wallLine());
    expect(sealed).toBeNull();

    // Control: no blockers, straight-ish path exists.
    expect(findPath(arena, 3, 5, 16, 5)).not.toBeNull();
  });

  it('findPath: a blocked goal is unreachable; a blocked start is exempt', () => {
    const blocked = new Set([ti(16, 5)]);
    expect(findPath(arena, 3, 5, 16, 5, blocked)).toBeNull();
    // Standing on a tile we just bump-marked must not strand us.
    const startBlocked = new Set([ti(3, 5)]);
    expect(findPath(arena, 3, 5, 16, 5, startBlocked)).not.toBeNull();
  });

  it('randomWalkableTile never lands on a blocked tile', () => {
    // Block everything except one column; every draw must land there.
    const blocked = new Set<number>();
    for (let y = 1; y <= 9; y++) {
      for (let x = 1; x <= 18; x++) {
        if (x !== 15) blocked.add(ti(x, y));
      }
    }
    const rng = createRng(7);
    for (let i = 0; i < 20; i++) {
      const t = randomWalkableTile(arena, rng, 2, 2, 3, blocked);
      if (t) expect(Math.floor(t.x)).toBe(15);
    }
  });
});
