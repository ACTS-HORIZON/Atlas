"""Compact, model-facing renderings: the obs in a few hundred tokens (not raw
JSON) and one-line history entries."""
from __future__ import annotations

import json


def _v(p) -> str:
    return "(" + ", ".join(f"{x:g}" if isinstance(x, (int, float)) else str(x) for x in p) + ")"


def render_obs(o: dict | None) -> str:
    if not o:
        return "(no observation yet: not in game)"
    s, w = o["self"], o["world"]
    lines = [
        f"t={o['t']} {s['gamemode']} in {s['dim']} at {_v(s['pos'])}, facing yaw {s['yaw']}",
        f"health {s['health']}/20, food {s['food']}/20, xp {s['xp']}, holding {s['held'] or 'nothing'}"
        + (f", armor {', '.join(s['armor'])}" if s["armor"] else "")
        + (f", effects {', '.join(s['effects'])}" if s["effects"] else "")
        + (", in water" if s["in_water"] else ""),
        f"world: {w['time']}, {w['weather']}, light {w['light']}, biome {w['biome']}",
    ]
    inv = o.get("inventory") or {}
    lines.append("inventory: " + (", ".join(f"{k} {v}" for k, v in sorted(inv.items())) if inv else "empty"))
    # blocks: grouped by type, nearest of each with count
    groups: dict[str, list] = {}
    for b in o.get("blocks_seen") or []:
        groups.setdefault(b["type"], []).append(b)
    if groups:
        parts = [f"{t} x{len(bs)} (nearest {_v(bs[0]['pos'])} {bs[0]['dist']}m)" for t, bs in sorted(groups.items(), key=lambda kv: kv[1][0]["dist"])]
        lines.append("blocks seen: " + "; ".join(parts[:12]))
    else:
        lines.append("blocks seen: nothing notable")
    ents = o.get("entities") or []
    if ents:
        lines.append("entities: " + "; ".join(
            f"{e['type']} {e['dist']}m {e['bearing']}{' HOSTILE' if e['hostile'] else ''}{' approaching' if e['approaching'] else ''}"
            for e in ents[:8]))
    for p in o.get("players") or []:
        if "pos" in p:
            lines.append(f"player {p['name']} {p['dist']}m at {_v(p['pos'])}" + (f", looking at {_v(p['looking_at'])}" if p.get("looking_at") else ""))
        else:
            lines.append(f"player {p['name']} out of sight, bearing {p['bearing']}")
    if o.get("sounds"):
        lines.append("sounds: " + ", ".join(f"{x['type']} ({x['bearing']}, {x['dist']})" for x in o["sounds"][:6]))
    if o.get("boss_bar"):
        lines.append(f"boss bar: {o['boss_bar']['title']} {round(o['boss_bar']['health'] * 100)}%")
    t = o.get("task")
    lines.append(f"running verb: {t['verb']} {json.dumps(t['args'])} ({t.get('progress', '')})" if t else "running verb: none")
    for c in (o.get("chat") or [])[-3:]:
        lines.append(f"chat <{c['from']}> {c['text']}")
    return "\n".join(lines)


def history_line(kind: str, m: dict) -> str:
    """One line per call/result/event/own action for the RECENT section."""
    if kind == "call":
        return f"you called {m['verb']} {json.dumps(m.get('args', {}))} (id {m['id']})"
    if kind == "result":
        data = f" data={json.dumps(m['data'], separators=(',', ':'))}" if m.get("data") else ""
        return f"result {m['id']}: {m['status']} - {m['detail']}{data}"
    if kind == "event":
        return f"event {m['kind']}: {json.dumps(m.get('detail'), separators=(',', ':'))}"
    return f"{kind}: {m}"
