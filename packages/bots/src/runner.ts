import { WsBot } from './client';

// CLI: connect N roaming bots to a running server.
//   npm run bots -- --count 8 --url ws://localhost:8787 --seed 42

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const url = arg('url', 'ws://localhost:8787');
const count = Number(arg('count', '4'));
const baseSeed = Number(arg('seed', '1000'));

const bots: WsBot[] = [];

async function main(): Promise<void> {
  for (let i = 0; i < count; i++) {
    const bot = new WsBot(url, `bot${i + 1}`, baseSeed + i * 7919);
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
