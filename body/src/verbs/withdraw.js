'use strict'
// withdraw {item, count = 1, chest}: take from an observed chest, only if it
// is one the bot has been given (house rules: ATLAS_CHESTS, or an
// allowlisted player saying "@<bot> that chest is yours" while looking at it).
// done / partial (the chest had fewer, or the inventory filled) / failed /
// refused (not given to the bot, or not observed).
const { checkArgs, failed, refused, cannotAct } = require('./common')

async function run (act, args) {
  const err = checkArgs('withdraw', args)
  if (err) return failed(err)
  const api = act.api
  const { item, count, chest } = args
  if (!api.isItem(item)) return failed(`withdraw: unknown item ${item}`)
  const no = cannotAct(api, 'withdraw')
  if (no) return no
  const c = api.container(chest)
  if (c.refused) return refused(c.reason)
  if (!c.ok) return failed(`withdraw: ${c.reason}`)
  if (!api.mayTakeFrom(chest)) return refused(`house rules: the ${c.type} at [${chest.join(', ')}] has not been given to Atlas (an allowlisted player can look at it and say "@Atlas that chest is yours")`)
  act.progress(`going to the ${c.type} at [${chest.join(', ')}]`)
  const g = await api.goto(chest, { kind: 'look', dig: false, scaffold: false, signal: act.signal })
  if (act.signal.aborted) return null
  if (g.status !== 'reached') return failed(`withdraw: could not reach the ${c.type} at [${chest.join(', ')}] (${g.status})`)
  act.progress(`taking ${count} ${item} from the ${c.type}`)
  const r = await api.withdraw(chest, item, count)
  if (act.signal.aborted) return null
  const data = { item, withdrawn: r.moved || 0 }
  if (!r.moved) return { status: 'failed', detail: `withdraw: ${r.reason}`, data }
  if (r.moved < count) return { status: 'partial', detail: `took ${r.moved} of ${count} ${item} from the ${c.type} at [${chest.join(', ')}]; ${r.reason || `the chest had only ${r.available}`}`, data }
  return { status: 'done', detail: `took ${r.moved} ${item} from the ${c.type} at [${chest.join(', ')}]`, data }
}

module.exports = { run, file: __filename }
