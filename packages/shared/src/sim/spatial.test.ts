import { describe, expect, it } from 'vitest';
import { SpatialHash } from './spatial';

describe('spatial hash', () => {
  it('finds points within the query circle and skips distant cells', () => {
    const h = new SpatialHash(2);
    h.insert(1, 5, 5);
    h.insert(2, 5.5, 5.5);
    h.insert(3, 50, 50);
    const near = h.queryCircle(5, 5, 2);
    expect(near).toContain(1);
    expect(near).toContain(2);
    expect(near).not.toContain(3);
  });

  it('handles negative coordinates', () => {
    const h = new SpatialHash(2);
    h.insert(7, -3, -3);
    expect(h.queryCircle(-3, -3, 1)).toContain(7);
  });

  it('clear() empties the grid', () => {
    const h = new SpatialHash(2);
    h.insert(1, 1, 1);
    h.clear();
    expect(h.queryCircle(1, 1, 5)).toHaveLength(0);
  });
});
