"""Lessons: what the player learned from its own play (Session 6a).

data/lessons.jsonl, one JSON object per line:
  {"t": <unix time>, "server": "host:port",
   "situation": {"verb", "failure_class", "surroundings_sentence", "task_text"},
   "lesson": "<one general sentence>", "outcome": "done|stopped|failing|written"}
Written by the model only: the `lesson {text}` action, or the short lesson
turn the loop asks for when a task closes or the same failure class comes
back twice in a row. Nothing here is a rule about Minecraft. Capped at
max_lessons (2000); the oldest are pruned.

Retrieval: the same interface as the wiki (wiki.Retriever: search(query, k)
-> [Hit]), BM25 over the lesson text plus its situation fields."""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from . import wiki

NOISE_RE = re.compile(r"\[[^\]]*\]|-?\b\d+(\.\d+)?\b")


def failure_class(verb: str, detail: str) -> str:
    """Same verb, same reason family: "mine: no iron_ore in view within blocks" for any radius,
    "goto: gave up blocks short of (stuck" for any target. Numbers and coordinates are dropped
    and the reason is cut at its first "(" or ";"; the first 6 words remain."""
    d = NOISE_RE.sub(" ", str(detail or "")).lower()
    d = re.split(r"[(;]", d, 1)[0]
    d = re.sub(rf"^{re.escape(verb)}:\s*", "", d.strip())
    words = re.findall(r"[a-z_']+", d)[:6]
    return f"{verb}: {' '.join(words)}".strip()


def age(t: float, now: float | None = None) -> str:
    s = max(0, (now or time.time()) - (t or 0))
    if s < 3600:
        return f"{int(s // 60)} min ago"
    if s < 86400:
        return f"{int(s // 3600)} h ago"
    return f"{int(s // 86400)} d ago"


class LessonStore:
    def __init__(self, path: Path, server: str = "", max_lessons: int = 2000):
        self.path = Path(path)
        self.server = server
        self.max = max_lessons
        self.items: list[dict] = []
        self._index = None
        try:
            for line in self.path.read_text(encoding="utf-8").splitlines():
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if isinstance(d, dict) and isinstance(d.get("lesson"), str):
                    self.items.append(d)
        except OSError:
            pass
        self.items = self.items[-self.max:]

    def add(self, lesson: str, situation: dict, outcome: str, now: float | None = None) -> dict:
        rec = {"t": round(now or time.time(), 1), "server": self.server,
               "situation": {k: situation.get(k) for k in ("verb", "failure_class", "surroundings_sentence", "task_text")},
               "lesson": " ".join(str(lesson).split())[:300], "outcome": outcome}
        self.items.append(rec)
        pruned = len(self.items) > self.max
        self.items = self.items[-self.max:]
        self._index = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if pruned:
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in self.items), encoding="utf-8")
                tmp.replace(self.path)
            else:
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError:
            pass
        return rec

    def index(self) -> wiki.BM25Index:
        if self._index is None:
            chunks = []
            for i, r in enumerate(self.items):
                s = r.get("situation") or {}
                body = " ".join(str(x) for x in (r["lesson"], s.get("failure_class"), s.get("verb"), s.get("surroundings_sentence"), s.get("task_text")) if x)
                # one "page" per lesson, so the one-chunk-per-page rule keeps them all
                chunks.append(wiki.Chunk(str(i), f"lesson {i}", "", body))
            self._index = wiki.BM25Index.build(chunks, title_weight=0)
        return self._index

    def search(self, query: str, k: int = 3) -> list[tuple[dict, float]]:
        """The k best lessons for a query: [(record, score)]."""
        if not self.items or not query.strip():
            return []
        return [(self.items[int(h.id)], h.score) for h in self.index().search(query, k)]
