import type { ClassId, GameConfig } from '../config';
import { getKit, secToTicks } from '../config';
import type { MapData } from '../map/types';
import type { RngState } from '../math/rng';
import { createRng } from '../math/rng';
import { distSq } from '../math/vec2';
import { placeProps } from './systems/props';

export type PlayerId = number;

/** One tick's worth of intent from a player. Everything the sim knows about a client. */
export interface InputCmd {
  /** Move direction, each axis in [-1, 1]; normalized inside movement. */
  mx: number;
  my: number;
  /** Aim unit vector (used as data — never re-derived via trig in the sim). */
  ax: number;
  ay: number;
  /** Button bitmask: 1 fire, 2 block, 4 dash, 8 interact, 16 bomb,
   *  32 build wall, 64 build gate, 128 build tower, 256 build trap
   *  (gate/tower/trap Engineer-only). */
  b: number;
}

export const BTN_FIRE = 1;
export const BTN_BLOCK = 2;
export const BTN_DASH = 4;
export const BTN_INTERACT = 8;
export const BTN_BOMB = 16;
export const BTN_BUILD = 32;
export const BTN_BUILD_GATE = 64;
export const BTN_BUILD_TOWER = 128;
export const BTN_BUILD_TRAP = 256;
/** Every defined button — THE server-side sanitize mask. A new BTN_* must be
 *  OR'd in here or the trust boundary silently strips it (the M4 s4 trap
 *  button shipped dead for an hour because a hardcoded 0xff didn't cover
 *  bit 9 — never again). */
export const BTN_ALL =
  BTN_FIRE |
  BTN_BLOCK |
  BTN_DASH |
  BTN_INTERACT |
  BTN_BOMB |
  BTN_BUILD |
  BTN_BUILD_GATE |
  BTN_BUILD_TOWER |
  BTN_BUILD_TRAP;

// Structure kinds (M4): wall blocks everyone; gate is a door for the owning
// squad's BODIES only (vision/arrows blocked for all); tower is a static
// extra viewer for its squad — information, never damage. Trap (s4) is the
// inverse of all three: blocks NOTHING (movement, vision, arrows), is never
// serialized to enemy squads, and consumes itself to snare the first enemy
// who steps on it once armed.
export const STRUCT_WALL = 0;
export const STRUCT_GATE = 1;
export const STRUCT_TOWER = 2;
export const STRUCT_TRAP = 3;
export const STRUCT_TREE = 4;
export const STRUCT_HUT = 5;

/** Owner id for countryside props: nobody's squad, everybody's target. Never
 *  matches an attacker squad (bombs/melee spare own-squad structures) and
 *  never reads as "own" in fog filtering — both fall out of the comparison. */
export const NEUTRAL_SQUAD = -1;
export type StructureKind = 0 | 1 | 2 | 3 | 4 | 5;

export const IDLE_INPUT: InputCmd = Object.freeze({ mx: 0, my: 0, ax: 1, ay: 0, b: 0 });

export type AttackPhase = 0 | 1 | 2 | 3; // idle | windup | active | recovery
export const ATK_IDLE = 0;
export const ATK_WINDUP = 1;
export const ATK_ACTIVE = 2;
export const ATK_RECOVERY = 3;

// Match phases, in order. Placement (M4): squads spawn at their map corners
// and claim keep sites; countdown: free-move warmup at the claimed keeps'
// final layout is pending — goLive teleports and hard-resets. Zero-duration
// phases collapse within a single stepPhase call, so smoke configs with
// placement 0 + countdown 0 go live on tick 1 exactly as before.
export type MatchPhase = 0 | 1 | 2 | 3; // placement | countdown | live | ended
export const PHASE_PLACEMENT = 0;
export const PHASE_COUNTDOWN = 1;
export const PHASE_LIVE = 2;
export const PHASE_ENDED = 3;

export interface Player {
  id: PlayerId;
  squad: number;
  name: string;
  bot: boolean;
  cls: ClassId;
  /** Class applied at the next respawn (class switching while dead). */
  pendingCls: ClassId;

  // ---- MoveState (the prediction kernel owns these; see systems/movement.ts)
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Ticks remaining in the active dash (0 = not dashing). */
  dashTicks: number;
  dashDx: number;
  dashDy: number;
  /** Cooldown ticks until the next dash. */
  dashCd: number;
  /** Previous tick's button mask — dash is edge-triggered inside the kernel. */
  prevB: number;
  /** Ticks left snared by a trap (0 = free). The kernel zeroes walk speed and
   *  blocks dash starts while set — predicted, so the snare doesn't rubber-band. */
  rootTicks: number;

  // ---- combat
  hp: number;
  alive: boolean;
  /** Tick this player respawns on (only meaningful while dead). */
  respawnAtTick: number;
  /** Tick of the last spawn/respawn (fresh-spawn anti-farm + survival bounty). */
  spawnedAtTick: number;
  /** Tick damage was last taken (regen delay + suicide detection). */
  lastDamagedTick: number;
  /** attackerId -> tick of their last damage on us (assist credit). */
  recentDamagers: Map<PlayerId, number>;
  /** Attack state machine: 0 idle, 1 windup, 2 active, 3 recovery. */
  atkPhase: AttackPhase;
  /** Ticks remaining in the current attack phase. */
  atkTicks: number;
  /** Cooldown ticks until the next attack may start. */
  atkCd: number;
  /** Aim locked at windup start (melee swings don't track). */
  atkDirX: number;
  atkDirY: number;
  /** Victims already hit by the current swing (one hit per swing). */
  atkHitIds: PlayerId[];

  // ---- economy
  bounty: number;
  kills: number;
  deaths: number;
  assists: number;
  /** victimId -> {count, lastTick} for diminishing repeat-kill rewards. */
  repeatKills: Map<PlayerId, { count: number; lastTick: number }>;
  /** Gold physically carried (withdrawn or looted). Drops as a sack on death. */
  carried: number;
  /** Deposit channel progress in ticks (0 = not channeling). */
  bankTicks: number;
  /** Emergency-rebuild channel progress in ticks (0 = not channeling). */
  rebuildTicks: number;
  /** Firebombs on hand (restocked inside your own keep circle). */
  bombs: number;
  /** Cooldown ticks until the next bomb throw. */
  bombCd: number;
  /** Previous tick's bomb button — throws are edge-triggered. */
  prevBombB: number;
  /** Previous tick's build button — placements are edge-triggered. */
  prevBuildB: number;
  /** Cooldown ticks until the next wall placement. */
  buildCd: number;
  /** Keep-site claim channel progress in ticks (placement phase only). */
  claimTicks: number;
  /** Site index the claim channel is targeting (-1 idle). Progress is per
   *  site: retargeting resets claimTicks (see claims.ts). */
  claimSiteIdx: number;

  /** Last applied input; server reuses it when a fresh one hasn't arrived (TCP delay). */
  input: InputCmd;
}

export interface Projectile {
  id: number;
  owner: PlayerId;
  squad: number;
  x: number;
  y: number;
  /** Unit direction (from the shooter's sanitized aim — already normalized). */
  dx: number;
  dy: number;
  speed: number;
  damage: number;
  radius: number;
  ticksLeft: number;
  bornTick: number;
  /** Damage multiplier vs countryside props, snapshotted at fire time from
   *  the shooter's class (arrow vs crossbow bolt) — the shooter may die or
   *  swap class mid-flight, the projectile keeps its nature. */
  propFactor: number;
}

export interface SquadState {
  id: number;
  /** This squad's keep site (moves on an emergency rebuild). PROVISIONAL
   *  (nearest-to-spawn) until the placement phase finalizes it. */
  keepX: number;
  keepY: number;
  /** Index into map.keeps once claimed/assigned; -1 while placement is open.
   *  Inert after the placement phase (rebuilds move keepX/Y, not this). */
  claimedSite: number;
  /** Structure hit points; <= 0 means destroyed (no respawns, vault spilled). */
  keepHp: number;
  /** Emergency rebuilds remaining this match (starts at 1). */
  rebuildsLeft: number;
  /** All members dead with no keep — out of the match, spectating. */
  eliminated: boolean;
  /** Tick of the last under-attack alarm sent to this squad (throttling). */
  lastAlarmTick: number;
  /** Gold in the keep vault. ONLY systems/economy.ts mutates this. */
  keepGold: number;
  /** Gold banked at towns — safe forever, THE score. ONLY economy.ts mutates. */
  bankedGold: number;
  /** Total gold ever minted to this squad; keeps the withdraw reserve honest. */
  lifetimeGold: number;
  /** Build-supply pool (a separate resource from gold — never scores). Fed by a
   *  living keep, spent into structures; a pure sink (no refunds). */
  supply: number;
  /** Total supply ever generated to this squad (supply ≤ supplyMinted always). */
  supplyMinted: number;
}

/** A lobbed firebomb in flight; resolves into a blast at landTick. */
export interface Bomb {
  id: number;
  owner: PlayerId;
  squad: number;
  x: number;
  y: number;
  /** Landing point (locked at throw — the lob is committed, dodge the circle). */
  tx: number;
  ty: number;
  landTick: number;
  bornTick: number;
}

/** Dropped carried gold. Sits on the ground until any squad walks over it. */
export interface LootSack {
  id: number;
  x: number;
  y: number;
  gold: number;
  bornTick: number;
}

/** A placed structure occupying one grid tile (tx,ty); center at (tx+.5, ty+.5).
 *  Walls/gates/towers block movement and vision while hp > 0; traps block
 *  nothing. Leaves the world when hp hits 0 (or, for traps, on trigger). */
export interface Structure {
  id: number;
  kind: StructureKind;
  squad: number;
  /** Who placed it — trap kills credit the builder (kill gold + bounty). */
  by: PlayerId;
  tx: number;
  ty: number;
  hp: number;
  maxHp: number;
  /** Tick it was placed — traps arm cfg.build.trap.armSec after this. */
  bornTick: number;
}

export interface World {
  tick: number;
  rng: RngState;
  nextId: number;
  phase: MatchPhase;
  /** Tick the current phase ends (countdown→live, live→ended, ended→restart). */
  phaseEndsTick: number;
  /** Winning squad ids, set when the match ends (ties possible). */
  winners: number[];
  /** Total gold ever minted. Invariant: equals the sum over all gold pools. */
  goldMinted: number;
  players: Map<PlayerId, Player>;
  projectiles: Map<number, Projectile>;
  sacks: Map<number, LootSack>;
  bombs: Map<number, Bomb>;
  structures: Map<number, Structure>;
  squads: SquadState[];
}

/**
 * Deterministically pair each squad with its nearest unclaimed keep site.
 * Greedy by squad index — stable, map-driven, and replay-independent.
 */
export function assignKeeps(map: MapData, squads: number): Array<{ x: number; y: number }> {
  const taken = new Set<number>();
  const out: Array<{ x: number; y: number }> = [];
  for (let s = 0; s < squads; s++) {
    const spawn = map.spawns[s] ?? map.spawns[0]!;
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let k = 0; k < map.keeps.length; k++) {
      if (taken.has(k)) continue;
      const d = distSq(spawn.x, spawn.y, map.keeps[k]!.x, map.keeps[k]!.y);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    // More squads than keeps: reuse the nearest keep rather than crash.
    const site = best >= 0 ? map.keeps[best]! : map.keeps[s % map.keeps.length]!;
    if (best >= 0) taken.add(best);
    out.push({ x: site.x, y: site.y });
  }
  return out;
}

// (value import at the bottom of the dependency chain: props.ts pulls only
// types and kind constants back from this module, and placeProps runs at
// call time — the cycle is initialization-safe by construction.)
// eslint-disable-next-line import/no-cycle
export function createWorld(seed: number, cfg: GameConfig, map: MapData): World {
  const keeps = assignKeeps(map, cfg.match.squads);
  const squads: SquadState[] = [];
  for (let i = 0; i < cfg.match.squads; i++) {
    squads.push({
      id: i,
      keepX: keeps[i]!.x,
      keepY: keeps[i]!.y,
      claimedSite: -1,
      keepHp: cfg.keep.maxHp,
      rebuildsLeft: 1,
      eliminated: false,
      lastAlarmTick: -1_000_000,
      keepGold: 0,
      bankedGold: 0,
      lifetimeGold: 0,
      supply: cfg.build.supplyStart,
      supplyMinted: cfg.build.supplyStart,
    });
  }
  const world: World = {
    tick: 0,
    rng: createRng(seed),
    nextId: 1,
    phase: PHASE_PLACEMENT,
    phaseEndsTick: secToTicks(cfg, cfg.match.placementSec),
    winners: [],
    goldMinted: 0,
    players: new Map(),
    projectiles: new Map(),
    sacks: new Map(),
    bombs: new Map(),
    structures: new Map(),
    squads,
  };
  // Countryside props draw from a FORKED stream off the same seed — world.rng
  // never moves, and replays/restarts re-derive the identical countryside by
  // re-running this very function.
  placeProps(world, cfg, map, seed);
  return world;
}

/** Ring of offsets around a spawn point so squadmates never stack exactly. */
export const SPAWN_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.9, 0],
  [0, 0.9],
  [-0.9, 0],
  [0, -0.9],
  [0.9, 0.9],
];

export function spawnPlayer(
  world: World,
  cfg: GameConfig,
  squad: number,
  name: string,
  bot: boolean,
  cls: ClassId,
  x: number,
  y: number,
): Player {
  const p: Player = {
    id: world.nextId++,
    squad,
    name,
    bot,
    cls,
    pendingCls: cls,
    x,
    y,
    vx: 0,
    vy: 0,
    dashTicks: 0,
    dashDx: 0,
    dashDy: 0,
    dashCd: 0,
    prevB: 0,
    rootTicks: 0,
    hp: getKit(cfg, cls).maxHp,
    alive: true,
    respawnAtTick: 0,
    spawnedAtTick: world.tick,
    lastDamagedTick: -1_000_000,
    recentDamagers: new Map(),
    atkPhase: ATK_IDLE,
    atkTicks: 0,
    atkCd: 0,
    atkDirX: 1,
    atkDirY: 0,
    atkHitIds: [],
    bounty: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    repeatKills: new Map(),
    carried: 0,
    bankTicks: 0,
    rebuildTicks: 0,
    bombs: cfg.firebomb.carried,
    bombCd: 0,
    prevBombB: 0,
    prevBuildB: 0,
    buildCd: 0,
    claimTicks: 0,
    claimSiteIdx: -1,
    input: { ...IDLE_INPUT },
  };
  world.players.set(p.id, p);
  return p;
}

/**
 * Stable serialization for determinism hashing and replay verification.
 * Everything the sim reads or writes must appear here — a field missing from
 * the hash is a field nondeterminism can hide in.
 */
export function serializeWorld(world: World): string {
  const players = [...world.players.values()].map((p) => ({
    id: p.id,
    squad: p.squad,
    cls: p.cls,
    pcls: p.pendingCls,
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    dt: p.dashTicks,
    ddx: p.dashDx,
    ddy: p.dashDy,
    dcd: p.dashCd,
    pb: p.prevB,
    rot: p.rootTicks,
    hp: p.hp,
    al: p.alive,
    rat: p.respawnAtTick,
    sat: p.spawnedAtTick,
    ldt: p.lastDamagedTick,
    rd: [...p.recentDamagers.entries()],
    ap: p.atkPhase,
    at: p.atkTicks,
    acd: p.atkCd,
    adx: p.atkDirX,
    ady: p.atkDirY,
    ah: p.atkHitIds,
    bo: p.bounty,
    k: p.kills,
    d: p.deaths,
    a: p.assists,
    rk: [...p.repeatKills.entries()].map(([v, r]) => [v, r.count, r.lastTick]),
    cg: p.carried,
    bt: p.bankTicks,
    rt: p.rebuildTicks,
    bm: p.bombs,
    bcd: p.bombCd,
    pbb: p.prevBombB,
    pvb: p.prevBuildB,
    blc: p.buildCd,
    ct: p.claimTicks,
    csi: p.claimSiteIdx,
  }));
  const projectiles = [...world.projectiles.values()].map((pr) => ({
    id: pr.id,
    ow: pr.owner,
    sq: pr.squad,
    x: pr.x,
    y: pr.y,
    dx: pr.dx,
    dy: pr.dy,
    sp: pr.speed,
    dm: pr.damage,
    r: pr.radius,
    tl: pr.ticksLeft,
    bt: pr.bornTick,
    pf: pr.propFactor,
  }));
  const sacks = [...world.sacks.values()].map((s) => ({
    id: s.id,
    x: s.x,
    y: s.y,
    g: s.gold,
    bt: s.bornTick,
  }));
  const bombs = [...world.bombs.values()].map((b) => ({
    id: b.id,
    ow: b.owner,
    sq: b.squad,
    x: b.x,
    y: b.y,
    tx: b.tx,
    ty: b.ty,
    lt: b.landTick,
    bt: b.bornTick,
  }));
  const structures = [...world.structures.values()].map((s) => ({
    id: s.id,
    k: s.kind,
    sq: s.squad,
    by: s.by,
    tx: s.tx,
    ty: s.ty,
    hp: s.hp,
    mh: s.maxHp,
    bt: s.bornTick,
  }));
  const squads = world.squads.map((s) => ({
    id: s.id,
    kx: s.keepX,
    ky: s.keepY,
    cs: s.claimedSite,
    kh: s.keepHp,
    rb: s.rebuildsLeft,
    el: s.eliminated,
    lat: s.lastAlarmTick,
    g: s.keepGold,
    bk: s.bankedGold,
    lt: s.lifetimeGold,
    sup: s.supply,
    sm: s.supplyMinted,
  }));
  return JSON.stringify({
    tick: world.tick,
    rng: world.rng.s,
    nextId: world.nextId,
    phase: world.phase,
    pet: world.phaseEndsTick,
    win: world.winners,
    minted: world.goldMinted,
    players,
    projectiles,
    sacks,
    bombs,
    structures,
    squads,
  });
}

/** FNV-1a hash of the serialized world — the determinism fingerprint. */
export function hashWorld(world: World): string {
  const s = serializeWorld(world);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
