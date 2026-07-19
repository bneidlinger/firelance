import { Container, Graphics } from 'pixi.js';
import type { SimEvent } from '@shared/sim/events';
import { FX } from '../fx/config';
import { ARMORY, BONE, FIRE, KHAKI } from './palette';
import { TILE } from './scene';

// Arrows are events-only: the server sends spawn + end, the client integrates
// flight locally. Remote arrows fly on the DELAYED interp timeline so they
// line up with the bodies they threaten (arrows must never lead their
// targets). The player's OWN arrows render as real-time "ghosts" spawned at
// the muzzle on click — when the authoritative spawn arrives it adopts the
// ghost, so your own shot never feels a round-trip late.
//
// Arcade light (G4): every shaft tows a short additive tracer — ALL dashes
// drawn into one per-frame Graphics — and wears a glow tip; and the two
// ranged weapons finally split: warm fletched arrows vs stubby steel bolts.
// The wire doesn't say which is which; kit speed does (classifier from main).

interface RemoteArrow {
  id: number;
  tk: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  speed: number;
  ttl: number;
  endTick: number | null; // from projEnd; render until the cursor reaches it
  gfx: Container;
  warm: boolean;
  /** Recent positions (flat x,y px pairs) — the tracer's memory. */
  hist: number[];
}

interface GhostArrow {
  bornMs: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  speed: number;
  maxMs: number;
  serverId: number | null; // adopted by our authoritative projSpawn
  endAtMs: number | null; // set when the server reports the end
  gfx: Container;
  warm: boolean;
  hist: number[];
}

const GHOST_CONFIRM_TIMEOUT_MS = 500;

export class ProjectileLayer {
  private readonly remote = new Map<number, RemoteArrow>();
  private ghosts: GhostArrow[] = [];
  /** Every arrow's tracer, one additive Graphics redrawn per frame. */
  private readonly trailG = new Graphics();

  constructor(
    private readonly container: Container,
    private readonly tickRate: number,
    /** Kit-speed classifier (from config, not the wire): true = bolt. */
    private readonly isBolt: (speed: number) => boolean,
  ) {
    this.trailG.blendMode = 'add';
    container.addChild(this.trailG);
  }

  /** Automation/debug: how many arrows each timeline is tracking. */
  counts(): { remote: number; ghosts: number; confirmedGhosts: number } {
    return {
      remote: this.remote.size,
      ghosts: this.ghosts.length,
      confirmedGhosts: this.ghosts.filter((g) => g.serverId !== null).length,
    };
  }

  clear(): void {
    for (const a of this.remote.values()) a.gfx.destroy({ children: true });
    this.remote.clear();
    for (const g of this.ghosts) g.gfx.destroy({ children: true });
    this.ghosts = [];
    this.trailG.destroy();
  }

  /** Fire-and-forget local muzzle prediction for the player's own shot. */
  spawnGhost(
    x: number,
    y: number,
    dx: number,
    dy: number,
    speed: number,
    ttlSec: number,
    warm: boolean,
  ): void {
    const gfx = makeArrowGfx(this.container, dx, dy, warm);
    this.ghosts.push({
      bornMs: performance.now(),
      x,
      y,
      dx,
      dy,
      speed,
      maxMs: ttlSec * 1000,
      serverId: null,
      endAtMs: null,
      gfx,
      warm,
      hist: [],
    });
  }

  onSpawn(ev: SimEvent & { k: 'projSpawn' }, ownId: number): void {
    if (ev.owner === ownId) {
      // Adopt the oldest unconfirmed ghost — that click was this arrow.
      const ghost = this.ghosts.find((g) => g.serverId === null);
      if (ghost) {
        ghost.serverId = ev.id;
        return;
      }
      // No ghost (edge: prediction gated) — fall through and render remote-style.
    }
    const warm = !this.isBolt(ev.speed);
    const gfx = makeArrowGfx(this.container, ev.dx, ev.dy, warm);
    this.remote.set(ev.id, {
      id: ev.id,
      tk: ev.tk,
      x: ev.x,
      y: ev.y,
      dx: ev.dx,
      dy: ev.dy,
      speed: ev.speed,
      ttl: ev.ttl,
      endTick: null,
      gfx,
      warm,
      hist: [],
    });
  }

  /** Returns the arrow's end position when one of ours ends (for impact fx). */
  onEnd(ev: SimEvent & { k: 'projEnd' }): void {
    const remote = this.remote.get(ev.id);
    if (remote) {
      remote.endTick = ev.tk;
      return;
    }
    const ghost = this.ghosts.find((g) => g.serverId === ev.id);
    if (ghost) {
      const dist = Math.hypot(ev.x - ghost.x, ev.y - ghost.y);
      ghost.endAtMs = ghost.bornMs + (dist / ghost.speed) * 1000;
    }
  }

  /** Advance both timelines; call every frame. */
  frame(renderTick: number, nowMs: number): void {
    for (const [id, a] of this.remote) {
      const t = renderTick - a.tk;
      if (t < 0) {
        a.gfx.visible = false;
        continue;
      }
      const done = a.endTick !== null ? renderTick >= a.endTick : t > a.ttl + 2;
      if (done) {
        a.gfx.destroy({ children: true });
        this.remote.delete(id);
        continue;
      }
      a.gfx.visible = true;
      const d = (a.speed * t) / this.tickRate;
      const px = (a.x + a.dx * d) * TILE;
      const py = (a.y + a.dy * d) * TILE;
      a.gfx.position.set(px, py);
      pushHist(a.hist, px, py);
    }

    this.ghosts = this.ghosts.filter((g) => {
      const age = nowMs - g.bornMs;
      const unconfirmedTimeout = g.serverId === null && age > GHOST_CONFIRM_TIMEOUT_MS;
      const ended = g.endAtMs !== null && nowMs >= g.endAtMs;
      if (age > g.maxMs || unconfirmedTimeout || ended) {
        g.gfx.destroy({ children: true });
        return false;
      }
      const d = (g.speed * age) / 1000;
      const px = (g.x + g.dx * d) * TILE;
      const py = (g.y + g.dy * d) * TILE;
      g.gfx.position.set(px, py);
      pushHist(g.hist, px, py);
      return true;
    });

    this.drawTrails();
  }

  private drawTrails(): void {
    const g = this.trailG;
    g.clear();
    const draw = (hist: number[], warm: boolean): void => {
      const color = warm ? FIRE.flame : ARMORY.SHIELD_RAISED;
      for (let k = 0; k + 3 < hist.length; k += 2) {
        const seg = k / 2;
        g.moveTo(hist[k]!, hist[k + 1]!)
          .lineTo(hist[k + 2]!, hist[k + 3]!)
          .stroke({
            width: 2.2 - seg * 0.5,
            color,
            alpha: FX.arcade.trailAlpha * (1 - seg / (FX.arcade.trailSegs + 0.5)),
          });
      }
    };
    for (const a of this.remote.values()) if (a.gfx.visible) draw(a.hist, a.warm);
    for (const gh of this.ghosts) draw(gh.hist, gh.warm);
  }
}

function pushHist(hist: number[], x: number, y: number): void {
  hist.unshift(x, y);
  const max = (FX.arcade.trailSegs + 1) * 2;
  while (hist.length > max) hist.pop();
}

function makeArrowGfx(parent: Container, dx: number, dy: number, warm: boolean): Container {
  const root = new Container();
  const shaft = new Graphics();
  if (warm) {
    // Fletched hunting arrow — bone shaft, trailing feathers.
    shaft.moveTo(-5, 0).lineTo(5, 0).stroke({ width: 2, color: BONE });
    shaft
      .moveTo(5, 0)
      .lineTo(2, -2)
      .moveTo(5, 0)
      .lineTo(2, 2)
      .stroke({ width: 1.5, color: BONE });
    shaft
      .moveTo(-5, 0)
      .lineTo(-7, -2)
      .moveTo(-5, 0)
      .lineTo(-7, 2)
      .stroke({ width: 1, color: KHAKI });
  } else {
    // Engineer bolt: stubby steel — heavier head, cropped vanes.
    shaft.moveTo(-3.5, 0).lineTo(4, 0).stroke({ width: 2.4, color: ARMORY.STEEL });
    shaft.poly([4, -1.6, 6.5, 0, 4, 1.6]).fill(ARMORY.STEEL_BRIGHT);
    shaft
      .moveTo(-3.5, -1.4)
      .lineTo(-3.5, 1.4)
      .stroke({ width: 1.4, color: ARMORY.STEEL_DARK });
  }
  const glow = new Graphics();
  glow.blendMode = 'add';
  const tipX = warm ? 5 : 5.5;
  glow.circle(tipX, 0, 2.2).fill({ color: warm ? FIRE.flame : ARMORY.SHIELD_RAISED, alpha: 0.4 });
  glow.circle(tipX, 0, 1).fill({ color: 0xffffff, alpha: 0.38 });
  root.addChild(shaft);
  root.addChild(glow);
  root.rotation = Math.atan2(dy, dx);
  parent.addChild(root);
  return root;
}
