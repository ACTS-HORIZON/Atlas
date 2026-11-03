'use strict'
// dig {pos}: dig one observed block (visible now, or a known place). Walks
// within reach first (the path may tunnel and pillar, like mine), digs with
// the best tool, or by hand if there is none (then blocks like stone drop
// nothing; the result says so). Refused for a block that was not observed
// (fair play) or inside a protected region (house rules).
const { checkArgs, failed, refused, cannotAct } = require('./common')

const OPEN = new Set(['air', 'cave_air', 'void_air'])

async function run (act, args) {
  const err = checkArgs('dig', args)
  if (err) return failed(err)
  const api = act.api
  const { pos } = args
  const no = cannotAct(api, 'dig')
  if (no) return no
  if (api.gamemode() === 'adventure') return failed('dig: cannot dig in adventure mode')
  const house = api.houseCheck('dig', pos)
  if (house) return refused(house)
  const name = api.observedBlock(pos)
  if (!name) return refused(`fair play: the block at [${pos.join(', ')}] has not been observed`)
  if (OPEN.has(name)) return failed(`dig: [${pos.join(', ')}] is already empty (${name})`)
  const tool = api.toolFor(name)
  if (tool.reason && !tool.needsTool) return failed(`dig: ${tool.reason}`) // e.g. bedrock
  act.progress(`going to ${name} at [${pos.join(', ')}]`)
  const g = await api.goto(pos, { kind: 'look', dig: true, scaffold: true, signal: act.signal })
  if (act.signal.aborted) return null
  if (g.status !== 'reached') return failed(`dig: could not get within reach of [${pos.join(', ')}] (${g.status})`)
  act.progress(`digging ${name} at [${pos.join(', ')}]`)
  const r = await api.digObserved(pos, name, { signal: act.signal, allowHand: true })
  if (act.signal.aborted) return null
  if (r.refused) return refused(r.reason)
  if (!r.ok) return failed(`dig: ${r.reason}`)
  const drops = tool.needsTool ? [] : api.dropsOf(name)
  const note = tool.needsTool ? ` by hand (${name} drops nothing without the right tool)` : drops.length && !(drops.length === 1 && drops[0] === name) ? ` (drops ${drops.join(', ')})` : ''
  return { status: 'done', detail: `dug ${name} at [${pos.join(', ')}]${note}`, data: { pos, block: name, dropped: !tool.needsTool, drops } }
}

module.exports = { run, file: __filename }
