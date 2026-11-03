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
Each task keeps what the bot already said about it, shown in the context."""
from __future__ import annotations

from dataclasses import dataclass, field

OPEN = ("new", "confirmed", "running")


@dataclass
class Task:
    id: str
    by: str
    text: str
    state: str = "new"
    standing: bool = False
    said: list[str] = field(default_factory=list)


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
        return "\n".join(lines)
