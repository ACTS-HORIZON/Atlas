"""Mind configuration: environment variables, optionally from <repo>/atlas.env
(the same file the body reads). Real environment variables win."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        out[k.strip()] = v
    return out


@dataclass
class Config:
    link_url: str = "ws://127.0.0.1:8765"
    bot_name: str = "Atlas"
    llm_url: str = "http://127.0.0.1:8080/v1"
    llm_model: str = "gemma"
    llm_key: str | None = None
    llm_temperature: float = 0.4
    llm_max_tokens: int = 600
    llm_json_mode: bool = True
    llm_timeout_s: float = 120.0
    idle_s: float = 10.0
    ask_timeout_s: float = 120.0
    retreat_health: float = 6.0
    history: int = 15
    notes_file: Path = field(default_factory=lambda: ROOT / "data" / "notes.md")
    notes_max_lines: int = 80
    verb_reference: Path = field(default_factory=lambda: ROOT / "docs" / "verbs.md")
    players: list[str] = field(default_factory=list)

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Config":
        e = {**load_env_file(Path(os.environ.get("ATLAS_ENV_FILE", ROOT / "atlas.env"))), **(env if env is not None else os.environ)}
        g = lambda k, d=None: e.get(k) if e.get(k) not in (None, "") else d  # noqa: E731
        host = g("ATLAS_LINK_HOST", "127.0.0.1")
        port = g("ATLAS_LINK_PORT", "8765")
        path = lambda k, d: Path(g(k, d)) if Path(g(k, d)).is_absolute() else ROOT / g(k, d)  # noqa: E731
        return cls(
            link_url=f"ws://{host}:{port}",
            bot_name=g("ATLAS_USERNAME", "Atlas"),
            llm_url=g("ATLAS_LLM_URL", cls.llm_url).rstrip("/"),
            llm_model=g("ATLAS_LLM_MODEL", cls.llm_model),
            llm_key=g("ATLAS_LLM_KEY"),
            llm_temperature=float(g("ATLAS_LLM_TEMPERATURE", cls.llm_temperature)),
            llm_max_tokens=int(g("ATLAS_LLM_MAX_TOKENS", cls.llm_max_tokens)),
            llm_json_mode=g("ATLAS_LLM_JSON_MODE", "1") not in ("0", "false", "no"),
            llm_timeout_s=float(g("ATLAS_LLM_TIMEOUT_S", cls.llm_timeout_s)),
            idle_s=float(g("ATLAS_IDLE_S", cls.idle_s)),
            ask_timeout_s=float(g("ATLAS_ASK_TIMEOUT_S", cls.ask_timeout_s)),
            retreat_health=float(g("ATLAS_RETREAT_HEALTH", cls.retreat_health)),
            history=int(g("ATLAS_MIND_HISTORY", cls.history)),
            notes_file=path("ATLAS_NOTES_FILE", "data/notes.md"),
            notes_max_lines=int(g("ATLAS_NOTES_MAX_LINES", cls.notes_max_lines)),
            verb_reference=path("ATLAS_VERB_REFERENCE", "docs/verbs.md"),
            players=[p.strip() for p in g("ATLAS_PLAYERS", "").split(",") if p.strip()],
        )
