'use strict'
// craft {item, count = 1}
// From the inventory: a 2x2 recipe if one works, else at a crafting table
// the bot has observed (in blocks_seen or known places, within 48 blocks),
// walking to it first. It never places a table itself; that is the mind's
// call. Failed reasons are meant to be acted on: "missing 3 oak_planks",
// "missing 2 planks (any kind)", "needs crafting_table nearby".
const { checkArgs, failed, cannotAct } = require('./common')

const TABLE_RADIUS = 48

/**
 * "3 oak_log", "2 planks (any kind)", "3 of cobblestone, blackstone or
 * cobbled_deepslate". An ingredient any of several items fills (a tag:
 * planks, logs, wool…) is never named as one variant, and counts what a fresh
 * variant needs. hintFor(alternatives) may add what the inventory can make
 * them from: "2 planks (any kind) — you have spruce_log 3: craft spruce_planks".
 */
function describeMissing (options, hintFor = null, hints = null) {
  const best = options[0]
  const shape = Object.keys(best.missing).length
  const same = options.filter(o => Object.keys(o.missing).length === shape)
  const lines = []
  Object.entries(best.missing).forEach(([name, n], i) => {
    const at = o => Object.entries(o.missing)[i]
    let names = [...new Set(same.map(o => at(o)?.[0]).filter(Boolean))]
    // a family (…_planks) beats odd ones out (bamboo also makes sticks): keep the family with this one
    const tail = name.split('_').at(-1)
    const family = names.filter(x => x.split('_').at(-1) === tail)
    if (family.length > 1) names = family
    if (names.length <= 1) { lines.push(`${n} ${name}`); return }
    const amount = Math.max(...same.filter(o => names.includes(at(o)?.[0])).map(o => at(o)[1]))
    const suffix = commonSuffix(names)
    let text = suffix ? `${amount} ${suffix.replace(/^_/, '')} (any kind)` : `${amount} of ${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
    const hint = hintFor && hintFor(names)
    if (hint && hints) hints.push(hint)
    else if (hint) text += ` — ${hint}`
    lines.push(text)
  })
  return lines.join(', ')
}

/** "you have spruce_log 3: craft spruce_planks" when the inventory makes one of the alternatives now. */
function inventoryHint (api, names) {
  const inv = api.inventory ? api.inventory() : {}
  for (const v of names) {
    const ready = (api.craftPlan(v, 1).options || []).filter(o => !Object.keys(o.missing).length && o.uses)
    ready.sort((a, b) => a.requiresTable - b.requiresTable)
    const src = ready.length && Object.keys(ready[0].uses).sort((a, b) => (inv[b] || 0) - (inv[a] || 0))[0]
    if (src) return `you have ${src} ${inv[src] || 0}: craft ${v}`
  }
  return null
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
  if (!ready.length) {
    const hints = []
    const missing = describeMissing(plan.options, names => inventoryHint(api, names), hints)
    return failed(`craft: missing ${missing} for ${count} ${item}${hints.length ? ` — ${hints.join('; ')}` : ''}`)
  }
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
  if (!r.ok || !r.crafted) return failed(`craft: ${r.reason || 'nothing came out'}`)
  return { status: 'done', detail: `crafted ${r.crafted} ${item}${tablePos ? ` at the crafting_table at [${tablePos.join(', ')}]` : ''}`, data: { item, crafted: r.crafted, table: tablePos } }
}

module.exports = { run, file: __filename, describeMissing }
