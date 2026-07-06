# Firelance

Top-down multiplayer medieval bounty-siege game. Design docs live in [docs/](docs/).

## Quick start

```sh
npm install
npm run dev:server   # authoritative server on ws://localhost:8787 (+3 in-process bots)
npm run dev:client   # Vite client on http://localhost:5173
```

Open http://localhost:5173 in two tabs to see prediction + interpolation working.

Useful client URL params: `?name=Brandon` `?fakelag=120&jitter=30` `?nopredict`
Press **F3** in-game for the netcode debug overlay.

## Verification

```sh
npm test              # unit + invariant + integration tests (includes turbo smoke match)
npm run match:smoke   # in-process 4-bot match at turbo speed, prints report
npm run play:bots     # server + 11 bots; join as the 12th player from the browser
npm run typecheck
```

## Layout

- `packages/shared` — pure simulation, config, map, protocol. Zero runtime deps, no DOM/Node APIs.
- `packages/server` — authoritative Node server (30Hz sim, 15Hz per-squad snapshots).
- `packages/client` — Vite + PixiJS browser client (prediction + interpolation).
- `packages/bots` — headless bot players speaking the real protocol.
