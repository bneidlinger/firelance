// Constant-speed projectile intercept of a constant-velocity target.
// Used by bots for aim lead (NOT part of the sim path — sqrt only, but the
// caller feeds it snapshot data, never authoritative world state).

export interface InterceptSolution {
  /** Unit aim direction. */
  ax: number;
  ay: number;
  /** Flight time in seconds. */
  t: number;
}

/**
 * Solve |targetPos + targetVel·t − shooter| = projSpeed·t for the smallest
 * positive t. Returns null when the target outruns the projectile.
 */
export function solveIntercept(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  tvx: number,
  tvy: number,
  projSpeed: number,
): InterceptSolution | null {
  const dx = tx - sx;
  const dy = ty - sy;
  const a = tvx * tvx + tvy * tvy - projSpeed * projSpeed;
  const b = 2 * (dx * tvx + dy * tvy);
  const c = dx * dx + dy * dy;

  let t: number;
  if (Math.abs(a) < 1e-9) {
    // Target speed ≈ projectile speed: linear equation.
    if (Math.abs(b) < 1e-9) return null;
    t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    t = Math.min(t1, t2);
    if (t <= 0) t = Math.max(t1, t2);
  }
  if (t <= 0 || !Number.isFinite(t)) return null;

  const ix = dx + tvx * t;
  const iy = dy + tvy * t;
  const l = Math.sqrt(ix * ix + iy * iy);
  if (l < 1e-9) return null;
  return { ax: ix / l, ay: iy / l, t };
}
