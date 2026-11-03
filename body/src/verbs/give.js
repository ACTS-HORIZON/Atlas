'use strict'
// give {item, count = 1, player}: walk to an observed player (in sight, or
// by Locator Bar bearing until in sight), within 2 blocks, and toss the
// items at their feet. Giving is always allowed (house rules).
// done: all given. partial: some given (had fewer). failed: none to give,
// or could not reach the player. refused: player not observed.
const { checkArgs, failed, refused, cannotAct } = require('./common')
const goto = require('./goto')

async function run (act, args) {
  const err = checkArgs('give', args)
  if (err) return failed(err)
  const api = act.api
  const { item, count, player } = args
  if (!api.isItem(item)) return failed(`give: unknown item ${item}`)
  const no = cannotAct(api, 'give')
  if (no) return no
  const have = api.inventoryCount(item)
  if (!have) return failed(`give: no ${item} in inventory`)
  const r = await goto.run(act, { target: player, range: 2 })
  if (act.signal.aborted) return null
  if (r.status === 'refused') return refused(r.detail)
  if (r.status !== 'done') return failed(`give: could not reach ${player}: ${r.detail}`)
  const t = api.resolveTarget(player)
  if (!t || t.kind !== 'player') return failed(`give: ${player} is not in sight any more`)
  act.progress(`tossing ${Math.min(count, have)} ${item} to ${player}`)
  const toss = await api.toss(item, count, [t.pos[0], t.pos[1], t.pos[2]])
  if (act.signal.aborted) return null
  const given = toss.tossed || 0
  const data = { item, given }
  if (!given) return { status: 'failed', detail: `give: could not toss ${item}: ${toss.reason}`, data }
  if (given < count) return { status: 'partial', detail: `gave ${given} of ${count} ${item} to ${player}; ${toss.reason || `only had ${given}`}`, data }
  return { status: 'done', detail: `gave ${given} ${item} to ${player}`, data }
}

module.exports = { run, file: __filename }
