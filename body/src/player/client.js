'use strict'
// The decision model (CONTRACT.md, "Player loop"): d1-2B behind llama.cpp's
// /v1/systemone endpoint on Horizon. One `choice` question per tick over the
// offered micro-actions, decoded greedily (argmax of the probabilities); 60 ms budget (ATLAS_PLAYER_TIMEOUT_MS), `wait` on timeout or any error.
//
// The shape, verified on Horizon (Session 6b-2):
//   POST <ATLAS_PLAYER_URL>, the full URL, used as is, e.g.
//     http://10.0.0.140:8000/upstream/d1-2b/v1/systemone
//     (llama-swap's model-routed /v1/systemone 404s; LiteLLM doesn't know it)
//   {"model": "d1-2b", "state": "<the reflex view as a JSON string>",
//    "questions": {"action": {"type": "choice", "instructions": "<what to decide>",
//                             "criteria": {"<option>": "<one-line description>", ...}}}}
//   200 {"answers": {"action": {"choice": "retreat", "probabilities": {...},
//        "confidence": 0.498}}, "usage": {...}}
// instructions and the base criteria lines: src/player/prompt.json (shared with scripts/player_eval.py)
const PROMPT = require('./prompt.json')

/** The question's instructions: the intent's goal and the rule; null intent = the survive override. */
function instructionsFor (intent) {
  return intent ? PROMPT.instructions.replace('{intent}', intent) : PROMPT.survive_instructions
}

class LatencyStats {
  constructor (keep = 2000) { this.keep = keep; this.samples = []; this.timeouts = 0; this.errors = 0; this.ticks = 0; this.kinds = new Map(); this.since = Date.now(); this.unoffered = 0 }
  add (ms, { timedOut = false, error = false, kind = null, unoffered = false } = {}) {
    this.ticks++ // (mode: the loop measures the per-mode rates itself, see PlayerLoop.rates)
    if (timedOut) this.timeouts++
    if (unoffered) this.unoffered++
    if (error) {
      this.errors++
      const k = kind || 'error'
      this.kinds.set(k, (this.kinds.get(k) || 0) + 1)
    }
    this.samples.push(ms)
    if (this.samples.length > this.keep) this.samples.shift()
  }

  pct (p) {
    if (!this.samples.length) return null
    const s = [...this.samples].sort((a, b) => a - b)
    return Math.round(s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] * 10) / 10
  }

  /**
   * "[player] 1200 ticks in 60.0 s (20.0 Hz achieved), latency p50 17.1 ms p95 21.4 ms, 3 timeouts,
   * 2 errors (fetch failed: other side closed x2), 1 answers not offered"; resets the window.
   * rates: the loop's per-mode rates ("play 19.8 Hz (1180 ticks in 59.6 s), survive 5.0 Hz (…)") in place of the one window rate.
   */
  report (now = Date.now(), rates = null) {
    const secs = Math.max(0.001, (now - this.since) / 1000)
    const kinds = [...this.kinds].map(([k, n]) => `${k} x${n}`).join(', ')
    const hz = rates || `${(this.ticks / secs).toFixed(1)} Hz achieved`
    const line = `[player] ${this.ticks} ticks in ${secs.toFixed(1)} s (${hz}), latency p50 ${this.pct(50)} ms p95 ${this.pct(95)} ms, ` +
      `${this.timeouts} timeouts, ${this.errors} errors${kinds ? ` (${kinds})` : ''}, ${this.unoffered} answers not offered`
    this.samples = []; this.ticks = 0; this.timeouts = 0; this.errors = 0; this.unoffered = 0; this.kinds = new Map(); this.since = now
    return line
  }
}

class DecisionClient {
  /** Logged, at most 5 a minute (the rest are counted in the report). */
  warn (m) {
    const now = Date.now()
    if (!this.warned || now - this.warned.at > 60000) this.warned = { at: now, n: 0 }
    if (++this.warned.n <= 5) this.log(`[player] ${m}`)
  }

  constructor ({ url, model = 'd1-2b', timeoutMs = 60, fetchImpl = globalThis.fetch, log = m => console.warn(m) } = {}) {
    this.log = log
    this.url = url
    this.model = model
    this.timeoutMs = timeoutMs
    this.fetch = fetchImpl
    this.stats = new LatencyStats()
  }

  /**
   * A bare request, timed: the smallest state and a two-option question, outside the tick stats.
   * {ok, ms, error?}. Logged every 60 s next to the tick latency (server contention vs. the body).
   */
  async bare () {
    const t0 = performance.now()
    try {
      const res = await this.fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.request({}, ['wait', 'continue_task'], { intent: null })),
        signal: AbortSignal.timeout(Math.max(1000, this.timeoutMs * 10))
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await res.json()
      return { ok: true, ms: performance.now() - t0 }
    } catch (err) {
      return { ok: false, ms: performance.now() - t0, error: errorKind(err) }
    }
  }

  /**
   * The request body: the view as a JSON string; one choice question whose instructions carry the intent
   * and whose criteria are the offered actions, each described relative to this tick (describe() in
   * offered.js; the static base line when none is given).
   */
  request (state, offered, { intent = state && state.intent, criteria = null } = {}) {
    const c = {}
    for (const a of offered) c[a] = (criteria && criteria[a]) || PROMPT.descriptions[a] || a
    return { model: this.model, state: JSON.stringify(state), questions: { action: { type: 'choice', instructions: instructionsFor(intent), criteria: c } } }
  }

  /**
   * {choice, probabilities, confidence, margin, latency, timedOut, serverChoice?, error?}. The choice is the
   * argmax of the returned probabilities over the offered actions (confidence = its probability, margin = it
   * minus the runner-up), never the server's `choice` field alone; without probabilities, the server's choice.
   * Always one of offered ('wait' on any trouble).
   */
  async choose (state, offered, opts = {}) {
    const t0 = performance.now()
    const fallback = offered.includes('wait') ? 'wait' : offered[0]
    try {
      const res = await this.fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.request(state, offered, opts)),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      const a = body && body.answers && body.answers.action
      if (body && body.usage) this.usage = body.usage
      const latency = performance.now() - t0
      const d = decode(a, offered)
      const unoffered = !d.choice
      this.stats.add(latency, { unoffered, mode: opts.mode })
      if (unoffered) this.warn(`answer not offered: ${a && a.choice}`)
      const choice = d.choice || fallback
      return {
        choice,
        probabilities: (a && a.probabilities) || null,
        confidence: d.confidence,
        margin: d.margin,
        latency,
        timedOut: false,
        ...(a && a.choice && a.choice !== choice && !unoffered ? { serverChoice: a.choice } : {}),
        ...(unoffered ? { error: `answer not offered: ${a && a.choice}` } : {})
      }
    } catch (err) {
      const latency = performance.now() - t0
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
      const kind = timedOut ? null : errorKind(err)
      this.stats.add(latency, { timedOut, error: !timedOut, kind, mode: opts.mode })
      if (!timedOut) this.warn(`decision error: ${kind}`)
      return { choice: fallback, probabilities: null, confidence: null, margin: null, latency, timedOut, ...(timedOut ? {} : { error: kind }) }
    }
  }
}

/**
 * The answer, decoded greedily: the offered action with the highest probability. {choice|null, confidence, margin}.
 * The server's `choice` is used only when it returns no probabilities for any offered action.
 */
function decode (a, offered) {
  const probs = (a && a.probabilities) || {}
  const ranked = offered.filter(o => typeof probs[o] === 'number').sort((x, y) => probs[y] - probs[x] || offered.indexOf(x) - offered.indexOf(y))
  if (ranked.length) {
    const top = probs[ranked[0]]
    const second = ranked.length > 1 ? probs[ranked[1]] : 0
    return { choice: ranked[0], confidence: r3(top), margin: r3(top - second) }
  }
  if (a && offered.includes(a.choice)) return { choice: a.choice, confidence: a.confidence ?? null, margin: null }
  return { choice: null, confidence: null, margin: null }
}
const r3 = v => Math.round(v * 1000) / 1000

/** "fetch failed: other side closed", "HTTP 503", "bad JSON: …": what went wrong, with undici's cause. */
function errorKind (err) {
  const msg = String((err && err.message) || err)
  const cause = err && err.cause && (err.cause.code || err.cause.message)
  return cause ? `${msg}: ${cause}` : msg
}

/**
 * A chooser from a function (tests, or a scripted policy): fn(state, offered, opts) -> action name, or
 * {choice, confidence} (a scripted policy is sure of itself: confidence 1 unless it says otherwise).
 */
class ScriptedChooser {
  constructor (fn) { this.fn = fn; this.stats = new LatencyStats() }
  async choose (state, offered, opts = {}) {
    const t0 = performance.now()
    const r = await this.fn(state, offered, opts)
    const c = r && typeof r === 'object' ? r.choice : r
    const confidence = r && typeof r === 'object' && typeof r.confidence === 'number' ? r.confidence : 1
    const latency = performance.now() - t0
    this.stats.add(latency, { mode: opts.mode })
    return { choice: offered.includes(c) ? c : (offered.includes('wait') ? 'wait' : offered[0]), probabilities: null, confidence, margin: null, latency, timedOut: false }
  }
}

module.exports = { DecisionClient, ScriptedChooser, LatencyStats, instructionsFor, errorKind, decode, PROMPT }
