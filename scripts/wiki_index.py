#!/usr/bin/env python3
"""Build the wiki index the mind retrieves from: data/wiki/raw/*.html ->
plain text by section -> chunks (~300-600 tokens) -> BM25 -> data/wiki/index.json.

    python3 scripts/wiki_index.py                         # build
    python3 scripts/wiki_index.py --query "iron ore y level"
    python3 scripts/wiki_index.py --check-ores            # the ore table in docs/verbs.md vs. the wiki
    python3 scripts/wiki_index.py --eval                  # "<ore> y level" must find that ore's page first

Standard library only (the parser, chunker and BM25 live in mind/atlas_mind/wiki.py)."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "mind"))
from atlas_mind import wiki  # noqa: E402

ORES = ["coal", "copper", "iron", "gold", "redstone", "lapis lazuli", "diamond", "emerald"]
# (query, the page that must come first)
EVAL = [(f"{ore} ore y level", f"{ore.title()} Ore") for ore in ORES]


def evaluate(retriever, cases=EVAL, out=print) -> int:
    """Run the retrieval checks; prints PASS/FAIL per query, returns the number failed."""
    failed = 0
    for query, want in cases:
        hits = retriever.search(query, 3)
        got = hits[0].title if hits else "(nothing)"
        ok = bool(hits) and hits[0].page == want
        failed += not ok
        out(f"{'PASS' if ok else 'FAIL'}  {query!r}: first {got}" + ("" if ok else f" (want page {want}); then " + ", ".join(h.title for h in hits[1:])))
    out(f"{len(cases) - failed}/{len(cases)} passed")
    return failed


def page_title(html_path: Path) -> str:
    meta = html_path.with_suffix(".json")
    if meta.exists():
        try:
            return json.loads(meta.read_text(encoding="utf-8"))["title"]
        except (ValueError, KeyError):
            pass
    return html_path.stem.replace("%2F", "/").replace("%3A", ":").replace("_", " ")


def build(raw: Path, out: Path, min_tokens: int, max_tokens: int) -> wiki.BM25Index:
    chunks: list[wiki.Chunk] = []
    pages = sorted(raw.glob("*.html"))
    t0 = time.monotonic()
    seen = set()
    for p in pages:
        title = page_title(p)
        if title in seen:  # two listed titles that redirect to one page
            continue
        seen.add(title)
        sections = wiki.parse_html(p.read_text(encoding="utf-8"))
        chunks += wiki.chunk_page(title, sections, min_tokens, max_tokens)
    ix = wiki.BM25Index.build(chunks)
    ix.save(out)
    sizes = sorted(wiki.tokens(c.text) for c in chunks) or [0]
    print(f"{len(seen)} pages ({len(pages) - len(seen)} duplicate redirects skipped) -> {len(chunks)} chunks (tokens: median {sizes[len(sizes) // 2]}, max {sizes[-1]}) "
          f"in {time.monotonic() - t0:.1f} s -> {out} ({out.stat().st_size // 1024} KiB)")
    return ix


def show(ix, query: str, k: int, budget: int) -> None:
    hits = ix.search(query, k)
    print(f"== {query}")
    if not hits:
        print("(no hits)")
    for h, text in wiki.excerpts(hits, query, budget):
        print(f"[{h.title}] score {h.score}\n{text}\n")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--raw", type=Path, default=ROOT / "data" / "wiki" / "raw")
    ap.add_argument("--index", type=Path, default=ROOT / "data" / "wiki" / "index.json")
    ap.add_argument("--min-tokens", type=int, default=300)
    ap.add_argument("--max-tokens", type=int, default=600)
    ap.add_argument("--query", action="append", help="search the existing index instead of building (repeatable)")
    ap.add_argument("--check-ores", action="store_true", help="print the wiki's distribution text for each ore in docs/verbs.md's table")
    ap.add_argument("--eval", action="store_true", help='check that "<ore> ore y level" finds that ore\'s page first (exit 1 on a failure)')
    ap.add_argument("-k", type=int, default=3)
    ap.add_argument("--budget", type=int, default=600)
    a = ap.parse_args(argv)
    if a.query or a.check_ores or a.eval:
        ix = wiki.load_retriever(a.index)
        if ix is None:
            print(f"no index at {a.index}; build it first", file=sys.stderr)
            return 1
        for q in a.query or []:
            show(ix, q, a.k, a.budget)
        if a.check_ores:
            for ore in ORES:
                show(ix, f"{ore} ore y level", 1, 500)
        if a.eval:
            return 1 if evaluate(ix) else 0
        return 0
    if not a.raw.exists() or not any(a.raw.glob("*.html")):
        print(f"no pages in {a.raw}; run scripts/wiki_fetch.py first", file=sys.stderr)
        return 1
    build(a.raw, a.index, a.min_tokens, a.max_tokens)
    return 0


if __name__ == "__main__":
    sys.exit(main())
