# Firelance

Top-down multiplayer medieval bounty-siege game. Design docs live in [docs/](docs/).

**Milestone 1 (bounty combat) is in**: Fighter/Ranger kits, dodgeable arrows, melee
with telegraphed windups, shield blocking, dash dodges, kill gold + personal
bounty with anti-farm rules, live fog of war, killfeed with payouts, bounty
leaderboard, ~8-minute auto-restarting matches, and combat bots for all 12 seats.

## Quick start

```sh
npm install
npm run dev:server   # authoritative server on ws://localhost:8787 (+3 in-process bots)
npm run dev:client   # Vite client on http://localhost:5173
```

The daily solo loop: `npm run play:bots` (server + 11 bots), then open
http://localhost:5173 and you're the 12th seat.

## Controls

| Input              | Action                                               |
| ------------------ | ---------------------------------------------------- |
| WASD / arrows      | move                                                 |
| mouse              | aim                                                  |
| left click         | fire bow / swing (hold to keep attacking)            |
| right click (hold) | shield block — Fighter only, frontal 120°, slows you |
| Space / Shift      | dash (displacement dodge, no i-frames)               |
| 1 / 2              | switch to Fighter / Ranger at next respawn           |
| F3                 | netcode debug overlay                                |

Useful client URL params: `?name=Brandon` `?class=fighter` `?fakelag=120&jitter=30` `?nopredict`
**Judge all combat feel at `?fakelag=120&jitter=30`** — never at localhost-zero.

## Play with friends (quick tunnel)

One URL, zero installs for them:

```sh
npm -w @firelance/client run build                 # build the client once
npx tsx packages/server/src/index.ts --config prototype --bots 11
# in another terminal (needs cloudflared installed: winget install Cloudflare.cloudflared)
cloudflared tunnel --url http://localhost:8787
```

Send friends the printed `https://….trycloudflare.com` URL. The server serves
the built client and the WebSocket on the same origin, so the tunnel carries
everything. Humans replace bots seat-by-seat as they join; matches restart
automatically 30s after each end screen.

## Verification

```sh
npm test                # 122 tests: sim units, invariants, fog property test,
                        #   3-seed 12-bot combat sanity, replay determinism
npm run match:smoke     # in-process 12-bot match at turbo speed, prints report
npm run match:headless  # 12 bots over real websockets, p99 tick budget check
npm run typecheck
```

The invariant backbone: gold conservation holds every tick (Σ minted ==
Σ everywhere gold can sit), fog never serializes an invisible enemy (1,000-state
property test), same seed ⇒ bit-identical replay, and every failing harness run
dumps its replay to `replays/` for offline reproduction.

Bots: `npm run bots -- --count 8 --skill easy|mid|hard` connects extra combat
bots to a running server (SEEK/ATTACK/FLEE, intercept-lead aim with gaussian
error, class kits).

## Layout

- `packages/shared` — pure simulation (movement/dash/block kernel, attacks,
  projectiles, economy+bounty, vision, match flow), config presets, map,
  protocol. Zero runtime deps, no DOM/Node APIs.
- `packages/server` — authoritative Node server (30Hz sim, 15Hz fog-filtered
  per-squad snapshots, event fan-out policy, auto-restart, static client serving).
- `packages/client` — Vite + PixiJS browser client (prediction + interpolation,
  own-muzzle prediction, fog mask from the shared visibility function, HUD).
- `packages/bots` — headless bot players speaking the real fog-filtered protocol.
