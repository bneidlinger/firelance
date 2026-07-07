import type { ClassId, GameConfig } from '@shared/config';
import { getKit } from '@shared/config';
import { bountyTier } from '@shared/sim/systems/economy';
import type { RosterEntry, ScoreMsg, YouSnap } from '@shared/net/messages';
import { PHASE_COUNTDOWN, PHASE_ENDED, PHASE_LIVE } from '@shared/sim/world';

// DOM HUD: timer + squad gold, bounty board, killfeed with payouts, own
// hp/dash/bounty bar, death overlay, end screen, toasts, damage vignette.
// DOM beats canvas text for iteration speed at this stage.

const TIER_NAMES = ['Nobody', 'Known', 'Wanted', 'Hunted', 'Infamous', 'Crownmarked'];
const TIER_COLORS = ['#b9ad98', '#c9c29b', '#e0b95e', '#e8985a', '#f05a4d', '#ff3333'];
const SQUAD_CSS = ['#f05a4d', '#5686bf', '#8fae6a', '#e0b95e'];

function el(id: string): HTMLElement {
  return document.getElementById(id)!;
}

export class Hud {
  private readonly cfg: GameConfig;
  private killfeedLines: Array<{ el: HTMLElement; bornMs: number }> = [];
  private lastScore: ScoreMsg | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(cfg: GameConfig) {
    this.cfg = cfg;
  }

  reset(): void {
    el('killfeed').innerHTML = '';
    this.killfeedLines = [];
    this.lastScore = null;
    el('endscreen').style.display = 'none';
    el('deathveil').style.display = 'none';
    el('deathmsg').style.display = 'none';
    el('board').innerHTML = '';
    el('squadgold').innerHTML = '';
  }

  // ---- own state -----------------------------------------------------------

  you(you: YouSnap, killerName: string | null): void {
    const kit = getKit(this.cfg, you.cls);
    const frac = Math.max(0, Math.min(1, you.hp / kit.maxHp));
    const fill = el('hpfill');
    fill.style.width = `${frac * 100}%`;
    fill.style.background = frac > 0.55 ? '#8fae6a' : frac > 0.28 ? '#e0b95e' : '#f05a4d';

    el('selfclass').textContent = you.cls === 'fighter' ? '⚔ Fighter' : '➶ Ranger';
    const dash = el('dash');
    if (you.dashCd <= 0) {
      dash.textContent = 'DASH ready';
      dash.className = 'ready';
    } else {
      dash.textContent = `DASH ${(you.dashCd / this.cfg.tick.simHz).toFixed(1)}s`;
      dash.className = 'cooling';
    }
    const tier = bountyTier(this.cfg, you.bounty);
    const sb = el('selfbounty');
    sb.textContent = `Bounty ${you.bounty} · ${TIER_NAMES[tier]}`;
    sb.style.color = TIER_COLORS[tier]!;

    // Death overlay with respawn countdown + class-switch hint.
    const dead = !you.alive;
    el('deathveil').style.display = dead ? 'block' : 'none';
    el('deathmsg').style.display = dead ? 'block' : 'none';
    if (dead) {
      const secs = Math.max(0, you.respIn / this.cfg.tick.simHz);
      el('deathmsg').innerHTML =
        `${killerName ? `Slain by ${esc(killerName)}` : 'Slain'}` +
        `<div class="sub">respawning in ${secs.toFixed(1)}s — press 1 Fighter · 2 Ranger</div>`;
    }
  }

  vignette(): void {
    const v = el('vignette');
    v.style.opacity = '1';
    setTimeout(() => (v.style.opacity = '0'), 120);
  }

  toast(text: string): void {
    const t = el('toast');
    t.textContent = text;
    t.style.opacity = '1';
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (t.style.opacity = '0'), 1800);
  }

  // ---- killfeed ------------------------------------------------------------

  killLine(
    killer: string | null,
    victim: string,
    killerSquad: number | null,
    victimSquad: number,
    gold: number,
    victimBounty: number,
  ): void {
    const div = document.createElement('div');
    const k = killer
      ? `<span style="color:${SQUAD_CSS[killerSquad ?? 0]}">${esc(killer)}</span> ⚔ `
      : '';
    const payout =
      gold > 0
        ? ` <span style="color:#e0b95e">+${gold}g</span>` +
          (victimBounty > 0 ? ` <span style="color:#b9ad98">(bounty ${victimBounty})</span>` : '')
        : ' <span style="color:#777">(no reward)</span>';
    div.innerHTML = `${k}<span style="color:${SQUAD_CSS[victimSquad]}">${esc(victim)}</span>${payout}`;
    const feed = el('killfeed');
    feed.prepend(div);
    this.killfeedLines.unshift({ el: div, bornMs: performance.now() });
    while (this.killfeedLines.length > 6) {
      this.killfeedLines.pop()!.el.remove();
    }
  }

  // ---- score / board -------------------------------------------------------

  score(msg: ScoreMsg, roster: Map<number, RosterEntry>): void {
    this.lastScore = msg;
    const gold = el('squadgold');
    gold.innerHTML = msg.squads
      .map((s) => `<span style="color:${SQUAD_CSS[s.id]}">◆ ${s.g}g</span>`)
      .join('');

    const top = [...msg.players].sort((a, b) => b.b - a.b || b.k - a.k).slice(0, 5);
    const rows = top
      .map((p) => {
        const r = roster.get(p.id);
        const tier = bountyTier(this.cfg, p.b);
        return (
          `<div><span style="color:${SQUAD_CSS[r?.squad ?? 0]}">${esc(r?.name ?? `#${p.id}`)}</span>` +
          ` <span style="color:${TIER_COLORS[tier]}">${p.b}</span>` +
          ` <span style="color:#777">${p.k}/${p.d}</span></div>`
        );
      })
      .join('');
    el('board').innerHTML = `<div class="hdr">BOUNTY BOARD</div>${rows}`;
  }

  // ---- match flow ----------------------------------------------------------

  timer(phase: number, phaseEndsTick: number, estTick: number): void {
    const t = el('timer');
    const remain = Math.max(0, (phaseEndsTick - estTick) / this.cfg.tick.simHz);
    if (phase === PHASE_COUNTDOWN) {
      t.textContent = `LIVE IN ${Math.ceil(remain)}`;
      t.style.color = '#e0b95e';
    } else if (phase === PHASE_LIVE) {
      const m = Math.floor(remain / 60);
      const s = Math.floor(remain % 60);
      t.textContent = `${m}:${s.toString().padStart(2, '0')}`;
      t.style.color = remain < 60 ? '#f05a4d' : '#f4ead8';
    } else {
      t.textContent = 'MATCH OVER';
      t.style.color = '#d5aa54';
    }
    // End-screen restart countdown, if showing.
    if (phase === PHASE_ENDED) {
      const r = el('endscreen').querySelector('.restart');
      if (r) r.textContent = `next match in ${Math.ceil(remain)}s`;
    }
  }

  endScreen(
    winners: number[],
    standings: Array<{ squad: number; gold: number; kills: number }>,
    roster: Map<number, RosterEntry>,
    ownSquad: number,
  ): void {
    const names = ['Red', 'Blue', 'Green', 'Gold'];
    const title =
      winners.length === 1
        ? `${names[winners[0]!]} squad takes the field`
        : `Tie: ${winners.map((w) => names[w]).join(' & ')}`;
    const rows = standings
      .map((s) => {
        const members = [...roster.values()]
          .filter((r) => r.squad === s.squad)
          .map((r) => esc(r.name))
          .join(', ');
        const you = s.squad === ownSquad ? ' ◀ you' : '';
        return (
          `<tr><td style="color:${SQUAD_CSS[s.squad]}">${names[s.squad]}</td>` +
          `<td>${s.gold}g</td><td>${s.kills} kills</td>` +
          `<td style="color:#b9ad98">${members}${you}</td></tr>`
        );
      })
      .join('');
    el('endscreen').innerHTML =
      `<h1>${title}</h1>` +
      `<table><tr><th>Squad</th><th>Keep gold</th><th>Kills</th><th>Riders</th></tr>${rows}</table>` +
      `<div class="restart"></div>`;
    el('endscreen').style.display = 'block';
  }

  hideEndScreen(): void {
    el('endscreen').style.display = 'none';
  }

  /** Fade old killfeed lines; call per frame-ish. */
  frame(nowMs: number): void {
    for (const line of this.killfeedLines) {
      const age = nowMs - line.bornMs;
      if (age > 6000) line.el.style.opacity = '0';
    }
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
