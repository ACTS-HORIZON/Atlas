'use strict'
// The decision model (CONTRACT.md, "Player loop"): d1-2B behind llama.cpp's
// /v1/systemone endpoint on Horizon. One `choice` question per tick over the
// offered micro-actions; 40 ms budget, `wait` on timeout or any error.
//
// Request/response, from the 2026-11-01 bench (Outline, "Decision model
// bench", ~/bench/s1bench.py):
//   POST <url>  {"model", "state", "questions"}
//   200 {"model", "answers": {"action": {"type": "choice", "choice": "retreat",
//        "probabilities": {...}, "confidence": 0.498}}, "usage": {...}}
// The bench note gives the request's top-level fields but not the exact
// shape of one entry in `questions`; it is built in one place, request(),
// as {action: {type: "choice", question, choices}}. Check it against
// s1bench.py and adjust there.

const QUESTION = 'Which action should the player take right now, given the state and the intent?'

class LatencyStats {
  constructor (keep = 2000) { this.keep = keep; this.samples = []; this.timeouts = 0; this.errors = 0; this.ticks = 0 }
  add (ms, { timedOut = false, error = false } = {}) {
    this.ticks++
    if (timedOut) this.timeouts++
    if (error) this.errors++
    this.samples.push(ms)
    if (this.samples.length > this.keep) this.samples.shift()
  }

  pct (p) {
    if (!this.samples.length) return null
    const s = [...this.samples].sort((a, b) => a - b)
    return Math.round(s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] * 10) / 10
  }

  /** "[player] 1200 ticks, latency p50 17.1 ms p95 21.4 ms, 3 timeouts, 0 errors"; resets the window. */
  report () {
    const line = `[player] ${this.ticks} ticks, latency p50 ${this.pct(50)} ms p95 ${this.pct(95)} ms, ${this.timeouts} timeouts, ${this.errors} errors`
    this.samples = []; this.ticks = 0; this.timeouts = 0; this.errors = 0
    return line
  }
}

class DecisionClient {
  constructor ({ url, model = 'd1-2B', timeoutMs = 40, fetchImpl = globalThis.fetch } = {}) {
    this.url = url
    this.model = model
    this.timeoutMs = timeoutMs
    this.fetch = fetchImpl
    this.stats = new LatencyStats()
  }

  request (state, offered) {
    return { model: this.model, state, questions: { action: { type: 'choice', question: QUESTION, choices: offered } } }
  }

  /** {choice, probabilities, confidence, latency, timedOut, error?}; choice is always one of offered ('wait' on any trouble). */
  async choose (state, offered) {
    const t0 = performance.now()
    const fallback = offered.includes('wait') ? 'wait' : offered[0]
    try {
      const res = await this.fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.request(state, offered)),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      const a = body && body.answers && body.answers.action
      const latency = performance.now() - t0
      this.stats.add(latency)
      const choice = a && offered.includes(a.choice) ? a.choice : fallback
      return { choice, probabilities: (a && a.probabilities) || null, confidence: (a && a.confidence) ?? null, latency, timedOut: false, ...(choice !== (a && a.choice) ? { error: `answer not offered: ${a && a.choice}` } : {}) }
    } catch (err) {
      const latency = performance.now() - t0
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError')
      this.stats.add(latency, { timedOut, error: !timedOut })
      return { choice: fallback, probabilities: null, confidence: null, latency, timedOut, ...(timedOut ? {} : { error: String(err.message || err) }) }
    }
  }
}

/** A chooser from a function (tests, or a scripted policy): fn(state, offered) -> action name. */
class ScriptedChooser {
  constructor (fn) { this.fn = fn; this.stats = new LatencyStats() }
  async choose (state, offered) {
    const t0 = performance.now()
    const c = await this.fn(state, offered)
    const latency = performance.now() - t0
    this.stats.add(latency)
    return { choice: offered.includes(c) ? c : (offered.includes('wait') ? 'wait' : offered[0]), probabilities: null, confidence: null, latency, timedOut: false }
  }
}

module.exports = { DecisionClient, ScriptedChooser, LatencyStats, QUESTION }
