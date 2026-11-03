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
            {"thinking": "Collin wants logs; confirm first.", "action": "say", "text": "On it: 3 oak logs.", "about": "t1"},
            {"thinking": "Two oak logs are in view; mine them.", "action": "call", "verb": "mine", "args": {"block": "oak_log", "count": 3}, "about": "t1"},
            {"thinking": "Mined 3; report and close the task.", "action": "say", "text": "Done: 3 oak logs.", "closes": "t1"},
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
        self.assertIn('t1 [running] from ACTS_HORIZON: get me 3 oak logs\n    you said: "On it: 3 oak logs."', self.prompt_text(2))
        await asyncio.sleep(0.6)
        self.assertEqual(len(self.llm.prompts), 3, "closed: no more turns without new input")

    async def test_failed_call_is_not_repeated(self):
        fail = "mine: iron_ore needs one of: stone_pickaxe, iron_pickaxe; none in inventory"
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "On it.", "about": "t1"},
            {"thinking": "Iron is needed.", "action": "call", "verb": "mine", "args": {"block": "iron_ore", "count": 3}, "about": "t1"},
            {"thinking": "Try again.", "action": "call", "verb": "mine", "args": {"count": 3, "block": "iron_ore"}, "about": "t1"},
            {"thinking": "I need a stone pickaxe first.", "action": "call", "verb": "craft", "args": {"item": "stone_pickaxe"}, "about": "t1"},
        ], respond=lambda c: ("failed", fail, None) if c["verb"] == "mine" else ("failed", "craft: missing 3 cobblestone for 1 stone_pickaxe", None))
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "get iron"})
        await until(lambda: len(self.body.calls()) >= 3)
        self.assertEqual([c["verb"] for c in self.body.calls()[:3]], ["say", "mine", "craft"], "the failed mine was not sent again")
        retry = self.llm.prompts[3][-1]["content"]
        self.assertIn("just failed with: " + fail, retry)
        self.assertIn("LAST FAILED CALL: mine", self.prompt_text(2))

    async def test_ask_player_round_trip(self):
        await self.start([
            {"thinking": "Which chest is unclear; ask.", "action": "ask_player", "player": "ACTS_HORIZON", "text": "Which chest, the one by spawn?", "about": "t1"},
            {"thinking": "He answered; confirm.", "action": "say", "text": "OK, the chest by spawn.", "about": "t1"},
        ])
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "put the iron in the chest"})
        await until(lambda: len(self.body.calls()) >= 1)
        self.assertEqual(self.body.calls()[0]["args"], {"text": "Which chest, the one by spawn?"})
        await asyncio.sleep(1.0)
        self.assertEqual(len(self.llm.prompts), 1, "no model calls while waiting for the answer")
        await self.body.event("player_said", {"from": "ACTS_HORIZON", "text": "yes, the one by spawn"})
        await until(lambda: any("answered your question: yes, the one by spawn" in p[-1]["content"] for p in self.llm.prompts))
        self.assertIsNone(self.mind.asking)

    async def test_ask_player_timeout(self):
        await self.start([{"thinking": "Ask.", "action": "ask_player", "player": "ACTS_HORIZON", "text": "How many?"}], ask_timeout_s=0.5)
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "get wood"})
        await until(lambda: any("no answer from ACTS_HORIZON" in p[-1]["content"] for p in self.llm.prompts), timeout=4)

    async def test_stop_clears_the_task(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "On it.", "about": "t1", "standing": True},
            {"thinking": "Mine.", "action": "call", "verb": "mine", "args": {"block": "coal_ore", "count": 64}, "about": "t1"},
        ], respond=lambda c: None if c["verb"] == "mine" else ("done", "said", None))
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "keep mining coal"})
        await until(lambda: self.body.held)
        self.assertTrue(self.mind.tasks.get("t1").standing)
        await self.body.event("stop_requested", {"from": "ACTS_HORIZON", "detail": "stopped mine"})
        await self.body.result(self.body.held[0]["id"], "interrupted", "mine: stopped by ACTS_HORIZON in chat (at: 2/64 coal_ore)")
        await until(lambda: any("stop requested by ACTS_HORIZON; t1 stopped" in p[-1]["content"] for p in self.llm.prompts))
        self.assertEqual(self.mind.tasks.get("t1").state, "stopped")
        self.assertEqual(self.mind.tasks.working(), [])

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

    async def test_question_gets_exactly_one_reply(self):
        await self.start([{"thinking": "A greeting; answer once.", "action": "say", "text": "Doing well, thanks!", "closes": "t1"}], idle_s=0.1)
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "how are you?"})
        await until(lambda: self.body.calls())
        for _ in range(10):  # the say's result and its obs come back; idle ticks pass
            await self.body.ws.send(json.dumps(make_obs()))
            await asyncio.sleep(0.15)
        self.assertEqual(len(self.llm.prompts), 1, "exactly one decision")
        self.assertEqual([c["verb"] for c in self.body.calls()], ["say"])
        self.assertEqual(self.mind.tasks.get("t1").state, "done")

    async def test_confirmed_task_is_never_reconfirmed(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "On it: 8 spruce logs.", "about": "t1"},
            {"thinking": "Confirm again.", "action": "say", "text": "Sure, on it!", "about": "t1"},
            {"thinking": "Start: mine spruce.", "action": "call", "verb": "mine", "args": {"block": "spruce_log", "count": 8}, "about": "t1"},
        ], respond=lambda c: None if c["verb"] == "mine" else ("done", "said", None))
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "bring me 8 spruce logs"})
        await until(lambda: len(self.body.calls()) >= 2)
        self.assertEqual([c["verb"] for c in self.body.calls()], ["say", "mine"])
        self.assertIn('t1 is already confirmed (you said: "On it: 8 spruce logs.")', self.llm.prompts[2][-1]["content"])
        self.assertEqual(self.mind.tasks.get("t1").state, "running")

    async def test_work_on_a_new_task_starts_with_confirming(self):
        await self.start([
            {"thinking": "Just go.", "action": "call", "verb": "mine", "args": {"block": "spruce_log", "count": 8}, "about": "t1"},
            {"thinking": "Confirm first.", "action": "say", "text": "On it.", "about": "t1"},
        ])
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "bring me 8 spruce logs"})
        await until(lambda: self.body.calls())
        self.assertEqual(self.body.calls()[0]["verb"], "say")
        self.assertIn("t1 is new: confirm it in chat first", self.llm.prompts[1][-1]["content"])

    async def test_idle_with_nothing_changed_makes_no_model_calls(self):
        await self.start([{"thinking": "Inventory changed; note it.", "action": "wait"}], idle_s=0.05)
        for _ in range(60):  # 60 idle ticks (10 minutes at the default 10 s), the same obs every few
            await self.body.ws.send(json.dumps(make_obs()))
            await asyncio.sleep(0.05)
        self.assertEqual(len(self.llm.prompts), 0)
        await self.body.ws.send(json.dumps(make_obs(inventory={"spruce_log": 8})))  # a meaningful change
        await until(lambda: len(self.llm.prompts) == 1)
        self.assertIn("WOKE BECAUSE: idle, something changed since your last turn", self.prompt_text(0))
        await asyncio.sleep(0.6)
        self.assertEqual(len(self.llm.prompts), 1, "one turn per change")

    async def test_truncated_reply_logs_raw_and_finish_reason(self):
        logs = []
        await self.start([('{"thinking": "I will go and get the wood from the forest to the', "length"),
                          ('```json\n{"thinking": "Still going on and on', "length")])
        self.mind.log = logs.append
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "get wood"})
        await until(lambda: self.mind.decisions)
        self.assertEqual(self.mind.decisions[0]["action"], "wait")
        text = "\n".join(logs)
        self.assertIn("unusable reply (first try, finish_reason=length): the reply was cut off before its JSON object closed", text)
        self.assertIn("raw reply: '{\"thinking\": \"I will go and get the wood from the forest to the'", text)
        self.assertIn("unusable reply (retry, finish_reason=length)", text)

    async def test_prose_and_fenced_json_is_used(self):
        await self.start(['Sure! Here is my decision:\n```json\n{"thinking": "Answer.", "action": "say", "text": "hi", "closes": "t1"}\n```\nLet me know!'])
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "hello"})
        await until(lambda: self.body.calls())
        self.assertEqual(self.body.calls()[0]["args"], {"text": "hi"})
        self.assertEqual(len(self.llm.prompts), 1, "parsed on the first try")

    async def test_plan_runs_three_steps_with_one_model_call(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "On it: a stone pickaxe.", "about": "t1"},
            {"thinking": "Obvious next steps.", "action": "plan", "about": "t1", "steps": [
                {"verb": "craft", "args": {"item": "stick", "count": 4}},
                {"verb": "craft", "args": {"item": "stone_pickaxe"}},
                {"verb": "equip", "args": {"item": "stone_pickaxe"}}]},
            {"thinking": "Done; report.", "action": "say", "text": "Here is my stone pickaxe.", "closes": "t1"},
        ])
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "make a stone pickaxe"})
        await until(lambda: len(self.body.calls()) >= 5)
        self.assertEqual([c["verb"] for c in self.body.calls()], ["say", "craft", "craft", "equip", "say"])
        self.assertEqual(len(self.llm.prompts), 3, "confirm, one plan, the report: the plan's 3 steps cost one model call")
        self.assertIn("plan finished (3 steps)", self.prompt_text(2))
        for i in ("m2", "m3", "m4"):  # every step's result is in the history as usual
            self.assertIn(f"result {i}: done", self.prompt_text(2))
        trace = [m for m in self.body.received if m["type"] == "trace"][1]
        self.assertEqual([st["verb"] for st in trace["data"]["steps"]], ["craft", "craft", "equip"])
        self.assertEqual(self.mind.tasks.get("t1").state, "done")

    async def test_failed_plan_step_stops_the_plan_and_rethinks_once(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "On it.", "about": "t1"},
            {"thinking": "Craft then mine.", "action": "plan", "about": "t1", "steps": [
                {"verb": "craft", "args": {"item": "stick", "count": 4}},
                {"verb": "craft", "args": {"item": "stone_pickaxe"}},
                {"verb": "mine", "args": {"block": "iron_ore", "count": 3}}]},
            {"thinking": "Need cobblestone first.", "action": "call", "verb": "mine", "args": {"block": "stone", "count": 3}, "about": "t1"},
        ], respond=lambda c: ("failed", "craft: missing 3 of cobbled_deepslate, blackstone or cobblestone for 1 stone_pickaxe", None)
           if c["args"].get("item") == "stone_pickaxe" else None if c["args"].get("block") == "stone" else ("done", "ok", None))
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "get iron"})
        await until(lambda: len(self.body.calls()) >= 4)
        await asyncio.sleep(0.3)
        self.assertEqual([(c["verb"], c["args"].get("item") or c["args"].get("block")) for c in self.body.calls()],
                         [("say", None), ("craft", "stick"), ("craft", "stone_pickaxe"), ("mine", "stone")], "step 3 never ran")
        self.assertEqual(len(self.llm.prompts), 3, "one re-think after the failed step")
        self.assertIn("plan stopped at step 2/3 (craft): failed - craft: missing 3 of", self.prompt_text(2))

    async def test_task_from_chat_mid_plan_stops_it_after_the_current_step(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "On it.", "about": "t1"},
            {"thinking": "Three crafts.", "action": "plan", "about": "t1", "steps": [
                {"verb": "craft", "args": {"item": "oak_planks", "count": 4}},
                {"verb": "craft", "args": {"item": "stick", "count": 4}},
                {"verb": "craft", "args": {"item": "crafting_table"}}]},
            {"thinking": "Answer the new question.", "action": "say", "text": "Crafting.", "closes": "t2"},
        ], respond=lambda c: None if c["verb"] == "craft" else ("done", "said", None))
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "make a table"})
        await until(lambda: self.body.held)  # step 1 is running
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "what are you doing?"})
        await asyncio.sleep(0.3)
        self.assertEqual(len(self.llm.prompts), 2, "the event waits for the current step")
        await self.body.result(self.body.held[0]["id"], "done", "crafted 4 oak_planks")
        await until(lambda: len(self.llm.prompts) == 3)
        self.assertIn("plan stopped after step 1/3; new task t2 from ACTS_HORIZON: what are you doing?", self.prompt_text(2))
        await asyncio.sleep(0.3)
        self.assertEqual([c["args"].get("item") for c in self.body.calls() if c["verb"] == "craft"], ["oak_planks"], "steps 2 and 3 never ran")

    async def test_unusable_decision_retries_on_idle_then_waits(self):
        logs = []
        bad = ("I am thinking about it", "stop")
        await self.start([bad] * 8, idle_s=0.1)
        self.mind.log = logs.append
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "get wood"})
        await until(lambda: len(self.mind.decisions) >= 4, timeout=5)  # the turn, then 3 retries with nothing changing
        await asyncio.sleep(0.8)
        self.assertEqual(len(self.mind.decisions), 4, "1 turn + 3 retries, then it waits")
        self.assertEqual(len(self.llm.prompts), 8, "each turn: one try and one in-turn retry")
        self.assertIn("WOKE BECAUSE: retrying after an unusable decision (1/3)", self.prompt_text(2))
        self.assertIn("WOKE BECAUSE: retrying after an unusable decision (3/3)", self.prompt_text(6))
        self.assertTrue(any("3 retries after unusable decisions failed; waiting for something to change" in line for line in logs))
        # a change in the world brings it back
        self.llm.script = [{"thinking": "Confirm.", "action": "say", "text": "On it.", "about": "t1"}]
        await self.body.ws.send(json.dumps(make_obs(inventory={"oak_log": 1})))
        await until(lambda: self.body.calls())
        self.assertEqual(self.mind.error_streak, 0)

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
                         ('[1, 2]', "no JSON object"), ('{"thinking": "t", "action": "call", "verb": "mine", "closes": "t1"}', '"closes" goes on a say'),
                         ('{"thinking": "t", "action": "done"}', '"done" needs "closes"'), ('{"thinking": "I will go and get the wo', "cut off")]:
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
                model = seen["body"]["model"]
                if model == "broken":
                    code, reply = 500, b"boom"
                elif model == "cut":  # pretty JSON, generation stopped on "\n}" (not included)
                    content = '{\n  "thinking": "hi",\n  "action": "say",\n  "text": "x",\n  "about": "t1"\n'
                    code, reply = 200, json.dumps({"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}).encode()
                else:
                    code, reply = 200, json.dumps({"choices": [{"message": {"content": '{"action": "wait", "thinking": "ok"}'}, "finish_reason": "stop"}]}).encode()
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
            self.assertEqual(out.finish_reason, "stop")
            self.assertEqual(seen["path"], "/v1/chat/completions")
            self.assertEqual(seen["auth"], "Bearer k123")
            self.assertEqual(seen["body"], {"model": "gemma-3-12b", "messages": [{"role": "user", "content": "hi"}], "temperature": 0.2,
                                            "max_tokens": 99, "response_format": {"type": "json_object"}, "stop": ["\n}"],
                                            "chat_template_kwargs": {"enable_thinking": False}, "reasoning_effort": "none"})
            # stopped on the closing brace: the brace is put back and the object parses
            cut = OpenAICompatLLM(base, "cut")
            r = asyncio.run(cut.complete([]))
            self.assertEqual(seen["body"]["max_tokens"], 2000, "the default")
            self.assertEqual(parse(r), {"action": "say", "thinking": "hi", "text": "x", "about": "t1"})
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


class ThinkingTest(unittest.TestCase):
    """Native thinking (Gemma 4 on llama.cpp): a live-shaped server that
    behaves like llama.cpp, adding reasoning_content unless the request turns
    thinking off with chat_template_kwargs.enable_thinking=false or
    reasoning_effort "none"."""

    def serve(self):
        import http.server
        import threading
        seen = []

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                seen.append(body)
                off = (body.get("chat_template_kwargs") or {}).get("enable_thinking") is False or body.get("reasoning_effort") == "none"
                msg = {"role": "assistant", "content": '{"thinking": "Logs are close; mine them.", "action": "wait"}'}
                if not off:
                    msg["reasoning_content"] = "The player wants logs. I see oak_log at 11 blocks. " * 20
                reply = {"choices": [{"finish_reason": "stop", "index": 0, "message": msg}], "created": 1793701234,
                         "model": "gemma-4-26b-a4b", "system_fingerprint": "b7210-0a1b2c3d", "object": "chat.completion",
                         "usage": {"completion_tokens": 70 if off else 748, "prompt_tokens": 4210, "total_tokens": 4280 if off else 4958},
                         "id": "chatcmpl-Q2w3e4r5", "timings": {"prompt_n": 4210, "predicted_n": 70 if off else 748}}
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(reply).encode())

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (srv.shutdown(), srv.server_close()))
        return f"http://127.0.0.1:{srv.server_port}/v1", seen

    def test_thinking_off_by_default_and_reasoning_absent(self):
        from atlas_mind.llm import OpenAICompatLLM
        base, seen = self.serve()
        self.assertFalse(Config.from_env({"ATLAS_ENV_FILE": "/nonexistent"}).llm_thinking, "off by default")
        r = asyncio.run(OpenAICompatLLM(base, "gemma-4-26b-a4b").complete([{"role": "user", "content": "hi"}]))
        self.assertEqual(seen[0]["chat_template_kwargs"], {"enable_thinking": False})
        self.assertEqual(seen[0]["reasoning_effort"], "none")
        self.assertEqual(r.reasoning, "", "reasoning_content absent")
        self.assertEqual(r.completion_tokens, 70)

    def test_thinking_on_is_never_invisible(self):
        from atlas_mind.llm import OpenAICompatLLM
        base, seen = self.serve()
        r = asyncio.run(OpenAICompatLLM(base, "gemma-4-26b-a4b", thinking=True).complete([{"role": "user", "content": "hi"}]))
        self.assertNotIn("chat_template_kwargs", seen[0])
        self.assertNotIn("reasoning_effort", seen[0])
        self.assertTrue(r.reasoning.startswith("The player wants logs."))
        self.assertEqual(r.completion_tokens, 748)

        async def scenario():
            body = FakeBody()
            url = await body.start()
            with tempfile.TemporaryDirectory() as d:
                logs = []
                cfg = Config(link_url=url, idle_s=0.1, notes_file=Path(d) / "n.md", verb_reference=ROOT / "docs" / "verbs.md", llm_thinking=False)
                llm = FakeLLM([r, ('{"thinking": "x", "action": "wait"}', "stop", "", 12)])
                mind = Mind(cfg, llm, log=logs.append)
                task = asyncio.create_task(mind.run())
                await until(lambda: body.ws is not None and mind.obs is not None)
                await body.event("player_said", {"from": "ACTS_HORIZON", "text": "hi"})
                await until(lambda: any(m["type"] == "trace" for m in body.received))
                await body.event("player_said", {"from": "ACTS_HORIZON", "text": "again"})
                await until(lambda: len(mind.decisions) >= 2)
                task.cancel()
                body.stop()
                return body, logs
        body, logs = asyncio.run(scenario())
        trace = next(m for m in body.received if m["type"] == "trace")
        self.assertTrue(trace["data"]["reasoning"].startswith("The player wants logs."))
        self.assertTrue(trace["data"]["reasoning"].endswith("…"), "truncated")
        self.assertLessEqual(len(trace["data"]["reasoning"]), 801)
        text = "\n".join(logs)
        self.assertIn("[llm] turn 1: 748 completion tokens in 1 call(s) (with reasoning); mean 748 over 1 turns, 1 with reasoning", text)
        self.assertIn("[llm] turn 2: 12 completion tokens in 1 call(s); mean 380 over 2 turns, 1 with reasoning", text)
        self.assertIn("reasoning_content came back although ATLAS_LLM_THINKING=0", text)
