"""Terminal client for the Atlas link.

    python -m atlas_mind.client [--url ws://127.0.0.1:8765] [--json]

Prints every message from the body. Type:
    say <text>    chat as the bot
    stop          cancel the current verb
    recall <type> [x y z]   nearest known place of that type
    goto <x> <y> <z> [nodig] [noscaffold]   walk there (tunnels and pillars unless told not to)
    goto <target>           walk to an observed player, entity type or block type
    explore <dir> <n>       walk n blocks (north, south-east, ..., forward) and report
    mine <block> <n> [radius] [y=<level>]   mine n observed blocks (strip-mines if none seen; y: staircase down first)
    collect <item>          pick up visible drops of that item
    craft <item> [n]        craft (2x2, or at a crafting table it has seen)
    smelt <item> [n] [fuel] smelt in a furnace it has seen (item: what to make or what to put in)
    place <block> [x y z]   place a block (without x y z: on a free spot next to Atlas)
    equip <item> [slot]     hand, off-hand, head, torso, legs, feet
    dig <x> <y> <z>         dig one observed block
    eat [item]              eat (best food if none named)
    give <item> <n> <player>        walk to a player and toss them items
    deposit <item> <x> <y> <z> [n]  put items in a chest (all if no n)
    withdraw <item> <x> <y> <z> [n] take from a chest given to Atlas
    play "<intent>" [seconds] [target]   hand the controls to the player loop with an intent
    player        the last 10 ticks of logs/player-<date>.jsonl (chosen, latency, effect)
    trace [kind] <text>     send a trace (kind: plan, decision, rag, verb_write,
                            advisor, note; default note); logged, never acted on
    obs           ask for a full view now
    quit
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
import sys
import threading
import time
from pathlib import Path

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from . import CONTRACT_VERSION
from .pretty import format_message

HELP = ("commands: say <text> | stop | recall <type> [x y z] | goto <x y z | target> | explore <dir> <n> |"
        " mine <block> <n> [radius] [y=<level>] | collect <item> | craft <item> [n] | smelt <item> [n] [fuel] | place <block> [x y z] | equip <item> [slot] |"
        " dig <x y z> | eat [item] | give <item> <n> <player> | deposit|withdraw <item> <x y z> [n] |"
        " play \"<intent>\" [seconds] [target] | player |"
        " trace [kind] <text> | obs | quit")
DIRECTIONS = ("north", "south", "east", "west", "north-east", "north-west", "south-east", "south-west", "forward")
TRACE_KINDS = ("plan", "decision", "rag", "verb_write", "advisor", "note")


def parse_command(line: str, next_id, now_t=lambda: 0) -> dict | None | str:
    """Turn a typed line into a contract message, 'quit', or an error string.

    now_t() gives the world tick of the latest obs, for trace messages."""
    line = line.strip()
    if not line:
        return None
    cmd, _, rest = line.partition(" ")
    if cmd == "say":
        if not rest.strip():
            return "usage: say <text>"
        return {"type": "call", "v": CONTRACT_VERSION, "id": next_id(), "verb": "say", "args": {"text": rest.strip()}}
    if cmd == "stop":
        return {"type": "call", "v": CONTRACT_VERSION, "id": next_id(), "verb": "stop", "args": {}}
    if cmd == "recall":
        parts = rest.split()
        if len(parts) not in (1, 4):
            return "usage: recall <type> [x y z]"
        args: dict = {"type": parts[0]}
        if len(parts) == 4:
            try:
                args["near"] = [float(v) for v in parts[1:]]
            except ValueError:
                return "usage: recall <type> [x y z]"
        return {"type": "call", "v": CONTRACT_VERSION, "id": next_id(), "verb": "recall", "args": args}
    def call(verb: str, args: dict) -> dict:
        return {"type": "call", "v": CONTRACT_VERSION, "id": next_id(), "verb": verb, "args": args}

    parts = rest.split()

    def ints(vals):
        try:
            return [int(v) for v in vals]
        except ValueError:
            return None

    if cmd == "goto":
        flags = {p for p in parts if p in ("nodig", "noscaffold")}
        parts = [p for p in parts if p not in flags]
        extra = {**({"dig": False} if "nodig" in flags else {}), **({"scaffold": False} if "noscaffold" in flags else {})}
        if len(parts) == 3:
            try:
                return call("goto", {"pos": [float(v) for v in parts], **extra})
            except ValueError:
                return "usage: goto <x> <y> <z> | goto <target> [nodig] [noscaffold]"
        if len(parts) == 1:
            return call("goto", {"target": parts[0], **extra})
        return "usage: goto <x> <y> <z> | goto <target> [nodig] [noscaffold]"
    if cmd == "craft":
        if len(parts) not in (1, 2) or (len(parts) == 2 and not parts[1].isdigit()):
            return "usage: craft <item> [count]"
        return call("craft", {"item": parts[0], **({"count": int(parts[1])} if len(parts) == 2 else {})})
    if cmd == "place":
        if len(parts) == 1:
            return call("place", {"block": parts[0]})
        pos = ints(parts[1:]) if len(parts) == 4 else None
        if not pos:
            return "usage: place <block> [<x> <y> <z>]"
        return call("place", {"block": parts[0], "pos": pos})
    if cmd == "equip":
        if len(parts) not in (1, 2):
            return "usage: equip <item> [hand|off-hand|head|torso|legs|feet]"
        return call("equip", {"item": parts[0], **({"slot": parts[1]} if len(parts) == 2 else {})})
    if cmd == "dig":
        pos = ints(parts) if len(parts) == 3 else None
        if not pos:
            return "usage: dig <x> <y> <z>"
        return call("dig", {"pos": pos})
    if cmd == "give":
        if len(parts) != 3 or not parts[1].isdigit():
            return "usage: give <item> <count> <player>"
        return call("give", {"item": parts[0], "count": int(parts[1]), "player": parts[2]})
    if cmd == "smelt":
        if not 1 <= len(parts) <= 3 or (len(parts) >= 2 and not parts[1].isdigit()):
            return "usage: smelt <item> [count] [fuel]"
        args = {"item": parts[0]}
        if len(parts) >= 2:
            args["count"] = int(parts[1])
        if len(parts) == 3:
            args["fuel"] = parts[2]
        return call("smelt", args)
    if cmd in ("deposit", "withdraw"):
        pos = ints(parts[1:4]) if len(parts) in (4, 5) else None
        if not pos or (len(parts) == 5 and not parts[4].isdigit()):
            return f"usage: {cmd} <item> <x> <y> <z> [count]"
        return call(cmd, {"item": parts[0], "chest": pos, **({"count": int(parts[4])} if len(parts) == 5 else {})})
    if cmd == "eat":
        if len(parts) > 1:
            return "usage: eat [item]"
        return call("eat", {"item": parts[0]} if parts else {})
    if cmd == "explore":
        if len(parts) != 2 or parts[0] not in DIRECTIONS or not parts[1].isdigit():
            return "usage: explore <" + "|".join(DIRECTIONS) + "> <blocks>"
        return call("explore", {"direction": parts[0], "distance": int(parts[1])})
    if cmd == "mine":
        ys = [p for p in parts if p.startswith("y=")]
        parts = [p for p in parts if not p.startswith("y=")]
        if len(parts) not in (2, 3) or not all(p.isdigit() for p in parts[1:]) or len(ys) > 1 \
                or (ys and not ys[0][2:].lstrip("-").isdigit()):
            return "usage: mine <block> <count> [radius] [y=<level>]"
        args = {"block": parts[0], "count": int(parts[1])}
        if len(parts) == 3:
            args["radius"] = int(parts[2])
        if ys:
            args["y"] = int(ys[0][2:])
        return call("mine", args)
    if cmd == "collect":
        if len(parts) != 1:
            return "usage: collect <item>"
        return call("collect", {"item": parts[0]})
    if cmd == "trace":
        kind, _, text = rest.strip().partition(" ")
        if kind not in TRACE_KINDS:
            kind, text = "note", rest.strip()
        if not text.strip():
            return "usage: trace [kind] <text>"
        return {"type": "trace", "v": CONTRACT_VERSION, "t": int(now_t()), "kind": kind, "text": text.strip(), "data": {}}
    if cmd == "obs":
        return {"type": "observe", "v": CONTRACT_VERSION}
    if cmd == "play":
        usage = 'usage: play "<intent>" [seconds] [target]'
        try:
            words = shlex.split(rest)
        except ValueError:
            return usage
        if not 1 <= len(words) <= 3 or not words[0].strip():
            return usage
        args = {"intent": words[0].strip()}
        if len(words) >= 2:
            try:
                secs = float(words[1])
            except ValueError:
                return usage
            if not 1 <= secs <= 1800:
                return usage
            args["budget"] = int(secs) if secs == int(secs) else secs
        if len(words) == 3:
            args["target"] = words[2]
        return call("play", args)
    if cmd == "player":
        return "player"
    if cmd in ("quit", "exit"):
        return "quit"
    return HELP


def player_tail(log_dir: Path, n: int = 10, day: str | None = None) -> str:
    """The last n ticks of logs/player-<day>.jsonl, one compact line each: time, mode, chosen, latency, effect."""
    day = day or time.strftime("%Y-%m-%d", time.gmtime())
    f = Path(log_dir) / f"player-{day}.jsonl"
    try:
        lines = f.read_text(encoding="utf-8").splitlines()[-n:]
    except OSError:
        return f"no player ticks today ({f})"
    out = []
    for line in lines:
        try:
            r = json.loads(line)
        except ValueError:
            continue
        flag = " TIMEOUT" if r.get("timed_out") else ""
        out.append(f"{str(r.get('ts', ''))[11:23]} {r.get('mode', '?'):7} {r.get('chosen', '?'):20} {r.get('latency_ms', '?'):>6} ms{flag}  {r.get('effect', '')}")
    return "\n".join(out) or f"no player ticks today ({f})"


def default_log_dir() -> Path:
    d = os.environ.get("ATLAS_LOG_DIR", "logs")
    return Path(d) if Path(d).is_absolute() else Path(__file__).resolve().parents[2] / d


def default_url() -> str:
    host = os.environ.get("ATLAS_LINK_HOST", "127.0.0.1")
    port = os.environ.get("ATLAS_LINK_PORT", "8765")
    return f"ws://{host}:{port}"


async def main(url: str, raw: bool) -> None:
    loop = asyncio.get_running_loop()
    lines: asyncio.Queue[str | None] = asyncio.Queue()

    def read_stdin() -> None:
        for line in sys.stdin:
            loop.call_soon_threadsafe(lines.put_nowait, line)
        loop.call_soon_threadsafe(lines.put_nowait, None)

    threading.Thread(target=read_stdin, daemon=True).start()
    counter = 0
    last_t = 0

    def next_id() -> str:
        nonlocal counter
        counter += 1
        return f"c{counter}"

    print(HELP)
    while True:
        try:
            async with connect(url, max_size=None) as ws:
                print(f"connected to {url}")

                async def reader() -> None:
                    nonlocal last_t
                    async for data in ws:
                        msg = json.loads(data)
                        obs = msg if msg.get("type") == "obs" else msg.get("obs")
                        if isinstance(obs, dict) and isinstance(obs.get("t"), int):
                            last_t = obs["t"]
                        print(json.dumps(msg, indent=2) if raw else format_message(msg), flush=True)

                async def writer() -> None:
                    while True:
                        line = await lines.get()
                        if line is None:
                            return
                        out = parse_command(line, next_id, lambda: last_t)
                        if out == "quit":
                            return
                        if out == "player":
                            print(player_tail(default_log_dir()))
                            continue
                        if isinstance(out, str):
                            print(out)
                        elif out:
                            await ws.send(json.dumps(out))
                            if out["type"] == "call":
                                print(f">> call {out['id']}: {out['verb']} {out['args'] or ''}".rstrip())
                            elif out["type"] == "trace":
                                print(f">> trace {out['kind']} t={out['t']}: {out['text']}")

                tasks = [asyncio.create_task(reader()), asyncio.create_task(writer())]
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
                if tasks[1] in done:  # user quit or stdin closed
                    return
        except (OSError, ConnectionClosed) as e:
            print(f"link down ({e.__class__.__name__}); retrying in 3 s", flush=True)
            await asyncio.sleep(3)


def cli() -> None:
    ap = argparse.ArgumentParser(prog="atlas_mind.client", description="Atlas link terminal client")
    ap.add_argument("--url", default=default_url(), help="body link URL (default from ATLAS_LINK_HOST/PORT, else ws://127.0.0.1:8765)")
    ap.add_argument("--json", action="store_true", help="print raw JSON instead of the summary")
    a = ap.parse_args()
    try:
        asyncio.run(main(a.url, a.json))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    cli()
