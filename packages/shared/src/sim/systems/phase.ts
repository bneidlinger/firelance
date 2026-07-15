import type { GameConfig } from '../../config';
import { getKit, secToTicks } from '../../config';
import type { MapData } from '../../map/types';
import type { SimEvent } from '../events';
import type { World } from '../world';
import {
  ATK_IDLE,
  PHASE_COUNTDOWN,
  PHASE_ENDED,
  PHASE_LIVE,
  PHASE_PLACEMENT,
  SPAWN_OFFSETS,
  STRUCT_HUT,
  STRUCT_TREE,
} from '../world';
import { plantKeep, siteClaimed } from './claims';

// Match flow: placement → countdown → live → ended. Placement (M4) is a
// free-move window where squads claim keep sites (claims.ts); its deadline
// auto-assigns the rest. The countdown is a free-move warmup (combat is gated
// on PHASE_LIVE elsewhere); going live hard-resets positions and the economy
// so warmup can't pollute the match. Zero-duration phases collapse within one
// call (sequential ifs), so smoke configs still go live on tick 1. The sim
// never restarts itself — the server watches phaseEndsTick while ended and
// builds a fresh world.

export function stepPhase(world: World, cfg: GameConfig, map: MapData, events: SimEvent[]): void {
  if (world.phase === PHASE_PLACEMENT && world.tick >= world.phaseEndsTick) {
    finalizePlacement(world, map, events);
    world.phase = PHASE_COUNTDOWN;
    world.phaseEndsTick = world.tick + secToTicks(cfg, cfg.match.countdownSec);
    events.push({
      k: 'phase',
      tk: world.tick,
      phase: PHASE_COUNTDOWN,
      endsTick: world.phaseEndsTick,
    });
  }
  if (world.phase === PHASE_COUNTDOWN && world.tick >= world.phaseEndsTick) {
    goLive(world, cfg);
    events.push({ k: 'phase', tk: world.tick, phase: PHASE_LIVE, endsTick: world.phaseEndsTick });
  } else if (world.phase === PHASE_LIVE) {
    // Elimination sweep: no keep + nobody breathing = out of the match.
    // (Sticky — a squad never un-eliminates; rebuild requires a living member.)
    let contenders = 0;
    for (const s of world.squads) {
      if (!s.eliminated && s.keepHp <= 0) {
        let anyAlive = false;
        for (const p of world.players.values()) {
          if (p.squad === s.id && p.alive) {
            anyAlive = true;
            break;
          }
        }
        if (!anyAlive) {
          s.eliminated = true;
          events.push({ k: 'eliminated', tk: world.tick, squad: s.id });
        }
      }
      if (!s.eliminated) contenders++;
    }
    // Last squad standing ends it now (doc §5.6) — or the clock runs out.
    if (contenders <= 1 || world.tick >= world.phaseEndsTick) {
      endMatch(world, cfg, events);
    }
  }
}

/**
 * Placement deadline: every squad without a claim gets the nearest unclaimed
 * site to its map spawn — the same greedy assignKeeps used for the provisional
 * layout, restricted to what's left, so a no-claims match lands exactly on the
 * M0–M3 default. Deterministic by squad index; claims killed the ties.
 */
function finalizePlacement(world: World, map: MapData, events: SimEvent[]): void {
  for (const squad of world.squads) {
    if (squad.claimedSite >= 0) continue;
    const spawn = map.spawns[squad.id] ?? map.spawns[0]!;
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < map.keeps.length; i++) {
      if (siteClaimed(world, i)) continue;
      const site = map.keeps[i]!;
      const d = (site.x - spawn.x) ** 2 + (site.y - spawn.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    // More squads than sites can't happen on authored maps (sites ≥ squads),
    // but mirror assignKeeps' reuse fallback rather than crash.
    plantKeep(world, squad, map, best >= 0 ? best : squad.id % map.keeps.length, null, events);
  }
  for (const p of world.players.values()) {
    p.claimTicks = 0;
    p.claimSiteIdx = -1;
  }
}

function goLive(world: World, cfg: GameConfig): void {
  world.phase = PHASE_LIVE;
  world.phaseEndsTick = world.tick + secToTicks(cfg, cfg.match.durationSec);
  world.projectiles.clear();
  world.sacks.clear();
  world.bombs.clear();
  // Sweep player-buildable kinds only (belt-and-braces vs warmup pollution —
  // builds are phase-gated anyway). The COUNTRYSIDE was born with the world
  // and must survive going live: this exact line silently deleted every tree
  // and hut in the first live playtest while all 307 unit tests stayed green
  // (none of them crossed goLive with props standing).
  for (const [id, s] of world.structures) {
    if (s.kind !== STRUCT_TREE && s.kind !== STRUCT_HUT) world.structures.delete(id);
  }
  world.goldMinted = 0;
  for (const s of world.squads) {
    s.keepGold = 0;
    s.bankedGold = 0;
    s.lifetimeGold = 0;
    s.keepHp = cfg.keep.maxHp;
    s.rebuildsLeft = 1;
    s.eliminated = false;
    s.lastAlarmTick = -1_000_000;
    s.supply = cfg.build.supplyStart;
    s.supplyMinted = cfg.build.supplyStart;
  }
  for (const p of world.players.values()) {
    const squad = world.squads[p.squad]!;
    const [ox, oy] = SPAWN_OFFSETS[p.id % SPAWN_OFFSETS.length]!;
    p.cls = p.pendingCls;
    p.x = squad.keepX + ox;
    p.y = squad.keepY + oy;
    p.vx = 0;
    p.vy = 0;
    p.dashTicks = 0;
    p.dashCd = 0;
    p.prevB = p.input.b;
    p.hp = getKit(cfg, p.cls).maxHp;
    p.alive = true;
    p.spawnedAtTick = world.tick;
    p.lastDamagedTick = -1_000_000;
    p.recentDamagers.clear();
    p.atkPhase = ATK_IDLE;
    p.atkTicks = 0;
    p.atkCd = 0;
    p.atkHitIds = [];
    p.bounty = 0;
    p.kills = 0;
    p.deaths = 0;
    p.assists = 0;
    p.repeatKills.clear();
    p.carried = 0;
    p.bankTicks = 0;
    p.rebuildTicks = 0;
    p.bombs = cfg.firebomb.carried;
    p.bombCd = 0;
    p.prevBombB = p.input.b;
    p.prevBuildB = p.input.b;
    p.buildCd = 0;
    p.claimTicks = 0;
    p.claimSiteIdx = -1;
  }
}

function endMatch(world: World, cfg: GameConfig, events: SimEvent[]): void {
  world.phase = PHASE_ENDED;
  world.phaseEndsTick = world.tick + secToTicks(cfg, cfg.match.restartSec);

  // Most banked gold AMONG SURVIVORS wins (doc: "the surviving squad with the
  // most banked gold") — elimination forfeits everything, even a fat bank.
  // Equal banked = shared win. If somehow every squad died (mutual ruin), the
  // bank ledger settles it among the dead.
  const contenders = world.squads.filter((s) => !s.eliminated);
  const pool = contenders.length > 0 ? contenders : world.squads;
  let bestBanked = -1;
  for (const s of pool) {
    if (s.bankedGold > bestBanked) bestBanked = s.bankedGold;
  }
  world.winners = pool.filter((s) => s.bankedGold === bestBanked).map((s) => s.id);

  const kills = new Array<number>(world.squads.length).fill(0);
  for (const p of world.players.values()) kills[p.squad] = (kills[p.squad] ?? 0) + p.kills;
  const standings = world.squads
    .map((s) => ({
      squad: s.id,
      banked: s.bankedGold,
      gold: s.keepGold,
      kills: kills[s.id] ?? 0,
      eliminated: s.eliminated,
    }))
    .sort(
      (a, b) =>
        Number(a.eliminated) - Number(b.eliminated) ||
        b.banked - a.banked ||
        b.gold - a.gold ||
        b.kills - a.kills ||
        a.squad - b.squad,
    );

  events.push({ k: 'phase', tk: world.tick, phase: PHASE_ENDED, endsTick: world.phaseEndsTick });
  events.push({ k: 'matchEnd', tk: world.tick, winners: world.winners, standings });
}
