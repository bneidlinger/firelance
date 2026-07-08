import { getConfigPreset, getKit, type GameConfig } from '@shared/config';
import { getMap } from '@shared/map/maps';
import type { MapData } from '@shared/map/types';
import { solveIntercept } from '@shared/math/intercept';
import { createRng, rngFloat, rngInt, type RngState } from '@shared/math/rng';
import type { EntitySnap, InputMsg, SackSnap, ServerMsg, YouSnap } from '@shared/net/messages';
import { ST_CARRYING } from '@shared/net/messages';
import { tileRayClear } from '@shared/sim/vision';
import { assignKeeps } from '@shared/sim/world';
import { findPath, randomWalkableTile, walkRayClear, type Waypoint } from './nav';

// Transport-agnostic bot mind, Milestone 2: a combatant AND an economic actor.
// Consumes only what the server actually sends (bots live under the same fog
// as humans, which makes every bot match a continuous protocol test) and
// produces inputs.
//
// FSM: ROAM (wander waypoints) → SEEK (chase last-seen enemy) → ATTACK
// (class-specific: rangers kite a distance band with intercept-lead arrows,
// fighters charge, dash-close, and swing) → FLEE (low hp: run home, let regen
// work) → LOOT (grab a visible ground sack) → BANK (the M2 loop: the squad's
// designated banker withdraws at the keep and hauls to the nearest town;
// anyone holding loot heads for a town and channels the deposit). Carriers
// hunt less and get hunted more: visible ST_CARRYING enemies pull strong
// target priority. Aim error is gaussian via the bot's own seeded rng — skill
// knobs in BotSkill. Bots never read authoritative world state: positions come
// from snapshots, walls from the shared map, own state from `you`.

export interface BotSkill {
  /** Gaussian aim error, radians (σ). 0 = aimbot. */
  aimErrorStd: number;
  /** Start attacking when a visible enemy is closer than this. */
  engageRange: number;
  /** Ranger kite band. */
  bandMin: number;
  bandMax: number;
  /** Flee below this hp fraction; re-engage above the other. */
  fleeBelow: number;
  reengageAbove: number;
  /** Chance per think to use dash aggressively (fighter gap-close). */
  dashAggression: number;
  /** Own-squad withdrawable gold that sends the designated banker on a run. */
  bankRunAt: number;
  /** Carried gold at which any bot beelines for a town to deposit. */
  bankNowAt: number;
  /** The banker stops loading at the keep once carrying this much. */
  carryTarget: number;
  /** Passing within this range of a town with gold aboard = deposit it. */
  bankDetourRange: number;
  /** Chase visible ground sacks within this range. */
  lootRange: number;
}

export const DEFAULT_SKILL: BotSkill = {
  aimErrorStd: 0.15,
  engageRange: 12,
  bandMin: 6,
  bandMax: 10,
  fleeBelow: 0.32,
  reengageAbove: 0.62,
  dashAggression: 0.5,
  bankRunAt: 300,
  bankNowAt: 100,
  carryTarget: 450,
  bankDetourRange: 12,
  lootRange: 18,
};

type FsmState =
  'ROAM' | 'SEEK' | 'ATTACK' | 'FLEE' | 'LOOT' | 'BANK' | 'DEFEND' | 'SIEGE' | 'REBUILD';

const BTN_INTERACT = 8; // matches shared/sim/world.ts (old code uses 1/2/4 literals)
const BTN_BOMB = 16;

const THINK_PATH_EVERY_TICKS = 6; // ~5Hz pathing at 30Hz sim
const WAYPOINT_REACHED = 0.7;
const STALL_WINDOW_TICKS = 45; // 1.5s
const STALL_MIN_MOVE = 0.5;
const TARGET_MEMORY_TICKS = 150; // chase a ghost for 5s, then give up
const STRAFE_FLIP_TICKS = 24;

interface TrackedEnemy {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  lastSeenTick: number;
  /** Visibly hauling gold (ST_CARRYING) — prime bounty-run interception bait. */
  carrying: boolean;
}

export class BotBrain {
  private readonly rng: RngState;
  private readonly skill: BotSkill;
  private map: MapData | null = null;
  private cfg: GameConfig | null = null;
  private myId = -1;
  private mySquad = -1;
  private tickRate = 30;
  private you: YouSnap | null = null;
  private keep: Waypoint | null = null;
  private readonly squadOf = new Map<number, number>();

  private state: FsmState = 'ROAM';
  private readonly enemies = new Map<number, TrackedEnemy>();
  private readonly bounties = new Map<number, number>();
  /** victimId -> tick until which they're spawn-protected in our eyes.
   *  Anti-farm already pays ZERO for fresh-spawn kills; hunting them anyway
   *  is pure spawn-camping grief — worst possible feel for human players. */
  private readonly freshUntil = new Map<number, number>();
  /** attackerId -> last tick they hit US (self-defense overrides etiquette). */
  private readonly aggressors = new Map<number, number>();
  private targetId = -1;
  private prevEnts = new Map<number, { x: number; y: number; tick: number }>();
  private prevHp = -1;
  private blockUntilTick = -1;

  // ---- banking state (M2)
  /** id -> bot flag for my squad (banker = lowest-id bot; humans opt in themselves). */
  private readonly squadBotIds = new Set<number>();
  /** Visible ground sacks, replaced wholesale each snapshot (fog = no memory). */
  private sacks: SackSnap[] = [];
  /** Own squad's withdrawable gold, from the 2Hz score broadcast. */
  private ownWd = 0;
  /** Tick carried last changed — detects "the vault trickle stopped". */
  private carriedChangedTick = -1_000_000;
  private lastCarried = 0;
  /** Failed/completed runs back off before re-triggering. */
  private bankRetryAt = -1_000_000;
  private bankStartTick = -1;
  /** Tick we entered the keep's interact circle (-1 = outside). */
  private atKeepSince = -1;
  /** Last tick doBank ran — a gap means another state interleaved. */
  private lastBankTick = -1_000_000;

  // ---- keep warfare state (M3)
  /** Current keep site per squad (assignKeeps at start; keepRebuilt moves it). */
  private readonly keepPos = new Map<number, Waypoint>();
  /** Public keep hp per squad, from the 2Hz score. */
  private readonly keepHpBySquad = new Map<number, number>();
  /** Own squad's rebuilds remaining (own-squad score field). */
  private ownRebuilds = 1;
  /** Tick of our squad's last under-attack alarm. */
  private lastOwnAlarmTick = -1_000_000;
  /** Where OUR keep fell (the spill to recover for the rebuild). */
  private ownRuin: Waypoint | null = null;

  private path: Waypoint[] | null = null;
  private wpIdx = 0;
  private pathGoal: Waypoint | null = null;
  private seq = 0;
  private lastPathThinkTick = -1_000_000;
  private stallX = 0;
  private stallY = 0;
  private stallTick = -1;
  private strafeSign = 1;
  private strafeFlipAt = 0;

  constructor(seed: number, skill: Partial<BotSkill> = {}) {
    this.rng = createRng(seed);
    this.skill = { ...DEFAULT_SKILL, ...skill };
  }

  get id(): number {
    return this.myId;
  }

  get fsmState(): FsmState {
    return this.state;
  }

  handleServer(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        // Fresh world (first join OR match auto-restart): reset everything.
        this.myId = msg.playerId;
        this.mySquad = msg.squadId;
        this.map = getMap(msg.mapId);
        try {
          this.cfg = getConfigPreset(msg.cfgName);
        } catch {
          this.cfg = null; // unknown preset: fall back to sane defaults
        }
        this.tickRate = msg.tickRate;
        this.keep = assignKeeps(this.map, 4)[this.mySquad] ?? null;
        this.keepPos.clear();
        assignKeeps(this.map, 4).forEach((k, sq) => this.keepPos.set(sq, k));
        this.keepHpBySquad.clear();
        this.ownRebuilds = 1;
        this.lastOwnAlarmTick = -1_000_000;
        this.ownRuin = null;
        this.squadOf.clear();
        this.squadBotIds.clear();
        for (const r of msg.roster) {
          this.squadOf.set(r.id, r.squad);
          if (r.squad === this.mySquad && r.bot) this.squadBotIds.add(r.id);
        }
        this.enemies.clear();
        this.bounties.clear();
        this.freshUntil.clear();
        this.aggressors.clear();
        this.prevEnts.clear();
        this.you = null;
        this.state = 'ROAM';
        this.targetId = -1;
        this.path = null;
        this.pathGoal = null;
        this.prevHp = -1;
        this.sacks = [];
        this.ownWd = 0;
        this.carriedChangedTick = -1_000_000;
        this.lastCarried = 0;
        this.bankRetryAt = -1_000_000;
        this.bankStartTick = -1;
        this.atKeepSince = -1;
        break;
      case 'snap':
        this.you = msg.you;
        this.trackEnemies(msg.tick, msg.ents);
        this.sacks = msg.sacks;
        if (msg.you.carried !== this.lastCarried) {
          this.lastCarried = msg.you.carried;
          this.carriedChangedTick = msg.tick;
        }
        break;
      case 'ev':
        for (const ev of msg.events) {
          if (ev.k === 'playerJoined') {
            this.squadOf.set(ev.id, ev.squad);
            if (ev.squad === this.mySquad && ev.bot) this.squadBotIds.add(ev.id);
          } else if (ev.k === 'playerLeft') {
            this.squadOf.delete(ev.id);
            this.squadBotIds.delete(ev.id);
            this.enemies.delete(ev.id);
          } else if (ev.k === 'kill') {
            this.enemies.delete(ev.victim); // dead targets stop existing
            if (ev.victim === this.targetId) this.targetId = -1;
            // Respawn delay + fresh-spawn window: leave them alone until then.
            const hz = this.tickRate;
            const respawnSec = this.cfg?.player.respawnSec ?? 8;
            const freshSec = this.cfg?.bounty.freshSpawnSec ?? 10;
            this.freshUntil.set(ev.victim, ev.tk + Math.round((respawnSec + freshSec) * hz));
          } else if (ev.k === 'hit' && ev.victim === this.myId) {
            this.aggressors.set(ev.attacker, ev.tk);
          } else if (ev.k === 'keepHit' && ev.squad === this.mySquad) {
            this.lastOwnAlarmTick = ev.tk;
          } else if (ev.k === 'keepDestroyed') {
            this.keepHpBySquad.set(ev.squad, 0);
            if (ev.squad === this.mySquad) this.ownRuin = { x: ev.x, y: ev.y };
          } else if (ev.k === 'keepRebuilt') {
            this.keepPos.set(ev.squad, { x: ev.x, y: ev.y });
            if (ev.squad === this.mySquad) {
              this.keep = { x: ev.x, y: ev.y };
              this.ownRuin = null;
            }
          }
        }
        break;
      case 'score':
        for (const p of msg.players) this.bounties.set(p.id, p.b);
        for (const s of msg.squads) {
          this.keepHpBySquad.set(s.id, s.kh);
          if (s.id === this.mySquad) {
            if (s.wd !== undefined) this.ownWd = s.wd;
            if (s.rb !== undefined) this.ownRebuilds = s.rb;
          }
        }
        break;
      case 'pong':
      case 'error':
        break;
    }
  }

  /** Update last-seen enemy records (position + velocity estimate) from a snapshot. */
  private trackEnemies(tick: number, ents: EntitySnap[]): void {
    for (const e of ents) {
      if (e.i === this.myId) continue;
      if (this.squadOf.get(e.i) === this.mySquad) continue;
      const prev = this.prevEnts.get(e.i);
      let vx = 0;
      let vy = 0;
      if (prev && tick > prev.tick) {
        const dt = (tick - prev.tick) / this.tickRate;
        vx = (e.x - prev.x) / dt;
        vy = (e.y - prev.y) / dt;
      }
      this.enemies.set(e.i, {
        id: e.i,
        x: e.x,
        y: e.y,
        vx,
        vy,
        lastSeenTick: tick,
        carrying: (e.st & ST_CARRYING) !== 0,
      });
      this.prevEnts.set(e.i, { x: e.x, y: e.y, tick });
    }
    // Forget ghosts we chased too long.
    for (const [id, en] of this.enemies) {
      if (tick - en.lastSeenTick > TARGET_MEMORY_TICKS) this.enemies.delete(id);
    }
  }

  /** Produce the next input for the given (snapshot) tick, or null while dead/unready. */
  think(tick: number): InputMsg | null {
    if (!this.map || !this.you) return null;
    const you = this.you;
    if (!you.alive) {
      // Stay quiet while dead; state machine restarts on respawn.
      this.state = 'ROAM';
      this.path = null;
      this.targetId = -1;
      return null;
    }

    const maxHp = this.cfg ? getKit(this.cfg, you.cls).maxHp : 100;
    const hpFrac = you.hp / maxHp;
    const tookDamage = this.prevHp >= 0 && you.hp < this.prevHp - 0.01;
    this.prevHp = you.hp;
    if (tookDamage && you.cls === 'fighter') {
      // Raise the shield for a beat while closing after eating an arrow.
      this.blockUntilTick = tick + 12;
    }

    // ---- FSM transitions
    const target = this.pickTarget(tick);
    const carrying = you.carried > 0;
    const sack = this.nearestSack();
    if (hpFrac < this.skill.fleeBelow) {
      this.state = 'FLEE';
    } else if (this.state === 'FLEE' && hpFrac <= this.skill.reengageAbove) {
      // Keep fleeing until healed past the hysteresis band.
    } else {
      const d = target ? Math.hypot(target.x - you.x, target.y - you.y) : Infinity;
      const fresh = target ? tick - target.lastSeenTick < 15 : false;
      // Carriers, on-duty bankers, and siegers only fight when cornered — the
      // job is worth more than a kill (commitment is what makes bank runs and
      // sieges happen at all in a 12-bot brawl). A sieger AT THROWING RANGE of
      // the target keep goes full tunnel-vision: keeps always have defenders
      // milling around, and breaking for every one of them is how sieges
      // never happen. Eating arrows at the wall is the price of the job.
      const siegeReadyEarly = this.siegeViable(tick);
      const atSiegePost =
        siegeReadyEarly &&
        (() => {
          const k = this.nearestEnemyKeep();
          if (!k) return false;
          const range = this.cfg?.firebomb.range ?? 7;
          return Math.hypot(k.x - you.x, k.y - you.y) < range + 2;
        })();
      const committed = carrying || this.bankerDuty(tick) || siegeReadyEarly;
      const engage = this.skill.engageRange * (atSiegePost ? 0.25 : committed ? 0.5 : 1);
      const townNear =
        carrying &&
        (() => {
          const t = this.nearestTown();
          return Math.hypot(t.x - you.x, t.y - you.y) <= this.skill.bankDetourRange;
        })();
      const ownKh = this.keepHpBySquad.get(this.mySquad) ?? 1;
      const exiled = ownKh <= 0;
      const alarmed = !exiled && tick - this.lastOwnAlarmTick < 300; // ~10s of urgency
      // A siege-ready aggressor has tunnel vision: only sacks practically on
      // the path (or underfoot) justify a detour.
      const siegeReady = siegeReadyEarly;
      const sackWorthIt =
        sack !== null && (!siegeReady || Math.hypot(sack.x - you.x, sack.y - you.y) < 6);
      if (target && fresh && d <= engage) {
        this.state = 'ATTACK';
      } else if (sack && sackWorthIt) {
        this.state = 'LOOT'; // also how exiles recover their spilled vault
      } else if (
        carrying &&
        (you.carried >= this.skill.bankNowAt || ((!target || townNear) && !siegeReady))
      ) {
        // A real load, nothing better to do, or walking past a town anyway.
        // Exception: an exiled banker saving for the rebuild HOLDS the gold.
        if (exiled && this.ownRebuilds > 0 && this.isBanker()) {
          this.state = 'REBUILD';
        } else {
          this.state = 'BANK';
        }
      } else if (exiled && this.ownRebuilds > 0 && this.isBanker()) {
        // The comeback is the banker's job: gather the spill, raise the keep.
        this.state = 'REBUILD';
      } else if (alarmed && !carrying) {
        this.state = 'DEFEND';
      } else if (this.bankerDuty(tick)) {
        // Duty outranks chasing: the banker LEAVES the fight — that's the role
        // (and the window it opens for the enemy is the M2 gameplay).
        if (this.state !== 'BANK') this.bankStartTick = tick; // entry only
        this.state = 'BANK';
      } else if (siegeReady) {
        // The aggressor walks PAST distant enemies — only a fresh threat
        // inside the committed engage radius (above) interrupts the siege.
        this.state = 'SIEGE';
      } else if (target && !carrying) {
        this.state = 'SEEK';
      } else {
        this.state = 'ROAM';
      }
    }

    switch (this.state) {
      case 'FLEE':
        return this.doFlee(tick);
      case 'ATTACK':
        return this.doAttack(tick, target!);
      case 'SEEK':
        return this.doSeek(tick, target!);
      case 'LOOT':
        return this.doLoot(tick, sack!);
      case 'BANK':
        return this.doBank(tick);
      case 'DEFEND':
        return this.doDefend(tick);
      case 'SIEGE':
        return this.doSiege(tick);
      case 'REBUILD':
        return this.doRebuild(tick);
      default:
        return this.doRoam(tick);
    }
  }

  /** Lowest-id squad bot = banker (bank runs, rebuilds). */
  private isBanker(): boolean {
    let lowest = Number.POSITIVE_INFINITY;
    for (const id of this.squadBotIds) if (id < lowest) lowest = id;
    return lowest === this.myId;
  }

  /** Highest-id squad bot = aggressor (the one who goes sieging). */
  private isAggressor(): boolean {
    let highest = -1;
    for (const id of this.squadBotIds) if (id > highest) highest = id;
    return highest === this.myId;
  }

  private siegeViable(tick: number): boolean {
    if (!this.isAggressor()) return false;
    // Let economies build first — a destroyed keep should spill something
    // worth fighting over (first quarter of the match is off-limits).
    const durationTicks = (this.cfg?.match.durationSec ?? 480) * this.tickRate;
    if (tick < durationTicks * 0.25) return false;
    const you = this.you!;
    // Pocket change rides along; a real load goes to the bank first.
    if (you.carried >= this.skill.bankNowAt) return false;
    const ownKh = this.keepHpBySquad.get(this.mySquad) ?? 1;
    // Out of bombs with no armory to refill at = no siege.
    if (you.bombs <= 0 && ownKh <= 0) return false;
    return this.nearestEnemyKeep() !== null;
  }

  private nearestEnemyKeep(): Waypoint | null {
    const you = this.you!;
    let best: Waypoint | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const [sq, pos] of this.keepPos) {
      if (sq === this.mySquad) continue;
      if ((this.keepHpBySquad.get(sq) ?? 1) <= 0) continue;
      const d = Math.hypot(pos.x - you.x, pos.y - you.y);
      if (d < bestD) {
        bestD = d;
        best = pos;
      }
    }
    return best;
  }

  /** Closest fresh enemy, with a bounty sweetener (hunt the rich) and a hard
   *  pull toward visible carriers (kill the bank run, take the sack). */
  private pickTarget(tick: number): TrackedEnemy | null {
    const you = this.you!;
    let best: TrackedEnemy | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const en of this.enemies.values()) {
      // Spawn etiquette: skip protected fresh spawns (they're worth 0 gold
      // anyway) — unless they hit us recently (self-defense) or picked up a
      // load (carrying gold makes anyone fair game).
      const protectedNow = tick < (this.freshUntil.get(en.id) ?? -1);
      const aggro = tick - (this.aggressors.get(en.id) ?? -1_000_000) < 90;
      if (protectedNow && !aggro && !en.carrying) continue;
      const d = Math.hypot(en.x - you.x, en.y - you.y);
      const staleness = (tick - en.lastSeenTick) / this.tickRate;
      const bounty = this.bounties.get(en.id) ?? 0;
      // Distance dominates; bounty shaves up to ~4 units of effective distance;
      // a gold carrier shaves 6 more — interception is the M2 counterplay.
      const score = d + staleness * 3 - Math.min(4, bounty / 60) - (en.carrying ? 6 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = en;
      }
    }
    if (best && this.targetId !== best.id) this.targetId = best.id;
    return best;
  }

  /** True when this bot is the squad's designated banker and the vault is ripe. */
  private bankerDuty(tick: number): boolean {
    if (tick < this.bankRetryAt) return false;
    if (this.ownWd < this.skill.bankRunAt) return false;
    let lowest = Number.POSITIVE_INFINITY;
    for (const id of this.squadBotIds) if (id < lowest) lowest = id;
    return lowest === this.myId;
  }

  private nearestSack(): SackSnap | null {
    const you = this.you!;
    let best: SackSnap | null = null;
    let bestD = this.skill.lootRange;
    for (const s of this.sacks) {
      const d = Math.hypot(s.x - you.x, s.y - you.y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  private nearestTown(): Waypoint {
    const you = this.you!;
    let best: Waypoint = this.map!.towns[0] ?? this.keep ?? { x: you.x, y: you.y };
    let bestD = Number.POSITIVE_INFINITY;
    for (const t of this.map!.towns) {
      const d = Math.hypot(t.x - you.x, t.y - you.y);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- behaviors

  private doRoam(tick: number): InputMsg {
    if (!this.path || this.wpIdx >= this.path.length) {
      if (tick - this.lastPathThinkTick >= THINK_PATH_EVERY_TICKS) {
        this.lastPathThinkTick = tick;
        const t = randomWalkableTile(this.map!, this.rng, this.you!.x, this.you!.y, 15);
        if (t) this.setPath(tick, t);
      }
    }
    const move = this.followPath(tick);
    return this.input(tick, move.mx, move.my, move.mx || 1, move.my, 0);
  }

  private doSeek(tick: number, target: TrackedEnemy): InputMsg {
    // Re-path toward the (possibly stale) target position at the path cadence.
    if (tick - this.lastPathThinkTick >= THINK_PATH_EVERY_TICKS) {
      this.lastPathThinkTick = tick;
      const goal = { x: target.x, y: target.y };
      if (!this.pathGoal || Math.hypot(goal.x - this.pathGoal.x, goal.y - this.pathGoal.y) > 2) {
        this.setPath(tick, goal);
      }
    }
    const move = this.followPath(tick);
    const aim = this.aimAt(target, false);
    return this.input(tick, move.mx, move.my, aim.ax, aim.ay, 0);
  }

  private doAttack(tick: number, target: TrackedEnemy): InputMsg {
    const you = this.you!;
    const map = this.map!;
    const dx = target.x - you.x;
    const dy = target.y - you.y;
    const dist = Math.hypot(dx, dy);
    const clearShot = tileRayClear(map, you.x, you.y, target.x, target.y);
    let b = 0;

    // Fighting on our own doorstep while on banking business? Keep the vault
    // trickle running through the brawl — withdrawing never requires stillness.
    if ((you.carried > 0 || this.bankerDuty(tick)) && this.keep) {
      const kd = Math.hypot(this.keep.x - you.x, this.keep.y - you.y);
      if (kd <= (this.cfg?.banking.interactRadius ?? 2.5)) b |= BTN_INTERACT;
    }

    if (you.cls === 'ranger') {
      // Kite: hold the band, strafe inside it, lead the target, loose on LOS.
      const aim = this.aimAt(target, true);
      let mx = 0;
      let my = 0;
      if (!clearShot || dist > this.skill.bandMax) {
        const m = this.moveToward(tick, target.x, target.y);
        mx = m.mx;
        my = m.my;
      } else if (dist < this.skill.bandMin) {
        mx = -dx / dist;
        my = -dy / dist;
        // Back-dash if they're right on top of us.
        if (dist < 3 && you.dashCd <= 0) b |= 4;
      } else {
        const strafe = this.strafeDir(tick, dx / dist, dy / dist);
        mx = strafe.x;
        my = strafe.y;
      }
      if (clearShot && dist <= this.skill.bandMax + 2 && you.atkCd <= 0) b |= 1;
      return this.input(tick, mx, my, aim.ax, aim.ay, b);
    }

    // Fighter: close, dash the last gap, swing at reach, shield while eating fire.
    const aim = this.aimAt(target, false);
    const m = clearShot
      ? { mx: dx / (dist || 1), my: dy / (dist || 1) }
      : this.moveToward(tick, target.x, target.y);
    if (dist <= 3.0 && clearShot) {
      b |= 1; // swing (slightly early — the windup travel closes the rest)
    } else if (
      clearShot &&
      dist > 3 &&
      dist < 7 &&
      you.dashCd <= 0 &&
      rngFloat(this.rng) < this.skill.dashAggression
    ) {
      b |= 4; // gap-close dash
    } else if (tick < this.blockUntilTick && dist > 2.5) {
      b |= 2; // advance behind the shield
    }
    return this.input(tick, m.mx, m.my, aim.ax, aim.ay, b);
  }

  /** Walk onto a visible sack — pickup is automatic on contact. */
  private doLoot(tick: number, sack: SackSnap): InputMsg {
    const move = this.moveToward(tick, sack.x, sack.y);
    // Eyes on the surroundings, not the ground: face the nearest known enemy.
    const threat = this.pickTarget(tick);
    const aim = threat ? this.aimAt(threat, false) : { ax: move.mx || 1, ay: move.my };
    return this.input(tick, move.mx, move.my, aim.ax, aim.ay, 0);
  }

  /**
   * The banking run. Two legs, keyed off what's on our back:
   *   empty-handed → walk to the keep, hold interact, let the vault trickle
   *   load us until it stops (reserve floor or dry) — then the run leg:
   *   walk to the nearest town, stand still inside the circle, hold interact
   *   through the channel. Damage/movement breaking the channel is server
   *   truth; we just keep standing and holding until carried hits zero.
   */
  private doBank(tick: number): InputMsg {
    const you = this.you!;
    const interactR = (this.cfg?.banking.interactRadius ?? 2.5) * 0.75;
    // Thinks run every snapshot (~2 ticks); a bigger gap means a fight or a
    // flee interleaved — the "vault is dry" clock must restart from scratch.
    if (tick - this.lastBankTick > 4) this.atKeepSince = -1;
    this.lastBankTick = tick;

    const home = this.keep ?? { x: you.x, y: you.y };
    const town = this.nearestTown();
    const dHome = Math.hypot(home.x - you.x, home.y - you.y);
    const dTown = Math.hypot(town.x - you.x, town.y - you.y);

    // Withdraw leg while: mid-trickle, or on duty and underloaded — unless
    // we're already carrying and the town is the nearer errand (deposit first,
    // then come back for more).
    const underloaded = you.carried < this.skill.carryTarget;
    const withdrawLeg =
      underloaded &&
      (this.stillLoading(tick) || (this.bankerDuty(tick) && (you.carried <= 0 || dHome <= dTown)));

    if (withdrawLeg) {
      if (dHome > interactR) {
        this.atKeepSince = -1;
        // Endless dry approach = duty triggered on stale info; give up gracefully.
        if (you.carried <= 0 && tick - this.bankStartTick > 600) {
          this.bankRetryAt = tick + 300;
          return this.doRoam(tick);
        }
        const move = this.moveToward(tick, home.x, home.y);
        return this.input(tick, move.mx, move.my, move.mx || 1, move.my, 0);
      }
      if (this.atKeepSince < 0) this.atKeepSince = tick;
      // A sustained stretch of holding interact with zero yield = the vault is
      // actually dry (the 2Hz score was stale). Back off so duty re-arms later.
      if (you.carried <= 0 && tick - this.atKeepSince > 60) {
        this.bankRetryAt = tick + 450;
        this.atKeepSince = -1;
        return this.doRoam(tick);
      }
      return this.input(tick, 0, 0, 1, 0, BTN_INTERACT);
    }

    if (you.carried <= 0) return this.doRoam(tick); // nothing to deposit after all

    // ---- run + deposit leg
    const threat = this.pickTarget(tick);
    if (dTown > interactR) {
      const move = this.moveToward(tick, town.x, town.y);
      const aim = threat ? this.aimAt(threat, false) : { ax: move.mx || 1, ay: move.my };
      return this.input(tick, move.mx, move.my, aim.ax, aim.ay, 0);
    }
    // Channel: stand still, hold interact, watch the treeline.
    const aim = threat ? this.aimAt(threat, false) : { ax: 1, ay: 0 };
    return this.input(tick, 0, 0, aim.ax, aim.ay, BTN_INTERACT);
  }

  /** Run home and hold the courtyard — ATTACK preempts handle the actual fight. */
  private doDefend(tick: number): InputMsg {
    const you = this.you!;
    const home = this.keep ?? { x: you.x, y: you.y };
    const d = Math.hypot(home.x - you.x, home.y - you.y);
    if (d > 3.5) {
      const move = this.moveToward(tick, home.x, home.y);
      let b = 0;
      if (you.dashCd <= 0 && (move.mx !== 0 || move.my !== 0)) b |= 4; // sprint home
      return this.input(tick, move.mx, move.my, move.mx || 1, move.my, b);
    }
    // On station: circle the keep so we're not a standing target.
    const strafe = this.strafeDir(tick, (you.x - home.x) / (d || 1), (you.y - home.y) / (d || 1));
    const threat = this.pickTarget(tick);
    const aim = threat ? this.aimAt(threat, false) : { ax: strafe.x || 1, ay: strafe.y };
    return this.input(tick, strafe.x, strafe.y, aim.ax, aim.ay, 0);
  }

  /** The aggressor's job: walk to a living enemy keep and burn it down,
   *  with restock trips home when the satchel runs dry. */
  private doSiege(tick: number): InputMsg {
    const you = this.you!;
    const range = this.cfg?.firebomb.range ?? 7;

    if (you.bombs <= 0) {
      // Armory run: restock is automatic inside our own keep circle.
      const home = this.keep ?? { x: you.x, y: you.y };
      const d = Math.hypot(home.x - you.x, home.y - you.y);
      if (d > 1.6) {
        const move = this.moveToward(tick, home.x, home.y);
        return this.input(tick, move.mx, move.my, move.mx || 1, move.my, 0);
      }
      return this.input(tick, 0, 0, 1, 0, 0); // stand a beat; restock is instant
    }

    const target = this.nearestEnemyKeep();
    if (!target) return this.doRoam(tick);
    const dx = target.x - you.x;
    const dy = target.y - you.y;
    const d = Math.hypot(dx, dy);
    if (d > range - 0.5) {
      // Bombs LOB — no sightline needed, just proximity. Approach.
      const move = this.moveToward(tick, target.x, target.y);
      return this.input(tick, move.mx, move.my, move.mx || 1, move.my, 0);
    }
    // In range: ORBIT the keep while lobbing — a moving bombardier survives
    // the defenders' arrows far longer than a standing one. Pressing only
    // while the cooldown is ready gives the edge-trigger clean rising edges.
    const strafe = this.strafeDir(tick, dx / (d || 1), dy / (d || 1));
    const b = you.bombCd <= 0 ? BTN_BOMB : 0;
    return this.input(tick, strafe.x, strafe.y, dx / (d || 1), dy / (d || 1), b);
  }

  /** The exile comeback: recover the spilled vault, then raise a new keep. */
  private doRebuild(tick: number): InputMsg {
    const you = this.you!;
    const cost = this.cfg?.keep.rebuildCost ?? 250;
    const interactR = (this.cfg?.banking.interactRadius ?? 2.5) * 0.6;

    if (you.carried < cost) {
      // Head for the ruin — the spill sacks become visible en route and the
      // LOOT branch (which outranks REBUILD) scoops them automatically.
      const ruin = this.ownRuin ?? this.keep ?? { x: you.x, y: you.y };
      const move = this.moveToward(tick, ruin.x, ruin.y);
      return this.input(tick, move.mx, move.my, move.mx || 1, move.my, 0);
    }

    const site = this.nearestUnoccupiedSite();
    if (!site) return this.doRoam(tick);
    const d = Math.hypot(site.x - you.x, site.y - you.y);
    if (d > interactR) {
      const move = this.moveToward(tick, site.x, site.y);
      return this.input(tick, move.mx, move.my, move.mx || 1, move.my, 0);
    }
    // Channel: stand still, hold interact, pray.
    const threat = this.pickTarget(tick);
    const aim = threat ? this.aimAt(threat, false) : { ax: 1, ay: 0 };
    return this.input(tick, 0, 0, aim.ax, aim.ay, BTN_INTERACT);
  }

  private nearestUnoccupiedSite(): Waypoint | null {
    const you = this.you!;
    let best: Waypoint | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const site of this.map!.keeps) {
      let occupied = false;
      for (const [sq, pos] of this.keepPos) {
        if ((this.keepHpBySquad.get(sq) ?? 1) <= 0) continue;
        if (Math.hypot(pos.x - site.x, pos.y - site.y) < 2) {
          occupied = true;
          break;
        }
      }
      if (occupied) continue;
      const d = Math.hypot(site.x - you.x, site.y - you.y);
      if (d < bestD) {
        bestD = d;
        best = site;
      }
    }
    return best;
  }

  /** True while the keep trickle moved gold onto us within the last 12 ticks. */
  private stillLoading(tick: number): boolean {
    const you = this.you!;
    if (!this.keep) return false;
    const d = Math.hypot(this.keep.x - you.x, this.keep.y - you.y);
    if (d > (this.cfg?.banking.interactRadius ?? 2.5)) return false;
    return tick - this.carriedChangedTick < 12;
  }

  private doFlee(tick: number): InputMsg {
    const you = this.you!;
    const home = this.keep ?? { x: you.x, y: you.y };
    if (tick - this.lastPathThinkTick >= THINK_PATH_EVERY_TICKS) {
      this.lastPathThinkTick = tick;
      if (!this.pathGoal || Math.hypot(home.x - this.pathGoal.x, home.y - this.pathGoal.y) > 2) {
        this.setPath(tick, home);
      }
    }
    const move = this.followPath(tick);
    let b = 0;
    if (you.dashCd <= 0 && (move.mx !== 0 || move.my !== 0)) b |= 4; // dash home
    // Face backwards (shield the pursuer if fighter).
    const nearest = this.pickTarget(tick);
    let ax = -move.mx || 1;
    let ay = -move.my;
    if (nearest) {
      const a = this.aimAt(nearest, false);
      ax = a.ax;
      ay = a.ay;
      if (you.cls === 'fighter') b |= 2;
    }
    return this.input(tick, move.mx, move.my, ax, ay, b);
  }

  // ---------------------------------------------------------------- helpers

  /** Intercept-lead aim with gaussian error (rangers lead; melee aims direct). */
  private aimAt(target: TrackedEnemy, lead: boolean): { ax: number; ay: number } {
    const you = this.you!;
    let ax = target.x - you.x;
    let ay = target.y - you.y;
    if (lead) {
      const arrowSpeed = this.cfg?.classes.ranger.bow?.speed ?? 14;
      const sol = solveIntercept(
        you.x,
        you.y,
        target.x,
        target.y,
        target.vx,
        target.vy,
        arrowSpeed,
      );
      if (sol) {
        ax = sol.ax;
        ay = sol.ay;
      }
    }
    const l = Math.hypot(ax, ay);
    if (l < 1e-6) return { ax: 1, ay: 0 };
    ax /= l;
    ay /= l;
    // Gaussian angle error via Box–Muller on the bot's own seeded rng.
    const u1 = Math.max(1e-12, rngFloat(this.rng));
    const u2 = rngFloat(this.rng);
    const err = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * this.skill.aimErrorStd;
    const cos = Math.cos(err);
    const sin = Math.sin(err);
    return { ax: ax * cos - ay * sin, ay: ax * sin + ay * cos };
  }

  /** Perpendicular strafe that flips direction periodically. */
  private strafeDir(tick: number, nx: number, ny: number): { x: number; y: number } {
    if (tick >= this.strafeFlipAt) {
      this.strafeFlipAt = tick + STRAFE_FLIP_TICKS + rngInt(this.rng, 0, 12);
      if (rngFloat(this.rng) < 0.5) this.strafeSign = -this.strafeSign;
    }
    return { x: -ny * this.strafeSign, y: nx * this.strafeSign };
  }

  /** Direct steer when close & WALKABLE in a straight line; A* otherwise.
   *  (Walk-clear, not vision-clear: water is see-through but not crossable —
   *  a vision ray marches bots into the river bank forever.) */
  private moveToward(tick: number, gx: number, gy: number): { mx: number; my: number } {
    const you = this.you!;
    if (walkRayClear(this.map!, you.x, you.y, gx, gy)) {
      const dx = gx - you.x;
      const dy = gy - you.y;
      const l = Math.hypot(dx, dy);
      if (l < 1e-6) return { mx: 0, my: 0 };
      return { mx: dx / l, my: dy / l };
    }
    if (tick - this.lastPathThinkTick >= THINK_PATH_EVERY_TICKS) {
      this.lastPathThinkTick = tick;
      if (!this.pathGoal || Math.hypot(gx - this.pathGoal.x, gy - this.pathGoal.y) > 2) {
        this.setPath(tick, { x: gx, y: gy });
      }
    }
    return this.followPath(tick);
  }

  private setPath(tick: number, goal: Waypoint): void {
    const you = this.you!;
    this.pathGoal = goal;
    this.path = findPath(
      this.map!,
      Math.floor(you.x),
      Math.floor(you.y),
      Math.floor(goal.x),
      Math.floor(goal.y),
    );
    this.wpIdx = 0;
    this.stallTick = tick;
    this.stallX = you.x;
    this.stallY = you.y;
  }

  private followPath(tick: number): { mx: number; my: number } {
    const you = this.you!;
    if (!this.path || this.wpIdx >= this.path.length) return { mx: 0, my: 0 };

    // Stall detection: barely moved over the window ⇒ path blocked by a body.
    if (tick - this.stallTick >= STALL_WINDOW_TICKS) {
      const moved = Math.hypot(you.x - this.stallX, you.y - this.stallY);
      if (moved < STALL_MIN_MOVE) {
        this.path = null;
        this.pathGoal = null;
        return { mx: 0, my: 0 };
      }
      this.stallTick = tick;
      this.stallX = you.x;
      this.stallY = you.y;
    }

    let wp = this.path[this.wpIdx]!;
    let dx = wp.x - you.x;
    let dy = wp.y - you.y;
    if (dx * dx + dy * dy < WAYPOINT_REACHED * WAYPOINT_REACHED) {
      this.wpIdx++;
      if (this.wpIdx >= this.path.length) return { mx: 0, my: 0 };
      wp = this.path[this.wpIdx]!;
      dx = wp.x - you.x;
      dy = wp.y - you.y;
    }
    const l = Math.sqrt(dx * dx + dy * dy);
    if (l < 1e-6) return { mx: 0, my: 0 };
    return { mx: dx / l, my: dy / l };
  }

  private input(tick: number, mx: number, my: number, ax: number, ay: number, b: number): InputMsg {
    const l = Math.hypot(ax, ay);
    return {
      t: 'input',
      seq: ++this.seq,
      tick,
      mx,
      my,
      ax: l > 1e-6 ? ax / l : 1,
      ay: l > 1e-6 ? ay / l : 0,
      b,
    };
  }
}
