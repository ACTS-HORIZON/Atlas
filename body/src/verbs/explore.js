'use strict'
// explore {direction, distance}: walk that way in legs of 16 blocks, pausing
// to look around after each, and report what it saw: counts of notable
// blocks by type (unique positions, from the fair-play obs) and how many new
// known places that added.
const { checkArgs, failed, cannotAct } = require('./common')
const { DIRS } = require('../api')

const LEG = 16
const r1 = v => Math.round(v * 10) / 10

async function run (act, args) {
  const err = checkArgs('explore', args)
  if (err) return failed(err)
  const api = act.api
  const no = cannotAct(api, 'explore')
  if (no) return no
  const dirName = args.direction === 'forward' ? api.facing() : args.direction
  const [ux, uz] = DIRS[dirName]
  const here = api.here()
  const start = here.pos
  const before = api.placeKeys(here.dim)
  const seen = new Map() // "x,y,z" -> type
  const record = () => {
    const o = api.observe()
    if (o) for (const b of o.blocks_seen) seen.set(b.pos.join(','), b.type)
  }
  const walked = () => { const p = api.here().pos; return Math.hypot(p[0] - start[0], p[2] - start[2]) }
  record()
  let stopped = null
  let lastSample = 0
  for (let goal = Math.min(LEG, args.distance); ; goal = Math.min(goal + LEG, args.distance)) {
    if (act.signal.aborted) return null
    const tx = start[0] + ux * goal; const tz = start[2] + uz * goal
    const r = await api.goto([tx, start[1], tz], {
      kind: 'xz',
      signal: act.signal,
      onProgress: () => {
        act.progress(`${dirName}: ${Math.round(walked())}/${args.distance} blocks, ${seen.size} notable blocks seen`)
        if (Date.now() - lastSample > 1000) { lastSample = Date.now(); record() }
      }
    })
    if (act.signal.aborted) return null
    await api.lookAround(act.signal)
    record()
    if (r.status !== 'reached') { stopped = r.status === 'no_path' ? 'no way on' : r.status === 'stuck' ? 'blocked' : 'took too long'; break }
    if (goal >= args.distance) break
  }
  const counts = {}
  for (const t of seen.values()) counts[t] = (counts[t] || 0) + 1
  const after = api.placeKeys(api.here().dim)
  let fresh = 0
  for (const k of after) if (!before.has(k)) fresh++
  const dist = r1(walked())
  const list = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ') || 'nothing notable'
  const data = { direction: dirName, walked: dist, seen: counts, new_places: fresh }
  if (stopped) return { status: 'partial', detail: `walked ${dist} of ${args.distance} blocks ${dirName}, then ${stopped}; saw ${list}; ${fresh} new known places`, data }
  return { status: 'done', detail: `walked ${dist} blocks ${dirName}; saw ${list}; ${fresh} new known places`, data }
}

module.exports = { run, file: __filename }
