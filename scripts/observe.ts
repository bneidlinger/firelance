import WebSocket from 'ws';
import { decodeServerMsg, encodeMsg } from '@shared/net/codec';
import { PROTOCOL_VERSION } from '@shared/net/messages';

// Headless "second pair of eyes": connects as a spectating client, watches a
// named player's entity through real snapshots, reports displacement and
// snapshot cadence. Used to verify that one client's inputs propagate to
// other clients (and, from M1, that fog filtering hides what it should).
//   npx tsx scripts/observe.ts <playerName> [watchMs] [wsUrl]

const targetName = process.argv[2] ?? 'LagTest';
const watchMs = Number(process.argv[3] ?? '6000');
const url = process.argv[4] ?? 'ws://localhost:8787';

const ws = new WebSocket(url);
let targetId = -1;
let first: { x: number; y: number } | null = null;
let last: { x: number; y: number } | null = null;
let snapCount = 0;
let firstSnapAt = 0;
let lastSnapAt = 0;
let firstMoveAtMs = 0;

ws.on('open', () => {
  ws.send(encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name: 'observer', bot: true }));
  setTimeout(() => {
    const report = {
      targetName,
      targetId,
      snapCount,
      avgSnapGapMs: snapCount > 1 ? Math.round((lastSnapAt - firstSnapAt) / (snapCount - 1)) : null,
      displacement:
        first && last ? Number(Math.hypot(last.x - first.x, last.y - first.y).toFixed(2)) : null,
      firstSeenMoveAtMs: firstMoveAtMs ? Math.round(firstMoveAtMs) : null,
      watchedMs: watchMs,
    };
    console.log(JSON.stringify(report));
    ws.close();
    process.exit(0);
  }, watchMs);
});

ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const d = decodeServerMsg(data.toString());
  if (!d.ok) return;
  const msg = d.msg;
  if (msg.t === 'welcome') {
    for (const r of msg.roster) if (r.name === targetName) targetId = r.id;
  } else if (msg.t === 'ev') {
    for (const ev of msg.events) {
      if (ev.k === 'playerJoined' && ev.name === targetName) targetId = ev.id;
    }
  } else if (msg.t === 'snap') {
    const now = performance.now();
    snapCount++;
    if (firstSnapAt === 0) firstSnapAt = now;
    lastSnapAt = now;
    const e = msg.ents.find((x) => x.i === targetId);
    if (process.env.OBSERVE_DEBUG && snapCount % 15 === 1) {
      console.log(
        `snap#${snapCount} target=${targetId} e=${JSON.stringify(e)} ents=${msg.ents.length}`,
      );
    }
    if (e) {
      if (!first) first = { x: e.x, y: e.y };
      if (firstMoveAtMs === 0 && Math.hypot(e.x - first.x, e.y - first.y) > 0.2) {
        firstMoveAtMs = now - firstSnapAt;
      }
      last = { x: e.x, y: e.y };
    }
  }
});
