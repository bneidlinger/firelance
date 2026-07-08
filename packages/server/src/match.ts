import { randomUUID } from 'node:crypto';
import { configHash, type ClassId, type GameConfig } from '@shared/config';
import { secToTicks } from '@shared/config';
import type { MapData } from '@shared/map/types';
import { decodeClientMsg, encodeMsg } from '@shared/net/codec';
import type { HelloMsg, NetEvent, RosterEntry, ServerMsg, WelcomeMsg } from '@shared/net/messages';
import { PROTOCOL_VERSION } from '@shared/net/messages';
import type { SimEvent } from '@shared/sim/events';
import { stepWorld } from '@shared/sim/step';
import { isVisibleToSquad } from '@shared/sim/vision';
import type { InputCmd, Player, PlayerId, World } from '@shared/sim/world';
import {
  createWorld,
  IDLE_INPUT,
  PHASE_ENDED,
  SPAWN_OFFSETS,
  spawnPlayer,
} from '@shared/sim/world';
import { removePlayerSpillingGold, withdrawableGold } from '@shared/sim/systems/economy';
import { acceptInput, createInputSlot, type InputSlot } from './inputs';
import { ReplayRecorder } from './replay';
import { buildSquadEnts, buildSquadSacks, buildYou } from './snapshot';
import type { ClientConn } from './transport';

interface Seat {
  id: PlayerId;
  conn: ClientConn;
  name: string;
  bot: boolean;
  squad: number;
  cls: ClassId;
  slot: InputSlot;
  /** Secret handed out in the welcome; reclaims this seat after a disconnect. */
  token: string;
}

/** Grace window during which a disconnected human's body (and gold) waits. */
const RESUME_GRACE_SEC = 60;

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
  /** Disconnected human seats waiting out the resume grace window, by token.
   *  Their player entities remain in the world — standing, killable, gold at
   *  risk. Refreshing is never an escape hatch. */
  private readonly limbo = new Map<string, { seat: Seat; expiresTick: number }>();
  /** One-shot idle inputs for freshly-limbo'd bodies — merged into the next
   *  tick's input map so the stop flows through recordTick (replay-faithful). */
  private readonly pendingIdleInputs = new Map<PlayerId, InputCmd>();
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

  get botSeats(): number {
    let n = 0;
    for (const s of this.seats.values()) if (s.bot) n++;
    return n;
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
      if (joined === null) return;
      const seat = this.seats.get(joined);
      // A resume takeover may have swapped the conn already — stale closes no-op.
      if (!seat || seat.conn !== conn) return;
      if (seat.bot) this.leave(joined);
      else this.enterLimbo(seat);
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
    if (hello.resume) {
      const resumed = this.tryResume(conn, hello.resume);
      if (resumed !== null) return resumed;
      // Unknown or expired token: fall through to a fresh join.
    }
    const capacity = this.cfg.match.squads * this.cfg.match.playersPerSquad;
    if (this.seats.size >= capacity) {
      // Bots fill seats; humans take them back. A human joining a bot-padded
      // full match evicts one bot — only genuinely human-full matches reject.
      const victim = hello.bot === true ? null : this.pickEvictableBot();
      if (!victim) {
        conn.send(encodeMsg({ t: 'error', reason: 'match full' }));
        conn.close();
        return null;
      }
      const victimConn = victim.conn;
      this.leave(victim.id);
      victimConn.close();
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
      token: randomUUID(),
    };
    this.seats.set(player.id, seat);
    this.recorderState?.recordJoin(player);

    this.send(seat, this.buildWelcome(seat));
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

  private buildWelcome(seat: Seat): WelcomeMsg {
    return {
      t: 'welcome',
      playerId: seat.id,
      squadId: seat.squad,
      mapId: this.map.id,
      cfgName: this.cfg.name,
      cfgHash: this.cfgHashValue,
      tick: this.worldState.tick,
      tickRate: this.cfg.tick.simHz,
      snapRate: this.cfg.tick.simHz / this.cfg.tick.snapshotEveryTicks,
      phase: this.worldState.phase,
      phaseEndsTick: this.worldState.phaseEndsTick,
      roster: this.roster(),
      resume: seat.token,
    };
  }

  /** Reclaim a seat by token: from limbo (normal refresh) or by conn takeover
   *  (the refresh RACE — the new tab connects before the old socket closes). */
  private tryResume(conn: ClientConn, token: string): PlayerId | null {
    const parked = this.limbo.get(token);
    if (parked) {
      this.limbo.delete(token);
      const seat = parked.seat;
      seat.conn = conn;
      seat.slot = createInputSlot(); // the refreshed client restarts seq at 1
      this.seats.set(seat.id, seat);
      this.send(seat, this.buildWelcome(seat));
      return seat.id;
    }
    for (const seat of this.seats.values()) {
      if (seat.bot || seat.token !== token) continue;
      const old = seat.conn;
      seat.conn = conn;
      seat.slot = createInputSlot();
      old.close(); // its onClose sees a different conn on the seat and no-ops
      this.send(seat, this.buildWelcome(seat));
      return seat.id;
    }
    return null;
  }

  /** Park a disconnected human seat; their body stays in the world (killable,
   *  gold at risk) until they resume or the grace window expires. */
  private enterLimbo(seat: Seat): void {
    this.seats.delete(seat.id);
    this.pendingIdleInputs.set(seat.id, { ...IDLE_INPUT });
    this.limbo.set(seat.token, {
      seat,
      expiresTick: this.worldState.tick + secToTicks(this.cfg, RESUME_GRACE_SEC),
    });
  }

  private leave(id: PlayerId): void {
    const seat = this.seats.get(id);
    if (!seat) return;
    this.seats.delete(id);
    // Spills carried gold as a sack — disconnecting can never destroy gold
    // (and can never rescue it, either: log off mid-run and the load stays
    // on the field). Same function the replay runner applies.
    removePlayerSpillingGold(this.worldState, id);
    this.recorderState?.recordLeave(id, this.worldState.tick);
    this.broadcastEvent({ k: 'playerLeft', tk: this.worldState.tick, id });
  }

  /** Newest bot on the fullest squad — evicting it preserves balance and
   *  leaves each squad's oldest (banker-role) bot in place. */
  private pickEvictableBot(): Seat | null {
    let best: Seat | null = null;
    let bestKey = -1;
    for (const s of this.seats.values()) {
      if (!s.bot) continue;
      const key = this.squadMembers(s.squad).length * 1_000_000 + s.id;
      if (key > bestKey) {
        bestKey = key;
        best = s;
      }
    }
    return best;
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
    // Freshly-disconnected bodies stop moving via a recorded idle input.
    for (const [id, cmd] of this.pendingIdleInputs) {
      if (this.worldState.players.has(id)) inputs.set(id, cmd);
    }
    this.pendingIdleInputs.clear();
    this.recorderState?.recordTick(this.worldState.tick + 1, inputs);
    const events = stepWorld(this.worldState, inputs, this.cfg, this.map);
    if (events.length > 0) {
      this.opts.onSimEvents?.(this.worldState.tick, events);
      this.pendingEvents.push(...events);
    }

    // Expire limbo seats whose grace window lapsed (checked ~1Hz).
    if (this.limbo.size > 0 && this.worldState.tick % this.cfg.tick.simHz === 0) {
      for (const [token, parked] of this.limbo) {
        if (this.worldState.tick < parked.expiresTick) continue;
        this.limbo.delete(token);
        removePlayerSpillingGold(this.worldState, parked.seat.id);
        this.recorderState?.recordLeave(parked.seat.id, this.worldState.tick);
        this.broadcastEvent({ k: 'playerLeft', tk: this.worldState.tick, id: parked.seat.id });
      }
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
      const sacks = buildSquadSacks(this.worldState, this.map, this.cfg, squad);
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
          sacks,
        });
        this.stats.snapshotsSent++;
      }
    }
  }

  /**
   * The event fog policy. Kill/phase/end/banked are global (bounty and the
   * banked score are public info by design); respawns are squad-private;
   * projectiles, swings, hits, and sack pickups are positional — with
   * own-squad involvement always visible.
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
        case 'banked':
          out.push(ev);
          break;
        case 'sackTaken':
          if (ev.squad === squadId || visible(ev.x, ev.y)) out.push(ev);
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
    const players = [...w.players.values()].map((p) => ({
      id: p.id,
      b: p.bounty,
      k: p.kills,
      d: p.deaths,
      a: p.assists,
    }));
    // Banked gold is the public score; keep-vault contents are squad-private
    // (design doc: "vault values" are hidden info) — so score fans out
    // per-squad, with `g`/`wd` attached only to the recipient's own entry.
    for (let squad = 0; squad < this.cfg.match.squads; squad++) {
      const members = this.squadMembers(squad);
      if (members.length === 0) continue;
      const msg: ServerMsg = {
        t: 'score',
        tick: w.tick,
        phase: w.phase,
        phaseEndsTick: w.phaseEndsTick,
        players,
        squads: w.squads.map((s) =>
          s.id === squad
            ? { id: s.id, bk: s.bankedGold, g: s.keepGold, wd: withdrawableGold(this.cfg, s) }
            : { id: s.id, bk: s.bankedGold },
        ),
      };
      for (const seat of members) this.send(seat, msg);
    }
  }

  /** End screen elapsed: rebuild the world, re-seat everyone, fresh welcomes. */
  private restart(): void {
    this.currentSeed++;
    this.worldState = createWorld(this.currentSeed, this.cfg, this.map);
    this.pendingEvents = [];
    // Limbo seats belong to the old world; a returner just joins fresh.
    this.limbo.clear();
    this.pendingIdleInputs.clear();
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
      this.send(seat, this.buildWelcome(seat));
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
