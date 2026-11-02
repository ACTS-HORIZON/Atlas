'use strict'
// Built-in verbs. Verbs implemented so far: say, stop, recall; everything
// else answers failed. Verbs get `act`, the body's (small) action API, and
// never touch the backend:
//   act.connected() -> bool, act.chat(text), act.halt(),
//   act.here() -> {pos, dim, t}, act.places (KnownPlaces)
// Long-running verbs also get act.signal (AbortSignal) and act.progress(text).
// `instant` verbs run alongside a running verb instead of preempting it.
// `stop` is not in this table: the Runner handles it directly.
const { check } = require('./schema')

const MAX_SAY = 256

const VERBS = {
  say: {
    instant: true,
    run (act, args) {
      if (typeof args.text !== 'string') return { status: 'failed', detail: 'say needs args.text (string)' }
      const text = args.text.replace(/[\r\n]+/g, ' ').trim()
      if (!text) return { status: 'failed', detail: 'say: empty text' }
      // The bot never runs commands: anything the server would parse as one is refused.
      if (text.startsWith('/')) return { status: 'refused', detail: 'say: text starting with "/" would run a command; the bot never runs commands' }
      if (text.length > MAX_SAY) return { status: 'failed', detail: `say: text longer than ${MAX_SAY} characters` }
      act.chat(text)
      return { status: 'done', detail: `said: ${text}` }
    }
  },

  recall: {
    instant: true,
    run (act, args) {
      const err = check('recallArgs', args)
      if (err) return { status: 'failed', detail: `recall: ${err}` }
      const here = act.here()
      const near = args.near || here.pos
      const hit = act.places.recall(args.type, near, here.dim, here.t)
      if (!hit) return { status: 'failed', detail: 'unknown' }
      return { status: 'done', detail: `${hit.type} at [${hit.pos.join(', ')}]`, data: hit }
    }
  }
}

module.exports = { VERBS }
