# Atlas

A Minecraft agent. [`CONTRACT.md`](CONTRACT.md) is the spec every layer follows.

```
body/      Node: Mineflayer backend, fair-play observation builder, verbs, link server, dashboard
mind/      Python: link client (this session: a terminal client, no LLM yet)
contract/  JSON Schema for the link messages (obs, call, result, event)
deploy/    example systemd unit
logs/      contract-message logs, JSONL (gitignored)
data/      known places file (gitignored)
```

## What works so far

- **Body** joins as `Atlas` (offline auth) and reconnects if the server goes away. It never gets op, never runs commands and never changes its gamemode; it plays in whatever gamemode you set.
- **Link**: a WebSocket on `127.0.0.1:8765`. The body sends a full-view `obs` when the mind connects, when it is asked, and every 2 s. It accepts `call` for `say`, `stop` and `recall`, answers each with a `result`, and emits `event`s for `died`, `respawned`, `player_joined`, `player_left` and `stop_requested`. It also accepts `trace` (the mind's reasoning), which it logs and never acts on.
- **Fair-play observation** (`body/src/fairplay/`):
  - `blocks_seen`: notable types only. They must be within the sight radius and visible along a raycast from the eyes, where the first solid block wins. Nearest first, at most 48 blocks and at most 12 of any one type. A pool is listed as water at its surface only.
  - Sight: glass, ice and water are transparent; leaves and lava block sight. The radius is `sight_radius` (`ATLAS_SIGHT_RADIUS`, default 64), never more than the server's or the bot's render distance.
  - `entities` and `players`: only those in line of sight. No hidden state. A player's `looking_at` is filled only when the bot can see that block too.
  - `sounds`: type, bearing and near/mid/far only.
- **Known places** (`body/src/places.js`): every notable block that has appeared in `blocks_seen` is remembered with position, dimension and last-seen game tick, saved at most every 10 s and on shutdown, and reloaded on start. The file is named after the configured server, `data/known-places.<host>_<port>.json` (e.g. `data/known-places.localhost_25565.json`), so the dev world and the co-op server never share one; `ATLAS_PLACES_FILE` overrides the name. The name comes from `ATLAS_MC_HOST` as written, so `localhost` and `127.0.0.1` give two files for the same server: pick one spelling and keep it. Nothing else can enter it. An entry is dropped when Atlas can see the spot again and the block is gone. `recall {type, near?}` returns the nearest one as `data: {type, pos, dist, age}`, or `failed` with detail `unknown`.
- **Logs**: every contract message in or out is appended to `logs/link-YYYY-MM-DD.jsonl` as `{"ts", "dir": "in"|"out", "msg"}`.
- **Verbs** run one at a time (`body/src/runner.js`), and the running one shows as `task` in the obs. `say`, `recall`, `inspect` and `stop` run alongside it. Any other call while a verb runs is `refused` with detail `busy`: it is not queued, and the running verb keeps going. `stop` aborts the running verb, so it returns `interrupted`, and releases every movement control.
- **Dashboard** at `http://<atlas>:8080/` (see below).
- **Mind**: `python -m atlas_mind` prints every message and takes `say <text>`, `stop`, `recall <type> [x y z]`, `trace [kind] <text>`, `obs` and `quit`.

### Contract notes

- **Requesting an obs**: the mind sends `{"type": "observe", "v": "0.1"}`.
- **`say`**: text starting with `/` gets `refused`, because the bot never runs commands.
- **`result.data`**: verbs that return information put it in `data` (only `recall` so far).
- **`trace`**: `data` is optional; `t` is the tick of the latest obs the mind has.
- **`obs: null`.** A `result` or `event` sent while the bot is not in the game carries `obs: null`.
- **Yaw and pitch** are in F3 degrees: yaw 0 is south and 90 is west; positive pitch looks down.

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

The Proxmox console gives you one terminal, so use `tmux` (or run the body under systemd, below).

**Body** (tmux window 1):

```bash
su - atlas -c 'cd /opt/atlas/body && npm start'
```

You should see `[link] listening…`, `[bot] spawned in overworld at … gamemode=…` and `[obs] first build N ms`. After that it prints build-time stats every 60 s.

**Mind** (tmux window 2, `Ctrl-b c`):

```bash
su - atlas -c 'cd /opt/atlas/mind && .venv/bin/python -m atlas_mind'
```

Type `say hello`, `stop`, `recall iron_ore`, `trace plan get iron first`, `obs`, or `quit`. Add `--json` to see raw messages instead of the summary.

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

The mind is interactive, so it stays a terminal program and gets no unit.

### Update

```bash
su - atlas -c 'cd /opt/atlas && git pull && cd body && npm ci'
```

```bash
systemctl restart atlas-body
```

If you run the body in tmux instead, restart it there.

## Checking it on atlas

1. **Joins and stays connected.** Atlas appears in the tab list. The body log shows no repeated `disconnected` lines.
2. **Line of sight.** Join from your client and stand in front of Atlas: the mind shows `player <you> at (...)`. Step behind a wall or hill: you disappear from `players` within 2 s. Look at a block that Atlas can also see: `looking at (x, y, z)` matches the block you're aiming at (F3 → *Targeted Block*). Look at a block that is hidden from Atlas: `looking at -`.
3. **No x-ray.** From your own client (you can be op; Atlas is not), bury an ore a few blocks under Atlas, for example with `/execute at Atlas run setblock ~ ~-3 ~ diamond_ore`, or `/tp Atlas` above a known vein. The ore never shows in `blocks seen`. Dig down to it from Atlas's side so a face is exposed toward Atlas, and it appears within 2 s.
4. **`say hello`** shows up in game chat, and the mind prints `result c1: done`.
5. **Known places:** let Atlas see an ore or chest, then `recall iron_ore` (or `chest`) returns its position. Restart the body; `[places] N known places` shows they were reloaded, and `recall` still finds them. An ore buried out of Atlas's sight never comes back from `recall`.
6. **Logs fill:** `logs/link-*.jsonl` grows by one obs every 2 s while the mind is connected.
7. **Dashboard:** open `http://10.0.0.52:8080/`. The tap pill shows *live*, and the obs panels update every 2 s. Type `trace plan test` in the mind: it shows in the trace feed. Press STOP: the events feed shows `stop_requested`.
8. **Build time:** read `[obs] build time over last N: mean … p95 …` in the body output or `journalctl`.

## Development

```bash
cd body && npm test
```

The fair-play, adapter, link, runner and dashboard tests run without a Minecraft server (the dashboard tests drive a real Body with a fake bot).

```bash
cd body && npm run bench
```

The benchmark measures obs build time (plus known-places upkeep) on synthetic 26.1 chunks.

```bash
cd mind && .venv/bin/python -m unittest discover -s tests
```
