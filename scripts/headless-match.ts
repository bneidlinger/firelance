import { WebSocketServer } from 'ws';
import { WsBot } from '../packages/bots/src/client';
import { getConfigPreset } from '../packages/shared/src/config';
import { getMap } from '../packages/shared/src/map/maps';
import { Match } from '../packages/server/src/match';
import { RealtimeTicker } from '../packages/server/src/ticker';
import { wrapWs } from '../packages/server/src/wsconn';

// Headless match over REAL WebSockets on localhost: validates the true network
// path (ws framing, deflate, backpressure) that LocalTransport bypasses.
//   npm run match:headless -- --bots 12 --seconds 20

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const botCount = Number(arg('bots', '12'));
const seconds = Number(arg('seconds', '20'));
const port = Number(arg('port', '8790'));

async function main(): Promise<void> {
  const cfg = getConfigPreset('smoke');
  const map = getMap('scrim_small');
  const match = new Match({ cfg, map, seed: 42 });

  const wss = new WebSocketServer({ port, perMessageDeflate: { threshold: 512 } });
  wss.on('connection', (ws, req) => {
    req.socket.setNoDelay(true);
    match.addConn(wrapWs(ws));
  });

  const tickTimes: number[] = [];
  const ticker = new RealtimeTicker(cfg.tick.simHz, () => {
    const t0 = performance.now();
    match.tick();
    tickTimes.push(performance.now() - t0);
  });
  ticker.start();

  const bots: WsBot[] = [];
  for (let i = 0; i < botCount; i++) {
    const bot = new WsBot(`ws://localhost:${port}`, `wsbot${i + 1}`, 5000 + i * 7919);
    bots.push(bot);
    await bot.connect();
  }
  console.log(`[headless] ${botCount} ws bots connected, running ${seconds}s realtime...`);

  await new Promise((r) => setTimeout(r, seconds * 1000));

  ticker.stop();
  for (const b of bots) b.close();
  wss.close();

  tickTimes.sort((x, y) => x - y);
  const p50 = tickTimes[Math.floor(tickTimes.length * 0.5)] ?? 0;
  const p99 = tickTimes[Math.floor(tickTimes.length * 0.99)] ?? 0;
  const stats = match.getStats();
  const report = {
    players: match.playerCount,
    ticks: match.world.tick,
    expectedTicks: seconds * cfg.tick.simHz,
    tickMsP50: Math.round(p50 * 1000) / 1000,
    tickMsP99: Math.round(p99 * 1000) / 1000,
    snapshotsSent: stats.snapshotsSent,
    kbSent: Math.round(stats.bytesSent / 1024),
    kbPerClientPerSec: Math.round(stats.bytesSent / 1024 / botCount / seconds),
    droppedMs: ticker.stats.droppedMs,
  };
  console.log(JSON.stringify(report, null, 2));

  const ok =
    match.playerCount === botCount &&
    stats.snapshotsSent > 0 &&
    p99 < 5 &&
    match.world.tick >= seconds * cfg.tick.simHz * 0.9;
  console.log(ok ? '[headless] PASSED' : '[headless] FAILED');
  process.exit(ok ? 0 : 1);
}

void main();
