import { configHash, getConfigPreset, getKit, secToTicks, type GameConfig } from '@shared/config';
import { getMap } from '@shared/map/maps';
import type { MapData } from '@shared/map/types';
import type { NetEvent, RosterEntry, ServerMsg, YouSnap } from '@shared/net/messages';
import { ST_ACTIVE, ST_BLOCKING, ST_DASHING, ST_WINDUP } from '@shared/net/messages';
import {
  ATK_ACTIVE,
  ATK_WINDUP,
  BTN_BLOCK,
  BTN_FIRE,
  PHASE_COUNTDOWN,
  PHASE_ENDED,
  PHASE_LIVE,
} from '@shared/sim/world';
import { sfx, unlockAudio } from './audio/sfx';
import { InputState } from './input/input';
import { Connection } from './net/connection';
import { Interpolation } from './net/interpolation';
import { Prediction } from './net/prediction';
import { EntityLayer, type OwnVisual } from './render/entities';
import { FogLayer } from './render/fog';
import { FxLayer } from './render/fx';
import { Hud } from './render/hud';
import { ProjectileLayer } from './render/projectiles';
import { Scene, SQUAD_COLORS } from './render/scene';
import { Overlay, showBanner } from './debug/overlay';

// Firelance client. URL params:
//   ?name=Brandon          display name
//   ?class=ranger          starting class (fighter|ranger)
//   ?server=host:port      ws server (default: same origin, or :8787 in Vite dev)
//   ?fakelag=120&jitter=30 added RTT ms + jitter — judge ALL feel with this on
//   ?nopredict             disable own-movement prediction (A/B + desync triage)
// Controls: WASD move · mouse aim · LMB fire · RMB block (fighter) ·
//           Space/Shift dash · 1/2 class at next respawn · F3 net overlay

const params = new URLSearchParams(location.search);
const name = params.get('name') ?? `guest${Math.floor(Math.random() * 1000)}`;
const clsParam = params.get('class');
const serverParam = params.get('server');
const fakelagMs = Number(params.get('fakelag') ?? '0');
const jitterMs = Number(params.get('jitter') ?? '0');
const noPredict = params.has('nopredict');

const INTERP_DELAY_TICKS = 4; // ~133ms at 30Hz

interface GameState {
  cfg: GameConfig;
  map: MapData;
  ownId: number;
  ownSquad: number;
  tickRate: number;
  phase: number;
  phaseEndsTick: number;
  prediction: Prediction;
  entities: EntityLayer;
  projectiles: ProjectileLayer;
  fx: FxLayer;
  fog: FogLayer;
  hud: Hud;
  /** Local fire-gating mirror (muzzle prediction). */
  predictedAtkCd: number;
  localSwingStartMs: number;
  lastAim: { ax: number; ay: number };
  lastKillerName: string | null;
  lastHitPos: Map<number, { x: number; y: number }>;
}

const roster = new Map<number, RosterEntry>();
const interp = new Interpolation();
let game: GameState | null = null;
let scene: Scene | null = null;
let disconnected = false;

const input = new InputState();
const overlay = new Overlay();

// Same-origin by default (server serves the built client + ws on one port);
// Vite dev runs on 5173 and talks to the game server on 8787.
const isViteDev = location.port === '5173';
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = serverParam
  ? `ws://${serverParam}`
  : isViteDev || !location.host
    ? `ws://${location.hostname || 'localhost'}:8787`
    : `${wsProto}://${location.host}`;

const conn = new Connection({
  url: wsUrl,
  name,
  cls: clsParam === 'fighter' || clsParam === 'ranger' ? clsParam : undefined,
  fakelagMs,
  jitterMs,
  onMessage: handleServer,
  onClose: () => {
    disconnected = true;
    showBanner('DISCONNECTED');
  },
});

window.addEventListener('pointerdown', unlockAudio, { once: true });
window.addEventListener('keydown', unlockAudio, { once: true });

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
      roster.clear();
      for (const r of msg.roster) roster.set(r.id, r);
      void setupScene(cfg, map, msg);
      break;
    }
    case 'snap':
      if (game) {
        game.prediction.onSnapshot(msg.you, msg.ackSeq);
        onYou(msg.you);
      }
      interp.addSnapshot(msg);
      break;
    case 'ev':
      for (const ev of msg.events) handleEvent(ev);
      break;
    case 'score':
      if (game) {
        game.phase = msg.phase;
        game.phaseEndsTick = msg.phaseEndsTick;
        game.hud.score(msg, roster);
      }
      break;
    case 'error':
      showBanner(msg.reason);
      break;
    case 'pong':
      break;
  }
}

let latestYou: YouSnap | null = null;

function onYou(you: YouSnap): void {
  if (!game) return;
  latestYou = you;
  latestYouHp = you.hp;
  // Fire-gate mirror: adopt the (slightly stale) server cooldown unless our
  // local prediction is already stricter — never re-arm early.
  if (you.atkPhase === 0) {
    game.predictedAtkCd = Math.max(game.predictedAtkCd, you.atkCd);
  }
  game.hud.you(you, game.lastKillerName);
}

function handleEvent(ev: NetEvent): void {
  if (!game) {
    if (ev.k === 'playerJoined') {
      roster.set(ev.id, { id: ev.id, squad: ev.squad, name: ev.name, bot: ev.bot });
    }
    return;
  }
  const listener = game.prediction.ready ? game.prediction.renderPos() : undefined;
  switch (ev.k) {
    case 'playerJoined':
      roster.set(ev.id, { id: ev.id, squad: ev.squad, name: ev.name, bot: ev.bot });
      break;
    case 'playerLeft':
      roster.delete(ev.id);
      game.entities.remove(ev.id);
      break;
    case 'projSpawn':
      game.projectiles.onSpawn(ev, game.ownId);
      if (ev.owner !== game.ownId) sfx('shoot', { x: ev.x, y: ev.y }, listener);
      break;
    case 'projEnd':
      game.projectiles.onEnd(ev);
      if (ev.hit === undefined) game.fx.arrowImpact(ev.x, ev.y);
      break;
    case 'swing':
      if (ev.id !== game.ownId) sfx('swing', { x: ev.x, y: ev.y }, listener);
      break;
    case 'hit': {
      game.fx.hitSpark(ev.x, ev.y, ev.blocked);
      game.entities.flash(ev.victim);
      game.lastHitPos.set(ev.victim, { x: ev.x, y: ev.y });
      const sound = ev.blocked ? 'block' : ev.kind === 'arrow' ? 'arrowHit' : 'meleeHit';
      sfx(sound, { x: ev.x, y: ev.y }, listener);
      if (ev.victim === game.ownId) game.hud.vignette();
      break;
    }
    case 'kill': {
      const killer = ev.killer !== null ? roster.get(ev.killer) : undefined;
      const victim = roster.get(ev.victim);
      game.hud.killLine(
        killer?.name ?? null,
        victim?.name ?? `#${ev.victim}`,
        killer?.squad ?? null,
        victim?.squad ?? 0,
        ev.gold,
        ev.victimBounty,
      );
      const pos = game.lastHitPos.get(ev.victim);
      if (pos) game.fx.death(pos.x, pos.y, SQUAD_COLORS[victim?.squad ?? 0] ?? 0xffffff);
      if (ev.victim === game.ownId) {
        game.lastKillerName = killer?.name ?? null;
        sfx('ownDeath');
      } else {
        sfx('death', pos, listener);
      }
      if (killer && killer.squad === game.ownSquad && ev.gold > 0) sfx('coin');
      break;
    }
    case 'respawn':
      game.fx.respawnRing(ev.x, ev.y, SQUAD_COLORS[ev.squad] ?? 0xffffff);
      if (ev.id === game.ownId) {
        game.lastKillerName = null;
        sfx('respawn');
      }
      break;
    case 'phase':
      game.phase = ev.phase;
      game.phaseEndsTick = ev.endsTick;
      if (ev.phase === PHASE_LIVE) {
        game.hud.hideEndScreen();
        sfx('live');
      }
      break;
    case 'matchEnd':
      game.phase = PHASE_ENDED;
      game.hud.endScreen(ev.winners, ev.standings, roster, game.ownSquad);
      sfx('matchEnd');
      break;
  }
}

async function setupScene(
  cfg: GameConfig,
  map: MapData,
  welcome: {
    playerId: number;
    squadId: number;
    tickRate: number;
    phase: number;
    phaseEndsTick: number;
  },
): Promise<void> {
  if (!scene) {
    scene = await Scene.create(document.getElementById('app')!);
    input.attach(document.body);
  }
  // Fresh world (first join or match restart): rebuild all mutable layers.
  scene.buildMap(map);
  interp.clear();
  game?.entities.clear();
  game?.projectiles.clear();
  game?.fx.clear();
  game?.fog.destroy();
  const hud = game?.hud ?? new Hud(cfg);
  hud.reset();

  game = {
    cfg,
    map,
    ownId: welcome.playerId,
    ownSquad: welcome.squadId,
    tickRate: welcome.tickRate,
    phase: welcome.phase,
    phaseEndsTick: welcome.phaseEndsTick,
    prediction: new Prediction(cfg, map),
    entities: new EntityLayer(scene.entityLayer, cfg),
    projectiles: new ProjectileLayer(scene.projectileLayer, welcome.tickRate),
    fx: new FxLayer(scene.fxLayer),
    fog: new FogLayer(scene.fogLayer, map, cfg),
    hud,
    predictedAtkCd: 0,
    localSwingStartMs: -1e9,
    lastAim: { ax: 1, ay: 0 },
    lastKillerName: null,
    lastHitPos: new Map(),
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

  // ---- class switch requests (any time; applies at next respawn)
  const wantCls = input.takePendingClass();
  if (wantCls) {
    conn.send({ t: 'class', cls: wantCls });
    game.hud.toast(`${wantCls === 'fighter' ? 'Fighter' : 'Ranger'} at next respawn`);
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

  // ---- own visual state (instant-feel: local aim + local swing telegraph)
  let ownVisual: OwnVisual | null = null;
  if (ownPos && game.prediction.ready && game.prediction.alive) {
    const cls = game.prediction.classId;
    const kit = getKit(game.cfg, cls);
    let st = 0;
    const p = game.prediction.predicted;
    if (p.dashTicks > 0) st |= ST_DASHING;
    if (kit.shield && (p.prevB & BTN_BLOCK) !== 0 && p.dashTicks <= 0) st |= ST_BLOCKING;
    if (kit.melee) {
      const age = now - game.localSwingStartMs;
      const windupMs = kit.melee.windupSec * 1000;
      const activeMs = kit.melee.activeSec * 1000;
      if (age < windupMs) st |= ST_WINDUP;
      else if (age < windupMs + activeMs) st |= ST_ACTIVE;
    }
    ownVisual = {
      x: ownPos.x,
      y: ownPos.y,
      ax: game.lastAim.ax,
      ay: game.lastAim.ay,
      hp: latestYouHp,
      cls,
      st,
    };
  }

  game.entities.sync(visible, roster, game.ownId, ownVisual);
  if (ownPos) scene.follow(ownPos.x, ownPos.y);

  // ---- projectiles + fx on the delayed timeline
  game.projectiles.frame(renderTick, now);
  game.fx.frame(now);
  game.hud.frame(now);
  game.hud.timer(game.phase, game.phaseEndsTick, estTick);

  // ---- fog from own squad's living viewers (same function as the server)
  const viewers: Array<{ x: number; y: number }> = [];
  if (ownPos && game.prediction.alive) viewers.push(ownPos);
  for (const [id, e] of visible) {
    if (id !== game.ownId && roster.get(id)?.squad === game.ownSquad) {
      viewers.push({ x: e.x, y: e.y });
    }
  }
  game.fog.update(now, viewers);

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
      phase: ['countdown', 'live', 'ended'][game.phase] ?? '?',
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

let latestYouHp = 0;

function sampleAndSendInput(now: number): void {
  if (!game || !scene) return;
  const move = input.sampleMove();
  const anchor =
    !noPredict && game.prediction.ready
      ? game.prediction.predicted
      : (interp.sample(conn.estServerTick(now) - INTERP_DELAY_TICKS).get(game.ownId) ?? null);
  let ax = game.lastAim.ax;
  let ay = game.lastAim.ay;
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
  game.lastAim = { ax, ay };

  // ---- own-muzzle prediction + local swing telegraph + fire gating mirror
  if (game.predictedAtkCd > 0) game.predictedAtkCd--;
  const alive = game.prediction.ready && game.prediction.alive;
  const cls = game.prediction.classId;
  const kit = getKit(game.cfg, cls);
  const pState = game.prediction.predicted;
  const blocking = kit.shield !== undefined && (move.b & BTN_BLOCK) !== 0 && pState.dashTicks <= 0;
  if (
    (move.b & BTN_FIRE) !== 0 &&
    alive &&
    game.phase === PHASE_LIVE &&
    game.predictedAtkCd <= 0 &&
    pState.dashTicks <= 0 &&
    !blocking &&
    !noPredict
  ) {
    if (kit.bow) {
      const off = game.cfg.player.radius + kit.bow.radius + 0.05;
      game.projectiles.spawnGhost(
        pState.x + ax * off,
        pState.y + ay * off,
        ax,
        ay,
        kit.bow.speed,
        kit.bow.ttlSec,
      );
      game.predictedAtkCd = secToTicks(game.cfg, kit.bow.cooldownSec);
      sfx('shoot');
    } else if (kit.melee) {
      game.localSwingStartMs = now;
      game.predictedAtkCd =
        secToTicks(game.cfg, kit.melee.windupSec) +
        secToTicks(game.cfg, kit.melee.activeSec) +
        secToTicks(game.cfg, kit.melee.recoverySec) +
        secToTicks(game.cfg, kit.melee.cooldownSec);
      sfx('swing');
    }
  }
  if ((move.b & 4) !== 0 && alive && pState.dashCd <= 0 && pState.dashTicks <= 0) {
    sfx('dash');
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
      visibleIds(): number[];
      phase(): number;
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
  remotePos: (id: number) => {
    const e = interp.sample(conn.estServerTick(performance.now()) - INTERP_DELAY_TICKS).get(id);
    return e ? { x: e.x, y: e.y } : null;
  },
  playerIdByName: (n: string) => {
    for (const r of roster.values()) if (r.name === n) return r.id;
    return null;
  },
  visibleIds: () => [
    ...interp.sample(conn.estServerTick(performance.now()) - INTERP_DELAY_TICKS).keys(),
  ],
  phase: () => game?.phase ?? -1,
  stats: () => ({
    rttMs: conn.rttMs,
    estTick: conn.estServerTick(performance.now()),
    prediction: game ? { ...game.prediction.stats } : null,
    interp: { ...interp.stats },
    roster: roster.size,
    phase: game?.phase,
    projectiles: game?.projectiles.counts() ?? null,
    you: latestYou
      ? {
          hp: latestYou.hp,
          alive: latestYou.alive,
          bounty: latestYou.bounty,
          cls: latestYou.cls,
          atkCd: latestYou.atkCd,
        }
      : null,
    disconnected,
  }),
};

conn.connect();
