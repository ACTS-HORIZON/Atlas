# Atlas

A Minecraft agent. [`CONTRACT.md`](CONTRACT.md) is the spec every layer follows.

```
body/      Node: Mineflayer backend, fair-play observation builder, verbs, link server
mind/      Python: link client (this session: a terminal client, no LLM yet)
contract/  JSON Schema for the link messages (obs, call, result, event)
deploy/    example systemd unit
logs/      contract-message logs, JSONL (gitignored)
```

## What works so far

- **Body** joins as `Atlas` (offline auth) and reconnects if the server goes away. It never gets op, never runs commands and never changes its gamemode; it plays in whatever gamemode you set.
- **Link**: a WebSocket on `127.0.0.1:8765`. The body sends a full-view `obs` when the mind connects, when it is asked, and every 2 s. It accepts `call` for `say` and `stop`, answers each with a `result`, and emits `event`s for `died`, `respawned`, `player_joined` and `player_left`.
- **Fair-play observation** (`body/src/fairplay/`):
  - `blocks_seen`: notable types only. They must be within the sight radius and visible along a raycast from the eyes, where the first solid block wins. Nearest first, at most 48 blocks and at most 12 of any one type.
  - `entities` and `players`: only those in line of sight. No hidden state. A player's `looking_at` is filled only when the bot can see that block too.
  - `sounds`: type, bearing and near/mid/far only.
- **Logs**: every contract message in or out is appended to `logs/link-YYYY-MM-DD.jsonl` as `{"ts", "dir": "in"|"out", "msg"}`.
- **Mind**: `python -m atlas_mind` prints every message and takes `say <text>`, `stop`, `obs` and `quit`.

### Contract notes

- **Requesting an obs.** CONTRACT.md says the full view is sent "on request" but names no request message. The body accepts `{"type": "observe", "v": "0.1"}` (see `contract/observe.schema.json`, marked *proposed*). It is not in CONTRACT.md until you decide.
- **`say` and commands.** Text starting with `/` gets `refused`, because the bot never runs commands.
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

Type `say hello`, `stop`, `obs`, or `quit`. Add `--json` to see raw messages instead of the summary.

**Logs:**

```bash
tail -f /opt/atlas/logs/link-$(date -u +%F).jsonl
```

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
5. **Logs fill:** `logs/link-*.jsonl` grows by one obs every 2 s while the mind is connected.
6. **Build time:** read `[obs] build time over last N: mean … p95 …` in the body output or `journalctl`.

## Development

```bash
cd body && npm test
```

The fair-play, adapter and link tests run without a Minecraft server.

```bash
cd body && npm run bench
```

The benchmark measures obs build time on synthetic 26.1 chunks.

```bash
cd mind && .venv/bin/python -m unittest discover -s tests
```
