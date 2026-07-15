import { describe, expect, it } from 'vitest';
import { smokeConfig } from '@shared/config';
import { parseMap } from '@shared/map/parse';
import type { Structure, World } from '@shared/sim/world';
import { createWorld, NEUTRAL_SQUAD, PHASE_LIVE, spawnPlayer, STRUCT_TREE } from '@shared/sim/world';
import { buildSquadStructures } from '../src/snapshot';

// Neutral countryside props follow the ordinary structure fog rule — and
// because squad −1 is never "own", eyes-on applies to EVERY squad equally:
// you learn the countryside by scouting it, exactly like enemy walls.

const arena = parseMap(
  'props-fog-arena',
  `
########################################
#1....................................2#
#..T...................................#
#..K..............................K....#
#......................................#
#..K..............................K....#
#3....................................4#
########################################
`,
);

function addTree(w: World, tx: number, ty: number): Structure {
  const st: Structure = {
    id: w.nextId++,
    kind: STRUCT_TREE,
    squad: NEUTRAL_SQUAD,
    by: -1,
    tx,
    ty,
    hp: 60,
    maxHp: 60,
    bornTick: 0,
  };
  w.structures.set(st.id, st);
  return st;
}

describe('neutral prop fog', () => {
  it('a far tree is not serialized; eyes on the tile reveal it (squad −1 intact)', () => {
    const w = createWorld(1, smokeConfig, arena);
    w.phase = PHASE_LIVE;
    const tree = addTree(w, 30, 3);
    spawnPlayer(w, smokeConfig, 0, 'scout', false, 'ranger', 3.5, 3.5);

    // 26+ tiles away — far outside vision.
    const far = buildSquadStructures(w, arena, smokeConfig, 0);
    expect(far.find((s) => s.i === tree.id)).toBeUndefined();

    // A squadmate walks up: the tree enters the snapshot, neutral and typed.
    spawnPlayer(w, smokeConfig, 0, 'eyes', false, 'ranger', 28.5, 3.5);
    const near = buildSquadStructures(w, arena, smokeConfig, 0);
    const snap = near.find((s) => s.i === tree.id);
    expect(snap).toBeDefined();
    expect(snap!.k).toBe(STRUCT_TREE);
    expect(snap!.s).toBe(NEUTRAL_SQUAD);
  });
});
