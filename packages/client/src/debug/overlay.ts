// F3 debug overlay: the objective numbers that stand in for "feel" —
// RTT, reconcile error, snap corrections, interp buffer health, bandwidth.

export class Overlay {
  private readonly el: HTMLElement;
  private visible = false;

  constructor() {
    this.el = document.getElementById('overlay')!;
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.visible = !this.visible;
        this.el.style.display = this.visible ? 'block' : 'none';
      }
    });
  }

  update(lines: Record<string, string | number>): void {
    if (!this.visible) return;
    this.el.textContent = Object.entries(lines)
      .map(([k, v]) => `${k.padEnd(14)} ${v}`)
      .join('\n');
  }
}

export function showBanner(text: string): void {
  const el = document.getElementById('banner')!;
  el.textContent = text;
  el.style.display = 'block';
}
