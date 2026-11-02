"""Human-readable rendering of contract messages (CONTRACT.md v0.1)."""
from __future__ import annotations

import json


def _vec(v) -> str:
    if v is None:
        return "-"
    return "(" + ", ".join(f"{x:g}" if isinstance(x, (int, float)) else str(x) for x in v) + ")"


def format_obs(o: dict) -> str:
    s = o.get("self", {})
    w = o.get("world", {})
    lines = [
        f"── obs t={o.get('t')} ─ {s.get('gamemode')} in {s.get('dim')} at {_vec(s.get('pos'))}"
        f" yaw {s.get('yaw')} pitch {s.get('pitch')}",
        f"   hp {s.get('health')} food {s.get('food')} xp {s.get('xp')} held {s.get('held')}"
        f"{' armor ' + ','.join(s['armor']) if s.get('armor') else ''}"
        f"{' effects ' + ','.join(s['effects']) if s.get('effects') else ''}"
        f"{' [ground]' if s.get('on_ground') else ''}{' [water]' if s.get('in_water') else ''}",
        f"   world: {w.get('time')}, {w.get('weather')}, light {w.get('light')}, {w.get('biome')}",
    ]
    inv = o.get("inventory") or {}
    if inv:
        lines.append("   inventory: " + ", ".join(f"{k} x{v}" for k, v in inv.items()))
    blocks = o.get("blocks_seen") or []
    if blocks:
        lines.append(f"   blocks seen ({len(blocks)}): " + ", ".join(
            f"{b['type']} {_vec(b['pos'])} {b['dist']}m" for b in blocks[:8]) + (" …" if len(blocks) > 8 else ""))
    for e in o.get("entities") or []:
        flags = ("hostile " if e.get("hostile") else "") + ("approaching" if e.get("approaching") else "")
        lines.append(f"   entity {e['type']} {e['dist']}m {e['bearing']} rel {_vec(e['rel'])} {flags}".rstrip())
    for p in o.get("players") or []:
        lines.append(f"   player {p['name']} at {_vec(p['pos'])} {p['dist']}m, looking at {_vec(p.get('looking_at'))}")
    sounds = o.get("sounds") or []
    if sounds:
        lines.append("   sounds: " + ", ".join(f"{x['type']} ({x['bearing']}, {x['dist']})" for x in sounds))
    if o.get("boss_bar"):
        b = o["boss_bar"]
        lines.append(f"   boss bar: {b.get('title')} {round(100 * b.get('health', 0))}%")
    for c in (o.get("chat") or [])[-3:]:
        lines.append(f"   chat <{c['from']}> {c['text']}")
    if o.get("task"):
        lines.append(f"   task: {o['task']}")
    return "\n".join(lines)


def format_message(m: dict) -> str:
    t = m.get("type")
    if t == "obs":
        return format_obs(m)
    if t == "result":
        data = m.get("data")
        if data and {"pos", "dist", "age"} <= data.keys():  # recall
            return (f"<< result {m.get('id')}: {m.get('status')} — {data.get('type')} at {_vec(data['pos'])},"
                    f" {data['dist']}m, seen {data['age']} ticks ago")
        line = f"<< result {m.get('id')}: {m.get('status')} — {m.get('detail')}"
        if data:
            line += "\n   data: " + json.dumps(data, separators=(", ", ": "))
        return line
    if t == "event":
        return f"<< event {m.get('kind')}: {m.get('detail')}"
    return f"<< {m}"
