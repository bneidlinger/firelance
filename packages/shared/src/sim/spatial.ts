// Uniform-grid spatial hash, rebuilt from scratch every tick (a few hundred
// inserts — rebuilding is simpler than incremental maintenance and costs
// microseconds). Serves projectile sweeps, melee arcs, and vision candidate
// pruning from M1 on.
export class SpatialHash {
  private cells = new Map<number, number[]>();
  constructor(private readonly cellSize: number) {}

  clear(): void {
    this.cells.clear();
  }

  private key(cx: number, cy: number): number {
    // Offset so negative coords hash cleanly; maps up to ±32k cells.
    return (cx + 32768) * 65536 + (cy + 32768);
  }

  insert(id: number, x: number, y: number): void {
    const k = this.key(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize));
    const cell = this.cells.get(k);
    if (cell) cell.push(id);
    else this.cells.set(k, [id]);
  }

  /** Ids whose insert point lies within `r` of (x, y). Caller re-checks exact shapes. */
  queryCircle(x: number, y: number, r: number, out: number[] = []): number[] {
    const c = this.cellSize;
    const cx0 = Math.floor((x - r) / c);
    const cx1 = Math.floor((x + r) / c);
    const cy0 = Math.floor((y - r) / c);
    const cy1 = Math.floor((y + r) / c);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = this.cells.get(this.key(cx, cy));
        if (cell) {
          for (const id of cell) out.push(id);
        }
      }
    }
    return out;
  }
}
