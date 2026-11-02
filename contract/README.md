# contract/

JSON Schema (draft 2020-12) for the link messages in [`../CONTRACT.md`](../CONTRACT.md) v0.1.
CONTRACT.md is the spec; these files only make it machine-checkable.

| File | Message | Direction |
|------|---------|-----------|
| `obs.schema.json` | `obs` (full view) | body → mind |
| `call.schema.json` | `call` | mind → body |
| `result.schema.json` | `result` | body → mind |
| `event.schema.json` | `event` | body → mind |
| `observe.schema.json` | `observe` (request a full view now) | mind → body |
| `recall.schema.json` | `recall` verb: call `args` and result `data` | — |

`result.data` carries verb output (only `recall` so far). `result.obs` and `event.obs` may be `null` only while the bot is not spawned
(e.g. between a disconnect and the reconnect).
