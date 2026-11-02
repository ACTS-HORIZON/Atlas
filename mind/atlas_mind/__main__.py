"""Terminal client for the Atlas link.

    python -m atlas_mind [--url ws://127.0.0.1:8765] [--json]

Prints every message from the body. Type:
    say <text>    chat as the bot
    stop          cancel the current verb
    recall <type> [x y z]   nearest known place of that type
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

HELP = "commands: say <text> | stop | recall <type> [x y z] | trace [kind] <text> | obs | quit"
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
    ap = argparse.ArgumentParser(prog="atlas_mind", description="Atlas link terminal client")
    ap.add_argument("--url", default=default_url(), help="body link URL (default from ATLAS_LINK_HOST/PORT, else ws://127.0.0.1:8765)")
    ap.add_argument("--json", action="store_true", help="print raw JSON instead of the summary")
    a = ap.parse_args()
    try:
        asyncio.run(main(a.url, a.json))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    cli()
