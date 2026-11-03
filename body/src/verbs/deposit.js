'use strict'
// deposit {item, count?, chest}: walk to an observed chest (or barrel) and
// put the item in; count defaults to all of it. Giving is always allowed.
// done / partial (the chest filled up) / failed / refused (chest not observed).
const { checkArgs, failed, refused, cannotAct } = require('./common')

async function run (act, args) {
  const err = checkArgs('deposit', args)
  if (err) return failed(err)
  const api = act.api
  const { item, chest } = args
  if (!api.isItem(item)) return failed(`deposit: unknown item ${item}`)
  const no = cannotAct(api, 'deposit')
  if (no) return no
  const c = api.container(chest)
  if (c.refused) return refused(c.reason)
  if (!c.ok) return failed(`deposit: ${c.reason}`)
  const have = api.inventoryCount(item)
  if (!have) return failed(`deposit: no ${item} in inventory`)
  const count = Math.min(args.count ?? have, have)
  act.progress(`going to the ${c.type} at [${chest.join(', ')}]`)
  const g = await api.goto(chest, { kind: 'look', dig: false, scaffold: false, signal: act.signal })
  if (act.signal.aborted) return null
  if (g.status !== 'reached') return failed(`deposit: could not reach the ${c.type} at [${chest.join(', ')}] (${g.status})`)
  act.progress(`putting ${count} ${item} in the ${c.type}`)
  const r = await api.deposit(chest, item, count)
  if (act.signal.aborted) return null
  const data = { item, deposited: r.moved || 0 }
  if (!r.moved) return { status: 'failed', detail: `deposit: ${r.reason}`, data }
  const asked = args.count ?? have
  if (r.moved < asked) return { status: 'partial', detail: `put ${r.moved} of ${asked} ${item} in the ${c.type} at [${chest.join(', ')}]; ${r.reason || `only had ${have}`}`, data }
  return { status: 'done', detail: `put ${r.moved} ${item} in the ${c.type} at [${chest.join(', ')}]`, data }
}

module.exports = { run, file: __filename }
