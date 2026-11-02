'use strict'
// Runs verbs, one long-running verb at a time, and stops them.
// stop (from the mind's `stop` call or the dashboard's Stop button) aborts
// the running verb, which then returns `interrupted`, and releases every
// movement control. It works even when not connected.
const { VERBS } = require('./verbs')

const abortedP = signal => new Promise(resolve => {
  if (signal.aborted) resolve()
  else signal.addEventListener('abort', () => resolve(), { once: true })
})

class Runner {
  constructor (verbs = VERBS) {
    this.verbs = verbs
    this.current = null
  }

  /** The running verb as an obs `task`, or null. */
  task () {
    const c = this.current
    if (!c) return null
    const t = { id: c.id, verb: c.verb, args: c.args, state: 'running' }
    if (c.progress !== null) t.progress = c.progress
    return t
  }

  /** @returns {Promise<{status, detail, data?}>} */
  async run (act, call) {
    const { id, verb } = call
    const args = call.args || {}
    if (verb === 'stop') return this.stop(act, `call ${id}`)
    const def = Object.hasOwn(this.verbs, verb) ? this.verbs[verb] : null
    if (!def) return { status: 'failed', detail: `verb not implemented yet: ${verb}` }
    if (!act.connected()) return { status: 'failed', detail: 'not connected to the server' }
    if (def.instant) {
      try { return await def.run(act, args) } catch (err) { return { status: 'failed', detail: `${verb}: ${err.message}` } }
    }
    if (this.current) this.interrupt(act, `preempted by ${verb} (${id})`)
    const ctrl = new AbortController()
    const cur = { id, verb, args, ctrl, progress: null }
    this.current = cur
    const vact = { ...act, signal: ctrl.signal, progress: p => { cur.progress = String(p) } }
    try {
      const r = await Promise.race([Promise.resolve().then(() => def.run(vact, args)), abortedP(ctrl.signal)])
      if (ctrl.signal.aborted) return { status: 'interrupted', detail: `${verb}: ${ctrl.signal.reason}` }
      return r
    } catch (err) {
      if (ctrl.signal.aborted) return { status: 'interrupted', detail: `${verb}: ${ctrl.signal.reason}` }
      return { status: 'failed', detail: `${verb}: ${err.message}` }
    } finally {
      if (this.current === cur) this.current = null
    }
  }

  stop (act, source) {
    try { act.halt() } catch {}
    if (!this.current) return { status: 'done', detail: 'stopped (nothing was running)' }
    const v = this.current.verb
    this.interrupt(act, `stopped by ${source}`)
    return { status: 'done', detail: `stopped ${v}` }
  }

  interrupt (act, reason) {
    const c = this.current
    this.current = null
    c.ctrl.abort(reason)
    try { act.halt() } catch {}
  }
}

/** One-shot helper (tests, tools): run a verb on a fresh runner. */
function runVerb (act, verb, args = {}) {
  return new Runner().run(act, { id: 'x', verb, args })
}

module.exports = { Runner, runVerb }
