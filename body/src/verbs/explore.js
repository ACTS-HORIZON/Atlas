'use strict'
// explore {direction, distance, dig = true}: walk that way in legs of 16
// blocks, pausing to look around after each, and report what it saw: counts
// of notable blocks by type (unique positions, from the fair-play obs) and
// how many new known places that added. With dig (the default, like goto) the
// path may tunnel through what is in the way (a hill, a tree); it never
// places blocks. When it can't go on, the result says what was in front.
// If it can't take a single step the asked way (a cave wall, a pit), it
// tries the other three directions (turned right, left, then back) and
// explores the first one that moves; with none, partial "no way on" naming
// what blocked each direction.
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
  const asked = args.direction === 'forward' ? api.facing() : args.direction
  const here = api.here()
  let start = here.pos
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
  let dirName = asked
  const blocked = [] // "north (ahead north: stone at feet, stone at head)"
  const order = [asked, ...turns(asked)]
  for (let i = 0; ; ) {
    dirName = order[i]
    const r = await walk(dirName)
    if (r === null) return null
    if (r.ok || walked() >= 1) { stopped = r.stopped; break }
    blocked.push(`${dirName} (${r.what || `${r.stopped.replace(/ \(.*$/, '')}, nothing seen in front`})`)
    if (++i >= order.length) { stopped = `no way on in any direction: ${blocked.join('; ')}`; dirName = asked; break }
    start = api.here().pos
  }
  const switched = dirName !== asked && !stopped?.startsWith('no way on in any') ? `couldn't go ${blocked.join('; ')}, so went ${dirName}: ` : ''
  return report(stopped, switched)

  async function walk (dirName) {
    const [ux, uz] = DIRS[dirName]
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
      if (walked() >= 1 || r.status === 'reached') await api.lookAround(act.signal)
      record()
      if (r.status !== 'reached') {
        const what = inFront(api, dirName, r)
        return { ok: false, what, stopped: (r.status === 'no_path' ? 'no way on' : r.status === 'stuck' ? 'blocked' : 'took too long') + (what ? ` (${what})` : '') }
      }
      if (goal >= args.distance) return { ok: true, stopped: null }
    }
  }

  function report (stopped, switched) {
    const counts = {}
    for (const t of seen.values()) counts[t] = (counts[t] || 0) + 1
    const after = api.placeKeys(api.here().dim)
    let fresh = 0
    for (const k of after) if (!before.has(k)) fresh++
    const dist = r1(walked())
    const list = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ') || 'nothing notable'
    const data = { direction: dirName, walked: dist, seen: counts, new_places: fresh }
    if (dirName !== asked) data.asked = asked
    if (blocked.length) data.blocked = blocked
    if (stopped && /^no way on in any/.test(stopped)) return { status: 'partial', detail: `walked 0 of ${args.distance} blocks: ${stopped}; saw ${list}; ${fresh} new known places`, data }
    if (stopped) return { status: 'partial', detail: `${switched}walked ${dist} of ${args.distance} blocks ${dirName}, then ${stopped}; saw ${list}; ${fresh} new known places`, data }
    return { status: 'done', detail: `${switched}walked ${dist} blocks ${dirName}; saw ${list}; ${fresh} new known places`, data }
  }
}

/** The other three directions, best first: turned right, left, then back (diagonals likewise). */
function turns (dir) {
  const ring = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']
  const i = ring.indexOf(dir)
  return [ring[(i + 2) % 8], ring[(i + 6) % 8], ring[(i + 4) % 8]]
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
