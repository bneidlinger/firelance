# Firelance

Top-down multiplayer medieval bounty-siege game. Design docs live in [docs/](docs/).

**Milestone 3 (keep destruction) is in**: keeps have hit points now, and
firebombs are the siege tool. Crack an enemy keep and its whole vault spills
onto the ground, their respawns stop, and their squad fights on in exile —
with exactly one emergency rebuild to buy the comeback. All dead with no keep
= eliminated (you spectate; your banked gold no longer counts). Matches end
early when one squad stands. Bots besiege, defend, loot fallen vaults, and
rebuild from exile. On top of Milestone 2's banking — four gold pools, only
**banked gold wins**, carriers slow and visible, dropped loads lootable by
anyone, plunder banks tax-free — and Milestone 1's combat: Fighter/Ranger
kits, dodgeable arrows, telegraphed melee, shield blocking, dash dodges,
bounty with anti-farm rules, live fog of war, auto-restarting matches.

## Quick start

```sh
npm install
npm run dev:server   # authoritative server on ws://localhost:8787 (+3 in-process bots)
npm run dev:client   # Vite client on http://localhost:5173
```

The daily solo loop: `npm run play:bots` (server + 11 bots), then open
http://localhost:5173 and you're the 12th seat.

## Controls

| Input              | Action                                                     |
| ------------------ | ---------------------------------------------------------- |
| WASD / arrows      | move                                                       |
| mouse              | aim                                                        |
| left click         | fire bow / swing (hold to keep attacking)                  |
| right click (hold) | shield block — Fighter only, frontal 120°, slows you       |
| Space / Shift      | dash (displacement dodge, no i-frames; ignores carry slow) |
| E (hold)           | load gold at your keep / bank at a town / rebuild (still)  |
| F                  | lob a firebomb toward your aim (anti-structure)            |
| 1 / 2              | switch to Fighter / Ranger at next respawn                 |
| F3                 | netcode debug overlay                                      |

Useful client URL params: `?name=Brandon` `?class=fighter` `?fakelag=120&jitter=30` `?nopredict`
**Judge all combat feel at `?fakelag=120&jitter=30`** — never at localhost-zero.

## Banking rules (the M2 loop)

1. Kills mint gold into your squad's **keep vault** — unsecured wealth.
2. Hold **E** inside your keep circle: gold trickles onto your back
   (300g/sec). The **reserve rule** keeps 25% of lifetime earnings locked in
   the vault, so every squad stays worth raiding.
3. Carry it to a town. Carriers walk slower per 100g carried, wear a visible
   gold sack (everyone sees _that_ you carry, only your squad sees _how much_),
   and get priority-hunted by bots.
4. Hold **E** in the town circle, standing still, for 4 seconds. Any damage,
   movement, dash, or attack resets the channel. Completing it banks the whole
   load — **banked gold is safe forever and is the only score that wins**.
5. Dying mid-run spills your load as a ground sack. Anyone — including the
   squad that killed you, or your own squadmates — can walk over it and take
   it. Stolen gold banks in full: plunder is never taxed.

## Siege rules (the M3 loop)

1. Keeps have hp (public — everyone sees a burning keep). **Firebombs** are
   the siege tool: press **F** to lob one at your aim; it lands after a short
   flight in a marked circle — heavy structure damage, light splash that
   ignores shields. You carry 2; standing in your own keep circle restocks.
   Swords chip keeps for scraps; arrows don't scratch stone.
2. When a keep falls: its **entire vault spills** as ground sacks, respawns
   stop for that squad, and the killfeed tells the whole map. Living members
   fight on in **exile** — their kills mint straight onto their backs.
3. Exiled squads get **one emergency rebuild**: carry the cost to any empty
   keep site and hold **E** through a stand-still channel. The cost goes into
   the new vault (born as raid bait), the keep rises at partial hp, and the
   dead come home on fresh respawn timers.
4. No keep and nobody breathing = **eliminated**: the squad spectates, and its
   banked gold no longer counts — only SURVIVORS can win. One squad left
   standing ends the match on the spot.

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
everything. Humans replace bots seat-by-seat as they join (bots refill freed
seats when humans leave); matches restart automatically 30s after each end
screen. Refreshing the page is safe: for 60 seconds your body stays in the
match — standing where you left it, killable, gold still on its back — and
F5 puts you right back in it.

## Deploy (stable URL)

The production build is two artifacts: a single-file server bundle and the
static client, served by one process on one port (same-origin `wss`).

```sh
npm run build    # vite-builds the client + esbuild-bundles the server → dist/server.mjs
npm start        # node dist/server.mjs --config prototype --bots 11 --static packages/client/dist
```

**fly.io** (builds remotely — no local Docker needed): install
[flyctl](https://fly.io/docs/flyctl/install/), sign up, then from the repo:

```sh
fly launch --no-deploy   # first time only — claims the app name, keeps fly.toml
fly deploy
```

[fly.toml](fly.toml) is preconfigured: one shared-cpu machine (a 12-player
match needs <1ms/tick and ~13 KB/s per client), https/wss on the same origin,
auto-stop when empty and auto-start on the next visit.

**Any $5 VPS**: `docker build -t firelance . && docker run -d -p 80:8787 firelance`
(see the [Dockerfile](Dockerfile)), or skip Docker entirely — copy the repo,
`npm ci && npm run build`, and run `PORT=80 npm start` under systemd. Put
Caddy in front if you want automatic TLS.

## Verification

```sh
npm test                # 170 tests: sim units, invariants, fog property test,
                        #   3-seed 12-bot combat+banking sanity, a pinned-seed
                        #   full siege arc (destructions→rebuild→eliminations→
                        #   early end), replay determinism
npm run match:smoke     # in-process 12-bot match at turbo speed, prints report
                        #   (--config prototype for full-length matches)
npm run match:headless  # 12 bots over real websockets, p99 tick budget check
npm run typecheck
```

The invariant backbone: gold conservation holds every tick across all four
pools (Σ minted == Σ keeps + Σ carried + Σ banked + Σ sacks) — through vault
spills, exile spoils, and rebuild transfers; the keep reserve never drops
below 25% of lifetime earnings while the keep stands; nobody respawns without
a living keep; fog never serializes an invisible enemy or sack — and never
leaks an enemy's carried amount — while eliminated spectators see everything
(1,000-state property test); same seed ⇒ bit-identical replay, and every
failing harness run dumps its replay to `replays/` for offline reproduction.

Bots: `npm run bots -- --count 8 --skill easy|mid|hard` connects extra combat
bots to a running server (SEEK/ATTACK/FLEE/LOOT/BANK/DEFEND/SIEGE/REBUILD:
intercept-lead aim with gaussian error, class kits, a designated banker and a
designated aggressor per squad, carrier hunting, keep defense, restock trips,
exile comebacks).

## Layout

- `packages/shared` — pure simulation (movement/dash/block/carry kernel,
  attacks, projectiles, economy+bounty+banking ledger, vision, match flow),
  config presets, map, protocol. Zero runtime deps, no DOM/Node APIs.
- `packages/server` — authoritative Node server (30Hz sim, 15Hz fog-filtered
  per-squad snapshots, event fan-out policy, squad-private vault scores,
  auto-restart, static client serving).
- `packages/client` — Vite + PixiJS browser client (prediction + interpolation
  including carry slow, own-muzzle prediction, fog mask from the shared
  visibility function, banking HUD/prompts).
- `packages/bots` — headless bot players speaking the real fog-filtered protocol.
