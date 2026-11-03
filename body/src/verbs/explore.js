'use strict'
// explore {direction, distance, dig = true}: walk that way in legs of 16
// blocks, pausing to look around after each, and report what it saw: counts
// of notable blocks by type (unique positions, from the fair-play obs) and
// how many new known places that added. With dig (the default, like goto) the
// path may tunnel through what is in the way (a hill, a tree); it never
// places blocks. When it can't go on, the result says what was in front.
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
      dig: args.dig,
      scaffold: false,
      signal: act.signal,
      onProgress: () => {
        act.progress(`${dirName}: ${Math.round(walked())}/${args.distance} blocks, ${seen.size} notable blocks seen`)
        if (Date.now() - lastSample > 1000) { lastSample = Date.now(); record() }
      }
    })
    if (act.signal.aborted) return null
    await api.lookAround(act.signal)
    record()
    if (r.status !== 'reached') {
      const what = inFront(api, dirName, r)
      stopped = (r.status === 'no_path' ? 'no way on' : r.status === 'stuck' ? 'blocked' : 'took too long') + (what ? ` (${what})` : '')
      break
    }
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

/** What stands in front, at feet and head height: "ahead: stone at feet, oak_leaves at head" (only what is seen). */
function inFront (api, dirName, r) {
  const [ux, uz] = DIRS[dirName]
  const card = Math.abs(ux) >= Math.abs(uz) ? (ux > 0 ? 'east' : 'west') : (uz > 0 ? 'south' : 'north')
  const OPEN = /^(air|cave_air|void_air)$/
  // the nearest step (1 to 3 blocks on) where something stands at feet or head height
  for (let n = 1; n <= 3; n++) {
    const feet = api.peek(api.ahead(card, 0, n)) ?? (n === 1 ? r.why?.front_feet?.name : null) ?? null
    const head = api.peek(api.ahead(card, 1, n)) ?? (n === 1 ? r.why?.front_head?.name : null) ?? null
    if ((feet && !OPEN.test(feet)) || (head && !OPEN.test(head))) {
      return `ahead ${card}${n > 1 ? ` ${n} blocks` : ''}: ${feet || 'unseen'} at feet, ${head || 'unseen'} at head`
    }
  }
  return r.why?.text || null
}

module.exports = { run, file: __filename }
