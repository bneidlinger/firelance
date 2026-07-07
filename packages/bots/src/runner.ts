import { DEFAULT_SKILL, type BotSkill } from './brain';
import { WsBot } from './client';

// CLI: connect N combat bots to a running server.
//   npm run bots -- --count 8 --url ws://localhost:8787 --seed 42 --skill hard

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const SKILL_PRESETS: Record<string, Partial<BotSkill>> = {
  easy: { aimErrorStd: 0.28, engageRange: 10, dashAggression: 0.2 },
  mid: {}, // DEFAULT_SKILL
  hard: { aimErrorStd: 0.07, engageRange: 13, dashAggression: 0.8 },
};

const url = arg('url', 'ws://localhost:8787');
const count = Number(arg('count', '4'));
const baseSeed = Number(arg('seed', '1000'));
const skillName = arg('skill', 'mid');
const skill = SKILL_PRESETS[skillName];
if (!skill) {
  console.error(`unknown --skill "${skillName}" (have: ${Object.keys(SKILL_PRESETS).join(', ')})`);
  process.exit(1);
}

const bots: WsBot[] = [];

async function main(): Promise<void> {
  console.log(`skill=${skillName} ${JSON.stringify({ ...DEFAULT_SKILL, ...skill })}`);
  for (let i = 0; i < count; i++) {
    const bot = new WsBot(url, `bot${i + 1}`, baseSeed + i * 7919, skill);
    bots.push(bot);
    try {
      await bot.connect();
      console.log(`bot${i + 1} connected`);
    } catch (err) {
      console.error(`bot${i + 1} failed to connect:`, err);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  console.log(`${bots.length} bots running against ${url} — Ctrl+C to stop`);
}

process.on('SIGINT', () => {
  for (const b of bots) b.close();
  process.exit(0);
});

void main();
