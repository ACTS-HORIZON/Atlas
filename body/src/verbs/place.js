'use strict'
// place {block, pos}: put an inventory block at pos, which must be an empty
// cell the bot can see and reach from where it stands (no walking: goto
// first), with a solid neighbour to place against. Refused inside a
// protected region (house rules).
const { checkArgs, failed, cannotAct } = require('./common')

async function run (act, args) {
  const err = checkArgs('place', args)
  if (err) return failed(err)
  const api = act.api
  const { block, pos } = args
  if (!api.isBlock(block)) return failed(`place: unknown block ${block}`)
  const no = cannotAct(api, 'place')
  if (no) return no
  if (api.gamemode() === 'adventure') return failed('place: cannot place blocks in adventure mode')
  act.progress(`placing ${block} at [${pos.join(', ')}]`)
  const r = await api.place(block, pos)
  if (r.refused) return { status: 'refused', detail: r.reason }
  if (!r.ok) return failed(`place: ${r.reason}`)
  return { status: 'done', detail: `placed ${block} at [${pos.join(', ')}]`, data: { block, pos } }
}

module.exports = { run, file: __filename }
