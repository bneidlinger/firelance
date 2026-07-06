import type WebSocket from 'ws';
import type { ClientConn } from './transport';

/** Adapt a ws socket to the ClientConn interface Match consumes. */
export function wrapWs(ws: WebSocket): ClientConn {
  let messageCb: ((data: string) => void) | null = null;
  let closeCb: (() => void) | null = null;
  let closed = false;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      ws.close(1003, 'binary frames not supported');
      return;
    }
    messageCb?.(data.toString());
  });
  ws.on('close', () => {
    closed = true;
    closeCb?.();
  });
  ws.on('error', () => {
    // 'close' follows 'error'; nothing extra to do.
  });

  return {
    send(data: string): void {
      if (ws.readyState === ws.OPEN) ws.send(data);
    },
    close(): void {
      closed = true;
      ws.close();
    },
    onMessage(cb): void {
      messageCb = cb;
    },
    onClose(cb): void {
      closeCb = cb;
    },
    get closed(): boolean {
      return closed;
    },
  };
}
