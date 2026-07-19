import { configHash, getConfigPreset, getKit, secToTicks, type GameConfig } from '@shared/config';
import { bountyTier } from '@shared/sim/systems/economy';
import { getMap } from '@shared/map/maps';
import type { MapData } from '@shared/map/types';
import { applyVariant } from '@shared/map/variant';
import type { KeepSnap, NetEvent, RosterEntry, ServerMsg, YouSnap } from '@shared/net/messages';
import type { RichEnt } from './net/interpolation';
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
  STRUCT_HUT,
  STRUCT_TOWER,
  STRUCT_TRAP,
  STRUCT_TREE,
} from '@shared/sim/world';
import { canSeePoint } from '@shared/sim/vision';
import { audioStats, sfx, unlockAudio } from './audio/sfx';
import { FX } from './fx/config';
import { InputState } from './input/input';
import { Connection, hasResumeToken } from './net/connection';
import { Interpolation } from './net/interpolation';
import { Prediction } from './net/prediction';
import { BombLayer } from './render/bombs';
import { EntityLayer, type OwnVisual } from './render/entities';
import { FogLayer } from './render/fog';
import { FloatTextLayer } from './render/floattext';
import { FxLayer } from './render/fx';
import { GhostMemory } from './render/ghosts';
import { ParticleLayer } from './render/particles';
import { Hud, TIER_NAMES } from './render/hud';
import { KeepLayer } from './render/keeps';
import { ProjectileLayer } from './render/projectiles';
import { SackLayer } from './render/sacks';
import { ARMORY, PROPS, SQUAD_COLORS, SQUAD_CSS, TIER_CSS } from './render/palette';
import { Scene } from './render/scene';
import { StructureLayer } from './render/structures';
import { initFrontDoor } from './ui/frontdoor';
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
  /** Ground stains (M6 s2) — bomb scorch on its own under-structures layer. */
  decals: FxLayer;
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
  /** Public bounty per player (score msg ~2Hz; own entry from every snap) —
   *  feeds the overhead writ-tags. Bounty is open information by design. */
  bounties: Map<number, number>;
  /** Own squad's vault detail from the last score (squad-private fields). */
  ownGold: { bk: number; g: number; wd: number; rb: number };
  ownEliminated: boolean;
  /** Local fire-gating mirror (muzzle prediction). */
  predictedAtkCd: number;
  localSwingStartMs: number;
  lastAim: { ax: number; ay: number };
  lastKillerName: string | null;
  lastHitPos: Map<number, { x: number; y: number }>;
  /** Own-keep alarm pointer deadline (M6 s3); set by own-squad keepHit. */
  alarmUntilMs: number;
  /** Last seen own bounty tier; -1 = unseeded (no ceremony on first read). */
  lastOwnTier: number;
  /** Deposit channel quarter last ticked (-1 = idle); drives rising plucks. */
  lastBankQuarter: number;
  /** Water tile centers (M6 s4) — the shimmer emitter samples these. */
  waterTiles: Array<{ x: number; y: number }>;
  /** Chimney anchors of visible living huts (G3) — the smoke emitter's list. */
  visibleHuts: Array<{ x: number; y: number }>;
}

const roster = new Map<number, RosterEntry>();
const interp = new Interpolation();
let game: GameState | null = null;
let scene: Scene | null = null;
let disconnected = false;

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
        for (const p of msg.players) game.bounties.set(p.id, p.b);
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
  // Own writ-tag tracks the snapshot, not the 2Hz score — it moves the same
  // frame the tier-up ceremony does.
  game.bounties.set(game.ownId, you.bounty);
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
      // Every outcome answers differently: cold steel sparks off a shield,
      // red spray off flesh — the fight is readable without the hp bars.
      if (ev.blocked) {
        game.particles.emit(ev.x, ev.y, FX.emit.blockWedge);
      } else if (ev.kind === 'arrow') {
        game.particles.emit(ev.x, ev.y, FX.emit.arrowFlesh);
      } else if (ev.kind === 'melee') {
        game.particles.emit(ev.x, ev.y, FX.emit.meleeFlesh);
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
      if (pos) {
        const c = SQUAD_COLORS[victim?.squad ?? 0] ?? 0xffffff;
        game.fx.death(pos.x, pos.y, c);
        // The body breaks into shards of its own color.
        game.particles.emit(pos.x, pos.y, { ...FX.emit.deathShatter, colors: [c, c, 0xffffff] });
      }
      // Bounty made visible where it was earned. Only where we SAW the hit —
      // lastHitPos is fed by positionally-filtered events, so this can't leak
      // a kill's location through the fog.
      if (pos && ev.gold > 0) game.floats.show(pos.x, pos.y, `+${ev.gold}g`, 0xf2d68c);
      if (ev.victim === game.ownId) {
        game.lastKillerName = killer?.name ?? null;
        sfx('ownDeath');
        // Color drains for a beat (CSS on #app; fast in, slow seep back).
        const app = document.getElementById('app')!;
        app.classList.add('desat');
        setTimeout(() => app.classList.remove('desat'), FX.combat.desatMs);
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
      game.particles.emit(ev.x, ev.y, FX.emit.coinBurst);
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
        const tierSpan = `<span style="color:${TIER_CSS[ev.tier] ?? '#fff'}">`;
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
      game.decals.scorch(ev.x, ev.y);
      sfx('bombBoom', { x: ev.x, y: ev.y }, listener);
      break;
    case 'keepHit': {
      game.particles.emit(ev.x, ev.y, FX.emit.structChip);
      const info = game.keepInfo.get(ev.squad);
      if (info) {
        info.hp = ev.hp;
        game.keeps.update(ev.squad, info.x, info.y, ev.hp);
      }
      if (ev.squad === game.ownSquad) {
        game.hud.alarm('⚠ KEEP UNDER ATTACK ⚠');
        game.alarmUntilMs = performance.now() + FX.moments.alarmPointerMs;
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
      game.decals.scorch(ev.x, ev.y, true); // the scar outlives the rubble
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
      } else {
        // A keep falling is THE map moment — everyone gets the banner, not
        // just a killfeed line.
        game.hud.moment(
          `<span style="color:${SQUAD_CSS_SAFE(ev.squad)}">🔥 ${['RED', 'BLUE', 'GREEN', 'GOLD'][ev.squad]} KEEP FALLS</span>`,
        );
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
        game.hud.moment('<span style="color:#f05a4d">☠ YOUR SQUAD IS ELIMINATED ☠</span>', 3200);
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
      // The countryside keeps the score (G3): kind-shaped scars on the decal
      // layer — under structures, walked over, oldest fades first.
      if (ev.kind === STRUCT_TREE) {
        game.decals.stump(ev.x, ev.y, FX.architecture.rubbleLifeMs);
        game.particles.emit(ev.x, ev.y, {
          ...FX.emit.structChip,
          colors: [PROPS.trunk, ARMORY.WOOD, PROPS.oak],
          count: 10,
        });
      } else if (ev.kind === STRUCT_HUT) {
        game.decals.hutRuin(ev.x, ev.y, FX.architecture.rubbleLifeMs);
        for (let i = 0; i < 5; i++) game.particles.emit(ev.x, ev.y, FX.emit.smoke);
        game.particles.emit(ev.x, ev.y, { ...FX.emit.structChip, count: 12 });
      } else if (ev.kind !== STRUCT_TRAP) {
        game.decals.rubblePile(ev.x, ev.y, FX.architecture.rubbleLifeMs);
        game.particles.emit(ev.x, ev.y, { ...FX.emit.structChip, count: 14 });
      } else {
        game.particles.emit(ev.x, ev.y, { ...FX.emit.structChip, count: 8 });
      }
      // The memory is certain now — no ghost should outlive the rubble.
      game.ghosts.forget(ev.id);
      break;
    case 'structRepaired':
      game.fx.hitSpark(ev.x, ev.y, true); // the mason's clink
      if (ev.by === game.ownId) game.hud.toast('Patched — supply spent');
      break;
    case 'trapTriggered': {
      // Iron jaws, not fire: metal-and-rust burst + a rust ring. The generic
      // explosion read as a bomb and lied about what happened.
      game.particles.emit(ev.x, ev.y, FX.emit.trapJaws);
      game.fx.respawnRing(ev.x, ev.y, 0xd8543e);
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
        game.hud.moment('<span style="color:#f2d68c">⚔ THE HUNT IS ON ⚔</span>', 1800);
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
  game?.decals.clear();

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
    // Chip dust on hp drops the snapshot diff detects — no wire event exists
    // for structure hits, and none is needed.
    structures: new StructureLayer(scene.structureLayer, (x, y) =>
      game?.particles.emit(x, y, FX.emit.structChip),
    ),
    bombs: new BombLayer(scene.bombLayer, cfg.firebomb.radius),
    keeps: new KeepLayer(scene.keepLayer, cfg.keep.maxHp, cfg.banking.interactRadius),
    particles: new ParticleLayer(scene.fxLayer),
    fx: new FxLayer(scene.fxLayer),
    pings: new FxLayer(scene.pingLayer),
    floats: new FloatTextLayer(scene.pingLayer),
    decals: new FxLayer(scene.decalLayer, FX.architecture.decalCap),
    visibleHuts: [],
    ghosts: new GhostMemory(),
    fog: new FogLayer(scene.fogLayer, map, cfg),
    hud,
    structOcc: null,
    ownKeep: keepInfo.has(welcome.squadId)
      ? { x: keepInfo.get(welcome.squadId)!.x, y: keepInfo.get(welcome.squadId)!.y }
      : null,
    keepInfo,
    bounties: new Map(),
    ownGold: { bk: 0, g: 0, wd: 0, rb: 1 },
    ownEliminated: false,
    predictedAtkCd: 0,
    localSwingStartMs: -1e9,
    lastAim: { ax: 1, ay: 0 },
    lastHitPos: new Map(),
    lastKillerName: null,
    alarmUntilMs: 0,
    lastOwnTier: -1,
    lastBankQuarter: -1,
    waterTiles: (() => {
      // Water = unwalkable but see-through (rivers), scanned once per map.
      const tiles: Array<{ x: number; y: number }> = [];
      for (let ty = 0; ty < map.height; ty++) {
        for (let tx = 0; tx < map.width; tx++) {
          const i = ty * map.width + tx;
          if (map.walk[i] === 1 && map.vision[i] === 0) tiles.push({ x: tx + 0.5, y: ty + 0.5 });
        }
      }
      return tiles;
    })(),
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
let lastBeatMs = 0; // heartbeat pacing (M6 s2) — own timer, not the spam gate
let lastStepMs = 0; // footstep pacing (M6 s2)

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

/** True while __fl.pump drives frames by hand — frame() must not re-queue
 *  rAF then, or every pumped call would spawn a permanent extra loop the
 *  moment the pane becomes visible again. */
let pumping = false;

function frame(now: number): void {
  if (!pumping) requestAnimationFrame(frame);
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
      // The fire-gate mirror doubles as a reload read: the nocked arrow /
      // loaded bolt disappears with the shot and returns when it re-arms.
      atkReady: game.predictedAtkCd <= 0,
    };
  }

  game.entities.sync(visible, roster, game.ownId, ownVisual, game.bounties);
  game.sacks.sync(interp.sacks, now);

  // ---- movement life (M6 s2): dash kicks up earth + a squad-tint trail,
  // carried gold winks. Emitted per-frame off visible state bits only.
  const moveFx = (x: number, y: number, st: number, squad: number): void => {
    if ((st & ST_DASHING) !== 0) {
      game!.particles.emit(x, y, FX.emit.dashDust);
      const c = SQUAD_COLORS[squad] ?? 0xffffff;
      game!.particles.emit(x, y, { ...FX.emit.dashTrail, colors: [c] });
    }
    if ((st & ST_CARRYING) !== 0 && Math.random() < dtMs / FX.movement.glintEveryMs) {
      game!.particles.emit(x, y, FX.emit.carryGlint);
    }
  };
  for (const [id, e] of visible) {
    if (id !== game.ownId) moveFx(e.x, e.y, e.st, roster.get(id)?.squad ?? 0);
  }
  if (ownVisual) moveFx(ownVisual.x, ownVisual.y, ownVisual.st, game.ownSquad);

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
  // Living huts on this snapshot: the chimney-smoke emitter's anchor list.
  game.visibleHuts = interp.structures
    .filter((st) => st.k === STRUCT_HUT)
    .map((st) => ({ x: st.tx + 0.7, y: st.ty + 0.33 }));
  if (peekAt) scene.follow(peekAt.x, peekAt.y);
  else if (ownPos) scene.follow(ownPos.x, ownPos.y);

  // ---- contextual banking prompt (the "how do I bank" tutorial, in place)
  updatePrompt(ownPos);

  // ---- projectiles + bombs + fx on the delayed timeline
  game.projectiles.frame(renderTick, now);
  game.bombs.frame(renderTick, now);
  game.keeps.frame(now);
  game.structures.frame(now);
  game.fx.frame(now);
  game.decals.frame(now);
  game.particles.frame(now);
  game.pings.frame(now);
  game.floats.frame(now);
  game.hud.frame(now);
  game.hud.timer(game.phase, game.phaseEndsTick, estTick);

  // ---- low-HP state (M6 s2, own only): breathing vignette + heartbeat.
  const kitMax = getKit(game.cfg, game.prediction.classId).maxHp;
  const lowHp =
    !noPredict &&
    game.prediction.ready &&
    game.prediction.alive &&
    latestYouHp > 0 &&
    latestYouHp / kitMax < FX.combat.lowHpFrac;
  game.hud.lowHpFrame(now, lowHp);
  if (lowHp && now - lastBeatMs > FX.combat.heartbeatGapMs) {
    lastBeatMs = now;
    sfx('heartbeat');
  }

  // ---- the big-moment watchers (M6 s3) ----
  // Critical keeps smolder: wisps off any living keep under the red-bar tier.
  for (const k of game.keepInfo.values()) {
    if (
      k.hp > 0 &&
      k.hp / game.cfg.keep.maxHp < FX.moments.keepCriticalFrac &&
      Math.random() < dtMs / FX.moments.smokeEveryMs
    ) {
      game.particles.emit(k.x, k.y, FX.emit.smoke);
    }
  }
  // Own-keep alarm pointer: an edge-of-screen arrow toward home while the
  // klaxon is fresh — the banner says ATTACKED, this says WHERE.
  const pointer = document.getElementById('keeppointer')!;
  if (now < game.alarmUntilMs && ownPos && game.ownKeep) {
    const dx = game.ownKeep.x - ownPos.x;
    const dy = game.ownKeep.y - ownPos.y;
    if (Math.hypot(dx, dy) > 12) {
      const ang = Math.atan2(dy, dx);
      // Pane pitfall: window.innerWidth can be 0 — trust the renderer.
      const w = window.innerWidth || scene.app.renderer.width;
      const h = window.innerHeight || scene.app.renderer.height;
      const rad = Math.min(w, h) / 2 - 46;
      pointer.style.display = 'block';
      pointer.style.transform =
        `translate(${w / 2 + Math.cos(ang) * rad - 11}px, ${h / 2 + Math.sin(ang) * rad - 14}px) ` +
        `rotate(${ang * (180 / Math.PI) + 90}deg)`;
    } else {
      pointer.style.display = 'none'; // home is on screen — the keep IS the pointer
    }
  } else if (pointer.style.display !== 'none') {
    pointer.style.display = 'none';
  }
  // Bounty tier-up (own only): your name got heavier — a wanted-poster beat.
  if (latestYou) {
    const tier = bountyTier(game.cfg, latestYou.bounty);
    if (game.lastOwnTier >= 0 && tier > game.lastOwnTier) {
      game.hud.moment(
        `<span style="color:${TIER_CSS[tier] ?? '#fff'}">★ ${(TIER_NAMES[tier] ?? '').toUpperCase()} ★</span>`,
        1900,
      );
      game.hud.vignette(); // one watched-from-the-dark flicker
      sfx('tierUp');
    }
    game.lastOwnTier = tier;
  }
  // ---- world life (M6 s4): the map moves a little even when nobody does.
  // Living huts smoke gently (G3) — same rejection pattern as water glints.
  if (ownPos && game.visibleHuts.length > 0 && Math.random() < dtMs / FX.world.hutSmokeEveryMs) {
    const hut = game.visibleHuts[Math.floor(Math.random() * game.visibleHuts.length)]!;
    if (Math.hypot(hut.x - ownPos.x, hut.y - ownPos.y) < FX.world.hutSmokeRange) {
      game.particles.emit(hut.x, hut.y, FX.emit.smoke);
    }
  }
  scene.forestBreath(
    now,
    FX.world.forestBreathBase,
    FX.world.forestBreathAmp,
    FX.world.forestBreathPeriodMs,
  );
  if (ownPos && game.waterTiles.length > 0 && Math.random() < dtMs / FX.world.waterGlintEveryMs) {
    // Rejection-sample a few tries for water near the player; rivers are
    // sparse enough that misses are the common case far from them.
    for (let tries = 0; tries < 6; tries++) {
      const t = game.waterTiles[Math.floor(Math.random() * game.waterTiles.length)]!;
      if (Math.hypot(t.x - ownPos.x, t.y - ownPos.y) < FX.world.waterGlintRange) {
        game.particles.emit(t.x, t.y, FX.emit.waterGlint);
        break;
      }
    }
  }
  for (const t of game.map.towns) {
    if (Math.random() < dtMs / FX.world.townGlintEveryMs) {
      game.particles.emit(t.x, t.y, FX.emit.carryGlint);
    }
  }

  // The deposit channel plucks a rising note at each quarter — progress you
  // can hear while your eyes stay on the treeline.
  const bankTicks = latestYou?.bankTicks ?? 0;
  if (bankTicks > 0) {
    const total = secToTicks(game.cfg, game.cfg.banking.bankChannelSec);
    const quarter = Math.min(3, Math.floor((4 * bankTicks) / total));
    if (quarter > game.lastBankQuarter) {
      game.lastBankQuarter = quarter;
      sfx('channelTick', undefined, undefined, 1 + quarter * FX.moments.channelPitchStep);
    }
  } else {
    game.lastBankQuarter = -1;
  }

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
  // Quiet self-only footsteps (M6 s2), paced by their own timer so the spam
  // gate's counters keep meaning "collapsed event spam". Rooted feet are
  // pinned; dashing has its own voice.
  if (
    (move.mx !== 0 || move.my !== 0) &&
    alive &&
    game.phase === PHASE_LIVE &&
    pState.dashTicks <= 0 &&
    pState.rootTicks <= 0 &&
    now - lastStepMs > FX.combat.footstepGapMs
  ) {
    lastStepMs = now;
    sfx('step');
  }
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
      decalDemo(): boolean;
      stats(): Record<string, unknown>;
      pump(n?: number): boolean;
      shot(w?: number, h?: number, scale?: number): { len: number; w: number; h: number } | null;
      shotChunk(i: number, size?: number): string | null;
      charSheet(mode?: 'squads' | 'poses'): boolean;
      charSheetClear(): void;
      peek(x: number, y: number): boolean;
      peekClear(): void;
    };
  }
}

// ---- graphics-session hooks: the Browser pane can sit occluded on the
// desktop (document.hidden=true) with rAF permanently dead — frame loops
// pause while the sim keeps running. These drive frames BY HAND and pull
// zoomed crops out through the eval channel, so character art is verifiable
// without a visible window. (Pixi's own ticker is rAF-driven too, hence the
// explicit renderer.render.)
let lastShot = '';
let sheet: EntityLayer | null = null;
/** Camera-peek target for art verification: frame() follows this instead of
 *  the player while set. Render-only — the fog toggle just hides the veil
 *  sprite over terrain the client already knows; filtered entities were never
 *  in the scene graph to reveal. */
let peekAt: { x: number; y: number } | null = null;

function flPeek(x: number, y: number): boolean {
  if (!game || !scene) return false;
  peekAt = { x, y };
  scene.fogLayer.visible = false;
  flPump(1);
  return true;
}

function flPeekClear(): void {
  peekAt = null;
  if (scene) scene.fogLayer.visible = true;
}

function flPump(n = 1): boolean {
  if (!game || !scene) return false;
  pumping = true;
  try {
    for (let i = 0; i < n; i++) frame(performance.now());
  } finally {
    pumping = false;
  }
  scene.app.renderer.render(scene.app.stage);
  return true;
}

function flShot(w = 240, h = 240, scale = 2): { len: number; w: number; h: number } | null {
  if (!scene) return null;
  const src = scene.app.canvas as HTMLCanvasElement;
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  // Paint, then grab synchronously — the WebGL buffer is only guaranteed
  // until the next compositor swap.
  flPump(1);
  ctx.drawImage(src, (src.width - w) / 2, (src.height - h) / 2, w, h, 0, 0, c.width, c.height);
  lastShot = c.toDataURL('image/png');
  return { len: lastShot.length, w: c.width, h: c.height };
}

/** A character sheet rendered IN the live scene around the player: fake
 *  sprites through the real EntityLayer, so what the sheet shows is exactly
 *  what the game draws. 'squads' = 4 squads × 3 classes idle; 'poses' = own
 *  squad's classes × combat/state poses (walk col has real gait phase). */
function flCharSheet(mode: 'squads' | 'poses' = 'poses'): boolean {
  if (!game || !scene) return false;
  const own = window.__fl.selfPos();
  if (!own) return false;
  sheet?.clear();
  sheet = new EntityLayer(scene.entityLayer, game.cfg);
  const classes: Array<'fighter' | 'ranger' | 'engineer'> = ['fighter', 'ranger', 'engineer'];
  const fakeRoster = new Map<number, RosterEntry>();
  const ents = new Map<number, RichEnt>();
  const fakeBounties = new Map<number, number>();
  const walkers: number[] = [];
  let id = 90001;
  const add = (
    x: number,
    y: number,
    cls: RichEnt['cls'],
    st: number,
    squad: number,
    name = '',
    bounty = 0,
  ) => {
    fakeRoster.set(id, { id, squad, name, bot: false });
    ents.set(id, { x, y, ax: 1, ay: 0, hp: getKit(game!.cfg, cls).maxHp, cls, st });
    fakeBounties.set(id, bounty);
    return id++;
  };
  if (mode === 'squads') {
    // Writ ramp per class column (none / Wanted / Crownmarked): proves the
    // tier colors read against all four squad colors, red-on-red included.
    const writs = [0, 150, 800];
    for (let squad = 0; squad < 4; squad++) {
      classes.forEach((cls, ci) => {
        add(own.x + (ci - 1) * 2.2, own.y + (squad - 1.5) * 1.9, cls, 0, squad, '', writs[ci]!);
      });
    }
  } else {
    const poses: Array<{ name: string; st: number; walk?: boolean }> = [
      { name: 'idle', st: 0 },
      { name: 'walk', st: 0, walk: true },
      { name: 'windup', st: ST_WINDUP },
      { name: 'strike', st: ST_ACTIVE },
      { name: 'block', st: ST_BLOCKING },
      { name: 'carry', st: ST_CARRYING },
      { name: 'rooted', st: ST_ROOTED },
      { name: 'dash', st: ST_DASHING },
    ];
    // One writ tier per pose column, hidden through Crownmarked — the whole
    // ramp on one sheet (size + color + the tier-5 smolder over the walk gait).
    const writs = [0, 20, 60, 160, 320, 520, 850, 1200];
    classes.forEach((cls, ci) => {
      poses.forEach((p, pi) => {
        const eid = add(
          own.x + (pi - (poses.length - 1) / 2) * 1.8,
          own.y + (ci - 1) * 2.1,
          cls,
          p.st,
          game!.ownSquad,
          ci === 0 ? p.name : '',
          writs[pi % writs.length]!,
        );
        if (p.walk) walkers.push(eid);
      });
    });
  }
  sheet.sync(ents, fakeRoster, -1, null, fakeBounties);
  // Give the walk column a real mid-stride gait phase: nudge them forward a
  // few times so bobPhase accumulates exactly the way live movement does.
  for (let stepI = 0; stepI < 3; stepI++) {
    for (const wid of walkers) {
      const e = ents.get(wid)!;
      ents.set(wid, { ...e, x: e.x + 0.11 });
    }
    sheet.sync(ents, fakeRoster, -1, null, fakeBounties);
  }
  scene.app.renderer.render(scene.app.stage);
  return true;
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
  /** Stamp the G3 scar set (rubble/stump/hut-ruin) around the player —
   *  destruction is rare on camera; this is the decal eyeball. */
  decalDemo: () => {
    if (!game) return false;
    const p = window.__fl.selfPos();
    if (!p) return false;
    game.decals.rubblePile(p.x - 2.2, p.y - 1.2, FX.architecture.rubbleLifeMs);
    game.decals.stump(p.x + 2.2, p.y - 1.2, FX.architecture.rubbleLifeMs);
    game.decals.hutRuin(p.x, p.y + 2, FX.architecture.rubbleLifeMs);
    return true;
  },
  pump: flPump,
  shot: flShot,
  shotChunk: (i: number, size = 24000) =>
    lastShot ? lastShot.slice(i * size, (i + 1) * size) : null,
  charSheet: flCharSheet,
  charSheetClear: () => {
    sheet?.clear();
    sheet = null;
  },
  peek: flPeek,
  peekClear: flPeekClear,
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
      ? {
          particles: game.particles.stats(),
          floats: game.floats.stats(),
          audio: audioStats(),
          decals: game.decals.count(),
        }
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
// The front door (M6 s4): first-time humans pick a class and a name; any
// ?name param or live resume token skips it — automation, verify configs,
// and F5 rejoins never see a menu.
initFrontDoor({
  skip: params.get('name') !== null || hasResumeToken(),
  defaultName: name,
  defaultCls:
    clsParam === 'fighter' || clsParam === 'ranger' || clsParam === 'engineer'
      ? clsParam
      : undefined,
  onPlay: (chosenName, chosenCls) => {
    conn.setIdentity(chosenName, chosenCls);
    unlockAudio(); // PLAY is a real gesture — audio and the wind start here
    conn.connect();
  },
});
