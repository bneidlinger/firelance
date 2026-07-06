import { configHash, getConfigPreset, type GameConfig } from '@shared/config';
import { getMap } from '@shared/map/maps';
import type { MapData } from '@shared/map/types';
import type { RosterEntry, ServerMsg } from '@shared/net/messages';
import { InputState } from './input/input';
import { Connection } from './net/connection';
import { Interpolation } from './net/interpolation';
import { Prediction } from './net/prediction';
import { EntityLayer } from './render/entities';
import { Scene } from './render/scene';
import { Overlay, showBanner } from './debug/overlay';

// Firelance client. URL params:
//   ?name=Brandon          display name
//   ?server=host:port      ws server (default: page host, port 8787)
//   ?fakelag=120&jitter=30 added RTT ms + jitter — judge ALL feel with this on
//   ?nopredict             disable own-movement prediction (A/B + desync triage)

const params = new URLSearchParams(location.search);
const name = params.get('name') ?? `guest${Math.floor(Math.random() * 1000)}`;
const serverParam = params.get('server');
const fakelagMs = Number(params.get('fakelag') ?? '0');
const jitterMs = Number(params.get('jitter') ?? '0');
const noPredict = params.has('nopredict');

const INTERP_DELAY_TICKS = 4; // ~133ms at 30Hz

interface GameState {
  cfg: GameConfig;
  map: MapData;
  ownId: number;
  tickRate: number;
  prediction: Prediction;
  entities: EntityLayer;
}

const roster = new Map<number, RosterEntry>();
const interp = new Interpolation();
let game: GameState | null = null;
let scene: Scene | null = null;
let disconnected = false;

const input = new InputState();
const overlay = new Overlay();

const wsUrl = serverParam ? `ws://${serverParam}` : `ws://${location.hostname || 'localhost'}:8787`;

const conn = new Connection({
  url: wsUrl,
  name,
  fakelagMs,
  jitterMs,
  onMessage: handleServer,
  onClose: () => {
    disconnected = true;
    showBanner('DISCONNECTED');
  },
});

function handleServer(msg: ServerMsg): void {
  switch (msg.t) {
    case 'welcome': {
      let cfg: GameConfig;
      try {
        cfg = getConfigPreset(msg.cfgName);
      } catch {
        showBanner(`unknown config "${msg.cfgName}" — rebuild client`);
        return;
      }
      if (configHash(cfg) !== msg.cfgHash) {
        showBanner('config drift: client and server disagree — rebuild');
        return;
      }
      const map = getMap(msg.mapId);
      for (const r of msg.roster) roster.set(r.id, r);
      void setupScene(cfg, map, msg.playerId, msg.tickRate);
      break;
    }
    case 'snap':
      if (game && !noPredict) game.prediction.onSnapshot(msg.you, msg.ackSeq);
      interp.addSnapshot(msg);
      break;
    case 'ev':
      for (const ev of msg.events) {
        if (ev.k === 'playerJoined') {
          roster.set(ev.id, { id: ev.id, squad: ev.squad, name: ev.name, bot: ev.bot });
        } else if (ev.k === 'playerLeft') {
          roster.delete(ev.id);
          game?.entities.remove(ev.id);
        }
      }
      break;
    case 'error':
      showBanner(msg.reason);
      break;
    case 'pong':
      break;
  }
}

async function setupScene(
  cfg: GameConfig,
  map: MapData,
  ownId: number,
  tickRate: number,
): Promise<void> {
  if (!scene) {
    scene = await Scene.create(document.getElementById('app')!);
    input.attach(document.body);
  }
  scene.buildMap(map);
  game = {
    cfg,
    map,
    ownId,
    tickRate,
    prediction: new Prediction(cfg, map),
    entities: new EntityLayer(scene.entityLayer, cfg.player.radius),
  };
  startLoop();
}

let loopStarted = false;
let seq = 0;
let inputAccum = 0;
let lastFrame = 0;
let fps = 0;
let lastOverlay = 0;
let lastBytes = { sent: 0, recv: 0, at: 0 };

function startLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  lastFrame = performance.now();
  lastBytes.at = lastFrame;
  requestAnimationFrame(frame);
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (!game || !scene || disconnected) return;
  const dtMs = Math.min(100, now - lastFrame);
  lastFrame = now;
  fps = fps * 0.95 + (1000 / Math.max(1, dtMs)) * 0.05;

  // ---- input sampling at the sim rate
  const stepMs = 1000 / game.tickRate;
  inputAccum += dtMs;
  while (inputAccum >= stepMs) {
    inputAccum -= stepMs;
    sampleAndSendInput(now);
  }

  // ---- interpolation cursor
  const estTick = conn.estServerTick(now);
  const renderTick = estTick - INTERP_DELAY_TICKS;
  const visible = interp.sample(renderTick);
  interp.trim(renderTick);

  // ---- own position: predicted (or interpolated with ?nopredict)
  game.prediction.frame(dtMs);
  let ownPos: { x: number; y: number } | null = null;
  if (!noPredict && game.prediction.ready) {
    ownPos = game.prediction.renderPos();
  } else {
    const own = visible.get(game.ownId);
    if (own) ownPos = own;
  }

  game.entities.sync(visible, roster, game.ownId, ownPos);
  if (ownPos) scene.follow(ownPos.x, ownPos.y);

  // ---- overlay (4Hz)
  if (now - lastOverlay > 250) {
    lastOverlay = now;
    const dtSec = (now - lastBytes.at) / 1000;
    const upKBs = (conn.bytesSent - lastBytes.sent) / 1024 / dtSec;
    const downKBs = (conn.bytesReceived - lastBytes.recv) / 1024 / dtSec;
    lastBytes = { sent: conn.bytesSent, recv: conn.bytesReceived, at: now };
    const p = game.prediction.stats;
    overlay.update({
      fps: fps.toFixed(0),
      rtt: `${conn.rttMs.toFixed(0)}ms (+${fakelagMs} fake)`,
      tick: `est ${estTick.toFixed(1)} render ${renderTick.toFixed(1)}`,
      snapsBuf: interp.stats.bufferedSnaps,
      starved: interp.stats.starvedFrames,
      predict: noPredict ? 'OFF (?nopredict)' : 'on',
      reconciles: p.reconciles,
      err: `${p.lastError.toFixed(4)} max ${p.maxError.toFixed(3)}`,
      snapsHard: p.snapCorrections,
      pending: p.pendingInputs,
      net: `up ${upKBs.toFixed(1)} down ${downKBs.toFixed(1)} KB/s`,
      players: roster.size,
    });
  }
}

function sampleAndSendInput(now: number): void {
  if (!game || !scene) return;
  const move = input.sampleMove();
  const anchor =
    !noPredict && game.prediction.ready
      ? game.prediction.predicted
      : (interp.sample(conn.estServerTick(now) - INTERP_DELAY_TICKS).get(game.ownId) ?? null);
  let ax = 1;
  let ay = 0;
  if (anchor) {
    const mouse = scene.screenToWorld(input.mouseScreenX, input.mouseScreenY);
    const dx = mouse.x - anchor.x;
    const dy = mouse.y - anchor.y;
    const l = Math.sqrt(dx * dx + dy * dy);
    if (l > 1e-6) {
      ax = dx / l;
      ay = dy / l;
    }
  }
  seq++;
  const cmd = { mx: move.mx, my: move.my, ax, ay, b: move.b };
  if (!noPredict) game.prediction.applyLocalInput(seq, cmd);
  conn.send({ t: 'input', seq, tick: Math.round(conn.estServerTick(now)), ...cmd });
}

// ---- automation hooks: browser tests assert BEHAVIOR via these, not pixels.
declare global {
  interface Window {
    __fl: {
      ready(): boolean;
      ownId(): number;
      selfPos(): { x: number; y: number } | null;
      remotePos(id: number): { x: number; y: number } | null;
      playerIdByName(name: string): number | null;
      stats(): Record<string, unknown>;
    };
  }
}

window.__fl = {
  ready: () => game !== null && (noPredict || game.prediction.ready),
  ownId: () => game?.ownId ?? -1,
  selfPos: () => {
    if (!game) return null;
    if (!noPredict && game.prediction.ready) return game.prediction.renderPos();
    return (
      interp.sample(conn.estServerTick(performance.now()) - INTERP_DELAY_TICKS).get(game.ownId) ??
      null
    );
  },
  remotePos: (id: number) =>
    interp.sample(conn.estServerTick(performance.now()) - INTERP_DELAY_TICKS).get(id) ?? null,
  playerIdByName: (n: string) => {
    for (const r of roster.values()) if (r.name === n) return r.id;
    return null;
  },
  stats: () => ({
    rttMs: conn.rttMs,
    estTick: conn.estServerTick(performance.now()),
    prediction: game ? { ...game.prediction.stats } : null,
    interp: { ...interp.stats },
    roster: roster.size,
    disconnected,
  }),
};

conn.connect();
