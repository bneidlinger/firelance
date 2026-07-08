import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BotBrain } from '@bots/brain';
import { LocalBotDriver } from '@bots/localdriver';
import { getConfigPreset, getKit, type GameConfig } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { isWalkBlocked } from '@shared/map/types';
import type { SimEvent } from '@shared/sim/events';
import { hashWorld } from '@shared/sim/world';
import { totalGoldInWorld } from '@shared/sim/systems/economy';
import { Match } from './match';
import { replayToHash } from './replay';
import { runTurboTicks } from './ticker';

// In-process match harness: Match + N BotBrains over LocalTransport, driven by
// the turbo ticker. A 10-minute match runs in seconds of wall time; invariants
// run EVERY tick (gold conservation is the crown jewel) and a full
// replay-vs-live hash comparison runs on every invocation. On violation the
// replay dumps to replays/ for offline reproduction. This is the
// autonomous-verification workhorse.

export interface HarnessOpts {
  bots: number;
  simSeconds: number;
  seed: number;
  cfg?: GameConfig;
}

export interface CombatStats {
  /** Arrows loosed + melee swings started, by player name. */
  shotsByPlayer: Record<string, number>;
  /** Hit events landed, by attacker name. */
  hitsByPlayer: Record<string, number>;
  killsBySquad: number[];
  totalKills: number;
  totalDeaths: number;
  goldMinted: number;
  /** Gold banked per squad, summed over `banked` events (spans restarts). */
  bankedBySquad: number[];
  /** Completed deposit channels. */
  bankDeposits: number;
  /** Carriers killed with gold on their back (sacks spawned). */
  sacksDropped: number;
  /** Ground sacks scooped up. */
  sacksLooted: number;
}

export interface HarnessResult {
  ticks: number;
  players: number;
  finalHash: string;
  replayHash: string;
  wallMs: number;
  restarts: number;
  stats: { snapshotsSent: number; inputsAccepted: number; bytesSent: number };
  combat: CombatStats;
  playerSummary: Array<{
    id: number;
    name: string;
    squad: number;
    cls: string;
    x: number;
    y: number;
    kills: number;
    deaths: number;
    bounty: number;
    distFromSpawn: number;
  }>;
  violations: string[];
}

export async function runInProcessMatch(opts: HarnessOpts): Promise<HarnessResult> {
  const cfg = opts.cfg ?? getConfigPreset('smoke');
  const map = getMap('scrim_small');
  const violations: string[] = [];
  const combat: CombatStats = {
    shotsByPlayer: {},
    hitsByPlayer: {},
    killsBySquad: new Array<number>(cfg.match.squads).fill(0),
    totalKills: 0,
    totalDeaths: 0,
    goldMinted: 0,
    bankedBySquad: new Array<number>(cfg.match.squads).fill(0),
    bankDeposits: 0,
    sacksDropped: 0,
    sacksLooted: 0,
  };
  let restarts = 0;

  const nameOf = (id: number): string => match.world.players.get(id)?.name ?? `#${id}`;
  const bump = (rec: Record<string, number>, key: string): void => {
    rec[key] = (rec[key] ?? 0) + 1;
  };
  const onSimEvents = (_tick: number, events: SimEvent[]): void => {
    for (const ev of events) {
      switch (ev.k) {
        case 'projSpawn':
          bump(combat.shotsByPlayer, nameOf(ev.owner));
          break;
        case 'swing':
          bump(combat.shotsByPlayer, nameOf(ev.id));
          break;
        case 'hit':
          bump(combat.hitsByPlayer, nameOf(ev.attacker));
          break;
        case 'kill':
          combat.totalDeaths++;
          if (ev.droppedGold > 0) combat.sacksDropped++;
          if (ev.killer !== null) {
            combat.totalKills++;
            const killer = match.world.players.get(ev.killer);
            if (killer)
              combat.killsBySquad[killer.squad] = (combat.killsBySquad[killer.squad] ?? 0) + 1;
          }
          break;
        case 'banked':
          combat.bankDeposits++;
          combat.bankedBySquad[ev.squad] = (combat.bankedBySquad[ev.squad] ?? 0) + ev.amount;
          break;
        case 'sackTaken':
          combat.sacksLooted++;
          break;
      }
    }
  };

  const match = new Match({
    cfg,
    map,
    seed: opts.seed,
    record: true,
    onSimEvents,
    onRestart: () => restarts++,
  });

  const { createLocalPair } = await import('./transport');
  for (let i = 0; i < opts.bots; i++) {
    const pair = createLocalPair();
    match.addConn(pair.serverEnd);
    const driver = new LocalBotDriver(
      pair.clientEnd,
      new BotBrain(opts.seed * 1009 + i * 7919),
      `bot${i + 1}`,
    );
    driver.start();
  }
  const spawnPositions = new Map<number, { x: number; y: number }>();
  const captureSpawns = (): void => {
    spawnPositions.clear();
    for (const p of match.world.players.values()) spawnPositions.set(p.id, { x: p.x, y: p.y });
  };
  captureSpawns();

  const ticks = Math.round(opts.simSeconds * cfg.tick.simHz);
  const maxTtlTicks = Math.ceil(cfg.classes.ranger.bow!.ttlSec * cfg.tick.simHz) + 1;
  const maxChannelTicks = Math.ceil(cfg.banking.bankChannelSec * cfg.tick.simHz) + 1;
  let lastSeed = match.seed;
  let ticksInCurrentWorld = 0;

  const t0 = performance.now();
  await runTurboTicks(ticks, () => {
    match.tick();
    if (match.seed !== lastSeed) {
      // Auto-restart replaced the world mid-run.
      lastSeed = match.seed;
      ticksInCurrentWorld = 0;
      captureSpawns();
    } else {
      ticksInCurrentWorld++;
    }

    // ---- every-tick invariants (cheap; violations carry the tick number)
    const w = match.world;
    if (violations.length < 20) {
      const pooled = totalGoldInWorld(w);
      if (pooled !== w.goldMinted) {
        violations.push(`tick ${w.tick}: GOLD LEAK — pooled ${pooled} != minted ${w.goldMinted}`);
      }
      for (const p of w.players.values()) {
        const maxHp = getKit(cfg, p.cls).maxHp;
        if (p.hp < 0 || p.hp > maxHp + 1e-9) {
          violations.push(`tick ${w.tick}: player ${p.id} hp ${p.hp} out of [0, ${maxHp}]`);
        }
        if (p.bounty < 0) violations.push(`tick ${w.tick}: player ${p.id} negative bounty`);
        if (p.alive && !Number.isFinite(p.x + p.y)) {
          violations.push(`tick ${w.tick}: player ${p.id} non-finite position`);
        }
        if (p.carried < 0 || !Number.isFinite(p.carried)) {
          violations.push(`tick ${w.tick}: player ${p.id} carried ${p.carried} invalid`);
        }
        if (p.bankTicks < 0 || p.bankTicks > maxChannelTicks) {
          violations.push(`tick ${w.tick}: player ${p.id} bankTicks ${p.bankTicks} out of range`);
        }
        if (!p.alive && p.carried > 0) {
          violations.push(`tick ${w.tick}: dead player ${p.id} still carrying ${p.carried}`);
        }
      }
      // The 75% rule as a standing invariant: the reserve NEVER leaves the keep
      // (holds until M3 introduces keep destruction, which spills it by design).
      for (const s of w.squads) {
        const reserve = Math.ceil(s.lifetimeGold * cfg.banking.reserveFraction);
        if (s.keepGold < reserve) {
          violations.push(
            `tick ${w.tick}: squad ${s.id} keep ${s.keepGold} below reserve ${reserve}`,
          );
        }
        if (s.bankedGold < 0) violations.push(`tick ${w.tick}: squad ${s.id} negative bank`);
      }
      for (const sack of w.sacks.values()) {
        if (sack.gold <= 0) violations.push(`tick ${w.tick}: sack ${sack.id} gold ${sack.gold}`);
        if (!Number.isFinite(sack.x + sack.y)) {
          violations.push(`tick ${w.tick}: sack ${sack.id} non-finite position`);
        }
      }
      for (const proj of w.projectiles.values()) {
        if (proj.ticksLeft > maxTtlTicks) {
          violations.push(`tick ${w.tick}: projectile ${proj.id} ttl ${proj.ticksLeft} too large`);
        }
      }
      if (w.projectiles.size > 200) {
        violations.push(`tick ${w.tick}: ${w.projectiles.size} projectiles alive (leak?)`);
      }
    }
  });
  const wallMs = performance.now() - t0;
  combat.goldMinted = match.world.goldMinted;

  const playerSummary: HarnessResult['playerSummary'] = [];
  for (const p of match.world.players.values()) {
    const spawn = spawnPositions.get(p.id) ?? { x: p.x, y: p.y };
    const distFromSpawn = Math.hypot(p.x - spawn.x, p.y - spawn.y);
    playerSummary.push({
      id: p.id,
      name: p.name,
      squad: p.squad,
      cls: p.cls,
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      kills: p.kills,
      deaths: p.deaths,
      bounty: p.bounty,
      distFromSpawn: Math.round(distFromSpawn * 10) / 10,
    });
    if (p.x < 0 || p.y < 0 || p.x > map.width || p.y > map.height) {
      violations.push(`player ${p.id} out of bounds at ${p.x},${p.y}`);
    }
    if (p.alive && isWalkBlocked(map, Math.floor(p.x), Math.floor(p.y))) {
      violations.push(`player ${p.id} inside a wall tile at ${p.x.toFixed(2)},${p.y.toFixed(2)}`);
    }
  }

  const stats = match.getStats();
  if (opts.bots > 0 && stats.snapshotsSent === 0) violations.push('no snapshots were sent');
  if (opts.bots > 0 && stats.inputsAccepted === 0) violations.push('no bot inputs were accepted');
  if (match.world.tick !== ticksInCurrentWorld) {
    violations.push(
      `world tick ${match.world.tick} != ticks driven since last restart ${ticksInCurrentWorld}`,
    );
  }

  // Replay the CURRENT world's recording (recorder resets on restart).
  const finalHash = hashWorld(match.world);
  const replayHash = replayToHash(match.recorder!.toRecord(), cfg, map, match.world.tick);
  if (replayHash !== finalHash) {
    violations.push(`REPLAY DIVERGENCE: live ${finalHash} vs replay ${replayHash}`);
  }

  if (violations.length > 0) {
    dumpFailureReplay(match, opts, violations);
  }

  return {
    ticks,
    players: match.playerCount,
    finalHash,
    replayHash,
    wallMs: Math.round(wallMs),
    restarts,
    stats,
    combat,
    playerSummary,
    violations,
  };
}

/** A failing run leaves its replay on disk — the cheapest bug repro there is. */
function dumpFailureReplay(match: Match, opts: HarnessOpts, violations: string[]): void {
  try {
    const dir = join(process.cwd(), 'replays');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `failure-seed${opts.seed}-${Date.now()}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        { violations, opts: { ...opts, cfg: opts.cfg?.name }, replay: match.recorder?.toRecord() },
        null,
        2,
      ),
    );
    console.error(`[harness] violations — replay dumped to ${file}`);
  } catch (err) {
    console.error('[harness] failed to dump replay:', err);
  }
}
