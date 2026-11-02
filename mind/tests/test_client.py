import unittest

from atlas_mind.__main__ import parse_command
from atlas_mind.pretty import format_obs


class ParseTest(unittest.TestCase):
    def test_commands(self):
        ids = iter(["c1", "c2"])
        nid = lambda: next(ids)  # noqa: E731
        self.assertEqual(parse_command("say hello there", nid),
                         {"type": "call", "v": "0.1", "id": "c1", "verb": "say", "args": {"text": "hello there"}})
        self.assertEqual(parse_command("stop", nid)["verb"], "stop")
        self.assertEqual(parse_command("obs", nid), {"type": "observe", "v": "0.1"})
        self.assertEqual(parse_command("quit", nid), "quit")
        self.assertIsNone(parse_command("   ", nid))
        self.assertTrue(parse_command("dance", nid).startswith("commands"))
        self.assertTrue(parse_command("say", nid).startswith("usage"))


class PrettyTest(unittest.TestCase):
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
