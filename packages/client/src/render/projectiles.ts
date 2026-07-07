import { Container, Graphics } from 'pixi.js';
import type { SimEvent } from '@shared/sim/events';
import { TILE } from './scene';

// Arrows are events-only: the server sends spawn + end, the client integrates
// flight locally. Remote arrows fly on the DELAYED interp timeline so they
// line up with the bodies they threaten (arrows must never lead their
// targets). The player's OWN arrows render as real-time "ghosts" spawned at
// the muzzle on click — when the authoritative spawn arrives it adopts the
// ghost, so your own shot never feels a round-trip late.

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
  gfx: Graphics;
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
  gfx: Graphics;
}

const GHOST_CONFIRM_TIMEOUT_MS = 500;

export class ProjectileLayer {
  private readonly remote = new Map<number, RemoteArrow>();
  private ghosts: GhostArrow[] = [];

  constructor(
    private readonly container: Container,
    private readonly tickRate: number,
  ) {}

  /** Automation/debug: how many arrows each timeline is tracking. */
  counts(): { remote: number; ghosts: number; confirmedGhosts: number } {
    return {
      remote: this.remote.size,
      ghosts: this.ghosts.length,
      confirmedGhosts: this.ghosts.filter((g) => g.serverId !== null).length,
    };
  }

  clear(): void {
    for (const a of this.remote.values()) a.gfx.destroy();
    this.remote.clear();
    for (const g of this.ghosts) g.gfx.destroy();
    this.ghosts = [];
  }

  /** Fire-and-forget local muzzle prediction for the player's own shot. */
  spawnGhost(x: number, y: number, dx: number, dy: number, speed: number, ttlSec: number): void {
    const gfx = makeArrowGfx(this.container, dx, dy);
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
    const gfx = makeArrowGfx(this.container, ev.dx, ev.dy);
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
        a.gfx.destroy();
        this.remote.delete(id);
        continue;
      }
      a.gfx.visible = true;
      const d = (a.speed * t) / this.tickRate;
      a.gfx.position.set((a.x + a.dx * d) * TILE, (a.y + a.dy * d) * TILE);
    }

    this.ghosts = this.ghosts.filter((g) => {
      const age = nowMs - g.bornMs;
      const unconfirmedTimeout = g.serverId === null && age > GHOST_CONFIRM_TIMEOUT_MS;
      const ended = g.endAtMs !== null && nowMs >= g.endAtMs;
      if (age > g.maxMs || unconfirmedTimeout || ended) {
        g.gfx.destroy();
        return false;
      }
      const d = (g.speed * age) / 1000;
      g.gfx.position.set((g.x + g.dx * d) * TILE, (g.y + g.dy * d) * TILE);
      return true;
    });
  }
}

function makeArrowGfx(parent: Container, dx: number, dy: number): Graphics {
  const g = new Graphics();
  // Simple fletched shaft, drawn pointing +x then rotated to the flight dir.
  g.moveTo(-5, 0).lineTo(5, 0).stroke({ width: 2, color: 0xe8dcc0 });
  g.moveTo(5, 0).lineTo(2, -2).moveTo(5, 0).lineTo(2, 2).stroke({ width: 1.5, color: 0xe8dcc0 });
  g.moveTo(-5, 0).lineTo(-7, -2).moveTo(-5, 0).lineTo(-7, 2).stroke({ width: 1, color: 0xb9ad98 });
  g.rotation = Math.atan2(dy, dx);
  parent.addChild(g);
  return g;
}
