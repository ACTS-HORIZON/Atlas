'use strict'
// craft {item, count = 1}
// From the inventory: a 2x2 recipe if one works, else at a crafting table
// the bot has observed (in blocks_seen or known places, within 48 blocks),
// walking to it first. It never places a table itself; that is the mind's
// call. Failed reasons are meant to be acted on: "missing 3 oak_planks",
// "missing 2 planks (any kind)", "needs crafting_table nearby".
const { checkArgs, failed, cannotAct } = require('./common')

const TABLE_RADIUS = 48

/** "3 oak_planks" or "2 planks (any kind)" / "3 of cobblestone, blackstone or cobbled_deepslate". */
function describeMissing (options) {
  const total = o => Object.values(o.missing).reduce((a, b) => a + b, 0)
  const best = total(options[0])
  const tied = options.filter(o => total(o) === best)
  // group the tied options' missing ingredients by amount and position
  const lines = []
  const first = Object.entries(tied[0].missing)
  for (let i = 0; i < first.length; i++) {
    const [name, n] = first[i]
    const alts = new Set(tied.map(o => Object.entries(o.missing)[i]?.[0]).filter(Boolean))
    if (alts.size <= 1) { lines.push(`${n} ${name}`); continue }
    const names = [...alts]
    const suffix = commonSuffix(names)
    if (suffix) lines.push(`${n} ${suffix.replace(/^_/, '')} (any kind)`)
    else lines.push(`${n} of ${names.slice(0, -1).join(', ')} or ${names.at(-1)}`)
  }
  return lines.join(', ')
}

function commonSuffix (names) {
  const parts = names.map(n => n.split('_'))
  const tail = []
  for (let k = 1; ; k++) {
    const w = parts[0].at(-k)
    if (!w || !parts.every(p => p.length > k && p.at(-k) === w)) break
    tail.unshift(w)
  }
  return tail.length ? '_' + tail.join('_') : null
}

async function run (act, args) {
  const err = checkArgs('craft', args)
  if (err) return failed(err)
  const api = act.api
  const { item, count } = args
  if (!api.isItem(item)) return failed(`craft: unknown item ${item}`)
  const no = cannotAct(api, 'craft')
  if (no) return no
  const plan = api.craftPlan(item, count)
  if (!plan.options.length) return failed(`craft: ${item} has no crafting recipe`)
  const ready = plan.options.filter(o => !Object.keys(o.missing).length)
  if (!ready.length) return failed(`craft: missing ${describeMissing(plan.options)} for ${count} ${item}`)
  const noTable = ready.find(o => !o.requiresTable)
  let tablePos = null
  if (!noTable) {
    const t = api.seenBlocks('crafting_table', TABLE_RADIUS)[0]
    if (!t) return failed(`craft: ${item} needs crafting_table nearby (none seen or known within ${TABLE_RADIUS} blocks)`)
    tablePos = t.pos
    act.progress(`going to the crafting table at [${t.pos.join(', ')}]`)
    const g = await api.goto(t.pos, { kind: 'look', dig: false, scaffold: false, signal: act.signal })
    if (act.signal.aborted) return null
    if (g.status !== 'reached') return failed(`craft: could not reach the crafting_table at [${t.pos.join(', ')}] (${g.status})`)
  }
  act.progress(`crafting ${count} ${item}${tablePos ? ' at the table' : ''}`)
  const r = await api.craft(item, count, tablePos)
  if (act.signal.aborted) return null
  if (!r.ok) return failed(`craft: ${r.reason}`)
  return { status: 'done', detail: `crafted ${r.crafted} ${item}${tablePos ? ` at the crafting_table at [${tablePos.join(', ')}]` : ''}`, data: { item, crafted: r.crafted, table: tablePos } }
}

module.exports = { run, file: __filename, describeMissing }
