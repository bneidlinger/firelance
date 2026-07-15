import { describe, expect, it } from 'vitest';
import type { GameConfig } from '../config';
import { smokeConfig } from '../config';
import { getMap } from '../map/maps';
import { parseMap } from '../map/parse';
import { stepWorld } from './step';
import { structuresInRange } from './systems/structures';
import type { InputCmd, Structure, World } from './world';
import {
  BTN_FIRE,
  createWorld,
  NEUTRAL_SQUAD,
  PHASE_LIVE,
  spawnPlayer,
  STRUCT_HUT,
  STRUCT_TREE,
  STRUCT_WALL,
} from './world';

// The Lived-In Vale (interlude s1): neutral countryside props. Placement is a
// FORKED-stream draw at world creation — deterministic per seed, exclusion-
// ruled, and guaranteed to never seal a chokepoint. Damage is weapon-typed:
// swords chop trees, huts demolish slowly, arrows stick, bolts bite, and
// player-built pieces keep their old numbers exactly.

const vale = getMap('vale_full');

/** Smoke baseline (variation/rumors off) with the countryside switched on. */
const PROPS_CFG: GameConfig = {
  ...smokeConfig,
  props: { ...smokeConfig.props, enabled: true },
};

const propsList = (w: World): string =>
  [...w.structures.values()]
    .map((s) => `${s.kind}:${s.tx},${s.ty}`)
    .sort()
    .join('|');

describe('props placement (vale_full)', () => {
  it('same seed draws the same countryside; different seeds differ', () => {
    const a = createWorld(77, PROPS_CFG, vale);
    const b = createWorld(77, PROPS_CFG, vale);
    const c = createWorld(78, PROPS_CFG, vale);
    // The countryside actually exists (placement isn't silently starved)…
    expect(a.structures.size).toBeGreaterThan(20);
    // …every client and replay re-derives it bit-exactly…
    expect(propsList(a)).toBe(propsList(b));
    // …and consecutive matches get a different board.
    expect(propsList(a)).not.toBe(propsList(c));
  });

  it('placement never advances world.rng (forked stream)', () => {
    const off: GameConfig = { ...PROPS_CFG, props: { ...PROPS_CFG.props, enabled: false } };
    expect(createWorld(5, PROPS_CFG, vale).rng.s).toBe(createWorld(5, off, vale).rng.s);
  });

  it('ground rules and landmark clearances hold (15 seeds)', () => {
    const pc = PROPS_CFG.props;
    const violations: string[] = [];
    for (let seed = 1; seed <= 15; seed++) {
      const tiles = new Set<number>();
      for (const s of createWorld(seed, PROPS_CFG, vale).structures.values()) {
        const at = `seed ${seed} kind ${s.kind} @ ${s.tx},${s.ty}`;
        const i = s.ty * vale.width + s.tx;
        if (s.squad !== NEUTRAL_SQUAD) violations.push(`${at}: not neutral`);
        if (tiles.has(i)) violations.push(`${at}: stacked`);
        tiles.add(i);
        if (vale.walk[i] === 1) violations.push(`${at}: on water/rock`);
        if (vale.forest[i] === 1) violations.push(`${at}: in forest`);
        const cx = s.tx + 0.5;
        const cy = s.ty + 0.5;
        const near = (x: number, y: number, r: number): boolean =>
          (x - cx) * (x - cx) + (y - cy) * (y - cy) < r * r;
        if (vale.keeps.some((k) => near(k.x, k.y, pc.keepClear))) {
          violations.push(`${at}: inside a keep clearance`);
        }
        if (vale.towns.some((t) => near(t.x, t.y, pc.townClear))) {
          violations.push(`${at}: inside a town clearance`);
        }
        if (vale.spawns.some((p) => near(p.x, p.y, pc.spawnClear))) {
          violations.push(`${at}: inside a spawn clearance`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the countryside survives goLive (the warmup reset spares neutral props)', () => {
    // The bug the first live playtest found: goLive() hard-resets the world —
    // projectiles, sacks, bombs, structures — and structures.clear() silently
    // deleted every prop the moment the match went live. Smoke's zero-length
    // placement + countdown collapse in one step: tick 1 IS the boundary.
    const w = createWorld(9, PROPS_CFG, vale);
    const before = w.structures.size;
    expect(before).toBeGreaterThan(20);
    stepWorld(w, new Map(), PROPS_CFG, vale);
    expect(w.phase).toBe(PHASE_LIVE);
    expect(w.structures.size).toBe(before);
  });

  it('the countryside never seals a chokepoint (15 seeds)', () => {
    // Independent flood-fill (deliberately NOT the placement module's own):
    // 4-connected walk over terrain minus prop tiles, from spawn 0, must
    // reach every keep site, town, and spawn.
    for (let seed = 1; seed <= 15; seed++) {
      const w = createWorld(seed, PROPS_CFG, vale);
      const blocked = new Set<number>();
      for (const s of w.structures.values()) blocked.add(s.ty * vale.width + s.tx);
      const seen = new Uint8Array(vale.width * vale.height);
      const start = Math.floor(vale.spawns[0]!.y) * vale.width + Math.floor(vale.spawns[0]!.x);
      const queue = [start];
      seen[start] = 1;
      while (queue.length > 0) {
        const i = queue.pop()!;
        const tx = i % vale.width;
        const ty = (i - tx) / vale.width;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = tx + dx;
          const ny = ty + dy;
          if (nx < 0 || ny < 0 || nx >= vale.width || ny >= vale.height) continue;
          const ni = ny * vale.width + nx;
          if (seen[ni] === 1 || blocked.has(ni) || vale.walk[ni] === 1) continue;
          seen[ni] = 1;
          queue.push(ni);
        }
      }
      const reach = (x: number, y: number): boolean =>
        seen[Math.floor(y) * vale.width + Math.floor(x)] === 1;
      for (const k of vale.keeps) expect(reach(k.x, k.y), `seed ${seed} keep`).toBe(true);
      for (const t of vale.towns) expect(reach(t.x, t.y), `seed ${seed} town`).toBe(true);
      for (const s of vale.spawns) expect(reach(s.x, s.y), `seed ${seed} spawn`).toBe(true);
    }
  });
});

// ---- damage table: hand-placed props on a bare arena (props disabled so
// placement adds nothing), driven through the real sim step.

const arena = parseMap(
  'props-arena',
  `
####################
#1................2#
#....T.............#
#..K............K..#
#..................#
#..................#
#..................#
#..K............K..#
#3................4#
####################
`,
);

const CFG = smokeConfig; // props off — this arena is hand-set

function liveWorld(seed = 1): World {
  const w = createWorld(seed, CFG, arena);
  w.phase = PHASE_LIVE;
  w.phaseEndsTick = 1_000_000;
  return w;
}

function input(id: number, cmd: Partial<InputCmd>): Map<number, InputCmd> {
  return new Map([[id, { mx: 0, my: 0, ax: 1, ay: 0, b: 0, ...cmd }]]);
}

function addProp(w: World, kind: typeof STRUCT_TREE | typeof STRUCT_HUT, tx: number, ty: number): Structure {
  const hp = kind === STRUCT_TREE ? CFG.props.treeHp : CFG.props.hutHp;
  const st: Structure = {
    id: w.nextId++,
    kind,
    squad: NEUTRAL_SQUAD,
    by: -1,
    tx,
    ty,
    hp,
    maxHp: hp,
    bornTick: 0,
  };
  w.structures.set(st.id, st);
  return st;
}

/** Hold FIRE until the target's hp first drops; returns ticks spent. */
function swingUntilChip(w: World, attackerId: number, target: Structure, cap = 200): number {
  const before = target.hp;
  for (let i = 0; i < cap; i++) {
    stepWorld(w, input(attackerId, { ax: 1, ay: 0, b: BTN_FIRE }), CFG, arena);
    if (target.hp < before || !w.structures.has(target.id)) return i;
  }
  return cap;
}

describe('props damage table', () => {
  it('a sword chops a tree hard, a hut slowly, a wall exactly as before', () => {
    const w = liveWorld();
    const fighter = spawnPlayer(w, CFG, 0, 'axe', false, 'fighter', 9.2, 4.5);
    const tree = addProp(w, STRUCT_TREE, 10, 4);
    swingUntilChip(w, fighter.id, tree);
    expect(tree.hp).toBe(CFG.props.treeHp - CFG.props.treeMelee);

    const w2 = liveWorld();
    const fighter2 = spawnPlayer(w2, CFG, 0, 'axe', false, 'fighter', 9.2, 4.5);
    const hut = addProp(w2, STRUCT_HUT, 10, 4);
    swingUntilChip(w2, fighter2.id, hut);
    expect(hut.hp).toBe(CFG.props.hutHp - CFG.props.hutMelee);

    const w3 = liveWorld();
    const fighter3 = spawnPlayer(w3, CFG, 0, 'axe', false, 'fighter', 9.2, 4.5);
    const wallHp = 200;
    const wall: Structure = {
      id: w3.nextId++,
      kind: STRUCT_WALL,
      squad: 1,
      by: -1,
      tx: 10,
      ty: 4,
      hp: wallHp,
      maxHp: wallHp,
      bornTick: 0,
    };
    w3.structures.set(wall.id, wall);
    swingUntilChip(w3, fighter3.id, wall);
    expect(wall.hp).toBe(wallHp - CFG.build.meleeChip);
  });

  it('a sword fells a tree in three swings', () => {
    const w = liveWorld();
    const fighter = spawnPlayer(w, CFG, 0, 'axe', false, 'fighter', 9.2, 4.5);
    const tree = addProp(w, STRUCT_TREE, 10, 4);
    let swings = 0;
    for (let i = 0; i < 600 && w.structures.has(tree.id); i++) {
      const before = tree.hp;
      stepWorld(w, input(fighter.id, { ax: 1, ay: 0, b: BTN_FIRE }), CFG, arena);
      if (tree.hp < before) swings++;
    }
    expect(w.structures.has(tree.id)).toBe(false);
    expect(swings).toBe(Math.ceil(CFG.props.treeHp / CFG.props.treeMelee)); // 3
  });

  it('arrows stick, bolts bite — and walls stay arrow-proof', () => {
    const shoot = (cls: 'ranger' | 'engineer', target: 'hut' | 'wall'): number => {
      const w = liveWorld();
      const shooter = spawnPlayer(w, CFG, 0, 'shot', false, cls, 5.5, 4.5);
      let hp0: number;
      let get: () => number;
      if (target === 'hut') {
        const hut = addProp(w, STRUCT_HUT, 10, 4);
        hp0 = hut.hp;
        get = () => hut.hp;
      } else {
        const wall: Structure = {
          id: w.nextId++,
          kind: STRUCT_WALL,
          squad: 1,
          by: -1,
          tx: 10,
          ty: 4,
          hp: 200,
          maxHp: 200,
          bornTick: 0,
        };
        w.structures.set(wall.id, wall);
        hp0 = wall.hp;
        get = () => wall.hp;
      }
      stepWorld(w, input(shooter.id, { ax: 1, ay: 0, b: BTN_FIRE }), CFG, arena);
      for (let i = 0; i < 30; i++) stepWorld(w, new Map(), CFG, arena);
      return hp0 - get();
    };
    const bow = CFG.classes.ranger.bow!;
    const xbow = CFG.classes.engineer.bow!;
    expect(shoot('ranger', 'hut')).toBe(Math.round(bow.damage * CFG.props.arrowFactor));
    expect(shoot('engineer', 'hut')).toBe(Math.round(xbow.damage * CFG.props.boltFactor));
    expect(shoot('ranger', 'wall')).toBe(0); // built pieces keep their arrow immunity
  });

  it('neutral props are nobody\'s own — every squad\'s bombs and blades connect', () => {
    const w = liveWorld();
    const tree = addProp(w, STRUCT_TREE, 10, 4);
    for (let squad = 0; squad < 4; squad++) {
      expect(structuresInRange(w, 10.5, 4.5, 1, squad)).toContain(tree);
    }
  });
});
