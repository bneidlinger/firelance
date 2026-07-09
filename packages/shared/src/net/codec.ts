import type { ClientMsg, ServerMsg } from './messages';

// The ONLY (de)serialization point in the game. Every byte on the wire passes
// through these functions, so swapping JSON for msgpack/binary later is a
// two-function change.

export type DecodeResult<T> = { ok: true; msg: T } | { ok: false; error: string };

export function encodeMsg(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

const CLIENT_KINDS = new Set(['hello', 'input', 'class', 'ping']);
const SERVER_KINDS = new Set(['welcome', 'snap', 'ev', 'score', 'pong', 'error']);
const CLASS_IDS = new Set(['fighter', 'ranger']);

function parse(data: unknown): DecodeResult<Record<string, unknown>> {
  if (typeof data !== 'string') return { ok: false, error: 'non-string frame' };
  if (data.length > 65536) return { ok: false, error: 'frame too large' };
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return { ok: false, error: 'malformed JSON' };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, error: 'not an object' };
  }
  return { ok: true, msg: obj as Record<string, unknown> };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function decodeClientMsg(data: unknown): DecodeResult<ClientMsg> {
  const parsed = parse(data);
  if (!parsed.ok) return parsed;
  const m = parsed.msg;
  if (typeof m.t !== 'string' || !CLIENT_KINDS.has(m.t)) {
    return { ok: false, error: `unknown client message kind "${String(m.t)}"` };
  }
  switch (m.t) {
    case 'hello':
      if (!isFiniteNumber(m.v)) return { ok: false, error: 'hello: bad v' };
      if (typeof m.name !== 'string' || m.name.length === 0 || m.name.length > 24) {
        return { ok: false, error: 'hello: bad name' };
      }
      if (m.cls !== undefined && (typeof m.cls !== 'string' || !CLASS_IDS.has(m.cls))) {
        return { ok: false, error: 'hello: bad cls' };
      }
      if (m.resume !== undefined && (typeof m.resume !== 'string' || m.resume.length > 64)) {
        return { ok: false, error: 'hello: bad resume' };
      }
      break;
    case 'input':
      for (const f of ['seq', 'tick', 'mx', 'my', 'ax', 'ay', 'b'] as const) {
        if (!isFiniteNumber(m[f])) return { ok: false, error: `input: bad ${f}` };
      }
      break;
    case 'class':
      if (typeof m.cls !== 'string' || !CLASS_IDS.has(m.cls)) {
        return { ok: false, error: 'class: bad cls' };
      }
      break;
    case 'ping':
      if (!isFiniteNumber(m.ct)) return { ok: false, error: 'ping: bad ct' };
      break;
  }
  return { ok: true, msg: m as unknown as ClientMsg };
}

export function decodeServerMsg(data: unknown): DecodeResult<ServerMsg> {
  const parsed = parse(data);
  if (!parsed.ok) return parsed;
  const m = parsed.msg;
  if (typeof m.t !== 'string' || !SERVER_KINDS.has(m.t)) {
    return { ok: false, error: `unknown server message kind "${String(m.t)}"` };
  }
  // Server is trusted by clients; structural spot-checks only.
  switch (m.t) {
    case 'welcome':
      if (
        !isFiniteNumber(m.playerId) ||
        !isFiniteNumber(m.tick) ||
        !Array.isArray(m.roster) ||
        !Array.isArray(m.keeps)
      ) {
        return { ok: false, error: 'welcome: bad shape' };
      }
      break;
    case 'snap':
      if (
        !isFiniteNumber(m.tick) ||
        !isFiniteNumber(m.ackSeq) ||
        !Array.isArray(m.ents) ||
        !Array.isArray(m.sacks) ||
        !Array.isArray(m.structures)
      ) {
        return { ok: false, error: 'snap: bad shape' };
      }
      break;
    case 'ev':
      if (!isFiniteNumber(m.tick) || !Array.isArray(m.events)) {
        return { ok: false, error: 'ev: bad shape' };
      }
      break;
    case 'score':
      if (!isFiniteNumber(m.tick) || !Array.isArray(m.players) || !Array.isArray(m.squads)) {
        return { ok: false, error: 'score: bad shape' };
      }
      break;
    case 'pong':
      if (!isFiniteNumber(m.ct) || !isFiniteNumber(m.tick)) {
        return { ok: false, error: 'pong: bad shape' };
      }
      break;
    case 'error':
      if (typeof m.reason !== 'string') return { ok: false, error: 'error: bad shape' };
      break;
  }
  return { ok: true, msg: m as unknown as ServerMsg };
}
