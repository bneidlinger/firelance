import { describe, expect, it } from 'vitest';
import { getConfigPreset } from '@shared/config';
import { getMap } from '@shared/map/maps';
import { decodeServerMsg, encodeMsg } from '@shared/net/codec';
import { PROTOCOL_VERSION } from '@shared/net/messages';
import type { EvMsg, ServerMsg, SnapMsg } from '@shared/net/messages';
import type { ClassId } from '@shared/config';
import { BTN_BUILD_TRAP, STRUCT_TRAP, STRUCT_WALL } from '@shared/sim/world';
import { Match } from '../src/match';
import { createLocalPair } from '../src/transport';

// The structure fog wrapper (buildSquadStructures) applies the same interest
// management as entities: your own walls are always serialized to you, an
// enemy's wall stays hidden until one of your squad has eyes on its tile. And
// build-supply rides the private `you` block. (Design §12.1: built structures
// are hidden information.) Traps go further: NEVER serialized to enemies and
// their structBuilt event is own-squad only — the whole slice hangs on that.

function connectClient(
  match: Match,
  name: string,
  cls?: ClassId,
): { msgs: ServerMsg[]; send: (msg: object) => void } {
  const pair = createLocalPair();
  const msgs: ServerMsg[] = [];
  pair.clientEnd.onMessage((d) => {
    const r = decodeServerMsg(d);
    if (r.ok) msgs.push(r.msg);
  });
  match.addConn(pair.serverEnd);
  pair.clientEnd.send(encodeMsg({ t: 'hello', v: PROTOCOL_VERSION, name, cls }));
  return { msgs, send: (msg) => pair.clientEnd.send(JSON.stringify(msg)) };
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
      by: -1,
      tx,
      ty,
      hp: cfg.build.wall.hp,
      maxHp: cfg.build.wall.hp,
      bornTick: match.world.tick,
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

  it('a trap is squad-secret even with enemy eyes on the tile; its trigger reaches the far-away owner', () => {
    const cfg = getConfigPreset('smoke');
    const match = new Match({ cfg, map: getMap('scrim_small'), seed: 1 });
    const owner = connectClient(match, 'owner', 'engineer'); // squad 0
    const spy = connectClient(match, 'spy'); // squad 1
    match.tick(); // live

    const w = match.world;
    const eng = [...w.players.values()].find((p) => p.name === 'owner')!;
    const spyP = [...w.players.values()].find((p) => p.name === 'spy')!;
    expect(eng.cls).toBe('engineer');

    // Park the spy two tiles from the engineer — eyes on EVERYTHING nearby —
    // and have the engineer plant a trap right in front of both of them. The
    // press goes through the REAL wire path (decode → acceptInput →
    // sanitizeInput): a hardcoded 8-bit button mask in the sanitizer once
    // stripped BTN_BUILD_TRAP (bit 9) — this test now fails if that regresses.
    spyP.x = eng.x + 2;
    spyP.y = eng.y;
    owner.send({ t: 'input', seq: 1, tick: 0, mx: 0, my: 0, ax: 0, ay: -1, b: BTN_BUILD_TRAP });
    match.tick();
    owner.send({ t: 'input', seq: 2, tick: 0, mx: 0, my: 0, ax: 0, ay: -1, b: 0 });
    match.tick();

    const trap = [...w.structures.values()].find((s) => s.kind === STRUCT_TRAP);
    expect(trap, 'placement must succeed for this test to mean anything').toBeDefined();

    for (let i = 0; i < 4; i++) match.tick(); // flush snapshots + events

    const evsOf = (msgs: ServerMsg[]) =>
      msgs.filter((m): m is EvMsg => m.t === 'ev').flatMap((m) => m.events);
    // The owner hears their own structBuilt; the watching spy hears NOTHING.
    expect(evsOf(owner.msgs).some((e) => e.k === 'structBuilt' && e.kind === STRUCT_TRAP)).toBe(
      true,
    );
    expect(evsOf(spy.msgs).some((e) => e.k === 'structBuilt' && e.kind === STRUCT_TRAP)).toBe(
      false,
    );
    // Snapshots: owner carries the trap (arming flag while young); spy never.
    const ownTrap = lastSnap(owner.msgs).structures.find((s) => s.k === STRUCT_TRAP);
    expect(ownTrap).toBeDefined();
    expect(ownTrap!.ar).toBe(1); // still arming this early
    expect(lastSnap(spy.msgs).structures.some((s) => s.k === STRUCT_TRAP)).toBe(false);

    // Send the owner across the map, arm the trap, and walk the spy onto it:
    // the trigger event must reach the distant owner (the tripwire doubles as
    // an alarm), and the spy stays rooted with the damage applied.
    eng.x = w.squads[1]!.keepX;
    eng.y = w.squads[1]!.keepY;
    const armTicks = Math.round(cfg.build.trap.armSec * cfg.tick.simHz);
    for (let i = 0; i < armTicks + 2; i++) match.tick();
    spyP.x = trap!.tx + 0.5;
    spyP.y = trap!.ty + 0.5;
    match.tick();
    for (let i = 0; i < 4; i++) match.tick();

    expect(w.structures.has(trap!.id)).toBe(false); // consumed
    expect(evsOf(owner.msgs).some((e) => e.k === 'trapTriggered')).toBe(true);
    expect(evsOf(spy.msgs).some((e) => e.k === 'trapTriggered')).toBe(true);
    expect(spyP.hp).toBe(cfg.classes[spyP.cls].maxHp - cfg.build.trap.damage);
    // And the owner's own-trap snapshot entry is gone with it.
    expect(lastSnap(owner.msgs).structures.some((s) => s.k === STRUCT_TRAP)).toBe(false);
  });
});
