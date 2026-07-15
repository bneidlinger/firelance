import type { GameConfig } from '../../config';
import type { MapData } from '../../map/types';
import { isWalkBlocked, tileIndex } from '../../map/types';
import { createRng, rngFloat, rngInt } from '../../math/rng';
import type { RngState } from '../../math/rng';
import type { Structure, World } from '../world';
import { NEUTRAL_SQUAD, STRUCT_HUT, STRUCT_TREE } from '../world';

// Countryside props (the Lived-In Vale): neutral trees and huts, placed ONCE
// at world creation. Semi-random per match — drawn from a FORKED seed stream
// (the map/variant.ts precedent) so ambient world.rng never advances: configs
// with props disabled keep their exact rng streams, and every pinned-seed arc
// test survives untouched. Replays and restarts re-derive the identical
// countryside because they re-run createWorld with the same (seed, cfg, map).
//
// Props ride the structure machinery end to end: they block movement, vision,
// and projectiles (buildOccupancy includes every non-trap kind), they take
// damage through damageStructure, they serialize under the same fog rules
// (neutral is never "own" — eyes-on for everyone), and bots path around them
// through the ordinary snapshot blocked-set. Chopping a tree to open a
// sightline is the point.
//
// Placement safety, enforced deterministically (every replay re-derives the
// same drops):
//   - never on water/rock/forest/bridge tiles, or a tile already taken
//   - clear radii around keep SITES (all of them — they are rebuild spots),
//     towns, and muster spawns
//   - never SEALS a choke: a candidate whose 8-neighborhood isn't fully open
//     must pass a flood-fill proving every landmark stays reachable

/** Stream fork: golden-ratio constant, same trick as variant.ts. */
const PROPS_STREAM_XOR = 0x9e3779b9;

export function placeProps(world: World, cfg: GameConfig, map: MapData, seed: number): void {
  if (!cfg.props.enabled) return;
  const pc = cfg.props;
  const rng = createRng((seed ^ PROPS_STREAM_XOR) >>> 0);

  // ---- exclusion mask: placement-only (excluded tiles stay walkable).
  const excluded = new Set<number>();
  const clearCircle = (cx: number, cy: number, r: number): void => {
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(map.width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(map.height - 1, Math.ceil(cy + r));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const dx = tx + 0.5 - cx;
        const dy = ty + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) excluded.add(ty * map.width + tx);
      }
    }
  };
  for (const k of map.keeps) clearCircle(k.x, k.y, pc.keepClear);
  for (const t of map.towns) clearCircle(t.x, t.y, pc.townClear);
  for (const s of map.spawns) clearCircle(s.x, s.y, pc.spawnClear);

  // Bridges: walkable tiles flanked by water on opposite sides (the client's
  // plank-render heuristic, reused as a placement rule — a hut may guard a
  // bridge approach, never the deck).
  const isWater = (tx: number, ty: number): boolean => {
    if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return false;
    const i = ty * map.width + tx;
    return map.walk[i] === 1 && map.vision[i] === 0;
  };
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      if (isWalkBlocked(map, tx, ty)) continue;
      if ((isWater(tx - 1, ty) && isWater(tx + 1, ty)) || (isWater(tx, ty - 1) && isWater(tx, ty + 1))) {
        clearCircle(tx + 0.5, ty + 0.5, pc.bridgeClear);
      }
    }
  }

  // ---- landmark set the flood-fill must keep mutually reachable.
  const landmarks: number[] = [];
  for (const k of map.keeps) landmarks.push(tileIndex(map, Math.floor(k.x), Math.floor(k.y)));
  for (const t of map.towns) landmarks.push(tileIndex(map, Math.floor(t.x), Math.floor(t.y)));
  for (const s of map.spawns) landmarks.push(tileIndex(map, Math.floor(s.x), Math.floor(s.y)));
  const floodFrom = landmarks[landmarks.length - 1] ?? 0; // a spawn: walkable, never taken

  const taken = new Set<number>();

  const legal = (tx: number, ty: number): boolean => {
    if (tx < 1 || ty < 1 || tx >= map.width - 1 || ty >= map.height - 1) return false;
    if (isWalkBlocked(map, tx, ty)) return false;
    const i = ty * map.width + tx;
    if (map.forest[i] === 1) return false;
    return !excluded.has(i) && !taken.has(i);
  };

  /** A tile whose full 8-neighborhood is open ground can never disconnect the
   *  grid — skip the flood. Anything chokier proves itself. */
  const mayBlock = (tx: number, ty: number): boolean => {
    let open = true;
    for (let dy = -1; dy <= 1 && open; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (isWalkBlocked(map, tx + dx, ty + dy) || taken.has((ty + dy) * map.width + tx + dx)) {
          open = false;
          break;
        }
      }
    }
    if (open) return false;
    return !landmarksReachable(map, taken, tileIndex(map, tx, ty), floodFrom, landmarks);
  };

  const put = (tx: number, ty: number, kind: typeof STRUCT_TREE | typeof STRUCT_HUT): void => {
    const hp = kind === STRUCT_TREE ? pc.treeHp : pc.hutHp;
    const st: Structure = {
      id: world.nextId++,
      kind,
      squad: NEUTRAL_SQUAD,
      by: -1,
      tx,
      ty,
      hp,
      maxHp: hp,
      bornTick: 0,
    };
    world.structures.set(st.id, st);
    taken.add(tileIndex(map, tx, ty));
  };

  // ---- trees: clumps of 1–3, biased toward forest fringes and riverbanks
  // (an open-field candidate flips a coin and may be redrawn — one extra rng
  // draw either way keeps the stream deterministic).
  for (let c = 0; c < pc.treeClumps; c++) {
    const center = findSpot(rng, map, legal, mayBlock, (tx, ty) => {
      const fringe = nearFeature(map, tx, ty);
      return fringe || rngFloat(rng) < 0.5;
    });
    if (!center) continue;
    put(center.tx, center.ty, STRUCT_TREE);
    const extra = rngInt(rng, 0, 2);
    for (let e = 0; e < extra; e++) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const tx = center.tx + rngInt(rng, -1, 1);
        const ty = center.ty + rngInt(rng, -1, 1);
        if (legal(tx, ty) && !mayBlock(tx, ty)) {
          put(tx, ty, STRUCT_TREE);
          break;
        }
      }
    }
  }

  // ---- huts: hamlets of 2–4 in a loose spread. Cover where people would
  // actually live — open fields, road shoulders, bridge approaches.
  for (let h = 0; h < pc.hutHamlets; h++) {
    const center = findSpot(rng, map, legal, mayBlock, () => true);
    if (!center) continue;
    put(center.tx, center.ty, STRUCT_HUT);
    const extra = 1 + rngInt(rng, 0, 2);
    for (let e = 0; e < extra; e++) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const tx = center.tx + rngInt(rng, -2, 2);
        const ty = center.ty + rngInt(rng, -2, 2);
        if (legal(tx, ty) && !mayBlock(tx, ty)) {
          put(tx, ty, STRUCT_HUT);
          break;
        }
      }
    }
  }
}

/** Forest or water within 2 tiles — the "fringe" a tree clump prefers. */
function nearFeature(map: MapData, tx: number, ty: number): boolean {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      const i = ny * map.width + nx;
      if (map.forest[i] === 1 || map.walk[i] === 1) return true;
    }
  }
  return false;
}

function findSpot(
  rng: RngState,
  map: MapData,
  legal: (tx: number, ty: number) => boolean,
  mayBlock: (tx: number, ty: number) => boolean,
  accept: (tx: number, ty: number) => boolean,
): { tx: number; ty: number } | null {
  for (let i = 0; i < 40; i++) {
    const tx = rngInt(rng, 1, map.width - 2);
    const ty = rngInt(rng, 1, map.height - 2);
    if (!legal(tx, ty)) continue;
    if (!accept(tx, ty)) continue;
    if (mayBlock(tx, ty)) continue;
    return { tx, ty };
  }
  return null;
}

/** BFS over the walk grid minus placed props minus the candidate: true if
 *  every landmark tile is still reached. 4-connected — stricter than the
 *  bots' diagonal-capable A*, so anything we pass, they can path. */
function landmarksReachable(
  map: MapData,
  taken: ReadonlySet<number>,
  candidate: number,
  from: number,
  landmarks: readonly number[],
): boolean {
  const want = new Set(landmarks);
  want.delete(candidate); // a landmark tile can't be a candidate (excluded), belt+braces
  const seen = new Uint8Array(map.width * map.height);
  const queue: number[] = [from];
  seen[from] = 1;
  let found = want.has(from) ? 1 : 0;
  while (queue.length > 0) {
    const i = queue.pop()!;
    const tx = i % map.width;
    const ty = (i - tx) / map.width;
    for (const [dx, dy] of NEIGH4) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      const ni = ny * map.width + nx;
      if (seen[ni] === 1 || ni === candidate || taken.has(ni)) continue;
      if (map.walk[ni] === 1) continue;
      seen[ni] = 1;
      if (want.has(ni)) {
        found++;
        if (found === want.size) return true;
      }
      queue.push(ni);
    }
  }
  return found === want.size;
}

const NEIGH4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
