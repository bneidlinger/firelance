import type { ClassId, GameConfig } from '@shared/config';
import { getKit, secToTicks } from '@shared/config';
import { bountyTier, carrySpeedFactor } from '@shared/sim/systems/economy';
import type { RosterEntry, ScoreMsg, SummaryMsg, YouSnap } from '@shared/net/messages';
import { PHASE_COUNTDOWN, PHASE_ENDED, PHASE_LIVE, PHASE_PLACEMENT } from '@shared/sim/world';

// DOM HUD: timer + banked-gold standings, bounty board, killfeed with payouts
// and dropped-sack drama, own hp/dash/bounty/carry bar, deposit channel bar,
// contextual banking prompts, death overlay, end screen, toasts, vignette.
// DOM beats canvas text for iteration speed at this stage.

export const TIER_NAMES = ['Nobody', 'Known', 'Wanted', 'Hunted', 'Infamous', 'Crownmarked'];
export const TIER_COLORS = ['#b9ad98', '#c9c29b', '#e0b95e', '#e8985a', '#f05a4d', '#ff3333'];
const SQUAD_CSS = ['#f05a4d', '#5686bf', '#8fae6a', '#e0b95e'];

function el(id: string): HTMLElement {
  return document.getElementById(id)!;
}

export class Hud {
  private readonly cfg: GameConfig;
  private killfeedLines: Array<{ el: HTMLElement; bornMs: number }> = [];
  private lastScore: ScoreMsg | null = null;
  /** Gold-flow data for the end screen (M5) — may land before OR after the
   *  matchEnd event; whichever arrives second draws the graph. */
  private lastSummary: SummaryMsg | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  private flashUntil = 0;
  private lowHpWas = false;

  constructor(cfg: GameConfig) {
    this.cfg = cfg;
  }

  reset(): void {
    el('killfeed').innerHTML = '';
    this.killfeedLines = [];
    this.lastScore = null;
    this.lastSummary = null;
    el('endscreen').style.display = 'none';
    el('deathveil').style.display = 'none';
    el('deathmsg').style.display = 'none';
    el('board').innerHTML = '';
    el('squadgold').innerHTML = '';
    el('carry').style.display = 'none';
    el('bankwrap').style.display = 'none';
    el('prompt').style.display = 'none';
    el('alarm').style.opacity = '0';
    el('exile').style.display = 'none';
  }

  // ---- own state -----------------------------------------------------------

  you(you: YouSnap, killerName: string | null, deadNote: string | null = null): void {
    const kit = getKit(this.cfg, you.cls);
    const frac = Math.max(0, Math.min(1, you.hp / kit.maxHp));
    const fill = el('hpfill');
    fill.style.width = `${frac * 100}%`;
    fill.style.background = frac > 0.55 ? '#8fae6a' : frac > 0.28 ? '#e0b95e' : '#f05a4d';

    el('selfclass').textContent =
      you.cls === 'fighter' ? '⚔ Fighter' : you.cls === 'engineer' ? '🔧 Engineer' : '➶ Ranger';
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

    // Firebomb satchel: filled/empty pips + the throw cooldown.
    const bombs = el('bombs');
    const capacity = this.cfg.firebomb.carried;
    const pips = '●'.repeat(you.bombs) + '○'.repeat(Math.max(0, capacity - you.bombs));
    bombs.textContent =
      you.bombCd > 0 ? `🔥${pips} ${(you.bombCd / this.cfg.tick.simHz).toFixed(1)}s` : `🔥${pips}`;

    // Build supply (⛏): green once a wall is affordable — the "you can build" tell.
    const supply = el('supply');
    supply.textContent = `⛏ ${Math.floor(you.supply)}`;
    supply.style.color = you.supply >= this.cfg.build.wall.cost ? '#8fae6a' : '#b9ad98';

    // Carried load + how much it's slowing you (the risk you're holding).
    const carry = el('carry');
    if (you.carried > 0) {
      const slowPct = Math.round((1 - carrySpeedFactor(this.cfg, you.carried)) * 100);
      carry.textContent = `◆ ${you.carried}g${slowPct > 0 ? ` · −${slowPct}% speed` : ''}`;
      carry.style.display = 'inline';
    } else {
      carry.style.display = 'none';
    }

    // Channel progress bar: deposit (gold), claim (green), or rebuild (red) —
    // the phases guarantee at most one runs at a time.
    const wrap = el('bankwrap');
    if (you.bankTicks > 0) {
      const total = secToTicks(this.cfg, this.cfg.banking.bankChannelSec);
      const fill = el('bankfill');
      fill.style.width = `${Math.min(100, (you.bankTicks / total) * 100)}%`;
      fill.style.background = '#f2d68c';
      wrap.style.display = 'block';
    } else if (you.claimTicks > 0) {
      const total = secToTicks(this.cfg, this.cfg.keep.claimChannelSec);
      const fill = el('bankfill');
      fill.style.width = `${Math.min(100, (you.claimTicks / total) * 100)}%`;
      fill.style.background = '#8fae6a';
      wrap.style.display = 'block';
    } else if (you.rebuildTicks > 0) {
      const total = secToTicks(this.cfg, this.cfg.keep.rebuildChannelSec);
      const fill = el('bankfill');
      fill.style.width = `${Math.min(100, (you.rebuildTicks / total) * 100)}%`;
      fill.style.background = '#f05a4d';
      wrap.style.display = 'block';
    } else {
      wrap.style.display = 'none';
    }

    // Death overlay with respawn countdown + class-switch hint.
    const dead = !you.alive;
    el('deathveil').style.display = dead ? 'block' : 'none';
    el('deathmsg').style.display = dead ? 'block' : 'none';
    if (dead) {
      const secs = Math.max(0, you.respIn / this.cfg.tick.simHz);
      const sub =
        deadNote ?? `respawning in ${secs.toFixed(1)}s — press 1 Fighter · 2 Ranger · 3 Engineer`;
      el('deathmsg').innerHTML =
        `${killerName ? `Slain by ${esc(killerName)}` : 'Slain'}<div class="sub">${sub}</div>`;
    }
  }

  vignette(): void {
    const v = el('vignette');
    v.style.opacity = '1';
    this.flashUntil = performance.now() + 130;
    setTimeout(() => (v.style.opacity = '0'), 120);
  }

  /** Low-HP breathing pulse on the same vignette (M6 s2, own hp only). The
   *  hit flash outranks it for its brief window. */
  lowHpFrame(nowMs: number, active: boolean): void {
    if (nowMs < this.flashUntil) return;
    if (active) {
      el('vignette').style.opacity = String(0.3 + 0.22 * Math.sin(nowMs / 260));
    } else if (this.lowHpWas) {
      el('vignette').style.opacity = '0';
    }
    this.lowHpWas = active;
  }

  toast(text: string): void {
    const t = el('toast');
    t.textContent = text;
    t.style.opacity = '1';
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (t.style.opacity = '0'), 1800);
  }

  /** Persistent contextual prompt ("Hold E to …"); null hides it. */
  prompt(html: string | null): void {
    const p = el('prompt');
    if (html === null) {
      p.style.display = 'none';
    } else {
      if (p.innerHTML !== html) p.innerHTML = html;
      p.style.display = 'block';
    }
  }

  /** The under-attack klaxon banner; fades on its own. */
  alarm(text: string): void {
    const a = el('alarm');
    a.textContent = text;
    a.style.opacity = '1';
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = setTimeout(() => (a.style.opacity = '0'), 2600);
  }

  /** Persistent exile strip under the topbar; null hides it. */
  exile(html: string | null): void {
    const x = el('exile');
    if (html === null) {
      x.style.display = 'none';
    } else {
      if (x.innerHTML !== html) x.innerHTML = html;
      x.style.display = 'block';
    }
  }

  // ---- killfeed ------------------------------------------------------------

  killLine(
    killer: string | null,
    victim: string,
    killerSquad: number | null,
    victimSquad: number,
    gold: number,
    victimBounty: number,
    droppedGold: number,
  ): void {
    const k = killer
      ? `<span style="color:${SQUAD_CSS[killerSquad ?? 0]}">${esc(killer)}</span> ⚔ `
      : '';
    const payout =
      gold > 0
        ? ` <span style="color:#e0b95e">+${gold}g</span>` +
          (victimBounty > 0 ? ` <span style="color:#b9ad98">(bounty ${victimBounty})</span>` : '')
        : ' <span style="color:#777">(no reward)</span>';
    // The vulture bell: a dead carrier's load is now on the ground, somewhere.
    const dropped =
      droppedGold > 0 ? ` <span style="color:#f2d68c">dropped ${droppedGold}g!</span>` : '';
    this.feedLine(
      `${k}<span style="color:${SQUAD_CSS[victimSquad]}">${esc(victim)}</span>${payout}${dropped}`,
    );
  }

  /** Banking success — global news; the scoreboard just moved. */
  bankedLine(name: string, squad: number, amount: number): void {
    this.feedLine(
      `<span style="color:${SQUAD_CSS[squad]}">${esc(name)}</span>` +
        ` <span style="color:#f2d68c">banked ${amount}g</span> 🏦`,
    );
  }

  /** Map-level news (keep falls, rebuilds, eliminations) into the feed. */
  news(html: string): void {
    this.feedLine(html);
  }

  private feedLine(html: string): void {
    const div = document.createElement('div');
    div.innerHTML = html;
    el('killfeed').prepend(div);
    this.killfeedLines.unshift({ el: div, bornMs: performance.now() });
    while (this.killfeedLines.length > 6) {
      this.killfeedLines.pop()!.el.remove();
    }
  }

  // ---- score / board -------------------------------------------------------

  score(msg: ScoreMsg, roster: Map<number, RosterEntry>): void {
    this.lastScore = msg;
    // Topbar = the SCORE: banked gold per squad (public). Your own entry adds
    // the private vault detail — keep balance and what the reserve rule lets out.
    const gold = el('squadgold');
    gold.innerHTML = msg.squads
      .map((s) => {
        const own =
          s.g !== undefined
            ? ` <span style="color:#b9ad98">(keep ${s.g}g · ${s.wd ?? 0} free)</span>`
            : '';
        // Keep status is public: standing / on fire (<50%) / fallen / squad out.
        const keep = s.el ? '💀' : s.kh <= 0 ? '✖' : s.kh < this.cfg.keep.maxHp * 0.5 ? '🔥' : '';
        const style = s.el ? 'opacity:0.5;text-decoration:line-through' : '';
        return `<span style="color:${SQUAD_CSS[s.id]};${style}">🏦 ${s.bk}g${keep ? ` ${keep}` : ''}${own}</span>`;
      })
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
    if (phase === PHASE_PLACEMENT) {
      const m = Math.floor(remain / 60);
      const s = Math.floor(remain % 60);
      t.textContent = `CLAIM A KEEP ${m}:${s.toString().padStart(2, '0')}`;
      t.style.color = '#8fae6a';
    } else if (phase === PHASE_COUNTDOWN) {
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
    standings: Array<{
      squad: number;
      banked: number;
      gold: number;
      kills: number;
      eliminated: boolean;
    }>,
    roster: Map<number, RosterEntry>,
    ownSquad: number,
  ): void {
    const names = ['Red', 'Blue', 'Green', 'Gold'];
    const title =
      winners.length === 1
        ? `${names[winners[0]!]} squad banked the most`
        : `Tie: ${winners.map((w) => names[w]).join(' & ')}`;
    const rows = standings
      .map((s) => {
        const members = [...roster.values()]
          .filter((r) => r.squad === s.squad)
          .map((r) => esc(r.name))
          .join(', ');
        const you = s.squad === ownSquad ? ' ◀ you' : '';
        const rowStyle = s.eliminated ? 'opacity:0.45;text-decoration:line-through' : '';
        const fate = s.eliminated ? ' 💀' : '';
        return (
          `<tr style="${rowStyle}"><td style="color:${SQUAD_CSS[s.squad]}">${names[s.squad]}${fate}</td>` +
          `<td style="color:#f2d68c">${s.banked}g</td>` +
          `<td style="color:#b9ad98">${s.gold}g</td><td>${s.kills}</td>` +
          `<td style="color:#b9ad98">${members}${you}</td></tr>`
        );
      })
      .join('');
    el('endscreen').innerHTML =
      `<h1>${title}</h1>` +
      `<table><tr><th>Squad</th><th>Banked</th><th>Left in keep</th><th>Kills</th><th>Riders</th></tr>${rows}</table>` +
      `<canvas id="goldflow" width="520" height="180" style="display:none;margin:14px auto 0;max-width:92%"></canvas>` +
      `<div class="restart"></div>`;
    el('endscreen').style.display = 'block';
    this.drawGoldFlow();
  }

  /** The match's gold story arrived (Match sends it once at matchEnd). */
  summary(msg: SummaryMsg): void {
    this.lastSummary = msg;
    this.drawGoldFlow();
  }

  /** Draw the banked-gold race onto the end screen, with the big beats
   *  marked. No-ops until BOTH the end screen and the summary exist. */
  private drawGoldFlow(): void {
    const m = this.lastSummary;
    const canvas = document.getElementById('goldflow') as HTMLCanvasElement | null;
    if (!m || !canvas || m.banked.length === 0) return;
    const samples = Math.max(...m.banked.map((b) => b.length));
    if (samples < 2) return;
    canvas.style.display = 'block';
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width;
    const H = canvas.height;
    const padL = 8;
    const padR = 8;
    const padT = 18; // room for beat emoji
    const padB = 16; // room for the time axis
    ctx.clearRect(0, 0, W, H);

    let maxG = 100;
    for (const series of m.banked) for (const v of series) if (v > maxG) maxG = v;
    const spanTicks = (samples - 1) * m.everyTicks;
    const x = (tk: number): number =>
      padL + (W - padL - padR) * Math.max(0, Math.min(1, (tk - m.startTick) / spanTicks));
    const y = (g: number): number => H - padB - (H - padT - padB) * (g / maxG);

    // Frame + max label + duration label.
    ctx.strokeStyle = 'rgba(185,173,152,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, W - padL - padR, H - padT - padB);
    ctx.fillStyle = 'rgba(185,173,152,0.8)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${maxG}g`, padL + 3, padT + 10);
    ctx.textAlign = 'right';
    const mins = spanTicks / this.cfg.tick.simHz / 60;
    ctx.fillText(
      `${mins < 1 ? `${Math.round(mins * 60)}s` : `${mins.toFixed(1)}min`} of banking`,
      W - padR - 3,
      H - 4,
    );

    // The big beats: a vertical whisper + an emoji in the squad's color.
    const BEAT = { keepDestroyed: '💥', keepRebuilt: '🏰', eliminated: '💀' } as const;
    ctx.textAlign = 'center';
    ctx.font = '11px monospace';
    for (const mk of m.marks) {
      const mx = x(mk.tk);
      ctx.strokeStyle = `${SQUAD_CSS[mk.squad] ?? '#fff'}55`;
      ctx.beginPath();
      ctx.moveTo(mx, padT);
      ctx.lineTo(mx, H - padB);
      ctx.stroke();
      ctx.fillText(BEAT[mk.k], mx, 12);
    }

    // The race itself.
    ctx.lineWidth = 2;
    m.banked.forEach((series, squad) => {
      if (series.length === 0) return;
      ctx.strokeStyle = SQUAD_CSS[squad] ?? '#ffffff';
      ctx.beginPath();
      series.forEach((g, i) => {
        const px = x(m.startTick + i * m.everyTicks);
        const py = y(g);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      // End-of-line total, right where the line stops.
      const last = series[series.length - 1]!;
      ctx.fillStyle = SQUAD_CSS[squad] ?? '#ffffff';
      ctx.textAlign = 'right';
      ctx.font = '10px monospace';
      ctx.fillText(`${last}g`, W - padR - 3, Math.max(padT + 9, y(last) - 4));
    });
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
