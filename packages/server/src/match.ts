import { configHash, type ClassId, type GameConfig } from '@shared/config';
import type { MapData } from '@shared/map/types';
import { decodeClientMsg, encodeMsg } from '@shared/net/codec';
import type { HelloMsg, NetEvent, RosterEntry, ServerMsg, WelcomeMsg } from '@shared/net/messages';
import { PROTOCOL_VERSION } from '@shared/net/messages';
import type { SimEvent } from '@shared/sim/events';
import { stepWorld } from '@shared/sim/step';
import { isVisibleToSquad } from '@shared/sim/vision';
import type { InputCmd, Player, PlayerId, World } from '@shared/sim/world';
import { createWorld, PHASE_ENDED, SPAWN_OFFSETS, spawnPlayer } from '@shared/sim/world';
import { acceptInput, createInputSlot, type InputSlot } from './inputs';
import { ReplayRecorder } from './replay';
import { buildSquadEnts, buildYou } from './snapshot';
import type { ClientConn } from './transport';

interface Seat {
  id: PlayerId;
  conn: ClientConn;
  name: string;
  bot: boolean;
  squad: number;
  cls: ClassId;
  slot: InputSlot;
}

export interface MatchOpts {
  cfg: GameConfig;
  map: MapData;
  seed: number;
  record?: boolean;
  /** Tap on raw per-tick sim events (harness stats/invariants). */
  onSimEvents?: (tick: number, events: SimEvent[]) => void;
  /** Called after the match auto-restarts with a fresh world. */
  onRestart?: (newSeed: number) => void;
}

/**
 * One match, one Match instance, no module globals — the multi-room future is
 * additive. Owns the world, seats, input slots, event fan-out (fog policy
 * lives HERE), snapshot fan-out, score broadcasts, the auto-restart loop, and
 * (when enabled) the replay recorder.
 */
export class Match {
  readonly cfg: GameConfig;
  readonly map: MapData;
  private readonly opts: MatchOpts;
  private readonly cfgHashValue: string;
  private readonly seats = new Map<PlayerId, Seat>();
  private stats = { snapshotsSent: 0, inputsAccepted: 0, bytesSent: 0 };
  private pendingEvents: SimEvent[] = [];
  private currentSeed: number;
  private worldState: World;
  private recorderState: ReplayRecorder | null;

  constructor(opts: MatchOpts) {
    this.opts = opts;
    this.cfg = opts.cfg;
    this.map = opts.map;
    this.currentSeed = opts.seed;
    this.worldState = createWorld(opts.seed, opts.cfg, opts.map);
    this.cfgHashValue = configHash(opts.cfg);
    this.recorderState = opts.record
      ? new ReplayRecorder(opts.seed, opts.cfg.name, opts.map.id)
      : null;
  }

  get world(): World {
    return this.worldState;
  }

  get recorder(): ReplayRecorder | null {
    return this.recorderState;
  }

  get playerCount(): number {
    return this.seats.size;
  }

  get seed(): number {
    return this.currentSeed;
  }

  getStats(): { snapshotsSent: number; inputsAccepted: number; bytesSent: number } {
    return { ...this.stats };
  }

  /** Register a fresh connection; the first valid message must be `hello`. */
  addConn(conn: ClientConn): void {
    let joined: PlayerId | null = null;
    conn.onMessage((data) => {
      const decoded = decodeClientMsg(data);
      if (!decoded.ok) {
        // Malformed frames from an unjoined connection are hostile/broken: drop.
        if (joined === null) conn.close();
        return;
      }
      const msg = decoded.msg;
      if (joined === null) {
        if (msg.t !== 'hello') {
          conn.close();
          return;
        }
        joined = this.join(conn, msg);
        return;
      }
      const seat = this.seats.get(joined);
      if (!seat) return;
      switch (msg.t) {
        case 'input':
          acceptInput(seat.slot, msg);
          this.stats.inputsAccepted++;
          break;
        case 'class': {
          seat.cls = msg.cls;
          const p = this.worldState.players.get(seat.id);
          if (p) p.pendingCls = msg.cls;
          this.recorderState?.recordClass(seat.id, msg.cls, this.worldState.tick);
          break;
        }
        case 'ping':
          this.send(seat, { t: 'pong', ct: msg.ct, tick: this.worldState.tick });
          break;
        case 'hello':
          break; // duplicate hello: ignore
      }
    });
    conn.onClose(() => {
      if (joined !== null) this.leave(joined);
    });
  }

  private join(conn: ClientConn, hello: HelloMsg): PlayerId | null {
    if (hello.v !== PROTOCOL_VERSION) {
      conn.send(
        encodeMsg({ t: 'error', reason: `protocol mismatch (server v${PROTOCOL_VERSION})` }),
      );
      conn.close();
      return null;
    }
    const capacity = this.cfg.match.squads * this.cfg.match.playersPerSquad;
    if (this.seats.size >= capacity) {
      conn.send(encodeMsg({ t: 'error', reason: 'match full' }));
      conn.close();
      return null;
    }

    const squad = this.pickSquad();
    const memberIdx = this.squadMembers(squad).length;
    // Default composition when no class requested: 1 fighter + rangers.
    const cls: ClassId = hello.cls ?? (memberIdx === 0 ? 'fighter' : 'ranger');
    const name =
      hello.name.replace(/[^\w \-']/g, '').slice(0, 16) || `player${this.worldState.nextId}`;

    const player = this.spawnSeatPlayer(squad, name, hello.bot === true, cls, memberIdx);
    const seat: Seat = {
      id: player.id,
      conn,
      name,
      bot: hello.bot === true,
      squad,
      cls,
      slot: createInputSlot(),
    };
    this.seats.set(player.id, seat);
    this.recorderState?.recordJoin(player);

    this.send(seat, this.buildWelcome(player.id, squad));
    this.broadcastEvent(
      {
        k: 'playerJoined',
        tk: this.worldState.tick,
        id: player.id,
        squad,
        name,
        bot: seat.bot,
      },
      player.id,
    );
    return player.id;
  }

  /** Players spawn at their squad keep (respawn point) with a small offset. */
  private spawnSeatPlayer(
    squad: number,
    name: string,
    bot: boolean,
    cls: ClassId,
    memberIdx: number,
  ): Player {
    const keep = this.worldState.squads[squad]!;
    const [ox, oy] = SPAWN_OFFSETS[memberIdx % SPAWN_OFFSETS.length]!;
    return spawnPlayer(
      this.worldState,
      this.cfg,
      squad,
      name,
      bot,
      cls,
      keep.keepX + ox,
      keep.keepY + oy,
    );
  }

  private buildWelcome(playerId: PlayerId, squad: number): WelcomeMsg {
    return {
      t: 'welcome',
      playerId,
      squadId: squad,
      mapId: this.map.id,
      cfgName: this.cfg.name,
      cfgHash: this.cfgHashValue,
      tick: this.worldState.tick,
      tickRate: this.cfg.tick.simHz,
      snapRate: this.cfg.tick.simHz / this.cfg.tick.snapshotEveryTicks,
      phase: this.worldState.phase,
      phaseEndsTick: this.worldState.phaseEndsTick,
      roster: this.roster(),
    };
  }

  private leave(id: PlayerId): void {
    const seat = this.seats.get(id);
    if (!seat) return;
    this.seats.delete(id);
    this.worldState.players.delete(id);
    this.recorderState?.recordLeave(id, this.worldState.tick);
    this.broadcastEvent({ k: 'playerLeft', tk: this.worldState.tick, id });
  }

  private pickSquad(): number {
    let best = 0;
    let bestCount = Number.POSITIVE_INFINITY;
    for (let s = 0; s < this.cfg.match.squads; s++) {
      const count = this.squadMembers(s).length;
      if (count < bestCount) {
        best = s;
        bestCount = count;
      }
    }
    return best;
  }

  private squadMembers(squad: number): Seat[] {
    return [...this.seats.values()].filter((s) => s.squad === squad);
  }

  private roster(): RosterEntry[] {
    return [...this.seats.values()].map((s) => ({
      id: s.id,
      squad: s.squad,
      name: s.name,
      bot: s.bot,
    }));
  }

  /** Advance the world one tick; fan out events/snapshots/score on schedule. */
  tick(): void {
    const inputs = new Map<PlayerId, InputCmd>();
    for (const seat of this.seats.values()) {
      if (seat.slot.latest) {
        inputs.set(seat.id, seat.slot.latest);
        seat.slot.appliedSeq = seat.slot.latestSeq;
        seat.slot.latest = null; // applied; sim keeps it on the player from here
      }
    }
    this.recorderState?.recordTick(this.worldState.tick + 1, inputs);
    const events = stepWorld(this.worldState, inputs, this.cfg, this.map);
    if (events.length > 0) {
      this.opts.onSimEvents?.(this.worldState.tick, events);
      this.pendingEvents.push(...events);
    }

    if (this.worldState.tick % this.cfg.tick.snapshotEveryTicks === 0) {
      this.sendSnapshots();
      this.pendingEvents = [];
    }
    if (this.worldState.tick % this.cfg.tick.scoreEveryTicks === 0) {
      this.sendScore();
    }
    if (
      this.worldState.phase === PHASE_ENDED &&
      this.worldState.tick >= this.worldState.phaseEndsTick &&
      this.seats.size > 0
    ) {
      this.restart();
    }
  }

  private sendSnapshots(): void {
    for (let squad = 0; squad < this.cfg.match.squads; squad++) {
      const members = this.squadMembers(squad);
      if (members.length === 0) continue;
      const events = this.filterEventsForSquad(squad);
      const ents = buildSquadEnts(this.worldState, this.map, this.cfg, squad);
      for (const seat of members) {
        const p = this.worldState.players.get(seat.id);
        if (!p) continue;
        if (events.length > 0) {
          this.send(seat, { t: 'ev', tick: this.worldState.tick, events });
        }
        this.send(seat, {
          t: 'snap',
          tick: this.worldState.tick,
          ackSeq: seat.slot.appliedSeq,
          you: buildYou(this.worldState, p),
          ents,
        });
        this.stats.snapshotsSent++;
      }
    }
  }

  /**
   * The event fog policy. Kill/phase/end are global (bounty is public info by
   * design); respawns are squad-private; projectiles, swings, and hits are
   * positional — with own-squad involvement always visible.
   */
  private filterEventsForSquad(squadId: number): NetEvent[] {
    const out: NetEvent[] = [];
    const w = this.worldState;
    const visible = (x: number, y: number): boolean =>
      isVisibleToSquad(w, this.map, this.cfg, squadId, x, y);
    for (const ev of this.pendingEvents) {
      switch (ev.k) {
        case 'kill':
        case 'phase':
        case 'matchEnd':
          out.push(ev);
          break;
        case 'respawn':
          if (ev.squad === squadId) out.push(ev);
          break;
        case 'projSpawn': {
          if (ev.squad === squadId) {
            out.push(ev);
            break;
          }
          // Fairness rule: an arrow is announced if ANY point of its flight
          // path is visible — you can always see (and dodge) what can hit you.
          const flight = (ev.speed * ev.ttl) / this.cfg.tick.simHz;
          let seen = false;
          for (let f = 0; f <= 1 && !seen; f += 0.25) {
            seen = visible(ev.x + ev.dx * flight * f, ev.y + ev.dy * flight * f);
          }
          if (seen) out.push(ev);
          break;
        }
        case 'projEnd':
          if (ev.squad === squadId || visible(ev.x, ev.y)) out.push(ev);
          break;
        case 'swing':
          if (visible(ev.x, ev.y)) out.push(ev);
          break;
        case 'hit': {
          const attacker = w.players.get(ev.attacker);
          const victim = w.players.get(ev.victim);
          if (attacker?.squad === squadId || victim?.squad === squadId || visible(ev.x, ev.y)) {
            out.push(ev);
          }
          break;
        }
      }
    }
    return out;
  }

  private sendScore(): void {
    const w = this.worldState;
    const msg: ServerMsg = {
      t: 'score',
      tick: w.tick,
      phase: w.phase,
      phaseEndsTick: w.phaseEndsTick,
      players: [...w.players.values()].map((p) => ({
        id: p.id,
        b: p.bounty,
        k: p.kills,
        d: p.deaths,
        a: p.assists,
      })),
      squads: w.squads.map((s) => ({ id: s.id, g: s.keepGold })),
    };
    for (const seat of this.seats.values()) this.send(seat, msg);
  }

  /** End screen elapsed: rebuild the world, re-seat everyone, fresh welcomes. */
  private restart(): void {
    this.currentSeed++;
    this.worldState = createWorld(this.currentSeed, this.cfg, this.map);
    this.pendingEvents = [];
    this.recorderState = this.opts.record
      ? new ReplayRecorder(this.currentSeed, this.cfg.name, this.map.id)
      : null;

    const oldSeats = [...this.seats.values()];
    this.seats.clear();
    const memberCount = new Array<number>(this.cfg.match.squads).fill(0);
    for (const seat of oldSeats) {
      if (seat.conn.closed) continue;
      const memberIdx = memberCount[seat.squad]!++;
      const player = this.spawnSeatPlayer(seat.squad, seat.name, seat.bot, seat.cls, memberIdx);
      seat.id = player.id;
      this.seats.set(player.id, seat);
      this.recorderState?.recordJoin(player);
    }
    for (const seat of this.seats.values()) {
      this.send(seat, this.buildWelcome(seat.id, seat.squad));
    }
    this.opts.onRestart?.(this.currentSeed);
  }

  private broadcastEvent(event: NetEvent, exceptId?: PlayerId): void {
    for (const seat of this.seats.values()) {
      if (seat.id === exceptId) continue;
      this.send(seat, { t: 'ev', tick: this.worldState.tick, events: [event] });
    }
  }

  private send(seat: Seat, msg: ServerMsg): void {
    const data = encodeMsg(msg);
    this.stats.bytesSent += data.length;
    seat.conn.send(data);
  }
}
