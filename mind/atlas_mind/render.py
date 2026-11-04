"""Compact, model-facing renderings: the obs in a few hundred tokens (not raw
JSON) and one-line history entries."""
from __future__ import annotations

import json


def _v(p) -> str:
    return "(" + ", ".join(f"{x:g}" if isinstance(x, (int, float)) else str(x) for x in p) + ")"


ABBR = {"north": "N", "east": "E", "south": "S", "west": "W"}


def render_inventory(o: dict | None) -> str:
    """One line: INVENTORY: cobblestone 41, oak_log 6 (or empty)."""
    inv = (o or {}).get("inventory") or {}
    return "INVENTORY: " + (", ".join(f"{k} {v}" for k, v in sorted(inv.items())) if inv else "empty")


def render_surroundings(o: dict | None) -> str:
    """SURROUNDINGS: the derived sentence, then the cells and the four directions (feet/head) in one line."""
    s = (o or {}).get("surroundings")
    if not s:
        return "SURROUNDINGS: (not reported)"
    sides = []
    for d, (feet, head) in (s.get("sides") or {}).items():
        if feet is None and head is None:
            sides.append(f"{ABBR.get(d, d)} open")
        elif feet == head:
            sides.append(f"{ABBR.get(d, d)} {feet} (feet+head)")
        else:
            sides.append(f"{ABBR.get(d, d)} {feet or 'open'}/{head or 'open'}")
    drops = [f"{ABBR.get(d, d)} {n}" for d, n in (s.get("drops") or {}).items() if n]
    g = s.get("ground") or {}
    if s.get("sky"):
        sky = "open sky"
    elif g.get("canopy"):
        sky = f"canopy: leaves {s['roof']} up"
    else:
        sky = f"roof {s['roof']} up" if s.get("roof") is not None else "no sky"
    out = (f"SURROUNDINGS: {s.get('summary', '')}\n"
           f"  feet {s.get('feet')}, head {s.get('head')}, below {s.get('below')}, above {s.get('above')}; "
           + "; ".join(sides) + (f"; drops {', '.join(drops)}" if drops else "") + f"; {sky}, light {s.get('light')}")
    return out + render_ground(g) if g else out


def render_ground(g: dict) -> str:
    """The ground facts (Session 9b), one line: what it stands on, where the natural ground is, the terrain."""
    on = g.get("standing_on")
    parts = [f"standing on: {on} (placed by you? {'yes' if g.get('placed') else 'no'})" if on else "standing on: nothing solid"]
    if g.get("level") is None:
        parts.append("ground level: not in sight")
    elif g.get("below") == 0:
        parts.append(f"ground level: y={g['level']}, you are on it")
    elif g["below"] > 0:
        parts.append(f"ground level: y={g['level']}, {g['below']} below you")
    else:
        parts.append(f"ground level: y={g['level']}, {-g['below']} above you")
    t = g.get("terrain")
    if t:
        shape, _, ys = t.partition(" ")
        parts.append(f"terrain within 8: {shape}, y {ys}")
    return "\n  " + "; ".join(parts)


def render_obs(o: dict | None, inventory: bool = True) -> str:
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
    if inventory:
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
