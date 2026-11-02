"""The mind loop (CONTRACT.md, "Mind loop"):

1. Wake on a result, an event, or the idle timer.
2. Build the context: tasks, the latest obs (compact), recent calls / results /
   events, notes.
3. Ask the model for exactly one action: call, say, ask_player, note or wait.
   Its "thinking" goes to the body as a trace (kind "decision") first.

Guards that don't rely on the model:
- an invalid reply is retried once with the error shown, then it waits;
- the exact call that just failed or was refused is not sent again; the
  model is told so and asked once more;
- idle wakes are skipped while a verb runs or while waiting for an answer
  to ask_player (until it arrives or times out).
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from collections import deque

from . import CONTRACT_VERSION
from .actions import ActionError, parse
from .config import Config
from .llm import LLMError
from .notes import Notes
from .prompt import context, load_verb_reference, system_prompt
from .render import history_line, render_obs
from .tasks import TaskList

V = CONTRACT_VERSION


def canon(args) -> str:
    return json.dumps(args or {}, sort_keys=True, separators=(",", ":"))


def verbs_in_reference(text: str) -> set[str]:
    names = set(re.findall(r"^### (\w+) \{", text, re.M))
    return names or {"say", "stop", "recall", "goto", "explore", "mine", "collect", "craft", "place", "equip", "dig", "eat"}


class Mind:
    def __init__(self, cfg: Config, llm, *, log=print):
        self.cfg = cfg
        self.llm = llm
        self.log = log
        self.tasks = TaskList()
        self.notes = Notes(cfg.notes_file, cfg.notes_max_lines)
        ref = load_verb_reference(cfg.verb_reference)
        self.verbs = verbs_in_reference(ref)
        self.system = system_prompt(cfg.bot_name, ref, cfg.retreat_health)
        self.obs: dict | None = None
        self.recent: deque[str] = deque(maxlen=cfg.history)
        self.pending: dict[str, dict] = {}
        self.wakes: asyncio.Queue[str] = asyncio.Queue()
        self.asking: dict | None = None
        self.last_failed: tuple[str, str, str] | None = None
        self.low_health = False
        self.decisions: list[dict] = []
        self.ws = None
        self._n = 0

    # ---- link -----------------------------------------------------------------
    async def send(self, msg: dict) -> None:
        if self.ws is not None:
            await self.ws.send(json.dumps(msg))

    def wake(self, reason: str) -> None:
        self.wakes.put_nowait(reason)

    def handle(self, m: dict) -> None:
        """Update state from one body message (also used by --replay)."""
        t = m.get("type")
        if m.get("obs"):
            self.set_obs(m["obs"])
        if t == "obs":
            self.set_obs(m)
        elif t == "result":
            call = self.pending.pop(m["id"], None)
            self.recent.append(history_line("result", m))
            if call and m["status"] in ("failed", "refused") and m["detail"] != "busy":
                self.last_failed = (call["verb"], canon(call.get("args")), m["detail"])
            self.wake(f"result {m['id']} ({call['verb'] if call else '?'}): {m['status']}")
        elif t == "event":
            self.recent.append(history_line("event", m))
            kind, d = m["kind"], m.get("detail") or {}
            if kind == "task_from_chat":
                task = self.tasks.add(d.get("from", "?"), d.get("text", ""))
                self.wake(f"new task {task.id} from {task.by}: {task.text}")
            elif kind == "player_said":
                if self.asking and d.get("from") == self.asking["player"]:
                    self.wake(f"{d.get('from')} answered your question: {d.get('text')}")
                    self.asking = None
                else:
                    self.wake(f"{d.get('from')} said: {d.get('text')}")
            elif kind == "stop_requested":
                stopped = self.tasks.stop_active()
                self.asking = None
                self.wake(f"stop requested by {d.get('from', 'someone')}" + (f"; task {stopped.id} stopped" if stopped else ""))
            else:
                self.wake(f"event {kind}")

    def set_obs(self, o: dict) -> None:
        self.obs = o
        h = o.get("self", {}).get("health")
        if isinstance(h, (int, float)):
            if h < self.cfg.retreat_health and not self.low_health:
                self.low_health = True
                self.wake(f"health is low ({h}/20)")
            elif h >= self.cfg.retreat_health:
                self.low_health = False

    # ---- thinking -------------------------------------------------------------
    def messages(self, wake: str) -> list[dict]:
        extra = ""
        if self.asking:
            extra = f"\nWAITING for {self.asking['player']} to answer: {self.asking['text']}\n"
        if self.last_failed:
            extra += f"\nLAST FAILED CALL: {self.last_failed[0]} {self.last_failed[1]} -> {self.last_failed[2]}\n"
        user = context(self.tasks.render(), render_obs(self.obs), list(self.recent), self.notes.render(), wake, extra)
        return [{"role": "system", "content": self.system}, {"role": "user", "content": user}]

    def check(self, raw: str) -> dict:
        a = parse(raw, self.verbs)
        if a["action"] == "call" and self.last_failed and (a["verb"], canon(a["args"])) == self.last_failed[:2]:
            raise ActionError(f"that exact call ({a['verb']} {canon(a['args'])}) just failed with: {self.last_failed[2]}. "
                              "Choose a different action that deals with the reason.")
        return a

    async def decide(self, wake: str) -> dict:
        msgs = self.messages(wake)
        try:
            raw = await self.llm.complete(msgs)
        except LLMError as e:
            self.log(f"[llm] {e}")
            return {"action": "wait", "thinking": f"model unavailable: {e}"[:200], "error": True}
        try:
            return self.check(raw)
        except ActionError as e:
            self.log(f"[llm] unusable reply ({e}); retrying once")
            retry = msgs + [{"role": "assistant", "content": raw},
                            {"role": "user", "content": f"That reply was not usable: {e} Reply again with exactly one valid JSON object."}]
            try:
                raw2 = await self.llm.complete(retry)
                return self.check(raw2)
            except (ActionError, LLMError) as e2:
                self.log(f"[llm] unusable again ({e2}); waiting")
                return {"action": "wait", "thinking": f"no usable decision ({e2})"[:300], "error": True}

    async def act(self, a: dict) -> None:
        self.decisions.append(a)
        t = (self.obs or {}).get("t", 0)
        summary = {k: a[k] for k in ("action", "verb", "args", "text", "player", "task") if k in a}
        await self.send({"type": "trace", "v": V, "t": t, "kind": "decision", "text": a["thinking"], "data": summary})
        if a.get("task"):
            err = self.tasks.update(a["task"]["id"], a["task"].get("state"), a["task"].get("standing"))
            if err:
                self.recent.append(f"task update failed: {err}")
        kind = a["action"]
        if kind == "call":
            await self.call(a["verb"], a["args"])
        elif kind == "say":
            await self.call("say", {"text": a["text"]})
        elif kind == "ask_player":
            await self.call("say", {"text": a["text"]})
            self.asking = {"player": a["player"], "text": a["text"], "deadline": time.monotonic() + self.cfg.ask_timeout_s}
            self.recent.append(f"you asked {a['player']}: {a['text']}")
        elif kind == "note":
            self.notes.append(a["text"])
            self.recent.append(f"you noted: {a['text']}")
            await self.send({"type": "trace", "v": V, "t": t, "kind": "note", "text": a["text"]})

    async def call(self, verb: str, args: dict) -> str:
        self._n += 1
        cid = f"m{self._n}"
        msg = {"type": "call", "v": V, "id": cid, "verb": verb, "args": args}
        self.pending[cid] = msg
        if (verb, canon(args)) != (self.last_failed or (None, None))[:2]:
            self.last_failed = None
        self.recent.append(history_line("call", msg))
        await self.send(msg)
        return cid

    async def next_wake(self) -> str:
        try:
            first = await asyncio.wait_for(self.wakes.get(), timeout=self.cfg.idle_s)
        except asyncio.TimeoutError:
            return "idle"
        reasons = [first]
        await asyncio.sleep(0.05)  # coalesce a result and its events into one turn
        while not self.wakes.empty():
            reasons.append(self.wakes.get_nowait())
        return "; ".join(reasons)

    async def think_forever(self) -> None:
        while True:
            reason = await self.next_wake()
            if reason == "idle":
                if self.asking:
                    if time.monotonic() < self.asking["deadline"]:
                        continue
                    reason = f"no answer from {self.asking['player']} after {self.cfg.ask_timeout_s:g} s"
                    self.recent.append(f"no answer from {self.asking['player']}")
                    self.asking = None
                elif self.pending:
                    continue  # a verb is running: its result will wake us
            if self.obs is None:
                continue
            a = await self.decide(reason)
            self.log(f"[mind] {a['action']}: {a['thinking']}")
            await self.act(a)

    async def run(self) -> None:
        from websockets.asyncio.client import connect
        from websockets.exceptions import ConnectionClosed
        while True:
            try:
                async with connect(self.cfg.link_url, max_size=None) as ws:
                    self.ws = ws
                    self.log(f"[mind] connected to {self.cfg.link_url}")
                    thinker = asyncio.create_task(self.think_forever())
                    try:
                        async for data in ws:
                            try:
                                self.handle(json.loads(data))
                            except (KeyError, TypeError, ValueError) as e:
                                self.log(f"[mind] bad message from body: {e}")
                    finally:
                        thinker.cancel()
            except (OSError, ConnectionClosed) as e:
                self.log(f"[mind] link down ({e.__class__.__name__}); retrying in 3 s")
            self.ws = None
            self.pending.clear()
            await asyncio.sleep(3)
