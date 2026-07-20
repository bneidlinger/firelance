// The front door (M6 s4): the first thing a friend ever sees. Class cards,
// a name, a three-line primer, PLAY. Shows ONLY for a bare URL — any ?name
// param or a live resume token skips it entirely, so every automation path,
// verify config, and F5 rejoin behaves exactly as before this file existed.
//
// G6 adds the key art: a procedural dusk painted onto #doorart behind the
// cards — ember horizon, silhouette treelines, a distant keep flying its
// banner, embers drifting up. Plain canvas 2D with its own tiny rAF loop
// (the Pixi scene doesn't exist until the welcome); it stops on RIDE.

import { ALARM, cssOf, FIRE, GOLD, INK } from '../render/palette';

export type DoorClass = 'fighter' | 'ranger' | 'engineer';

/** Paint the dusk behind the door; returns a stop() that ends the loop. */
function startDoorArt(): () => void {
  const cv = document.getElementById('doorart') as HTMLCanvasElement | null;
  const ctx = cv?.getContext('2d');
  if (!cv || !ctx) return () => {};
  const hash = (a: number, b: number): number =>
    (((((a + 7) * 73856093) ^ ((b + 3) * 19349663)) >>> 0) % 1000) / 1000;
  let raf = 0;
  const draw = (): void => {
    const w = cv.clientWidth || window.innerWidth;
    const h = cv.clientHeight || window.innerHeight;
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const t = performance.now();
    const horizon = h * 0.54;

    // Dusk sky: night above, an ember band where the sun went down.
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#0a0d12');
    sky.addColorStop(0.55, '#141710');
    sky.addColorStop(0.88, '#31221a');
    sky.addColorStop(1, '#4a2f1e');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizon);
    ctx.fillStyle = '#7a4224';
    ctx.globalAlpha = 0.6;
    ctx.fillRect(0, horizon - 2, w, 2);
    ctx.globalAlpha = 1;

    // Stars, twinkling faintly.
    for (let i = 0; i < 44; i++) {
      const a = (0.2 + hash(i, 3) * 0.45) * (0.7 + 0.3 * Math.sin(t / 900 + i));
      ctx.globalAlpha = a;
      ctx.fillStyle = '#e8e4d8';
      const r = 0.6 + hash(i, 4);
      ctx.beginPath();
      ctx.arc(hash(i, 1) * w, hash(i, 2) * horizon * 0.75, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Ground, then the far treeline scallops.
    ctx.fillStyle = '#10130c';
    ctx.fillRect(0, horizon, w, h - horizon);
    ctx.fillStyle = '#11150c';
    for (let x = -20; x < w + 40; x += 26) {
      const r = 12 + hash(x, 7) * 16;
      ctx.beginPath();
      ctx.arc(x, horizon + 4 - r * 0.35, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillRect(0, horizon + 4, w, h * 0.2);

    // The distant keep on its knoll, banner up — the whole pitch in silhouette.
    const cx = w * 0.7;
    const base = horizon + 2;
    ctx.fillStyle = '#0e120a';
    ctx.beginPath();
    ctx.ellipse(cx, base + 10, 130, 26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0a0d08';
    ctx.fillRect(cx - 46, base - 30, 92, 34);
    ctx.fillRect(cx - 56, base - 44, 16, 48);
    ctx.fillRect(cx + 40, base - 44, 16, 48);
    ctx.fillRect(cx - 18, base - 50, 36, 24);
    for (let m = 0; m < 3; m++) {
      ctx.fillRect(cx - 54 + m * 6, base - 48, 3, 4);
      ctx.fillRect(cx + 42 + m * 6, base - 48, 3, 4);
    }
    // Lit windows — somebody is home, and rich.
    ctx.fillStyle = cssOf(GOLD.bright);
    for (const [wx, wy] of [
      [cx - 49, base - 30],
      [cx + 47, base - 22],
      [cx - 4, base - 40],
      [cx + 10, base - 38],
    ] as Array<[number, number]>) {
      ctx.globalAlpha = 0.55 + 0.3 * Math.sin(t / 700 + wx);
      ctx.fillRect(wx, wy, 2.5, 3.5);
    }
    ctx.globalAlpha = 1;
    // Mast + the waving banner.
    ctx.strokeStyle = cssOf(INK);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, base - 50);
    ctx.lineTo(cx, base - 76);
    ctx.stroke();
    const sway = Math.sin(t / 320) * 3;
    ctx.fillStyle = cssOf(ALARM);
    ctx.beginPath();
    ctx.moveTo(cx + 1, base - 76);
    ctx.lineTo(cx + 21, base - 71 + sway);
    ctx.lineTo(cx + 1, base - 67);
    ctx.closePath();
    ctx.fill();

    // Near treeline, black against the field.
    ctx.fillStyle = '#080b06';
    const near = h * 0.74;
    for (let x = -30; x < w + 40; x += 34) {
      const r = 18 + hash(x, 9) * 18;
      ctx.beginPath();
      ctx.arc(x, near - r * 0.3, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillRect(0, near, w, h - near);

    // Embers on the night air.
    for (let i = 0; i < 16; i++) {
      const p = ((t * (0.012 + hash(i, 11) * 0.022)) / 1000 + hash(i, 12)) % 1;
      const y = h * 0.92 - p * h * 0.6;
      const x = hash(i, 13) * w + Math.sin(t / 1400 + i * 1.7) * 18;
      ctx.globalAlpha = (1 - p) * 0.5;
      ctx.fillStyle = i % 3 === 0 ? cssOf(FIRE.flame) : cssOf(FIRE.fire);
      ctx.beginPath();
      ctx.arc(x, y, 1 + hash(i, 14) * 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Edge vignette so the door's parchment stays the brightest thing.
    const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.28, w / 2, h / 2, h * 0.85);
    vig.addColorStop(0, 'rgba(6, 8, 5, 0)');
    vig.addColorStop(1, 'rgba(6, 8, 5, 0.6)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);

    raf = requestAnimationFrame(draw);
  };
  // First frame synchronously: the door must never open on a blank wall
  // (and occluded panes may never fire rAF at all — the verify rig's world).
  draw();
  return () => cancelAnimationFrame(raf);
}

export interface FrontDoorOpts {
  /** True = never show the door; join immediately with the defaults. */
  skip: boolean;
  defaultName: string;
  defaultCls: DoorClass | undefined;
  onPlay: (name: string, cls: DoorClass | undefined) => void;
}

const CARDS: Array<{ cls: DoorClass; icon: string; title: string; blurb: string }> = [
  {
    cls: 'fighter',
    icon: '⚔',
    title: 'Fighter',
    blurb: 'Sword & shield. Block arrows, hold the door, win the brawl.',
  },
  {
    cls: 'ranger',
    icon: '➶',
    title: 'Ranger',
    blurb: 'The bow. Arrows anyone can dodge — and you make them miss.',
  },
  {
    cls: 'engineer',
    icon: '🔧',
    title: 'Engineer',
    blurb: 'Crossbow & tools. Walls, gates, watchtowers, hidden traps.',
  },
];

export function initFrontDoor(opts: FrontDoorOpts): void {
  initHelpToggle();
  if (opts.skip) {
    opts.onPlay(opts.defaultName, opts.defaultCls);
    return;
  }
  const door = document.getElementById('frontdoor')!;
  const cardsEl = document.getElementById('doorcards')!;
  const nameEl = document.getElementById('doorname') as HTMLInputElement;
  const playEl = document.getElementById('doorplay')!;
  nameEl.value = opts.defaultName;
  let stopArt: () => void = () => {};

  let chosen: DoorClass = opts.defaultCls ?? 'fighter';
  const cardEls = new Map<DoorClass, HTMLElement>();
  for (const c of CARDS) {
    const el = document.createElement('div');
    el.className = 'doorcard';
    el.innerHTML = `<div class="ic">${c.icon}</div><div class="ti">${c.title}</div><div class="bl">${c.blurb}</div>`;
    el.addEventListener('click', () => {
      chosen = c.cls;
      for (const [cls, e] of cardEls) e.classList.toggle('sel', cls === c.cls);
    });
    cardsEl.appendChild(el);
    cardEls.set(c.cls, el);
  }
  cardEls.get(chosen)!.classList.add('sel');

  const play = (): void => {
    const name = nameEl.value.trim().slice(0, 16) || opts.defaultName;
    stopArt();
    door.style.display = 'none';
    opts.onPlay(name, chosen);
  };
  playEl.addEventListener('click', play);
  nameEl.addEventListener('keydown', (e) => {
    if (e.code === 'Enter') play();
    e.stopPropagation(); // typing a name must not move a future body
  });
  door.style.display = 'flex';
  stopArt = startDoorArt();
}

/** H toggles the controls cheat-sheet, on the door and in the match alike. */
function initHelpToggle(): void {
  const help = document.getElementById('helpov')!;
  const toggle = (): void => {
    help.style.display = help.style.display === 'block' ? 'none' : 'block';
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyH' && (e.target as HTMLElement)?.tagName !== 'INPUT') toggle();
  });
  document.getElementById('doorhelp')!.addEventListener('click', toggle);
  help.addEventListener('click', toggle);
}
