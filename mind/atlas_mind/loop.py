"""The mind loop (CONTRACT.md, "Mind loop"):

1. Wake on a long-verb result, an event (task_from_chat, player_said, stop…),
   or the idle timer.
2. Build the context: tasks (with their state and what the bot already said),
   the latest obs (compact), recent calls / results / events, notes, and
   KNOWLEDGE: wiki excerpts retrieved for the open tasks, the last failure
   and the current verb target (top 3, <= 600 tokens; trace kind "rag").
3. Ask the model for exactly one action: call, say, ask_player, note, done,
   wait, lookup, or a plan (up to 6 calls). Its "thinking" goes to the body
   as a trace (kind "decision") first. A lookup searches the wiki; the
   answer is shown as LOOKUP in the next turn, which follows at once.

Plans: the steps run one at a time without asking the model again. The
mind thinks again only when a step's result isn't "done", an event arrives
(it is held until the current step ends, then the plan stops), or the plan
finishes.

Wake policy (no model call is wasted):
- results of say, recall and stop, and of calls nothing is waiting on, don't
  wake a turn (a recall's or a failed say's result is still new input for
  the next turn);
- with no open task (and health and food above their thresholds) an idle
  tick never runs a turn: only task_from_chat, player_said, stop, death or
  damage events, or health/food dropping below threshold wake it;
- an idle tick runs a turn only if something changed since the last turn:
  a new event, a task change, new input, or a meaningful obs change
  (health, food, position, inventory, entities); otherwise no model call;
- idle ticks are skipped while a long verb runs or an ask_player question
  is open (until the answer or the timeout).

Guards that don't rely on the model:
- an unusable reply is logged (raw text, finish_reason) and retried once
  with the error shown, then the mind waits;
- nothing is refused for repeating a failure: calls that failed recently
  are listed in the context (FAILED RECENTLY); the fuse: the identical call
  failing ATLAS_FUSE_COUNT (5) times in a row pauses the mind for
  ATLAS_FUSE_S (30 s), logged "fuse: <call> x5", then it carries on;
- each task keeps a journal (calls with status and detail, "ruled out"
  notes) shown in the context;
- a task that is already confirmed is not confirmed again, and work on a
  new task starts with confirming it;
- after a turn that only talked while a task is open, one follow-up turn
  carries on (at most 3 in a row without new input);
- after an unusable decision the next idle tick runs a turn even if nothing
  changed (up to 3 retries, then it waits for a change and says so);
- at most 2 lookups in a row, and never the same query twice in a row.
"""
from __future__ import annotations

import asyncio
import difflib
import json
import re
import time
from collections import deque
from pathlib import Path

from . import CONTRACT_VERSION, wiki
from .lessons import LessonStore, age, failure_class
from .actions import ActionError, extract_json, parse
from .config import Config
from .llm import LLMError
from .notes import Notes
from .prompt import OUTPUT_FORMAT, context, load_verb_reference, system_prompt
from .render import history_line, render_inventory, render_obs, render_surroundings
from .tasks import OPEN, TaskList, one_line, place_cell

V = CONTRACT_VERSION
QUIET_VERBS = {"say", "recall", "stop"}  # their results don't wake a turn
MAX_FOLLOW_UPS = 3
IDLE_VERBS = {"eat", "say", "stop"}
# With no open task, the events that still get a turn (besides task_from_chat, player_said and
# stop_requested, which always do, and the low health / low food wakes). The kinds the body actually
# emits are listed in docs/verbs.md, "Events": task_from_chat, player_said, stop_requested,
# damaged_badly, died, respawned, player_joined, player_left.
IDLE_WAKE_EVENTS = {"died", "damaged_badly"}
# Idle never forbids saving yourself (Session 8b): with no open task, any verb is allowed while health is
# below DANGER_HEALTH or within DAMAGE_WINDOW_S of taking damage (a damaged_badly event, or health falling).
DANGER_HEALTH = 10
DAMAGE_WINDOW_S = 15
MAX_ERROR_RETRIES = 3
MAX_LOOKUPS_IN_ROW = 2
HINT_TURNS = 5  # LOOKUP and other hints expire after this many turns (stall hints also when the target changes)
FAILED_WINDOW = 10  # a call that failed within the last 10 RECENT lines is not sent again


class Recent(deque):
    """The RECENT lines; n counts every line ever added, so "within the last
    10 lines" can be checked after older ones have rolled off."""

    def __init__(self, maxlen: int):
        super().__init__(maxlen=maxlen)
        self.n = 0

    def append(self, line) -> None:
        self.n += 1
        super().append(line)
NOISE_RE = re.compile(r"\[[^\]]*\]|-?\b\d+(\.\d+)?\b|\bm\d+\b")  # coordinates, numbers, call ids
SAY_REPEAT_WINDOW_S = 60  # a say matching one of the last 3 says within this window is dropped
STUCK_RE = re.compile(r"\b(stuck|gave up)\b")  # a partial with this in its detail counts as failed


def norm_request(text: str) -> str:
    """A request without its "@Name" prefix, lower case, single spaces."""
    t = re.sub(r"^\s*@\w+[\s,:]*", "", str(text))
    return " ".join(t.lower().split())


def norm_say(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", text.lower()).split())


PLAN_NEXT = "\x00plan-next"  # internal wake: run the next plan step, no model call


def target_of(verb: str, args) -> str | None:
    """What a call is after (block, item, player, target or position), for "the target changed"."""
    a = args or {}
    tgt = a.get("block") or a.get("item") or a.get("target") or a.get("player")
    if isinstance(tgt, str):
        return f"{verb} {tgt}"
    if isinstance(a.get("pos"), list):
        return f"{verb} [" + ", ".join(str(round(v)) for v in a["pos"]) + "]"
    return None


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
    def __init__(self, cfg: Config, llm, *, log=default_log, retriever=None):
        self.cfg = cfg
        self.llm = llm
        self.log = log
        self.tasks = TaskList()
        self.notes = Notes(cfg.notes_file, cfg.notes_max_lines)
        ref = load_verb_reference(cfg.verb_reference, play=cfg.player_play)
        self.verbs = verbs_in_reference(ref)
        self.system = system_prompt(cfg.bot_name, ref, cfg.retreat_health)
        self.obs: dict | None = None
        self.recent: Recent = Recent(cfg.history)
        self.pending: dict[str, dict] = {}
        self.wakes: asyncio.Queue[str] = asyncio.Queue()
        self.asking: dict | None = None
        self.failures: list[dict] = []  # {verb, args (canonical), detail, at (RECENT line number), turn, stall, target}
        self.low_health = False
        self.last_health = None
        self.damaged_at: float | None = None  # monotonic time of the last damage taken (in_danger)
        self.hungry = False
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
        self.says: deque = deque(maxlen=3)  # (normalised text, time) of the last says sent
        self.connect_t = None  # game tick of the first obs since the link came up
        self.last_call_target: dict[str, str] = {}
        self.fuse_streak: tuple = (None, 0)  # (call key, identical failures in a row)
        self.lessons = LessonStore(cfg.lessons_file, cfg.server, cfg.lessons_max)
        self.lesson_queue: list[dict] = []  # situations waiting for a lesson turn
        self.class_streak: dict | None = None  # {cls, n, verb, args, detail, task}: same failure class in a row
        self.stuck: dict | None = None  # the streak once it reached 2 (stuck mode: a STUCK line, nothing refused)
        self.fuse_until = 0.0  # verb -> target of its latest call
        self.call_meta: dict[str, tuple] = {}  # call id -> (task id, place cell when sent)
        self.retriever = retriever if retriever is not None else wiki.load_retriever(cfg.wiki_index)
        if self.retriever is None:
            self.log(f"[mind] no wiki index at {cfg.wiki_index}: no KNOWLEDGE (see README, Wiki knowledge)")
        self.last_failure: str | None = None  # detail of the latest failed result (until a verb succeeds)
        self.last_target: str | None = None  # what the latest verb call was after (block, item, player…)
        self.lookup: dict | None = None  # {"query", "text", "titles", "turns"}: shown as LOOKUP
        self.lookups_in_row = 0

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
            stalled = m["status"] == "partial" and bool(STUCK_RE.search(m.get("detail") or ""))
            failed = m["status"] in ("failed", "refused") or stalled  # a stuck/gave-up partial is a failure for the repeat guard
            tid, place = self.call_meta.pop(m["id"], (None, None))
            task = self.tasks.get(tid)
            if task and call["verb"] not in QUIET_VERBS and m["detail"] != "busy":
                self.tasks.result(task, call["verb"], call.get("args"), place, m["status"], m.get("detail") or "", failed)
            if call["verb"] not in QUIET_VERBS and m["detail"] != "busy":
                self.fuse_check(call, failed)
                self.class_check(call, m, failed, task)
            if failed and m["detail"] != "busy":
                key = (call["verb"], canon(call.get("args")))
                self.failures = [f for f in self.failures if (f["verb"], f["args"]) != key]
                self.failures.append({"verb": key[0], "args": key[1], "detail": m["detail"], "at": self.recent.n,
                                      "turn": self.turns, "stall": stalled or bool(STUCK_RE.search(m.get("detail") or "")),
                                      "target": target_of(call["verb"], call.get("args"))})
                self.last_failure = m["detail"]
            elif m["status"] == "done" and call["verb"] not in QUIET_VERBS:
                self.last_failure = None
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
            elif kind in ("damaged_badly", "died"):
                self.damaged_at = time.monotonic()
                self.wake(f"event {kind}" + (f" {json.dumps(d, separators=(',', ':'))}" if d else ""))
            elif kind == "stop_requested":
                stopped = self.tasks.stop_working()
                for st in stopped:
                    self.lesson_closed(st, "stopped")
                self.asking = None
                self.wake(f"stop requested by {d.get('from', 'someone')}" + (f"; {', '.join(t.id for t in stopped)} stopped" if stopped else ""))
            else:
                if self.tasks.open() or kind in IDLE_WAKE_EVENTS:
                    self.wake(f"event {kind}")
                else:
                    self.dirty = True  # e.g. player_joined with nothing to do: noted, no turn

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
        p["cid"] = await self.call(st["verb"], st["args"], task)
        if p["cid"] is None:  # a dropped (repeated) say: carry on
            self.wakes.put_nowait(PLAN_NEXT) if p["steps"] else self.plan_step_done(st, {"status": "done", "detail": "skipped"})

    def set_obs(self, o: dict) -> None:
        self.obs = o
        if self.connect_t is None and isinstance(o.get("t"), (int, float)):
            self.connect_t = o["t"]  # the first obs after (re)connecting: its chat is all from before
        if self.turn_fp is None:
            self.turn_fp = fingerprint(o)  # the baseline: nothing has changed yet
        h = o.get("self", {}).get("health")
        if isinstance(h, (int, float)):
            if isinstance(self.last_health, (int, float)) and h < self.last_health:
                self.damaged_at = time.monotonic()  # taking damage, whatever the event stream says
            self.last_health = h
            if h < self.cfg.retreat_health and not self.low_health:
                self.low_health = True
                self.wake(f"health is low ({h}/20)")
            elif h >= self.cfg.retreat_health:
                self.low_health = False
        f = o.get("self", {}).get("food")
        if isinstance(f, (int, float)):
            if f < self.cfg.hungry_food and not self.hungry:
                self.hungry = True
                self.wake(f"food is low ({f}/20)")
            elif f >= self.cfg.hungry_food:
                self.hungry = False

    def fresh_obs(self) -> dict | None:
        """The obs as the model sees it: chat from before the mind connected
        (obs.chat is the body's rolling buffer) is left out. Old "@Atlas …"
        lines are not tasks: tasks come only from task_from_chat events
        received on this connection."""
        o = self.obs
        if not o or not o.get("chat"):
            return o
        chat = []
        for c in o["chat"]:
            if self.connect_t is not None and (c.get("t") or 0) <= self.connect_t:
                continue
            t = self.task_of_chat(c)
            if t and t.state in ("done", "stopped"):
                continue  # a delivered request: never shown as something to do again
            chat.append({**c, "text": f"{c.get('text', '')} (-> {t.id} {t.state})"} if t else c)
        return {**o, "chat": chat}

    def task_of_chat(self, c: dict):
        """The task a chat line became (same player, same request), or None."""
        text = norm_request(c.get("text", ""))
        if not text:
            return None
        for t in reversed(self.tasks.tasks):
            if t.by == c.get("from") and norm_request(t.text) == text:
                return t
        return None

    def changed_since_turn(self) -> bool:
        return self.dirty or self.tasks.version != self.turn_tasks or fingerprint(self.obs) != self.turn_fp

    # ---- thinking -------------------------------------------------------------
    # ---- failures and hints -------------------------------------------------------
    # ---- lessons and stuck mode ---------------------------------------------------
    def situation(self, task=None, verb: str | None = None, cls: str | None = None) -> dict:
        s = ((self.obs or {}).get("surroundings") or {}).get("summary")
        return {"verb": verb or (self.class_streak or {}).get("verb"), "failure_class": cls or (self.class_streak or {}).get("cls"),
                "surroundings_sentence": s, "task_text": task.text if task else None}

    def class_check(self, call: dict, m: dict, failed: bool, task) -> None:
        """Same failure class (same verb, same reason family) twice in a row: a lesson turn, and stuck mode
        (a STUCK line in the context until something else happens). Nothing is refused."""
        if not failed:
            if m["status"] == "done":
                self.class_streak = None
                self.stuck = None
            return
        cls = failure_class(call["verb"], m.get("detail") or "")
        n = self.class_streak["n"] + 1 if self.class_streak and self.class_streak["cls"] == cls else 1
        self.class_streak = {"cls": cls, "n": n, "verb": call["verb"], "args": canon(call.get("args")), "detail": m.get("detail") or "",
                             "task": task.id if task else None}
        if n >= 2:
            self.stuck = dict(self.class_streak)
        else:
            self.stuck = None
        if n == 2 and self.cfg.lessons:
            self.lesson_queue.append({"why": f"{cls} came back twice in a row", "outcome": "failing",
                                      "situation": self.situation(task, call["verb"], cls), "task": task.id if task else None})

    def lesson_closed(self, task, outcome: str) -> None:
        if self.cfg.lessons:
            self.lesson_queue.append({"why": f"{task.id} {outcome}", "outcome": outcome, "situation": self.situation(task), "task": task.id})

    def lesson_query(self) -> str:
        parts = [t.text for t in (self.tasks.working() or self.tasks.open())[-2:]]
        if self.last_failure:
            parts.append(self.last_failure)
        s = ((self.obs or {}).get("surroundings") or {}).get("summary")
        if s:
            parts.append(s)
        return " ".join(parts)

    def lessons_block(self) -> str:
        found = self.lessons.search(self.lesson_query(), self.cfg.lessons_k)
        if not found:
            return ""
        lines = [f"- ({age(r.get('t'))}) {r['lesson']}" for r, _ in found]
        return "LESSONS (from your own play; use them over your memory when they disagree)\n" + "\n".join(lines) + "\n\n"

    def stuck_line(self) -> str:
        s = self.stuck
        if not s:
            return ""
        found = self.lessons.search(f"{s['cls']} {s['detail']}", self.cfg.lessons_k)
        ls = "; ".join(f"\"{r['lesson']}\" ({age(r.get('t'))})" for r, _ in found) or "none yet"
        return (f"\nSTUCK: \"{s['cls']}\" came back {s['n']}x in a row (last: {s['verb']} {s['args']} -> {one_line(s['detail'], 120)}). "
                f"Lessons for it: {ls}. Your next action should be different in kind: a lookup, a different verb or target, "
                "a lesson, or ask_player.\n")

    async def store_lesson(self, text: str, situation: dict, outcome: str, why: str) -> None:
        rec = self.lessons.add(text, situation, outcome)
        self.recent.append(f"you learned: {rec['lesson']}")
        self.log(f"[mind] lesson ({why}): {rec['lesson']}")
        await self.send({"type": "trace", "v": V, "t": (self.obs or {}).get("t", 0), "kind": "lesson", "text": rec["lesson"],
                         "data": {"situation": rec["situation"], "outcome": outcome, "why": why}})

    async def run_lessons(self) -> None:
        """One short model call per queued situation: {"lesson": "..."} or {"lesson": null}."""
        while self.lesson_queue:
            item = self.lesson_queue.pop(0)
            task = self.tasks.get(item.get("task"))
            happened = (self.tasks.render_journal(task) if task else []) or [f"    {x}" for x in list(self.recent)[-8:]]
            sit = item["situation"]
            user = (f"Time to write down a lesson ({item['why']}).\n"
                    f"SITUATION: verb {sit.get('verb')}; failure {sit.get('failure_class')}; surroundings: {sit.get('surroundings_sentence')}; "
                    f"task: {sit.get('task_text')}\nWHAT HAPPENED:\n" + "\n".join(happened) + "\n"
                    "A lesson is one general sentence you'd want to remember next time in a situation like this "
                    "(\"when a player is above me, goto surface first\"), not a transcript of what happened. "
                    'If there is nothing worth keeping, say so. Reply with exactly {"lesson": "..."} or {"lesson": null}.')
            msgs = [{"role": "system", "content": f"You are {self.cfg.bot_name}, a Minecraft player, keeping lessons from your own play."},
                    {"role": "user", "content": user}]
            try:
                raw = await self.llm.complete(msgs)
                obj = extract_json(str(raw))
            except (LLMError, ActionError) as e:
                self.log(f"[mind] lesson turn ({item['why']}): no usable reply ({e})")
                continue
            text = obj.get("lesson") if isinstance(obj, dict) else None
            if isinstance(text, str) and text.strip():
                await self.store_lesson(text, sit, item["outcome"], item["why"])
            else:
                self.log(f"[mind] lesson turn ({item['why']}): nothing to keep")

    def fuse_check(self, call: dict, failed: bool) -> None:
        """The fuse (not a guard: nothing is refused): the identical call failing fuse_count times in a
        row pauses the mind for fuse_s seconds, then it carries on as before."""
        key = f"{call['verb']} {canon(call.get('args'))}"
        if not failed:
            self.fuse_streak = (None, 0)
            return
        n = self.fuse_streak[1] + 1 if self.fuse_streak[0] == key else 1
        self.fuse_streak = (key, n)
        if n >= self.cfg.fuse_count:
            self.fuse_until = time.monotonic() + self.cfg.fuse_s
            self.fuse_streak = (None, 0)
            self.log(f"[mind] fuse: {key} ×{n}; pausing {self.cfg.fuse_s:g} s")

    def recent_failures(self) -> list[dict]:
        """Failed calls still in force: within the last FAILED_WINDOW RECENT lines and
        HINT_TURNS turns. A stuck/gave-up one also ends when a later call of the same
        verb goes after a different target (the route changed)."""
        out = []
        for f in self.failures:
            if self.recent.n - f["at"] >= FAILED_WINDOW or self.turns - f["turn"] >= HINT_TURNS:
                continue
            if f["stall"] and f["target"] and self.last_call_target.get(f["verb"]) not in (None, f["target"]):
                continue
            out.append(f)
        self.failures = out
        return out

    def hint_alive(self, h: dict | None) -> bool:
        return bool(h) and self.turns - h["turn"] <= HINT_TURNS

    # ---- knowledge --------------------------------------------------------------
    def rag_query(self) -> str:
        """What to retrieve for: the open tasks' text, the last failure, the current verb target."""
        tasks = self.tasks.working() or self.tasks.open()
        parts = [t.text for t in tasks[-2:]]
        if self.last_failure:
            parts.append(self.last_failure)
        if self.last_target:
            parts.append(self.last_target)
        q = NOISE_RE.sub(" ", " ".join(parts)).replace("@" + self.cfg.bot_name, " ")
        return " ".join(q.split())[:400]

    def retrieve(self, query: str, budget: int, exclude=()) -> tuple[str, list[str]]:
        """(rendered excerpts, chunk titles) for a query, within a token budget."""
        if self.retriever is None or not query:
            return "", []
        hits = [h for h in self.retriever.search(query, self.cfg.rag_k + len(exclude)) if h.id not in exclude][: self.cfg.rag_k]
        pairs = wiki.excerpts(hits, query, budget)
        return wiki.render(pairs), [h.title for h, _ in pairs]

    async def knowledge(self) -> str:
        """This turn's KNOWLEDGE (and LOOKUP) blocks; a rag trace when there is knowledge."""
        out, shown = "", ()
        if self.lookup and self.turns > self.lookup["turn"] and self.hint_alive(self.lookup):
            shown = self.lookup["ids"]  # not repeated under KNOWLEDGE
            out += f'LOOKUP "{self.lookup["query"]}" (from the wiki; use it over your memory)\n{self.lookup["text"]}\n\n'
        out += self.lessons_block()
        q = self.rag_query()
        text, titles = self.retrieve(q, self.cfg.rag_tokens, exclude=shown)
        if text:
            out += f"KNOWLEDGE (Minecraft wiki excerpts for what you're doing; use them over your memory)\n{text}\n"
            await self.send({"type": "trace", "v": V, "t": (self.obs or {}).get("t", 0), "kind": "rag", "text": q,
                             "data": {"query": q, "titles": titles, "tokens": wiki.tokens(text), "lookup": False}})
        return out

    async def do_lookup(self, a: dict) -> None:
        q = a["query"]
        if self.retriever is None:
            text, titles, ids = "(no wiki index on this machine: rely on what you know)", [], []
        else:
            hits = self.retriever.search(q, self.cfg.rag_k)
            pairs = wiki.excerpts(hits, q, self.cfg.lookup_tokens)
            text, titles, ids = (wiki.render(pairs) or "(nothing found)"), [h.title for h, _ in pairs], [h.id for h, _ in pairs]
        self.lookup = {"query": q, "text": text, "titles": titles, "ids": ids, "turn": self.turns}
        self.recent.append(f'you looked up "{q}": ' + ("; ".join(titles) if titles else "nothing found"))
        await self.send({"type": "trace", "v": V, "t": (self.obs or {}).get("t", 0), "kind": "rag", "text": q,
                         "data": {"query": q, "titles": titles, "tokens": wiki.tokens(text), "lookup": True}})

    def messages(self, wake: str, knowledge: str = "") -> list[dict]:
        extra = ""
        if self.asking:
            extra = f"\nWAITING for {self.asking['player']} to answer: {self.asking['text']}\n"
        extra += self.stuck_line()
        fails = self.recent_failures()
        if fails:
            extra += "\nFAILED RECENTLY (don't repeat): " + "; ".join(
                f"{f['verb']} {f['args']} -> {one_line(f['detail'], 90)}" for f in fails[-4:]) + "\n"
        user = context(self.tasks.render(), render_obs(self.fresh_obs(), inventory=False), list(self.recent), self.notes.render(), wake, extra,
                       knowledge, render_inventory(self.obs), render_surroundings(self.obs) if self.obs else "")
        return [{"role": "system", "content": self.system}, {"role": "user", "content": user}]

    def resolve_task_ref(self, value: str):
        """A task for an "about"/"closes" value, leniently: the exact id (any
        case); else an open task whose text matches the value (substring
        either way, or similarity >= 0.7; models sometimes use the task's
        text as its id); else the only open task. (task, how) or (None, None)."""
        v = str(value).strip()
        t = self.tasks.get(v) or self.tasks.get(v.lower())
        if t:
            return t, "id"
        open_ = self.tasks.open()
        low = v.lower()
        scored = []
        for t in open_:
            text = t.text.lower()
            if low and (low in text or text in low):
                scored.append((1.0, t))
            else:
                r = difflib.SequenceMatcher(None, low, text).ratio()
                if r >= 0.7:
                    scored.append((r, t))
        if scored:
            return max(scored, key=lambda x: x[0])[1], "text"
        if len(open_) == 1:
            return open_[0], "only open task"
        return None, None

    def resolve_refs(self, a: dict) -> None:
        """Rewrite "about"/"closes" to real task ids, or drop them with a warning.
        A decision is never rejected over these fields."""
        for k in ("about", "closes"):
            if k not in a:
                continue
            t, how = self.resolve_task_ref(a[k])
            if t is None:
                self.log(f'[mind] warning: {k}="{a[k]}" matches no task; dropped it (tasks: {", ".join(x.id for x in self.tasks.tasks) or "none"})')
                del a[k]
            elif how != "id" or t.id != a[k]:
                self.log(f'[mind] {k}="{a[k]}" taken as {t.id} ({how})')
                a[k] = t.id
        if a["action"] == "done" and "closes" not in a:
            a.clear()
            a.update({"action": "wait", "thinking": "done for a task that doesn't exist; waiting"})

    def task_for(self, a: dict):
        """The task an action is for: "closes", "about" (already resolved), or the one task being worked on."""
        tid = a.get("closes") or a.get("about")
        if tid:
            return self.tasks.get(tid)
        working = self.tasks.working()
        return working[0] if len(working) == 1 and a["action"] in ("call", "plan", "ask_player") else None

    def in_danger(self) -> bool:
        """Health below DANGER_HEALTH, or damage taken within the last DAMAGE_WINDOW_S seconds."""
        h = ((self.obs or {}).get("self") or {}).get("health")
        if isinstance(h, (int, float)) and h < DANGER_HEALTH:
            return True
        return self.damaged_at is not None and time.monotonic() - self.damaged_at < DAMAGE_WINDOW_S

    def idle_allows(self, a: dict) -> bool:
        """With no open task: say, note, wait, lookup, eat (and stop); while in danger (hurt, or taking
        damage), any verb: being idle never forbids saving yourself. Work verbs stay off otherwise."""
        def call_ok(verb: str) -> bool:
            return verb in IDLE_VERBS or self.in_danger()
        if a["action"] in ("say", "note", "wait", "lookup", "lesson"):  # lookup and lesson don't act in the world
            return True
        if a["action"] == "call":
            return call_ok(a["verb"])
        if a["action"] == "plan":
            return all(call_ok(st["verb"]) for st in a["steps"])
        return False

    def check(self, raw: str) -> dict:
        a = parse(raw, self.verbs)
        self.resolve_refs(a)
        if not self.tasks.open() and not self.idle_allows(a):
            what = a.get("verb") or a["action"]
            raise ActionError(f"no open task, so you are idle: {what} is not allowed. Idle allows say, note, wait and eat "
                              f"(and any verb while health is below {DANGER_HEALTH} or you are taking damage). Work comes from players "
                              "(@-tasks); a standing task is how a player keeps you doing something. Reply with wait.")
        t = self.task_for(a)
        if t and a["action"] in ("say", "ask_player", "call", "done") and t.state in ("done", "stopped"):
            raise ActionError(f"{t.id} is already {t.state}; leave it alone")
        if t and a["action"] == "say" and "closes" not in a and t.state == "confirmed":
            said = f' (you said: "{t.said[-1]}")' if t.said else ""
            raise ActionError(f"{t.id} is already confirmed{said}. Don't confirm it again: start it with a call (about {t.id}), "
                              f'or finish it with a say that has "closes": "{t.id}".')
        if t and a["action"] == "call" and a["verb"] not in QUIET_VERBS and t.state == "new":
            raise ActionError(f"{t.id} is new: confirm it in chat first (a say with \"about\": \"{t.id}\"), then start it.")
        if a["action"] == "lookup":
            if self.lookups_in_row >= MAX_LOOKUPS_IN_ROW:
                raise ActionError(f"you already looked up {self.lookups_in_row} times in a row; act on what LOOKUP and KNOWLEDGE say.")
            if self.lookup and self.lookups_in_row and a["query"].lower() == self.lookup["query"].lower():
                raise ActionError(f'you just looked up "{a["query"]}"; the answer is under LOOKUP. Act on it.')
        if a["action"] == "plan":
            if t and t.state == "new" and any(st["verb"] not in QUIET_VERBS for st in a["steps"]):
                raise ActionError(f"{t.id} is new: confirm it in chat first (a say with \"about\": \"{t.id}\"), then plan the work.")
        return a

    def retry_text(self, err: Exception) -> str:
        """What the model reads after an unusable reply: the reason (with the failed call's exact detail),
        then FAILED RECENTLY, then the action format, last, right before it answers."""
        fails = self.recent_failures()
        lines = [f"That reply was not usable: {err}"]
        if fails:
            lines.append("FAILED RECENTLY (don't repeat): " + "; ".join(f"{f['verb']} {f['args']} -> {f['detail']}" for f in fails[-4:]))
        lines.append("Reply again with exactly one valid JSON object, one of:")
        lines += [ln for ln in OUTPUT_FORMAT.splitlines() if ln.startswith("{")]
        return "\n".join(lines)

    def dump_context(self, msgs: list[dict], path: Path | None = None) -> Path | None:
        """ATLAS_MIND_DUMP_CONTEXT=1: the exact text the model gets, one file per turn,
        logs/context/<tick>.txt (-2, -3… when a tick has several turns); a retry is
        appended to its turn's file."""
        if not self.cfg.dump_context:
            return None
        try:
            if path is None:
                d = Path(self.cfg.dump_dir)
                d.mkdir(parents=True, exist_ok=True)
                tick = (self.obs or {}).get("t", 0)
                path = d / f"{tick}.txt"
                n = 1
                while path.exists():
                    n += 1
                    path = d / f"{tick}-{n}.txt"
            text = "".join(f"===== {m['role'].upper()} =====\n{m['content']}\n\n" for m in msgs)
            with open(path, "a", encoding="utf-8") as f:
                f.write(text)
            return path
        except OSError as e:
            self.log(f"[mind] could not write the context dump: {e}")
            return None

    def unusable(self, attempt: str, err: Exception, raw) -> None:
        finish = getattr(raw, "finish_reason", None)
        self.log(f"[llm] unusable reply ({attempt}, finish_reason={finish}): {err}")
        self.log(f"[llm] raw reply: {str(raw)[:500]!r}")

    async def decide(self, wake: str) -> dict:
        msgs = self.messages(wake, await self.knowledge())
        self.last_prompt = msgs
        dump = self.dump_context(msgs)
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
                            {"role": "user", "content": self.retry_text(e)}]
            self.dump_context(retry[-2:], dump)
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
        summary = {k: a[k] for k in ("action", "verb", "args", "text", "player", "about", "closes", "standing", "steps", "query") if k in a}
        reasoning = " / ".join(r.reasoning for r in self.replies if getattr(r, "reasoning", ""))
        if reasoning:  # native thinking: never invisible
            summary["reasoning"] = reasoning[:800] + ("…" if len(reasoning) > 800 else "")
        task = None if a.get("error") else self.task_for(a)
        # for the dashboard's charts: this turn's completion tokens, and the task it was for
        toks = [r.completion_tokens for r in self.replies if getattr(r, "completion_tokens", None) is not None]
        if toks:
            summary["tokens"] = sum(toks)
        if task:
            summary["task"] = task.id
        await self.send({"type": "trace", "v": V, "t": t, "kind": "decision", "text": a["thinking"], "data": summary})
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
            await self.call(a["verb"], a["args"], task)
        elif kind == "say":
            if task:
                self.tasks.said(task, a["text"])
                if a.get("closes"):
                    self.tasks.close(task)
                    self.lesson_closed(task, "done")
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
                self.lesson_closed(task, "done")
            self.recent.append(f"you closed {a['closes']}")
        elif kind == "lookup":
            await self.do_lookup(a)
        elif kind == "lesson":
            await self.store_lesson(a["text"], self.situation(task), "written", "written by the model")
        elif kind == "note" and task and a.get("about"):  # a "ruled out" line in the task's journal
            self.tasks.ruled_out(task, a["text"])
            self.recent.append(f"you ruled out for {task.id}: {a['text']}")
            await self.send({"type": "trace", "v": V, "t": t, "kind": "note", "text": f"ruled out ({task.id}): {a['text']}"})
        elif kind == "note":
            self.notes.append(a["text"])
            self.recent.append(f"you noted: {a['text']}")
            await self.send({"type": "trace", "v": V, "t": t, "kind": "note", "text": a["text"]})

    def repeated_say(self, text: str) -> bool:
        """Does this say match one of the last 3 says sent within the window?"""
        n = norm_say(text)
        now = self.now()
        for prev, t in self.says:
            if now - t <= SAY_REPEAT_WINDOW_S and (prev == n or difflib.SequenceMatcher(None, prev, n).ratio() >= 0.9):
                return True
        return False

    def now(self) -> float:
        return time.monotonic()

    async def call(self, verb: str, args: dict, task=None) -> str | None:
        if verb == "say" and isinstance(args.get("text"), str):
            if self.repeated_say(args["text"]):
                self.log(f'[mind] warning: dropped a repeated say (said within {SAY_REPEAT_WINDOW_S} s): "{args["text"]}"')
                self.recent.append(f'you did not repeat yourself: "{args["text"]}" was already said')
                return None
            self.says.append((norm_say(args["text"]), self.now()))
        if verb not in QUIET_VERBS:
            a = args or {}
            tgt = a.get("block") or a.get("item") or a.get("target") or a.get("player")
            self.last_target = f"{verb} {tgt}".replace("_", " ") if isinstance(tgt, str) else verb
        self._n += 1
        cid = f"m{self._n}"
        if task is not None and verb not in QUIET_VERBS:
            place = place_cell(((self.obs or {}).get("self") or {}).get("pos"))
            self.call_meta[cid] = (task.id, place)
        msg = {"type": "call", "v": V, "id": cid, "verb": verb, "args": args}
        self.pending[cid] = msg
        if verb not in QUIET_VERBS and target_of(verb, args):
            self.last_call_target[verb] = target_of(verb, args)
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
        self.lookups_in_row = self.lookups_in_row + 1 if a["action"] == "lookup" else 0
        self.turn_tasks = self.tasks.version  # what this turn did itself is not news
        if a["action"] == "lookup":
            self.wakes.put_nowait(f'your lookup "{a["query"]}" is answered under LOOKUP')
            return
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
            pause = self.fuse_until - time.monotonic()
            if pause > 0:
                await asyncio.sleep(pause)  # the fuse: wake reasons wait, then go on as usual
            if self.lesson_queue:
                await self.run_lessons()  # before the next decision, also on idle ticks
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
                elif not self.tasks.open() and not self.low_health and not self.hungry:
                    continue  # idle: world changes alone don't cost a model call (5i-2)
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
                    self.connect_t = None
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
            self.call_meta.clear()
            self.plan = None
            await asyncio.sleep(3)
