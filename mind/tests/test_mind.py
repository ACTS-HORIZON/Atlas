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
from atlas_mind.render import render_obs, render_surroundings
from atlas_mind.replay import replay


def make_obs(t=100, health=20, inventory=None, task=None, chat=None, pos=None):
    return {"type": "obs", "v": "0.1", "t": t,
            "self": {"pos": pos or [0.5, 64, 0.5], "dim": "overworld", "yaw": 0, "pitch": 0, "health": health, "food": 20, "xp": 0,
                     "on_ground": True, "in_water": False, "held": None, "armor": [], "effects": [], "gamemode": "survival"},
            "inventory": inventory or {}, "world": {"time": "day", "weather": "clear", "light": 15, "biome": "plains"},
            "blocks_seen": [{"type": "oak_log", "pos": [3, 64, 5], "dist": 5.8}, {"type": "oak_log", "pos": [4, 65, 5], "dist": 6.4}],
            "entities": [{"type": "cow", "rel": [5, 0, 2], "dist": 5.4, "bearing": "front-left", "approaching": False, "hostile": False}],
            "players": [{"name": "ACTS_HORIZON", "pos": [2.5, 64, -3.5], "dist": 4.5, "looking_at": [3, 64, 5]}],
            "sounds": [], "boss_bar": None, "chat": chat or [], "task": task}


STUCK = 'gave up 13.3 blocks short of [9, 64, 9] (stuck: feet air, head air, below spruce_log; in front: spruce_leaves (would dig) at [-13, 76, -10]; dig on, scaffold on; last plan: partial, no next step)'


class FakeBody:
    """Speaks the link: obs on connect and on observe, a result for every call
    (from respond(call) -> (status, detail, data) or None to hold it)."""

    def __init__(self, respond=None, first_obs=None):
        self.respond = respond or (lambda c: ("done", f"{c['verb']} ok", None))
        self.first_obs = first_obs
        self.received: list[dict] = []
        self.ws = None
        self.held: list[dict] = []

    async def start(self):
        self.server = await serve(self.handler, "127.0.0.1", 0)
        return f"ws://127.0.0.1:{self.server.sockets[0].getsockname()[1]}"

    async def handler(self, ws):
        self.ws = ws
        await ws.send(json.dumps(self.first_obs or make_obs()))
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

    async def event(self, kind, detail, obs=None):
        await self.ws.send(json.dumps({"type": "event", "v": "0.1", "kind": kind, "detail": detail, "obs": obs or make_obs()}))

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


class MindHarness:
    """start() / teardown for mind tests against the fake body (a mixin, so other modules reuse it without its tests)."""
    async def start(self, script, respond=None, retriever=None, first_obs=None, **cfg):
        self.tmp = tempfile.TemporaryDirectory()
        self.body = FakeBody(respond, first_obs)
        url = await self.body.start()
        self.llm = FakeLLM(script)
        self.cfg = Config(link_url=url, idle_s=cfg.pop("idle_s", 0.2), ask_timeout_s=cfg.pop("ask_timeout_s", 30),
                          notes_file=Path(self.tmp.name) / "notes.md", verb_reference=ROOT / "docs" / "verbs.md",
                          wiki_index=cfg.pop("wiki_index", Path(self.tmp.name) / "no-index.json"), **cfg)
        self.mind = Mind(self.cfg, self.llm, log=lambda *_: None, retriever=retriever)
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


class MindTest(MindHarness, unittest.IsolatedAsyncioTestCase):
    async def test_task_confirm_chain_done(self):
        await self.start([
            {"thinking": "Collin wants logs; confirm first.", "action": "say", "text": "On it: 3 oak logs.", "about": "t1"},
            {"thinking": "Two oak logs are in view; mine them.", "action": "call", "verb": "mine", "args": {"block": "oak_log", "count": 3}, "about": "t1"},
            {"thinking": "Mined 3; report and close the task.", "action": "say", "text": "Done: 3 oak logs.", "closes": "t1"},
        ], respond=lambda c: ("done", "mined 3 oak_log", {"block": "oak_log", "mined": 3, "requested": 3, "tunnel": 0}) if c["verb"] == "mine" else ("done", "said", None))
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "mine 3 oak logs"})
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
        self.assertIn("new task t1 from ACTS_HORIZON: mine 3 oak logs", self.prompt_text(0))
        self.assertIn("blocks seen: oak_log x2", self.prompt_text(0))
        self.assertIn("### mine {block", self.llm.prompts[0][0]["content"])
        self.assertIn("result m2 (mine): done", self.prompt_text(2))
        self.assertIn('t1 [running] from ACTS_HORIZON: mine 3 oak logs\n    you said: "On it: 3 oak logs."', self.prompt_text(2))
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
        self.assertIn("failed recently: " + fail, retry)
        self.assertIn("FAILED RECENTLY (don't repeat): ", self.prompt_text(2))
        self.assertIn('mine {"block":"iron_ore","count":3} -> mine: iron_ore needs one of', self.prompt_text(2))

    def running_task(self, text="get iron"):
        t = self.mind.tasks.add("ACTS_HORIZON", text)
        t.state = "running"
        return t

    async def test_a_failed_call_is_refused_for_the_next_10_recent_lines_not_only_right_after(self):
        await self.start([
            {"thinking": "Go.", "action": "call", "verb": "goto", "args": {"pos": [9, 64, 9]}},
            {"thinking": "Look elsewhere.", "action": "call", "verb": "recall", "args": {"type": "iron_ore"}},
            {"thinking": "Walk a bit.", "action": "call", "verb": "explore", "args": {"direction": "north", "distance": 16}},
            {"thinking": "Back to the spot.", "action": "call", "verb": "goto", "args": {"pos": [9, 64, 9]}},
            {"thinking": "Plan it: sticks, then the spot.", "action": "plan", "steps": [{"verb": "craft", "args": {"item": "stick"}}, {"verb": "goto", "args": {"pos": [9, 64, 9]}}]},
            {"thinking": "Plan starting with the failed goto.", "action": "plan", "steps": [{"verb": "goto", "args": {"pos": [9, 64, 9]}}, {"verb": "craft", "args": {"item": "stick"}}]},
            {"thinking": "Mine instead.", "action": "call", "verb": "mine", "args": {"block": "stone"}},
        ], respond=lambda c: ("partial", STUCK, None) if c["verb"] == "goto" else ("done", "ok", None))
        self.running_task()
        logs = []
        self.mind.log = logs.append
        self.mind.wake("go")
        await until(lambda: len(self.body.calls()) >= 6)
        self.assertEqual([c["verb"] for c in self.body.calls()[:6]], ["goto", "recall", "explore", "craft", "goto", "mine"],
                         "the single goto two calls later was refused; a plan whose LATER step is that goto ran (step 2 failed again); "
                         "a plan STARTING with it was refused")
        self.assertTrue(any('that exact call (goto {"pos":[9,64,9]}) failed recently' in str(x) for x in logs))
        self.assertTrue(any('plan step 1 (goto {"pos":[9,64,9]}) failed recently' in str(x) for x in logs))
        # 10 RECENT lines later it may be tried again
        f = self.mind.failures[-1]
        self.mind.recent.n = f["at"] + 10
        self.assertIsNone(self.mind.failed_recently("goto", {"pos": [9, 64, 9]}))

    async def test_a_verb_name_as_the_action_is_a_call(self):
        await self.start([
            {"thinking": "Planks.", "action": "craft", "args": {"item": "oak_planks", "count": 4}},
            {"thinking": "Sticks, args inline.", "action": "craft", "item": "stick", "count": 4},
            {"thinking": "w", "action": "wait"},
        ])
        self.running_task("make sticks")
        self.mind.wake("go")
        await until(lambda: len(self.body.calls()) >= 2)
        self.assertEqual([(c["verb"], c["args"]) for c in self.body.calls()[:2]],
                         [("craft", {"item": "oak_planks", "count": 4}), ("craft", {"item": "stick", "count": 4})])
        self.assertEqual(self.mind.decisions[0]["action"], "call")

    async def test_idle_means_idle(self):
        await self.start([
            {"thinking": "Nothing to do; look around.", "action": "call", "verb": "explore", "args": {"direction": "north", "distance": 32}},
            {"thinking": "Then mine.", "action": "plan", "steps": [{"verb": "mine", "args": {"block": "stone"}}]},
            {"thinking": "Fine.", "action": "wait"},
            {"thinking": "Hungry.", "action": "call", "verb": "eat", "args": {}},
            {"thinking": "w", "action": "wait"},
        ])
        await self.body.event("player_said", {"from": "ACTS_HORIZON", "text": "anything going on?"})  # a wake with no task
        await until(lambda: len(self.llm.prompts) >= 2)
        self.assertIn("no open task, so you are idle: explore is not allowed", self.llm.prompts[1][-1]["content"])
        self.assertIn("Idle means idle", self.llm.prompts[0][0]["content"])
        await self.body.event("player_said", {"from": "ACTS_HORIZON", "text": "ok"})
        await until(lambda: len(self.llm.prompts) >= 3)
        self.assertEqual(self.body.calls(), [], "no explore, no mine with no open task")
        await self.body.event("player_said", {"from": "ACTS_HORIZON", "text": "you look hungry"})
        await until(lambda: len(self.body.calls()) >= 1)
        self.assertEqual(self.body.calls()[0]["verb"], "eat", "eating is allowed")
        m = self.mind  # goto only to get away, when hurt
        m.obs["self"]["health"] = 4
        self.assertTrue(m.idle_allows({"action": "call", "verb": "goto", "args": {"pos": [0, 64, 0]}}))
        m.obs["self"]["health"] = 20
        self.assertFalse(m.idle_allows({"action": "call", "verb": "goto", "args": {"pos": [0, 64, 0]}}))

    async def test_a_delivered_request_in_obs_chat_is_not_shown_again(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "On it: an iron pickaxe.", "about": "t1"},
            {"thinking": "Hand it over.", "action": "call", "verb": "give", "args": {"item": "iron_pickaxe", "player": "Rook"}, "about": "t1"},
            {"thinking": "Done.", "action": "say", "text": "Here you go.", "closes": "t1"},
            {"thinking": "Nothing to do.", "action": "wait"},
            {"thinking": "w", "action": "wait"},
        ])
        line = {"from": "Rook", "text": "@Atlas get me an iron pickaxe", "t": 300}
        await self.body.event("task_from_chat", {"from": "Rook", "text": "get me an iron pickaxe"}, obs=make_obs(t=310, chat=[line]))
        await until(lambda: len(self.llm.prompts) >= 1)
        self.assertIn("chat <Rook> @Atlas get me an iron pickaxe (-> t1 new)", self.prompt_text(0))
        await until(lambda: self.mind.tasks.get("t1").state == "done" and not self.mind.pending)
        n = len(self.llm.prompts)
        await self.body.event("player_said", {"from": "Rook", "text": "thanks!"}, obs=make_obs(t=400, chat=[line]))  # still in the buffer
        await until(lambda: len(self.llm.prompts) > n)
        later = self.llm.prompts[n][-1]["content"]
        self.assertNotIn("get me an iron pickaxe", later.split("TASKS")[1].split("RECENT")[0].replace("t1 [done] from Rook: get me an iron pickaxe", ""),
                         "the delivered request is not in the observation's chat")
        self.assertEqual(len(self.mind.tasks.tasks), 1, "no new task")
        self.assertEqual([c["args"]["text"] for c in self.body.calls() if c["verb"] == "say"], ["On it: an iron pickaxe.", "Here you go."], "no second confirm")

    async def test_hints_expire_after_5_turns_or_when_the_target_changes(self):
        await self.start([{"thinking": "w", "action": "wait"}])
        m = self.mind
        m.failures = [{"verb": "goto", "args": '{"target":"ACTS_HORIZON"}', "detail": "stuck", "at": m.recent.n, "turn": m.turns,
                       "stall": True, "target": "goto ACTS_HORIZON"},
                      {"verb": "mine", "args": '{"block":"iron_ore"}', "detail": "no iron_ore in view", "at": m.recent.n, "turn": m.turns,
                       "stall": False, "target": "mine iron_ore"}]
        self.assertEqual(len(m.recent_failures()), 2)
        m.last_call_target["goto"] = "goto [40, 64, 0]"  # a goto elsewhere: the route hint toward the player is gone
        self.assertEqual([f["verb"] for f in m.recent_failures()], ["mine"])
        m.turns += 5
        self.assertEqual(m.recent_failures(), [], "5 turns later")
        m.lookup = {"query": "q", "text": "x", "titles": [], "ids": [], "turn": m.turns}
        m.turns += 5
        self.assertTrue(m.hint_alive(m.lookup))
        m.turns += 1
        self.assertFalse(m.hint_alive(m.lookup))

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
        self.running_task()  # with a task open, a meaningful change gets a turn
        self.mind.turn_tasks = self.mind.tasks.version
        for _ in range(60):  # 60 idle ticks (10 minutes at the default 10 s), the same obs every few
            await self.body.ws.send(json.dumps(make_obs()))
            await asyncio.sleep(0.05)
        self.assertEqual(len(self.llm.prompts), 0)
        await self.body.ws.send(json.dumps(make_obs(inventory={"spruce_log": 8})))  # a meaningful change
        await until(lambda: len(self.llm.prompts) == 1)
        self.assertIn("WOKE BECAUSE: idle, something changed since your last turn", self.prompt_text(0))
        await asyncio.sleep(0.6)
        self.assertEqual(len(self.llm.prompts), 1, "one turn per change")

    async def test_idle_with_no_task_world_changes_never_call_the_model(self):
        await self.start([{"thinking": "w", "action": "wait"}] * 5, idle_s=0.05)
        for i in range(60):  # 60 idle ticks, moving, with entities coming and going, no task
            o = make_obs(t=200 + i, pos=[0.5 + i, 64, 0.5], inventory={"dirt": i + 1})
            o["entities"] = [{"type": "zombie" if i % 2 else "cow", "rel": [i % 5, 0, 1], "dist": 3.0, "bearing": "front", "approaching": bool(i % 2), "hostile": bool(i % 2)}]
            await self.body.ws.send(json.dumps(o))
            await asyncio.sleep(0.05)
        await self.body.event("player_joined", {"name": "Rook"})  # not a wake with nothing to do
        await asyncio.sleep(0.3)
        self.assertEqual(len(self.llm.prompts), 0, "zero model calls")
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "get me 3 logs"})
        await until(lambda: len(self.llm.prompts) >= 1)
        await asyncio.sleep(0.05)
        self.assertEqual(len(self.llm.prompts), 1, "one turn for the task")
        self.assertIn("WOKE BECAUSE: new task t1", self.prompt_text(0))

    async def test_idle_wakes_on_low_food_health_chat_and_stop(self):
        await self.start([{"thinking": "w", "action": "wait"}] * 8, idle_s=0.05)
        await self.body.ws.send(json.dumps({**make_obs(t=300), "self": {**make_obs()["self"], "food": 4}}))
        await until(lambda: len(self.llm.prompts) >= 1)
        self.assertIn("food is low (4/20)", self.prompt_text(0))
        await self.body.event("player_said", {"from": "ACTS_HORIZON", "text": "hi"})
        await until(lambda: len(self.llm.prompts) >= 2)
        await self.body.event("stop_requested", {"from": "ACTS_HORIZON"})
        await until(lambda: len(self.llm.prompts) >= 3)
        await self.body.event("died", {})
        await until(lambda: len(self.llm.prompts) >= 4)
        await self.body.event("damaged_badly", {"health": 13, "lost": 5, "food": 20})
        await until(lambda: len(self.llm.prompts) >= 5)
        self.assertIn("event damaged_badly", self.prompt_text(4))
        for kind in ("respawned", "player_joined", "player_left"):  # noted, no turn, with nothing to do
            await self.body.event(kind, {"name": "Rook"})
        await asyncio.sleep(0.3)
        self.assertEqual(len(self.llm.prompts), 5)

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

    async def test_task_exists_before_the_turn_that_reacts_to_it(self):
        seen = {}

        def first(messages):
            seen["task"] = self.mind.tasks.get("t1")
            seen["context"] = messages[-1]["content"]
            return {"thinking": "Confirm.", "action": "say", "text": "On it.", "about": "t1"}
        await self.start([first])
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "bring me 8 spruce logs"})
        await until(lambda: self.body.calls())
        self.assertIsNotNone(seen["task"], "the task was created before the model was asked")
        self.assertIn("t1 [new] from ACTS_HORIZON: bring me 8 spruce logs", seen["context"])
        self.assertIn("WOKE BECAUSE: new task t1 from ACTS_HORIZON: bring me 8 spruce logs", seen["context"])

    async def test_stuck_partial_counts_as_failed_for_the_repeat_guard(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "Coming.", "about": "t1"},
            {"thinking": "Go to him.", "action": "call", "verb": "goto", "args": {"target": "ACTS_HORIZON"}, "about": "t1"},
            {"thinking": "Try again.", "action": "call", "verb": "goto", "args": {"target": "ACTS_HORIZON"}, "about": "t1"},
            {"thinking": "Dig down first.", "action": "call", "verb": "dig", "args": {"pos": [-14, 75, -11]}, "about": "t1"},
        ], respond=lambda c: ("partial", 'gave up 13.3 blocks short of player ACTS_HORIZON at [-1.5, 64, -3.5] (stuck: feet air, head air, below spruce_log; in front: spruce_leaves (would dig) at [-13, 76, -10]; dig on, scaffold on; last plan: partial, no next step)', {"pos": [-1.5, 64, -3.5], "remaining": 13.3}) if c["verb"] == "goto" else ("done", "ok", None))
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "come here"})
        await until(lambda: len(self.body.calls()) >= 3)
        self.assertEqual([c["verb"] for c in self.body.calls()[:3]], ["say", "goto", "dig"], "the stuck goto was not sent again")
        self.assertIn("failed recently: gave up 13.3 blocks short", self.llm.prompts[3][-1]["content"])

    async def test_repeated_say_is_dropped(self):
        logs = []
        await self.start([
            {"thinking": "Answer.", "action": "say", "text": "On my way!"},
            {"thinking": "Answer again.", "action": "say", "text": "on my way"},
            {"thinking": "Answer again, later.", "action": "say", "text": "On my way!"},
        ])
        self.mind.log = logs.append
        await self.body.event("player_said", {"from": "ACTS_HORIZON", "text": "where are you?"})
        await until(lambda: len(self.body.calls()) == 1)
        await self.body.event("player_said", {"from": "ACTS_HORIZON", "text": "hello??"})
        await until(lambda: len(self.mind.decisions) == 2)
        await asyncio.sleep(0.2)
        self.assertEqual(len(self.body.calls()), 1, "the same text (any case or punctuation) is not said again")
        self.assertIn('[mind] warning: dropped a repeated say (said within 60 s): "on my way"', logs)
        self.mind.now = lambda: __import__("time").monotonic() + 61  # a minute later it may be said again
        await self.body.event("player_said", {"from": "ACTS_HORIZON", "text": "still there?"})
        await until(lambda: len(self.body.calls()) == 2)

    async def test_three_failures_of_one_kind_then_a_different_approach_not_ask_player(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "Coming.", "about": "t1"},
            {"thinking": "Go.", "action": "call", "verb": "goto", "args": {"pos": [9, 64, 9]}, "about": "t1"},
            {"thinking": "Go a bit left.", "action": "call", "verb": "goto", "args": {"pos": [8, 64, 9]}, "about": "t1"},
            {"thinking": "Go a bit right.", "action": "call", "verb": "goto", "args": {"pos": [10, 64, 9]}, "about": "t1"},
            {"thinking": "I'm stuck; ask.", "action": "ask_player", "player": "ACTS_HORIZON", "text": "I'm stuck, can you come closer?", "about": "t1"},
            {"thinking": "Fine: look for another way out.", "action": "call", "verb": "explore", "args": {"direction": "south", "distance": 32}, "about": "t1"},
        ], respond=lambda c: ("partial", STUCK, None) if c["verb"] == "goto" else ("done", "ok", None))
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "come here"})
        await until(lambda: len(self.body.calls()) >= 5)
        await asyncio.sleep(0.1)
        self.assertEqual([c["verb"] for c in self.body.calls()], ["say", "goto", "goto", "goto", "explore"],
                         "the question was not asked: the fourth action is a different approach")
        retry = self.llm.prompts[5][-1]["content"]
        self.assertIn("t1 is hard, not unclear: you have tried 1 approach(es) (goto a position from 0,4,0)", retry)
        self.assertIn("Try at least 3 different approaches", retry)
        p = self.llm.prompts[4][-1]["content"]
        self.assertIn("    approaches tried since the first failure: 1 (ask_player needs 3)", p)
        self.assertIn("    - goto pos=[10, 64, 9] -> partial: gave up 13.3 blocks short of [9, 64, 9] (stuck:", p)
        self.assertNotIn("ROUTE:", p, "the journal replaces the route hint")

    async def test_ask_player_is_allowed_after_three_approaches(self):
        fail = lambda c: ("failed", f"{c['verb']}: no iron_ore in view", None) if c["verb"] != "say" else ("done", "ok", None)  # noqa: E731
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "On it.", "about": "t1"},
            {"thinking": "Mine.", "action": "call", "verb": "mine", "args": {"block": "iron_ore"}, "about": "t1"},
            {"thinking": "Deeper.", "action": "call", "verb": "mine", "args": {"block": "iron_ore", "y": 16}, "about": "t1"},
            {"thinking": "Look around.", "action": "call", "verb": "explore", "args": {"direction": "north", "distance": 32}, "about": "t1"},
            {"thinking": "Ask.", "action": "ask_player", "player": "ACTS_HORIZON", "text": "Know where iron is?", "about": "t1"},
        ], respond=fail)
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "get iron"})
        await until(lambda: len(self.body.calls()) >= 5)
        self.assertEqual(self.body.calls()[4]["args"], {"text": "Know where iron is?"})
        self.assertEqual(len(self.mind.tasks.get("t1").approaches), 3)

    async def test_no_capable_verb_ask_player_at_once(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "A house? Let me think.", "about": "t1"},
            {"thinking": "No build verb: ask what they want instead.", "action": "ask_player", "player": "ACTS_HORIZON",
             "text": "I can't build yet. Want me to gather the wood for it?", "about": "t1"},
        ])
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "build me a house"})
        await until(lambda: len(self.body.calls()) >= 2)
        self.assertEqual(self.body.calls()[1]["args"]["text"], "I can't build yet. Want me to gather the wood for it?")

    async def test_not_implemented_failure_lets_it_ask(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "On it.", "about": "t1"},
            {"thinking": "Try.", "action": "call", "verb": "mine", "args": {"block": "stone"}, "about": "t1"},
            {"thinking": "Can't; ask.", "action": "ask_player", "player": "ACTS_HORIZON", "text": "That needs a verb I lack. Skip it?", "about": "t1"},
        ], respond=lambda c: ("failed", "verb not implemented yet: mine", None) if c["verb"] == "mine" else ("done", "ok", None))
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "do it"})
        await until(lambda: len(self.body.calls()) >= 3)
        self.assertEqual(self.body.calls()[2]["args"]["text"], "That needs a verb I lack. Skip it?")

    async def test_after_a_failure_the_next_call_differs(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "On it.", "about": "t1"},
            {"thinking": "Mine 3.", "action": "call", "verb": "mine", "args": {"block": "iron_ore", "count": 3}, "about": "t1"},
            {"thinking": "Mine 5 then.", "action": "call", "verb": "mine", "args": {"block": "iron_ore", "count": 5}, "about": "t1"},
            {"thinking": "Mine deeper.", "action": "call", "verb": "mine", "args": {"block": "iron_ore", "count": 3, "y": 16}, "about": "t1"},
        ], respond=lambda c: ("failed", "mine: no iron_ore in view", None) if c["verb"] == "mine" and "y" not in c["args"] else ("done", "ok", None))
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "get iron"})
        await until(lambda: len(self.body.calls()) >= 3)
        self.assertEqual(self.body.calls()[2]["args"], {"block": "iron_ore", "count": 3, "y": 16}, "only the count changed: not sent")
        self.assertIn("After a failure the next action must differ in verb, target or method", self.llm.prompts[3][-1]["content"])

    async def test_note_about_a_task_is_ruled_out_in_its_journal(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "On it.", "about": "t1"},
            {"thinking": "No trees here.", "action": "note", "text": "no trees within 64 blocks north", "about": "t1"},
            {"thinking": "wait", "action": "wait"},
        ])
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "get logs"})
        await until(lambda: len(self.llm.prompts) >= 3)
        self.assertIn("    - ruled out: no trees within 64 blocks north", self.prompt_text(2))
        self.assertEqual(self.mind.notes.render(), Notes(self.cfg.notes_file, 80).render(), "not in the notes file")
        self.assertNotIn("no trees", self.cfg.notes_file.read_text() if self.cfg.notes_file.exists() else "")

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
            cfg = Config(notes_file=Path(d) / "notes.md", verb_reference=ROOT / "docs" / "verbs.md", wiki_index=Path(d) / "none.json")
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
                cfg = Config(link_url=url, idle_s=0.1, notes_file=Path(d) / "n.md", verb_reference=ROOT / "docs" / "verbs.md", llm_thinking=False, wiki_index=Path(d) / "none.json")
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


class TaskRefTest(unittest.TestCase):
    """about/closes are resolved leniently and never make a decision unusable."""

    def mind(self, *texts):
        d = tempfile.mkdtemp()
        logs = []
        m = Mind(Config(notes_file=Path(d) / "n.md", verb_reference=ROOT / "docs" / "verbs.md", wiki_index=Path(d) / "none.json"), FakeLLM([]), log=logs.append)
        for t in texts:
            m.tasks.add("ACTS_HORIZON", t)
        return m, logs

    def say(self, **kw):
        return json.dumps({"thinking": "t", "action": "say", "text": "On it.", **kw})

    def test_exact_id_any_case(self):
        m, logs = self.mind("bring me 8 spruce logs", "how are you?")
        self.assertEqual(m.check(self.say(about="t2"))["about"], "t2")
        self.assertEqual(m.check(self.say(closes="T2"))["closes"], "t2")
        self.assertEqual(logs[-1], '[mind] closes="T2" taken as t2 (id)')

    def test_task_text_used_as_id(self):
        m, logs = self.mind("bring me 8 spruce logs", "how are you?")
        self.assertEqual(m.check(self.say(about="bring me 8 spruce logs"))["about"], "t1", "exact text")
        self.assertEqual(m.check(self.say(about="8 spruce logs"))["about"], "t1", "substring")
        self.assertEqual(m.check(self.say(closes="how are you"))["closes"], "t2")
        self.assertEqual(m.check(self.say(about="bring me eight spruce logs"))["about"], "t1", "similar (>= 0.7)")
        self.assertIn('[mind] about="bring me eight spruce logs" taken as t1 (text)', logs)

    def test_only_open_task(self):
        m, logs = self.mind("bring me 8 spruce logs")
        a = m.check(self.say(about="t2"))  # t2 doesn't exist yet: the model guessed the next id
        self.assertEqual(a["about"], "t1")
        self.assertIn('[mind] about="t2" taken as t1 (only open task)', logs)

    def test_nothing_resolves_drop_and_warn(self):
        m, logs = self.mind("bring me 8 spruce logs", "how are you?")
        a = m.check(self.say(about="t9"))
        self.assertNotIn("about", a)
        self.assertEqual(a["action"], "say", "the decision is kept")
        self.assertIn('[mind] warning: about="t9" matches no task; dropped it (tasks: t1, t2)', logs)
        m2, logs2 = self.mind()  # no tasks at all
        a = m2.check(json.dumps({"thinking": "t", "action": "done", "closes": "t1"}))
        self.assertEqual(a["action"], "wait", "a done for nothing becomes a wait, not an error")
        self.assertTrue(any("matches no task; dropped it (tasks: none)" in x for x in logs2))

    def test_closed_tasks_are_not_matched_by_text(self):
        m, _ = self.mind("bring me 8 spruce logs", "how are you?")
        m.tasks.close(m.tasks.get("t1"))
        a = m.check(self.say(about="spruce logs"))  # matches only the closed t1's text; t2 is the only open task
        self.assertEqual(a["about"], "t2")


class JournalTest(unittest.TestCase):
    def test_journal_is_capped_and_summarised(self):
        from atlas_mind.tasks import JOURNAL_LINES, TaskList
        tl = TaskList()
        t = tl.add("ACTS_HORIZON", "get iron")
        t.state = "running"
        for i in range(30):
            ok = i % 3 == 0
            tl.result(t, "mine" if i % 2 else "goto", {"block": "iron_ore"} if i % 2 else {"pos": [i, 64, 0]}, (0, 4, 0),
                      "done" if ok else "failed", f"attempt {i}", not ok)
        tl.ruled_out(t, "no iron in the cave east of spawn")
        lines = tl.render().split("\n")[1:]
        self.assertLessEqual(len(lines), JOURNAL_LINES)
        self.assertEqual(len(lines), JOURNAL_LINES)
        self.assertRegex(lines[1], r"^    \(\d+ earlier calls: (goto|mine) x\d+, (goto|mine) x\d+; \d+ failed\)$")
        self.assertIn("attempt 29", lines[-2])
        self.assertEqual(lines[-1], "    - ruled out: no iron in the cave east of spawn")

    def test_approach_keys(self):
        from atlas_mind.tasks import approach_key, fine_key, place_cell
        here = place_cell([0.5, 64, 0.5])
        self.assertEqual(approach_key("goto", {"pos": [9, 64, 9]}, here), approach_key("goto", {"pos": [1, 70, -3], "range": 3}, here),
                         "goto toward other spots from the same place is one approach")
        self.assertNotEqual(approach_key("mine", {"block": "iron_ore"}, here), approach_key("mine", {"block": "iron_ore"}, place_cell([100, 64, 0])),
                            "the same verb from another place is another approach")
        self.assertNotEqual(approach_key("mine", {"block": "iron_ore"}, here), approach_key("mine", {"block": "iron_ore", "y": 16}, here))
        self.assertNotEqual(approach_key("goto", {"pos": [9, 64, 9]}, here), approach_key("goto", {"pos": [9, 64, 9], "dig": False}, here))
        self.assertEqual(fine_key("mine", {"block": "x", "count": 3}), fine_key("mine", {"block": "x", "count": 9}))


SHAFT = {"summary": "in a 1-wide shaft 5 deep, stone all sides, open above", "feet": "air", "head": "air",
         "below": "stone", "above": "air", "sides": {"north": ["stone 1", "stone 1"], "east": ["stone 1", "stone 1"],
                                                     "south": ["stone 1", "dirt 1"], "west": [None, None]},
         "drops": {"north": None, "east": None, "south": None, "west": 2}, "sky": True, "roof": None, "light": 15}


class EyesTest(unittest.TestCase):
    def test_inventory_and_surroundings_near_the_top(self):
        with tempfile.TemporaryDirectory() as d:
            m = Mind(Config(notes_file=Path(d) / "n.md", verb_reference=ROOT / "docs" / "verbs.md", wiki_index=Path(d) / "none.json"),
                     FakeLLM([]), log=lambda *_: None)
            o = make_obs(inventory={"spruce_log": 3, "cobblestone": 9})
            o["surroundings"] = SHAFT
            m.set_obs(o)
            p = m.messages("look around")[1]["content"]
        top = p.split("TASKS")[0]
        self.assertTrue(top.startswith("WOKE BECAUSE: look around\n\nINVENTORY: cobblestone 9, spruce_log 3\nSURROUNDINGS: "))
        self.assertIn("SURROUNDINGS: in a 1-wide shaft 5 deep, stone all sides, open above\n"
                      "  feet air, head air, below stone, above air; N stone 1 (feet+head); E stone 1 (feet+head); S stone 1/dirt 1; W open; "
                      "drops W 2; open sky, light 15", top)
        self.assertNotIn("inventory:", p, "inventory is shown once, at the top")
        self.assertLess(p.index("SURROUNDINGS"), p.index("blocks seen"))
        self.assertLess(len(render_surroundings(o)) / 4, 120)
        self.assertIn("Before crafting or asking, check INVENTORY and SURROUNDINGS; you often already have the item.", m.system)


class DumpTest(MindHarness, unittest.IsolatedAsyncioTestCase):
    async def test_context_dump_writes_what_the_model_saw(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        await self.start(["not json", {"thinking": "ok", "action": "wait"}, {"thinking": "ok", "action": "wait"}],
                         dump_context=True, dump_dir=Path(d.name) / "context")
        self.mind.wake("look around")
        await until(lambda: len(self.llm.prompts) >= 2)
        await asyncio.sleep(0.05)
        f = Path(d.name) / "context" / "100.txt"
        text = f.read_text()
        self.assertTrue(text.startswith("===== SYSTEM =====\nYou are Atlas"))
        self.assertIn("===== USER =====\nWOKE BECAUSE: look around\n\nINVENTORY: empty", text)
        self.assertIn("===== ASSISTANT =====\nnot json", text)
        self.assertIn("That reply was not usable", text, "a retry is appended to its turn's file")
        self.assertEqual(text.split("===== USER =====\n", 1)[1].split("\n\n===== ASSISTANT", 1)[0], self.llm.prompts[0][1]["content"],
                         "the exact user text")


OLD_CHAT = [{"from": "ACTS_HORIZON", "text": "@atlas get me 8 iron ingots", "t": 40},
            {"from": "ACTS_HORIZON", "text": "@Atlas come here", "t": 95}]


class OldChatTest(MindHarness, unittest.IsolatedAsyncioTestCase):
    async def test_old_chat_in_the_obs_makes_no_task_and_no_action(self):
        await self.start([{"thinking": "Nothing to do.", "action": "wait"}] * 3, first_obs=make_obs(t=100, chat=OLD_CHAT))
        await asyncio.sleep(0.6)  # a few idle ticks
        self.assertEqual(self.mind.tasks.tasks, [], "no task from chat lines in the obs")
        self.assertEqual(self.llm.prompts, [], "nothing changed: no model call at all")
        self.assertEqual(self.body.calls(), [])
        # a player talks: a turn runs, and the old lines are not in its context
        later = make_obs(t=160, chat=OLD_CHAT + [{"from": "ACTS_HORIZON", "text": "nice weather", "t": 150}], pos=[9.5, 64, 9.5])
        await self.body.event("player_said", {"from": "ACTS_HORIZON", "text": "nice weather"}, obs=later)
        await until(lambda: len(self.llm.prompts) >= 1)
        p = self.prompt_text(0)
        self.assertNotIn("get me 8 iron ingots", p)
        self.assertNotIn("come here", p)
        self.assertIn("chat <ACTS_HORIZON> nice weather", p, "chat since the mind connected is still shown")
        self.assertEqual(self.mind.tasks.tasks, [])
        self.assertEqual(self.body.calls(), [], "it waited: no action")
        self.assertEqual(self.mind.obs["chat"][0]["text"], "@atlas get me 8 iron ingots", "the obs itself (for display) is untouched")

    async def test_a_task_comes_only_from_task_from_chat(self):
        await self.start([{"thinking": "Confirm.", "action": "say", "text": "On it.", "about": "t1"}], first_obs=make_obs(t=100, chat=OLD_CHAT))
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "get me 3 logs"})
        await until(lambda: len(self.llm.prompts) >= 1)
        self.assertEqual([t.text for t in self.mind.tasks.tasks], ["get me 3 logs"])


class DeliveryTest(MindHarness, unittest.IsolatedAsyncioTestCase):
    async def test_a_bring_me_task_closes_only_after_give(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "On it: an iron pickaxe.", "about": "t1"},
            {"thinking": "Craft it.", "action": "call", "verb": "craft", "args": {"item": "iron_pickaxe"}, "about": "t1"},
            {"thinking": "Crafted: report.", "action": "say", "text": "I have crafted the iron pickaxe.", "closes": "t1"},
            {"thinking": "Right, hand it over.", "action": "call", "verb": "give", "args": {"item": "iron_pickaxe", "player": "Rook"}, "about": "t1"},
            {"thinking": "Delivered.", "action": "say", "text": "Here's your iron pickaxe.", "closes": "t1"},
        ], respond=lambda c: ("done", "crafted 1 iron_pickaxe", None) if c["verb"] == "craft" else
           ("done", "gave 1 iron_pickaxe to Rook", {"item": "iron_pickaxe", "given": 1}) if c["verb"] == "give" else ("done", "said", None))
        await self.body.event("task_from_chat", {"from": "Rook", "text": "get me an iron pickaxe"})
        await until(lambda: self.mind.tasks.get("t1") and self.mind.tasks.get("t1").state == "done")
        verbs = [(c["verb"], c["args"].get("text") or c["args"].get("item")) for c in self.body.calls()]
        self.assertEqual(verbs, [("say", "On it: an iron pickaxe."), ("craft", "iron_pickaxe"), ("give", "iron_pickaxe"),
                                 ("say", "Here's your iron pickaxe.")], "the early close was refused, never said")
        retry = next(m[-1]["content"] for m in self.llm.prompts if m[-1]["content"].startswith("That reply was not usable"))
        self.assertIn("the player doesn't have it yet — give it to them first", retry)

    async def test_saying_it_cant_be_done_may_close(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "On it.", "about": "t1"},
            {"thinking": "No diamonds anywhere near; give up honestly.", "action": "say", "text": "Sorry, I can't find any diamonds.", "closes": "t1"},
        ])
        await self.body.event("task_from_chat", {"from": "Rook", "text": "bring me a diamond"})
        await until(lambda: self.mind.tasks.get("t1") and self.mind.tasks.get("t1").state == "done")

    async def test_the_retry_shows_failed_recently_last(self):
        fail = "craft: missing 2 planks (any kind) for 4 stick"
        await self.start([
            {"thinking": "Sticks.", "action": "call", "verb": "craft", "args": {"item": "stick", "count": 4}},
            {"thinking": "Again.", "action": "call", "verb": "craft", "args": {"item": "stick", "count": 4}},
            {"thinking": "Planks first.", "action": "call", "verb": "craft", "args": {"item": "oak_planks"}},
        ], respond=lambda c: ("failed", fail, None) if c["args"].get("item") == "stick" else ("done", "crafted 4 oak_planks", None))
        t = self.mind.tasks.add("Rook", "make sticks")
        t.state = "running"
        self.mind.wake("go")
        await until(lambda: len(self.body.calls()) >= 2)
        retry = self.llm.prompts[2][-1]["content"]
        lines = retry.splitlines()
        self.assertIn(f"failed recently: {fail}", lines[0], "the exact detail")
        self.assertEqual(lines[1], 'FAILED RECENTLY (don\'t repeat): craft {"count":4,"item":"stick"} -> ' + fail)
        self.assertEqual(lines[2], "Reply again with exactly one valid JSON object, one of:")
        self.assertTrue(lines[-1].startswith('{"thinking": "...", "action": '), "the action format is the last thing it reads")


class DeliveryPhrasingTest(unittest.TestCase):
    def test_delivery_phrasing(self):
        from atlas_mind.loop import is_delivery
        for t in ("get me an iron pickaxe", "bring me 8 logs", "fetch me some coal", "give me a bucket", "I need 3 torches", "can I have a bed"):
            self.assertTrue(is_delivery(t), t)
        for t in ("mine 3 oak logs", "come here", "how are you?", "build a wall"):
            self.assertFalse(is_delivery(t), t)
