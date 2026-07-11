import { getConfigPreset } from '../packages/shared/src/config';
import type { SimEvent } from '../packages/shared/src/sim/events';
import { runInProcessMatch } from '../packages/server/src/harness';

// The tuning-pass instrument (M5 s5): N full-length bot matches on the real
// config, one line of pacing truth per seed. Counts stop at the FIRST
// matchEnd (the harness stops early too), so numbers describe exactly one
// match on one drawn board.
//   npx tsx scripts/tune-stats.ts --config default --map vale_full --seeds 1,2,3,4,5

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const cfg = getConfigPreset(arg('config', 'default'));
const mapId = arg('map', 'vale_full');
const seeds = arg('seeds', '1,2,3,4,5')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));

interface Row {
  seed: number;
  liveSec: number;
  byClock: boolean;
  claims: number;
  kills: number;
  deposits: number;
  banked: number[];
  destroyed: number;
  rebuilds: number;
  elims: number;
  rumors: { bounty: number; carrier: number; richKeep: number };
  traps: number;
  structs: number[];
  winners: number[];
  violations: number;
  wallMs: number;
}

async function runSeed(seed: number): Promise<Row> {
  const hz = cfg.tick.simHz;
  let ended = false;
  let liveTick = -1;
  let endTick = -1;
  const row: Row = {
    seed,
    liveSec: 0,
    byClock: false,
    claims: 0,
    kills: 0,
    deposits: 0,
    banked: new Array<number>(cfg.match.squads).fill(0),
    destroyed: 0,
    rebuilds: 0,
    elims: 0,
    rumors: { bounty: 0, carrier: 0, richKeep: 0 },
    traps: 0,
    structs: [0, 0, 0, 0],
    winners: [],
    violations: 0,
    wallMs: 0,
  };
  const tap = (_tick: number, events: SimEvent[]): void => {
    if (ended) return;
    for (const ev of events) {
      switch (ev.k) {
        case 'phase':
          if (ev.phase === 2 && liveTick < 0) liveTick = ev.tk;
          break;
        case 'keepClaimed':
          if (ev.by !== null) row.claims++;
          break;
        case 'kill':
          row.kills++;
          break;
        case 'banked':
          row.deposits++;
          row.banked[ev.squad] = (row.banked[ev.squad] ?? 0) + ev.amount;
          break;
        case 'keepDestroyed':
          row.destroyed++;
          break;
        case 'keepRebuilt':
          row.rebuilds++;
          break;
        case 'eliminated':
          row.elims++;
          break;
        case 'rumor':
          row.rumors[ev.kind]++;
          break;
        case 'trapTriggered':
          row.traps++;
          break;
        case 'structBuilt':
          row.structs[ev.kind] = (row.structs[ev.kind] ?? 0) + 1;
          break;
        case 'matchEnd':
          ended = true;
          endTick = ev.tk;
          row.winners = ev.winners;
          break;
      }
    }
  };
  const budgetSec = cfg.match.placementSec + cfg.match.countdownSec + cfg.match.durationSec + 60;
  const r = await runInProcessMatch({
    bots: cfg.match.squads * cfg.match.playersPerSquad,
    simSeconds: budgetSec,
    seed,
    cfg,
    mapId,
    onSimEvents: tap,
    stopWhen: () => ended,
  });
  row.liveSec = liveTick >= 0 && endTick >= 0 ? Math.round((endTick - liveTick) / hz) : -1;
  row.byClock = row.liveSec >= cfg.match.durationSec - 2;
  row.violations = r.violations.length;
  row.wallMs = r.wallMs;
  if (r.violations.length > 0) console.error(`seed ${seed} VIOLATIONS:`, r.violations.slice(0, 5));
  return row;
}

async function main(): Promise<void> {
  console.log(
    `[tune] config=${cfg.name} map=${mapId} duration=${cfg.match.durationSec}s seeds=[${seeds.join(',')}]`,
  );
  const rows: Row[] = [];
  for (const seed of seeds) {
    const row = await runSeed(seed);
    rows.push(row);
    const spread = [...row.banked].sort((a, b) => b - a);
    console.log(
      `seed ${String(seed).padStart(3)} | live ${String(row.liveSec).padStart(4)}s${row.byClock ? ' (clock)' : ' (early)'} | ` +
        `claims ${row.claims} | kills ${String(row.kills).padStart(3)} | deps ${String(row.deposits).padStart(2)} | ` +
        `banked [${row.banked.join(',')}] top-gap ${spread[0]! - (spread[1] ?? 0)} | ` +
        `destr ${row.destroyed} reb ${row.rebuilds} elim ${row.elims} | ` +
        `rumors b${row.rumors.bounty}/c${row.rumors.carrier}/k${row.rumors.richKeep} | ` +
        `traps ${row.traps} | structs [${row.structs.join(',')}] | ` +
        `win [${row.winners.join(',')}] | viol ${row.violations} | ${(row.wallMs / 1000).toFixed(0)}s wall`,
    );
  }
  const mean = (f: (r: Row) => number): string =>
    (rows.reduce((a, r) => a + f(r), 0) / rows.length).toFixed(1);
  console.log(
    `[tune] means: live ${mean((r) => r.liveSec)}s | kills ${mean((r) => r.kills)} | ` +
      `deps ${mean((r) => r.deposits)} | destr ${mean((r) => r.destroyed)} | ` +
      `elim ${mean((r) => r.elims)} | rumors ${mean((r) => r.rumors.bounty + r.rumors.carrier + r.rumors.richKeep)} | ` +
      `byClock ${rows.filter((r) => r.byClock).length}/${rows.length}`,
  );
}

void main();
