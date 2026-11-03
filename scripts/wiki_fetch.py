#!/usr/bin/env python3
"""Fetch the curated minecraft.wiki pages (data/wiki/pages.txt) into
data/wiki/raw/, politely: one request per second, a descriptive User-Agent,
backoff on 429/5xx, resumable (pages already on disk are skipped).

Each page is the wiki's rendered article HTML from the MediaWiki API
(action=parse), saved as <Title>.html, with <Title>.json beside it (title,
revision, fetch time). Titles the wiki doesn't have are listed in
data/wiki/raw/_missing.txt.

    python3 scripts/wiki_fetch.py              # fetch what's missing
    python3 scripts/wiki_fetch.py --refresh    # fetch everything again
    python3 scripts/wiki_fetch.py --fixtures   # copy Iron_Ore/Ore into mind/tests/fixtures

Then build the index: python3 scripts/wiki_index.py

Wiki text is CC BY-NC-SA 3.0 (minecraft.wiki): personal use only."""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = "https://minecraft.wiki/api.php"
# Generic client name; no personal contact details.
USER_AGENT = "AtlasWikiCache/0.1 (personal Minecraft bot; local knowledge cache; 1 request/s)"


def safe_name(title: str) -> str:
    return title.replace(" ", "_").replace("/", "%2F").replace(":", "%3A")


def read_titles(path: Path) -> list[str]:
    out, seen = [], set()
    for line in path.read_text(encoding="utf-8").splitlines():
        t = line.strip()
        if t and not t.startswith("#") and t not in seen:
            seen.add(t)
            out.append(t)
    return out


def fetch(title: str, timeout: float = 30.0, tries: int = 5, sleep=time.sleep) -> dict:
    """The parse API's JSON for one page; retries 429/5xx and network errors with backoff."""
    q = urllib.parse.urlencode({"action": "parse", "page": title, "prop": "text|revid|displaytitle", "format": "json",
                                "formatversion": "2", "redirects": "1", "disableeditsection": "1"})
    req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    delay = 2.0
    for attempt in range(1, tries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == tries:
                raise
            wait = float(e.headers.get("Retry-After") or delay)
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == tries:
                raise
            wait = delay
            print(f"  network error ({e}); retrying in {wait:g} s", file=sys.stderr)
        sleep(wait)
        delay *= 2
    raise RuntimeError("unreachable")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--pages", type=Path, default=ROOT / "data" / "wiki" / "pages.txt")
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "wiki" / "raw")
    ap.add_argument("--refresh", action="store_true", help="fetch pages again even if cached")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests (default 1)")
    ap.add_argument("--fixtures", action="store_true", help="copy the cached Iron_Ore and Ore pages into mind/tests/fixtures")
    a = ap.parse_args(argv)

    if a.fixtures:
        for name in ("Iron_Ore", "Ore"):
            src = a.out / f"{name}.html"
            if not src.exists():
                print(f"{src} not fetched yet", file=sys.stderr)
                return 1
            shutil.copy(src, ROOT / "mind" / "tests" / "fixtures" / f"{name}.html")
            print(f"copied {src.name}")
        return 0

    a.out.mkdir(parents=True, exist_ok=True)
    titles = read_titles(a.pages)
    missing_file = a.out / "_missing.txt"
    missing = set(missing_file.read_text(encoding="utf-8").splitlines()) if missing_file.exists() and not a.refresh else set()
    todo = [t for t in titles if a.refresh or not (a.out / f"{safe_name(t)}.html").exists()]
    todo = [t for t in todo if t not in missing]
    print(f"{len(titles)} pages listed, {len(titles) - len(todo)} cached or known missing, {len(todo)} to fetch")
    last = 0.0
    failed = 0
    for i, title in enumerate(todo, 1):
        wait = a.delay - (time.monotonic() - last)
        if wait > 0:
            time.sleep(wait)
        last = time.monotonic()
        try:
            d = fetch(title)
        except Exception as e:  # noqa: BLE001 — report and carry on; a rerun resumes
            failed += 1
            print(f"[{i}/{len(todo)}] {title}: failed ({e})", file=sys.stderr)
            continue
        if "error" in d:
            code = d["error"].get("code")
            print(f"[{i}/{len(todo)}] {title}: {code}")
            if code == "missingtitle":
                missing.add(title)
                missing_file.write_text("\n".join(sorted(missing)) + "\n", encoding="utf-8")
            else:
                failed += 1
            continue
        p = d["parse"]
        name = safe_name(title)
        (a.out / f"{name}.html").write_text(p["text"], encoding="utf-8")
        meta = {"title": p.get("title", title), "requested": title, "revid": p.get("revid"),
                "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "source": f"https://minecraft.wiki/w/{urllib.parse.quote(p.get('title', title).replace(' ', '_'))}"}
        (a.out / f"{name}.json").write_text(json.dumps(meta), encoding="utf-8")
        print(f"[{i}/{len(todo)}] {title}" + (f" -> {p['title']}" if p.get("title") not in (None, title) else "") + f" ({len(p['text']) // 1024} KiB)")
    print(f"done: {failed} failed (rerun to retry), {len(missing)} missing titles in {missing_file.name}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
