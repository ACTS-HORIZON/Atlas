"""The mind's task list.

States: new -> confirmed -> running -> done | stopped
- new: arrived from chat (task_from_chat).
- confirmed: the bot said something about it (a say with "about").
- running: the bot made a call for it.
- done: an action with "closes" finished it (the reply to a question, or
  the report after the work).
- stopped: "@<bot> stop" while it was confirmed or running.
A conversational message (a question, a greeting) is a task too: one reply
with "closes" finishes it. Standing tasks stay open until stopped.
Each task keeps what the bot already said about it, shown in the context.

Each task also keeps a journal: every call made for it with its status and a
one-line detail, and "ruled out" lines (a note with "about"). Open tasks show
it in the context, at most JOURNAL_LINES lines (older calls summarised).

Approaches: once a call for a task has failed, every call made for it counts
toward the approaches tried. An approach is the verb, what it was after
(block, item, player, "a position"), its method (dig/scaffold off, a target
y, a fuel) and the place it was made from (32x16x32 cells): goto toward three
spots from the same place is one approach; mining iron from two places is two."""
from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field

OPEN = ("new", "confirmed", "running")
JOURNAL_LINES = 15
MIN_APPROACHES = 3
TARGET_ARGS = ("block", "item", "player", "target", "type")
IGNORED_ARGS = ("count", "range", "radius", "near", "text")  # not a different approach
# failures that mean no verb can do it (or the player must decide): asking is fine at once
NO_VERB_RE = re.compile(r"not implemented|no verb|unknown verb|protected|house rules|not allowed|not yours|not on the allowlist", re.I)


def fine_key(verb: str, args: dict | None) -> str:
    """A call, ignoring how many: the "same call" for the differ-after-failure rule."""
    a = {k: v for k, v in (args or {}).items() if k != "count"}
    return verb + " " + json.dumps(a, sort_keys=True, separators=(",", ":"))


def approach_key(verb: str, args: dict | None, place) -> str:
    a = args or {}
    tgt = next((str(a[k]) for k in TARGET_ARGS if isinstance(a.get(k), str)), "a position" if "pos" in a else "")
    method = []
    for k, v in sorted(a.items()):
        if k in TARGET_ARGS or k in IGNORED_ARGS or k == "pos":
            continue
        if k == "y" and isinstance(v, (int, float)):
            v = int(v) // 16 * 16  # target levels 16 apart are different methods
        method.append(f"{k}={v}")
    cell = "" if place is None else " from " + ",".join(str(int(c)) for c in place)
    return " ".join(x for x in (verb, tgt, " ".join(method)) if x) + cell


def place_cell(pos) -> tuple | None:
    if not pos:
        return None
    return (int(pos[0] // 32), int(pos[1] // 16), int(pos[2] // 32))


def one_line(text: str, n: int = 120) -> str:
    t = " ".join(str(text).split())
    return t if len(t) <= n else t[: n - 1] + "…"


def short_call(verb: str, args: dict | None) -> str:
    a = args or {}
    parts = []
    for k, v in a.items():
        if isinstance(v, list):
            v = "[" + ", ".join(str(round(x)) if isinstance(x, float) else str(x) for x in v) + "]"
        parts.append(f"{k}={v}" if k not in TARGET_ARGS else str(v))
    return one_line(f"{verb} {' '.join(parts)}".strip(), 60)


@dataclass
class Task:
    id: str
    by: str
    text: str
    state: str = "new"
    standing: bool = False
    said: list[str] = field(default_factory=list)
    journal: list[dict] = field(default_factory=list)  # {"kind": "call"|"ruled_out", "text", "status"?}
    failed_once: bool = False
    approaches: set = field(default_factory=set)  # approach keys since the first failure
    last_failed: str | None = None  # fine key of the failed call, until a different call is made
    no_verb: bool = False  # a failure said no verb can do it (or a house rule): asking is fine


class TaskList:
    def __init__(self):
        self.tasks: list[Task] = []
        self._n = 0
        self.version = 0  # bumped on every change, so the loop can tell

    def _changed(self):
        self.version += 1

    def add(self, by: str, text: str) -> Task:
        self._n += 1
        t = Task(id=f"t{self._n}", by=by, text=text)
        self.tasks.append(t)
        self._changed()
        return t

    def get(self, tid: str | None) -> Task | None:
        return next((t for t in self.tasks if t.id == tid), None)

    def open(self) -> list[Task]:
        return [t for t in self.tasks if t.state in OPEN]

    def working(self) -> list[Task]:
        return [t for t in self.tasks if t.state in ("confirmed", "running")]

    def said(self, t: Task, text: str) -> None:
        t.said.append(text)
        t.said = t.said[-3:]
        if t.state == "new":
            t.state = "confirmed"
        self._changed()

    def started(self, t: Task) -> None:
        if t.state in ("new", "confirmed"):
            t.state = "running"
            self._changed()

    def close(self, t: Task) -> None:
        t.state = "done"
        self._changed()

    def set_standing(self, t: Task, standing: bool) -> None:
        if t.standing != standing:
            t.standing = standing
            self._changed()

    def stop_working(self) -> list[Task]:
        stopped = self.working()
        for t in stopped:
            t.state = "stopped"
        if stopped:
            self._changed()
        return stopped

    # ---- journal --------------------------------------------------------------
    def sent(self, t: Task, verb: str, args: dict | None, place) -> None:
        """A call for t went out: it is a new approach once the task has failed."""
        if fine_key(verb, args) != t.last_failed:
            t.last_failed = None
        if t.failed_once:
            t.approaches.add(approach_key(verb, args, place))

    def result(self, t: Task, verb: str, args: dict | None, place, status: str, detail: str, failed: bool) -> None:
        t.journal.append({"kind": "call", "status": status, "failed": failed,
                          "text": f"{short_call(verb, args)} -> {status}: {one_line(detail)}"})
        if failed:
            if not t.failed_once:
                t.failed_once = True
                t.approaches.add(approach_key(verb, args, place))
            t.last_failed = fine_key(verb, args)
            if NO_VERB_RE.search(detail or ""):
                t.no_verb = True
        self._changed()

    def ruled_out(self, t: Task, text: str) -> None:
        t.journal.append({"kind": "ruled_out", "text": one_line(text)})
        self._changed()

    def ask_blocked(self, t: Task) -> str | None:
        """Why ask_player is not allowed yet for t, or None."""
        if not t.failed_once or t.no_verb or len(t.approaches) >= MIN_APPROACHES:
            return None
        tried = "; ".join(sorted(t.approaches))
        return (f"{t.id} is hard, not unclear: you have tried {len(t.approaches)} approach(es) ({tried}). "
                f"Try at least {MIN_APPROACHES} different approaches (a different verb, place or method) before asking. "
                "Ask only for real ambiguity, a player's preference, or when no verb can do it.")

    def render_journal(self, t: Task) -> list[str]:
        if not t.journal:
            return []
        ruled = [e for e in t.journal if e["kind"] == "ruled_out"][-5:]
        calls = [e for e in t.journal if e["kind"] == "call"]
        room = JOURNAL_LINES - 1 - len(ruled)
        out = []
        if t.failed_once:
            out.append(f"    approaches tried since the first failure: {len(t.approaches)}"
                       + ("" if len(t.approaches) >= MIN_APPROACHES or t.no_verb else f" (ask_player needs {MIN_APPROACHES})"))
        else:
            out.append("    journal:")
        if len(calls) > room:
            old, calls = calls[: len(calls) - room + 1], calls[len(calls) - room + 1:]
            verbs = Counter(e["text"].split(" ", 1)[0] for e in old)
            nf = sum(e["failed"] for e in old)
            out.append(f"    ({len(old)} earlier calls: {', '.join(f'{v} x{n}' for v, n in verbs.most_common())}; {nf} failed)")
        out += [f"    - {e['text']}" for e in calls]
        out += [f"    - ruled out: {e['text']}" for e in ruled]
        return out

    def render(self) -> str:
        shown = self.open() + [t for t in self.tasks if t.state in ("done", "stopped")][-3:]
        if not shown:
            return "(no tasks)"
        lines = []
        for t in shown:
            flags = ", standing" if t.standing else ""
            lines.append(f"{t.id} [{t.state}{flags}] from {t.by}: {t.text}")
            for s in t.said:
                lines.append(f'    you said: "{s}"')
            if t.state in OPEN:
                lines += self.render_journal(t)
        return "\n".join(lines)
