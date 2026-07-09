import { describe, expect, it } from 'vitest';
import { getConfigPreset } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { decodeServerMsg, encodeMsg } from '@shared/net/codec';
import { PROTOCOL_VERSION } from '@shared/net/messages';
import type { ServerMsg, SnapMsg } from '@shared/net/messages';
import { STRUCT_WALL } from '@shared/sim/world';
import { Match } from '../src/match';
import { createLocalPair } from '../src/transport';

// The structure fog wrapper (buildSquadStructures) applies the same interest
// management as entities: your own walls are always serialized to you, an
// enemy's wall stays hidden until one of your squad has eyes on its tile. And
// build-supply rides the private `you` block. (Design §12.1: built structures
// are hidden information.)

function connectClient(match: Match, name: string): { msgs: ServerMsg[] } {
  const pair = createLocalPair();
  const msgs: ServerMsg[] = [];
  pair.clientEnd.onMessage((d) => {
    const r = decodeServerMsg(d);
    if (r.ok) msgs.push(r.msg);
  });
  match.addConn(pair.serverEnd);
  pair.clientEnd.send(encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name }));
  return { msgs };
}

function lastSnap(msgs: ServerMsg[]): SnapMsg {
  const snaps = msgs.filter((m): m is SnapMsg => m.t === 'snap');
  return snaps[snaps.length - 1]!;
}

describe('structure snapshots are fog-filtered', () => {
  it('owner sees their wall; a distant enemy never does; supply rides `you`', () => {
    const cfg = getConfigPreset('smoke');
    const match = new Match({ cfg, map: getMap('scrim_small'), seed: 1 });
    const owner = connectClient(match, 'owner'); // squad 0
    const spy = connectClient(match, 'spy'); // squad 1

    // Tick once so the match goes live (goLive clears any warmup structures),
    // THEN plant a squad-0 wall a couple tiles off its own keep.
    match.tick();
    const k0 = match.world.squads[0]!;
    const tx = Math.floor(k0.keepX) + 2;
    const ty = Math.floor(k0.keepY);
    match.world.structures.set(match.world.nextId, {
      id: match.world.nextId++,
      kind: STRUCT_WALL,
      squad: 0,
      tx,
      ty,
      hp: cfg.build.wall.hp,
      maxHp: cfg.build.wall.hp,
    });

    // Confirm the two squads are genuinely out of each other's vision.
    const k1 = match.world.squads[1]!;
    expect(Math.abs(k1.keepX - k0.keepX)).toBeGreaterThan(cfg.vision.radius * 2);

    for (let i = 0; i < 6; i++) match.tick(); // emit a few snapshots

    const ownerSnap = lastSnap(owner.msgs);
    const spySnap = lastSnap(spy.msgs);

    // Owner always sees their own wall...
    const ownWall = ownerSnap.structures.find((s) => s.tx === tx && s.ty === ty);
    expect(ownWall).toBeDefined();
    expect(ownWall!.s).toBe(0);
    expect(ownWall!.hp).toBe(cfg.build.wall.hp);

    // ...the distant enemy sees no structures at all (fog hides it).
    expect(spySnap.structures.length).toBe(0);

    // Build-supply is private state on the recipient's own `you` block.
    expect(ownerSnap.you.supply).toBeGreaterThan(0);
    expect(ownerSnap.you.supply).toBeLessThanOrEqual(cfg.build.supplyCap);
  });
});
