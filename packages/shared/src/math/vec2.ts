// 2D vector helpers on plain {x, y} objects. Only +,-,*,/ and sqrt so results
// are IEEE-754 identical across server and client (determinism contract).
export interface Vec2 {
  x: number;
  y: number;
}

export function len(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return len(bx - ax, by - ay);
}

export function distSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/** Normalize into out; returns zero vector unchanged. */
export function normalize(x: number, y: number): Vec2 {
  const l = len(x, y);
  if (l === 0) return { x: 0, y: 0 };
  return { x: x / l, y: y / l };
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
