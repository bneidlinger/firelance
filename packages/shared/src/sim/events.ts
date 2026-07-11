// Everything discrete the simulation produces, consumed by the network layer,
// the test harness, and bots alike. Discriminated on `k`; every event carries
// the tick it happened on (`tk`) because the network batches events per
// snapshot and clients replay them on the delayed interp timeline.
//
// Distribution policy lives in the server (match.ts), but the intent is fixed
// here: kill/phase/end/banked are GLOBAL (bounty and banking success are
// public information by design — banked gold is the score); projectile/hit/
// sackTaken events are POSITIONAL (fog-filtered); respawns are SQUAD-only.

export type SimEvent =
  // -- combat, positional
  | {
      k: 'projSpawn';
      tk: number;
      id: number;
      owner: number;
      squad: number;
      x: number;
      y: number;
      dx: number;
      dy: number;
      speed: number;
      ttl: number;
    }
  | { k: 'projEnd'; tk: number; id: number; squad: number; x: number; y: number; hit?: number }
  | { k: 'swing'; tk: number; id: number; x: number; y: number; dx: number; dy: number }
  | {
      k: 'hit';
      tk: number;
      /** Attacking player id; -1 for an ownerless source (orphaned trap). */
      attacker: number;
      victim: number;
      amount: number;
      hp: number;
      kind: 'arrow' | 'melee' | 'bomb' | 'trap';
      blocked: boolean;
      x: number;
      y: number;
    }
  // -- firebombs, positional (the lob is public exactly like an arrow's flight)
  | {
      k: 'bombSpawn';
      tk: number;
      id: number;
      owner: number;
      squad: number;
      x: number;
      y: number;
      /** Locked landing point — the visible danger circle. */
      tx: number;
      ty: number;
      flightTicks: number;
    }
  | { k: 'bombEnd'; tk: number; id: number; squad: number; x: number; y: number }
  // -- keeps
  /** GLOBAL: a squad claimed its keep site (placement phase; `by` null = the
   *  deadline auto-assign). Same announce posture as keepRebuilt; the doc's
   *  "enemy keep locations hidden" tightens via M5 ghosting, not here. */
  | { k: 'keepClaimed'; tk: number; squad: number; x: number; y: number; by: number | null }
  /** Under-attack alarm — sent to the OWNING squad (throttled); positional otherwise. */
  | { k: 'keepHit'; tk: number; squad: number; hp: number; x: number; y: number }
  /** GLOBAL: a keep fell, its vault is on the ground — the map-level plunder bell. */
  | { k: 'keepDestroyed'; tk: number; squad: number; x: number; y: number; spilled: number }
  /** GLOBAL: an exiled squad bought its way back in. */
  | { k: 'keepRebuilt'; tk: number; squad: number; x: number; y: number; by: number }
  /** GLOBAL: all dead with no keep — the squad is out (spectating). */
  | { k: 'eliminated'; tk: number; squad: number }
  // -- structures (walls now; gates/towers/traps in later M4 slices), positional
  /** A structure went up — POSITIONAL (fog hides enemy building until seen). */
  | { k: 'structBuilt'; tk: number; id: number; squad: number; kind: number; x: number; y: number }
  /** A structure was destroyed — POSITIONAL. */
  | {
      k: 'structDestroyed';
      tk: number;
      id: number;
      squad: number;
      kind: number;
      x: number;
      y: number;
    }
  /** A build press patched a damaged own structure — POSITIONAL (hp = after). */
  | {
      k: 'structRepaired';
      tk: number;
      id: number;
      squad: number;
      by: number;
      hp: number;
      x: number;
      y: number;
    }
  /** A trap went off (consumed) — OWNER squad always (your tripwire fired,
   *  wherever you are); everyone else positional. The paired `hit` event
   *  carries the damage; this one carries the snap for fx/audio/alarm.
   *  NOTE: structBuilt for kind trap is OWN-squad only — never positional. */
  | {
      k: 'trapTriggered';
      tk: number;
      id: number;
      squad: number;
      victim: number;
      x: number;
      y: number;
    }
  // -- lifecycle
  | { k: 'respawn'; tk: number; id: number; squad: number; x: number; y: number }
  // -- economy, global (bounty is public info)
  | {
      k: 'kill';
      tk: number;
      killer: number | null;
      victim: number;
      /** Total gold minted to the killer's squad for this kill (0 if farmed/no killer). */
      gold: number;
      /** Victim's bounty at the moment of death (killfeed drama). */
      victimBounty: number;
      /** Carried gold the victim spilled as a ground sack (0 = empty-handed).
       *  Amount is public (vulture bait by design) — the sack POSITION is not. */
      droppedGold: number;
      assists: number[];
    }
  // -- banking
  /** A deposit channel completed — global; the scoreboard moved. */
  | { k: 'banked'; tk: number; squad: number; by: number; amount: number; x: number; y: number }
  /** A ground sack was scooped — positional; you only learn it if you saw it. */
  | {
      k: 'sackTaken';
      tk: number;
      id: number;
      by: number;
      squad: number;
      gold: number;
      x: number;
      y: number;
    }
  // -- match flow, global
  | { k: 'phase'; tk: number; phase: number; endsTick: number }
  | {
      k: 'matchEnd';
      tk: number;
      winners: number[];
      standings: Array<{
        squad: number;
        banked: number;
        gold: number;
        kills: number;
        eliminated: boolean;
      }>;
    };
