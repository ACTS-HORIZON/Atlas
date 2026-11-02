"""The mind loop against a fake body over the real link protocol (a WebSocket
speaking contract messages), with a scripted FakeLLM. No server, no model."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from websockets.asyncio.server import serve

from atlas_mind.actions import ActionError, parse
from atlas_mind.config import ROOT, Config
from atlas_mind.llm import FakeLLM
from atlas_mind.loop import Mind
from atlas_mind.notes import Notes
from atlas_mind.render import render_obs
from atlas_mind.replay import replay


def make_obs(t=100, health=20, inventory=None, task=None):
    return {"type": "obs", "v": "0.1", "t": t,
            "self": {"pos": [0.5, 64, 0.5], "dim": "overworld", "yaw": 0, "pitch": 0, "health": health, "food": 20, "xp": 0,
                     "on_ground": True, "in_water": False, "held": None, "armor": [], "effects": [], "gamemode": "survival"},
            "inventory": inventory or {}, "world": {"time": "day", "weather": "clear", "light": 15, "biome": "plains"},
            "blocks_seen": [{"type": "oak_log", "pos": [3, 64, 5], "dist": 5.8}, {"type": "oak_log", "pos": [4, 65, 5], "dist": 6.4}],
            "entities": [{"type": "cow", "rel": [5, 0, 2], "dist": 5.4, "bearing": "front-left", "approaching": False, "hostile": False}],
            "players": [{"name": "ACTS_HORIZON", "pos": [2.5, 64, -3.5], "dist": 4.5, "looking_at": [3, 64, 5]}],
            "sounds": [], "boss_bar": None, "chat": [], "task": task}


class FakeBody:
    """Speaks the link: obs on connect and on observe, a result for every call
    (from respond(call) -> (status, detail, data) or None to hold it)."""

    def __init__(self, respond=None):
        self.respond = respond or (lambda c: ("done", f"{c['verb']} ok", None))
        self.received: list[dict] = []
        self.ws = None
        self.held: list[dict] = []

    async def start(self):
        self.server = await serve(self.handler, "127.0.0.1", 0)
        return f"ws://127.0.0.1:{self.server.sockets[0].getsockname()[1]}"

    async def handler(self, ws):
        self.ws = ws
        await ws.send(json.dumps(make_obs()))
        async for data in ws:
            m = json.loads(data)
            self.received.append(m)
            if m["type"] == "observe":
                await ws.send(json.dumps(make_obs()))
            elif m["type"] == "call":
                r = self.respond(m)
                if r is None:
                    self.held.append(m)
                else:
                    await self.result(m["id"], *r)

    async def result(self, cid, status, detail, data=None):
        msg = {"type": "result", "v": "0.1", "id": cid, "status": status, "detail": detail, "obs": make_obs()}
        if data:
            msg["data"] = data
        await self.ws.send(json.dumps(msg))

    async def event(self, kind, detail):
        await self.ws.send(json.dumps({"type": "event", "v": "0.1", "kind": kind, "detail": detail, "obs": make_obs()}))

    def calls(self):
        return [m for m in self.received if m["type"] == "call"]

    def stop(self):
        self.server.close()


async def until(pred, timeout=3.0):
    end = asyncio.get_running_loop().time() + timeout
    while not pred():
        if asyncio.get_running_loop().time() > end:
            raise AssertionError("timed out waiting for a condition")
        await asyncio.sleep(0.02)


class MindTest(unittest.IsolatedAsyncioTestCase):
    async def start(self, script, respond=None, **cfg):
        self.tmp = tempfile.TemporaryDirectory()
        self.body = FakeBody(respond)
        url = await self.body.start()
        self.llm = FakeLLM(script)
        self.cfg = Config(link_url=url, idle_s=cfg.pop("idle_s", 0.2), ask_timeout_s=cfg.pop("ask_timeout_s", 30),
                          notes_file=Path(self.tmp.name) / "notes.md", verb_reference=ROOT / "docs" / "verbs.md", **cfg)
        self.mind = Mind(self.cfg, self.llm, log=lambda *_: None)
        self.task = asyncio.create_task(self.mind.run())
        await until(lambda: self.body.ws is not None and self.mind.obs is not None)

    async def asyncTearDown(self):
        self.task.cancel()
        try:
            await self.task
        except (asyncio.CancelledError, Exception):
            pass
        self.body.stop()
        self.tmp.cleanup()

    def prompt_text(self, i):
        return self.llm.prompts[i][-1]["content"]

    async def test_task_confirm_chain_done(self):
        await self.start([
            {"thinking": "Collin wants logs; confirm first.", "action": "say", "text": "On it: 3 oak logs.", "task": {"id": "t1", "state": "active"}},
            {"thinking": "Two oak logs are in view; mine them.", "action": "call", "verb": "mine", "args": {"block": "oak_log", "count": 3}},
            {"thinking": "Mined 3; report and close the task.", "action": "say", "text": "Done: 3 oak logs.", "task": {"id": "t1", "state": "done"}},
        ], respond=lambda c: ("done", "mined 3 oak_log", {"block": "oak_log", "mined": 3, "requested": 3, "tunnel": 0}) if c["verb"] == "mine" else ("done", "said", None))
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "get me 3 oak logs"})
        await until(lambda: len(self.body.calls()) >= 3)
        calls = [(c["verb"], c["args"]) for c in self.body.calls()[:3]]
        self.assertEqual(calls, [("say", {"text": "On it: 3 oak logs."}), ("mine", {"block": "oak_log", "count": 3}), ("say", {"text": "Done: 3 oak logs."})])
        # every action is preceded by its thinking as a decision trace
        seq = [m for m in self.body.received if m["type"] in ("trace", "call")][:6]
        self.assertEqual([m["type"] for m in seq], ["trace", "call"] * 3)
        self.assertEqual(seq[0]["kind"], "decision")
        self.assertEqual(seq[0]["text"], "Collin wants logs; confirm first.")
        self.assertEqual(seq[0]["v"], "0.1")
        self.assertEqual(self.mind.tasks.get("t1").state, "done")
        # the first prompt carried the task, the compact obs and the verb reference
        self.assertIn("new task t1 from ACTS_HORIZON: get me 3 oak logs", self.prompt_text(0))
        self.assertIn("blocks seen: oak_log x2", self.prompt_text(0))
        self.assertIn("### mine {block", self.llm.prompts[0][0]["content"])
        self.assertIn("result m2 (mine): done", self.prompt_text(2))

    async def test_failed_call_is_not_repeated(self):
        fail = "mine: iron_ore needs one of: stone_pickaxe, iron_pickaxe; none in inventory"
        await self.start([
            {"thinking": "Iron is needed.", "action": "call", "verb": "mine", "args": {"block": "iron_ore", "count": 3}},
            {"thinking": "Try again.", "action": "call", "verb": "mine", "args": {"count": 3, "block": "iron_ore"}},
            {"thinking": "I need a stone pickaxe first.", "action": "call", "verb": "craft", "args": {"item": "stone_pickaxe"}},
        ], respond=lambda c: ("failed", fail, None) if c["verb"] == "mine" else ("failed", "craft: missing 3 cobblestone for 1 stone_pickaxe", None))
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "get iron"})
        await until(lambda: len(self.body.calls()) >= 2)
        self.assertEqual([c["verb"] for c in self.body.calls()[:2]], ["mine", "craft"], "the failed mine was not sent again")
        retry = self.llm.prompts[2][-1]["content"]
        self.assertIn("just failed with: " + fail, retry)
        self.assertIn("LAST FAILED CALL: mine", self.prompt_text(1))

    async def test_ask_player_round_trip(self):
        await self.start([
            {"thinking": "Which chest is unclear; ask.", "action": "ask_player", "player": "ACTS_HORIZON", "text": "Which chest, the one by spawn?"},
            {"thinking": "He answered; confirm.", "action": "say", "text": "OK, the chest by spawn."},
        ])
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "put the iron in the chest"})
        await until(lambda: len(self.body.calls()) >= 1)
        self.assertEqual(self.body.calls()[0]["args"], {"text": "Which chest, the one by spawn?"})
        await asyncio.sleep(0.4)  # say's result wakes it once; then idle wakes are skipped while waiting for the answer
        n = len(self.llm.prompts)
        await asyncio.sleep(0.7)
        self.assertEqual(len(self.llm.prompts), n, "no model calls while waiting for the answer")
        await self.body.event("player_said", {"from": "ACTS_HORIZON", "text": "yes, the one by spawn"})
        await until(lambda: any("answered your question: yes, the one by spawn" in p[-1]["content"] for p in self.llm.prompts))
        self.assertIsNone(self.mind.asking)

    async def test_ask_player_timeout(self):
        await self.start([{"thinking": "Ask.", "action": "ask_player", "player": "ACTS_HORIZON", "text": "How many?"}], ask_timeout_s=0.5)
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "get wood"})
        await until(lambda: any("no answer from ACTS_HORIZON" in p[-1]["content"] for p in self.llm.prompts), timeout=4)

    async def test_stop_clears_the_task(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "On it.", "task": {"id": "t1", "state": "active", "standing": True}},
            {"thinking": "Mine.", "action": "call", "verb": "mine", "args": {"block": "coal_ore", "count": 64}},
        ], respond=lambda c: None if c["verb"] == "mine" else ("done", "said", None))
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "keep mining coal"})
        await until(lambda: self.body.held)
        self.assertTrue(self.mind.tasks.get("t1").standing)
        await self.body.event("stop_requested", {"from": "ACTS_HORIZON", "detail": "stopped mine"})
        await self.body.result(self.body.held[0]["id"], "interrupted", "mine: stopped by ACTS_HORIZON in chat (at: 2/64 coal_ore)")
        await until(lambda: any("stop requested by ACTS_HORIZON; task t1 stopped" in p[-1]["content"] for p in self.llm.prompts))
        self.assertEqual(self.mind.tasks.get("t1").state, "stopped")
        self.assertIsNone(self.mind.tasks.active())

    async def test_parse_failure_retry(self):
        await self.start(["Sure! I will mine some wood.", {"thinking": "Say hi.", "action": "say", "text": "hi"}])
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "say hi"})
        await until(lambda: self.body.calls())
        self.assertEqual(self.body.calls()[0]["args"], {"text": "hi"})
        self.assertIn("That reply was not usable: no JSON object in the reply", self.llm.prompts[1][-1]["content"])
        self.assertEqual(self.llm.prompts[1][-2], {"role": "assistant", "content": "Sure! I will mine some wood."})

    async def test_two_bad_replies_wait(self):
        await self.start(["nope", '{"action": "dance", "thinking": "x"}'])
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "dance"})
        await until(lambda: self.mind.decisions)
        self.assertEqual(self.mind.decisions[0]["action"], "wait")
        self.assertEqual(self.body.calls(), [])
        trace = next(m for m in self.body.received if m["type"] == "trace")
        self.assertIn('"action" must be one of', trace["text"])

    async def test_low_health_wakes_it(self):
        await self.start([{"thinking": "Hurt; back off.", "action": "call", "verb": "goto", "args": {"pos": [-10, 64, -10]}}])
        await self.body.ws.send(json.dumps(make_obs(health=4)))
        await until(lambda: self.body.calls())
        self.assertIn("health is low (4/20)", self.prompt_text(0))
        self.assertIn("If health drops below 6, you may goto away", self.llm.prompts[0][0]["content"])


class UnitTest(unittest.TestCase):
    def test_actions(self):
        verbs = {"mine", "say"}
        a = parse('```json\n{"thinking": "t", "action": "call", "verb": "mine", "args": {"block": "stone"}}\n```', verbs)
        self.assertEqual(a, {"action": "call", "thinking": "t", "verb": "mine", "args": {"block": "stone"}})
        for bad, msg in [('{"action": "call", "thinking": "t"}', "needs \"verb\""), ('{"action": "fly", "thinking": "t"}', "must be one of"),
                         ('{"action": "say"}', '"thinking"'), ('{"action": "call", "thinking": "t", "verb": "smelt"}', 'unknown verb "smelt"'),
                         ('[1, 2]', "one JSON object"), ('{"thinking": "t", "action": "wait", "task": {"id": "t1", "state": "finished"}}', 'task "state"')]:
            with self.assertRaises(ActionError) as cm:
                parse(bad, verbs)
            self.assertIn(msg, str(cm.exception))

    def test_notes_capped_and_persistent(self):
        with tempfile.TemporaryDirectory() as d:
            n = Notes(Path(d) / "notes.md", max_lines=3)
            for i in range(5):
                n.append(f"note {i}")
            again = Notes(Path(d) / "notes.md", max_lines=3)
            self.assertEqual([line.split(" ", 3)[-1] for line in again.lines], ["note 2", "note 3", "note 4"])
            self.assertEqual(again.dropped, 2)
            self.assertIn("(2 older notes dropped)", again.render())

    def test_render_obs_is_compact(self):
        o = make_obs(inventory={f"item_{i}": i + 1 for i in range(20)})
        o["blocks_seen"] = [{"type": f"type_{i % 9}", "pos": [i, 60, i], "dist": float(i)} for i in range(48)]
        o["entities"] = [{"type": "zombie", "rel": [i, 0, 1], "dist": float(i), "bearing": "front", "approaching": True, "hostile": True} for i in range(20)]
        o["players"].append({"name": "Far", "bearing": "behind"})
        text = render_obs(o)
        self.assertLess(len(text) / 4, 450, "a few hundred tokens at most")
        self.assertIn("player Far out of sight, bearing behind", text)
        self.assertNotIn('"blocks_seen"', text)

    def test_replay_feeds_recorded_logs(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "link.jsonl"
            lines = [{"ts": "t0", "dir": "out", "msg": make_obs(t=t)} for t in range(1, 5)]
            lines.append({"ts": "t1", "dir": "out", "msg": {"type": "event", "v": "0.1", "kind": "task_from_chat", "detail": {"from": "ACTS_HORIZON", "text": "get wood"}, "obs": make_obs(t=5)}})
            lines.append({"ts": "t2", "dir": "in", "msg": {"type": "call", "v": "0.1", "id": "m1", "verb": "mine", "args": {"block": "oak_log", "count": 3}}})
            lines.append({"ts": "t3", "dir": "out", "msg": {"type": "result", "v": "0.1", "id": "m1", "status": "done", "detail": "mined 3 oak_log", "obs": make_obs(t=9)}})
            log.write_text("\n".join(json.dumps(x) for x in lines) + "\n")
            llm = FakeLLM([])
            cfg = Config(notes_file=Path(d) / "notes.md", verb_reference=ROOT / "docs" / "verbs.md")
            out = []
            n = asyncio.run(replay(Mind(cfg, llm, log=lambda *_: None), [str(log)], every=2, limit=10, out=out.append))
            self.assertEqual(n, 4)  # obs 2 and 4, the event, the result
            self.assertIn("new task t1 from ACTS_HORIZON: get wood", llm.prompts[2][-1]["content"])
            self.assertIn("you called mine", llm.prompts[3][-1]["content"])
            self.assertIn("result m1 (mine): done", llm.prompts[3][-1]["content"])


if __name__ == "__main__":
    unittest.main()


class LLMClientTest(unittest.TestCase):
    def test_openai_compatible_request_and_errors(self):
        import http.server
        import threading
        from atlas_mind.llm import LLMError, OpenAICompatLLM
        seen = {}

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                seen["path"] = self.path
                seen["auth"] = self.headers.get("authorization")
                seen["body"] = json.loads(self.rfile.read(int(self.headers["content-length"])))
                code, reply = (500, b"boom") if seen["body"]["model"] == "broken" else (200, json.dumps({"choices": [{"message": {"content": '{"action": "wait", "thinking": "ok"}'}}]}).encode())
                self.send_response(code)
                self.end_headers()
                self.wfile.write(reply)

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_port}/v1"
        try:
            llm = OpenAICompatLLM(base, "gemma-3-12b", key="k123", temperature=0.2, max_tokens=99)
            out = asyncio.run(llm.complete([{"role": "user", "content": "hi"}]))
            self.assertEqual(out, '{"action": "wait", "thinking": "ok"}')
            self.assertEqual(seen["path"], "/v1/chat/completions")
            self.assertEqual(seen["auth"], "Bearer k123")
            self.assertEqual(seen["body"], {"model": "gemma-3-12b", "messages": [{"role": "user", "content": "hi"}], "temperature": 0.2,
                                            "max_tokens": 99, "response_format": {"type": "json_object"}})
            with self.assertRaises(LLMError):
                asyncio.run(OpenAICompatLLM(base, "broken").complete([]))
            with self.assertRaises(LLMError):
                asyncio.run(OpenAICompatLLM("http://127.0.0.1:1/v1", "x", timeout_s=2).complete([]))
        finally:
            srv.shutdown()
            srv.server_close()

    def test_config_from_env(self):
        c = Config.from_env({"ATLAS_ENV_FILE": "/nonexistent", "ATLAS_LINK_PORT": "9000", "ATLAS_LLM_URL": "http://gpu:8080/v1/",
                             "ATLAS_LLM_JSON_MODE": "0", "ATLAS_PLAYERS": "A, B", "ATLAS_NOTES_FILE": "/tmp/n.md", "ATLAS_IDLE_S": "5"})
        self.assertEqual((c.link_url, c.llm_url, c.llm_json_mode, c.players, str(c.notes_file), c.idle_s),
                         ("ws://127.0.0.1:9000", "http://gpu:8080/v1", False, ["A", "B"], "/tmp/n.md", 5.0))
