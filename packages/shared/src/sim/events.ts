// Everything discrete the simulation produces, consumed by the network layer,
// the test harness, and bots alike. Discriminated on `k`; every event carries
// the tick it happened on (`tk`) because the network batches events per
// snapshot and clients replay them on the delayed interp timeline.
//
// Distribution policy lives in the server (match.ts), but the intent is fixed
// here: kill/phase/end are GLOBAL (bounty is public information by design);
// projectile/hit events are POSITIONAL (fog-filtered); respawns are SQUAD-only.

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
      attacker: number;
      victim: number;
      amount: number;
      hp: number;
      kind: 'arrow' | 'melee';
      blocked: boolean;
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
      assists: number[];
    }
  // -- match flow, global
  | { k: 'phase'; tk: number; phase: number; endsTick: number }
  | {
      k: 'matchEnd';
      tk: number;
      winners: number[];
      standings: Array<{ squad: number; gold: number; kills: number }>;
    };
