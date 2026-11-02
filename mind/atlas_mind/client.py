"""Terminal client for the Atlas link.

    python -m atlas_mind.client [--url ws://127.0.0.1:8765] [--json]

Prints every message from the body. Type:
    say <text>    chat as the bot
    stop          cancel the current verb
    recall <type> [x y z]   nearest known place of that type
    goto <x> <y> <z> [nodig] [noscaffold]   walk there (tunnels and pillars unless told not to)
    goto <target>           walk to an observed player, entity type or block type
    explore <dir> <n>       walk n blocks (north, south-east, ..., forward) and report
    mine <block> <n> [radius]   mine n observed blocks (strip-mines if none seen)
    collect <item>          pick up visible drops of that item
    craft <item> [n]        craft (2x2, or at a crafting table it has seen)
    place <block> <x> <y> <z>   place a block next to Atlas
    equip <item> [slot]     hand, off-hand, head, torso, legs, feet
    dig <x> <y> <z>         dig one observed block
    eat [item]              eat (best food if none named)
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
import sys
import threading

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from . import CONTRACT_VERSION
from .pretty import format_message

HELP = ("commands: say <text> | stop | recall <type> [x y z] | goto <x y z | target> | explore <dir> <n> |"
        " mine <block> <n> [radius] | collect <item> | craft <item> [n] | place <block> <x y z> | equip <item> [slot] |"
        " dig <x y z> | eat [item] | trace [kind] <text> | obs | quit")
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
        pos = ints(parts[1:]) if len(parts) == 4 else None
        if not pos:
            return "usage: place <block> <x> <y> <z>"
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
    if cmd == "eat":
        if len(parts) > 1:
            return "usage: eat [item]"
        return call("eat", {"item": parts[0]} if parts else {})
    if cmd == "explore":
        if len(parts) != 2 or parts[0] not in DIRECTIONS or not parts[1].isdigit():
            return "usage: explore <" + "|".join(DIRECTIONS) + "> <blocks>"
        return call("explore", {"direction": parts[0], "distance": int(parts[1])})
    if cmd == "mine":
        if len(parts) not in (2, 3) or not all(p.isdigit() for p in parts[1:]):
            return "usage: mine <block> <count> [radius]"
        args = {"block": parts[0], "count": int(parts[1])}
        if len(parts) == 3:
            args["radius"] = int(parts[2])
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
    if cmd in ("quit", "exit"):
        return "quit"
    return HELP


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
