import unittest

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
