# Firelance

Top-down multiplayer medieval bounty-siege game. Design docs live in [docs/](docs/).

**Feature-complete through Milestone 6 (juice & polish), and playtest-ready.**
Twelve players, four squads, one rule that decides it: **only banked gold
wins.** Kill for bounty and the gold mints into your keep's vault as unsecured
wealth; load it onto your back, walk it to a town past everyone who can now see
a courier coming, and channel it into the bank, where it's safe forever. Crack
an enemy keep with firebombs and its whole vault spills on the ground — their
respawns stop, their squad fights on in exile with exactly one emergency
rebuild, and the last squad standing ends the match. Underneath it all:
Fighter/Ranger/Engineer kits, dodgeable arrows and telegraphed melee, shield
blocks and dash dodges, player-built walls/gates/towers/traps, live fog of war,
anti-farm bounty, and a board that redraws itself every match so there are no
solved openings.

Since the core came together the game has grown a face: a **destructible
painted countryside** — the Lived-In Vale, where you chop trees and flatten
huts and the scars stay after the fight moves on — **procedural soldiers**
where placeholder discs used to be, and an **Age of Empires II × arcade**
graphics pass: coursed-stone castles flying waving heraldry, glow-tipped
tracers, kill ceremonies colored to the bounty they pay, and gold that
fountains when it banks. And one command puts a join link in your friends'
Discord: `npm run host`.

## Quick start

```sh
npm install
npm run dev:server   # authoritative server on ws://localhost:8787 — the Vale, +3 bots
npm run dev:client   # Vite client on http://localhost:5173
```

Open http://localhost:5173, pick a class and a name at the door, and you drop
into a bot's seat.

The daily solo loop: `npm run play:bots` (server + 11 bots on the Vale), then
open http://localhost:5173 and you're the 12th seat.

Want a real game with friends right now? `npm run host` builds everything,
boots the match, and prints a share URL — see [Play with friends](#play-with-friends).

## Controls

| Input              | Action                                                     |
| ------------------ | ---------------------------------------------------------- |
| WASD / arrows      | move                                                       |
| mouse              | aim                                                        |
| left click         | fire bow / swing (hold to keep attacking)                  |
| right click (hold) | shield block — Fighter only, frontal 120°, slows you       |
| Space / Shift      | dash (displacement dodge, no i-frames; ignores carry slow) |
| E (hold)           | claim a keep site (placement) / load gold / bank / rebuild |
| F                  | lob a firebomb toward your aim (anti-structure)            |
| B                  | build a wall at your aim (2 tiles out; costs build supply) |
| B (on own damage)  | repair the aimed structure (supply; Engineer patches 2x)   |
| G / T              | Engineer only: build a gate / watchtower at your aim       |
| V                  | Engineer only: lay a hidden trap at your aim               |
| 1 / 2 / 3          | switch to Fighter / Ranger / Engineer at next respawn      |
| H                  | show / hide the controls card                              |
| F3                 | netcode debug overlay                                      |

A bare visit shows the **front door** — pick a class and name, `H` for the
control list; your own F5 skips straight back into the match.

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

## Building, traps & the Vale (the M4 loop)

1. Engineers fortify and besiege: **B** raises a wall two tiles out, **G** a
   gate, **T** a watchtower — all from build supply, restocked at your keep.
   Walls and gates are structures in their own right now: they take
   weapon-typed fire on the same hp table as keeps, so built ground is
   something a siege has to work through, not just walk around.
2. **V** lays a **hidden trap** — invisible to the enemy, armed after a beat;
   the first enemy to trip it is snapped in place for your squad to punish.
   Your own squad sees its own traps.
3. The map is **the Vale**: a countryside of trees and huts you can chew
   through. Three swings fell a tree to a stump and a fallen trunk; a firebomb
   flattens a hut to a charred ruin. The wreckage stays after the fight moves
   on, so the map itself tells the story of the match.
4. Bots do all of it — claim sites, wall up, lay traps, cut through the woods,
   and rebuild from exile.

## Every match is a new board (the M5 loop)

Consecutive matches don't replay the same opening: keep sites, towns, and
spawns are redrawn each match, so there are no solved lines. Gold buys
attention — a fat vault or a heavy carrier throws **rumors** onto the map (a 🗣
ping and a compass line) that send the whole lobby hunting, and climbing the
bounty tiers makes you **wear your price**: ★ tags over your head, colored to
the tier, so everyone knows what you're worth. Enemy structures you've seen
stay **ghosted under fog** where you last saw them, and the end screen replays
the match as a **gold-flow graph** — who hoarded, who banked, who got cracked.

## The look

The field is painted in an **Age of Empires II × arcade** style, all
procedural — no sprite sheets, no image assets; the whole art direction ships
as code. The plan and its slice-by-slice log live in
[docs/graphics_plan.md](docs/graphics_plan.md).

- **Procedural soldiers:** class silhouettes over honest hitbox discs, in
  saturated squad colors that pop off muted ground.
- **Castles, not markers:** keeps are coursed-stone bastions flying waving
  squad heraldry; walls wear their squad's edge; your gates hang ajar, the
  enemy's shut. Damage escalates the architecture itself, and a fallen keep
  looks looted.
- **Arcade light:** arrows tow warm tracers and Engineer crossbow bolts cold
  steel-blue ones, muzzles flash at the loose, firebombs blast with a ring and
  an ember shower, kills pop in their bounty tier's color, and a completed
  deposit sends a pillar of gold up over the bank.
- **A countryside that reads as a place:** dirt roads run town-to-town over the
  bridges (never through water), shores foam, meadows flower, cliffs show
  strata.
- **No screen shake, ever** — impact reads through flash, particles, and sound.

## Play with friends

One command, one URL, zero installs for them:

```sh
npm run host
```

It builds the client and server, boots the match (the Vale, `prototype`
preset, 11 bots), opens a [cloudflared](https://github.com/cloudflare/cloudflared)
quick tunnel, and prints an `https://….trycloudflare.com` URL to paste into
Discord. Friends click it, pick a class and name at the door, and swap into a
bot seat — humans replace bots seat-by-seat as they join, bots refill freed
seats when humans leave, and matches restart automatically 30s after each end
screen. No cloudflared? `winget install Cloudflare.cloudflared` (the script
also prints your LAN URL for same-wifi players). `Ctrl+C` ends the night.

Refreshing the page is safe: for 60 seconds your body stays in the match —
standing where you left it, killable, gold still on its back — and F5 puts you
right back in it.

The full hosting + verdict-sheet page is [docs/playtest_night.md](docs/playtest_night.md).

Under the hood it's just same-origin serving over a tunnel, if you'd rather run
the pieces yourself:

```sh
npm run build                                      # build client + server bundle
node dist/server.mjs --config prototype --bots 11 --static packages/client/dist
cloudflared tunnel --url http://localhost:8787     # in another terminal
```

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

The server takes `--port` / `PORT`, `--config` (`prototype` · `smoke` ·
`verify` · `verify5` · `default`), `--bots`, `--seed`, `--map` (default
`vale_full`; `scrim_small` is the bare CI arena), and `--static`.

## Verification

```sh
npm test                # 308 tests: sim units & invariants, fog property test,
                        #   3-seed 12-bot combat+banking sanity, a pinned vale_full
                        #   ecology run, a pinned full siege arc (destructions→
                        #   rebuild→eliminations→early end), replay determinism
npm run match:smoke     # in-process 12-bot match at turbo speed, prints a report
                        #   (--config prototype for full-length matches)
npm run match:headless  # 12 bots over real websockets, p99 tick-budget check
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
The protocol is versioned (**v13**) and the config is hashed into the `welcome`
message, so a stale client or preset fails loud instead of desyncing quietly.

Bots: `npm run bots -- --count 8 --skill easy|mid|hard` connects extra combat
bots to a running server (SEEK/ATTACK/FLEE/LOOT/BANK/DEFEND/SIEGE/REBUILD:
intercept-lead aim with gaussian error, class kits, a designated banker and a
designated aggressor per squad, carrier hunting, keep defense and wall/gate/
trap building, restock trips, exile comebacks).

## Layout

- `packages/shared` — pure simulation (movement/dash/block/carry kernel,
  attacks, projectiles, economy+bounty+banking ledger, siege & structures,
  traps, the destructible countryside, rumors, per-match board variation,
  vision, match flow), config presets, maps, protocol. Zero runtime deps, no
  DOM/Node APIs.
- `packages/server` — authoritative Node server (30Hz sim, 15Hz fog-filtered
  per-squad snapshots, event fan-out policy, squad-private vault scores,
  ghosted enemy structures, auto-restart, static client serving).
- `packages/client` — Vite + PixiJS browser client (prediction + interpolation
  including carry slow, own-muzzle prediction, fog mask from the shared
  visibility function, banking HUD/prompts, the procedural art pass — one
  palette codex, soldiers, castles, the arcade glow layer — front door, and the
  end-screen gold-flow graph).
- `packages/bots` — headless bot players speaking the real fog-filtered protocol.
```