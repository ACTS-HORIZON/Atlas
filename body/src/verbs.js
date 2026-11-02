'use strict'
// Verbs implemented this session: say, stop. Everything else answers failed.
// `act` is the body's (small) action API, so verbs never touch the backend:
//   act.connected() -> bool, act.chat(text), act.halt()

const MAX_SAY = 256

function say (act, args) {
  if (typeof args.text !== 'string') return { status: 'failed', detail: 'say needs args.text (string)' }
  const text = args.text.replace(/[\r\n]+/g, ' ').trim()
  if (!text) return { status: 'failed', detail: 'say: empty text' }
  // The bot never runs commands: anything the server would parse as one is refused.
  if (text.startsWith('/')) return { status: 'refused', detail: 'say: text starting with "/" would run a command; the bot never runs commands' }
  if (text.length > MAX_SAY) return { status: 'failed', detail: `say: text longer than ${MAX_SAY} characters` }
  act.chat(text)
  return { status: 'done', detail: `said: ${text}` }
}

function stop (act) {
  // No long-running verbs exist yet; stop still releases every movement control.
  act.halt()
  return { status: 'done', detail: 'stopped (nothing was running)' }
}

const VERBS = { say, stop }

/** @returns {{status: string, detail: string}} */
function runVerb (act, verb, args = {}) {
  if (!Object.hasOwn(VERBS, verb)) return { status: 'failed', detail: `verb not implemented yet: ${verb}` }
  if (!act.connected()) return { status: 'failed', detail: 'not connected to the server' }
  try {
    return VERBS[verb](act, args || {})
  } catch (err) {
    return { status: 'failed', detail: `${verb}: ${err.message}` }
  }
}

module.exports = { runVerb, VERBS }
