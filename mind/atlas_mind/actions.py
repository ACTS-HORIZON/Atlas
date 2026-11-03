"""The model's output: exactly one JSON object per turn.

{"thinking": "...", "action": "call", "verb": "mine", "args": {...}, "about": "t1"}
{"thinking": "...", "action": "say", "text": "...", "about": "t1"}            # e.g. confirming t1
{"thinking": "...", "action": "say", "text": "...", "closes": "t1"}           # the reply that finishes t1
{"thinking": "...", "action": "ask_player", "player": "Name", "text": "...", "about": "t1"}
{"thinking": "...", "action": "note", "text": "..."}
{"thinking": "...", "action": "done", "closes": "t1"}                         # finish t1 without chat
{"thinking": "...", "action": "wait"}
{"thinking": "...", "action": "plan", "about": "t1", "steps": [{"verb": "craft", "args": {...}}, ...]}  # up to 6 calls
{"thinking": "...", "action": "lookup", "query": "iron ore y level", "about": "t1"}  # the wiki; answer next turn

"about" ties an action to a task; "closes" finishes one; "standing": true
marks the task it is about as standing (re-planned until stopped).
The reply may be wrapped in prose or code fences: the first complete JSON
object with an "action" is used."""
from __future__ import annotations

import json

ACTIONS = ("call", "say", "ask_player", "note", "done", "wait", "plan", "lookup")
MAX_PLAN = 6


class ActionError(ValueError):
    pass


def _objects(text: str):
    """Yield (start, end) of every balanced {...} in text, outermost first (string-aware)."""
    i = 0
    n = len(text)
    while i < n:
        if text[i] != "{":
            i += 1
            continue
        depth, in_str, esc = 0, False, False
        for j in range(i, n):
            ch = text[j]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            elif ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    yield i, j + 1
                    break
        else:
            i += 1  # never closed from here: try the next brace
            continue
        i = j + 1


def extract_json(text: str) -> dict:
    """The first complete JSON object in the reply that has an "action" (or
    else the first complete object). Prose, code fences and trailing text
    around it are ignored."""
    first = None
    for a, b in _objects(text):
        try:
            obj = json.loads(text[a:b])
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            if "action" in obj:
                return obj
            first = first or obj
    if first is not None:
        return first
    if "{" in text:
        raise ActionError("the reply was cut off before its JSON object closed")
    raise ActionError("no JSON object in the reply")


def validate(obj: dict, verbs: set[str] | None = None) -> dict:
    """Check the shape; returns a normalised action dict or raises ActionError."""
    a = obj.get("action")
    if a not in ACTIONS and verbs is not None and isinstance(a, str) and a in verbs:
        # {"action": "craft", "args": {...}} (or the args inline): a call to that verb
        args = obj.get("args")
        if not isinstance(args, dict):
            args = {k: v for k, v in obj.items() if k not in ("thinking", "action", "verb", "args", "about", "closes", "standing")}
        obj = {**obj, "action": "call", "verb": a, "args": args}
        a = "call"
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
    elif a == "plan":
        steps = obj.get("steps")
        if not isinstance(steps, list) or not 1 <= len(steps) <= MAX_PLAN:
            raise ActionError(f'"plan" needs "steps": a list of 1 to {MAX_PLAN} calls')
        norm = []
        for i, st in enumerate(steps, 1):
            if not isinstance(st, dict) or not isinstance(st.get("verb"), str) or not st["verb"]:
                raise ActionError(f'plan step {i} needs "verb"')
            if verbs is not None and st["verb"] not in verbs:
                raise ActionError(f'plan step {i}: unknown verb "{st["verb"]}"; known: {", ".join(sorted(verbs))}')
            args = st.get("args", {})
            if not isinstance(args, dict):
                raise ActionError(f'plan step {i}: "args" must be an object')
            norm.append({"verb": st["verb"], "args": args})
        out["steps"] = norm
    elif a == "lookup":
        q = obj.get("query")
        if not isinstance(q, str) or not q.strip():
            raise ActionError('"lookup" needs "query": what to look up on the Minecraft wiki')
        out["query"] = " ".join(q.split())[:200]
    elif a == "ask_player":
        player, text = obj.get("player"), obj.get("text")
        if not isinstance(player, str) or not player or not isinstance(text, str) or not text.strip():
            raise ActionError('"ask_player" needs "player" and "text"')
        out.update(player=player, text=text.strip())
    for k in ("about", "closes"):
        v = obj.get(k)
        if v is not None:
            if not isinstance(v, str) or not v:
                raise ActionError(f'"{k}" must be a task id like "t1"')
            out[k] = v
    if a == "done" and "closes" not in out:
        raise ActionError('"done" needs "closes": the task id it finishes')
    if "closes" in out and a not in ("say", "done"):
        raise ActionError('"closes" goes on a say (the reply that finishes the task) or a done')
    if "standing" in obj:
        if not isinstance(obj["standing"], bool):
            raise ActionError('"standing" must be true or false')
        out["standing"] = obj["standing"]
    return out


def parse(text: str, verbs: set[str] | None = None) -> dict:
    return validate(extract_json(text), verbs)
