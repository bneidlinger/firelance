import type { MapData } from './types';

// ASCII map legend:
//   #  wall        blocks walk + vision
//   ~  water       blocks walk only
//   f  forest      walkable, flagged for the forest vision rule
//   .  open ground
//   =  bridge/road walkable (visually distinct road over water)
//   K  keep site   walkable POI
//   T  town/bank   walkable POI
//   1-4 squad spawn points, walkable
const WALK_BLOCKERS = new Set(['#', '~']);
const VISION_BLOCKERS = new Set(['#']);
const KNOWN = new Set(['#', '~', 'f', '.', '=', 'K', 'T', '1', '2', '3', '4']);

export function parseMap(id: string, ascii: string): MapData {
  const lines = ascii
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error(`map ${id}: empty`);

  const height = lines.length;
  const width = lines[0]!.length;
  const walk = new Uint8Array(width * height);
  const vision = new Uint8Array(width * height);
  const forest = new Uint8Array(width * height);
  const keeps: MapData['keeps'] = [];
  const towns: MapData['towns'] = [];
  const spawnsByDigit = new Map<number, { x: number; y: number }>();

  for (let y = 0; y < height; y++) {
    const line = lines[y]!;
    if (line.length !== width) {
      throw new Error(`map ${id}: row ${y} has length ${line.length}, expected ${width}`);
    }
    for (let x = 0; x < width; x++) {
      const ch = line[x]!;
      if (!KNOWN.has(ch)) throw new Error(`map ${id}: unknown tile "${ch}" at ${x},${y}`);
      const i = y * width + x;
      if (WALK_BLOCKERS.has(ch)) walk[i] = 1;
      if (VISION_BLOCKERS.has(ch)) vision[i] = 1;
      if (ch === 'f') forest[i] = 1;
      const center = { x: x + 0.5, y: y + 0.5 };
      if (ch === 'K') keeps.push(center);
      if (ch === 'T') towns.push(center);
      if (ch >= '1' && ch <= '4') spawnsByDigit.set(Number(ch), center);
    }
  }

  const spawns: MapData['spawns'] = [];
  for (let d = 1; d <= 4; d++) {
    const s = spawnsByDigit.get(d);
    if (!s) throw new Error(`map ${id}: missing spawn point "${d}"`);
    spawns.push(s);
  }
  if (keeps.length < 2)
    throw new Error(`map ${id}: needs at least 2 keep sites, found ${keeps.length}`);
  if (towns.length < 1) throw new Error(`map ${id}: needs at least 1 town, found ${towns.length}`);

  return { id, width, height, walk, vision, forest, keeps, towns, spawns };
}
