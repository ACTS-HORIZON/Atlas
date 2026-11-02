'use strict'
// eat {item?}: eat a named food, or the best food in the inventory (harmful
// ones like rotten_flesh only when named). Fails when not hungry (food 20).
const { checkArgs, failed, cannotAct } = require('./common')

async function run (act, args) {
  const err = checkArgs('eat', args || {})
  if (err) return failed(err)
  const api = act.api
  const no = cannotAct(api, 'eat')
  if (no) return no
  const before = api.food()
  if (before >= 20) return failed('eat: not hungry (food 20/20)')
  let item = args && args.item
  if (item) {
    if (!api.isItem(item)) return failed(`eat: unknown item ${item}`)
    if (!api.isFood(item)) return failed(`eat: ${item} is not food`)
    if (!api.inventoryCount(item)) return failed(`eat: no ${item} in inventory`)
  } else {
    const best = api.foods().find(f => !f.harmful)
    if (!best) return failed(api.foods().length ? `eat: only harmful food in inventory (${api.foods().map(f => f.name).join(', ')}); name it to eat it anyway` : 'eat: no food in inventory')
    item = best.name
  }
  act.progress(`eating ${item}`)
  const r = await api.eat(item)
  if (act.signal.aborted) return null
  if (!r.ok) return failed(`eat: ${r.reason}`)
  const after = api.food()
  return { status: 'done', detail: `ate ${item}; food ${before} → ${after}`, data: { item, food_before: before, food_after: after } }
}

module.exports = { run, file: __filename }
