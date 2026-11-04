# 📜 Contract v0.1

**Status:** v0.1 — Approved 2026-11-02; amended 2026-11-04 (player loop parked, watched verbs)

The contract is the version-agnostic part of the project. Every layer talks only through it, so the game backend (Mineflayer now, our own Fabric mod later) can be swapped without touching the brain, skills, reflexes or training data.

## Processes

* **Body** — game backend + verb library + verb loader + reflex loop + fair-play filter + house rules. Node, in the `atlas` LXC on pve3. v1 backend: Mineflayer, connected to the offline-mode 26.1 dev server in the same LXC (LAN-only). End state: the Fabric mod on the co-op server (26.3) replaces Mineflayer *under* the body, exposing the same primitives (observe, move, dig, place, use…); the body, the JS verbs and this contract stay unchanged.
* **Mind** — Gemma loop, notes (persistent across sessions), wiki RAG, live verb writing, chat task handling, optional advisor calls.
* **Link** — one WebSocket between them, JSON messages, every message carries `"v": "0.1"`. Body → mind: `obs`, `result`, `event`. Mind → body: `call`, `observe`, `trace`. Everything is logged as JSONL. Logs contain contract messages only — never anything backend-specific — so they stay valid fine-tuning data across backends.

The reflex loop lives inside the body, so the 20 Hz path never crosses the link.

The bot's name is configuration (default `Atlas`); `@<botname>` below means whatever it's set to.

## Rules the body enforces (never trusted to a model)

**Fair play** — adaptations, not cheats. The observation builder reports only what a player could perceive, in a form the models can use:

* Blocks and entities only if within render distance **and** line of sight (raycast from the eyes).
* Sounds as bearing + rough distance (near / mid / far), not exact coordinates.
* Own coordinates, time, weather and boss bar are fine (a player has F3 and the HUD).
* Other players: position, and the block they are looking at if it's visible (their look direction is visible).
* Players out of line of sight: bearing only (plus the bar's up/down indicator when it shows one), exactly when the game's Locator Bar would show them — i.e. when the server sends a Locator Bar waypoint for that player — so a player the game hides from the bar (sneaking, invisible, …) stays hidden.
* No ores behind rock, no hidden entity state (health, AI target), no seed-derived knowledge.
* Pathfinding may plan over loaded-chunk terrain geometry (a player sees the ground as they walk); verbs still only target observed things, or a player by bearing.
* A verb may only target blocks or entities the bot has actually observed.
* Verbs — including ones Gemma writes live — use the body's filtered API only, never the raw backend.

**Gamemode** — whatever Collin sets. The bot never changes its own gamemode and never runs commands.

**House rules** (apply in any shared world, survival or creative):

* Protected regions (list of boxes): no dig, no place inside them.
* Chest allowlist: only take from chests it's been given. A chest is added only by an allowlisted player in chat ("@Atlas that chest is yours").
* Giving is always allowed: toss items to a player, or deposit into a chest the player names.
* Never op. `stop` from an allowlisted player halts everything instantly, handled by the body without the mind.
* World backup before the bot joins a shared world.

## Observation

Two views of the same filtered world, plus an on-request region view.

**Full view** (mind, on events or on request), example. On request means the mind sends `{"type": "observe", "v": "0.1"}` and the body answers with an `obs`.

```json
{"type": "obs", "v": "0.1", "t": 18342,
 "self": {"pos": [104, 63, 131], "dim": "overworld", "yaw": 90, "pitch": 10,
          "health": 14, "food": 17, "xp": 3, "on_ground": true, "in_water": false,
          "held": "stone_pickaxe", "armor": ["leather_chestplate"], "effects": [],
          "gamemode": "survival"},
 "inventory": {"cobblestone": 41, "oak_log": 6, "coal": 9, "bread": 3, "stone_pickaxe": 1},
 "world": {"time": "dusk", "weather": "clear", "light": 9, "biome": "cherry_grove"},
 "blocks_seen": [{"type": "iron_ore", "pos": [110, 58, 129], "dist": 8.3},
                 {"type": "lava", "pos": [99, 60, 133], "dist": 6.1}],
 "entities": [{"type": "zombie", "rel": [5, 0, -2], "dist": 5.4, "bearing": "front-left",
               "approaching": true, "hostile": true}],
 "players": [{"name": "ACTS_HORIZON", "pos": [98, 64, 130], "dist": 6.2,
              "looking_at": [96, 63, 128]}],
 "sounds": [{"type": "creeper_hiss", "bearing": "behind", "dist": "near"}],
 "boss_bar": null,
 "chat": [{"from": "ACTS_HORIZON", "text": "@Atlas grab some iron", "t": 18300}],
 "task": {"id": "t12", "verb": "mine", "args": {"block": "iron_ore", "count": 8},
          "progress": "3/8", "state": "running"}}
```

`blocks_seen` lists notable block types only (ores, logs, water, lava, chests, crafting tables, furnaces, beds, portals, spawners, obsidian, enchanting tables, anvils, brewing stands, shulker boxes, vaults…), not every stone block. Nearest first, at most 48 entries and at most 12 of any one type. A pool is listed as water at its surface only.

`surroundings` (optional; added in Session 5) is the close-range view: the blocks at the feet, head, below and above, the first solid block (and its distance, up to 8) north/east/south/west at feet and head height, the floor drop one step each way, whether there is open sky overhead, the light, and one derived sentence (`"in a 1-wide shaft 5 deep, stone all sides, open above"`). Built from blocks in line of sight only.

**Sight:** `sight_radius` is config, default 64 blocks, and is never more than the server's or the bot's render distance. Glass, ice and water are transparent; leaves and lava block sight.

**Known places** (body-side): the body keeps a log of every notable block (ores, chests, portals, beds, crafting stations…) that has appeared in `blocks_seen`, with position, dimension and last-seen time (game ticks), persisted to disk and reloaded on start. The file is per server: `data/known-places.<host>_<port>.json` from the configured server address, so two servers (e.g. the dev world and the co-op server) never share one; a configured path overrides it. Only blocks that passed the fair-play filter enter it. An entry is dropped when the bot can see its position again and the block is no longer there. The `recall` verb reads it: `{"type": "call", "id": "c7", "verb": "recall", "args": {"type": "iron_ore", "near": [100, 64, 130]}}` → `{"type": "result", "id": "c7", "status": "done", "detail": "iron_ore at [110, 58, 129]", "data": {"type": "iron_ore", "pos": [110, 58, 129], "dist": 11.8, "age": 3600}, "obs": {...}}`. `near` defaults to the bot's position, `age` is in game ticks since last seen, and only the current dimension is searched. With no entry of that type: `failed`, detail `unknown`.

**Region view** (`inspect`, on request): every block in a box, but only the faces the bot can see from where it stands — line of sight still applies. This is how it reads a design to copy or checks a dig-out.

**Reflex view** (body-internal, every tick, \~150–250 tokens): self vitals, held item, the nearest few visible or heard threats, nearby hazards (lava, drops, fire), what the current verb is doing, and which reflex actions are currently possible.

## Verbs (mind → body)

Call: `{"type": "call", "id": "c41", "verb": "mine", "args": {"block": "iron_ore", "count": 8, "radius": 32}}`

Result: `{"type": "result", "id": "c41", "status": "partial", "detail": "mined 3 of 8, ran out of seen ore", "obs": {...}}`. Verbs that return information (e.g. `recall`) add it as `data`.

Statuses: `done` · `partial` · `failed` (with reason) · `interrupted` (by reflex or `stop`) · `refused` (house rules or fair play).

The body runs one verb at a time; it appears as `task` in the obs. `say`, `recall`, `inspect` and `stop` run alongside a running verb. Any other call while one is running is `refused` with reason `busy`.

**Core (v1):**

| Verb | Args | Notes |
|------|------|-------|
| `goto` | `pos` or `target`, `dig`, `scaffold`, `watch` | pathfinder; `target` may be a player by bearing; `dig` and `scaffold` default true (tunnels and pillars like a player); house rules still apply |
| `explore` | `direction`, `distance`, `watch` | walk and look around, reports what it saw |
| `mine` | `block`, `count`, `radius` or `box`, `watch` | only seen blocks: notable types from blocks_seen / known places, common types (stone, dirt, gravel, sand, logs…) by looking at the terrain around it with the same line-of-sight check (`mine stone 3` is valid when stone is visible); strip-mines/caves for ores not in view; `box` = dig out a region |
| `dig` | `pos` | one block |
| `collect` | `item`, `watch` | pick up nearby drops (this is also how it receives tossed items) |
| `craft` | `item`, `count` | uses a nearby crafting table if needed |
| `smelt` | `item`, `count`, `fuel` |       |
| `place` | `block`, `pos` |       |
| `build` | `blocks` (list of block+pos) or `copy` (`from` box, `to` pos) | places a design; `copy` uses the region view |
| `inspect` | `box` | region view, see Observation |
| `recall` | `type`, `near` (optional) | nearest known place of that type, see Known places |
| `equip` | `item`, `slot` |       |
| `eat` | `item` (optional) |       |
| `fight` | `target`, `until` | melee; reflexes take over in close combat |
| `flee` | `from` |       |
| `give` | `item`, `count`, `player` | walk to the player, toss at their feet |
| `deposit` / `withdraw` | `item`, `count`, `chest` | withdraw only from allowlisted chests |
| `say` | `text` | chat; text starting with `/` is refused |
| `play` | `intent`, `target`, `budget` | hands the controls to the player loop (see Player loop) until `done`/`stuck`/budget/`stop` |
| `stop` |      | cancel current verb |

**Later:** `shelter`, `pillar`, `bridge`, `sleep`, `use` (doors, levers, portal lighting), `throw` (eyes of ender), `shoot` (bow), `follow`, `trade`, farming (`plant`, `harvest`). Note: the dragon run needs `use`, `throw`, `shoot`, `sleep`, `bridge` and `pillar`, so core v1 alone cannot beat the game.

**Contract and verb reference:** this contract is the what-it's-for level. Argument details, limits, data shapes and progress strings live in the repo's verb reference, which is the authority for those. Verbs are hands, not the player. They are deliberately dumb: `mine` with no pickaxe fails with the reason; it does not go make one. That decision is the mind's.

**Live verb writing (Gemma):** when no verb fits, Gemma first calls a holding verb (`shelter` or `retreat`), then writes a new verb as JS against the body's filtered API. Its context: the body API reference, the two or three most similar existing verbs, and the failed attempt's error trace. The body validates the verb's API calls in a dry run, then loads it and runs it. It returns `done`/`failed` like any verb; Gemma iterates on failure. Verbs that work are saved to the library on disk and carried across worlds and servers. The advisor, if enabled, can be asked for help writing one — it never runs anything.

**Standing tasks:** a task with no completion check (farm this plot, stay here). It loops until `stop`. Night, hunger and danger are handled like any other task. A new task arriving mid-task: Gemma says what it'll do in chat ("pausing farming, getting your iron, then back") and does it.

## Player loop (body-internal) — replaces "Reflexes", 2026-11-03 (Collin)

Three layers, not two. Gemma is strategy (seconds). The decision model is **the player** (20 Hz). Verbs are macros Gemma may still call when a script is simply better (A\* across open ground, crafting through a window) — hands, not the player.

* **Always on:** d1-2B ticks continuously (\~20 Hz) on the reflex view plus Gemma's current **intent** (free text + optional target, e.g. "get to the surface", "walk to Rook"). One `choice` question per tick covers survival and play alike; no separate reflex gate.
* **Micro-actions v1:** `step`, `sprint`, `jump`, `turn_left`, `turn_right`, `look_up`, `look_down`, `dig_ahead`, `dig_above`, `dig_below`, `place_below_and_jump`, `place_ahead`, `attack`, `block`, `retreat`, `eat`, `wait`, `done` (intent satisfied), `stuck` (can't). The body offers only the actions that are possible **and not immediately lethal** this tick (no step into lava or a drop > 3, no dig below with air under it, no `eat` without food) — the 2B model stays safe by what it is offered, not by what it knows.
* **Intent lifecycle:** Gemma sets an intent with the `play {intent, target?, budget}` verb; the loop runs until the model answers `done` or `stuck`, the budget (ticks or seconds) runs out, or `stop`. The result reports what happened and why, with the tick trace attached for fine-tuning d1 later.
* **Override:** with a scripted verb running, any answer other than `continue_task` pauses it and acts; \~1 s of `continue_task` resumes it; if it can't resume, `interrupted` goes to the mind.
* **Escalate:** a 2–5 Hz `noul` question ("does the brain need to know?") sends `reflex_escalation` to the mind.
* **Fair play unchanged:** the reflex view is built by the same filter; micro-actions act on what the player can see.
* **Risk, named:** d1-2B's quality on real game states is untested (bench caveat). The player loop is measured against the scripted verbs on the same tasks; if it loses badly, the model or its prompt is the problem, not the design.

**Outcome, 2026-11-04 (Collin):** measured. With the plumbing clean (34 ms ticks, 0 timeouts, argmax decoding, end-of-run discipline), d1-2B still could not climb a shaft in 317 ticks (138 jump, 48 stuck, 27% agreement with the script, 60% on the eval twice) while `goto surface` climbed 43 blocks from the same spot. d1 answered every survive-mode tick correctly. **d1 is a reflex classifier, not a planner.** No additional model is added (scope). So:

* **Reflex (d1) stays as built:** survive mode, 5 Hz, 20 Hz under threat or damage; timeouts never pause a verb.
* **`play` and the micro-action loop stay in the code but off by default** (`ATLAS_PLAYER_PLAY=0`); the imitation recorder keeps logging every scripted run (`logs/imitation-<date>.jsonl`) so a future d1 fine-tune has data. No fine-tuning is scheduled.
* **Watched verbs replace the play layer for "do X unless you see Y":** `goto`, `explore`, `mine`, `collect` take `watch: [{see: <block|entity|item>, do: {verb, args}, max?}]`. On sight of Y — deterministic, from `blocks_seen`/entities/drops, no model — the body holds the verb, runs the sub-call, and resumes, re-planning the path. Gemma composes ("explore north, mine any iron you see, keep going"); the hands execute; d1 is not asked questions a lookup can answer. Depth 1, `stop` ends both, a failed sub-call never fails the parent.

## Events (body → mind)

`{"type": "event", "kind": "...", "detail": ..., "obs": {...}}`

Kinds: `task_from_chat`, `player_said` (any chat from an allowlisted player that isn't a task — answers to its questions), `item_received`, `verb_done` (redundant with result, for logging), `reflex_escalation`, `damaged_badly`, `died`, `respawned`, `inventory_full`, `night_falling`, `player_joined` / `player_left`, `stop_requested`.

**Trace** (mind → body): `{"type": "trace", "v": "0.1", "t": <tick>, "kind": "plan|decision|rag|verb_write|advisor|note|lesson", "text": "...", "data": {...}}` records the mind's reasoning; the body logs it like every other message and never acts on it.

## Mind loop


1. Wakes on a result, an event, or an idle timer (\~10 s).
2. Builds context: task, full observation, notes, short memory, RAG hits for what it's about to do.
3. Outputs exactly one of: a verb call, `say`, `ask_player(question)` (says it in chat and waits for a `player_said`), `lookup(query)` (searches the wiki; the answer is in the next turn's context), `lesson(text)` (writes down a lesson from its own play), `write_verb(spec)`, `ask_advisor(question)`, or `wait`.
   Or, instead of one action, a **plan**: an ordered list of up to 6 calls with one `thinking`. The mind runs it step by step (still one verb at a time) and thinks again only when a result isn't `done`, an event arrives (`task_from_chat`, `player_said`, `damaged_badly`, `died`, `stop_requested`, …), or the plan finishes. Each step's result is logged as usual. A plan is for when the next few steps are obvious (craft sticks → craft stone_pickaxe → mine iron_ore); a single action is for when the next step depends on what the bot will see.
4. `ask_advisor` only exists when the advisor is enabled (config, off by default). Input/output only. Capped per session by dollars or tokens (config).
5. Notes: Gemma writes down what worked, where things are, and what it learned; the notes file persists across sessions, worlds and servers. Lessons (`data/lessons.jsonl`) are what it learned from its own play, written only by the model (when it chooses, when a task closes, and when the same kind of failure comes back twice) and retrieved into the context by situation; they are never rules the code applies.

**Knowledge:** game facts come from a local, offline index of minecraft.wiki pages (fetched once, personal use): each turn the mind retrieves a few excerpts for what it is doing, `lookup` searches it on purpose, and the wiki wins over the model's memory when they disagree; it is general game knowledge, never world-specific state (fair play is unchanged).

## Chat tasks

* A message starting with `@<botname>` from an allowlisted player becomes a `task_from_chat` event.
* The mind turns it into a plan. If the ask is unclear (which box, which chest, how many), it asks in chat and waits. Then it confirms ("on it: 64 iron, I'll bring it to the chest by spawn") and reports progress and questions in chat.
* Regions can be given as coordinates, by standing at the corners and saying "here", or by pointing at the corner blocks. The mind reads the box back and confirms before digging or building.
* Only `stop` and `status` are handled by the body directly, so they work even if the mind is busy or down. Everything else, including "come here", is a normal `task_from_chat` for the mind. (The house-rules chest grant, "@Atlas that chest is yours", is also enforced by the body.)
* The dev-world dragon run is started the same way ("@Atlas beat the game").

## Open questions

* Fair play, case by case: where adaptations stop. Decided as cases come up.
* Live verb writing success rate — unknown until tried.
* Reflex quality on real game states — untested; always-on tick is a bet.
* If one combined-action question is too coarse: `-np 5` or Liquid's transformers runtime.
* Fabric mod backend — designed later.