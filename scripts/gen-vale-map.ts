import { parseMap } from '@shared/map/parse';
import { isWalkBlocked } from '@shared/map/types';
import { assignKeeps } from '@shared/sim/world';

// Generator for the vale_full ASCII map (M4 s5, doc §13.1). The committed
// artifact is the ASCII in packages/shared/src/map/maps/vale_full.ts — this
// script exists so the geometry is correct by construction. It stamps the
// terrain, then ASSERTS: every keep/town/spawn mutually reachable (flood
// fill) and greedy auto-assign = the four corner defaults, in squad order
// (a no-claims match must produce a sane spread). Tweak coordinates here,
// re-run, paste:
//   npx tsx scripts/gen-vale-map.ts > vale.txt   (map on stdout, audit on stderr)

const W = 128;
const H = 128;
const g: string[][] = Array.from({ length: H }, () => Array<string>(W).fill('.'));

const set = (x: number, y: number, c: string): void => {
  if (x >= 0 && x < W && y >= 0 && y < H) g[y]![x] = c;
};
const rect = (x0: number, y0: number, x1: number, y1: number, c: string): void => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c);
};

// ---- border
for (let x = 0; x < W; x++) {
  set(x, 0, '#');
  set(x, H - 1, '#');
}
for (let y = 0; y < H; y++) {
  set(0, y, '#');
  set(W - 1, y, '#');
}

// ---- main river: meanders across the full width, 5 tiles tall, 3 bridges.
const riverTopAt = (x: number): number => {
  if (x < 40) return 58;
  if (x < 52) return 58 + Math.floor((x - 40) / 3); // step down to 61
  if (x < 76) return 62;
  if (x < 90) return 62 - Math.floor((x - 76) / 3); // step back up
  return 57;
};
for (let x = 1; x < W - 1; x++) {
  const top = riverTopAt(x);
  for (let y = top; y < top + 5; y++) set(x, y, '~');
}
const bridge = (x0: number, x1: number): void => {
  for (let x = x0; x <= x1; x++) {
    const top = riverTopAt(x);
    for (let y = top; y < top + 5; y++) set(x, y, '=');
  }
};
bridge(22, 27); // west crossing
bridge(62, 67); // center crossing (the artery)
bridge(100, 105); // east crossing

// ---- tributary: NE vertical stream from the north edge down to the river,
// one bridge — splits the NE quadrant into two routes.
for (let y = 1; y < riverTopAt(88); y++) {
  for (let x = 86; x <= 89; x++) set(x, y, '~');
}
for (let y = 36; y <= 39; y++) for (let x = 86; x <= 89; x++) set(x, y, '=');

// ---- forests (concealed approaches; forest rule = visible only inside 4u)
rect(44, 20, 62, 34, 'f'); // north-center wood
rect(96, 44, 112, 54, 'f'); // east wood
rect(24, 78, 40, 94, 'f'); // south-west wood
rect(70, 92, 84, 106, 'f'); // south-center wood
rect(14, 40, 24, 50, 'f'); // west copse

// ---- ruins: wall clusters as midfield chokepoints/cover
rect(56, 44, 59, 47, '#'); // NW plaza ruin (flanks center-bridge north approach)
rect(70, 44, 73, 47, '#'); // NE plaza ruin
rect(46, 72, 49, 75, '#'); // SW bridgehead ruin
rect(78, 74, 81, 77, '#'); // SE bridgehead ruin
rect(32, 56, 34, 58, '#'); // west river overlook
rect(106, 24, 108, 26, '#'); // NE watch ruin

// ---- towns (3): NW, CENTER (rich + dangerous, at the artery), SE
set(34, 30, 'T');
set(64, 54, 'T');
set(96, 96, 'T');

// ---- keep sites (10)
// Corner defaults — MUST stay each squad's nearest free site:
set(20, 20, 'K'); // squad 1 default
set(107, 20, 'K'); // squad 2 default
set(20, 107, 'K'); // squad 3 default
set(107, 107, 'K'); // squad 4 default
// Contested picks (each farther from EVERY spawn than that squad's default):
set(44, 52, 'K'); // west bridge-control
set(84, 70, 'K'); // east bridge-control (south bank)
set(38, 34, 'K'); // NW town-adjacent (easy banking, easy to find)
set(90, 88, 'K'); // SE town-adjacent
set(52, 36, 'K'); // forest-edge north (concealed)
set(60, 100, 'K'); // south-center field

// ---- spawns
set(14, 14, '1');
set(113, 14, '2');
set(14, 113, '3');
set(113, 113, '4');

const ascii = g.map((row) => row.join('')).join('\n');

// ---- verify: parse, connectivity, greedy assignment
const map = parseMap('vale_full', `\n${ascii}\n`);
const landmarks: Array<[number, number, string]> = [];
for (const k of map.keeps) landmarks.push([Math.floor(k.x), Math.floor(k.y), 'keep']);
for (const t of map.towns) landmarks.push([Math.floor(t.x), Math.floor(t.y), 'town']);
for (const s of map.spawns) landmarks.push([Math.floor(s.x), Math.floor(s.y), 'spawn']);

const seen = new Uint8Array(W * H);
const s0 = map.spawns[0]!;
const q: number[] = [Math.floor(s0.y) * W + Math.floor(s0.x)];
seen[q[0]!] = 1;
while (q.length) {
  const i = q.pop()!;
  const x = i % W;
  const y = (i - x) / W;
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const ni = ny * W + nx;
    if (seen[ni] || isWalkBlocked(map, nx, ny)) continue;
    seen[ni] = 1;
    q.push(ni);
  }
}
const unreachable = landmarks.filter(([x, y]) => !seen[y * W + x]);
if (unreachable.length) {
  console.error('UNREACHABLE landmarks:', unreachable);
  process.exit(1);
}

const assigned = assignKeeps(map, 4);
const expect: Array<[number, number]> = [
  [20.5, 20.5],
  [107.5, 20.5],
  [20.5, 107.5],
  [107.5, 107.5],
];
for (let i = 0; i < 4; i++) {
  const a = assigned[i]!;
  if (Math.abs(a.x - expect[i]![0]) > 0.01 || Math.abs(a.y - expect[i]![1]) > 0.01) {
    console.error(`auto-assign drift: squad ${i} got (${a.x},${a.y}) want (${expect[i]})`);
    process.exit(1);
  }
}

console.error(
  `OK: ${map.keeps.length} keeps, ${map.towns.length} towns, ${map.spawns.length} spawns, all reachable, greedy = corner defaults`,
);
console.log(ascii);
