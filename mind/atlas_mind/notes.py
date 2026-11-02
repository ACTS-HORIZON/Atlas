"""Persistent notes (data/notes.md): appended by the note action, included in
the context, kept across runs. Capped at max_lines: the oldest lines are
dropped and counted in a header line, so the file never eats the context."""
from __future__ import annotations

import time
from pathlib import Path

HEADER = "<!-- older notes dropped: "


class Notes:
    def __init__(self, path: Path, max_lines: int = 80):
        self.path = Path(path)
        self.max_lines = max_lines
        self.dropped = 0
        self.lines: list[str] = []
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                if line.startswith(HEADER):
                    try:
                        self.dropped = int(line[len(HEADER):].split()[0])
                    except ValueError:
                        pass
                elif line.strip():
                    self.lines.append(line)

    def append(self, text: str) -> None:
        stamp = time.strftime("%Y-%m-%d %H:%M")
        self.lines.append(f"- {stamp} {' '.join(text.split())}")
        over = len(self.lines) - self.max_lines
        if over > 0:
            self.lines = self.lines[over:]
            self.dropped += over
        self.save()

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        head = [f"{HEADER}{self.dropped} -->"] if self.dropped else []
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text("\n".join(head + self.lines) + "\n", encoding="utf-8")
        tmp.replace(self.path)

    def render(self) -> str:
        if not self.lines:
            return "(no notes yet)"
        more = f"({self.dropped} older notes dropped)\n" if self.dropped else ""
        return more + "\n".join(self.lines)
