// Server-side view of one connected client. WsConn (see wsconn.ts) adapts a
// real WebSocket; LocalTransport wires an in-process pair for bots living
// inside the server process and for tests — synchronous delivery, so turbo
// matches stay deterministic.

export interface ClientConn {
  send(data: string): void;
  close(): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  /** True once close() was called or the underlying socket dropped. */
  readonly closed: boolean;
}

class LocalEnd implements ClientConn {
  peer!: LocalEnd;
  closed = false;
  private messageCb: ((data: string) => void) | null = null;
  private closeCb: (() => void) | null = null;

  send(data: string): void {
    if (this.closed || this.peer.closed) return;
    // Synchronous delivery: deterministic ordering under the turbo ticker.
    this.peer.messageCb?.(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCb?.();
    if (!this.peer.closed) {
      this.peer.closed = true;
      this.peer.closeCb?.();
    }
  }

  onMessage(cb: (data: string) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
}

export interface LocalPair {
  /** Hand this end to Match.addConn(). */
  serverEnd: ClientConn;
  /** Hand this end to an in-process bot driver or test client. */
  clientEnd: ClientConn;
}

export function createLocalPair(): LocalPair {
  const a = new LocalEnd();
  const b = new LocalEnd();
  a.peer = b;
  b.peer = a;
  return { serverEnd: a, clientEnd: b };
}
