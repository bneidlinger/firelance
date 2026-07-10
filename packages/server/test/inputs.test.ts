import { describe, expect, it } from 'vitest';
import { BTN_ALL, BTN_BUILD_TRAP, BTN_DASH, BTN_FIRE } from '@shared/sim/world';
import { sanitizeInput } from '../src/inputs';

// The sanitizer is the trust boundary every input crosses. Its button mask
// must be derived from the DEFINED buttons — a hardcoded width shipped the
// trap button (bit 9) dead once: 0xff chopped it and every V-press vanished
// server-side while all 8 older buttons kept working.

describe('sanitizeInput button mask', () => {
  const msg = { t: 'input' as const, seq: 1, tick: 0, mx: 0, my: 0, ax: 1, ay: 0, b: 0 };

  it('every defined button survives sanitization', () => {
    expect(sanitizeInput({ ...msg, b: BTN_ALL }).b).toBe(BTN_ALL);
    expect(sanitizeInput({ ...msg, b: BTN_BUILD_TRAP }).b).toBe(BTN_BUILD_TRAP);
    expect(sanitizeInput({ ...msg, b: BTN_FIRE | BTN_DASH }).b).toBe(BTN_FIRE | BTN_DASH);
  });

  it('undefined bits are stripped', () => {
    expect(sanitizeInput({ ...msg, b: BTN_ALL | 0x10000 }).b).toBe(BTN_ALL);
    expect(sanitizeInput({ ...msg, b: -1 }).b).toBe(BTN_ALL);
  });
});
