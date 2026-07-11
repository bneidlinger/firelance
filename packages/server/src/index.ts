import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { BotBrain } from '@bots/brain';
import { LocalBotDriver } from '@bots/localdriver';
import { getConfigPreset } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { Match } from './match';
import { RealtimeTicker } from './ticker';
import { createLocalPair } from './transport';
import { serveStatic } from './static';
import { wrapWs } from './wsconn';

// Firelance authoritative server.
//   tsx packages/server/src/index.ts --port 8787 --config prototype --bots 11 --seed 1 --map vale_full
// Serves the built client (packages/client/dist) on the same port when it
// exists — one origin for page + websocket, which is exactly what a
// `cloudflared tunnel --url http://localhost:8787` needs.

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

// --port flag > PORT env (fly.io/PaaS convention) > default.
const port = Number(arg('port', process.env.PORT ?? '8787'));
const cfgName = arg('config', 'prototype');
const botCount = Number(arg('bots', '0'));
const seed = Number(arg('seed', String((Date.now() / 1000) | 0)));
const here = dirname(fileURLToPath(import.meta.url));
const staticDir = arg('static', join(here, '../../client/dist'));

const cfg = getConfigPreset(cfgName);
// vale_full is the M4+ default; scrim_small stays the harness/CI arena.
const map = getMap(arg('map', 'vale_full'));
const match = new Match({
  cfg,
  map,
  seed,
  onRestart: (s) => console.log(`[server] match restarted (seed ${s})`),
});

// In-process bots fill seats from the start (plan: any 0–12 human mix is a
// valid playtest). They speak the same protocol over LocalTransport. Humans
// evict bots when the match is full (see Match.join); when humans leave, this
// top-up loop refills back to --bots (never past capacity, never in a
// human-full match).
let botSerial = 0;
function spawnBot(): void {
  botSerial++;
  const pair = createLocalPair();
  match.addConn(pair.serverEnd);
  new LocalBotDriver(
    pair.clientEnd,
    new BotBrain(seed * 1009 + botSerial * 7919),
    `bot${botSerial}`,
  ).start();
}
for (let i = 0; i < botCount; i++) spawnBot();
const capacity = cfg.match.squads * cfg.match.playersPerSquad;
setInterval(() => {
  while (match.botSeats < botCount && match.playerCount < capacity) spawnBot();
}, 2000);

const haveClient = existsSync(join(staticDir, 'index.html'));
const httpServer = createServer((req, res) => {
  if (haveClient) serveStatic(staticDir, req, res);
  else res.writeHead(200, { 'content-type': 'text/plain' }).end('firelance ws server');
});

const wss = new WebSocketServer({
  server: httpServer,
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

httpServer.listen(port, () => {
  console.log(
    `[server] firelance up on ws://localhost:${port} — config=${cfg.name} seed=${seed} bots=${botCount} map=${map.id}` +
      (haveClient ? ` — serving client from ${staticDir}` : ' — no client build found (ws only)'),
  );
});

const ticker = new RealtimeTicker(cfg.tick.simHz, () => match.tick());
ticker.start();

// Periodic health line: tick drift and memory stay observable during soaks.
const startedAt = Date.now();
setInterval(() => {
  const elapsedSec = (Date.now() - startedAt) / 1000;
  const expectedTicks = elapsedSec * cfg.tick.simHz;
  const driftPct = ((ticker.stats.ticks - expectedTicks) / expectedTicks) * 100;
  const mem = Math.round(process.memoryUsage.rss() / 1024 / 1024);
  const stats = match.getStats();
  console.log(
    `[server] up=${elapsedSec.toFixed(0)}s tick=${match.world.tick} phase=${match.world.phase} drift=${driftPct.toFixed(2)}% ` +
      `players=${match.playerCount} rss=${mem}MB sentKB=${(stats.bytesSent / 1024).toFixed(0)}`,
  );
}, 10_000);

process.on('SIGINT', () => {
  console.log('[server] shutting down');
  ticker.stop();
  wss.close();
  httpServer.close();
  process.exit(0);
});
