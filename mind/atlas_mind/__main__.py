"""Atlas mind v0.

    python -m atlas_mind                      run the loop against the body's link
    python -m atlas_mind --replay logs/link-2026-11-03.jsonl [--every 15] [--limit 10] [--show-prompt]
    python -m atlas_mind --print-prompt       print the system prompt and exit

The terminal client is python -m atlas_mind.client.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from .config import Config
from .llm import OpenAICompatLLM
from .loop import Mind
from .replay import replay


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="atlas_mind", description="Atlas mind loop (v0)")
    ap.add_argument("--replay", nargs="+", metavar="JSONL", help="feed recorded link logs to the model instead of running live")
    ap.add_argument("--every", type=int, default=15, help="replay: decide every N obs (plus on every result and event)")
    ap.add_argument("--limit", type=int, default=10, help="replay: stop after this many decisions")
    ap.add_argument("--show-prompt", action="store_true", help="replay: print each context before the decision")
    ap.add_argument("--print-prompt", action="store_true", help="print the system prompt and exit")
    a = ap.parse_args(argv)
    try:  # unbuffered output, so a log file (mind.out) shows every line as it happens
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except AttributeError:
        pass
    cfg = Config.from_env()
    llm = OpenAICompatLLM(cfg.llm_url, cfg.llm_model, cfg.llm_key, cfg.llm_temperature, cfg.llm_max_tokens, cfg.llm_json_mode,
                          cfg.llm_timeout_s, stop_after_object=cfg.llm_stop, thinking=cfg.llm_thinking)
    mind = Mind(cfg, llm, log=(lambda *x: print(*x, file=sys.stderr)) if a.print_prompt else print)
    if a.print_prompt:
        print(mind.system)
        return 0
    print(f"[mind] model {cfg.llm_model} at {cfg.llm_url} (max_tokens {cfg.llm_max_tokens}, thinking {'on' if cfg.llm_thinking else 'off'}); notes {cfg.notes_file}; verbs: {', '.join(sorted(mind.verbs))}", file=sys.stderr)
    try:
        if a.replay:
            asyncio.run(replay(mind, a.replay, a.every, a.limit, a.show_prompt))
        else:
            asyncio.run(mind.run())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
