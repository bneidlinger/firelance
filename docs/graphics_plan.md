# Firelance Graphics Plan — the Vale earns its portrait

> **Drafted:** 2026-07-18 · **Status:** G1–G2 shipped 2026-07-18 · G3–G6 queued
> **Scope:** render-only. Zero sim, zero protocol, zero config-hash changes. Every slice ships alone.
> **North star image:** `docs/media/conceptart1.png` (the Red Writ concept board)

---

## 1. The Thesis

Two parents, one child:

- **Age of Empires II supplies the world.** Earthy painterly countryside, architecture with
  visible mass, banners and heraldry as team identity, damage states that tell a siege's story,
  parchment-and-gold chrome. AoE2's actual terrain trick — ordered dithering between ground
  tones — is *also* a retro technique. The two styles want to meet.
- **The arcade supplies the energy.** Saturated squad hues that pop off muted ground, chunky
  dark outlines, glow-tipped projectiles, white hit-flashes, coin fountains, ceremony on kills.
  Snappy, readable, a little loud.

The concept board's tone strip stays the law: **nothing on the field may be saturated enough to
fight a squad color — except gold and fire.** Those two are allowed to shout, because they're
what the game is about.

What we explicitly do **not** chase from AoE2: the isometric camera. Firelance is straight
top-down and the sim, aim, and netcode assume it. We take AoE2's palette, materiality, and
ceremony — not its projection.

---

## 2. The Law (invariants every slice obeys)

1. **The readability ladder outranks beauty:** squad color > silhouette > state telegraph >
   costume. The torso disc stays an honest hitbox at its exact radius. Structure fills stay
   inside their tile.
2. **No screen shake. Ever.** Impact reads through flash, particles, and sound — never through
   moving the camera.
3. **Render-only.** Nothing in these slices touches prediction, occupancy, aim, vision, or the
   wire. `fx/config.ts` grows; `GameConfig` doesn't. Zero re-pins expected across the series.
4. **Procedural primitives only.** No sprite sheets, no image assets, no fonts beyond system
   stacks. The whole look ships in code — that's the aesthetic, and it keeps the build trivial.
5. **Fog is truth.** Anything vision-gated renders below `fogLayer`. Only gossip (pings,
   floats) lives above it. New ambient layers must pick a side deliberately.
6. **Deterministic bakes.** Static map beauty hashes from tile coords — never `world.rng`,
   never `Math.random()` in `buildMap`. Same map, same painting, every visit.
7. **The 19px budget.** At TILE=19, every tile-scale idea gets 2–4 strokes, no more. We paint
   impressions, not illustrations. If a detail needs squinting, it's cut.
8. **No per-frame Pixi filters.** Blur/bloom shaders are a frame-budget trap on integrated
   GPUs. Glow is faked with additive blend mode + layered alpha discs, which is also more
   arcade-correct.
9. **DOM HUD stays DOM.** It's the right call for iteration speed; G6 restyles it with CSS
   only.
10. **Perf discipline as built:** redraws hide behind key-change guards (`bodyKey`/`poseKey`
    pattern), particles stay inside the 512 pool, static beauty bakes once in `buildMap`.

Ship rule (from memory, still true): any client change makes the 8787 static dist stale —
`npm run build` before host night. `npm run host` rebuilds itself.

---

## 3. The Palette Codex (G1 makes this real)

Today the palette lives in four places: `scene.ts` (terrain COLORS + SQUAD_COLORS), `hud.ts`
(TIER_COLORS + a duplicate SQUAD_CSS), `main.ts` (another SQUAD_CSS), `entities.ts` (the
armory constants). And we have two near-identical inks (`0x14170f` background vs `0x12160e`
outline). One module ends that: `render/palette.ts`, numbers as source of truth, CSS strings
derived, so canvas and DOM can never drift.

Current tokens, verified in code (these are good — the codex *names* them, it doesn't repaint):

| Family | Tokens (hex) |
| --- | --- |
| Ground | `2f3428` / `333929` / `2c3226` mottle · grass `475639` · stone `596052` |
| Wood/water | forest `22371f` + lit `2e4a28` · water `1f3a52` + shallow `25425a` + line `14202e` + ripple `3d5f7d` |
| Timber | bridge `7a6544` · plank `5f4c33` · rail `4a3a26` |
| Rock | wall `55554d` · lit `6d6d62` · shade `3a3a34` |
| Gold | keep `d5aa54` · town `f2d68c` · bright `ffe9b0` · squad-gold `e0b95e` |
| Squads | red `f05a4d` · blue `5686bf` · green `8fae6a` · gold `e0b95e` |
| Armory | steel `8b939e`/`565e66`/`d8e0e8` · leather `8a6f4d` · hood `46573a` · fletch `d8d4c8` |
| Tiers | `b9ad98` → `c9c29b` → `e0b95e` → `e8985a` → `f05a4d` → `ff3333` |
| Ink & parchment | ink `14170f` (unify `12160e` into it) · parchment `f4ead8` · khaki `b9ad98` · bone `e8dcc0` |

New tokens the series needs (start values, tuned in-game): `road 6a593c`, `roadWorn 7d6a48`,
`thatch 8a7550` (exists inline in huts — promote it), `ember d8543e` (exists as trap red —
promote it), `fire ff9a3d`, `smoke 6b6b64`, `foam 9db4c9` (exists as shield steel — shared on
purpose: cold highlights are one family).

**One sun.** Code and comments currently disagree about where the light comes from (the
character shade arc says one thing, the `fx/config.ts` comment says another). The codex ends
the argument: **sun from the north-west** — lit edges up-left, shade and drop shadows fall
down-right. Every slice after G1 inherits the convention.

---

## 4. The Slices

Six slices, G1–G6. Each is a session-sized, independently shippable, render-only commit in the
M6 mold. Order is argued in §5.

---

### G1 — The Codex and the Sun *(foundation, with a visible payoff)*

**Why first:** every later slice wants named colors and a lighting convention. Doing it last
means repainting twice.

The work:

- `render/palette.ts`: all tokens above, `cssOf(hex)` helper, squad colors + CSS derived from
  one array. `main.ts`, `hud.ts`, `entities.ts`, `scene.ts`, `structures.ts`, `keeps.ts`
  import from it. Unify the two inks. Delete both duplicate `SQUAD_CSS` arrays.
- **Grounding pass** (the visible payoff): the tree's shadow ellipse treatment goes universal.
  Huts, walls, gates, towers, keeps, sacks, bombs get a soft NW-sun drop shadow; walls/huts
  get a 1px lit top-left edge + shaded bottom-right edge, exactly like rock tiles already do.
  Suddenly nothing floats — the single cheapest "the game got better and I can't say why."
- State the sun convention in one comment block in `palette.ts`; fix the stale comment in
  `fx/config.ts`.

Files: new `render/palette.ts`; touch `scene.ts`, `entities.ts`, `structures.ts`, `keeps.ts`,
`hud.ts`, `main.ts`, `fx/config.ts`.

**Shipped 2026-07-18.** Field notes: (1) the dark olive ground eats shadows — the first-draft
strengths (0.18 shadow / 0.2 lit / 0.3 shade) read as nothing at 19px; shipped at
0.3 / 0.32 / 0.45 (all knobs in `FX.grounding`). (2) A pixel probe caught a latent bug: the
fixed-sun crescent + glint had rendered UNDER the opaque torso since the modern pass —
invisible, and redrawn every frame besides. They now live on a static `sun` overlay above the
body, verified by canvas sampling (shade SE 362 vs SW 407 on the red disc; glint NW > NE).
Before/afters in `docs/media/g1_*.png`; sacks and bombs were already shadowed or joined in.
Payoff testers see: everything sits *on* the ground; the field reads cleaner in a brawl.
Verify: side-by-side screenshots (before/after) at spawn, a keep, a hut cluster; 11-bot brawl
with F3 overlay — frame time flat vs baseline (shadows bake into existing Graphics, no new
per-frame work).
Risk: low. Mechanical refactor + additive draws behind existing redraw guards.

---

### G2 — The Keep Becomes a Castle *(the emotional center gets a body)*

**Why:** the keep is the vault, the respawn, the thing sieges are about — and today it renders
as a ring, a 4px dot, and a 14px square. It's the largest gap between game and concept board.

The work (all in `keeps.ts` + the site markers in `scene.ts`):

- **Architecture:** procedural bastion — stone courtyard disc (mottled, hash-jittered),
  four corner posts, central hall with a two-tone roof (NW-lit per G1), gold-trimmed vault
  door dot facing south. Footprint stays inside the current interact ring; the ring remains
  (it's the claim/deposit tutorial).
- **The pennant:** a squad-colored flag on a pole, 3-segment polyline waving on a slow sine
  (phase-offset per squad so the world doesn't metronome). AoE2's signature read, and our
  cheapest one — 6 strokes, redrawn per frame for one keep × 4. This is the new
  friend-or-foe read at long range.
- **Damage escalates architecture-first:** existing crack thresholds move onto the hall and
  courtyard (cracks → missing roof chunk + the existing critical smoke → breach). Ruin state
  becomes collapsed masonry: tumbled corner posts, charred hall outline, the pennant pole
  bare and tilted. "Still a place — just a dead one," but now it *looks* looted.
- **Towns match:** the flat gold square becomes a bank — stone front, gold-trimmed door,
  hanging sign (static), coin dot. Same silhouette weight as today so banking wayfinding
  doesn't move.
- Unclaimed keep sites: faint foundation stones instead of the bare faint ring.

Payoff testers see: "THAT's my keep" — and a burning keep visible as a story across the field.
Verify: claim → build → siege → ruin → rebuild loop against bots; screenshot each damage
tier; confirm pennant read at max camera distance; fog/ghost variants still render dimmed.
Risk: medium-low. Pure draw code, but the keep marker carries a lot of meaning — keep the
ring + hp bar exactly where they are.

**Shipped 2026-07-18.** Field notes: (1) Pixi `arc()` chains onto the open path — a
decorative arc after any shape drags a connector line across the drawing unless you `moveTo`
its start first (found as a pale streak across every courtyard; same fix applied to G1's
tower arc and the character glint). (2) `applyVariant` trims `map.keeps`/`map.towns` to the
ACTIVE set — foundations and banks only bake for sites that exist this match, which is
correct and free, but verify shots must use the current variant's coords (a mid-verify
auto-restart swapped the active towns out from under the first pass). (3) The pennant needed
growing (mast 1.1×TILE, banner 0.75×TILE) before it read at distance; wave proven live with
two pumps 900ms apart. The helper lives in `render/pennant.ts` for G3's towers. Ruin and
mid-damage tiers shipped code-reviewed but unstaged — the first real siege is their eyeball;
captures in `docs/media/g2_*.png`.

---

### G3 — Architecture With Mass *(walls, gates, towers — and the Vale props payoff)*

**Why:** player-built defenses are half the game's fiction and currently read as colored
tiles. Plus this slice **completes the Lived-In Vale interlude** (s2 render payoff / s3 soak).

The work (mostly `structures.ts`):

- **Walls:** stone-course fill (2–3 mortar seams, hash-offset per tile so runs don't stripe),
  crenellation dots on the top edge, G1 shadow + lit edge. Squad identity moves from
  full-tint fill to **stone body + bold squad-colored edge + cap accents** — masonry that
  *belongs* to red, instead of red plastic. (Friend-or-foe read verified at distance before
  committing; if it's weaker, fall back to squad-tinted stone.)
- **Gates:** visible timber doors with iron banding inside the posts; own-squad gates draw
  the doors ajar (the walkable read, stronger than today's gap).
- **Towers:** height illusion — larger base shadow, platform ring offset up-left 1–2px,
  brace shadows, and a small squad pennant (shared flag helper from G2).
- **Damage in three acts:** hairline crack (<75%) → crack web + edge chips (<50%, current
  single crack upgraded) → gap-toothed silhouette + dust motes (<25%). Destruction drops a
  **persistent rubble decal** on the existing `decalLayer` (bounded pool, oldest fades).
- **The Vale props earn their deaths:** a killed tree leaves a stump + felled-trunk decal
  (angled away from the killing blow's side if cheap, else fixed); a killed hut collapses to
  a rubble + charred-beam decal with a brief smoke burst. Living huts get a chimney smoke
  wisp on the existing `smoke` emitter, gated by earshot range so the pool stays calm.
- Trap/ghost/arming visuals untouched — they're information design, already correct.

Payoff testers see: sieges leave scars; the countryside stays chewed-through after the fight
moves on. The Vale interlude closes.
Verify: this slice absorbs the owed **bot-soak** — 10+ min attached client on `play:bots`,
watch particle pool caps, decal pool bounds, fps flat; screenshot wall/gate/tower damage
tiers own-vs-enemy; fog entry/exit and M5 ghost memory still correct (dimmed, behind live).
Risk: medium. Most draw-code volume of the series; decal pool needs a hard cap (suggest 64,
FIFO fade). Friend-or-foe check is the gate on the stone-body decision.

---

### G4 — Arcade Light *(projectiles, impacts, ceremony)*

**Why:** combat is the moment-to-moment product, and it's one slice away from *juicy*. This
is the retro-arcade half of the thesis paying rent. Highest value if a playtest night is near.

The work:

- **A glow layer:** one container above `projectileLayer` with `blendMode:'add'`. Glow =
  2–3 stacked alpha discs, never filters (Law #8).
- **Arrows with life:** short fading tracer (3–4 ghost dashes pooled per arrow), warm
  additive tip glint; engineer bolts get a steel-blue shorter/faster read so the two ranged
  weapons stop being twins. Loose flash at the muzzle (one 80ms additive fan) — pairs with
  the ranger reload read the playtest still owes eyes on.
- **Firebombs go theatrical:** sputtering fuse sparks along the arc (existing emitter
  pattern), impact = additive flash ring + ember shower (`fire`/`ember` tokens) over the
  existing scorch decal.
- **Kill ceremony, tiered:** every death keeps `deathShatter` in squad color; Wanted+ adds a
  writ-burst — tier-colored star sparks + the existing float; Crownmarked adds a gold coin
  fountain and its existing banner moment. The reward *looks* like the number it pays.
- **Banking payoff:** deposit completion adds a brief rising gold pillar of glints at the
  bank (the coinBurst's vertical cousin). The score moment becomes visible across a field.
- Block sparks and trap jaws get a single additive flash frame — same specs, more snap.

Files: `fx.ts`, `particles.ts`/`particlepool.ts` (additive pool variant), `projectiles.ts`,
`bombs.ts`, `fx/config.ts` (all new knobs live here), `scene.ts` (one layer).
Payoff testers see: every fight is a light show that still reads perfectly.
Verify: 11-bot brawl at `?fakelag=120&jitter=30` — fps flat, pool never starves the big
moments; the melee strike frame + ranger reload get their owed live eyes; confirm glow layer
sits below fog (muzzle flashes must not leak through fog).
Risk: medium-low. Additive blending is cheap; the discipline point is keeping counts small —
every new emitter gets a knob in `fx/config.ts`, nothing hardcoded.

---

### G5 — The Countryside Painting *(terrain v2, baked)*

**Why:** the ground is 70% of every frame. It's already good mottle; this makes it a place.
All of it bakes once in `buildMap` — zero per-frame cost by construction.

The work (all `scene.ts::buildMap`):

- **Dirt roads:** polylines town↔town and town↔keep-site neighborhoods, drawn as layered
  rough strokes (`road`/`roadWorn`) with hash-jittered edges + sparse wheel-rut dashes.
  Purely visual — no walk/speed meaning (said explicitly in-code so nobody asks the sim for
  it). Roads give the map its AoE2 "worked land" read and make wayfinding-by-words easier.
- **Dither the seams:** ordered 2×2 dither band where ground mottle patches meet, and
  grass-tone dither collars around forest edges and banks — the AoE2 blend that doubles as
  our retro texture. Strictly hash-driven (Law #6).
- **Meadows and fields:** rare hash-picked patches get flower dots (2 colors, 1px), dry-grass
  tint sweeps; a wheat-row patch beside map huts (3 parallel strokes) sells "lived-in."
- **Water v2:** foam dashes along shorelines (static, sparse), 1–2 lily dots on calm pools;
  keep the live glint emitter as the only animated part.
- **Rock strata:** one thin lit strata line across multi-tile rock runs, so cliffs read as
  geology instead of tile piles.
- **Forest floor:** dark underlay disc beneath canopy clusters so the wood has depth under
  its breathing alpha.

Payoff testers see: the map screenshot becomes the marketing shot. First-join impression
jumps.
Verify: bake-time measured (<50ms budget on the dev box); screenshot tour of roads, shores,
meadows, cliffs; determinism check — reload twice, identical painting; F3 fps flat (it's all
static geometry in the two existing baked Graphics).
Risk: low mechanics / medium taste. Pure additive bake; the danger is visual noise — the 19px
budget (Law #7) is the editor. Anything that muddies a soldier's silhouette gets cut.

---

### G6 — Chrome and the Front Door *(the writ made official)*

**Why:** the HUD and door are the game's handshake. Functional today; this makes them *of the
world* — parchment, wax, iron, and gold, AoE2's UI soul with our arcade type discipline.

The work:

- **HUD reskin, CSS-only** (index.html styles; `hud.ts` markup mostly untouched): panels get
  carved dark-wood/iron backing with a 1px gold pinstripe; the bounty board becomes a
  parchment writ — `parchment` text on dark, wax-seal red header chip, tier colors from the
  codex; killfeed lines styled as ledger entries; topbar squad purses get coin-stack chips;
  the class line gets a small portrait chip (CSS-drawn shield/hood/wrench glyph, no images).
  Numbers stay in the mono stack — tabular digits are our pixel-font, free.
- **Alarm/moment banners:** the existing center banner gets the concept board's framing —
  thin gold rules above/below, letter-spaced smallcaps. No new timing logic, styling only.
- **The front door becomes key art:** behind the class cards, a procedural Pixi vignette —
  dusk-gradient sky band, silhouette treeline (the forest blob painter reused), a distant
  keep pennant waving (G2's flag helper), slow drifting embers (existing particle pool).
  Class cards get writ-poster frames: parchment header, gold-nail corners, hover lift.
  Settings panel inherits the same skin.
- **Stretch (only if the slice runs short):** an optional scanline overlay toggle in
  settings — a 2px CSS repeating-gradient, default OFF, honest arcade fan service.

Payoff testers see: screenshots start looking like a game with a publisher. The Discord
first-open moment ("host night's front door") sells the fantasy before the first input.
Verify: door → play → death → end-screen flow eyeballed at 1080p and a laptop-small window;
killfeed/board legibility over the brightest terrain (G5 meadows); no layout shift vs today
(reuse the same element IDs — `hud.ts` reset() contract untouched).
Risk: low. CSS + one self-contained Pixi vignette behind a DOM door.

---

## 5. Order and Sizing

| # | Slice | Size | Tester-visible | Notes |
| --- | --- | --- | --- | --- |
| G1 | Codex + Sun | S | ★★ | Foundation; everything after inherits it |
| G2 | Keep → Castle | M | ★★★★ | Biggest single wow per effort |
| G3 | Architecture + Vale payoff | L | ★★★★ | Closes the interlude, absorbs the owed bot-soak |
| G4 | Arcade Light | M | ★★★★★ | Do before the next playtest night |
| G5 | Countryside Painting | M | ★★★ | The screenshot slice; zero frame cost |
| G6 | Chrome + Front Door | M | ★★★ | The handshake slice |

**Default order: G1 → G2 → G3 → G4 → G5 → G6.**

**If a playtest night lands mid-series:** pull G4 forward (G1 → G4 → G2 → …). Combat juice
and the keep are what testers feel in their hands; ground and chrome can trail.

Every slice ends the same way: `npm run typecheck`, `npm test` (298+ green, untouched),
15-minute attached bot-soak, before/after screenshots into `docs/media/`, `npm run build` so
host night's dist is fresh.

---

## 6. Deliberate No's

- **No minimap.** The design chose rumors and words as wayfinding; the concept art's minimap
  stays concept art. (G5's roads make the words work harder.)
- **No isometric re-projection.** Camera stays top-down; see §1.
- **No screen shake.** Still never.
- **No sprite/image assets.** The procedural look *is* the art direction — and the whole
  game keeps shipping as code.
- **No Pixi filters.** Additive layering only. If a glow needs a shader, the glow is wrong.
- **No new wire data.** Every visual derives from state already on the client (snapshot
  diffs, events, hashes of coordinates). The `onChip` snapshot-diff trick is the model.

---

## 7. Playtest Hooks (what to ask after each lands)

- G1/G5: "Describe the map like you'd describe a place." (Want: named features — the road,
  the ford, the meadow — not 'the green part.')
- G2/G3: "Whose keep is that, and how's the siege going?" — answered from one glance at
  range.
- G4: "Did any fight feel confusing?" (Juice must never cost reads. One 'what hit me' answer
  = a knob comes down in `fx/config.ts`.)
- G6: screenshot-share rate. If testers start posting screenshots unprompted, the plan
  worked.
