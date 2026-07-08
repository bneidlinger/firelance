import type { GameConfig } from '../../config';
import { getKit, secToTicks } from '../../config';
import type { SimEvent } from '../events';
import type { World } from '../world';
import { ATK_IDLE, PHASE_COUNTDOWN, PHASE_ENDED, PHASE_LIVE, SPAWN_OFFSETS } from '../world';

// Match flow: countdown → live → ended. The countdown is a free-move warmup
// (combat is gated on PHASE_LIVE elsewhere); going live hard-resets positions
// and the economy so warmup can't pollute the match. The sim never restarts
// itself — the server watches phaseEndsTick while ended and builds a fresh
// world.

export function stepPhase(world: World, cfg: GameConfig, events: SimEvent[]): void {
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

function goLive(world: World, cfg: GameConfig): void {
  world.phase = PHASE_LIVE;
  world.phaseEndsTick = world.tick + secToTicks(cfg, cfg.match.durationSec);
  world.projectiles.clear();
  world.sacks.clear();
  world.bombs.clear();
  world.goldMinted = 0;
  for (const s of world.squads) {
    s.keepGold = 0;
    s.bankedGold = 0;
    s.lifetimeGold = 0;
    s.keepHp = cfg.keep.maxHp;
    s.rebuildsLeft = 1;
    s.eliminated = false;
    s.lastAlarmTick = -1_000_000;
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
