# Atlas

A Minecraft agent. [`CONTRACT.md`](CONTRACT.md) is the spec every layer follows.

```
body/      Node: Mineflayer backend, fair-play observation builder, verbs, link server, dashboard
mind/      Python: the mind loop (LLM) and a terminal client
contract/  JSON Schema for the link messages (obs, call, result, event)
deploy/    example systemd unit
logs/      contract-message logs, JSONL (gitignored)
data/      known places file (gitignored)
```

## What works so far

- **Body** joins as `Atlas` (offline auth) and reconnects if the server goes away. Nothing is observed or sent until health and food are known (they arrive just after spawn), so the first obs is always complete. It never gets op, never runs commands and never changes its gamemode; it plays in whatever gamemode you set.
- **Link**: a WebSocket on `127.0.0.1:8765`. The body sends a full-view `obs` when the mind connects, when it is asked, and every 2 s. It accepts `call` for the verbs in [docs/verbs.md](docs/verbs.md), answers each with a `result`, and emits `event`s for `died`, `respawned`, `player_joined`, `player_left`, `stop_requested`, `task_from_chat`, `player_said` and `verb_done`. It also accepts `trace` (the mind's reasoning), which it logs and never acts on.
- **Fair-play observation** (`body/src/fairplay/`):
  - `blocks_seen`: notable types only. They must be within the sight radius and visible along a raycast from the eyes, where the first solid block wins. Nearest first, at most 48 blocks and at most 12 of any one type. A pool is listed as water at its surface only.
  - Sight: glass, ice and water are transparent; leaves and lava block sight. The radius is `sight_radius` (`ATLAS_SIGHT_RADIUS`, default 64), never more than the server's or the bot's render distance.
  - `entities` and `players`: only those in line of sight. No hidden state. A player's `looking_at` is filled only when the bot can see that block too.
  - `sounds`: type, bearing and near/mid/far only.
- **Known places** (`body/src/places.js`): every notable block that has appeared in `blocks_seen` is remembered with position, dimension and last-seen game tick, saved at most every 10 s and on shutdown, and reloaded on start. The file is named after the configured server, `data/known-places.<host>_<port>.json` (e.g. `data/known-places.localhost_25565.json`), so the dev world and the co-op server never share one; `ATLAS_PLACES_FILE` overrides the name. The name comes from `ATLAS_MC_HOST` as written, so `localhost` and `127.0.0.1` give two files for the same server: pick one spelling and keep it. Nothing else can enter it. An entry is dropped when Atlas can see the spot again and the block is gone. `recall {type, near?}` returns the nearest one as `data: {type, pos, dist, age}`, or `failed` with detail `unknown`.
- **Chat:** only players on `ATLAS_PLAYERS` are listened to.
  - `@Atlas stop`, `@Atlas status` and `@Atlas come here` are handled by the body itself, so they work even with the mind busy or down.
  - Any other `@Atlas …` becomes a `task_from_chat` event, and their other chat a `player_said` event.
  - Everyone else's chat only appears in `obs.chat`.
- **House rules:** protected regions (`ATLAS_PROTECTED_REGIONS`, a JSON list of boxes, empty by default). Nothing is dug or placed inside one.
- **Locator Bar:** not available yet; see [Locator Bar](#locator-bar-not-available-yet).
- **Logs**: every contract message in or out is appended to `logs/link-YYYY-MM-DD.jsonl` as `{"ts", "dir": "in"|"out", "msg"}`.
- **Verbs** run one at a time (`body/src/runner.js`), and the running one shows as `task` in the obs. `say`, `recall`, `inspect` and `stop` run alongside it. Any other call while a verb runs is `refused` with detail `busy`: it is not queued, and the running verb keeps going. `stop` aborts the running verb, so it returns `interrupted`, and releases every movement control.
- **Dashboard** at `http://<atlas>:8080/` (see below).
- **Mind** (brain v0): `python -m atlas_mind` is the loop. It wakes on results, events and a 10 s timer, asks an OpenAI-compatible model for one action per turn, keeps a task list and a notes file, and sends its reasoning as `trace`. See [Mind (brain v0)](#mind-brain-v0).
- **Terminal client:** `python -m atlas_mind.client` prints every message and takes typed verb commands (`say`, `goto`, `mine`, `craft`, …).

### Contract notes

- **Requesting an obs**: the mind sends `{"type": "observe", "v": "0.1"}`.
- **`say`**: text starting with `/` gets `refused`, because the bot never runs commands.
- **`result.data`**: verbs that return information put it in `data`; shapes are in [docs/verbs.md](docs/verbs.md).
- **`trace`**: `data` is optional; `t` is the tick of the latest obs the mind has.
- **`obs: null`.** A `result` or `event` sent while the bot is not in the game carries `obs: null`.
- **Yaw and pitch** are in F3 degrees: yaw 0 is south and 90 is west; positive pitch looks down.
- **Bearing-only players:** an obs `players` entry is either `{name, pos, dist, looking_at}` (in sight) or `{name, bearing}` (out of sight, on the Locator Bar).

### Locator Bar (not available yet)

CONTRACT.md: players out of sight are reported by bearing only, exactly when the game's Locator Bar would show them.
- **Protocol:** in 26.1 the server sends the bar in the `tracked_waypoint` play packet (track / untrack / update; keyed by player UUID; carrying a block position, a chunk, or only an azimuth). minecraft-protocol parses it, but **Mineflayer 4.39 has no handler for it**.
- **What the body does instead:** it reports no bearings. It deliberately does not compute them from entity positions, because that would show players the game hides.
- **What's ready:** the observation builder, the obs schema and `goto` by bearing all support it, and are tested with a stand-in source. Wiring the real packet changes only `body/src/locator.js`.

## Verbs

**[docs/verbs.md](docs/verbs.md) is the verb reference.** It is the authority for arguments, limits, `data` shapes, progress strings and failure reasons, and the mind loads it into its prompt.

- **Implemented:** `say`, `stop`, `recall`, `goto`, `explore`, `mine`, `collect`, `craft`, `place`, `equip`, `dig`, `eat`.
- **One at a time:** the running verb is the `task` in the obs, with progress, and `stop` interrupts it.
- **Filtered API:** verbs act only through `body/src/api.js`, which enforces fair play (targets must be observed; blocks are read only when visible) and house rules (protected regions). The Mineflayer side is `body/src/motor.js`, which also guards `bot.dig` and `bot.placeBlock` against protected regions, so not even the pathfinder digs or builds in one.
- **Deliberately dumb:** a verb that can't do its job fails with a reason the mind can act on ("needs crafting_table nearby", "missing 3 oak_planks"). It doesn't go and fix the cause itself.

## Install on the `atlas` LXC

Everything below runs from the Proxmox console of the LXC: in the web UI, open *atlas → Console*, or run `pct enter <vmid>` on the host. There is no SSH, so nothing is copied in; the code arrives through `git clone` from inside the LXC.

Assumed already present: Node 26 (`/usr/local/bin/node`, `/usr/local/bin/npm`), Python 3.13, and the vanilla 26.1 server on port 25565 with `online-mode=false`.

**1. Packages and a service user** (as root):

```bash
apt update && apt install -y git ca-certificates python3-venv tmux
```

```bash
useradd --system --create-home --home-dir /home/atlas --shell /bin/bash atlas
```

**2. Clone the repo:**

```bash
git clone https://github.com/ACTS-HORIZON/Atlas.git /opt/atlas
```

If the repo is private, git asks for a username and password. Give your GitHub username and, as the password, a fine-grained personal access token with read-only *Contents* access to this repo. To pin to a branch that isn't merged yet, run `git -C /opt/atlas checkout <branch>`.

```bash
chown -R atlas:atlas /opt/atlas
```

**3. Body** (as `atlas`). The install pulls Mineflayer 4.39 and its dependencies from npm. The tests need no server.

```bash
su - atlas -c 'cd /opt/atlas/body && npm ci && npm test'
```

**4. Mind:**

```bash
su - atlas -c 'cd /opt/atlas/mind && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt'
```

**5. Config.** The defaults are `localhost:25565`, username `Atlas` and the link on `127.0.0.1:8765`, which already fit this LXC. To change them:

```bash
su - atlas -c 'cp /opt/atlas/atlas.env.example /opt/atlas/atlas.env && nano /opt/atlas/atlas.env'
```

Every setting is an environment variable (`ATLAS_MC_HOST`, `ATLAS_MC_PORT`, `ATLAS_USERNAME`, …). `atlas.env` is read by both `npm start` and the systemd unit, and real environment variables override it.

**6. Minecraft server checks** (`server.properties`):
- `online-mode=false`, so offline auth works.
- Don't op Atlas. If `white-list=true`, add it with `whitelist add Atlas` from the server console.
- `view-distance` together with `ATLAS_SIGHT_RADIUS` (default 64) sets how far Atlas can see.

## Run

The Proxmox console gives you one terminal, so the body and mind run in a tmux session called `atlas`, as the `atlas` user (or run the body under systemd, below).

**Start the session** (as root):

```bash
su - atlas -c 'tmux new -d -s atlas'
```

**Attach to it later:**

```bash
su - atlas -c 'tmux attach -t atlas'
```

**Body** (tmux window 1):

```bash
cd /opt/atlas/body && npm start
```

You should see `[link] listening…`, `[bot] spawned in overworld at … gamemode=…`, `[bot] ready: health 20, food 20` and `[obs] first build N ms`. After that it prints build-time stats every 60 s.

**Mind** (tmux window 2, `Ctrl-b c`), once the `ATLAS_LLM_*` settings are in `atlas.env` (see [Mind (brain v0)](#mind-brain-v0)):

```bash
cd /opt/atlas/mind && .venv/bin/python -m atlas_mind
```

It prints one line per decision (`[mind] call: <thinking>`). The dashboard's Trace feed shows the same reasoning.

**Terminal client** (tmux window 3), to watch every message and to issue verbs by hand:

```bash
cd /opt/atlas/mind && .venv/bin/python -m atlas_mind.client
```

Both can be connected at once. A verb you type while the mind's verb is running gets `refused — busy`. Type `say hello`, `goto 10 64 -20`, `explore north 48`, `mine coal_ore 3`, `collect oak_log`, `craft oak_planks 4`, `place cobblestone 3 64 -2`, `equip iron_pickaxe`, `dig 3 63 -2`, `eat`, `stop`, `recall iron_ore`, `trace plan get iron first`, `obs`, or `quit`. Add `--json` to see raw messages instead of the summary.

**Logs:**

```bash
tail -f /opt/atlas/logs/link-$(date -u +%F).jsonl
```

### Dashboard

The body serves a read-only dashboard on `ATLAS_DASH_BIND` (default `0.0.0.0:8080`). Open `http://10.0.0.52:8080/` in a browser on your LAN.

- **Data source:** a read-only tap of the link. Every `obs`, `call`, `result`, `event`, `trace` and `observe` crossing it is pushed to the page as-is, and recent messages are replayed when the page connects.
- **What reaches the page:**
  - Tap messages are copied through JSON and must validate against the contract schemas; anything else is dropped. Raw Mineflayer objects and hidden entity state can't reach the page.
  - The rest comes from read-only `GET /api/*` endpoints: known places, verb library, config with secrets masked, and the log tail.
- **Panels:**
  - vitals, inventory and world
  - blocks seen, entities, players and sounds
  - current task with its verb and progress, plus the last calls
  - events, chat and the trace feed
  - known places: the count and the 10 nearest to the bot
  - verb library: built-in or live-written; click a verb to see its source
  - config as loaded
  - live log tail
  - placeholders for reflexes and advisor calls, marked "not wired yet"
- **The one control: STOP.** It calls the body's stop path directly (`POST /api/stop`), not through the mind. The running verb returns `interrupted`, movement controls are released, and the mind gets a `stop_requested` event with `{"from": "dashboard"}`. Every other endpoint is read-only and answers `405` to writes.
- **No authentication.** Anyone who can reach the port can watch, which includes chat and coordinates, and can press STOP. On a shared network, set `ATLAS_DASH_BIND=127.0.0.1:8080` and reach it through Proxmox, or firewall the port. Set it to `off` to disable the dashboard.
- **Without a mind:** obs still flow to the dashboard every 2 s, but they aren't logged, because nothing crossed the link.

## Mind (brain v0)

`python -m atlas_mind` runs the loop from CONTRACT.md's Mind loop.

**What it does each turn:**
- **Wakes** on a result, an event, or the idle timer (`ATLAS_IDLE_S`, 10 s). Idle wakes are skipped while a verb runs, and while it waits for an answer to `ask_player`.
- **Builds the context:**
  - a **system prompt**: who Atlas is, fair play, house rules, no fighting, no smelting yet, and the output format, plus `docs/verbs.md` loaded from the repo at start, so it is never stale;
  - the **task list**;
  - the **latest obs**, rendered compactly (a few hundred tokens, not raw JSON);
  - the **last 15** calls, results and events;
  - the **notes**.
- **Asks the model for one JSON object:**
  - **`call`**: `{verb, args}`
  - **`say`**: `{text}`
  - **`ask_player`**: `{player, text}`. It says the question, then waits for that player's `player_said` (or `ASK_TIMEOUT`), then decides again.
  - **`note`**: `{text}`, appended to `data/notes.md`.
  - **`wait`**
  Every action carries `thinking`, sent first as a `trace` (kind `decision`).
- **Updates tasks:** any action may also carry `task: {id, state, standing}`. Tasks come from `task_from_chat` events, and the model decides order and interleaving. It's told to confirm a task in chat before starting it and to report when it's done. Standing tasks stay until stopped. `@Atlas stop` (the body's stop) marks the active task `stopped`, and `@Atlas stop <task>` lets the model drop that task.

**Guards in code, not left to the model:**
- **Invalid replies:** a reply that isn't one valid JSON object (or names an unknown verb, or a bad task state) is retried once, with the error shown to the model; after that it waits.
- **No repeating a failure:** the exact call that just failed or was refused is not sent again; the model is told so and asked once more.
- **No fighting:** the prompt forbids it (there are no combat verbs). When health falls below `ATLAS_RETREAT_HEALTH` (6), the mind is woken with "health is low", and may retreat with `goto`.

**Config** (in `atlas.env` or the environment):

| Variable | Default | |
|---|---|---|
| `ATLAS_LLM_URL` | `http://127.0.0.1:8080/v1` | OpenAI-compatible base URL (`…/chat/completions` is appended) |
| `ATLAS_LLM_MODEL` | `gemma` | model name sent in the request |
| `ATLAS_LLM_KEY` | — | sent as `Authorization: Bearer …` if set |
| `ATLAS_LLM_TEMPERATURE` | `0.4` | |
| `ATLAS_LLM_MAX_TOKENS` | `600` | |
| `ATLAS_LLM_JSON_MODE` | `1` | sends `response_format: {"type": "json_object"}`; set `0` if the server rejects it |
| `ATLAS_LLM_TIMEOUT_S` | `120` | |
| `ATLAS_IDLE_S` | `10` | idle wake |
| `ATLAS_ASK_TIMEOUT_S` | `120` | how long `ask_player` waits for an answer |
| `ATLAS_RETREAT_HEALTH` | `6` | |
| `ATLAS_NOTES_FILE` | `data/notes.md` | |
| `ATLAS_NOTES_MAX_LINES` | `80` | the oldest notes are dropped (and counted) past this |

**The prompt.** To see the system prompt:

```bash
cd /opt/atlas/mind && .venv/bin/python -m atlas_mind --print-prompt
```

It is about 3,300 tokens, most of it the verb reference. Each turn adds a context like this one (fresh spawn, first wake):

```
WOKE BECAUSE: new task t1 from ACTS_HORIZON: get me 3 iron ingots

TASKS
t1 [new] from ACTS_HORIZON: get me 3 iron ingots

OBSERVATION
t=2410 survival in overworld at (0.5, 64, 0.5), facing yaw 0
health 20/20, food 20/20, xp 0, holding nothing
world: day, clear, light 15, biome plains
inventory: empty
blocks seen: oak_log x2 (nearest (12, 64, -3) 11.2m); water x1 (nearest (-6, 62, 9) 11.4m)
entities: sheep 7.2m front-left
player ACTS_HORIZON 3.9m at (3.4, 64, -2.1), looking at (3, 63, -1)
running verb: none
chat <ACTS_HORIZON> @Atlas get me 3 iron ingots

RECENT (oldest first)
event task_from_chat: {"from":"ACTS_HORIZON","text":"get me 3 iron ingots"}

NOTES
(no notes yet)

Decide the next action. One JSON object.
```

**Prompt tuning offline.** `--replay` feeds recorded link logs through the same state and context, asks the real model, and prints each decision; nothing is sent to a body.

```bash
cd /opt/atlas/mind && .venv/bin/python -m atlas_mind --replay ../logs/link-2026-11-03.jsonl --every 15 --limit 10 --show-prompt
```

It decides on every recorded result and event, plus every 15th obs.

**Tests** (no server, no model) drive the mind against a fake body speaking the real link protocol, with a scripted `FakeLLM` (`mind/tests/test_mind.py`). They cover:
- a task through confirm, a chain of calls, and the done report;
- a failed call not being repeated;
- the `ask_player` round trip and its timeout;
- stop clearing the task;
- the invalid-reply retry;
- the low-health wake;
- replay.

### Optional: body as a systemd service

```bash
cp /opt/atlas/deploy/systemd/atlas-body.service /etc/systemd/system/
```

```bash
systemctl daemon-reload && systemctl enable --now atlas-body
```

```bash
journalctl -u atlas-body -f
```

The mind loop has an example unit too, `deploy/systemd/atlas-mind.service`; install it the same way. The terminal client (`python -m atlas_mind.client`) is interactive and gets no unit.

### Update

Pulling also installs new dependencies; session 2 adds mineflayer-pathfinder.

```bash
su - atlas -c 'cd /opt/atlas && git pull && cd body && npm ci'
```

Then restart the body. In tmux, press `Ctrl-c` in window 1 and run `npm start` again. Under systemd:

```bash
systemctl restart atlas-body
```

## Checking it on atlas (session 1)

1. **Joins and stays connected.** Atlas appears in the tab list. The body log shows no repeated `disconnected` lines.
2. **Line of sight.** Join from your client and stand in front of Atlas: the mind shows `player <you> at (...)`. Step behind a wall or hill: you disappear from `players` within 2 s. Look at a block that Atlas can also see: `looking at (x, y, z)` matches the block you're aiming at (F3 → *Targeted Block*). Look at a block that is hidden from Atlas: `looking at -`.
3. **No x-ray.** From your own client (you can be op; Atlas is not), bury an ore a few blocks under Atlas, for example with `/execute at Atlas run setblock ~ ~-3 ~ diamond_ore`, or `/tp Atlas` above a known vein. The ore never shows in `blocks seen`. Dig down to it from Atlas's side so a face is exposed toward Atlas, and it appears within 2 s.
4. **`say hello`** shows up in game chat, and the mind prints `result c1: done`.
5. **Known places:** let Atlas see an ore or chest, then `recall iron_ore` (or `chest`) returns its position. Restart the body; `[places] N known places` shows they were reloaded, and `recall` still finds them. An ore buried out of Atlas's sight never comes back from `recall`.
6. **Logs fill:** `logs/link-*.jsonl` grows by one obs every 2 s while the mind is connected.
7. **Dashboard:** open `http://10.0.0.52:8080/`. The tap pill shows *live*, and the obs panels update every 2 s. Type `trace plan test` in the mind: it shows in the trace feed. Press STOP: the events feed shows `stop_requested`.
8. **Build time:** read `[obs] build time over last N: mean … p95 …` in the body output or `journalctl`.

## Session 2 live checklist (atlas)

Run these in order, in the dev world, with your client next to Atlas and the dashboard open at `http://10.0.0.52:8080/`. Give Atlas items by tossing them (Q) near it, then `collect`.

1. **Update and restart.** Run the update steps above.
   - **Body log:** `[bot] ready: health …, food …` comes *before* `[obs] first build`, and there's no `[tap] dropped` line.
   - **Dashboard:** the Self panel fills on the first obs, with numbers, not dashes.
2. **Obs cost.** Stand Atlas in the same spruce forest as before. After a minute, read `[obs] build time over last N` in the body log.
   - **Expect:** well under the earlier 64–72 ms mean (the benchmark says roughly 4–5× lower once warm). The first build after spawn is still the slow one.
3. **`goto` a position.** About 10 blocks away on open ground, type `goto <x> <y> <z>` in the mind.
   - **Task panel:** `goto` with `to [x, y, z]: N blocks left`, counting down.
   - **Result:** `done — arrived at [...]`.
4. **`goto` you, then refused.** In view, `goto ACTS_HORIZON`: it walks to within 2 blocks. Step behind a wall and try again.
   - **Result:** `refused — fair play: ACTS_HORIZON has not been observed…`, and it doesn't move.
5. **`goto` failures.**
   - **No path:** a position inside a sealed stone box gives `failed — no path to [...]`.
   - **Gives up:** a reachable-looking spot it can't get to (a pillar top) gives `partial — gave up N blocks short (stuck)` after about 15 s.
6. **STOP during `goto`.** Start a long `goto` (about 60 blocks) and press STOP on the dashboard.
   - **In game:** Atlas halts at once.
   - **Dashboard:** Last calls shows `interrupted — goto: stopped by dashboard (at: …)`, and Events shows `stop_requested`.
7. **Busy.** During a long `goto`, `say on my way` works, but `mine coal_ore 1` gives `refused — busy`, and the `goto` keeps going.
8. **`explore north 48`.**
   - **Task panel:** `north: 16/48 blocks, N notable blocks seen`. Atlas pauses every 16 blocks and looks left and right.
   - **Result:** `done — walked 48 blocks north; saw spruce_log …; K new known places`.
   - **Known places:** the count went up.
9. **`collect`.** Toss 3 oak logs near Atlas, then `collect oak_log`.
   - **Result:** it walks over them, the inventory panel shows `oak_log 3`, and the result is `done — collected 3 oak_log; none left in sight`.
   - **Behind a wall:** toss one behind a wall instead. It isn't fetched; `no oak_log drops in sight`.
10. **`mine`, missing tool.** With no pickaxe, `mine iron_ore 1` gives `failed — mine: iron_ore needs one of: stone_pickaxe, …`, before it moves.
11. **`mine stone 3`** without a pickaxe gives `failed — mine: stone needs one of: wooden_pickaxe, …`. (Before session 3 this was refused; stone visible in the terrain now counts as seen.)
12. **`mine` seen ore.** Toss Atlas an iron pickaxe, then `collect iron_pickaxe`. With exposed coal in view, `mine coal_ore 3`.
    - **Task panel:** `1/3 coal_ore: digging [...]`.
    - **Result:** the coal leaves Blocks seen, the inventory shows coal, and the result is `done — mined 3 coal_ore`, or `partial — mined N of 3; none left within 32 blocks`.
    - **Slow digs are expected:** prismarine-block's 26.1 data gives ores a 4.5 s dig time with any pickaxe, and Mineflayer waits that long.
13. **Strip-mine.**
    - **Setup:** take Atlas below ground in a 1×2 pocket in stone, holding a pickaxe; `/tp Atlas` is yours to run. Then `mine diamond_ore 1`.
    - **Task panel:** shows `tunnel N`. The tunnel runs 24 blocks straight, turns right, goes 3 across, turns right again and runs back.
    - **Stops:** it stops with `partial — … strip-mining stopped: lava ahead` (or similar) when lava shows. Press STOP mid-tunnel: digging stops immediately and you get `interrupted`.
14. **Logs.** `logs/link-*.jsonl` has every call and result. Each result's `data` is under the result in Last calls.

## Session 3 live checklist, part A: body (atlas)

Set `ATLAS_PLAYERS=ACTS_HORIZON` in `atlas.env` first. Optionally protect a small test box, for example:

```bash
ATLAS_PROTECTED_REGIONS='[{"name":"test","from":[100,60,100],"to":[110,80,110]}]'
```

Restart the body after changing either.

1. **Chat.**
   - `@Atlas status` gets a chat reply like `status: idle | health 20 food 20 | at …`.
   - `@Atlas hello there`: the dashboard Events feed shows `task_from_chat {"from":"ACTS_HORIZON","text":"hello there"}`.
   - Plain `hi` shows `player_said`.
   - A second, non-allowlisted account's chat shows only in the Chat panel, with no event.
2. **`@Atlas come here`** in view: Atlas walks to you, and Events shows `verb_done {…"by":"chat"}`. Out of view, it says `I can't see you, ACTS_HORIZON`, because the Locator Bar isn't available yet.
3. **`@Atlas stop`** during a long `goto`: Atlas halts and replies `stopped goto`, and Events shows `stop_requested`.
4. **`goto` with digging and pillaring.**
   - `goto <x y z>` to a spot behind a 3-block wall: it tunnels through.
   - A spot 4 blocks up a cliff, with cobblestone in the inventory: it pillars.
   - `goto <x y z> nodig noscaffold` (same spots) gives `partial` or `failed`.
5. **Protected region.** Stand Atlas next to the test box.
   - `dig <x y z>` on a block inside gives `refused — house rules: no dig inside protected region "test" …`.
   - `place cobblestone <inside>` gives the same refusal.
   - A `goto` whose shortest path tunnels through the box walks around it, or gives `partial`/`failed`; it never digs inside.
6. **`mine stone 3`** with a wooden pickaxe, standing on stone. It mines 3 visible stone, and the inventory shows cobblestone. Without a pickaxe: `failed — mine: stone needs one of: wooden_pickaxe, …`.
7. **`craft`.** With 2 oak_log in the inventory:
   - `craft oak_planks 8` gives `done — crafted 8 oak_planks`.
   - `craft crafting_table` gives `done`.
   - `craft wooden_pickaxe` with no table seen gives `failed — craft: wooden_pickaxe needs crafting_table nearby …`.
   - Place the table (`place crafting_table x y z` next to Atlas), then `craft stick 4`, then `craft wooden_pickaxe`. It walks to the table and gives `done`.
   - `craft stone_pickaxe` with no cobblestone gives `failed — craft: missing 3 of cobbled_deepslate, blackstone or cobblestone for 1 stone_pickaxe`.
8. **`equip wooden_pickaxe`**, then **`dig`** a visible block: done. A buried block's coordinates: `refused — fair play`.
9. **`eat`.** At full food: `failed — eat: not hungry (food 20/20)`. After sprinting a while, toss Atlas bread and `collect bread`; then `eat` gives `done — ate bread; food 14 → 19`.

## Session 3 live checklist, part B: the mind (atlas)

**Setup:**
- Point `ATLAS_LLM_URL` and `ATLAS_LLM_MODEL` at the Gemma server, and set `ATLAS_PLAYERS=ACTS_HORIZON`.
- Start the body, then the mind (tmux window 2), and open the dashboard. Its Trace feed shows the mind's `thinking` for every turn.
- Start with a **fresh spawn**: new world, or Atlas with an empty inventory.

**The run:** say `@Atlas get me 3 iron ingots` and don't help. Nothing below is scripted; it's what a sensible plan looks like and what to check for. The exact order and wording will vary.

| Step | Trace feed (thinking, roughly) | Calls and results to expect |
|---|---|---|
| 1. Confirm | "Collin wants 3 iron ingots. I have nothing; I need a pickaxe chain first. Confirm." (A careful model may already mention smelting here and ask; that's fine too.) | `say "On it: …"`; task t1 → active |
| 2. Wood | "Logs are in view; mine some." If none are in view: "No trees in sight; explore." | `mine oak_log 4` → done (or `explore …` first) |
| 3. Planks | "Turn the logs into planks." | `craft oak_planks 12` → done |
| 4. Table | "I need a crafting table; craft and place one." | `craft crafting_table` → done, then `place crafting_table [x,y,z]` next to it → done |
| 5. Sticks and pickaxe | "Sticks, then a wooden pickaxe at the table." | `craft stick 4`, `craft wooden_pickaxe` → walks to the table → done |
| 6. Stone | "Stone pickaxe needs cobblestone; mine visible stone." If none is visible: "No stone in view; dig down or explore." | `mine stone 3` → done (cobblestone in the inventory), or `failed — no stone in view` and then a reasoned move |
| 7. Stone pickaxe | "Now a stone pickaxe." | `craft stone_pickaxe` → done |
| 8. Iron | "Iron ore next; none in view, so strip-mine." | `mine iron_ore 3`: the Task panel shows `tunnel N`; done (raw_iron 3) or partial |
| 9. The wall | "Iron ingots need smelting and I have no smelt verb. I'll tell Collin and ask." | `ask_player ACTS_HORIZON "I have 3 raw iron but can't smelt yet. Want the raw iron, or should I wait?"`; the mind goes quiet until you answer |
| 10. Your answer | `player_said` arrives; "Collin wants the raw iron; …" | a reasoned next step (no `give` verb yet either, so expect it to say so) |

**What to watch for:**
- **Recovering from failure:** after a `failed` result (e.g. `craft: wooden_pickaxe needs crafting_table nearby`), the next trace deals with the reason. The same call never comes straight back; if the model tries, the trace shows the retry or "no usable decision".
- **No busy collisions:** no `refused — busy` in Last calls from the mind itself, because it only acts after each result.
- **Stop:** `@Atlas stop` mid-chain. Atlas halts, and the next trace mentions the stop, with task t1 `stopped`.
- **Notes:** it may `note` things like where it put the table. They're in `data/notes.md` and in the next turns' context.
- **Cost:** while idle with no tasks, expect a `wait` decision about every 10 s (one model call each).

## Development

```bash
cd body && npm test
```

The fair-play, adapter, link, runner, verb and dashboard tests run without a Minecraft server: the verb tests use the real filtered API over a fake world with a fake motor, and the dashboard tests drive a real Body with a fake bot. Movement itself is covered by the live checklist.

```bash
cd body && npm run bench
```

The benchmark measures obs build time (plus known-places upkeep) on synthetic 26.1 chunks.

```bash
cd body && npm run bench:forest
```

The forest benchmark is a dense spruce forest over cave-riddled stone. It prints an output checksum, so a speed change can be shown not to change what is observed.

```bash
cd mind && .venv/bin/python -m unittest discover -s tests
```

The mind tests need no server and no model: a fake body over the real link protocol and a scripted `FakeLLM`.
