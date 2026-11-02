'use strict'
// collect {item}: walk onto visible drops of that item (in sight, same
// line-of-sight rule as entities) until none are left in sight. This is also
// how the bot receives items a player tosses to it.
// done: none left in sight. partial: some stayed out of reach.
const { checkArgs, failed, cannotAct } = require('./common')

async function run (act, args) {
  const err = checkArgs('collect', args)
  if (err) return failed(err)
  const api = act.api
  const { item } = args
  if (!api.isItem(item)) return failed(`collect: unknown item ${item}`)
  const no = cannotAct(api, 'collect')
  if (no) return no
  const startCount = api.inventoryCount(item)
  const unreachable = new Set()
  const got = () => Math.max(0, api.inventoryCount(item) - startCount)
  for (;;) {
    if (act.signal.aborted) return null
    const drops = api.visibleDrops(item).filter(d => !unreachable.has(d.id))
    if (!drops.length) break
    const d = drops[0]
    act.progress(`${got()} ${item} so far; ${drops.length} in sight, going to [${d.pos.join(', ')}]`)
    const r = await api.pickUp(d, { signal: act.signal })
    if (act.signal.aborted) return null
    if (r.refused) return { status: 'refused', detail: r.reason }
    if (!r.ok) unreachable.add(d.id)
  }
  const n = got()
  const data = { item, collected: n, unreachable: unreachable.size }
  if (unreachable.size) return { status: 'partial', detail: `collected ${n} ${item}; ${unreachable.size} drop(s) in sight could not be reached`, data }
  return { status: 'done', detail: n ? `collected ${n} ${item}; none left in sight` : `no ${item} drops in sight`, data }
}

module.exports = { run, file: __filename }
