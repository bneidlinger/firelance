import { runInProcessMatch } from '../packages/server/src/harness';

// CLI smoke match: in-process turbo run + determinism double-run + report.
//   npm run match:smoke -- --bots 4 --seconds 60 --seed 12345

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const bots = Number(arg('bots', '4'));
const seconds = Number(arg('seconds', '60'));
const seed = Number(arg('seed', '12345'));

async function main(): Promise<void> {
  console.log(`[smoke] running ${bots} bots for ${seconds} sim-seconds (seed ${seed})...`);
  const a = await runInProcessMatch({ bots, simSeconds: seconds, seed });
  console.log(
    `[smoke] run A: ${a.ticks} ticks in ${a.wallMs}ms wall (${Math.round(a.ticks / (a.wallMs / 1000))} ticks/s)`,
  );
  const b = await runInProcessMatch({ bots, simSeconds: seconds, seed });
  console.log(`[smoke] run B: ${b.ticks} ticks in ${b.wallMs}ms wall`);

  const violations = [...a.violations];
  if (a.finalHash !== b.finalHash) {
    violations.push(`NONDETERMINISM: run A hash ${a.finalHash} != run B hash ${b.finalHash}`);
  }

  console.log(
    JSON.stringify({ ...a, determinismCheck: a.finalHash === b.finalHash, violations }, null, 2),
  );

  if (violations.length > 0) {
    console.error(`[smoke] FAILED with ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log('[smoke] PASSED');
}

void main();
