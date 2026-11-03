'use strict'
// smelt {item, count = 1, fuel?}
//
// item is what to make (iron_ingot) or what to put in (raw_iron); count is
// how many come out. Uses a furnace (or a blast furnace / smoker that takes
// that input) the bot has seen: in view or a known place within 32 blocks.
// It never places one: that's place (craft makes a furnace from 8
// cobblestone). Fuel: the fuel arg, else the best in the inventory: coal,
// charcoal, then planks, then logs (never the input itself), only as much as
// the count needs. Walks to the furnace, loads input and fuel, waits, takes
// the output as it comes ("3/8 smelted"), and takes back anything left.
//
// done: all smelted. partial: fewer, with the shortage named (input, fuel,
// or the furnace stalled). failed: not smeltable, nothing to smelt, no fuel,
// no furnace seen, furnace busy with something else. refused: the furnace is
// inside a protected region (house rules).
const { checkArgs, failed, refused, cannotAct } = require('./common')
const { RECIPES, FURNACES, furnacesFor, inputsFor, fuelValue, bestFuel } = require('../smelting')

const RADIUS = 32
const fmt = n => (Number.isInteger(n) ? String(n) : n.toFixed(1))

async function run (act, args) {
  const err = checkArgs('smelt', args)
  if (err) return failed(err)
  const api = act.api
  const { item, count } = args
  if (!api.isItem(item)) return failed(`smelt: unknown item ${item}`)
  const no = cannotAct(api, 'smelt')
  if (no) return no
  const inv = api.inventory()

  // what goes in, what comes out: item is the output when something in the
  // inventory smelts into it (stone from cobblestone), else the input
  let input, output
  const inputs = inputsFor(item)
  const held = inputs.filter(n => inv[n] > 0).sort((a, b) => inv[b] - inv[a])
  if (held.length) {
    input = held[0]; output = item
  } else if (RECIPES[item]) {
    input = item; output = RECIPES[item]
  } else if (inputs.length) {
    return failed(`smelt: nothing to smelt into ${item}: no ${inputs.slice(0, 4).join(', ')}${inputs.length > 4 ? ', …' : ''} in inventory`)
  } else {
    return failed(`smelt: ${item} is not made in a furnace${api.craftPlan(item, 1).options?.length ? `; it is crafted: use craft ${item}` : ''}`)
  }
  const have = inv[input] || 0
  if (!have) return failed(`smelt: no ${input} in inventory`)

  // fuel
  let fuel = args.fuel
  if (fuel) {
    if (!fuelValue(fuel)) return failed(`smelt: ${fuel} is not a fuel`)
    if (!inv[fuel]) return failed(`smelt: no ${fuel} in inventory`)
    if (fuel === input) return failed(`smelt: ${fuel} is the input; pick another fuel`)
  } else {
    fuel = bestFuel(inv, input)
    if (!fuel) return failed('smelt: no fuel in inventory (coal, charcoal, planks or logs)')
  }
  const per = fuelValue(fuel)
  const want = Math.min(count, have)
  const fuelHave = inv[fuel] - (fuel === input ? want : 0)
  const fuelUse = Math.min(Math.ceil(want / per), fuelHave)
  const load = Math.min(want, Math.floor(fuelUse * per))
  if (load < 1) return failed(`smelt: not enough fuel: ${fuelHave} ${fuel} smelts ${fmt(fuelHave * per)} items`)
  let short = null
  if (have < count) short = `only ${have} ${input} in inventory`
  else if (load < want) short = `not enough fuel: ${fuelHave} ${fuel} smelts ${fmt(fuelHave * per)}; ${Math.ceil((count - load) / per)} more ${fuel} needed`

  // the furnace
  const types = furnacesFor(input)
  const found = types.flatMap(t => api.targetsOfType(t, RADIUS).map(b => ({ ...b, type: t }))).sort((a, b) => a.dist - b.dist)
  if (!found.length) {
    const kinds = types.join(' or ')
    return failed(`smelt: needs a ${kinds} (none seen or known within ${RADIUS} blocks); craft furnace (8 cobblestone), then place it`)
  }
  const usable = found.filter(f => !api.houseCheck('furnace use', f.pos))
  if (!usable.length) return refused(api.houseCheck('furnace use', found[0].pos))
  const f = usable[0]
  const where = `the ${f.type} at [${f.pos.join(', ')}]`

  act.progress(`going to ${where}`)
  const g = await api.goto(f.pos, { kind: 'look', dig: false, scaffold: false, signal: act.signal })
  if (act.signal.aborted) return null
  if (g.status !== 'reached') return failed(`smelt: could not reach ${where} (${g.status})`)
  act.progress(`0/${load} smelted`)
  const r = await api.smelt(f.pos, { input, output, count: load, fuel, fuelCount: fuelUse, signal: act.signal, onProgress: n => act.progress(`${n}/${load} smelted`) })
  if (act.signal.aborted) return null
  const data = { item: output, input, smelted: r.smelted, requested: count, fuel, fuel_used: fuelUse, furnace: f.pos }
  if (!r.smelted) return { status: 'failed', detail: `smelt: ${r.reason || 'nothing came out'}`, data }
  if (r.smelted >= count) return { status: 'done', detail: `smelted ${r.smelted} ${output} in ${where}`, data }
  const why = r.smelted < load ? (r.reason || 'the furnace stopped') : short
  return { status: 'partial', detail: `smelted ${r.smelted} of ${count} ${output}; ${why}`, data }
}

module.exports = { run, file: __filename, FURNACES }
