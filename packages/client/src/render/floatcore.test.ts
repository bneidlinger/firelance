import { describe, expect, it } from 'vitest';
import { FloatTextCore } from './floatcore';

// Rising-text lifecycle (M6 s1): ring pool with oldest-steal, ease-out rise,
// late fade, and clamped time so rAF stalls can't overshoot.

describe('FloatTextCore', () => {
  it('spawns into ring slots and steals the oldest when full', () => {
    const core = new FloatTextCore(3, 1000, 17);
    const a = core.spawn(0, 0, 'a', 0xffffff, 0);
    core.spawn(0, 0, 'b', 0xffffff, 10);
    core.spawn(0, 0, 'c', 0xffffff, 20);
    expect(core.activeCount()).toBe(3);
    expect(core.stolen).toBe(0);
    const d = core.spawn(0, 0, 'd', 0xffffff, 30);
    expect(d).toBe(a); // wrapped onto the oldest slot
    expect(core.stolen).toBe(1);
    expect(core.activeCount()).toBe(3);
    expect(core.items[a]!.text).toBe('d');
  });

  it('rises with ease-out and holds full alpha through the hold window', () => {
    const core = new FloatTextCore(2, 1000, 20);
    const idx = core.spawn(100, 200, '+5g', 0xf2d68c, 0);
    const it = core.items[idx]!;
    const start = core.pose(it, 0);
    expect(start.y).toBe(200);
    expect(start.alpha).toBe(1);
    const halfway = core.pose(it, 500);
    expect(halfway.y).toBeCloseTo(200 - 20 * 0.75, 5); // ease-out: 75% risen at t=0.5
    expect(halfway.alpha).toBe(1); // still inside the hold
    expect(halfway.done).toBe(false);
  });

  it('fades to zero at end of life and clamps past it', () => {
    const core = new FloatTextCore(2, 1000, 20);
    const idx = core.spawn(0, 50, 'x', 0xffffff, 0);
    const it = core.items[idx]!;
    const end = core.pose(it, 1000);
    expect(end.alpha).toBeCloseTo(0, 5);
    expect(end.done).toBe(true);
    const stale = core.pose(it, 5000); // long rAF stall
    expect(stale.alpha).toBeCloseTo(0, 5);
    expect(stale.y).toBe(50 - 20); // rise clamps at full, no overshoot
  });

  it('step deactivates expired items; clear kills all', () => {
    const core = new FloatTextCore(2, 1000, 20);
    core.spawn(0, 0, 'x', 0xffffff, 0);
    core.spawn(0, 0, 'y', 0xffffff, 600);
    core.step(1100);
    expect(core.activeCount()).toBe(1); // 'y' still inside its life
    core.clear();
    expect(core.activeCount()).toBe(0);
  });
});
