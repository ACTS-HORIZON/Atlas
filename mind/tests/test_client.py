import json
import tempfile
import unittest
from pathlib import Path

from atlas_mind.client import parse_command
from atlas_mind.pretty import format_obs


class ParseTest(unittest.TestCase):
    def test_commands(self):
        ids = iter(["c1", "c2", "c3", "c4"])
        nid = lambda: next(ids)  # noqa: E731
        self.assertEqual(parse_command("say hello there", nid),
                         {"type": "call", "v": "0.1", "id": "c1", "verb": "say", "args": {"text": "hello there"}})
        self.assertEqual(parse_command("stop", nid)["verb"], "stop")
        self.assertEqual(parse_command("obs", nid), {"type": "observe", "v": "0.1"})
        self.assertEqual(parse_command("recall iron_ore", nid)["args"], {"type": "iron_ore"})
        self.assertEqual(parse_command("recall chest 1 64 -3", nid)["args"], {"type": "chest", "near": [1.0, 64.0, -3.0]})
        self.assertTrue(parse_command("recall chest 1 2", nid).startswith("usage"))

    def test_verbs(self):
        ids = iter(f"c{i}" for i in range(1, 20))
        nid = lambda: next(ids)  # noqa: E731
        self.assertEqual(parse_command("goto 10 64 -3.5", nid)["args"], {"pos": [10.0, 64.0, -3.5]})
        self.assertEqual(parse_command("goto ACTS_HORIZON", nid)["args"], {"target": "ACTS_HORIZON"})
        self.assertTrue(parse_command("goto 1 2", nid).startswith("usage"))
        self.assertTrue(parse_command("goto 1 2 x", nid).startswith("usage"))
        self.assertEqual(parse_command("explore north-east 48", nid)["args"], {"direction": "north-east", "distance": 48})
        self.assertTrue(parse_command("explore up 3", nid).startswith("usage"))
        self.assertTrue(parse_command("explore north", nid).startswith("usage"))
        m = parse_command("mine iron_ore 8", nid)
        self.assertEqual((m["verb"], m["args"]), ("mine", {"block": "iron_ore", "count": 8}))
        self.assertEqual(parse_command("mine coal_ore 3 16", nid)["args"], {"block": "coal_ore", "count": 3, "radius": 16})
        self.assertTrue(parse_command("mine coal_ore lots", nid).startswith("usage"))
        self.assertEqual(parse_command("mine iron_ore 3 y=16", nid)["args"], {"block": "iron_ore", "count": 3, "y": 16})
        self.assertEqual(parse_command("mine diamond_ore 2 48 y=-59", nid)["args"], {"block": "diamond_ore", "count": 2, "radius": 48, "y": -59})
        self.assertTrue(parse_command("mine iron_ore 3 y=deep", nid).startswith("usage"))
        self.assertEqual(parse_command("smelt iron_ingot 8", nid)["args"], {"item": "iron_ingot", "count": 8})
        self.assertEqual(parse_command("smelt raw_iron 3 oak_planks", nid)["args"], {"item": "raw_iron", "count": 3, "fuel": "oak_planks"})
        self.assertEqual(parse_command("smelt glass", nid)["args"], {"item": "glass"})
        self.assertEqual(parse_command("place furnace", nid)["args"], {"block": "furnace"})
        self.assertTrue(parse_command("smelt iron_ingot lots", nid).startswith("usage"))
        self.assertEqual(parse_command("collect oak_log", nid)["args"], {"item": "oak_log"})
        self.assertTrue(parse_command("collect", nid).startswith("usage"))

    def test_session3_verbs(self):
        ids = iter(f"c{i}" for i in range(1, 30))
        nid = lambda: next(ids)  # noqa: E731
        self.assertEqual(parse_command("goto 1 64 2 nodig", nid)["args"], {"pos": [1.0, 64.0, 2.0], "dig": False})
        self.assertEqual(parse_command("goto ACTS_HORIZON noscaffold", nid)["args"], {"target": "ACTS_HORIZON", "scaffold": False})
        self.assertEqual(parse_command("craft oak_planks 8", nid)["args"], {"item": "oak_planks", "count": 8})
        self.assertEqual(parse_command("craft crafting_table", nid)["args"], {"item": "crafting_table"})
        self.assertEqual(parse_command("place cobblestone 3 64 -2", nid)["args"], {"block": "cobblestone", "pos": [3, 64, -2]})
        self.assertTrue(parse_command("place cobblestone 3 64", nid).startswith("usage"))
        self.assertEqual(parse_command("equip shield off-hand", nid)["args"], {"item": "shield", "slot": "off-hand"})
        self.assertEqual(parse_command("dig 3 63 -2", nid)["args"], {"pos": [3, 63, -2]})
        self.assertTrue(parse_command("dig 3 x -2", nid).startswith("usage"))
        self.assertEqual(parse_command("eat", nid)["args"], {})
        self.assertEqual(parse_command("eat bread", nid)["args"], {"item": "bread"})
        self.assertEqual(parse_command("give spruce_log 8 ACTS_HORIZON", nid)["args"], {"item": "spruce_log", "count": 8, "player": "ACTS_HORIZON"})
        self.assertEqual(parse_command("deposit cobblestone 3 64 -2", nid)["args"], {"item": "cobblestone", "chest": [3, 64, -2]})
        self.assertEqual(parse_command("withdraw iron_ingot 3 64 -2 5", nid)["args"], {"item": "iron_ingot", "chest": [3, 64, -2], "count": 5})
        self.assertTrue(parse_command("give spruce_log ACTS_HORIZON", nid).startswith("usage"))

    def test_trace(self):
        nid = lambda: "c1"  # noqa: E731
        self.assertEqual(parse_command("trace check the cave first", nid, lambda: 18342),
                         {"type": "trace", "v": "0.1", "t": 18342, "kind": "note", "text": "check the cave first", "data": {}})
        self.assertEqual(parse_command("trace plan get iron, then come back", nid)["kind"], "plan")
        self.assertEqual(parse_command("trace plan get iron", nid)["text"], "get iron")
        self.assertTrue(parse_command("trace", nid).startswith("usage"))
        self.assertTrue(parse_command("trace decision", nid).startswith("usage"))
        self.assertEqual(parse_command("quit", nid), "quit")
        self.assertIsNone(parse_command("   ", nid))
        self.assertTrue(parse_command("dance", nid).startswith("commands"))
        self.assertTrue(parse_command("say", nid).startswith("usage"))


class WatchParseTest(unittest.TestCase):
    """--watch <see>:<verb>:<n>[,...] on explore/goto/mine/collect (Session 8b-2)."""

    def parse(self, line):
        ids = iter(range(100))
        return parse_command(line, lambda: f"c{next(ids)}")

    def test_watch(self):
        m = self.parse("explore north 48 --watch oak_log:mine:2")
        self.assertEqual(m["args"], {"direction": "north", "distance": 48,
                                     "watch": [{"see": "oak_log", "do": {"verb": "mine", "args": {"block": "oak_log", "count": 2}}}]})
        m = self.parse("mine stone 5 --watch iron_ore:mine:3,zombie:goto:1")
        self.assertEqual(m["args"]["watch"], [{"see": "iron_ore", "do": {"verb": "mine", "args": {"block": "iron_ore", "count": 3}}},
                                              {"see": "zombie", "do": {"verb": "goto", "args": {"target": "zombie"}}, "max": 1}])
        m = self.parse("goto 10 64 -20 --watch apple:collect:4 nodig")  # flags after the watch still count
        self.assertEqual(m["args"], {"pos": [10.0, 64.0, -20.0], "dig": False,
                                     "watch": [{"see": "apple", "do": {"verb": "collect", "args": {"item": "apple"}}, "max": 4}]})
        self.assertEqual(self.parse("collect apple --watch apple:collect")["args"]["watch"][0]["max"], 1)
        self.assertEqual(self.parse("craft stick --watch x:mine:1"), "--watch is only for explore, goto, mine, collect")
        for bad in ("explore north 48 --watch oak_log:fly:2", "explore north 48 --watch oak_log:mine:0", "explore north 48 --watch", "explore north 48 --watch :mine:2"):
            self.assertTrue(self.parse(bad).startswith("usage: ... --watch"), bad)
        self.assertTrue(self.parse("explore north --watch oak_log:mine:2").startswith("usage: explore"))


class PrettyTest(unittest.TestCase):
    def test_recall_result(self):
        from atlas_mind.pretty import format_message
        m = {"type": "result", "v": "0.1", "id": "c3", "status": "done", "detail": "iron_ore at [0, 10, 6]",
             "data": {"type": "iron_ore", "pos": [0, 10, 6], "dist": 6, "age": 200}, "obs": None}
        self.assertEqual(format_message(m), "<< result c3: done — iron_ore at (0, 10, 6), 6m, seen 200 ticks ago")

    def test_contract_example(self):
        o = {"type": "obs", "v": "0.1", "t": 18342,
             "self": {"pos": [104, 63, 131], "dim": "overworld", "yaw": 90, "pitch": 10, "health": 14, "food": 17,
                      "xp": 3, "on_ground": True, "in_water": False, "held": "stone_pickaxe",
                      "armor": ["leather_chestplate"], "effects": [], "gamemode": "survival"},
             "inventory": {"cobblestone": 41},
             "world": {"time": "dusk", "weather": "clear", "light": 9, "biome": "cherry_grove"},
             "blocks_seen": [{"type": "iron_ore", "pos": [110, 58, 129], "dist": 8.3}],
             "entities": [{"type": "zombie", "rel": [5, 0, -2], "dist": 5.4, "bearing": "front-left",
                           "approaching": True, "hostile": True}],
             "players": [{"name": "ACTS_HORIZON", "pos": [98, 64, 130], "dist": 6.2, "looking_at": [96, 63, 128]}],
             "sounds": [{"type": "creeper_hiss", "bearing": "behind", "dist": "near"}],
             "boss_bar": None, "chat": [{"from": "ACTS_HORIZON", "text": "@Atlas grab some iron", "t": 18300}],
             "task": None}
        text = format_obs(o)
        for s in ["survival", "iron_ore (110, 58, 129)", "zombie 5.4m front-left", "looking at (96, 63, 128)",
                  "creeper_hiss (behind, near)", "<ACTS_HORIZON> @Atlas grab some iron"]:
            self.assertIn(s, text)


if __name__ == "__main__":
    unittest.main()


class PlayCommandTest(unittest.TestCase):
    def test_play_parses(self):
        from atlas_mind.client import parse_command
        n = iter(range(100))
        nid = lambda: f"c{next(n)}"  # noqa: E731
        m = parse_command('play "get to the surface"', nid)
        self.assertEqual((m["type"], m["verb"], m["args"]), ("call", "play", {"intent": "get to the surface"}))
        self.assertEqual(parse_command('play "get to the surface" 90', nid)["args"], {"intent": "get to the surface", "budget": 90})
        self.assertEqual(parse_command('play "walk to Rook" 30 Rook', nid)["args"], {"intent": "walk to Rook", "budget": 30, "target": "Rook"})
        self.assertEqual(parse_command("play climb 2.5", nid)["args"], {"intent": "climb", "budget": 2.5})
        for bad in ("play", 'play "x" soon', 'play "x" 0', 'play "x" 5000', 'play "unclosed', 'play "x" 5 Rook extra'):
            self.assertTrue(parse_command(bad, nid).startswith("usage: play"), bad)
        self.assertEqual(parse_command("player", nid), "player")

    def test_player_tail(self):
        from atlas_mind.client import player_tail
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(player_tail(Path(d), day="2026-11-04").startswith("no player ticks today"))
            rows = [{"ts": f"2026-11-04T10:00:{i:02d}.000Z", "mode": "play", "chosen": "dig_above", "latency_ms": 17.2 + i,
                     "timed_out": i == 11, "effect": "dug stone above"} for i in range(12)]
            (Path(d) / "player-2026-11-04.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
            out = player_tail(Path(d), day="2026-11-04").splitlines()
            self.assertEqual(len(out), 10, "the last 10")
            self.assertEqual(out[0], "10:00:02.000 play    dig_above              19.2 ms  dug stone above")
            self.assertIn("TIMEOUT", out[-1])
