'use strict'
// Built-in verbs: say, recall, goto, explore, mine, collect, craft, place,
// equip, dig, eat, give, deposit, withdraw, smelt (stop is the
// Runner's own). Everything else answers failed. Verbs get `act` and never
// touch the backend:
//   act.connected() -> bool, act.chat(text), act.halt(),
//   act.here() -> {pos, dim, t}, act.places (KnownPlaces),
//   act.api (VerbApi: the filtered API, src/api.js), act.cfg
// Verbs that become the task also get act.signal (AbortSignal) and
// act.progress(text). Which verbs run alongside a running one is decided by
// the Runner (ALONGSIDE), not here.
const { check } = require('../schema')

const MAX_SAY = 256

const VERBS = {
  say: {
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

VERBS.say.file = VERBS.recall.file = __filename
VERBS.goto = require('./goto')
VERBS.explore = require('./explore')
VERBS.mine = require('./mine')
VERBS.collect = require('./collect')
VERBS.craft = require('./craft')
VERBS.place = require('./place')
VERBS.equip = require('./equip')
VERBS.dig = require('./dig')
VERBS.eat = require('./eat')
VERBS.give = require('./give')
VERBS.deposit = require('./deposit')
VERBS.withdraw = require('./withdraw')
VERBS.smelt = require('./smelt')

module.exports = { VERBS }
