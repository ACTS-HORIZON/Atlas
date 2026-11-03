"""LLM clients. OpenAICompatLLM talks to any OpenAI-compatible chat
completions endpoint (llama.cpp server, vLLM, Ollama's /v1, ...). FakeLLM
returns scripted replies for tests."""
from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from typing import Callable

Messages = list[dict]

# With JSON mode the model answers with a bare, usually pretty-printed object.
# Generation stops at a closing brace in column 0 (the end of the top-level
# object; nested ones are indented) instead of running on to max_tokens;
# the brace itself is not returned, so it is put back.
STOP = ["\n}"]


class LLMError(Exception):
    pass


class Reply(str):
    """The model's text, with the server's finish_reason ("stop", "length", ...)."""
    finish_reason: str | None = None

    def __new__(cls, text: str, finish_reason: str | None = None):
        r = super().__new__(cls, text)
        r.finish_reason = finish_reason
        return r


def open_depth(text: str) -> int:
    """How many JSON objects are still open at the end of text (string-aware)."""
    depth, in_str, esc = 0, False, False
    for ch in text:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth = max(0, depth - 1)
    return depth


class OpenAICompatLLM:
    def __init__(self, url: str, model: str, key: str | None = None, temperature: float = 0.4,
                 max_tokens: int = 2000, json_mode: bool = True, timeout_s: float = 120.0, stop_after_object: bool = True):
        self.url = url.rstrip("/") + "/chat/completions"
        self.model = model
        self.key = key
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.json_mode = json_mode
        self.timeout_s = timeout_s
        self.stop_after_object = stop_after_object

    def _post(self, messages: Messages) -> Reply:
        body = {"model": self.model, "messages": messages, "temperature": self.temperature, "max_tokens": self.max_tokens}
        if self.json_mode:
            body["response_format"] = {"type": "json_object"}
            if self.stop_after_object:
                body["stop"] = STOP
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), method="POST",
                                     headers={"content-type": "application/json",
                                              **({"authorization": f"Bearer {self.key}"} if self.key else {})})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as r:
                data = json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise LLMError(f"HTTP {e.code} from {self.url}: {e.read()[:300]!r}") from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise LLMError(f"cannot reach {self.url}: {e}") from e
        try:
            choice = data["choices"][0]
            text = choice["message"]["content"] or ""
            finish = choice.get("finish_reason")
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError(f"unexpected reply shape: {str(data)[:300]}") from e
        # stopped on the top-level closing brace: put it back
        if self.json_mode and self.stop_after_object and finish == "stop" and text.lstrip().startswith("{") and open_depth(text) == 1:
            text = text.rstrip() + "\n}"
        return Reply(text, finish)

    async def complete(self, messages: Messages) -> Reply:
        return await asyncio.to_thread(self._post, messages)


class FakeLLM:
    """Scripted replies. Each item is a string (returned as is), a dict
    (returned as JSON), a (text, finish_reason) tuple, or a
    callable(messages) -> any of those. Every prompt it receives is kept in
    .prompts."""

    def __init__(self, script: list):
        self.script = list(script)
        self.prompts: list[Messages] = []

    async def complete(self, messages: Messages) -> Reply:
        self.prompts.append([dict(m) for m in messages])
        if not self.script:
            return Reply(json.dumps({"thinking": "nothing scripted", "action": "wait"}), "stop")
        item = self.script.pop(0)
        if callable(item):
            item = item(messages)
        if isinstance(item, tuple):
            return Reply(item[0], item[1])
        return Reply(item if isinstance(item, str) else json.dumps(item), "stop")
