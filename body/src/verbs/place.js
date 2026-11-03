'use strict'
// place {block, pos?}: put an inventory block at pos, which must be an empty
// cell the bot can see and reach from where it stands (no walking: goto
// first), with a solid neighbour to place against. Without pos: the nearest
// such cell next to the bot (the four sides at feet level standing on solid
// ground first, then at head level), tried in turn. A hand-level
// convenience, no planning. Refused inside a protected region (house rules).
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
  if (!pos) return placeBeside(act, api, block)
  act.progress(`placing ${block} at [${pos.join(', ')}]`)
  const r = await api.place(block, pos)
  if (r.refused) return { status: 'refused', detail: r.reason }
  if (!r.ok) return failed(`place: ${r.reason}`)
  return { status: 'done', detail: `placed ${block} at [${pos.join(', ')}]`, data: { block, pos } }
}

const SIDES = [['north', [0, -1]], ['east', [1, 0]], ['south', [0, 1]], ['west', [-1, 0]]]
const EMPTY = /^(air|cave_air|void_air|water|short_grass|tall_grass|fern|large_fern|snow|dead_bush|seagrass)$/

/** The cells next to the bot, best first: feet level on solid ground, then feet level, then head level. */
function besideCells (api) {
  const f = api.here().pos.map(Math.floor)
  const out = []
  for (const [, [dx, dz]] of SIDES) {
    const feet = [f[0] + dx, f[1], f[2] + dz]
    const below = api.peek([feet[0], feet[1] - 1, feet[2]])
    out.push({ pos: feet, rank: below && !EMPTY.test(below) ? 0 : 1 })
    out.push({ pos: [f[0] + dx, f[1] + 1, f[2] + dz], rank: 2 })
  }
  return out.sort((a, b) => a.rank - b.rank).map(c => c.pos)
}

async function placeBeside (act, api, block) {
  if (!api.inventoryCount(block)) return failed(`place: no ${block} in inventory`)
  act.progress(`placing ${block} next to Atlas`)
  const why = []
  for (const pos of besideCells(api)) {
    const here = api.peek(pos)
    if (here === null || !EMPTY.test(here)) continue // not seen, or occupied: skip without trying
    const r = await api.place(block, pos)
    if (act.signal?.aborted) return null
    if (r.refused) { why.push(r.reason); continue }
    if (r.ok) return { status: 'done', detail: `placed ${block} at [${pos.join(', ')}]`, data: { block, pos } }
    why.push(r.reason)
  }
  return failed(`place: no free spot next to Atlas for ${block}${why.length ? ` (${why[0]})` : ' (every side is occupied or not visible)'}`)
}

module.exports = { run, file: __filename }
