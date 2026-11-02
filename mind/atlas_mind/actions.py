"""The model's output: exactly one JSON object per turn.

{"thinking": "...", "action": "call", "verb": "mine", "args": {...}}
{"thinking": "...", "action": "say", "text": "..."}
{"thinking": "...", "action": "ask_player", "player": "Name", "text": "..."}
{"thinking": "...", "action": "note", "text": "..."}
{"thinking": "...", "action": "wait"}

Any action may also carry "task": {"id": "t1", "state": "active|done|dropped|waiting",
"standing": true|false} to update the task list."""
from __future__ import annotations

import json
import re

ACTIONS = ("call", "say", "ask_player", "note", "wait")
TASK_STATES = ("active", "done", "dropped", "waiting")


class ActionError(ValueError):
    pass


def extract_json(text: str) -> dict:
    """Parse the reply; tolerate a ```json fence or prose around one object."""
    t = text.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", t, re.S)
    if fence:
        t = fence.group(1)
    try:
        obj = json.loads(t)
    except json.JSONDecodeError:
        start, end = t.find("{"), t.rfind("}")
        if start < 0 or end <= start:
            raise ActionError("no JSON object in the reply")
        try:
            obj = json.loads(t[start:end + 1])
        except json.JSONDecodeError as e:
            raise ActionError(f"invalid JSON: {e}") from None
    if not isinstance(obj, dict):
        raise ActionError("the reply must be one JSON object")
    return obj


def validate(obj: dict, verbs: set[str] | None = None) -> dict:
    """Check the shape; returns a normalised action dict or raises ActionError."""
    a = obj.get("action")
    if a not in ACTIONS:
        raise ActionError(f'"action" must be one of {", ".join(ACTIONS)}')
    thinking = obj.get("thinking")
    if not isinstance(thinking, str) or not thinking.strip():
        raise ActionError('"thinking" must be a short non-empty string')
    out: dict = {"action": a, "thinking": thinking.strip()[:500]}
    if a == "call":
        verb = obj.get("verb")
        if not isinstance(verb, str) or not verb:
            raise ActionError('"call" needs "verb"')
        if verbs is not None and verb not in verbs:
            raise ActionError(f'unknown verb "{verb}"; known: {", ".join(sorted(verbs))}')
        args = obj.get("args", {})
        if not isinstance(args, dict):
            raise ActionError('"args" must be an object')
        out.update(verb=verb, args=args)
    elif a in ("say", "note"):
        text = obj.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ActionError(f'"{a}" needs "text"')
        out["text"] = text.strip()
    elif a == "ask_player":
        player, text = obj.get("player"), obj.get("text")
        if not isinstance(player, str) or not player or not isinstance(text, str) or not text.strip():
            raise ActionError('"ask_player" needs "player" and "text"')
        out.update(player=player, text=text.strip())
    task = obj.get("task")
    if task is not None:
        if not isinstance(task, dict) or not isinstance(task.get("id"), str):
            raise ActionError('"task" must be {"id": "t1", "state": ..., "standing": ...}')
        if "state" in task and task["state"] not in TASK_STATES:
            raise ActionError(f'task "state" must be one of {", ".join(TASK_STATES)}')
        if "standing" in task and not isinstance(task["standing"], bool):
            raise ActionError('task "standing" must be true or false')
        out["task"] = {k: task[k] for k in ("id", "state", "standing") if k in task}
    return out


def parse(text: str, verbs: set[str] | None = None) -> dict:
    return validate(extract_json(text), verbs)
