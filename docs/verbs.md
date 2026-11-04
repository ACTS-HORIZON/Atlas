# Verb reference

CONTRACT.md says what each verb is for. **This file is the authority for argument details, limits, `data` shapes and progress strings.** The mind loads this file into its prompt, and the body implements it (`body/src/verbs/`).

## How verbs run

- **Call:** `{"type": "call", "v": "0.1", "id": "c7", "verb": "<verb>", "args": {...}}`.
- **Result:** `{"type": "result", "id": "c7", "status": "...", "detail": "...", "data": {...}, "obs": {...}}`. `data` is present only where listed below.
- **Statuses:**
  - `done`
  - `partial`: some of it, with the reason
  - `failed`: could not, with a reason meant to be acted on
  - `interrupted`: by `stop`; the detail ends with `(at: <last progress>)`
  - `refused`: fair play, house rules, or `busy`
- **One verb at a time.** The running verb is `task` in the obs, with `progress`. `say`, `recall`, `inspect` and `stop` run alongside it. Any other call while a verb runs is `refused` with detail `busy`: it isn't queued, and the running verb is not cancelled.
- **Verbs are hands, not the player.** They are deliberately dumb: `mine` with no pickaxe fails with the reason ("iron_ore needs one of: stone_pickaxe, …"); it does not go make one. Deciding what to do next is the mind's job.
- **Unknown arguments are rejected:** `failed`, `<verb>: unknown argument "x"`.
- **Spectator mode:** every verb that acts fails.
- **Watches (`goto`, `explore`, `mine`, `collect`):** add `"watch": [{"see": "<block type | entity type | item name>", "do": {"verb": "...", "args": {...}}, "max": <n>}, ...]` (1–8 of them; `max` optional, default unlimited) to have the body react to what it sees while the verb runs, with no model turn in between. About 4 times a second the body checks `blocks_seen`, `entities` and the item drops in sight. On a new sighting of `see` (a block at a position not handled yet, an entity type coming into sight, a new drop) it holds the verb, runs `do` as a sub-call, then lets the verb carry on from wherever the bot is now (its path is re-planned). A sub-call's result never fails the parent. Each one is appended to the parent's detail as `; watched: <sub-call detail>; …` (`<verb> <status>: <detail>` when it wasn't `done`) and listed in `data.watched: [{id, see, seen: block|entity|drop, at, verb, args, status, detail}]`. While a sub-call runs, the obs `task` has `sub: {id, verb, args, progress}` (its id is `<parent id>.w<n>`). A sub-call can't watch (no nesting), and can't be `stop` or `play`. `stop` ends the verb and its sub-call. A bad watch is `failed` with the reason, e.g. `craft: watch is only for goto, explore, mine, collect`. Example, mine the iron found on the way:
  `{"verb": "explore", "args": {"direction": "north", "distance": 128, "watch": [{"see": "iron_ore", "do": {"verb": "mine", "args": {"block": "iron_ore", "count": 8}}}]}}`
  → `walked 128 blocks north; saw iron_ore 5, coal_ore 9; 14 new known places; watched: mined 5 iron_ore`.

### Fair play and house rules (enforced by the body, whatever the mind asks)
- **Targets** must be observed:
  - blocks in `blocks_seen` or known places, or visible now by the same line-of-sight check (for common types such as stone, dirt, gravel and sand);
  - players and entities visible now;
  - a player on the Locator Bar, by bearing;
  - dropped items visible now.
  Anything else: `refused` with `fair play: …`.
- **Movement:** the pathfinder plans over loaded-chunk terrain, as a walker sees the ground.
- **Protected regions** (`ATLAS_PROTECTED_REGIONS`): never dug or built in, not even by the pathfinder on the way somewhere: `refused` with `house rules: no dig|place inside protected region "<name>" ([x, y, z])`.
- **Commands:** never runs any. `say` text starting with `/` is `refused`.

## Verbs

### say {text}
Chat. Text is up to 256 characters; newlines become spaces. It runs alongside a running verb.
- `done`: `said: <text>`
- `refused`: text starts with `/`

### stop {}
Interrupts the running verb (which returns `interrupted`) and releases all movement. Always `done`: `stopped <verb>`, or `stopped (nothing was running)`. It also works while disconnected.

### recall {type, near?}
The nearest known place of `type` in this dimension. `near` defaults to the bot's position. It runs alongside a running verb.
- `done`, `data: {type, pos, dist, age}`. `age` is in game ticks.
- `failed`: `unknown`

### goto {pos | target, range?, dig = true, scaffold = true}
- **`pos`:** `[x, y, z]`.
- **`target`:** a visible player's name; a visible entity type (nearest); a block type in `blocks_seen` or known places (nearest); or a player shown on the Locator Bar.
- **`target: "surface"`:** climbs until there is open sky overhead and a side open at head height (the bottom of an open shaft doesn't count): straight up in legs of up to 16 blocks, pillaring with scaffold blocks and digging what is above, else a staircase dug into the wall. A leg stops the moment the bot is at the surface (it used to pillar on into the open air above the ground). `done`: `reached open sky at y <n> (climbed <k>)`, `data: {pos, y, climbed}`. `partial`: `stopped at y <n> (climbed <k>): lava above at y <m>` (or water), `bedrock above at y <m>`, or `no way up` (` (no scaffold blocks to pillar with)` when it had none).
- **`range`:** 0–32; default 1, or 2 with a target.
- **`dig`:** may tunnel through blocks in the way.
- **`scaffold`:** may place blocks to pillar or bridge, from dirt, cobblestone, cobbled_deepslate, netherrack, andesite, diorite, granite or tuff in the inventory.
- **Following a bearing:** for a target on the Locator Bar, it walks along the bearing in 16-block legs, re-reading the bearing each leg, until the player is in sight, then goes to within `range`.
  - **Gives up** (partial) after 512 blocks walked in total (the path, not the straight line), 48 legs, or the time cap `ATLAS_FOLLOW_MAX_S` (180 s): `followed <name>'s bearing for <n> blocks in <k> legs without seeing them` / `… for <s> s (the time cap): …`.
  - **A bearing that reverses (~180°) on two legs in a row** means the player is not ahead: `<name> is above|below you, not ahead: bearing flips each leg (horizontal distance ~0)` (from the bar's up/down indicator; `close by but not in sight` when it says level). `data.vertical` has it.
  - **Up/down:** a bearing-only player in the obs carries `vertical: above|below|level` when the bar shows an indicator: only for a nearby player (the server sends a block position); a far one (chunk or bare direction) has none.
- **Progress:** `to <what>: <n> blocks left`, or `following <name>'s bearing (<deg>°), <n> blocks so far`.
- **Results:**
  - `done`: `arrived at <what>`, `data: {pos, remaining}`
  - `partial`: `gave up <n> blocks short of <what> (stuck|took too long|no further path: <why>); tried <recoveries>`, `data: {pos, remaining, why, recoveries}`. Following a bearing: `lost <name>'s bearing after <n> blocks`, `data: {pos: null, remaining: null}`
  - `<why>` says what is around: `feet <block>, head <block>, below <block>; in front: <block> (would dig|won't dig|dig off) at [x, y, z]; dig on|off, scaffold on|off; last plan: <status>, next step […]`. `data.why` has the same as fields.
- **Far goals:** more than 48 blocks away, it walks in 16-block legs along the straight line, each leg planned on its own, then the real goal for the last stretch. Mostly up or down (a shaft to the surface), the legs are 16 blocks up or down (with `scaffold` it pillars, with `dig` it breaks through the top); a leg that gets no closer ends the legs. One long search through solid rock runs out of planning time (5 s) and leaves the bot standing still; a 16-block leg plans in a few seconds.
- **No progress:** if it hasn't taken a step (entered another block, or actually broken one) within 15 s of the call or of the last step, it gives up: `partial`, `gave up <n> blocks short of <what> (no path found yet: planner <status> after <ms> ms, <n> nodes visited, its best plan ends at [x, y, z]; nearest point reached [x, y, z], <d> blocks from the goal: <why>)`, `data.planner: {status, visited, ms, plan_end, nearest, nearest_dist}`. "Not moving" is the bot's own position: the pathfinder saying it is digging doesn't count unless a block really breaks.
- **Getting unstuck:** when it hasn't moved for about 3 s (12 s while the pathfinder says it is digging), it jumps, digs the blocks in front and above (with `dig`, leaves and logs included), and re-plans, at most 3 times per goto.
  - `failed`: `no path to <what>`
  - `refused`: `fair play: <target> has not been observed …`
- **Who is on the Locator Bar:** whoever the server sends a waypoint for (the 26.1 `tracked_waypoint` packet); the game decides, and the body adds no rules of its own. These rules were not checked against minecraft.wiki: the site was unreachable from the build environment.

### explore {direction, distance, dig = true}
- **`direction`:** north, south, east, west, north-east, north-west, south-east, south-west, or forward (the way the bot faces).
- **`distance`:** 1–512.
- **`dig`:** as goto: the path may tunnel through what is in front (a hill, a tree). It never places blocks. `dig: false` walks only.
- **What it does:** walks in 16-block legs and looks left and right after each leg.
- **Progress:** `<dir>: <n>/<distance> blocks, <k> notable blocks seen`.
- **Results:**
  - `done`: `walked <n> blocks <dir>; saw <type> <count>, …; <k> new known places`
  - `partial`: `… then blocked|no way on|took too long`, with what stood in front when it saw it: `(ahead south 2 blocks: stone at feet, oak_leaves at head)`
  - **Can't take a single step the asked way** (a cave wall, a pit): it tries the other three directions, turned right, left, then back, and explores the first that moves: `couldn't go north (ahead north 2 blocks: stone at feet, stone at head), so went east: walked …`, with `data.asked` and `data.blocked`. With none: `partial`, `walked 0 of <n> blocks: no way on in any direction: north (…); east (…); …`.
  - Both carry `data: {direction, walked, seen: {type: count}, new_places}`.

### mine {block, count = 1, radius = 32, y?}
- **Blocks, not items:** mine takes block names. Asking for an item fails, naming the blocks that drop it.
- **Limits:** `count` 1–512, `radius` 1–128, `y` −64–320.
- **Targets:** notable types (ores, logs, …) come from `blocks_seen` and known places within `radius`. Any type, stone included, also counts when visible in the terrain around the bot, looked for up to 24 blocks out.
- **For each target, nearest first:** walk until a face is in reach (the path may dig and pillar), dig it with the best tool, then pick up drops within 4 blocks.
- **Strip-mining, ores only (`*_ore`, ancient_debris) when none is in view at the start:**
  - **Tunnel:** a 1×2 tunnel straight ahead at the current y, in a serpentine: `ATLAS_STRIP_LENGTH` straight (default 24), turn, 3 across, turn, back.
  - **Targets on the way:** the target type is mined as soon as it comes into view.
  - **A hole under the next step:** bridged with a block from the inventory (cobblestone, cobbled_deepslate, dirt, netherrack, stone, andesite, diorite, granite, tuff, deepslate, blackstone); with none, it steps down into it if the drop is 3 or less and tunnels on from there.
  - **Stops:** at visible lava or water ahead or under the next step, a drop deeper than 3 it can't bridge (`a drop of <n> under the next step (nothing to bridge it with)`), gravel that keeps falling, or `ATLAS_STRIP_MAX` tunnel blocks (default 256).
  - **A block it can't get a clear look at** (the game's "Block not in view"): it faces the way again, re-centres and retries; if that keeps failing, the tunnel turns right and carries on (`blocked: could not get a clear look at the <block> ahead; turning <dir>`), stopping only after 4 such turns in a row.
  - **Tools:** tunnel blocks are dug by hand if there is no tool.
- **`y` (ores): go to that level first.** When the strip-mine starts, it digs a 1-wide staircase (2 high) straight ahead down to `y`, then tunnels at `y` as above. With `y`, the strip-mine also starts once the ores in view are mined.
  - **Each step:** clear the three blocks in front (head+1, head, feet−1), check the floor which opened up, then step down. It never digs the block under its own feet and never steps onto water or lava. A hole under the step is bridged or dropped into as in the tunnel (3 at most, the step included).
  - **Stops with the reason:** water or lava in front, lava one block further on, a deeper drop it can't bridge, or the bottom of the world: `staircase at y <n> stopped: <reason>`.
  - **Down only:** at or below `y` already, it tunnels where it is.
- **Progress:** `<mined>/<count> <block>[, tunnel <n>]: going to|digging [x, y, z]|tunnelling <dir>`.
- **Results:**
  - `done`: `mined <n> <block>`
  - `partial`: `mined <n> of <count> <block>; none left in view within <r> blocks`, `…; strip-mining stopped: <reason>` or `…; staircase at y <n> stopped: <reason>`. When targets in protected regions were skipped, it adds `; <k> inside protected regions left alone`.
  - `failed`: `mine: <block> needs one of: <tools>; none in inventory` (checked before moving); `mine: no <block> in view within <r> blocks` (a type other than ore), plus `; blocks that drop <block>: <blocks>` when other blocks drop it; `mine: <item> is an item; blocks that drop it: <blocks>` (or `; no block drops it`); for crafted things (stick, planks, crafting_table) `… is crafted from <ingredients>`; `mine: unknown block <x>`; `mine: box is not supported yet`; `mine: cannot dig in adventure mode`.
  - `refused`: every target in view is protected: `house rules: …; no other <block> in view`.
  - `done` and `partial` carry `data: {block, mined, requested, tunnel}`, plus `{y, stairs, at_y}` when `y` was given.

### dig {pos}
Digs one observed block: one visible now, or a known place. It walks within reach first (the path may dig and pillar) and digs with the best tool, or by hand if it has none.
- **Progress:** `going to <block> at [x, y, z]`, then `digging …`.
- **Results:**
  - `done`: `dug <block> at [x, y, z]`, with ` (drops <items>)` when it drops something else, or ` by hand (<block> drops nothing without the right tool)` when it had no tool; `data: {pos, block, dropped, drops}`
  - `failed`: `dig: <block> cannot be dug`; `dig: [x, y, z] is already empty (air)`; `dig: could not get within reach of [x, y, z] (<why>)`
  - `refused`: `fair play: the block at [x, y, z] has not been observed`, or house rules

### collect {item}
Walks onto visible drops of `item` until none are left in sight. This is how it receives tossed items.
- **Progress:** `<n> <item> so far; <k> in sight, going to [x, y, z]`.
- **Results:**
  - `done`: `collected <n> <item>; none left in sight`, or `no <item> drops in sight`, plus ` (mining <block> drops <item>, not <block>)` when it named a block that drops something else
  - `partial`: `collected <n> <item>; <k> drop(s) in sight could not be reached`
  - Both carry `data: {item, collected, unreachable}`.

### craft {item, count = 1}
`count` (1–576) is the number of items wanted. It uses a 2×2 inventory recipe if one works. Otherwise it uses a crafting table it has observed (in `blocks_seen` or known places, within 48 blocks), walking to it first without digging or placing. It never places a table itself.
- **Progress:** `going to the crafting table at [x, y, z]`, then `crafting <n> <item>`.
- **Results:**
  - `done`: `crafted <n> <item>[ at the crafting_table at [x, y, z]]`, `data: {item, crafted, table}`. `<n>` is how many arrived in the inventory (before/after, read once the window has settled, up to 1.5 s), not what the recipe call returned.
  - `failed`:
    - `craft: missing <what> for <count> <item>[; you have <item> <n>]`. `<what>` lists what the cheapest recipe still needs, e.g. `1 oak_log`, `2 planks (any kind)`, or `3 of cobbled_deepslate, blackstone or cobblestone, 2 stick`. An ingredient any variant fills (planks, logs, wool…) is never named as one variant. When the inventory holds what makes one of the variants, it says so: `; you have spruce_log 3`.
    - `craft: <item> needs crafting_table nearby (none seen or known within 48 blocks)`
    - `craft: <item> has no crafting recipe` (smelting is not crafting)
    - `craft: could not reach the crafting_table at …`
    - `craft: unknown item <x>`
    - `craft: nothing came out: no <item> arrived in the inventory` (nothing arrived within 1.5 s), or the game's own error

### place {block, pos?}
Places an inventory block at `pos`, which must be an empty cell (air, water, grass, …) that the bot can see and reach from where it stands (4.5 blocks), with a solid neighbour to place against. It does not walk; `goto` first.
- **Without `pos`:** it picks the spot itself: the nearest free, visible cell next to the bot, the four sides at feet level standing on solid ground first, then the others, then head level. Occupied or unseen sides are skipped without trying. If no side is free: `place: no free spot next to Atlas for <block> (…)`.
- **Results:**
  - `done`: `placed <block> at [x, y, z]`, `data: {block, pos}`
  - `failed`: `place: no <block> in inventory`; `[x, y, z] is out of reach (<d> blocks, max 4.5); goto closer first`; `is not empty (<block>)`; `is where Atlas is standing`; `is not visible from here`; `nothing solid next to [x, y, z] to place against`; `cannot place blocks in adventure mode`
  - `refused`: house rules

### equip {item, slot = hand}
`slot`: hand, off-hand, head, torso, legs, feet.
- `done`: `equipped <item> (<slot>)`, `data: {item, slot}`
- `failed`: `equip: no <item> in inventory`, `equip: unknown item <x>`

### eat {item?}
Eats `item`, or the best food in the inventory. Harmful foods (rotten_flesh, spider_eye, poisonous_potato, pufferfish, suspicious_stew, chorus_fruit) are eaten only when named.
- **Results:**
  - `done`: `ate <item>; food <before> → <after>`, `data: {item, food_before, food_after}`
  - `failed`: `eat: not hungry (food 20/20)`; `eat: no food in inventory`; `eat: only harmful food in inventory (<list>); name it to eat it anyway`; `eat: <item> is not food`; `eat: no <item> in inventory`

### give {item, count = 1, player}
Walks to an observed player and tosses the items at their feet. The player may be in sight, or out of sight on the Locator Bar (then it follows the bearing until they are in sight, as `goto` does). It stops within 2 blocks. `count` is 1–2304. Giving is always allowed.
- **Progress:** as `goto`, then `tossing <n> <item> to <player>`.
- **Results:**
  - `done`: `gave <n> <item> to <player>`
  - `partial`: `gave <n> of <count> <item> to <player>; only had <n>`
  - `failed`: `give: no <item> in inventory` (checked before walking); `give: could not reach <player>: <goto detail>`; `give: <player> is not in sight any more`
  - `refused`: `fair play: <player> has not been observed …`
  - Results with something given carry `data: {item, given}`.

### deposit {item, count?, chest}
Walks to an observed chest, trapped chest or barrel at `chest` [x, y, z] (visible now, or a known place) and puts the item in. `count` defaults to all of that item. Depositing is always allowed.
- **Progress:** `going to the <chest> at [x, y, z]`, then `putting <n> <item> in the <chest>`.
- **Results:**
  - `done`: `put <n> <item> in the <chest> at [x, y, z]`
  - `partial`: `put <n> of <count> <item> …; the chest is full`
  - `failed`: `deposit: no <item> in inventory`; `deposit: [x, y, z] is <block>, not a chest or barrel`; `deposit: could not reach the <chest> at … (<why>)`
  - `refused`: `fair play: no chest has been observed at [x, y, z]`
  - Results carry `data: {item, deposited}`.

### withdraw {item, count = 1, chest}
Takes from an observed chest, but only from one that has been given to Atlas (house rules). A chest is given through `ATLAS_CHESTS`, or by an allowlisted player looking at it and saying `@<bot> that chest is yours`.
- **Progress:** `going to the <chest> at [x, y, z]`, then `taking <n> <item> from the <chest>`.
- **Results:**
  - `done`: `took <n> <item> from the <chest> at [x, y, z]`
  - `partial`: `took <n> of <count> <item> …; the chest had only <n>`, or `…; the inventory is full`
  - `failed`: `withdraw: no <item> in the chest`; not a chest; could not reach it
  - `refused`: `house rules: the <chest> at [x, y, z] has not been given to Atlas (…)`, or fair play (not observed)
  - Results carry `data: {item, withdrawn}`.

### smelt {item, count = 1, fuel?}
Smelts in a furnace Atlas has seen: in view, or a known place within 32 blocks. It never places one.
- **`item`:** what to make (`iron_ingot`, `stone`, `glass`, `cooked_beef`, `charcoal`) or what to put in (`raw_iron`). For an output, the input is whatever in the inventory smelts into it (raw_iron or iron_ore for iron_ingot). `count` is how many come out (1–576).
- **Which furnace:** ores and raw metals go in a furnace or a blast_furnace; food in a furnace or a smoker; anything else only in a furnace. The nearest one that takes it is used.
- **Fuel:** the `fuel` item if given, else the best in the inventory: coal, charcoal, coal_block, then planks, then logs. It is never the input itself, and only as much as the count needs. Per item: coal and charcoal smelt 8, planks and logs 1.5, a stick 0.5.
- **How it runs:** walks to the furnace, puts the fuel and the input in, waits (10 s per item; 5 s in a blast furnace or smoker), and takes the output as it comes. At the end it takes back any input and fuel left over.
- **Someone else's furnace:** one whose slots hold other items is left alone.
- **Progress:** `going to the furnace at [x, y, z]`, then `<n>/<N> smelted`.
- **Results:**
  - `done`: `smelted <n> <item> in the furnace at [x, y, z]`
  - `partial`: `smelted <n> of <count> <item>; <shortage>`, where the shortage is one of:
    - `only <n> <input> in inventory`
    - `not enough fuel: <n> <fuel> smelts <m>; <k> more <fuel> needed`
    - `the furnace stopped: nothing came out for 25 s`
    - `the inventory is full`
  - `failed`, before moving:
    - `smelt: needs a furnace or blast_furnace (none seen or known within 32 blocks)`
    - `smelt: no fuel in inventory (coal, charcoal, planks or logs)`
    - `smelt: nothing to smelt into <item>: no <inputs> in inventory`
    - `smelt: <item> is not made in a furnace` (with `; it is crafted` when it is crafted)
    - `smelt: <fuel> is not a fuel`
  - `failed`, at the furnace: `smelt: the furnace is in use: its <slot> slot holds <n> <item>`.
  - `refused`: the only furnace in reach is inside a protected region: `house rules: no furnace use inside protected region "<name>" (…)`.
  - Results carry `data: {item, input, smelted, requested, fuel, fuel_used, furnace}`.

### play {intent, target?, budget?}
**Parked (Session 8).** Off unless `ATLAS_PLAYER_PLAY=1`: until then every call is `refused`, `play layer is off`, and the mind leaves this section out of its prompt. The survive override and the imitation recorder keep running when `ATLAS_PLAYER_URL` is set.
Use play for anything a player would do by hand (climb out, cross terrain, fight); use goto/mine when a script is plainly better.
- **What it does:** hands the controls to the player loop (the decision model, ~20 Hz) with `intent` (free text, e.g. "get to the surface", "walk to Rook") and an optional `target`. It runs until the model says the intent is done or that it's stuck, the `budget` runs out (seconds, or `{ticks, seconds}`; default 60 s), or `stop`.
- **Progress:** `<intent>: tick <n>, <action> (<effect>)`.
- **Results:**
  - `done`: `play "<intent>": done after <n> ticks; moved <d> blocks ([x, y, z] → [x, y, z]), dug <k>, placed <k>, damage <h>`
  - `partial`: the same, with `the player is stuck after <n> ticks` or `out of budget after <n> ticks (<s> s)`
  - `failed`: `play: no decision model configured (ATLAS_PLAYER_URL)`
  - `refused`: `play layer is off` (parked; `ATLAS_PLAYER_PLAY=1` turns it on)
  - Results carry `data: {end, ticks, seconds, moved, from, to, dug, placed, damage, log}`. `log` is the `logs/player-<date>.jsonl` file holding every tick.

## Not implemented yet
`inspect`, `build`, `fight`, `flee` and the Later list in CONTRACT.md. Calling one gives `failed` with `verb not implemented yet: <verb>`.

## Events

The event kinds the body emits (body → mind, `{"type": "event", "kind", "detail", "obs"}`). This is the complete list; the mind's wake rules use exactly these.

| Kind | When | `detail` |
|---|---|---|
| `task_from_chat` | an allowlisted player's `@<bot> …` that isn't `stop`, `status` or the chest grant | `{from, text}` (text without the `@<bot>`) |
| `player_said` | other chat from an allowlisted player | `{from, text}` |
| `stop_requested` | `@<bot> stop`, or the dashboard's Stop button | `{from, detail}` |
| `damaged_badly` | health dropped by 4 or more in one update, or any drop while health is below 10 (not on death). At most one every 3 s, except a drop of 4+ in one update, which always goes | `{health, lost, food}`, plus `in_water: true`, `on_fire: true` and `attacker: <type>` (the nearest visible hostile within 4 blocks) when known |
| `died` | the bot died | `{pos}` |
| `respawned` | the bot spawned again after dying | `{pos}` |
| `player_joined` / `player_left` | another player joined or left (not during the first seconds after the bot joins) | `{name}` |

CONTRACT.md also names `item_received`, `verb_done`, `reflex_escalation`, `inventory_full` and `night_falling`; the body does not emit them (yet).

**Which wake the mind with no open task:** `task_from_chat`, `player_said`, `stop_requested`, `damaged_badly`, `died` (and health or food dropping below its threshold, from the obs). The others are noted for the next turn without one. With a task open, every event wakes it.

## Chat the body handles itself
From players on `ATLAS_PLAYERS` only:
- `@<bot> stop` stops the running verb, replies in chat and sends event `stop_requested {from, detail}`.
- `@<bot> status` replies `status: <verb> (<progress>) | health <h> food <f> | at x y z`.
- `@<bot> that chest is yours` (house rules): the chest the player is looking at, and the bot can see, joins the withdraw allowlist, with the other half of a double chest next to it. The bot replies in chat. Grants persist per server in `data/chests.<host>_<port>.json`.
- Any other `@<bot> <text>` sends event `task_from_chat {from, text}`. That includes `come here`, which is the mind's to decide.
- Their other chat sends event `player_said {from, text}`.

Chat from anyone else only appears in `obs.chat`.
