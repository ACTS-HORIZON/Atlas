"""The mind loop (CONTRACT.md, "Mind loop"):

1. Wake on a long-verb result, an event (task_from_chat, player_said, stop…),
   or the idle timer.
2. Build the context: tasks (with their state and what the bot already said),
   the latest obs (compact), recent calls / results / events, notes.
3. Ask the model for exactly one action: call, say, ask_player, note, done,
   wait, or a plan (up to 6 calls). Its "thinking" goes to the body as a
   trace (kind "decision") first.

Plans: the steps run one at a time without asking the model again. The
mind thinks again only when a step's result isn't "done", an event arrives
(it is held until the current step ends, then the plan stops), or the plan
finishes.

Wake policy (no model call is wasted):
- results of say, recall and stop, and of calls nothing is waiting on, don't
  wake a turn (a recall's or a failed say's result is still new input for
  the next turn);
- an idle tick runs a turn only if something changed since the last turn:
  a new event, a task change, new input, or a meaningful obs change
  (health, food, position, inventory, entities); otherwise no model call;
- idle ticks are skipped while a long verb runs or an ask_player question
  is open (until the answer or the timeout).

Guards that don't rely on the model:
- an unusable reply is logged (raw text, finish_reason) and retried once
  with the error shown, then the mind waits;
- the exact call that just failed or was refused is not sent again;
- a task that is already confirmed is not confirmed again, and work on a
  new task starts with confirming it;
- after a turn that only talked while a task is open, one follow-up turn
  carries on (at most 3 in a row without new input);
- after an unusable decision the next idle tick runs a turn even if nothing
  changed (up to 3 retries, then it waits for a change and says so).
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
QUIET_VERBS = {"say", "recall", "stop"}  # their results don't wake a turn
MAX_FOLLOW_UPS = 3
MAX_ERROR_RETRIES = 3
PLAN_NEXT = "\x00plan-next"  # internal wake: run the next plan step, no model call


def canon(args) -> str:
    return json.dumps(args or {}, sort_keys=True, separators=(",", ":"))


def verbs_in_reference(text: str) -> set[str]:
    names = set(re.findall(r"^### (\w+) \{", text, re.M))
    return names or {"say", "stop", "recall", "goto", "explore", "mine", "collect", "craft", "place", "equip", "dig", "eat"}


def fingerprint(o: dict | None):
    """What counts as a meaningful change in the obs for an idle turn."""
    if not o:
        return None
    s = o["self"]
    pos = tuple(int(v // 2) for v in s["pos"])  # 2-block cells: no jitter
    inv = tuple(sorted((o.get("inventory") or {}).items()))
    ents = tuple(sorted((e["type"], e["hostile"]) for e in o.get("entities") or []))
    players = tuple(sorted(p["name"] for p in o.get("players") or []))
    return (s["health"], s["food"], pos, s["dim"], inv, ents, players)


def default_log(*a):
    print(*a, flush=True)


class Mind:
    def __init__(self, cfg: Config, llm, *, log=default_log):
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
        self.turns = 0
        self.ws = None
        self._n = 0
        self.dirty = False  # new input since the last turn (besides the obs)
        self.turn_fp = None  # obs fingerprint at the last turn (or the first obs)
        self.turn_tasks = 0  # task list version at the last turn
        self.follow_ups = 0
        self.plan: dict | None = None
        self.error_streak = 0
        self.error_wait_logged = False
        self.replies: list = []  # the model replies of the current turn
        self.token_turns = 0
        self.token_total = 0
        self.reasoning_turns = 0

    # ---- link -----------------------------------------------------------------
    async def send(self, msg: dict) -> None:
        if self.ws is not None:
            await self.ws.send(json.dumps(msg))

    def wake(self, reason: str) -> None:
        self.dirty = True
        self.follow_ups = 0  # real input: follow-ups may start over
        if self.plan is not None:
            self.plan["interrupt"].append(reason)  # held until the current step ends
            return
        self.wakes.put_nowait(reason)

    def long_pending(self) -> bool:
        return any(c["verb"] not in QUIET_VERBS for c in self.pending.values())

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
            if not call:
                return  # nothing was waiting on it
            failed = m["status"] in ("failed", "refused")
            if failed and m["detail"] != "busy":
                self.last_failed = (call["verb"], canon(call.get("args")), m["detail"])
            if self.plan is not None and m["id"] == self.plan.get("cid"):
                self.plan_step_done(call, m)
                return
            if call["verb"] in QUIET_VERBS:
                if call["verb"] == "recall" or failed:
                    self.dirty = True  # new information for the next turn, no turn of its own
                return
            self.wake(f"result {m['id']} ({call['verb']}): {m['status']}")
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
                stopped = self.tasks.stop_working()
                self.asking = None
                self.wake(f"stop requested by {d.get('from', 'someone')}" + (f"; {', '.join(t.id for t in stopped)} stopped" if stopped else ""))
            else:
                self.wake(f"event {kind}")

    # ---- plans ----------------------------------------------------------------
    def plan_step_done(self, call: dict, m: dict) -> None:
        p = self.plan
        step = f"{p['i']}/{p['n']}"
        if m["status"] == "done" and p["steps"] and not p["interrupt"]:
            self.wakes.put_nowait(PLAN_NEXT)  # carry on, no model call
            return
        self.plan = None
        if m["status"] != "done":
            reason = f"plan stopped at step {step} ({call['verb']}): {m['status']} - {m['detail']}"
        elif p["interrupt"]:
            reason = f"plan stopped after step {step}"
        else:
            reason = f"plan finished ({p['n']} steps)"
        self.dirty = True
        self.wakes.put_nowait("; ".join([reason] + p["interrupt"]))

    async def plan_next(self) -> None:
        p = self.plan
        if p is None:
            return
        if p["interrupt"]:  # an event came in between steps
            self.plan = None
            self.wakes.put_nowait("; ".join([f"plan stopped after step {p['i']}/{p['n']}"] + p["interrupt"]))
            return
        st = p["steps"].pop(0)
        p["i"] += 1
        task = self.tasks.get(p.get("about"))
        if task and st["verb"] not in QUIET_VERBS:
            self.tasks.started(task)
        self.log(f"[mind] plan step {p['i']}/{p['n']}: {st['verb']} {canon(st['args'])}")
        p["cid"] = await self.call(st["verb"], st["args"])

    def set_obs(self, o: dict) -> None:
        self.obs = o
        if self.turn_fp is None:
            self.turn_fp = fingerprint(o)  # the baseline: nothing has changed yet
        h = o.get("self", {}).get("health")
        if isinstance(h, (int, float)):
            if h < self.cfg.retreat_health and not self.low_health:
                self.low_health = True
                self.wake(f"health is low ({h}/20)")
            elif h >= self.cfg.retreat_health:
                self.low_health = False

    def changed_since_turn(self) -> bool:
        return self.dirty or self.tasks.version != self.turn_tasks or fingerprint(self.obs) != self.turn_fp

    # ---- thinking -------------------------------------------------------------
    def messages(self, wake: str) -> list[dict]:
        extra = ""
        if self.asking:
            extra = f"\nWAITING for {self.asking['player']} to answer: {self.asking['text']}\n"
        if self.last_failed:
            extra += f"\nLAST FAILED CALL: {self.last_failed[0]} {self.last_failed[1]} -> {self.last_failed[2]}\n"
        user = context(self.tasks.render(), render_obs(self.obs), list(self.recent), self.notes.render(), wake, extra)
        return [{"role": "system", "content": self.system}, {"role": "user", "content": user}]

    def task_for(self, a: dict):
        """The task an action is for: "closes", "about", or the one task being worked on."""
        tid = a.get("closes") or a.get("about")
        if tid:
            t = self.tasks.get(tid)
            if not t:
                raise ActionError(f'there is no task "{tid}"; tasks: {", ".join(x.id for x in self.tasks.tasks) or "none"}')
            return t
        working = self.tasks.working()
        return working[0] if len(working) == 1 and a["action"] in ("call", "plan") else None

    def check(self, raw: str) -> dict:
        a = parse(raw, self.verbs)
        if a["action"] == "call" and self.last_failed and (a["verb"], canon(a["args"])) == self.last_failed[:2]:
            raise ActionError(f"that exact call ({a['verb']} {canon(a['args'])}) just failed with: {self.last_failed[2]}. "
                              "Choose a different action that deals with the reason.")
        t = self.task_for(a)
        if t and a["action"] in ("say", "ask_player", "call", "done") and t.state in ("done", "stopped"):
            raise ActionError(f"{t.id} is already {t.state}; leave it alone")
        if t and a["action"] == "say" and "closes" not in a and t.state == "confirmed":
            said = f' (you said: "{t.said[-1]}")' if t.said else ""
            raise ActionError(f"{t.id} is already confirmed{said}. Don't confirm it again: start it with a call (about {t.id}), "
                              f'or finish it with a say that has "closes": "{t.id}".')
        if t and a["action"] == "call" and a["verb"] not in QUIET_VERBS and t.state == "new":
            raise ActionError(f"{t.id} is new: confirm it in chat first (a say with \"about\": \"{t.id}\"), then start it.")
        if a["action"] == "plan":
            first = a["steps"][0]
            if self.last_failed and (first["verb"], canon(first["args"])) == self.last_failed[:2]:
                raise ActionError(f"the plan starts with the exact call that just failed ({first['verb']}): {self.last_failed[2]}. "
                                  "Plan around the reason instead.")
            if t and t.state == "new" and any(st["verb"] not in QUIET_VERBS for st in a["steps"]):
                raise ActionError(f"{t.id} is new: confirm it in chat first (a say with \"about\": \"{t.id}\"), then plan the work.")
        return a

    def unusable(self, attempt: str, err: Exception, raw) -> None:
        finish = getattr(raw, "finish_reason", None)
        self.log(f"[llm] unusable reply ({attempt}, finish_reason={finish}): {err}")
        self.log(f"[llm] raw reply: {str(raw)[:500]!r}")

    async def decide(self, wake: str) -> dict:
        msgs = self.messages(wake)
        self.replies = []
        try:
            raw = await self.llm.complete(msgs)
            self.replies.append(raw)
        except LLMError as e:
            self.log(f"[llm] {e}")
            return {"action": "wait", "thinking": f"model unavailable: {e}"[:200], "error": True}
        try:
            return self.check(raw)
        except ActionError as e:
            self.unusable("first try", e, raw)
            retry = msgs + [{"role": "assistant", "content": str(raw)},
                            {"role": "user", "content": f"That reply was not usable: {e} Reply again with exactly one valid JSON object."}]
            raw2 = ""
            try:
                raw2 = await self.llm.complete(retry)
                self.replies.append(raw2)
                return self.check(raw2)
            except LLMError as e2:
                self.log(f"[llm] {e2}")
                return {"action": "wait", "thinking": f"model unavailable: {e2}"[:200], "error": True}
            except ActionError as e2:
                self.unusable("retry", e2, raw2)
                return {"action": "wait", "thinking": f"no usable decision ({e2})"[:300], "error": True}

    async def act(self, a: dict) -> None:
        self.decisions.append(a)
        t = (self.obs or {}).get("t", 0)
        summary = {k: a[k] for k in ("action", "verb", "args", "text", "player", "about", "closes", "standing", "steps") if k in a}
        reasoning = " / ".join(r.reasoning for r in self.replies if getattr(r, "reasoning", ""))
        if reasoning:  # native thinking: never invisible
            summary["reasoning"] = reasoning[:800] + ("…" if len(reasoning) > 800 else "")
        await self.send({"type": "trace", "v": V, "t": t, "kind": "decision", "text": a["thinking"], "data": summary})
        task = None if a.get("error") else self.task_for(a)
        if task and "standing" in a:
            self.tasks.set_standing(task, a["standing"])
        kind = a["action"]
        if kind == "plan":
            self.plan = {"steps": list(a["steps"]), "n": len(a["steps"]), "i": 0, "about": task.id if task else None,
                         "interrupt": [], "cid": None}
            await self.plan_next()
        elif kind == "call":
            if task and a["verb"] not in QUIET_VERBS:
                self.tasks.started(task)
            await self.call(a["verb"], a["args"])
        elif kind == "say":
            if task:
                self.tasks.said(task, a["text"])
                if a.get("closes"):
                    self.tasks.close(task)
            await self.call("say", {"text": a["text"]})
        elif kind == "ask_player":
            if task:
                task.said.append(a["text"])
            await self.call("say", {"text": a["text"]})
            self.asking = {"player": a["player"], "text": a["text"], "deadline": time.monotonic() + self.cfg.ask_timeout_s}
            self.recent.append(f"you asked {a['player']}: {a['text']}")
        elif kind == "done":
            if task:
                self.tasks.close(task)
            self.recent.append(f"you closed {a['closes']}")
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

    async def turn(self, reason: str) -> None:
        self.turns += 1
        # the baseline for "changed since the last turn" is what this turn sees;
        # anything arriving while the model thinks still counts as new
        self.dirty = False
        self.turn_fp = fingerprint(self.obs)
        a = await self.decide(reason)
        self.log(f"[mind] {a['action']}: {a['thinking']}")
        self.count_tokens()
        if a.get("error"):
            self.error_streak += 1
        else:
            self.error_streak = 0
            self.error_wait_logged = False
        await self.act(a)
        self.turn_tasks = self.tasks.version  # what this turn did itself is not news
        # A turn that only talked (confirmed a task, reported, noted) while a
        # task is still open and no verb runs gets a follow-up turn to carry
        # on, at most MAX_FOLLOW_UPS in a row before it needs real input.
        if a["action"] == "call" and a["verb"] not in QUIET_VERBS:
            self.follow_ups = 0
        elif a["action"] in ("say", "note", "done") and not a.get("error") and self.tasks.working() and not self.long_pending():
            if self.follow_ups < MAX_FOLLOW_UPS:
                self.follow_ups += 1
                self.wakes.put_nowait(f"carry on with {', '.join(t.id for t in self.tasks.working())}")

    def count_tokens(self) -> None:
        """Completion tokens of this turn's model calls, and the running mean, to mind.out."""
        toks = [r.completion_tokens for r in self.replies if getattr(r, "completion_tokens", None) is not None]
        if not toks:
            return
        n = sum(toks)
        self.token_turns += 1
        self.token_total += n
        reasoning = any(getattr(r, "reasoning", "") for r in self.replies)
        self.reasoning_turns += reasoning
        self.log(f"[llm] turn {self.turns}: {n} completion tokens in {len(toks)} call(s){' (with reasoning)' if reasoning else ''}; "
                 f"mean {self.token_total / self.token_turns:.0f} over {self.token_turns} turns, {self.reasoning_turns} with reasoning")
        if reasoning and not self.cfg.llm_thinking:
            self.log("[llm] warning: reasoning_content came back although ATLAS_LLM_THINKING=0; the server ignored enable_thinking")

    async def think_forever(self) -> None:
        while True:
            reason = await self.next_wake()
            if PLAN_NEXT in reason:
                rest = [r for r in reason.split("; ") if r != PLAN_NEXT]
                await self.plan_next()
                if not rest:
                    continue
                reason = "; ".join(rest)
            if reason == "idle":
                if self.asking:
                    if time.monotonic() < self.asking["deadline"]:
                        continue
                    reason = f"no answer from {self.asking['player']} after {self.cfg.ask_timeout_s:g} s"
                    self.recent.append(f"no answer from {self.asking['player']}")
                    self.asking = None
                elif self.long_pending() or self.plan is not None:
                    continue  # a verb or a plan is running: its result will wake us
                elif 0 < self.error_streak <= MAX_ERROR_RETRIES:
                    reason = f"retrying after an unusable decision ({self.error_streak}/{MAX_ERROR_RETRIES})"
                elif not self.changed_since_turn():
                    if self.error_streak > MAX_ERROR_RETRIES and not self.error_wait_logged:
                        self.error_wait_logged = True
                        self.log(f"[mind] {MAX_ERROR_RETRIES} retries after unusable decisions failed; waiting for something to change")
                    continue  # nothing new: no model call
                else:
                    reason = "idle, something changed since your last turn"
            if self.obs is None:
                continue
            await self.turn(reason)

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
            self.plan = None
            await asyncio.sleep(3)
