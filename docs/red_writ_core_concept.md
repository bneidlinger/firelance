# Project Red Writ — Core Game Concept

> **Working title:** Red Writ  
> **Genre:** Top-down multiplayer medieval / low-fantasy bounty siege game  
> **Core fantasy:** Build a keep, grow rich and infamous, protect your vault, hunt valuable enemies, and decide when to risk everything on a banking run.

---

## 1. One-Sentence Pitch

**Red Writ is a squad-based top-down medieval bounty game where teams claim territory, build temporary keeps, earn gold through kills and objectives, and must physically bank their wealth at dangerous towns before enemy squads destroy their keep and steal the vault.**

---

## 2. Core Identity

The game combines four main ideas:

1. **Top-down dodgeable projectile combat**  
   Combat uses visible, physical projectiles such as arrows, bolts, thrown weapons, bombs, and low-fantasy magic. Players can dodge, lead shots, use terrain, and outmaneuver enemies.

2. **Personal bounty escalation**  
   Players become more valuable as they kill, assist, survive, complete objectives, and help their squad succeed. Higher bounty creates greater rewards and greater danger.

3. **Temporary squad-built keeps**  
   Each squad chooses where to build a keep during the match. The keep is the squad’s respawn point, vault, defensive anchor, and strategic identity.

4. **Risk-based banking and plunder**  
   Gold earned during the match first goes to the squad keep. To secure it, players must physically transport gold to towns around the map. Destroyed keeps drop their stored gold onto the ground for anyone to steal.

The intended emotional loop is:

```text
Greed → Fortify → Hunt → Grow Valuable → Bank or Push Further → Get Hunted → Siege / Escape / Plunder
```

---

## 3. Design Pillars

### 3.1 Bounty Is the Emotional Engine

The game should constantly create the feeling that successful players are becoming both richer and more endangered.

A high-bounty player should not simply be stronger. They should be more valuable, more visible, and more tempting to kill.

**Rule of thumb:** success creates opportunity and pressure, not guaranteed dominance.

---

### 3.2 Keeps Create Territory, Not Permanent Safety

Keeps are essential but vulnerable. They are not meant to create long-term survival-game fortresses.

A keep should feel like:

- A home base
- A respawn point
- A vault
- A tactical structure
- A liability when it becomes too rich

A keep should not feel like:

- An invincible bunker
- A permanent account asset
- A second job
- A place where a squad can safely turtle forever

---

### 3.3 Banking Forces Risk

Gold in the keep is not safe. Banked gold is safe.

To win, squads must eventually leave their keep, carry gold through the map, and bank it at towns. This creates escort missions, ambushes, counter-raids, and difficult split-squad decisions.

**The game should be at its best when a squad has too much gold, too few defenders, and too many bad options.**

---

### 3.4 Defense and Aggression Both Matter

The game should not purely reward camping or reckless fighting.

Good play includes:

- Choosing a strong keep location
- Building quickly
- Scouting enemy locations
- Hunting high-bounty targets
- Timing banking runs
- Defending the keep
- Raiding rich enemies
- Third-partying major fights
- Rebuilding after disaster

---

### 3.5 The Match Should Generate Stories

The game succeeds when players retell moments like:

- “We banked a huge chest while two squads fought over our decoy keep.”
- “Our ranger had a massive bounty, so we escorted him through the forest while enemies tracked us.”
- “We destroyed a keep, but a third squad stole the gold while we were fighting the defenders.”
- “We lost our keep, rebuilt in exile, then killed the top bounty player and came back.”

---

## 4. Match Overview

### 4.1 Suggested MVP Match Format

| Item                      |                                                    MVP Target |
| ------------------------- | ------------------------------------------------------------: |
| Squads                    |                                                      4 squads |
| Players per squad         |                                                     3 players |
| Total players             |                                                    12 players |
| Match length              |                                                 25–35 minutes |
| Map type                  |          Static map first, randomized spawns/objectives later |
| Main win condition        |                       Most banked gold among surviving squads |
| Primary failure condition | Squad eliminated when all players are dead and no keep exists |

---

## 5. Match Flow

### 5.1 Phase 1 — Scattered Spawn

At match start, squads spawn in different regions of the map.

The terrain map is known, but enemy positions, enemy keep locations, traps, and fresh structures are hidden by fog of war.

Initial pressure:

- Squads want good keep spots.
- The best-looking locations may be contested.
- Early scouting and movement choices matter.
- Randomized spawns help prevent solved openings.

---

### 5.2 Phase 2 — Claim and Build

Each squad carries or controls a **Keep Standard**.

The squad chooses a legal location and plants the standard to begin constructing a keep.

Once completed, the keep becomes:

- The squad respawn point
- The squad vault
- The squad build-radius anchor
- The main strategic target for enemies

---

### 5.3 Phase 3 — Hunt, Build, Scout, Raid

Squads earn gold and bounty by:

- Killing enemy players
- Assisting kills
- Surviving with bounty
- Completing map objectives
- Destroying enemy structures
- Looting enemy gold
- Escorting and banking gold
- Possibly clearing neutral camps or events

Gold initially goes to the squad keep, while player experience is tracked individually.

---

### 5.4 Phase 4 — Banking Runs

To secure gold, a squad must transfer gold from its keep into a physical carry object, then escort it to a town or banking site.

Banking should involve meaningful risk:

- The carrier may move slower.
- Larger deposits may create louder map alerts.
- Banking takes time.
- More allies nearby speed up banking.
- Enemies contesting the banking area pause or slow the process.
- Sending more players to bank leaves the keep vulnerable.

---

### 5.5 Phase 5 — Siege and Plunder

Enemy squads can attack and destroy keeps.

When a keep is destroyed:

- Squad respawns stop.
- Unbanked gold spills onto the ground in sacks/chests.
- Other squads can loot the dropped gold.
- Living members of the destroyed squad enter an exile state.
- Dead members remain dead unless the squad successfully rebuilds.

This should create a major map event that attracts other squads.

---

### 5.6 Phase 6 — Endgame

The winning squad is determined by banked gold.

Suggested MVP rule:

> At match end, the surviving squad with the most banked gold wins.

If only one squad remains alive, the match may end immediately or after a short final plunder window.

---

## 6. Gold System

### 6.1 Gold States

Gold exists in three important states:

| State        | Description                       | Safe? |                                  Counts Toward Win? |
| ------------ | --------------------------------- | ----: | --------------------------------------------------: |
| Keep Gold    | Gold stored in the squad keep     |    No | Not directly, or only partially depending on tuning |
| Carried Gold | Gold being transported by players |    No |                                    No, until banked |
| Banked Gold  | Gold deposited at a town/bank     |   Yes |                                                 Yes |

The main score should be **banked gold**, not total gold generated.

---

### 6.2 Keep Reserve Rule

To prevent squads from emptying their keep completely, a portion of total earned gold should always remain vulnerable.

Recommended rule:

> A squad may bank up to 75% of its lifetime earned match gold. At least 25% remains as exposed keep reserve.

This means even careful squads remain worth raiding.

Example:

- Squad earns 4,000 total gold.
- Up to 3,000 may be banked.
- At least 1,000 remains exposed in the keep.
- If the keep falls, the exposed gold drops as loot.

---

### 6.3 Loot Drops

When gold drops, it should appear as loot containers rather than hundreds of individual coins.

Suggested loot sizes:

| Loot Object | Example Value | Gameplay Role                              |
| ----------- | ------------: | ------------------------------------------ |
| Small Sack  |      100 gold | Fast pickup, low risk                      |
| Large Sack  |      500 gold | Meaningful but manageable                  |
| Chest       |    1,000 gold | Requires commitment                        |
| Great Chest |   2,500+ gold | High-value objective, likely slows carrier |

Large loot should create decisions:

- Grab small sacks and escape quickly.
- Carry a heavy chest and move slowly.
- Hold the ruins while allies haul loot.
- Leave some gold behind because another squad is approaching.

---

## 7. Bounty System

### 7.1 Personal Bounty

Each player has a personal bounty value that increases during the match.

Bounty can increase from:

- Kills
- Assists
- Survival time
- Objective participation
- Banking participation
- Destroying enemy structures
- Killing high-bounty players
- Carrying or stealing major loot

Bounty should usually decrease, reset, or partially transfer when the player dies.

---

### 7.2 What Bounty Does

Bounty should affect rewards and visibility, not raw combat power.

A higher-bounty player may:

- Generate more gold for their keep when they get kills.
- Grant a larger reward to whoever kills them.
- Gain more individual XP for risky actions.
- Trigger vague location rumors at high tiers.
- Become a priority target for enemy squads.

A higher-bounty player should **not** automatically gain more health, more damage, or permanent combat advantage.

---

### 7.3 Suggested Bounty Tiers

| Tier | Name        | Gameplay Effect                                |
| ---: | ----------- | ---------------------------------------------- |
|    0 | Nobody      | No special effect                              |
|    1 | Known       | Small reward increase                          |
|    2 | Wanted      | Worth noticeably more when killed              |
|    3 | Hunted      | Occasional vague location rumors               |
|    4 | Infamous    | Stronger regional hints and banking alerts     |
|    5 | Crownmarked | Major bounty target; death becomes a map event |

Information should remain approximate. Avoid exact constant tracking unless used for a specific special mode.

Good examples:

- “A Hunted player was seen near Blackpine Ford.”
- “A Crownmarked player is moving through the northern woods.”
- “A high-value banking chest was sighted near Eastford.”

Bad example:

- Permanent exact GPS marker on the player.

---

### 7.4 Anti-Farming Rules

The bounty system must resist abuse.

Recommended protections:

- Recently respawned players are worth reduced or zero gold.
- Repeated kills on the same victim give diminishing rewards.
- Suicides do not create bounty rewards.
- Intentional death loops should not produce value.
- Assist rewards should not duplicate full kill gold.
- Build/repair XP should be capped or tied to meaningful combat context.

---

## 8. Keep System

### 8.1 Keep Purpose

The keep is the squad’s most important asset.

It functions as:

- Respawn point
- Vault
- Build anchor
- Defensive center
- Strategic liability

If the keep becomes too rich, it should become a natural target.

---

### 8.2 Keep Placement Rules

A keep can only be placed in legal areas.

Placement should require:

- Enough flat/open space
- Minimum distance from other keeps
- Minimum distance from towns/banks
- No blocking required map paths
- No placement inside unreachable terrain
- No placement directly on top of neutral objectives
- At least two viable attack approaches

Every good keep location should have a tradeoff.

Examples:

| Keep Location Type | Strength                   | Weakness                    |
| ------------------ | -------------------------- | --------------------------- |
| Hilltop            | Strong vision and defense  | Far from banks              |
| Forest             | Harder to discover         | Poor tower sightlines       |
| River crossing     | Controls traffic           | Attracts third-party fights |
| Ruined fort        | Strong defensive footprint | Predictable and contested   |
| Near town          | Easier banking             | Easier to locate and raid   |

---

### 8.3 Respawn Rules

Suggested MVP respawn behavior:

- Dead players respawn at their active keep after a timer.
- Respawn timer increases when the keep is under attack.
- Respawns may pause if the keep is critically damaged or enemies are inside the keep radius.
- If the keep is destroyed, respawns stop.

This prevents infinite defender respawn loops during sieges.

---

### 8.4 Keep Destruction

When a keep is destroyed:

1. Respawns stop immediately.
2. Unbanked gold drops into loot containers.
3. The event creates a map-level alert or rumor.
4. Living squad members enter exile state.
5. Dead squad members remain dead unless a new keep is built.
6. Other squads may loot the dropped gold.

---

### 8.5 Exile and Rebuild

A squad with no keep but living players enters **Exile State**.

In Exile State:

- Living players can still fight.
- Living players can carry loot.
- Kills may generate carried spoils instead of keep gold.
- The squad may attempt an emergency rebuild.
- Dead squad members cannot respawn until the new keep is completed.

Recommended MVP rule:

> Each squad gets one emergency rebuild per match.

This allows comebacks without turning eliminated squads into endless cockroaches.

---

## 9. Building System

### 9.1 General Building

All players can participate in basic construction.

All classes can:

- Help build the keep
- Build basic walls
- Assist construction speed
- Perform basic repairs

This keeps the squad functional even without a specialist.

---

### 9.2 Engineer Role

The Engineer is the building and defensive specialist.

The Engineer can build or improve advanced structures such as:

- Gates
- Towers
- Traps
- Reinforced walls
- Alarm structures
- Repair stations
- Anti-stealth wards
- Siege tools

For MVP, the Engineer should have a small, clear set of unique build options.

Recommended MVP Engineer structures:

- Gate
- Watchtower
- Trap

---

### 9.3 Structure Limits

Hard limits are important to prevent wall spam and fortress abuse.

Suggested MVP limits per squad:

| Structure              |                            Suggested Limit |
| ---------------------- | -----------------------------------------: |
| Keep                   |                                   1 active |
| Emergency rebuilt keep |                                1 per match |
| Basic walls            | Limited by build supply / structure budget |
| Gates                  |                                          2 |
| Towers                 |                                          2 |
| Traps                  |                                        4–6 |

---

### 9.4 Build Resources

Use a separate build resource at first.

Recommended resources:

| Resource     | Purpose                                             |
| ------------ | --------------------------------------------------- |
| Gold         | Score, bounty, loot, banking, cosmetics after match |
| Build Supply | Walls, gates, towers, traps, repairs                |

Do not make early building consume the same gold that determines score. Otherwise defending the keep may feel like losing points.

---

## 10. Combat System

### 10.1 Combat Style

Combat is top-down and projectile-based.

The game should emphasize:

- Dodging visible projectiles
- Leading shots
- Positioning
- Line of sight
- Terrain usage
- Ambushes
- Retreats
- Escorting vulnerable carriers
- Siege pressure

---

### 10.2 Weapons and Abilities

MVP weapons should be readable and distinct.

Suggested MVP weapon set:

- Sword
- Spear
- Shield
- Bow
- Crossbow
- Firebomb
- Hammer / builder tool

Low-fantasy magic can be added later but should stay tactical and readable.

Good fantasy abilities:

- Slow fire orb
- Frost patch
- Vision ward
- Short blink
- Smoke cloud
- Curse that improves tracking against high-bounty targets

Avoid screen-filling ultimate abilities during MVP.

---

## 11. Classes

### 11.1 MVP Classes

Start with three classes.

#### Fighter

Role: frontline combat and keep defense.

Possible tools:

- Sword or spear
- Shield
- Short dash or shove
- Better survivability under pressure

#### Ranger

Role: ranged damage, scouting, ambush, pursuit.

Possible tools:

- Bow
- Trap or snare
- Short dodge
- Tracking hints or scouting utility

#### Engineer

Role: building, repairs, gates, towers, traps, siege support.

Possible tools:

- Hammer
- Crossbow or sidearm
- Faster repairs
- Advanced structures
- Trap placement

---

### 11.2 Future Class Ideas

Possible later classes:

- Raider: stealth, lockpicks, smoke, fast loot stealing
- Arcanist: low-fantasy area denial and utility magic
- Warden: defensive wards, anti-stealth, vision control
- Siegehand: rams, bombs, heavy crossbows, anti-structure tools
- Cleric / Chirurgeon: limited revive or recovery mechanics

---

## 12. Fog of War and Information

### 12.1 Starting Information

At match start, players know the terrain but not enemy activity.

Known:

- Terrain layout
- Roads
- Rivers
- Town locations
- Major landmarks

Hidden:

- Enemy positions
- Enemy keep locations
- Built structures
- Traps
- Banking runs
- Vault values
- Exact bounty player positions

---

### 12.2 Information Sources

Information can be gained through:

- Line of sight
- Watchtowers
- Scouting abilities
- Bounty rumors
- Banking alerts
- Keep destruction alerts
- Neutral objective alerts
- Enemy combat noise

Information should often be approximate rather than exact.

---

## 13. Map Design

### 13.1 MVP Map Approach

Start with one static handcrafted map.

The first map should include:

- 4–5 squad spawn regions
- 8–12 viable keep locations
- 2–3 towns or banks
- 2–3 neutral objectives
- Forested areas
- Open fields
- Chokepoints
- Hills or ruins
- River/bridge or similar contested passage
- Multiple routes between key areas

---

### 13.2 Randomization for Early Replayability

Full procedural generation is not required for MVP.

Instead, randomize:

- Squad spawn positions
- Neutral objective locations
- Some blocked/open routes
- Bank availability or town bonuses
- Resource camp locations
- Fog/weather modifiers

This helps prevent the best early route from becoming solved.

---

### 13.3 Future Map Generation

Later maps may use handcrafted procedural chunks.

Example chunks:

- Forest
- Hill pass
- River crossing
- Ruined keep
- Village
- Quarry
- Cave
- Swamp
- Roadside shrine

Chunk-based generation is safer than fully freeform procedural terrain for competitive multiplayer.

---

## 14. Towns and Banking Sites

### 14.1 Town Purpose

Towns are where squads secure gold.

They should be important, dangerous, and contested.

Towns should not be fully safe zones.

---

### 14.2 Banking Rules

Suggested MVP banking process:

1. Squad converts bankable keep gold into a carry object.
2. A player carries the gold.
3. Carrier movement is slowed based on gold amount.
4. The squad escorts the carrier to a town.
5. Banking requires a timed channel.
6. Allies nearby increase banking speed.
7. Enemies nearby contest or pause banking.
8. Banked gold becomes safe and counts toward victory.

---

### 14.3 Banking Object Types

| Object    | Gold Amount | Risk Level | Notes                        |
| --------- | ----------: | ---------- | ---------------------------- |
| Pouch     |         Low | Low        | Fast, stealthy banking       |
| Strongbox |      Medium | Medium     | Slows carrier, visible       |
| War Chest |        High | High       | Very slow, may trigger alert |

---

## 15. Progression

### 15.1 Match Gold vs Persistent Gold

Gold has two meanings:

1. **Match gold** — used for scoring, banking, plunder, and victory.
2. **Persistent gold** — earned after banking and used outside matches.

Persistent gold should be used for cosmetics, banners, titles, and personalization.

---

### 15.2 Individual Experience

Each player earns individual XP during matches.

XP may come from:

- Kills
- Assists
- Killing high-bounty players
- Scouting enemy keeps
- Defending the keep
- Building useful structures
- Repairing during combat
- Banking gold
- Escorting gold carriers
- Destroying enemy structures
- Surviving with high bounty

XP persists between matches and supports ranking/unlocks.

---

### 15.3 Unlock Philosophy

Persistent unlocks should not create major combat power gaps.

Good unlocks:

- Banners
- Heraldry
- Armor skins
- Weapon skins
- Keep cosmetics
- Titles
- Emotes
- Projectile effects
- Execution markers
- Sidegrade weapons
- Alternate structure skins

Avoid or be extremely careful with:

- More health
- More damage
- Faster movement
- Stronger starting gear
- Permanent economy bonuses
- Mandatory high-level classes

A new player should be dangerous with basic gear. A veteran should have style, options, and knowledge.

---

## 16. MVP Scope

### 16.1 MVP Must-Have Features

The MVP should prove the core loop.

Required:

- Top-down multiplayer movement
- Projectile combat
- 4 squads of 3 players
- Static map
- Fog of war / limited vision
- Keep placement and construction
- Keep respawns
- Basic walls
- Engineer gate/tower/trap
- Kill gold goes to keep
- Personal bounty system
- Banking run system
- Destroyable keeps
- Loot drops from destroyed keeps
- Banked gold win condition
- Basic persistent XP/gold tracking can be stubbed or local at first

---

### 16.2 MVP Nice-to-Have Features

Useful but not required for first proof:

- Semi-random spawns
- Semi-random objective placement
- Neutral camps
- Advanced tower vision
- Better siege tools
- Match recap screen
- Bounty rumor system
- Replay/highlight markers
- Basic cosmetics

---

### 16.3 Explicit Non-Goals for MVP

Do not build these first:

- Fully procedural map generation
- Persistent survival-world bases
- Massive player counts
- Complex crafting
- Deep economy simulation
- Dozens of weapons
- Full guild system
- Ranked matchmaking
- Live-service battle pass systems
- Huge lore campaign
- Permanent combat-stat progression

These can wait. The MVP lives or dies on bounty, banking, keep destruction, and projectile combat.

---

## 17. First Playable Prototype Plan

The first prototype should be even smaller than the MVP.

### Prototype 1 — Bounty Combat

Goal: prove combat and bounty are fun.

Features:

- Pre-placed keeps
- Basic movement
- Bow/projectile weapon
- Melee weapon
- Kill rewards go to keep
- Player bounty rises and pays out on death

No building yet.

---

### Prototype 2 — Banking

Goal: prove players will leave safety to secure gold.

Add:

- Town banking site
- Gold carry object
- Slowed carrier
- Banking channel
- Banked gold score

---

### Prototype 3 — Keep Destruction

Goal: prove siege and plunder are fun.

Add:

- Keep health
- Destroyable keep
- Respawns stop when keep dies
- Gold drops as loot sacks/chests
- Exile state

---

### Prototype 4 — Building

Goal: prove player-built defenses improve the game.

Add:

- Keep placement
- Walls
- Gates
- Towers
- Traps
- Engineer role

---

### Prototype 5 — Replayability

Goal: prevent solved openings.

Add:

- Randomized squad spawns
- Randomized neutral objectives
- Randomized bank modifiers
- Better fog/information systems

---

## 18. Key Balance Risks

### 18.1 Turtling

Problem: squads may hide behind walls and avoid risk.

Counters:

- Banked gold determines winner.
- Banking requires leaving the keep.
- At least 25% of earned gold remains exposed.
- Rich keeps generate vague rumors.
- Siege tools spawn away from keeps.
- Neutral objectives reward map control.

---

### 18.2 Snowballing

Problem: leading squads become impossible to beat.

Counters:

- Bounty increases value, not raw power.
- High-bounty players become more trackable.
- Rich keeps become bigger targets.
- Destroyed keeps drop gold to the world.
- Multiple squads can third-party the leader.

---

### 18.3 Early Elimination

Problem: eliminated players may have nothing to do.

Counters:

- Match length should stay moderate.
- One emergency rebuild gives comeback potential.
- Exile squads can still fight and steal.
- Dead players may respawn if the squad rebuilds.
- Full elimination should become a dramatic endpoint, not a long wait.

---

### 18.4 Best Keep Spot Becomes Solved

Problem: players always rush the same location.

Counters:

- Static map first, but with multiple viable keep sites.
- Randomized spawns.
- Randomized objective locations.
- Randomized bank modifiers.
- Each keep spot has tradeoffs.
- No location should have only one attack approach.

---

### 18.5 Farming and Collusion

Problem: players may exploit bounty/gold systems.

Counters:

- Diminishing rewards for repeated kills on the same player.
- Recently respawned players are worth little.
- Suicides produce no reward.
- Assist rewards do not duplicate gold.
- Build/repair XP is capped or context-sensitive.
- Suspicious kill loops can be detected later.

---

## 19. Open Design Questions

These should be answered during prototyping:

1. What is the ideal match length?
2. Should unbanked keep gold count at all toward the final score?
3. How harsh should keep destruction be?
4. Should squads get one emergency rebuild or unlimited costly rebuilds?
5. How much should high bounty reveal a player’s location?
6. Should towns ever have NPC guards, or should all danger come from players?
7. How much should carried gold slow the player?
8. Can solo queue work, or does the game require premade squads?
9. Should players choose classes before match start or swap at the keep?
10. Should engineers be mandatory, or can all squads build enough without one?
11. Should build supply be gathered, generated, or given as a fixed budget?
12. Should neutral objectives generate gold, build supply, vision, siege tools, or bounty?
13. How much magic fits before the combat becomes unreadable?
14. Should friendly fire exist in any mode?
15. How much information should players get when a keep is attacked or destroyed?

---

## 20. Current Best Version of the Game

The current strongest version of the concept is:

> **A 12-player, 4-squad, top-down medieval bounty siege match where each squad plants a keep, earns gold through combat and objectives, grows personal bounties, banks gold through risky town runs, and tries to destroy enemy keeps to spill their vaults before time expires.**

The game should prioritize:

1. Bounty pressure
2. Banking risk
3. Keep vulnerability
4. Dodgeable projectile combat
5. Squad decision-making
6. Emergent third-party chaos

Everything else is secondary.

---

## 21. Guiding Mantra

**The richer and more infamous a squad becomes, the more the map should conspire to make them nervous.**
