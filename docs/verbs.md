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
- **`range`:** 0–32; default 1, or 2 with a target.
- **`dig`:** may tunnel through blocks in the way.
- **`scaffold`:** may place blocks to pillar or bridge, from dirt, cobblestone, cobbled_deepslate, netherrack, andesite, diorite, granite or tuff in the inventory.
- **Following a bearing:** for a target on the Locator Bar, it walks along the bearing in 16-block legs, re-reading the bearing each leg, until the player is in sight, then goes to within `range`. It gives up after 512 blocks.
- **Progress:** `to <what>: <n> blocks left`, or `following <name>'s bearing (<deg>°), <n> blocks so far`.
- **Results:**
  - `done`: `arrived at <what>`, `data: {pos, remaining}`
  - `partial`: `gave up <n> blocks short of <what> (stuck|took too long|no further path)`, `data: {pos, remaining}`. Following a bearing: `lost <name>'s bearing after <n> blocks`, `data: {pos: null, remaining: null}`
  - `failed`: `no path to <what>`
  - `refused`: `fair play: <target> has not been observed …`
- **Who is on the Locator Bar:** whoever the server sends a waypoint for (the 26.1 `tracked_waypoint` packet); the game decides, and the body adds no rules of its own. These rules were not checked against minecraft.wiki: the site was unreachable from the build environment.

### explore {direction, distance}
- **`direction`:** north, south, east, west, north-east, north-west, south-east, south-west, or forward (the way the bot faces).
- **`distance`:** 1–512.
- **What it does:** walks in 16-block legs, never digging or placing, and looks left and right after each leg.
- **Progress:** `<dir>: <n>/<distance> blocks, <k> notable blocks seen`.
- **Results:**
  - `done`: `walked <n> blocks <dir>; saw <type> <count>, …; <k> new known places`
  - `partial`: `… then blocked|no way on|took too long`
  - Both carry `data: {direction, walked, seen: {type: count}, new_places}`.

### mine {block, count = 1, radius = 32}
- **Limits:** `count` 1–512, `radius` 1–128.
- **Targets:** notable types (ores, logs, …) come from `blocks_seen` and known places within `radius`. Any type, stone included, also counts when visible in the terrain around the bot, looked for up to 24 blocks out.
- **For each target, nearest first:** walk until a face is in reach (the path may dig and pillar), dig it with the best tool, then pick up drops within 4 blocks.
- **Strip-mining, ores only (`*_ore`, ancient_debris) when none is in view at the start:**
  - **Tunnel:** a 1×2 tunnel straight ahead at the current y, in a serpentine: `ATLAS_STRIP_LENGTH` straight (default 24), turn, 3 across, turn, back.
  - **Targets on the way:** the target type is mined as soon as it comes into view.
  - **Stops:** at visible lava or water ahead, a hole under the next step, gravel that keeps falling, or `ATLAS_STRIP_MAX` tunnel blocks (default 256).
  - **Tools:** tunnel blocks are dug by hand if there is no tool.
- **Progress:** `<mined>/<count> <block>[, tunnel <n>]: going to|digging [x, y, z]|tunnelling <dir>`.
- **Results:**
  - `done`: `mined <n> <block>`
  - `partial`: `mined <n> of <count> <block>; none left in view within <r> blocks` or `…; strip-mining stopped: <reason>`. When targets in protected regions were skipped, it adds `; <k> inside protected regions left alone`.
  - `failed`: `mine: <block> needs one of: <tools>; none in inventory` (checked before moving); `mine: no <block> in view within <r> blocks` (a type other than ore); `mine: unknown block <x>`; `mine: box is not supported yet`; `mine: cannot dig in adventure mode`.
  - `refused`: every target in view is protected: `house rules: …; no other <block> in view`.
  - `done` and `partial` carry `data: {block, mined, requested, tunnel}`.

### dig {pos}
Digs one observed block: one visible now, or a known place. It walks within reach first (the path may dig and pillar) and digs with the best tool, or by hand if it has none.
- **Progress:** `going to <block> at [x, y, z]`, then `digging …`.
- **Results:**
  - `done`: `dug <block> at [x, y, z]`, with ` by hand (<block> drops nothing without the right tool)` when it had no tool; `data: {pos, block, dropped}`
  - `failed`: `dig: <block> cannot be dug`; `dig: [x, y, z] is already empty (air)`; `dig: could not get within reach of [x, y, z] (<why>)`
  - `refused`: `fair play: the block at [x, y, z] has not been observed`, or house rules

### collect {item}
Walks onto visible drops of `item` until none are left in sight. This is how it receives tossed items.
- **Progress:** `<n> <item> so far; <k> in sight, going to [x, y, z]`.
- **Results:**
  - `done`: `collected <n> <item>; none left in sight`, or `no <item> drops in sight`
  - `partial`: `collected <n> <item>; <k> drop(s) in sight could not be reached`
  - Both carry `data: {item, collected, unreachable}`.

### craft {item, count = 1}
`count` (1–576) is the number of items wanted. It uses a 2×2 inventory recipe if one works. Otherwise it uses a crafting table it has observed (in `blocks_seen` or known places, within 48 blocks), walking to it first without digging or placing. It never places a table itself.
- **Progress:** `going to the crafting table at [x, y, z]`, then `crafting <n> <item>`.
- **Results:**
  - `done`: `crafted <n> <item>[ at the crafting_table at [x, y, z]]`, `data: {item, crafted, table}`
  - `failed`:
    - `craft: missing <what> for <count> <item>`. `<what>` lists what the cheapest recipe still needs, e.g. `3 oak_planks`, `2 planks (any kind)`, or `3 of cobbled_deepslate, blackstone or cobblestone, 2 stick`.
    - `craft: <item> needs crafting_table nearby (none seen or known within 48 blocks)`
    - `craft: <item> has no crafting recipe` (smelting is not crafting)
    - `craft: could not reach the crafting_table at …`
    - `craft: unknown item <x>`

### place {block, pos}
Places an inventory block at `pos`, which must be an empty cell (air, water, grass, …) that the bot can see and reach from where it stands (4.5 blocks), with a solid neighbour to place against. It does not walk; `goto` first.
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

## Not implemented yet
`inspect`, `build`, `smelt`, `fight`, `flee` and the Later list in CONTRACT.md. Calling one gives `failed` with `verb not implemented yet: <verb>`.

## Chat the body handles itself
From players on `ATLAS_PLAYERS` only:
- `@<bot> stop` stops the running verb, replies in chat and sends event `stop_requested {from, detail}`.
- `@<bot> status` replies `status: <verb> (<progress>) | health <h> food <f> | at x y z`.
- `@<bot> that chest is yours` (house rules): the chest the player is looking at, and the bot can see, joins the withdraw allowlist, with the other half of a double chest next to it. The bot replies in chat. Grants persist per server in `data/chests.<host>_<port>.json`.
- Any other `@<bot> <text>` sends event `task_from_chat {from, text}`. That includes `come here`, which is the mind's to decide.
- Their other chat sends event `player_said {from, text}`.

Chat from anyone else only appears in `obs.chat`.
