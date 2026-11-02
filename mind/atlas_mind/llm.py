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


class LLMError(Exception):
    pass


class OpenAICompatLLM:
    def __init__(self, url: str, model: str, key: str | None = None, temperature: float = 0.4,
                 max_tokens: int = 600, json_mode: bool = True, timeout_s: float = 120.0):
        self.url = url.rstrip("/") + "/chat/completions"
        self.model = model
        self.key = key
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.json_mode = json_mode
        self.timeout_s = timeout_s

    def _post(self, messages: Messages) -> str:
        body = {"model": self.model, "messages": messages, "temperature": self.temperature, "max_tokens": self.max_tokens}
        if self.json_mode:
            body["response_format"] = {"type": "json_object"}
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
            return data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError(f"unexpected reply shape: {str(data)[:300]}") from e

    async def complete(self, messages: Messages) -> str:
        return await asyncio.to_thread(self._post, messages)


class FakeLLM:
    """Scripted replies. Each item is a string (returned as is), a dict
    (returned as JSON) or a callable(messages) -> str|dict. Every prompt it
    receives is kept in .prompts."""

    def __init__(self, script: list):
        self.script = list(script)
        self.prompts: list[Messages] = []

    async def complete(self, messages: Messages) -> str:
        self.prompts.append([dict(m) for m in messages])
        if not self.script:
            return json.dumps({"thinking": "nothing scripted", "action": "wait"})
        item = self.script.pop(0)
        if callable(item):
            item = item(messages)
        return item if isinstance(item, str) else json.dumps(item)
