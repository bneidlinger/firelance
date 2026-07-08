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
  } else if (world.phase === PHASE_LIVE && world.tick >= world.phaseEndsTick) {
    endMatch(world, cfg, events);
  }
}

function goLive(world: World, cfg: GameConfig): void {
  world.phase = PHASE_LIVE;
  world.phaseEndsTick = world.tick + secToTicks(cfg, cfg.match.durationSec);
  world.projectiles.clear();
  world.sacks.clear();
  world.goldMinted = 0;
  for (const s of world.squads) {
    s.keepGold = 0;
    s.bankedGold = 0;
    s.lifetimeGold = 0;
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
  }
}

function endMatch(world: World, cfg: GameConfig, events: SimEvent[]): void {
  world.phase = PHASE_ENDED;
  world.phaseEndsTick = world.tick + secToTicks(cfg, cfg.match.restartSec);

  // M2: only BANKED gold wins — keep gold is unsecured wealth, carried gold is
  // in flight, sacks are anyone's. Equal banked = shared win; the standings
  // list additionally orders by keep gold, then kills, for the end screen.
  let bestBanked = -1;
  for (const s of world.squads) {
    if (s.bankedGold > bestBanked) bestBanked = s.bankedGold;
  }
  world.winners = world.squads.filter((s) => s.bankedGold === bestBanked).map((s) => s.id);

  const kills = new Array<number>(world.squads.length).fill(0);
  for (const p of world.players.values()) kills[p.squad] = (kills[p.squad] ?? 0) + p.kills;
  const standings = world.squads
    .map((s) => ({ squad: s.id, banked: s.bankedGold, gold: s.keepGold, kills: kills[s.id] ?? 0 }))
    .sort(
      (a, b) => b.banked - a.banked || b.gold - a.gold || b.kills - a.kills || a.squad - b.squad,
    );

  events.push({ k: 'phase', tk: world.tick, phase: PHASE_ENDED, endsTick: world.phaseEndsTick });
  events.push({ k: 'matchEnd', tk: world.tick, winners: world.winners, standings });
}
