#!/usr/bin/env python3
"""Offline tuning for the player loop's question (CONTRACT.md "Player loop").

Replays reflex views against the live d1 endpoint with the current
instructions and criteria (body/src/player/prompt.json, the same file the
body reads), and prints what d1 picks for each view and the overall action
distribution. Tune the wording in prompt.json, rerun, compare: minutes, no game.
d1's answer is decoded as the body decodes it: the argmax of the returned
probabilities over the offered actions (confidence = top, margin = top - second).

    python3 scripts/player_eval.py                         # the 10 hand-written views
    python3 scripts/player_eval.py --repeat 5              # ask each view 5 times
    python3 scripts/player_eval.py --logs                  # the last 50 ticks from logs/player-*.jsonl
    python3 scripts/player_eval.py --logs 200 --log-dir logs
    python3 scripts/player_eval.py --imitation 500         # agreement with the scripts' actions: the pre-fine-tuning baseline
    python3 scripts/player_eval.py --views my_views.json
    python3 scripts/player_eval.py --print-request 0       # the request body for view 0, no network

The URL: --url, else ATLAS_PLAYER_URL from the environment, else from atlas.env.
Standard library only. The request is built byte for byte as
body/src/player/client.js builds it (body/test/player.test.js checks that)."""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROMPT_FILE = ROOT / "body" / "src" / "player" / "prompt.json"
VIEWS_FILE = ROOT / "scripts" / "player_eval_views.json"


def load_prompt() -> dict:
    return json.loads(PROMPT_FILE.read_text(encoding="utf-8"))


def _jsnum(o):
    """JS has one number type: 3.0 prints as 3."""
    if isinstance(o, float) and o.is_integer() and abs(o) < 1e21:
        return int(o)
    if isinstance(o, dict):
        return {k: _jsnum(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_jsnum(v) for v in o]
    return o


def js(o) -> str:
    """JSON.stringify(o): compact, non-ASCII as is, integral numbers without ".0"."""
    return json.dumps(_jsnum(o), separators=(",", ":"), ensure_ascii=False)


def instructions_for(prompt: dict, intent) -> str:
    return prompt["instructions"].replace("{intent}", intent, 1) if intent else prompt["survive_instructions"]


def build_request(prompt: dict, state: dict, offered: list, intent=None, criteria=None, model: str = "d1-2b") -> dict:
    """DecisionClient.request(): criteria per offered action (the given line, else the base line, else the name)."""
    c = {a: (criteria or {}).get(a) or prompt["descriptions"].get(a) or a for a in offered}
    return {"model": model, "state": js(state),
            "questions": {"action": {"type": "choice", "instructions": instructions_for(prompt, intent), "criteria": c}}}


def load_views(path: Path) -> list[dict]:
    d = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for v in d["views"] if isinstance(d, dict) else d:
        intent = None if v.get("mode") == "survive" else v.get("intent", (v.get("state") or {}).get("intent"))
        out.append({"name": v.get("name", "?"), "intent": intent, "want": v.get("want") or [],
                    "state": v["state"], "offered": v.get("offered") or v["state"].get("offered") or [],
                    "criteria": v.get("criteria")})
    return out


def load_logs(log_dir: Path, n: int, prefix: str = "player") -> list[dict]:
    """The last n ticks across logs/<prefix>-*.jsonl (oldest file first). Ticks with no view are skipped.
    prefix "imitation": the recorder's ticks; the script's action becomes the wanted answer."""
    imitation = prefix == "imitation"
    lines = []
    for f in sorted(log_dir.glob(f"{prefix}-*.jsonl")):
        try:
            lines += f.read_text(encoding="utf-8").splitlines()
        except OSError:
            pass
    out = []
    for line in reversed(lines):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if not isinstance(r, dict) or not isinstance(r.get("view"), dict) or not r.get("offered"):
            continue
        intent = None if r.get("mode") == "survive" else (r.get("intent") or r["view"].get("intent"))
        if r.get("target") and intent and "(target:" not in intent:
            intent = f"{intent} (target: {r['target']})"
        if imitation and r.get("chosen") not in r["offered"]:
            continue
        name = f"{r.get('ts', '?')} {r.get('source', '')} did {r.get('chosen')}" if imitation else f"{r.get('ts', '?')} {r.get('mode', '')} chose {r.get('chosen')}"
        out.append({"name": name, "intent": intent, "want": [r["chosen"]] if imitation else [], "logged": r.get("chosen"),
                    "state": r["view"], "offered": r["offered"], "criteria": r.get("criteria")})
        if len(out) >= n:
            break
    return list(reversed(out))


def env_url() -> str:
    if os.environ.get("ATLAS_PLAYER_URL"):
        return os.environ["ATLAS_PLAYER_URL"]
    for f in (ROOT / "atlas.env", ROOT / "body" / "atlas.env"):
        try:
            for line in f.read_text(encoding="utf-8").splitlines():
                k, _, v = line.strip().partition("=")
                if k.strip() == "ATLAS_PLAYER_URL" and v.strip():
                    return v.strip().strip("'\"")
        except OSError:
            pass
    return ""


def ask(url: str, body: dict, timeout: float) -> tuple[dict | None, float, str | None]:
    t0 = time.perf_counter()
    req = urllib.request.Request(url, data=js(body).encode("utf-8"), headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            data = json.loads(res.read().decode("utf-8"))
        return data, (time.perf_counter() - t0) * 1000, None
    except urllib.error.HTTPError as e:
        return None, (time.perf_counter() - t0) * 1000, f"HTTP {e.code}"
    except (urllib.error.URLError, OSError, ValueError) as e:
        return None, (time.perf_counter() - t0) * 1000, str(getattr(e, "reason", e))


def decode(ans: dict, offered: list) -> tuple[str | None, float | None, float | None]:
    """The body's decoding (client.js decode()): the argmax of the probabilities over the offered actions,
    never the server's `choice` alone; (choice, confidence, margin). No probabilities: the server's choice."""
    probs = ans.get("probabilities") if isinstance(ans.get("probabilities"), dict) else {}
    ranked = sorted((o for o in offered if isinstance(probs.get(o), (int, float))), key=lambda o: (-probs[o], offered.index(o)))
    if ranked:
        top_p = probs[ranked[0]]
        second = probs[ranked[1]] if len(ranked) > 1 else 0
        return ranked[0], round(top_p, 3), round(top_p - second, 3)
    if ans.get("choice") in offered:
        return ans["choice"], ans.get("confidence"), None
    return None, None, None


def top(probs: dict | None, k: int = 3) -> str:
    if not isinstance(probs, dict):
        return ""
    best = sorted(probs.items(), key=lambda kv: -float(kv[1] or 0))[:k]
    return "  ".join(f"{a} {float(p):.2f}" for a, p in best)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", default=None, help="the /v1/systemone URL (default: ATLAS_PLAYER_URL)")
    ap.add_argument("--model", default=os.environ.get("ATLAS_PLAYER_MODEL", "d1-2b"))
    ap.add_argument("--views", type=Path, default=VIEWS_FILE, help="a views file (default: the hand-written set)")
    ap.add_argument("--logs", type=int, nargs="?", const=50, default=None, metavar="N", help="replay the last N logged ticks instead (default 50)")
    ap.add_argument("--imitation", type=int, nargs="?", const=200, default=None, metavar="N",
                    help="replay the last N imitation ticks (logs/imitation-*.jsonl, default 200) and report agreement with the script's action")
    ap.add_argument("--log-dir", type=Path, default=ROOT / "logs")
    ap.add_argument("--repeat", type=int, default=1, help="ask each view this many times")
    ap.add_argument("--timeout", type=float, default=2.0, help="seconds per request (offline: no tick budget)")
    ap.add_argument("--print-request", type=int, default=None, metavar="I", help="print view I's request body and exit (no network)")
    a = ap.parse_args(argv)

    prompt = load_prompt()
    if a.imitation is not None:
        views = load_logs(a.log_dir, a.imitation, "imitation")
    elif a.logs is not None:
        views = load_logs(a.log_dir, a.logs)
    else:
        views = load_views(a.views)
    if not views:
        where = f" in {a.log_dir}/imitation-*.jsonl" if a.imitation is not None else f" in {a.log_dir}/player-*.jsonl" if a.logs is not None else ""
        print("no views" + where, file=sys.stderr)
        return 1
    if a.print_request is not None:
        v = views[a.print_request]
        sys.stdout.write(js(build_request(prompt, v["state"], v["offered"], v["intent"], v["criteria"], a.model)))
        return 0

    url = a.url or env_url()
    if not url:
        print("no URL: pass --url or set ATLAS_PLAYER_URL (environment or atlas.env)", file=sys.stderr)
        return 1

    overall = collections.Counter()
    per_action = collections.defaultdict(lambda: [0, 0])  # wanted action -> [asked, agreed]
    lat, errors, scored, hits = [], collections.Counter(), 0, 0
    for i, v in enumerate(views):
        body = build_request(prompt, v["state"], v["offered"], v["intent"], v["criteria"], a.model)
        dist, last = collections.Counter(), None
        for _ in range(max(1, a.repeat)):
            data, ms, err = ask(url, body, a.timeout)
            lat.append(ms)
            ans = ((data or {}).get("answers") or {}).get("action") or {}
            if err or not ans:
                errors[err or "no answer"] += 1
                dist["(error)"] += 1
                continue
            choice, conf, margin = decode(ans, v["offered"])
            if not choice:
                choice = f"{ans.get('choice')} (not offered)"
            dist[choice] += 1
            overall[choice] += 1
            last = {**ans, "_conf": conf, "_margin": margin}
            if v["want"]:
                per_action[v["want"][0]][0] += 1
                per_action[v["want"][0]][1] += choice in v["want"]
        verdict = ""
        if v["want"]:
            n = sum(c for k, c in dist.items() if k in v["want"])
            scored += sum(dist.values()); hits += n
            verdict = f"  want {'/'.join(v['want'])}: {'PASS' if n == sum(dist.values()) else 'MISS' if n == 0 else f'{n}/{sum(dist.values())}'}"
        elif v.get("logged"):
            verdict = f"  (logged: {v['logged']})"
        print(f"[{i}] {v['name']}")
        print(f"    intent: {v['intent'] or '(survive)'}")
        print(f"    chose:  {', '.join(f'{k} x{c}' for k, c in dist.most_common())}{verdict}")
        if last:
            extra = f"  (top {last['_conf']:.2f}, margin {last['_margin']:.2f})" if last.get("_margin") is not None else ""
            served = f"  server choice: {last.get('choice')}" if last.get("choice") and last.get("choice") not in dist else ""
            print(f"    probs:  {top(last.get('probabilities'))}{extra}{served}")

    total = sum(overall.values())
    print()
    print(f"distribution over {total} answers: " + ", ".join(f"{k} {100 * c / total:.0f}%" for k, c in overall.most_common()) if total else "no answers")
    if scored:
        label = "agreement with the script (d1 argmax == script action)" if a.imitation is not None else "wanted"
        print(f"{label}: {hits}/{scored} ({100 * hits / scored:.0f}%)")
        if a.imitation is not None:
            for act, (n, ok) in sorted(per_action.items(), key=lambda kv: -kv[1][0]):
                print(f"    {act:<22} {ok}/{n} ({100 * ok / n:.0f}%)")
    if lat:
        s = sorted(lat)
        print(f"latency p50 {s[len(s) // 2]:.1f} ms p95 {s[min(len(s) - 1, int(0.95 * len(s)))]:.1f} ms" +
              (f", errors: {', '.join(f'{k} x{c}' for k, c in errors.items())}" if errors else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
