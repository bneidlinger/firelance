import type { ClassId } from '@shared/config';
import type { InputCmd } from '@shared/sim/world';
import {
  BTN_BLOCK,
  BTN_BOMB,
  BTN_BUILD,
  BTN_DASH,
  BTN_FIRE,
  BTN_INTERACT,
} from '@shared/sim/world';

// Keyboard + mouse state, sampled into InputCmds at the sim rate (30Hz) by the
// main loop. Aim is a unit vector from the player's predicted position to the
// mouse's world position — computed by the caller, which owns both transforms.
//
// Presses are LATCHED between samples: a click or dash tap that lands between
// two 33ms samples must still fire. Holds are read live.

export class InputState {
  private keys = new Set<string>();
  private mouseButtons = new Set<number>();
  private latched = 0; // BTN_* bits pressed since the last sample
  mouseScreenX = 0;
  mouseScreenY = 0;
  /** Class switch requested this frame ('1'/'2' keys); consumed by main. */
  pendingClass: ClassId | null = null;

  attach(target: HTMLElement): void {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code === 'ShiftLeft') this.latched |= BTN_DASH;
      if (e.code === 'KeyF') this.latched |= BTN_BOMB; // tap-to-lob (edge-triggered sim-side)
      if (e.code === 'KeyB') this.latched |= BTN_BUILD; // tap-to-build a wall (edge-triggered)
      if (e.code === 'Digit1') this.pendingClass = 'fighter';
      if (e.code === 'Digit2') this.pendingClass = 'ranger';
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseButtons.clear();
    });
    target.addEventListener('pointermove', (e) => {
      this.mouseScreenX = e.clientX;
      this.mouseScreenY = e.clientY;
    });
    target.addEventListener('pointerdown', (e) => {
      this.mouseButtons.add(e.button);
      if (e.button === 0) this.latched |= BTN_FIRE;
      if (e.button === 2) this.latched |= BTN_BLOCK;
    });
    window.addEventListener('pointerup', (e) => this.mouseButtons.delete(e.button));
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Movement axes + button bitmask; aim filled in by the caller. */
  sampleMove(): Pick<InputCmd, 'mx' | 'my' | 'b'> {
    let mx = 0;
    let my = 0;
    if (this.isDown('KeyA') || this.isDown('ArrowLeft')) mx -= 1;
    if (this.isDown('KeyD') || this.isDown('ArrowRight')) mx += 1;
    if (this.isDown('KeyW') || this.isDown('ArrowUp')) my -= 1;
    if (this.isDown('KeyS') || this.isDown('ArrowDown')) my += 1;

    let b = this.latched;
    this.latched = 0;
    if (this.mouseButtons.has(0)) b |= BTN_FIRE;
    if (this.mouseButtons.has(2)) b |= BTN_BLOCK;
    if (this.isDown('Space') || this.isDown('ShiftLeft')) b |= BTN_DASH;
    // Interact is a pure HOLD (withdraw trickle / deposit channel) — no latch.
    if (this.isDown('KeyE')) b |= BTN_INTERACT;
    if (this.isDown('KeyF')) b |= BTN_BOMB;
    if (this.isDown('KeyB')) b |= BTN_BUILD;
    return { mx, my, b };
  }

  takePendingClass(): ClassId | null {
    const c = this.pendingClass;
    this.pendingClass = null;
    return c;
  }
}
