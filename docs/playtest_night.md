# Playtest Night — hosting + the verdict sheet

This is the one page for the friend playtest that gates M4+M5+M6. Print it or
keep it on a second screen. Config-only tuning is the expected output — write
numbers and feelings down, change presets later, no code on game night.

## Hosting (2 minutes)

```
npm run host
```

Builds everything, starts vale_full on the `prototype` preset with 11 bots,
opens a cloudflared quick tunnel, and prints the URL to paste into Discord.
Friends need **nothing installed** — the link is the game. They pick a class
and a name on the door and swap into bot seats. `Ctrl+C` ends the night.

No cloudflared? `winget install Cloudflare.cloudflared` (the script also
prints your LAN URL for same-wifi friends).

If a match ends, the next one starts itself (~8 min matches, new map draw
each time). You never need to touch the server.

---

## Pre-flight feel ritual (~10 min, solo, BEFORE inviting anyone)

All feel judgments at `?fakelag=120&jitter=30` in a **focused** tab — the
standing rule. Join, then walk through:

- [ ] **Movement**: WASD instant, dash reads, walk bob subtle (not seasick)
- [ ] **Arrows**: dodgeable from 10–12 units; terrain misses _thunk_ quietly to the correct SIDE (stereo); flesh hits spray red
- [ ] **Blocks**: shield block sparks COLD (blue-grey) and clangs — instantly distinct from a hit
- [ ] **Deaths**: shape-shatter in squad color; own death drains color for a beat
- [ ] **Low HP**: vignette breathes + heartbeat under ~30% — tense, not annoying
- [ ] **Sounds**: 12-bot brawl is readable, not a buzz (spam gate); Esc sliders work and persist
- [ ] **Keeps**: cracks at 75/50/25, smoke when critical, destruction is a MOMENT (banner + horn + scar)
- [ ] **Banking**: channel plucks rise in pitch; completed deposit fountains gold; "+Ng banked" floats
- [ ] **Bounty**: tier-up moment lands ("★ WANTED ★"), rumor pings + compass lines make you LOOK
- [ ] **Alarm**: keep hit → edge-of-screen arrow points HOME correctly
- [ ] **Front door**: bare URL shows the door; your F5 skips it; H shows controls
- [ ] **End screen**: banked totals count up; gold-flow graph tells the match's story
- [ ] **Perf**: F3 — fps steady, `err` ~0.00, no snap corrections while running around

Anything that fails: knobs live in `packages/client/src/fx/config.ts` (juice)
and `packages/shared/src/config/` (game). Fix before the night or note it.

---

## The verdict sheet (fill in DURING/AFTER matches with friends)

The gate questions the whole roadmap has been waiting on. 1–5 or a sentence.

### M4 — building & the Vale

- [ ] **Keep-loss drama**: did losing a keep feel like a dramatic setback with a comeback path — not an insta-loss?
- [ ] **Site tradeoffs**: did anyone argue about WHERE to claim? (near town vs bridge vs forest)
- [ ] **Walls change sieges**: did built ground change how a siege played, without stalemating it?
- [ ] **Trap ambushes**: did a trap ever create a story? (a snap mid-chase, a defended vault)
- [ ] **Big-map pacing**: does vale_full pace well, or is it a hiking simulator? (deposits/match: ____)

### M5 — replayability & information

- [ ] **Consecutive matches differ**: did match 2 FEEL like a different board? (sites/towns/spawns)
- [ ] **Rumors trigger hunts**: did anyone chase a 🗣 ping? Did being WANTED feel dangerous?

### M6 — juice & the first impression

- [ ] **First 60 seconds**: did friends understand the goal from the door primer alone?
- [ ] **Combat reads**: could they tell hit / block / trap / bomb apart WITHOUT being told?
- [ ] **The moments**: did a keep fall or a big deposit get a reaction out loud?

### The only question that actually matters

- [ ] **Did anyone say "one more match"?** Who: ____________ After match #: ____

### Raw notes / numbers to tune

```
match length felt:            too short · right · too long
bank runs per match (~):
sieges per match (~):
snowball complaints:
quotes worth keeping:
```

Next step after the night: bring this sheet back — **M7 gets planned from it.**
