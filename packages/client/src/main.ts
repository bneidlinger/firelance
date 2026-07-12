import { configHash, getConfigPreset, getKit, secToTicks, type GameConfig } from '@shared/config';
import { getMap } from '@shared/map/maps';
import type { MapData } from '@shared/map/types';
import { applyVariant } from '@shared/map/variant';
import type { KeepSnap, NetEvent, RosterEntry, ServerMsg, YouSnap } from '@shared/net/messages';
import {
  ST_ACTIVE,
  ST_BANKING,
  ST_BLOCKING,
  ST_CARRYING,
  ST_DASHING,
  ST_ROOTED,
  ST_WINDUP,
} from '@shared/net/messages';
import {
  ATK_ACTIVE,
  ATK_WINDUP,
  BTN_BLOCK,
  BTN_FIRE,
  PHASE_ENDED,
  PHASE_LIVE,
  PHASE_PLACEMENT,
  STRUCT_GATE,
  STRUCT_TOWER,
  STRUCT_TRAP,
} from '@shared/sim/world';
import { canSeePoint } from '@shared/sim/vision';
import { audioStats, sfx, unlockAudio } from './audio/sfx';
import { FX } from './fx/config';
import { InputState } from './input/input';
import { Connection } from './net/connection';
import { Interpolation } from './net/interpolation';
import { Prediction } from './net/prediction';
import { BombLayer } from './render/bombs';
import { EntityLayer, type OwnVisual } from './render/entities';
import { FogLayer } from './render/fog';
import { FloatTextLayer } from './render/floattext';
import { FxLayer } from './render/fx';
import { GhostMemory } from './render/ghosts';
import { ParticleLayer } from './render/particles';
import { Hud, TIER_COLORS, TIER_NAMES } from './render/hud';
import { KeepLayer } from './render/keeps';
import { ProjectileLayer } from './render/projectiles';
import { SackLayer } from './render/sacks';
import { Scene, SQUAD_COLORS } from './render/scene';
import { StructureLayer } from './render/structures';
import { initSettings } from './ui/settings';
import { Overlay, showBanner } from './debug/overlay';

// Firelance client. URL params:
//   ?name=Brandon          display name
//   ?class=ranger          starting class (fighter|ranger|engineer)
//   ?server=host:port      ws server (default: same origin, or :8787 in Vite dev)
//   ?fakelag=120&jitter=30 added RTT ms + jitter — judge ALL feel with this on
//   ?nopredict             disable own-movement prediction (A/B + desync triage)
// Controls: WASD move · mouse aim · LMB fire · RMB block (fighter) ·
//           Space/Shift dash · E interact (claim site / load gold / bank) ·
//           F firebomb · B wall · G gate · T tower · V trap (Engineer) — B on a
//           damaged own structure repairs · 1/2/3 class at next respawn · F3 overlay

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
  sacks: SackLayer;
  structures: StructureLayer;
  bombs: BombLayer;
  keeps: KeepLayer;
  fx: FxLayer;
  /** Rumor pings — a second fx pool on the ABOVE-FOG layer (gossip marks
   *  places nobody can see; the fog must not swallow it). */
  pings: FxLayer;
  /** Pooled particles (M6 s1) — world matter, fog-masked like sparks. */
  particles: ParticleLayer;
  /** Rising gold text (M6 s1) — announcements, so above fog like pings. */
  floats: FloatTextLayer;
  /** Last-known enemy structures (M5) — rendered dimmed under fog. */
  ghosts: GhostMemory;
  fog: FogLayer;
  hud: Hud;
  /** FULL structure occupancy from the newest snapshot — the fog mask's
   *  blocker set (gates veil everyone). Prediction gets its own MOVE set with
   *  our gates carved out; both mirror the server's two layers exactly. */
  structOcc: ReadonlySet<number> | null;
  /** Own squad's keep site (claims/rebuilds move it; null until claimed). */
  ownKeep: { x: number; y: number } | null;
  /** Live keep intel per squad: position (claims/rebuilds move it) + public
   *  hp. Fed by welcome.keeps + keepClaimed/keepRebuilt events — the client
   *  derives nothing (placement made local derivation wrong). */
  keepInfo: Map<number, { x: number; y: number; hp: number }>;
  /** Own squad's vault detail from the last score (squad-private fields). */
  ownGold: { bk: number; g: number; wd: number; rb: number };
  ownEliminated: boolean;
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

const SQUAD_CSS = ['#f05a4d', '#5686bf', '#8fae6a', '#e0b95e'];
const SQUAD_CSS_SAFE = (squad: number): string => SQUAD_CSS[squad] ?? '#ffffff';

/** " — close by, to the north-west" style bearing for rumor news lines (no
 *  minimap: words are the wayfinding). World y grows southward. */
function bearingPhrase(dx: number, dy: number): string {
  const d = Math.hypot(dx, dy);
  if (d < 8) return ' — right where you stand';
  const dirs = [
    'east',
    'south-east',
    'south',
    'south-west',
    'west',
    'north-west',
    'north',
    'north-east',
  ];
  const idx = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
  const range = d < 22 ? 'close by, to the' : d > 55 ? 'far to the' : 'to the';
  return ` — ${range} ${dirs[idx]}`;
}

/** Keep the persistent exile/eliminated strip in sync with squad state. */
function updateExileStrip(): void {
  if (!game) return;
  if (game.ownEliminated) {
    game.hud.exile(
      `💀 ELIMINATED — spectating<div class="sub">no keep, nobody left standing</div>`,
    );
  } else if ((game.keepInfo.get(game.ownSquad)?.hp ?? 1) <= 0) {
    const rb = game.ownGold.rb;
    game.hud.exile(
      rb > 0
        ? `⚠ EXILED — no respawns` +
            `<div class="sub">rebuild: carry ${game.cfg.keep.rebuildCost}g to an empty keep site and hold E (${rb} left)</div>`
        : `⚠ EXILED — no respawns<div class="sub">no rebuilds left — survive</div>`,
    );
  } else {
    game.hud.exile(null);
  }
}

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
  cls:
    clsParam === 'fighter' || clsParam === 'ranger' || clsParam === 'engineer'
      ? clsParam
      : undefined,
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
      // Variant-applied: this match's active sites, open towns, and muster
      // corners. Rendering and prediction downstream never see the base map.
      const map = applyVariant(getMap(msg.mapId), msg.variant);
      roster.clear();
      for (const r of msg.roster) roster.set(r.id, r);
      // NOTE: `seq` deliberately does NOT reset here. The server gives every
      // welcome (join/resume/restart) a fresh input slot, and a monotonic
      // per-page counter is what makes that race-free: any of our inputs
      // still in flight when the slot resets carries a seq BELOW the next
      // one we send, so nothing we do can wedge the slot. (A welcome-time
      // reset was tried and races: one in-flight high seq lands in the fresh
      // slot first and every post-reset input reads as stale — ghost seat.)
      void setupScene(cfg, map, msg);
      break;
    }
    case 'snap':
      if (game) {
        // Feed occupancy BEFORE reconciling so replayed inputs collide with
        // the same tiles the server saw. The MOVE set excludes our own gates
        // (a door for our bodies) — the same rule the server applies, so
        // gate-walking predicts bit-exactly. Fog uses the FULL set below.
        const w = game.map.width;
        const moveOcc = new Set<number>();
        const fullOcc = new Set<number>();
        for (const s of msg.structures) {
          // Traps block nothing and occlude nothing (own traps DO arrive in
          // our snapshot — adding them here would predict a collision the
          // server never applies and snap us every time we cross our own).
          if (s.k === STRUCT_TRAP) continue;
          const ti = s.ty * w + s.tx;
          fullOcc.add(ti);
          if (!(s.k === STRUCT_GATE && s.s === game.ownSquad)) moveOcc.add(ti);
        }
        game.structOcc = fullOcc;
        game.prediction.setOccupancy(moveOcc);
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
        for (const s of msg.squads) {
          const info = game.keepInfo.get(s.id);
          if (info) {
            info.hp = s.kh;
            game.keeps.update(s.id, info.x, info.y, info.hp);
          }
          if (s.id === game.ownSquad) {
            if (s.g !== undefined) {
              game.ownGold = { bk: s.bk, g: s.g, wd: s.wd ?? 0, rb: s.rb ?? 0 };
            }
            game.ownEliminated = s.el;
          }
        }
        updateExileStrip();
        game.hud.score(msg, roster);
      }
      break;
    case 'summary':
      // The match's gold story — the end screen draws the graph from this.
      if (game) game.hud.summary(msg);
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
  // Dead with no keep: the respawn countdown would lie.
  const deadNote = game.ownEliminated
    ? 'ELIMINATED — spectating the endgame'
    : (game.keepInfo.get(game.ownSquad)?.hp ?? 1) <= 0
      ? 'no keep, no respawn — your squad must rebuild'
      : null;
  game.hud.you(you, game.lastKillerName, deadNote);
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
      if (ev.hit === undefined) {
        // The s1 exemplar: an arrow dying in terrain answers with splinters
        // and a dry panned knock — a miss whose direction you can hear.
        game.fx.arrowImpact(ev.x, ev.y);
        game.particles.emit(ev.x, ev.y, FX.emit.arrowThud);
        sfx('arrowThud', { x: ev.x, y: ev.y }, listener);
      }
      break;
    case 'swing':
      if (ev.id !== game.ownId) sfx('swing', { x: ev.x, y: ev.y }, listener);
      break;
    case 'hit': {
      game.fx.hitSpark(ev.x, ev.y, ev.blocked);
      if (ev.kind === 'arrow' && !ev.blocked) {
        game.particles.emit(ev.x, ev.y, FX.emit.arrowFlesh);
      }
      game.entities.flash(ev.victim);
      game.lastHitPos.set(ev.victim, { x: ev.x, y: ev.y });
      // Trap damage keeps quiet here — trapTriggered owns the snap sound.
      if (ev.kind !== 'trap') {
        const sound = ev.blocked ? 'block' : ev.kind === 'arrow' ? 'arrowHit' : 'meleeHit';
        sfx(sound, { x: ev.x, y: ev.y }, listener);
      }
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
        ev.droppedGold,
      );
      const pos = game.lastHitPos.get(ev.victim);
      if (pos) game.fx.death(pos.x, pos.y, SQUAD_COLORS[victim?.squad ?? 0] ?? 0xffffff);
      // Bounty made visible where it was earned. Only where we SAW the hit —
      // lastHitPos is fed by positionally-filtered events, so this can't leak
      // a kill's location through the fog.
      if (pos && ev.gold > 0) game.floats.show(pos.x, pos.y, `+${ev.gold}g`, 0xf2d68c);
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
    case 'banked': {
      const by = roster.get(ev.by);
      game.hud.bankedLine(by?.name ?? `#${ev.by}`, ev.squad, ev.amount);
      game.fx.respawnRing(ev.x, ev.y, 0xf2d68c);
      // Deposits are public news (the killfeed already says so) and towns are
      // public geography — floating the amount over fog reveals nothing new.
      game.floats.show(ev.x, ev.y, `+${ev.amount}g banked`, 0xf2d68c);
      if (ev.squad === game.ownSquad) {
        sfx('banked'); // your gold is SAFE — full-volume payoff chime
        game.hud.toast(`${ev.amount}g banked — it's safe`);
      } else {
        sfx('banked', { x: ev.x, y: ev.y }, listener);
      }
      break;
    }
    case 'rumor': {
      // Gossip: a fuzzed ring on the map (ABOVE fog — nobody "sees" this) +
      // a news line with a compass bearing, since there's no minimap to read.
      const r = game.cfg.rumors;
      const fuzz =
        ev.kind === 'richKeep'
          ? r.fuzzRadius
          : r.fuzzRadius * Math.pow(r.fuzzTierFactor, Math.max(0, ev.tier - r.bountyTier));
      game.pings.rumorPing(ev.x, ev.y, fuzz, SQUAD_COLORS[ev.squad] ?? 0xffffff, r.fadeSec * 1000);
      const names = ['Red', 'Blue', 'Green', 'Gold'];
      const dir = listener ? bearingPhrase(ev.x - listener.x, ev.y - listener.y) : '';
      const who = ev.id >= 0 ? (roster.get(ev.id)?.name ?? `#${ev.id}`) : '';
      const squadSpan = `<span style="color:${SQUAD_CSS_SAFE(ev.squad)}">`;
      if (ev.kind === 'richKeep') {
        game.hud.news(`🗣 ${squadSpan}${names[ev.squad]} keep</span>'s vault grows fat${dir}`);
        if (ev.squad === game.ownSquad) {
          game.hud.toast(`your vault's wealth is the talk of the land — bank it or defend it`);
        }
      } else {
        const tierSpan = `<span style="color:${TIER_COLORS[ev.tier] ?? '#fff'}">`;
        const what =
          ev.kind === 'carrier'
            ? `hauls a heavy purse`
            : `(${tierSpan}${TIER_NAMES[ev.tier] ?? '?'}</span>) sighted`;
        game.hud.news(`🗣 ${squadSpan}${who}</span> ${what}${dir}`);
        if (ev.id === game.ownId) {
          game.hud.toast(
            ev.kind === 'carrier'
              ? `your heavy purse draws eyes — hunters may follow`
              : `word of your deeds spreads — hunters may follow`,
          );
        }
      }
      if (ev.squad !== game.ownSquad) sfx('rumor');
      break;
    }
    case 'bombSpawn':
      game.bombs.onSpawn(ev);
      sfx('bombThrow', { x: ev.x, y: ev.y }, listener);
      break;
    case 'bombEnd':
      game.bombs.onEnd(ev.id);
      game.fx.explosion(ev.x, ev.y);
      sfx('bombBoom', { x: ev.x, y: ev.y }, listener);
      break;
    case 'keepHit': {
      const info = game.keepInfo.get(ev.squad);
      if (info) {
        info.hp = ev.hp;
        game.keeps.update(ev.squad, info.x, info.y, ev.hp);
      }
      if (ev.squad === game.ownSquad) {
        game.hud.alarm('⚠ KEEP UNDER ATTACK ⚠');
        sfx('alarm');
      }
      break;
    }
    case 'keepDestroyed': {
      const info = game.keepInfo.get(ev.squad);
      if (info) {
        info.hp = 0;
        game.keeps.update(ev.squad, info.x, info.y, 0);
      }
      game.fx.explosion(ev.x, ev.y, true);
      sfx('keepFall'); // a map event — thunder for everyone
      const names = ['Red', 'Blue', 'Green', 'Gold'];
      game.hud.news(
        `<span style="color:${SQUAD_CSS_SAFE(ev.squad)}">${names[ev.squad]} keep</span>` +
          ` <span style="color:#f05a4d">DESTROYED</span>` +
          (ev.spilled > 0 ? ` <span style="color:#f2d68c">— ${ev.spilled}g spilled!</span>` : ''),
      );
      if (ev.squad === game.ownSquad) {
        game.hud.alarm('☠ YOUR KEEP HAS FALLEN ☠');
        updateExileStrip();
      }
      break;
    }
    case 'keepClaimed': {
      game.keepInfo.set(ev.squad, { x: ev.x, y: ev.y, hp: game.cfg.keep.maxHp });
      game.keeps.update(ev.squad, ev.x, ev.y, game.cfg.keep.maxHp);
      const names = ['Red', 'Blue', 'Green', 'Gold'];
      game.hud.news(
        `<span style="color:${SQUAD_CSS_SAFE(ev.squad)}">${names[ev.squad]} squad</span> raised their banner 🏰`,
      );
      if (ev.squad === game.ownSquad) {
        game.ownKeep = { x: ev.x, y: ev.y };
        sfx('rebuilt');
        game.hud.toast(
          ev.by === game.ownId
            ? 'Keep site claimed — this is home now'
            : ev.by === null
              ? 'Keep site assigned — this is home now'
              : 'Your squad claimed a keep site',
        );
      }
      break;
    }
    case 'keepRebuilt': {
      const info = game.keepInfo.get(ev.squad);
      if (info) {
        info.x = ev.x;
        info.y = ev.y;
        game.keeps.update(
          ev.squad,
          ev.x,
          ev.y,
          game.cfg.keep.maxHp * game.cfg.keep.rebuildHpFactor,
        );
      }
      if (ev.squad === game.ownSquad) {
        game.ownKeep = { x: ev.x, y: ev.y };
        sfx('rebuilt');
        game.hud.toast('The keep stands again — respawns resume');
        updateExileStrip();
      } else {
        sfx('rebuilt', { x: ev.x, y: ev.y }, listener);
      }
      const names = ['Red', 'Blue', 'Green', 'Gold'];
      game.hud.news(
        `<span style="color:${SQUAD_CSS_SAFE(ev.squad)}">${names[ev.squad]} squad</span> rebuilt their keep 🏰`,
      );
      break;
    }
    case 'eliminated': {
      const names = ['Red', 'Blue', 'Green', 'Gold'];
      game.hud.news(
        `<span style="color:${SQUAD_CSS_SAFE(ev.squad)}">${names[ev.squad]} squad</span>` +
          ` <span style="color:#f05a4d">ELIMINATED</span> 💀`,
      );
      if (ev.squad === game.ownSquad) {
        game.ownEliminated = true;
        sfx('ownDeath');
        updateExileStrip();
      }
      break;
    }
    case 'sackTaken':
      game.fx.respawnRing(ev.x, ev.y, 0xf2d68c);
      sfx('pickup', { x: ev.x, y: ev.y }, listener);
      if (ev.by === game.ownId) game.hud.toast(`Picked up ${ev.gold}g — bank it at a town`);
      break;
    case 'structBuilt':
      game.fx.respawnRing(ev.x, ev.y, SQUAD_COLORS[ev.squad] ?? 0x8a8a80);
      break;
    case 'structDestroyed':
      game.fx.explosion(ev.x, ev.y);
      // The memory is certain now — no ghost should outlive the rubble.
      game.ghosts.forget(ev.id);
      break;
    case 'structRepaired':
      game.fx.hitSpark(ev.x, ev.y, true); // the mason's clink
      if (ev.by === game.ownId) game.hud.toast('Patched — supply spent');
      break;
    case 'trapTriggered': {
      game.fx.explosion(ev.x, ev.y);
      if (ev.victim === game.ownId) {
        sfx('trapSnap'); // it's around YOUR leg — full volume
        game.hud.alarm('⚠ SNARED ⚠');
      } else {
        sfx('trapSnap', { x: ev.x, y: ev.y }, listener);
      }
      if (ev.squad === game.ownSquad) {
        const victim = roster.get(ev.victim);
        game.hud.toast(`Your trap caught ${victim?.name ?? 'someone'}`);
      }
      break;
    }
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
    keeps: KeepSnap[];
  },
): Promise<void> {
  if (!scene) {
    scene = await Scene.create(document.getElementById('app')!);
    input.attach(document.body);
  }
  // Fresh world (first join or match restart): rebuild all mutable layers.
  scene.buildMap(map, cfg.banking.interactRadius);
  interp.clear();
  game?.entities.clear();
  game?.projectiles.clear();
  game?.sacks.clear();
  game?.structures.clear();
  game?.fx.clear();
  game?.fog.destroy();
  const hud = game?.hud ?? new Hud(cfg);
  hud.reset();

  const keepInfo = new Map<number, { x: number; y: number; hp: number }>();
  for (const k of welcome.keeps) keepInfo.set(k.squad, { x: k.x, y: k.y, hp: k.hp });

  game?.bombs.clear();
  game?.keeps.clear();
  game?.pings.clear();
  game?.particles.clear();
  game?.floats.clear();

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
    sacks: new SackLayer(scene.sackLayer),
    structures: new StructureLayer(scene.structureLayer),
    bombs: new BombLayer(scene.bombLayer, cfg.firebomb.radius),
    keeps: new KeepLayer(scene.keepLayer, cfg.keep.maxHp, cfg.banking.interactRadius),
    particles: new ParticleLayer(scene.fxLayer),
    fx: new FxLayer(scene.fxLayer),
    pings: new FxLayer(scene.pingLayer),
    floats: new FloatTextLayer(scene.pingLayer),
    ghosts: new GhostMemory(),
    fog: new FogLayer(scene.fogLayer, map, cfg),
    hud,
    structOcc: null,
    ownKeep: keepInfo.has(welcome.squadId)
      ? { x: keepInfo.get(welcome.squadId)!.x, y: keepInfo.get(welcome.squadId)!.y }
      : null,
    keepInfo,
    ownGold: { bk: 0, g: 0, wd: 0, rb: 1 },
    ownEliminated: false,
    predictedAtkCd: 0,
    localSwingStartMs: -1e9,
    lastAim: { ax: 1, ay: 0 },
    lastHitPos: new Map(),
    lastKillerName: null,
  };
  for (const [squad, info] of keepInfo) game.keeps.update(squad, info.x, info.y, info.hp);
  updateExileStrip();
  startLoop();
}

let loopStarted = false;
let seq = 0;
let lastFrame = 0;
let fps = 0;
let lastOverlay = 0;
let lastBytes = { sent: 0, recv: 0, at: 0 };

function startLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  lastFrame = performance.now();
  lastBytes.at = lastFrame;
  // Input sampling runs on its OWN clock, not the render loop: rAF throttles
  // hard in occluded/background windows (down to a few Hz), and inputs
  // freezing because the window lost focus mid-bank-run would be a disaster.
  // (Browsers still clamp background timers to ~1Hz — acceptable degradation;
  // an occluded 4fps window keeps full 30Hz input this way.)
  setInterval(
    () => {
      if (game && scene && !disconnected) sampleAndSendInput(performance.now());
    },
    1000 / (game?.tickRate ?? 30),
  );
  requestAnimationFrame(frame);
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (!game || !scene || disconnected) return;
  const dtMs = Math.min(100, now - lastFrame);
  lastFrame = now;
  fps = fps * 0.95 + (1000 / Math.max(1, dtMs)) * 0.05;

  // ---- class switch requests (any time; applies at next respawn)
  const wantCls = input.takePendingClass();
  if (wantCls) {
    conn.send({ t: 'class', cls: wantCls });
    const label =
      wantCls === 'fighter' ? 'Fighter' : wantCls === 'engineer' ? 'Engineer' : 'Ranger';
    game.hud.toast(`${label} at next respawn`);
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
    // Carry/channel states come straight from the authoritative `you` (they
    // aren't predicted — the 100ms lag on a badge is imperceptible).
    if (latestYou && latestYou.carried > 0) st |= ST_CARRYING;
    if (latestYou && latestYou.bankTicks > 0) st |= ST_BANKING;
    if (latestYou && latestYou.rootTicks > 0) st |= ST_ROOTED;
    ownVisual = {
      x: ownPos.x,
      y: ownPos.y,
      ax: game.lastAim.ax,
      ay: game.lastAim.ay,
      hp: latestYouHp,
      cls,
      st,
      g: latestYou?.carried,
    };
  }

  game.entities.sync(visible, roster, game.ownId, ownVisual);
  game.sacks.sync(interp.sacks, now);

  // ---- squad viewers, shared by the fog mask, ghost expiry, and towers
  // (M4 s3): own predicted pos + ally snapshot positions + own watchtowers.
  const viewers: Array<{ x: number; y: number }> = [];
  if (ownPos && game.prediction.alive) viewers.push(ownPos);
  for (const [id, e] of visible) {
    if (id !== game.ownId && roster.get(id)?.squad === game.ownSquad) {
      viewers.push({ x: e.x, y: e.y });
    }
  }
  for (const s of interp.structures) {
    if (s.k === STRUCT_TOWER && s.s === game.ownSquad) {
      viewers.push({ x: s.tx + 0.5, y: s.ty + 0.5 });
    }
  }

  // ---- structure ghosts (M5): remember enemy pieces the fog re-covered;
  // eyes-on an empty tile forgets them. MUST share the fog's visibility
  // (same canSeePoint, same occupancy) or ghosts contradict the mask.
  const visibleTile = (tx: number, ty: number): boolean => {
    const cx = tx + 0.5;
    const cy = ty + 0.5;
    const r2 = game!.cfg.vision.radius ** 2;
    for (const v of viewers) {
      const dx = cx - v.x;
      const dy = cy - v.y;
      if (dx * dx + dy * dy > r2) continue;
      if (canSeePoint(game!.map, game!.cfg, v.x, v.y, cx, cy, game!.structOcc)) return true;
    }
    return false;
  };
  const ghostList = game.ghosts.update(interp.structures, game.ownSquad, visibleTile);
  game.structures.sync(interp.structures, game.ownSquad, ghostList);
  if (ownPos) scene.follow(ownPos.x, ownPos.y);

  // ---- contextual banking prompt (the "how do I bank" tutorial, in place)
  updatePrompt(ownPos);

  // ---- projectiles + bombs + fx on the delayed timeline
  game.projectiles.frame(renderTick, now);
  game.bombs.frame(renderTick, now);
  game.keeps.frame(now);
  game.fx.frame(now);
  game.particles.frame(now);
  game.pings.frame(now);
  game.floats.frame(now);
  game.hud.frame(now);
  game.hud.timer(game.phase, game.phaseEndsTick, estTick);

  // ---- fog from the same squad viewers computed above.
  game.fog.update(now, viewers, game.structOcc);

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
      phase: ['placement', 'countdown', 'live', 'ended'][game.phase] ?? '?',
      snapsBuf: interp.stats.bufferedSnaps,
      starved: interp.stats.starvedFrames,
      predict: noPredict ? 'OFF (?nopredict)' : 'on',
      reconciles: p.reconciles,
      err: `${p.lastError.toFixed(4)} max ${p.maxError.toFixed(3)}`,
      snapsHard: p.snapCorrections,
      // Count + buffered seq window + last ack: healthy is a tiny count with
      // ack hugging the window; a full window ack can't reach is a dead epoch.
      pending: `${p.pendingInputs} [${p.pendingSeqLo}..${p.pendingSeqHi}] ack ${p.ackSeq}`,
      net: `up ${upKBs.toFixed(1)} down ${downKBs.toFixed(1)} KB/s`,
      players: roster.size,
    });
  }
}

let latestYouHp = 0;

/**
 * The rules, taught where they apply: loading at your keep (with the 75/25
 * reserve explained the moment it bites), the deposit channel at towns, and —
 * in exile — the rebuild ritual at empty keep sites.
 */
function updatePrompt(ownPos: { x: number; y: number } | null): void {
  if (!game || !ownPos || !latestYou?.alive) {
    game?.hud.prompt(null);
    return;
  }
  const R = game.cfg.banking.interactRadius;
  const near = (p: { x: number; y: number }): boolean =>
    Math.hypot(p.x - ownPos.x, p.y - ownPos.y) <= R + 0.6;

  // ---- placement phase: the claim tutorial, in place.
  if (game.phase === PHASE_PLACEMENT) {
    game.hud.prompt(placementPrompt(ownPos, near));
    return;
  }
  if (game.phase !== PHASE_LIVE) {
    game.hud.prompt(null);
    return;
  }
  const ownKeepAlive = (game.keepInfo.get(game.ownSquad)?.hp ?? 1) > 0;

  let html: string | null = null;

  if (!ownKeepAlive && game.ownGold.rb > 0) {
    // Exile: rebuild prompts at any unoccupied site in reach.
    const cost = game.cfg.keep.rebuildCost;
    for (const site of game.map.keeps) {
      if (!near(site)) continue;
      const occupied = [...game.keepInfo.values()].some(
        (k) => k.hp > 0 && Math.hypot(k.x - site.x, k.y - site.y) < 2,
      );
      if (occupied) continue;
      html =
        latestYou.rebuildTicks > 0
          ? `Raising the keep…` +
            `<div class="sub">stand still — damage or movement breaks the ritual</div>`
          : latestYou.carried >= cost
            ? `<span class="key">E</span> rebuild the keep here (${cost}g)` +
              `<div class="sub">stand still and hold — ${game.cfg.keep.rebuildChannelSec}s; the cost seeds the new vault</div>`
            : `Rebuild costs ${cost}g carried — you have ${latestYou.carried}g` +
              `<div class="sub">recover your spilled vault from the ruin</div>`;
      break;
    }
  }

  if (!html && ownKeepAlive && game.ownKeep && near(game.ownKeep)) {
    if (game.ownGold.wd > 0) {
      html =
        `<span class="key">E</span> load gold — ${game.ownGold.wd}g withdrawable` +
        `<div class="sub">carriers move slower · dying drops the load</div>`;
    } else if (game.ownGold.g > 0) {
      html =
        `Keep reserve locked` +
        `<div class="sub">25% of lifetime earnings stays home as raid bait — earn more to bank more</div>`;
    }
  }

  if (!html) {
    for (const t of game.map.towns) {
      if (!near(t)) continue;
      if (latestYou.carried > 0) {
        html =
          latestYou.bankTicks > 0
            ? `Banking ${latestYou.carried}g…` +
              `<div class="sub">stand still — damage or movement breaks the channel</div>`
            : `<span class="key">E</span> bank ${latestYou.carried}g` +
              `<div class="sub">stand still and hold — ${game.cfg.banking.bankChannelSec}s channel</div>`;
      }
      break;
    }
  }

  // Lowest priority: teach building where there's room and supply — but not
  // while hauling gold (a carrier's screen shouldn't nag about walls).
  if (!html && latestYou.carried === 0 && latestYou.supply >= game.cfg.build.wall.cost) {
    html =
      latestYou.cls === 'engineer'
        ? `<span class="key">B</span> wall · <span class="key">G</span> gate · <span class="key">T</span> tower · <span class="key">V</span> trap` +
          `<div class="sub">aim to place · B on a damaged wall repairs · ${Math.floor(latestYou.supply)} supply</div>`
        : `<span class="key">B</span> build a wall` +
          `<div class="sub">aim where you want it · ${Math.floor(latestYou.supply)} supply</div>`;
  }
  game.hud.prompt(html);
}

/**
 * The placement-phase prompt: teach the claim where it happens. A site is
 * "claimed" when any squad's keep marker sits on it (keepInfo is fed by the
 * global keepClaimed events, so this is authoritative).
 */
function placementPrompt(
  ownPos: { x: number; y: number },
  near: (p: { x: number; y: number }) => boolean,
): string | null {
  if (!game || !latestYou) return null;
  if (game.keepInfo.has(game.ownSquad)) {
    return `Keep claimed — the match starts when the timer ends<div class="sub">walk the ground you'll defend</div>`;
  }
  const claimed = (site: { x: number; y: number }): boolean => {
    for (const k of game!.keepInfo.values()) {
      if (Math.hypot(k.x - site.x, k.y - site.y) < 1) return true;
    }
    return false;
  };
  for (const site of game.map.keeps) {
    if (!near(site)) continue;
    if (claimed(site)) {
      return `Site taken<div class="sub">another squad raised their banner here first</div>`;
    }
    const secs = game.cfg.keep.claimChannelSec;
    return latestYou.claimTicks > 0
      ? `Claiming this site…<div class="sub">stand still and hold — first squad to finish wins it</div>`
      : `<span class="key">E</span> claim this keep site` +
          `<div class="sub">stand still and hold — ${secs}s · every site is a tradeoff</div>`;
  }
  return `Pick a keep site — walk to a ring and hold <span class="key">E</span><div class="sub">unclaimed squads get assigned when the timer ends</div>`;
}

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
    // Juice-kit probes (M6 s1): pool health + audio gate counters. A soak
    // asserts `alive` returns to ~0 and `stolen` stays sane (no leak, no spam).
    fx: game
      ? { particles: game.particles.stats(), floats: game.floats.stats(), audio: audioStats() }
      : null,
    you: latestYou
      ? {
          hp: latestYou.hp,
          alive: latestYou.alive,
          bounty: latestYou.bounty,
          cls: latestYou.cls,
          atkCd: latestYou.atkCd,
          carried: latestYou.carried,
          bankTicks: latestYou.bankTicks,
          rebuildTicks: latestYou.rebuildTicks,
          bombs: latestYou.bombs,
          bombCd: latestYou.bombCd,
          supply: latestYou.supply,
          claimTicks: latestYou.claimTicks,
          rootTicks: latestYou.rootTicks,
        }
      : null,
    banking: game
      ? {
          sacksVisible: interp.sacks.length,
          sacks: interp.sacks.map((s) => ({ x: s.x, y: s.y, g: s.g })),
          ownKeep: game.ownKeep,
          towns: game.map.towns,
          ownGold: { ...game.ownGold },
        }
      : null,
    keeps: game
      ? [...game.keepInfo.entries()].map(([squad, k]) => ({ squad, x: k.x, y: k.y, hp: k.hp }))
      : null,
    // This match's map draw (M5 variation) — the browser-verification probe
    // for "consecutive matches play differently".
    mapDraw: game
      ? { sites: game.map.keeps, towns: game.map.towns, spawns: game.map.spawns }
      : null,
    // Remembered enemy structures currently rendered as ghosts (M5 s3).
    ghostStructs: game ? game.ghosts.ids() : null,
    structures: game
      ? interp.structures.map((s) => ({
          i: s.i,
          k: s.k,
          squad: s.s,
          tx: s.tx,
          ty: s.ty,
          hp: s.hp,
          mx: s.mx,
          arming: s.ar === 1,
        }))
      : null,
    ownEliminated: game?.ownEliminated ?? false,
    disconnected,
  }),
};

initSettings();
conn.connect();
