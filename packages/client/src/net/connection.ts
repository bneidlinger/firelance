import { decodeServerMsg, encodeMsg } from '@shared/net/codec';
import type { ClientMsg, ServerMsg } from '@shared/net/messages';
import { PROTOCOL_VERSION } from '@shared/net/messages';

// WebSocket connection with:
//  - clock sync (estimate the current server tick from welcome + pongs)
//  - optional fake latency/jitter injection (?fakelag=120&jitter=30, RTT ms)
//    so netcode feel is ALWAYS judged under realistic conditions.
//  - refresh survival: the welcome's resume token is stashed in
//    sessionStorage (per-tab) and offered in the next hello, so F5 reclaims
//    the SAME player — body, gold, bounty — instead of burning a seat.

const RESUME_KEY = 'fl-resume';

function readResumeToken(): string | undefined {
  try {
    return sessionStorage.getItem(RESUME_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeResumeToken(token: string): void {
  try {
    sessionStorage.setItem(RESUME_KEY, token);
  } catch {
    // Storage unavailable (private mode etc.): refreshes just join fresh.
  }
}

/** Front-door gate (M6 s4): a live resume token means this tab already has a
 *  seat — F5 must reclaim it instantly, never show a menu. */
export function hasResumeToken(): boolean {
  return readResumeToken() !== undefined;
}

export interface ConnectionOpts {
  url: string;
  name: string;
  /** Preferred class, sent in the hello (server assigns a default when absent). */
  cls?: 'fighter' | 'ranger' | 'engineer';
  /** Added round-trip latency in ms (half applied each direction). */
  fakelagMs: number;
  /** Random extra per-message delay in ms (uniform, half each direction). */
  jitterMs: number;
  onMessage: (msg: ServerMsg) => void;
  onClose: () => void;
}

export class Connection {
  private ws: WebSocket | null = null;
  private opts: ConnectionOpts;

  // Clock sync state
  private baseTick = 0;
  private baseTime = 0;
  private tickRate = 30;
  private offsetTicks = 0; // EMA-corrected drift from pongs
  rttMs = 0; // EMA
  private synced = false;

  // Bandwidth counters (for the overlay)
  bytesSent = 0;
  bytesReceived = 0;

  constructor(opts: ConnectionOpts) {
    this.opts = opts;
  }

  /** Set who we are BEFORE connect() — the front door picks name/class after
   *  construction (the hello reads opts at send time). */
  setIdentity(name: string, cls?: 'fighter' | 'ranger' | 'engineer'): void {
    this.opts.name = name;
    this.opts.cls = cls;
  }

  connect(): void {
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.sendNow({
        t: 'hello',
        v: PROTOCOL_VERSION,
        name: this.opts.name,
        cls: this.opts.cls,
        resume: readResumeToken(),
      });
      // Pings ride the same fake-latency queue as inputs so the overlay's RTT
      // reflects the simulated conditions, not a shortcut path.
      setInterval(() => this.send({ t: 'ping', ct: performance.now() }), 1000);
    };
    ws.onmessage = (e) => {
      const deliver = (): void => {
        if (typeof e.data !== 'string') return;
        this.bytesReceived += e.data.length;
        const decoded = decodeServerMsg(e.data);
        if (!decoded.ok) {
          console.error('bad server frame:', decoded.error);
          return;
        }
        this.handleClock(decoded.msg);
        this.opts.onMessage(decoded.msg);
      };
      this.delayed(deliver);
    };
    ws.onclose = () => this.opts.onClose();
  }

  /** One-way artificial delay (half the configured RTT + jitter share). */
  private delayed(fn: () => void): void {
    const base = this.opts.fakelagMs / 2;
    const jitter = (this.opts.jitterMs / 2) * Math.random();
    if (base + jitter <= 0) {
      fn();
      return;
    }
    setTimeout(fn, base + jitter);
  }

  send(msg: ClientMsg): void {
    this.delayed(() => this.sendNow(msg));
  }

  private sendNow(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const data = encodeMsg(msg);
      this.bytesSent += data.length;
      this.ws.send(data);
    }
  }

  private handleClock(msg: ServerMsg): void {
    const now = performance.now();
    if (msg.t === 'welcome') {
      this.baseTick = msg.tick;
      this.baseTime = now;
      this.tickRate = msg.tickRate;
      this.offsetTicks = 0;
      this.synced = true;
      storeResumeToken(msg.resume);
    } else if (msg.t === 'pong') {
      const rtt = now - msg.ct;
      this.rttMs = this.rttMs === 0 ? rtt : this.rttMs * 0.8 + rtt * 0.2;
      // Server was at msg.tick roughly rtt/2 ago; nudge our estimate toward that.
      const measured = msg.tick + (rtt / 2 / 1000) * this.tickRate;
      const est = this.rawEstTick(now);
      this.offsetTicks += 0.1 * (measured - est);
    }
  }

  private rawEstTick(now: number): number {
    return this.baseTick + ((now - this.baseTime) / 1000) * this.tickRate + this.offsetTicks;
  }

  /** Continuous (fractional) estimate of the server's current tick. */
  estServerTick(now: number): number {
    if (!this.synced) return 0;
    return this.rawEstTick(now);
  }
}
