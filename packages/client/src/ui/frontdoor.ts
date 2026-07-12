// The front door (M6 s4): the first thing a friend ever sees. Class cards,
// a name, a three-line primer, PLAY. Shows ONLY for a bare URL — any ?name
// param or a live resume token skips it entirely, so every automation path,
// verify config, and F5 rejoin behaves exactly as before this file existed.

export type DoorClass = 'fighter' | 'ranger' | 'engineer';

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
    door.style.display = 'none';
    opts.onPlay(name, chosen);
  };
  playEl.addEventListener('click', play);
  nameEl.addEventListener('keydown', (e) => {
    if (e.code === 'Enter') play();
    e.stopPropagation(); // typing a name must not move a future body
  });
  door.style.display = 'flex';
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
