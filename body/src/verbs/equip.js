'use strict'
// equip {item, slot = hand}: hold or wear an inventory item.
// slot: hand, off-hand, head, torso, legs, feet.
const { checkArgs, failed, cannotAct } = require('./common')

async function run (act, args) {
  const err = checkArgs('equip', args)
  if (err) return failed(err)
  const api = act.api
  const { item, slot } = args
  if (!api.isItem(item)) return failed(`equip: unknown item ${item}`)
  const no = cannotAct(api, 'equip')
  if (no) return no
  if (!api.inventoryCount(item)) return failed(`equip: no ${item} in inventory`)
  const r = await api.equip(item, slot)
  if (!r.ok) return failed(`equip: ${r.reason}`)
  return { status: 'done', detail: `equipped ${item} (${slot})`, data: { item, slot } }
}

module.exports = { run, file: __filename }
