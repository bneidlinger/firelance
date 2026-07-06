import type { InputCmd } from '@shared/sim/world';

// Keyboard + mouse state, sampled into InputCmds at the sim rate (30Hz) by the
// main loop. Aim is a unit vector from the player's predicted position to the
// mouse's world position — computed by the caller, which owns both transforms.

export class InputState {
  private keys = new Set<string>();
  mouseScreenX = 0;
  mouseScreenY = 0;

  attach(target: HTMLElement): void {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    target.addEventListener('pointermove', (e) => {
      this.mouseScreenX = e.clientX;
      this.mouseScreenY = e.clientY;
    });
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Movement axes from WASD/arrows; aim filled in by the caller. */
  sampleMove(): Pick<InputCmd, 'mx' | 'my' | 'b'> {
    let mx = 0;
    let my = 0;
    if (this.isDown('KeyA') || this.isDown('ArrowLeft')) mx -= 1;
    if (this.isDown('KeyD') || this.isDown('ArrowRight')) mx += 1;
    if (this.isDown('KeyW') || this.isDown('ArrowUp')) my -= 1;
    if (this.isDown('KeyS') || this.isDown('ArrowDown')) my += 1;
    return { mx, my, b: 0 };
  }
}
