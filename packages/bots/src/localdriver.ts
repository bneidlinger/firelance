import { decodeServerMsg, encodeMsg } from '@shared/net/codec';
import { PROTOCOL_VERSION } from '@shared/net/messages';
import type { BotBrain } from './brain';

// Drives a BotBrain over an in-process connection (the server's LocalTransport
// clientEnd, or anything with the same shape). Fully synchronous and
// timer-free: the brain thinks in reaction to snapshots, so turbo-ticked
// matches stay deterministic.

export interface LocalConnLike {
  send(data: string): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
}

export class LocalBotDriver {
  private closed = false;

  constructor(
    private readonly conn: LocalConnLike,
    private readonly brain: BotBrain,
    private readonly name: string,
  ) {}

  start(): void {
    this.conn.onMessage((data) => {
      const decoded = decodeServerMsg(data);
      if (!decoded.ok) throw new Error(`bot ${this.name}: bad server frame: ${decoded.error}`);
      this.brain.handleServer(decoded.msg);
      if (decoded.msg.t === 'snap') {
        const input = this.brain.think(decoded.msg.tick);
        if (input && !this.closed) this.conn.send(encodeMsg(input));
      }
    });
    this.conn.onClose(() => {
      this.closed = true;
    });
    this.conn.send(encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name: this.name, bot: true }));
  }
}
