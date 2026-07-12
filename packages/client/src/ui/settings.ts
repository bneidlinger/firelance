import { audioLevels, setAudioLevel, sfx, unlockAudio } from '../audio/sfx';
import type { AudioChannel } from '../audio/mixer';

// Esc settings drawer (M6 s1): volume sliders over the persisted audio buses.
// DOM like the rest of the HUD; the panel re-enables pointer-events locally
// (the .hud base class kills them so chrome never eats game clicks).

const SLIDERS: Array<{ ch: AudioChannel; id: string }> = [
  { ch: 'master', id: 'vol-master' },
  { ch: 'sfx', id: 'vol-sfx' },
  { ch: 'ambient', id: 'vol-ambient' }, // the s4 wind bed
];

export function initSettings(): void {
  const panel = document.getElementById('settings')!;
  const gear = document.getElementById('gearbtn')!;

  const toggle = (): void => {
    const showing = panel.style.display === 'block';
    panel.style.display = showing ? 'none' : 'block';
    if (!showing) unlockAudio(); // opening IS a user gesture — seize it
  };

  gear.addEventListener('click', toggle);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') toggle();
  });

  for (const { ch, id } of SLIDERS) {
    const el = document.getElementById(id) as HTMLInputElement;
    el.value = String(Math.round(audioLevels()[ch] * 100));
    el.addEventListener('input', () => {
      setAudioLevel(ch, Number(el.value) / 100);
      sfx('coin'); // audition the new level (its spam gap paces the drag)
    });
  }
}
