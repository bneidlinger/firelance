import { WebSocketServer } from 'ws';
import { BotBrain } from '@bots/brain';
import { LocalBotDriver } from '@bots/localdriver';
import { getConfigPreset } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { Match } from './match';
import { RealtimeTicker } from './ticker';
import { createLocalPair } from './transport';
import { wrapWs } from './wsconn';

// Firelance authoritative server.
//   tsx packages/server/src/index.ts --port 8787 --config prototype --bots 11 --seed 1

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const port = Number(arg('port', '8787'));
const cfgName = arg('config', 'prototype');
const botCount = Number(arg('bots', '0'));
const seed = Number(arg('seed', String((Date.now() / 1000) | 0)));

const cfg = getConfigPreset(cfgName);
const map = getMap('scrim_small');
const match = new Match({ cfg, map, seed });

// In-process bots fill seats from the start (plan: any 0–12 human mix is a
// valid playtest). They speak the same protocol over LocalTransport.
for (let i = 0; i < botCount; i++) {
  const pair = createLocalPair();
  match.addConn(pair.serverEnd);
  new LocalBotDriver(pair.clientEnd, new BotBrain(seed * 1009 + i * 7919), `bot${i + 1}`).start();
}

const wss = new WebSocketServer({
  port,
  perMessageDeflate: { threshold: 512 },
});

wss.on('connection', (ws, req) => {
  // Node's ws does NOT set TCP_NODELAY; Nagle would add up to ~40ms of
  // batching latency to our small frames. Browsers already disable it
  // client-side; we must do it server-side.
  req.socket.setNoDelay(true);
  match.addConn(wrapWs(ws));
  console.log(
    `[server] connection from ${req.socket.remoteAddress} (${match.playerCount} players)`,
  );
});

const ticker = new RealtimeTicker(cfg.tick.simHz, () => match.tick());
ticker.start();

console.log(
  `[server] firelance up on ws://localhost:${port} — config=${cfg.name} seed=${seed} bots=${botCount} map=${map.id}`,
);

// Periodic health line: tick drift and memory stay observable during soaks.
const startedAt = Date.now();
setInterval(() => {
  const elapsedSec = (Date.now() - startedAt) / 1000;
  const expectedTicks = elapsedSec * cfg.tick.simHz;
  const driftPct = ((ticker.stats.ticks - expectedTicks) / expectedTicks) * 100;
  const mem = Math.round(process.memoryUsage.rss() / 1024 / 1024);
  const stats = match.getStats();
  console.log(
    `[server] up=${elapsedSec.toFixed(0)}s tick=${match.world.tick} drift=${driftPct.toFixed(2)}% ` +
      `players=${match.playerCount} rss=${mem}MB sentKB=${(stats.bytesSent / 1024).toFixed(0)}`,
  );
}, 10_000);

process.on('SIGINT', () => {
  console.log('[server] shutting down');
  ticker.stop();
  wss.close();
  process.exit(0);
});
