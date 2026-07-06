import { configHash, type GameConfig } from '@shared/config';
import type { MapData } from '@shared/map/types';
import { decodeClientMsg, encodeMsg } from '@shared/net/codec';
import type { HelloMsg, NetEvent, RosterEntry, ServerMsg } from '@shared/net/messages';
import { PROTOCOL_VERSION } from '@shared/net/messages';
import { stepWorld } from '@shared/sim/step';
import type { InputCmd, Player, PlayerId, World } from '@shared/sim/world';
import { createWorld, spawnPlayer } from '@shared/sim/world';
import { acceptInput, createInputSlot, type InputSlot } from './inputs';
import { ReplayRecorder } from './replay';
import { buildSquadEnts } from './snapshot';
import type { ClientConn } from './transport';

interface Seat {
  id: PlayerId;
  conn: ClientConn;
  name: string;
  bot: boolean;
  squad: number;
  slot: InputSlot;
}

export interface MatchOpts {
  cfg: GameConfig;
  map: MapData;
  seed: number;
  record?: boolean;
}

// Spawn offsets so squad members don't stack on the spawn tile.
const SPAWN_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.9, 0],
  [0, 0.9],
  [0.9, 0.9],
];

/**
 * One match, one Match instance, no module globals — the multi-room future is
 * additive. Owns the world, seats, input slots, snapshot fan-out, and (when
 * enabled) the replay recorder.
 */
export class Match {
  readonly cfg: GameConfig;
  readonly map: MapData;
  readonly world: World;
  readonly recorder: ReplayRecorder | null;
  private readonly cfgHashValue: string;
  private readonly seats = new Map<PlayerId, Seat>();
  private stats = { snapshotsSent: 0, inputsAccepted: 0, bytesSent: 0 };

  constructor(opts: MatchOpts) {
    this.cfg = opts.cfg;
    this.map = opts.map;
    this.world = createWorld(opts.seed, opts.cfg);
    this.cfgHashValue = configHash(opts.cfg);
    this.recorder = opts.record ? new ReplayRecorder(opts.seed, opts.cfg.name, opts.map.id) : null;
  }

  get playerCount(): number {
    return this.seats.size;
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
        case 'ping':
          this.send(seat, { t: 'pong', ct: msg.ct, tick: this.world.tick });
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
    const spawn = this.map.spawns[squad] ?? this.map.spawns[0]!;
    const [ox, oy] = SPAWN_OFFSETS[memberIdx % SPAWN_OFFSETS.length]!;
    const name = hello.name.replace(/[^\w \-']/g, '').slice(0, 16) || `player${this.world.nextId}`;

    const player = spawnPlayer(
      this.world,
      squad,
      name,
      hello.bot === true,
      spawn.x + ox,
      spawn.y + oy,
    );
    const seat: Seat = {
      id: player.id,
      conn,
      name,
      bot: hello.bot === true,
      squad,
      slot: createInputSlot(),
    };
    this.seats.set(player.id, seat);
    this.recorder?.recordJoin(player);

    this.send(seat, {
      t: 'welcome',
      playerId: player.id,
      squadId: squad,
      mapId: this.map.id,
      cfgName: this.cfg.name,
      cfgHash: this.cfgHashValue,
      tick: this.world.tick,
      tickRate: this.cfg.tick.simHz,
      snapRate: this.cfg.tick.simHz / this.cfg.tick.snapshotEveryTicks,
      roster: this.roster(),
    });
    this.broadcastEvent(
      { k: 'playerJoined', id: player.id, squad, name, bot: seat.bot },
      player.id,
    );
    return player.id;
  }

  private leave(id: PlayerId): void {
    const seat = this.seats.get(id);
    if (!seat) return;
    this.seats.delete(id);
    this.world.players.delete(id);
    this.recorder?.recordLeave(id, this.world.tick);
    this.broadcastEvent({ k: 'playerLeft', id });
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

  /** Advance the world one tick; fan out snapshots on snapshot ticks. */
  tick(): void {
    const inputs = new Map<PlayerId, InputCmd>();
    for (const seat of this.seats.values()) {
      if (seat.slot.latest) {
        inputs.set(seat.id, seat.slot.latest);
        seat.slot.appliedSeq = seat.slot.latestSeq;
        seat.slot.latest = null; // applied; sim keeps it on the player from here
      }
    }
    this.recorder?.recordTick(this.world.tick + 1, inputs);
    stepWorld(this.world, inputs, this.cfg, this.map);

    if (this.world.tick % this.cfg.tick.snapshotEveryTicks === 0) {
      this.sendSnapshots();
    }
  }

  private sendSnapshots(): void {
    for (let squad = 0; squad < this.cfg.match.squads; squad++) {
      const members = this.squadMembers(squad);
      if (members.length === 0) continue;
      const ents = buildSquadEnts(this.world, squad, this.cfg);
      for (const seat of members) {
        const p = this.world.players.get(seat.id);
        if (!p) continue;
        this.send(seat, {
          t: 'snap',
          tick: this.world.tick,
          ackSeq: seat.slot.appliedSeq,
          you: { x: p.x, y: p.y, vx: p.vx, vy: p.vy },
          ents,
        });
        this.stats.snapshotsSent++;
      }
    }
  }

  private broadcastEvent(event: NetEvent, exceptId?: PlayerId): void {
    for (const seat of this.seats.values()) {
      if (seat.id === exceptId) continue;
      this.send(seat, { t: 'ev', tick: this.world.tick, events: [event] });
    }
  }

  private send(seat: Seat, msg: ServerMsg): void {
    const data = encodeMsg(msg);
    this.stats.bytesSent += data.length;
    seat.conn.send(data);
  }
}
