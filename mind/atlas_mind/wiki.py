"""Wiki knowledge: Minecraft wiki pages -> plain-text sections -> chunks ->
a BM25 index -> a retriever the mind asks each turn (and on `lookup`).

The pieces, each usable on its own:
- parse_html(html) -> [Section]: MediaWiki parse output (the `action=parse`
  HTML) to plain text by section. Infoboxes, navboxes, the table of contents,
  edit links, references, hatnotes, styles and scripts are dropped; tables
  are kept as text, one row per line ("a | b | c"); list items start "- ".
- chunk_page(page, sections) -> [Chunk]: chunks by section, ~300-600 tokens.
- BM25Index: build / save / load (one JSON file) / search.
- Retriever: anything with `search(query, k) -> [Hit]`. BM25Retriever is the
  v1 backend; an embedding backend only has to implement the same method
  (load_retriever picks the backend from the index file's "backend" field).
- excerpts(hits, query, budget): the hits cut to a token budget, keeping the
  lines that match the query.

No dependencies beyond the standard library."""
from __future__ import annotations

import json
import math
import re
from collections import Counter
from dataclasses import asdict, dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Protocol

# ---- parsing --------------------------------------------------------------------

SKIP_TAGS = {"style", "script", "noscript", "sup", "math", "audio", "video", "figure", "gallery"}
SKIP_CLASSES = {
    "infobox", "notaninfobox", "infobox-rows", "navbox", "navbox-wrapper", "toc", "toclimit-2", "toclimit-3",
    "mw-editsection", "reference", "references", "mw-references-wrap", "reflist", "hatnote", "dablink",
    "noprint", "metadata", "msgbox", "sidebar", "navigation-not-searchable", "mw-empty-elt", "gallery",
    "mw-cite-backlink", "load-page-button", "mcwiki-header", "thumb", "thumbcaption", "catlinks",
}
SKIP_IDS = {"toc", "catlinks"}
# Sections that are noise for playing the game.
SKIP_SECTIONS = {
    "history", "trivia", "gallery", "references", "external links", "navigation", "issues", "videos",
    "see also", "data values", "sounds", "achievements", "advancements", "screenshots", "renders",
    "notes", "development", "id", "block states", "entity data", "item data", "block data", "in other media",
}
VOID = {"br", "img", "hr", "input", "meta", "link", "wbr", "col", "source", "track", "area", "base", "param", "embed"}
BLOCK = {"p", "div", "li", "ul", "ol", "dl", "dd", "dt", "table", "tr", "caption", "blockquote", "pre", "section", "center"}
HEADINGS = {"h2": 2, "h3": 3, "h4": 4, "h5": 5}


@dataclass
class Section:
    title: str  # "" for the lead
    level: int  # 1 for the lead, 2..5 for headings
    path: list[str]  # headings from h2 down to this one
    text: str


class _WikiHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, bool]] = []  # (tag, starts a skipped subtree)
        self.skip = 0
        self.sections: list[Section] = []
        self.cur = Section("", 1, [], "")
        self.buf: list[str] = []
        self.heading: list[str] | None = None
        self.heading_level = 0
        self.rows: list[list[str]] = []  # open table rows (cells so far)
        self.cells: list[list[str]] = []  # open cells (text so far)
        self.path: list[str] = []

    # where text goes right now
    def _out(self) -> list[str]:
        if self.heading is not None:
            return self.heading
        if self.cells:
            return self.cells[-1]
        return self.buf

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        classes = set((a.get("class") or "").split())
        skip = tag in SKIP_TAGS or bool(classes & SKIP_CLASSES) or a.get("id") in SKIP_IDS \
            or "display:none" in (a.get("style") or "").replace(" ", "")
        if tag in VOID:
            if tag == "br" and not self.skip:
                self._out().append("\n" if not self.cells else " ")
            return
        self.stack.append((tag, skip))
        if skip:
            self.skip += 1
        if self.skip:
            return
        if tag in HEADINGS:
            self.heading = []
            self.heading_level = HEADINGS[tag]
        elif tag == "tr":
            self.rows.append([])
        elif tag in ("td", "th"):
            self.cells.append([])
        elif tag == "span" and (self.cells or any(c.startswith("mcui") for c in classes)):
            self._out().append(" ")  # crafting/smelting UI parts and table sprites are separate words
        elif tag == "caption":
            self._out().append("\nTable: ")
        elif tag == "li":
            self._out().append("\n- ")
        elif tag in BLOCK:
            self._out().append("\n")

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        # pop to the matching open tag (tolerates unclosed children); ignore strays
        if not any(t == tag for t, _ in self.stack):
            return
        while self.stack:
            t, skip = self.stack.pop()
            if skip:
                self.skip -= 1
            elif not self.skip:
                self._close(t)
            if t == tag:
                break

    def _close(self, tag):
        if tag in HEADINGS and self.heading is not None:
            title = _clean_inline("".join(self.heading))
            self.heading = None
            self._flush()
            level = self.heading_level
            self.path = self.path[: max(0, level - 2)] + [title]
            self.cur = Section(title, level, list(self.path), "")
        elif tag in ("td", "th") and self.cells:
            text = _clean_inline("".join(self.cells.pop()))
            if self.rows:
                self.rows[-1].append(text)
            else:
                self._out().append(" " + text + " ")
        elif tag == "tr" and self.rows:
            cells = [c for c in self.rows.pop()]
            line = " | ".join(c for c in cells)
            if line.strip(" |"):
                if self.cells:  # a table inside a cell: rows joined with "; "
                    self.cells[-1].append(" " + line + ";")
                else:
                    self._out().append("\n" + line + "\n")
        elif tag in BLOCK:
            self._out().append("\n")

    def handle_data(self, data):
        if not self.skip:
            self._out().append(data)

    def _flush(self):
        text = _clean_block("".join(self.buf))
        self.buf = []
        if text:
            self.cur.text = text
            self.sections.append(self.cur)

    def close(self):
        super().close()
        self._flush()


def _clean_inline(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _clean_block(s: str) -> str:
    lines = []
    for line in s.split("\n"):
        line = _clean_inline(line)
        if line in ("-", "|", "Table:"):
            continue
        if line:
            lines.append(line)
    return "\n".join(lines)


def parse_html(html: str, keep_all: bool = False) -> list[Section]:
    """Plain text by section. Sections in SKIP_SECTIONS (history, trivia,
    gallery, references…) and everything under them are dropped unless keep_all."""
    p = _WikiHTML()
    p.feed(html)
    p.close()
    if keep_all:
        return p.sections
    out = []
    for s in p.sections:
        if any(h.lower() in SKIP_SECTIONS for h in s.path):
            continue
        out.append(s)
    return out


# ---- chunking -------------------------------------------------------------------

def tokens(text: str) -> int:
    """A token estimate (about 4 characters per token for English)."""
    return max(1, math.ceil(len(text) / 4))


@dataclass
class Chunk:
    id: str
    page: str
    section: str  # "" for the lead; "A › B" for subsections
    text: str

    @property
    def title(self) -> str:
        return f"{self.page} › {self.section}" if self.section else self.page


def _split(text: str, max_tokens: int) -> list[str]:
    """Split text into pieces of about equal size, each <= max_tokens, on line
    (then sentence, then word) boundaries."""
    n = math.ceil(tokens(text) / max_tokens)
    if n <= 1:
        return [text]
    target = len(text) / n
    units: list[str] = []
    for line in text.split("\n"):
        if tokens(line) <= max_tokens:
            units.append(line)
            continue
        for sent in re.split(r"(?<=[.!?])\s+", line):
            while tokens(sent) > max_tokens:
                cut = sent.rfind(" ", 0, max_tokens * 4)
                cut = cut if cut > 0 else max_tokens * 4
                units.append(sent[:cut])
                sent = sent[cut:].lstrip()
            if sent:
                units.append(sent)
    pieces, cur = [], []
    size = 0
    for u in units:
        if cur and (size + len(u) > target * 1.15 or tokens("\n".join(cur + [u])) > max_tokens):
            pieces.append("\n".join(cur))
            cur, size = [], 0
        cur.append(u)
        size += len(u) + 1
    if cur:
        pieces.append("\n".join(cur))
    return pieces


def chunk_page(page: str, sections: list[Section], min_tokens: int = 300, max_tokens: int = 600) -> list[Chunk]:
    """One chunk per section, every heading level kept in its title
    ("Iron Ore › Obtaining › Natural generation"), so a subsection is never
    folded under its neighbour's name. A section longer than max_tokens is
    split evenly on line/sentence boundaries; the pieces after the first start
    with "… " and carry the same title. (min_tokens is the size a split aims
    for; small sections stay small.)"""
    out: list[Chunk] = []
    for s in sections:
        section = " › ".join(s.path)
        sid = re.sub(r"\W+", "_", f"{page} {section}").strip("_")
        for i, piece in enumerate(_split(s.text, max_tokens)):
            out.append(Chunk(f"{sid}#{len(out)}", page, section, piece if i == 0 else "… " + piece))
    return out


# ---- BM25 -----------------------------------------------------------------------

STOP = set("""a an and are as at be by can do does for from has have how i if in into is it its of on or
that the their then there these this to was what when where which while who will with you your me my""".split())
# A tiny query expansion for how players ask vs. how the wiki words it.
SYNONYMS = {
    "level": ["altitude", "height", "y", "generation", "generate"], "levels": ["altitude", "height", "y", "generation"],
    "depth": ["altitude", "y", "generation"],
    "find": ["generation", "found", "generates"], "where": ["generation", "found"], "spawn": ["spawning"],
    "make": ["crafting", "recipe"], "craft": ["crafting", "recipe"], "recipe": ["crafting"],
    "smelt": ["smelting", "furnace"], "cook": ["smelting", "furnace"], "fuel": ["fuel", "burn"],
    "get": ["obtaining"], "obtain": ["obtaining"], "kill": ["defeat", "attack"],
}


def stem(w: str) -> str:
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def tokenize(text: str) -> list[str]:
    return [stem(w) for w in re.findall(r"[a-z0-9]+", text.lower().replace("_", " ")) if w not in STOP]


def query_terms(query: str) -> list[str]:
    words = re.findall(r"[a-z0-9]+", query.lower().replace("_", " "))
    out = tokenize(query)
    for w in words:
        out += [stem(s) for s in SYNONYMS.get(w, [])]
    return out


@dataclass
class Hit:
    page: str
    section: str
    text: str
    score: float
    id: str = ""

    @property
    def title(self) -> str:
        return f"{self.page} › {self.section}" if self.section else self.page


class Retriever(Protocol):
    def search(self, query: str, k: int = 3) -> list[Hit]: ...


def _words(text: str) -> list[str]:
    """Every word, stemmed, stop words kept: for matching a query run against a page title."""
    return [stem(w) for w in re.findall(r"[a-z0-9]+", text.lower().replace("_", " "))]


@dataclass
class BM25Index:
    """BM25 over two fields, the chunk's title (page + section path) weighted
    title_weight x and its body, plus two ranking rules on top:
    - subject first: the longest run of query words that is (part of) a page
      title, e.g. "iron ore" in "iron ore y level", is the subject; chunks of
      pages titled exactly that rank above pages that merely contain it, and
      those above every other page;
    - one chunk per page in the results."""
    chunks: list[Chunk] = field(default_factory=list)
    k1: float = 1.5
    b: float = 0.75
    title_weight: float = 3.0
    _fields: dict = field(default_factory=dict, repr=False)  # name -> (tfs, lens, df, avg)
    _titles: dict = field(default_factory=dict, repr=False)  # page -> its title words

    @classmethod
    def build(cls, chunks: list[Chunk], **kw) -> "BM25Index":
        ix = cls(list(chunks), **kw)
        ix._prepare()
        return ix

    def _prepare(self) -> None:
        def field_of(texts):
            tfs = [Counter(tokenize(t)) for t in texts]
            lens = [sum(tf.values()) for tf in tfs]
            df = Counter(t for tf in tfs for t in tf)
            return tfs, lens, df, (sum(lens) / len(lens)) if lens else 1.0
        self._fields = {"title": field_of([c.page + " " + c.section for c in self.chunks]),
                        "body": field_of([c.text for c in self.chunks])}
        self._titles = {c.page: tuple(_words(c.page)) for c in self.chunks}

    def _bm25(self, name: str, q: Counter, i: int) -> float:
        tfs, lens, df, avg = self._fields[name]
        n = len(self.chunks)
        s = 0.0
        for t, qn in q.items():
            f = tfs[i].get(t)
            if f:
                idf = math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5))
                s += qn * idf * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * lens[i] / avg))
        return s

    def subject(self, query: str) -> tuple[str, set, set]:
        """(subject words, pages titled exactly that, pages whose title contains it); ("", ∅, ∅) if none."""
        words = _words(query)
        for n in range(len(words), 0, -1):
            best = None
            for i in range(len(words) - n + 1):
                run = tuple(words[i:i + n])
                if all(w in STOP or w.isdigit() or len(w) < 2 for w in run):
                    continue
                exact = {p for p, t in self._titles.items() if t == run}
                within = {p for p, t in self._titles.items() if any(t[j:j + n] == run for j in range(len(t) - n + 1))}
                if not within:
                    continue
                rank = (bool(exact), -len(within))
                if best is None or rank > best[0]:
                    best = (rank, " ".join(run), exact, within)
            if best:
                return best[1], best[2], best[3]
        return "", set(), set()

    def search(self, query: str, k: int = 3) -> list[Hit]:
        q = Counter(query_terms(query))
        if not q or not self.chunks:
            return []
        _, exact, within = self.subject(query)
        scored = []
        for i, c in enumerate(self.chunks):
            s = self.title_weight * self._bm25("title", q, i) + self._bm25("body", q, i)
            if s > 0:
                tier = 2 if c.page in exact else 1 if c.page in within else 0
                scored.append((tier, s, i))
        scored.sort(key=lambda x: (-x[0], -x[1], x[2]))
        out, pages = [], set()
        for tier, s, i in scored:
            c = self.chunks[i]
            if c.page in pages:
                continue
            pages.add(c.page)
            out.append(Hit(c.page, c.section, c.text, round(s, 3), c.id))
            if len(out) >= k:
                break
        return out

    def to_json(self) -> dict:
        return {"backend": "bm25", "version": 2, "k1": self.k1, "b": self.b, "title_weight": self.title_weight,
                "chunks": [asdict(c) for c in self.chunks]}

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.to_json(), ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)

    @classmethod
    def from_json(cls, d: dict) -> "BM25Index":
        return cls.build([Chunk(**c) for c in d["chunks"]], k1=d.get("k1", 1.5), b=d.get("b", 0.75),
                         title_weight=d.get("title_weight", 3))


BACKENDS = {"bm25": BM25Index.from_json}  # an embedding backend registers its loader here


def load_retriever(path: Path) -> Retriever | None:
    """The retriever stored at path, or None when there is no index."""
    try:
        d = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    loader = BACKENDS.get(d.get("backend", "bm25"))
    return loader(d) if loader else None


# ---- excerpts for the context ---------------------------------------------------

def excerpt(text: str, query: str, budget: int) -> str:
    """At most `budget` tokens of text: the whole text if it fits, else the
    best-matching line and its neighbours (the line's own text first)."""
    if tokens(text) <= budget:
        return text
    lines = text.split("\n")
    q = set(query_terms(query))
    score = [len(q & set(tokenize(ln))) for ln in lines]
    best = max(range(len(lines)), key=lambda i: (score[i], -i))
    lo = hi = best
    picked = lines[best][: budget * 4]
    while True:
        grew = False
        for j in (hi + 1, lo - 1):  # grow both ways, the line below first
            if 0 <= j < len(lines) and not (lo <= j <= hi):
                cand = (lines[j] + "\n" + picked) if j < lo else (picked + "\n" + lines[j])
                if tokens(cand) <= budget:
                    picked = cand
                    lo, hi = min(lo, j), max(hi, j)
                    grew = True
        if not grew:
            break
    return ("… " if lo > 0 else "") + picked + (" …" if hi < len(lines) - 1 else "")


def excerpts(hits: list[Hit], query: str, budget: int = 600) -> list[tuple[Hit, str]]:
    """The hits, each cut so the total stays within budget tokens (titles
    included). The budget is shared evenly; what a short hit leaves over goes
    to the next ones."""
    out = []
    left = budget
    for i, h in enumerate(hits):
        share = left // (len(hits) - i)
        room = share - tokens(h.title) - 2
        if room < 20:
            continue
        text = excerpt(h.text, query, room)
        out.append((h, text))
        left -= tokens(h.title) + 2 + tokens(text)
    return out


def render(pairs: list[tuple[Hit, str]]) -> str:
    return "\n\n".join(f"[{h.title}]\n{t}" for h, t in pairs)
