import WebSocket from 'ws';
import { encodeMsg } from '@shared/net/codec';
import { PROTOCOL_VERSION } from '@shared/net/messages';

// Diagnostic: print the raw welcome + first N snapshot frames verbatim.
//   npx tsx scripts/dump-snaps.ts [count] [wsUrl]

const count = Number(process.argv[2] ?? '3');
const url = process.argv[3] ?? 'ws://localhost:8787';

const ws = new WebSocket(url);
let snaps = 0;

ws.on('open', () => {
  ws.send(encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name: 'dump', bot: true }));
  setTimeout(() => process.exit(2), 5000);
});

ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const text = data.toString();
  const wall = Date.now();
  if (text.includes('"welcome"')) console.log(`WELCOME wall=${wall}`, text);
  if (text.includes('"snap"')) {
    if (snaps % 15 === 0) {
      const snap = JSON.parse(text) as {
        tick: number;
        ents: Array<{ i: number; x: number; y: number }>;
      };
      const bot1 = snap.ents.find((e) => e.i === 1);
      console.log(
        `SNAP#${snaps} wall=${wall} tick=${snap.tick} bot1=${bot1 ? `${bot1.x},${bot1.y}` : 'n/a'} ents=${snap.ents.length}`,
      );
    }
    if (++snaps >= count) {
      ws.close();
      process.exit(0);
    }
  }
});
