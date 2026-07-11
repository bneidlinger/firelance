import type { StructSnap } from '@shared/net/messages';
import { STRUCT_TRAP } from '@shared/sim/world';

// Last-known-position ghosting for enemy structures (M5, doc §12.1): the
// snapshot only carries what your squad can SEE, so an enemy wall you scouted
// vanishes from the wire the moment fog re-covers it. Humans remember maps —
// the client should too. This holds the last-seen snap of every enemy piece
// and offers it back as a dimmed "ghost" until either (a) the piece is seen
// again (live snap wins), or (b) the tile is CURRENTLY visible and the piece
// is absent — an eyes-on verification that it's gone. Pure memory, zero
// protocol: ghosts never join occupancy or prediction (they may be stale —
// walking into a phantom wall would rubber-band).
//
// Enemy traps never arrive in squad snapshots, so they can't ghost — except
// via the eliminated-spectator firehose, which is why kind 3 is filtered here
// too (a spectator's leftover trap memory would be nonsense next match... and
// matches rebuild the whole layer anyway; belt and suspenders).

export class GhostMemory {
  private readonly mem = new Map<number, StructSnap>();

  clear(): void {
    this.mem.clear();
  }

  get size(): number {
    return this.mem.size;
  }

  /** Ids currently remembered (debug probe). */
  ids(): number[] {
    return [...this.mem.keys()];
  }

  /**
   * Feed the newest visible set; get back the ghosts to render alongside it.
   * `isTileVisible` must be the SAME visibility the fog mask draws from —
   * a ghost standing on a tile the player can see through reads as a bug.
   */
  update(
    structs: StructSnap[],
    ownSquad: number,
    isTileVisible: (tx: number, ty: number) => boolean,
  ): StructSnap[] {
    const live = new Set<number>();
    for (const s of structs) {
      live.add(s.i);
      if (s.s !== ownSquad && s.k !== STRUCT_TRAP) this.mem.set(s.i, s);
    }
    const ghosts: StructSnap[] = [];
    for (const [id, s] of this.mem) {
      if (live.has(id)) continue; // on the wire right now — the live sprite wins
      if (isTileVisible(s.tx, s.ty)) {
        // Eyes on the tile, nothing standing there: verified gone.
        this.mem.delete(id);
        continue;
      }
      ghosts.push(s);
    }
    return ghosts;
  }

  /** A structDestroyed event names this id — the memory is certain now. */
  forget(id: number): void {
    this.mem.delete(id);
  }
}
