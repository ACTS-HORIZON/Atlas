"""The mind's task list. task_from_chat adds a task; the model decides the
order, interleaving and when to ask, and updates states through the "task"
field of its actions. Standing tasks stay until stopped."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Task:
    id: str
    by: str
    text: str
    state: str = "new"  # new | active | waiting | done | dropped | stopped
    standing: bool = False
    note: str = ""


class TaskList:
    def __init__(self):
        self.tasks: list[Task] = []
        self._n = 0

    def add(self, by: str, text: str) -> Task:
        self._n += 1
        t = Task(id=f"t{self._n}", by=by, text=text)
        self.tasks.append(t)
        return t

    def get(self, tid: str) -> Task | None:
        return next((t for t in self.tasks if t.id == tid), None)

    def open(self) -> list[Task]:
        return [t for t in self.tasks if t.state in ("new", "active", "waiting")]

    def active(self) -> Task | None:
        return next((t for t in self.tasks if t.state == "active"), None)

    def update(self, tid: str, state: str | None = None, standing: bool | None = None) -> str | None:
        """Apply a model update; returns an error string if it does not apply."""
        t = self.get(tid)
        if not t:
            return f"no task {tid}"
        if state:
            if state == "active":  # one active task at a time; the others wait
                for o in self.tasks:
                    if o.state == "active" and o is not t:
                        o.state = "waiting"
            t.state = state
        if standing is not None:
            t.standing = standing
        return None

    def stop_active(self) -> Task | None:
        t = self.active()
        if t:
            t.state = "stopped"
        return t

    def render(self) -> str:
        shown = self.open() + [t for t in self.tasks if t.state in ("done", "dropped", "stopped")][-3:]
        if not shown:
            return "(no tasks)"
        lines = []
        for t in shown:
            flags = " standing" if t.standing else ""
            lines.append(f"{t.id} [{t.state}{flags}] from {t.by}: {t.text}")
        return "\n".join(lines)
