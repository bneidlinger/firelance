import { BotBrain } from '@bots/brain';
import { LocalBotDriver } from '@bots/localdriver';
import { getConfigPreset, type GameConfig } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { isWalkBlocked } from '@shared/map/types';
import { hashWorld } from '@shared/sim/world';
import { Match } from './match';
import { replayToHash } from './replay';
import { runTurboTicks } from './ticker';

// In-process match harness: Match + N BotBrains over LocalTransport, driven by
// the turbo ticker. A 10-minute match runs in seconds of wall time; invariants
// and a full replay-vs-live hash comparison run on every invocation. This is
// the autonomous-verification workhorse.

export interface HarnessOpts {
  bots: number;
  simSeconds: number;
  seed: number;
  cfg?: GameConfig;
}

export interface HarnessResult {
  ticks: number;
  players: number;
  finalHash: string;
  replayHash: string;
  wallMs: number;
  stats: { snapshotsSent: number; inputsAccepted: number; bytesSent: number };
  playerSummary: Array<{
    id: number;
    name: string;
    squad: number;
    x: number;
    y: number;
    distFromSpawn: number;
  }>;
  violations: string[];
}

export async function runInProcessMatch(opts: HarnessOpts): Promise<HarnessResult> {
  const cfg = opts.cfg ?? getConfigPreset('smoke');
  const map = getMap('scrim_small');
  const match = new Match({ cfg, map, seed: opts.seed, record: true });

  const { createLocalPair } = await import('./transport');
  const spawnPositions = new Map<number, { x: number; y: number }>();
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
  for (const p of match.world.players.values()) {
    spawnPositions.set(p.id, { x: p.x, y: p.y });
  }

  const ticks = Math.round(opts.simSeconds * cfg.tick.simHz);
  const t0 = performance.now();
  await runTurboTicks(ticks, () => match.tick());
  const wallMs = performance.now() - t0;

  const violations: string[] = [];
  const playerSummary: HarnessResult['playerSummary'] = [];
  for (const p of match.world.players.values()) {
    const spawn = spawnPositions.get(p.id) ?? { x: p.x, y: p.y };
    const distFromSpawn = Math.hypot(p.x - spawn.x, p.y - spawn.y);
    playerSummary.push({
      id: p.id,
      name: p.name,
      squad: p.squad,
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      distFromSpawn: Math.round(distFromSpawn * 10) / 10,
    });
    if (p.x < 0 || p.y < 0 || p.x > map.width || p.y > map.height) {
      violations.push(`player ${p.id} out of bounds at ${p.x},${p.y}`);
    }
    if (isWalkBlocked(map, Math.floor(p.x), Math.floor(p.y))) {
      violations.push(`player ${p.id} inside a wall tile at ${p.x.toFixed(2)},${p.y.toFixed(2)}`);
    }
  }

  const stats = match.getStats();
  if (opts.bots > 0 && stats.snapshotsSent === 0) violations.push('no snapshots were sent');
  if (opts.bots > 0 && stats.inputsAccepted === 0) violations.push('no bot inputs were accepted');
  if (match.world.tick !== ticks)
    violations.push(`world tick ${match.world.tick} != expected ${ticks}`);

  const finalHash = hashWorld(match.world);
  const replayHash = replayToHash(match.recorder!.toRecord(), cfg, map, ticks);
  if (replayHash !== finalHash) {
    violations.push(`REPLAY DIVERGENCE: live ${finalHash} vs replay ${replayHash}`);
  }

  return {
    ticks,
    players: match.playerCount,
    finalHash,
    replayHash,
    wallMs: Math.round(wallMs),
    stats,
    playerSummary,
    violations,
  };
}
