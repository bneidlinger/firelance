import WebSocket from 'ws';
import { decodeServerMsg, encodeMsg } from '@shared/net/codec';
import { PROTOCOL_VERSION } from '@shared/net/messages';
import { BotBrain, type BotSkill } from './brain';

// A bot over a real WebSocket — exercises the true network path (codec,
// deflate, backpressure) exactly like a human client does.

export class WsBot {
  private ws: WebSocket | null = null;
  readonly brain: BotBrain;

  constructor(
    private readonly url: string,
    private readonly name: string,
    seed: number,
    skill: Partial<BotSkill> = {},
  ) {
    this.brain = new BotBrain(seed, skill);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on('open', () => {
        ws.send(encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name: this.name, bot: true }));
        resolve();
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const decoded = decodeServerMsg(data.toString());
        if (!decoded.ok) {
          console.error(`[${this.name}] bad server frame: ${decoded.error}`);
          return;
        }
        this.brain.handleServer(decoded.msg);
        if (decoded.msg.t === 'snap') {
          const input = this.brain.think(decoded.msg.tick);
          if (input && ws.readyState === WebSocket.OPEN) ws.send(encodeMsg(input));
        }
      });
      ws.on('error', (err) => reject(err));
      ws.on('close', () => {
        this.ws = null;
      });
    });
  }

  close(): void {
    this.ws?.close();
  }
}
