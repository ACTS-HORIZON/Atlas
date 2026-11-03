"""--replay: feed recorded link logs (logs/link-*.jsonl) through the mind's
state and ask the real model what it would do, without a body. For tuning
the prompt offline: nothing is sent anywhere."""
from __future__ import annotations

import json
from pathlib import Path

from .loop import Mind
from .render import history_line


async def replay(mind: Mind, files: list[str], every: int = 15, limit: int = 10, show_prompt: bool = False, out=print) -> int:
    n_obs = 0
    decided = 0
    for f in files:
        for line in Path(f).read_text(encoding="utf-8").splitlines():
            try:
                e = json.loads(line)
                msg = e["msg"]
            except (ValueError, KeyError):
                continue
            if e.get("dir") == "in":  # what the mind sent: keep calls in the history, skip the rest
                if msg.get("type") == "call":
                    mind.pending[msg["id"]] = msg
                    mind.recent.append(history_line("call", msg))
                continue
            mind.handle(msg)
            if msg.get("type") == "obs":
                n_obs += 1
            trigger = msg.get("type") in ("result", "event") or (msg.get("type") == "obs" and n_obs % every == 0)
            if not trigger:
                continue
            reasons = []
            while not mind.wakes.empty():
                reasons.append(mind.wakes.get_nowait())
            reason = "; ".join(reasons) or "idle"
            a = await mind.decide(reason)
            if show_prompt:
                out("=" * 72 + "\n" + mind.last_prompt[1]["content"])
            out(f"--- {e.get('ts', '')} woke: {reason}\n{json.dumps(a, indent=2)}")
            decided += 1
            if decided >= limit:
                return decided
    return decided
