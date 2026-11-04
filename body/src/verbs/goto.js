'use strict'
// goto {pos | target, range?, dig = true, scaffold = true}
// Walks with the pathfinder. dig: may tunnel through blocks in the way;
// scaffold: may place blocks from the inventory to pillar up or bridge, as a
// player does. Protected regions are never dug or built in (house rules).
// A target must be observed: a visible player, a visible entity type, a
// block type in blocks_seen / known places, or a player shown on the Locator
// Bar (then it walks along the bearing in 16-block legs, re-reading the
// bearing each leg, until the player is in sight, then goes to them).
// done: arrived. partial: gave up (stuck, out of time, lost the bearing)
// with the distance remaining. failed: no path at all.
//
// target "surface": climb until the surroundings report open sky with a side
// open at head height (not the bottom of an open shaft): straight
// up in 16-block legs (pillaring with scaffold blocks, digging what is
// above), else a rising staircase dug into the wall; done with the y
// reached; partial at lava or water above, bedrock above, or no way up (no
// scaffold blocks and no staircase possible).
const { checkArgs, failed, refused, cannotAct } = require('./common')

const LEG = 16
const MAX_FOLLOW = 512 // blocks walked in total (the path, not the straight line)
const MAX_LEGS = 48
const FLIP = 150 // a bearing change of more than this between legs is a reversal
const r1 = v => Math.round(v * 10) / 10

async function run (act, args) {
  const err = checkArgs('goto', args)
  if (err) return failed(err)
  const api = act.api
  const no = cannotAct(api, 'goto')
  if (no) return no
  const move = { dig: args.dig, scaffold: args.scaffold }
  let pos = args.pos
  let what = pos ? `[${pos.join(', ')}]` : null
  let range = args.range
  if (args.target === 'surface') return toSurface(act, api, move)
  if (args.target) {
    const t = api.resolveTarget(args.target)
    if (!t) return refused(`fair play: ${args.target} has not been observed (not a visible player or entity, not a seen or known block, not on the Locator Bar)`)
    if (t.kind === 'bearing') return followBearing(act, api, args.target, move, range ?? 2)
    pos = t.kind === 'block' ? [t.pos[0] + 0.5, t.pos[1] + 0.5, t.pos[2] + 0.5] : t.pos
    what = `${t.kind} ${t.name} at [${t.pos.map(r1).join(', ')}]`
    range ??= 2
  }
  range ??= 1
  return walkTo(act, api, pos, what, range, move)
}

async function walkTo (act, api, pos, what, range, move) {
  act.progress(`to ${what}`)
  const r = await api.goto(pos, { range, ...move, signal: act.signal, onProgress: d => act.progress(`to ${what}: ${d} blocks left`) })
  const data = { pos: pos.map(r1), remaining: r.remaining }
  if (r.recoveries) data.recoveries = r.recoveries
  if (r.why) { const { text, ...why } = r.why; data.why = why }
  const because = r.why ? `: ${r.why.text}` : ''
  const tried = r.tried && r.tried.length ? `; tried ${r.tried.join(' / ')}` : ''
  if (r.status === 'reached') return { status: 'done', detail: `arrived at ${what}${r.recoveries ? ` after ${r.recoveries} recover${r.recoveries > 1 ? 'ies' : 'y'}` : ''}`, data }
  if (r.status === 'no_path' && r.moved < 1) return { status: 'failed', detail: `no path to ${what}${because}`, data }
  if (r.planner) data.planner = r.planner
  const why = r.status === 'no_progress' ? `no path found yet: ${plannerText(r.planner)}`
    : { no_path: 'no further path', stuck: 'stuck', timeout: 'took too long', aborted: 'stopped' }[r.status] || r.status
  return { status: 'partial', detail: `gave up ${r.remaining} blocks short of ${what} (${why}${because})${tried}`, data }
}

/**
 * Walk along a player's Locator Bar bearing until they are in sight. Gives
 * up on: the total distance walked (MAX_FOLLOW, the path, not the straight
 * line from the start), MAX_LEGS legs, the time cap (cfg.followMaxS, default
 * 3 min), or a bearing that reverses (~180°) on two legs in a row: the player
 * is above or below, not ahead (horizontal distance ~0), which the bar's
 * up/down indicator says when it shows one.
 */
async function followBearing (act, api, name, move, range) {
  const maxMs = ((act.cfg && act.cfg.followMaxS) || 180) * 1000
  const t0 = Date.now()
  let path = 0; let legs = 0; let flips = 0; let prevAz = null; let vertical = null
  let prev = api.here().pos
  const walked = () => r1(path)
  const data = extra => ({ pos: null, remaining: null, walked: walked(), legs, ...extra })
  for (;;) {
    if (act.signal.aborted) return null
    const t = api.resolveTarget(name)
    if (t && t.kind === 'player') return walkTo(act, api, t.pos, `player ${name}`, range, move)
    if (!t || t.kind !== 'bearing') {
      return { status: 'partial', detail: `lost ${name}'s bearing after ${walked()} blocks (not in sight, not on the Locator Bar)`, data: data() }
    }
    if (t.vertical) vertical = t.vertical
    if (prevAz !== null) {
      const turn = Math.abs(((t.azimuth - prevAz) % 360 + 540) % 360 - 180)
      flips = turn > FLIP ? flips + 1 : 0
    }
    if (flips >= 2) {
      const where = vertical === 'above' || vertical === 'below' ? `is ${vertical} you, not ahead`
        : vertical === 'level' ? 'is close by but not in sight (behind a wall, or in a cave?)' : 'is above or below you, not ahead'
      return { status: 'partial', detail: `${name} ${where}: bearing flips each leg (horizontal distance ~0)`, data: data({ vertical: vertical || null }) }
    }
    if (path >= MAX_FOLLOW || legs >= MAX_LEGS) {
      return { status: 'partial', detail: `followed ${name}'s bearing for ${walked()} blocks in ${legs} legs without seeing them`, data: data() }
    }
    const left = maxMs - (Date.now() - t0)
    if (left <= 0) {
      return { status: 'partial', detail: `followed ${name}'s bearing for ${Math.round((Date.now() - t0) / 1000)} s (the time cap): walked ${walked()} blocks in ${legs} legs without seeing them`, data: data() }
    }
    prevAz = t.azimuth
    legs++
    const a = t.azimuth * Math.PI / 180
    const here = api.here().pos
    const next = [here[0] - Math.sin(a) * LEG, here[1], here[2] + Math.cos(a) * LEG]
    act.progress(`following ${name}'s bearing (${Math.round(t.azimuth)}°${vertical && vertical !== 'level' ? `, ${vertical}` : ''}), ${walked()} blocks so far`)
    const r = await api.goto(next, { kind: 'xz', ...move, signal: act.signal, timeoutMs: Math.max(1000, left) })
    if (act.signal.aborted) return null
    const p = api.here().pos
    path += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2])
    prev = p
    if (r.status !== 'reached' && r.moved < 1) {
      return { status: r.status === 'no_path' ? 'failed' : 'partial', detail: `blocked while following ${name}'s bearing after ${walked()} blocks (${r.status})`, data: data() }
    }
  }
}

const SCAFFOLD = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff']
const OPEN = /^(air|cave_air|void_air)$/
const STAIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]

/** The first block seen straight above the head: {name, y} or null (open, or not seen). */
function overhead (api, x, y, z) {
  for (let k = 2; k < 400; k++) {
    const name = api.peek([x, y + k, z])
    if (name === null) return null
    if (!OPEN.test(name)) return { name, y: y + k }
  }
  return null
}

/** Open sky overhead and not walled in: some side open at head height (the bottom of an open shaft sees the sky too). */
function atSurface (s) {
  if (!s || !s.sky) return false
  return Object.values(s.sides || {}).some(([, head]) => head === null || !/ 1$/.test(head))
}

/**
 * One goto leg of the climb, cut short the moment the bot is at the surface: a leg aims up to 16 blocks
 * higher, and without this it went on pillaring into the open air above the ground (live: 57 blocks).
 */
async function climbLeg (act, api, goal, opts, everyMs = 50) {
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  act.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setInterval(() => {
    try { if (atSurface((api.observe() || {}).surroundings)) ac.abort() } catch {}
  }, everyMs)
  try {
    return await api.goto(goal, { ...opts, signal: ac.signal })
  } finally {
    clearInterval(timer)
    act.signal.removeEventListener('abort', onAbort)
  }
}

async function toSurface (act, api, move) {
  const y0 = Math.floor(api.here().pos[1])
  const done = (y, p) => ({ status: 'done', detail: `reached open sky at y ${y} (climbed ${y - y0})`, data: { pos: p.map(r1), y, climbed: y - y0 } })
  for (let round = 0; round < 64; round++) {
    if (act.signal.aborted) return null
    const p = api.here().pos
    const f = p.map(Math.floor)
    const o = api.observe()
    if (atSurface(o && o.surroundings)) return done(f[1], p)
    const top = overhead(api, f[0], f[1], f[2])
    const stop = why => ({ status: 'partial', detail: `stopped at y ${f[1]} (climbed ${f[1] - y0}): ${why}`, data: { pos: p.map(r1), y: f[1], climbed: f[1] - y0 } })
    if (top && /^(lava|water)$/.test(top.name)) return stop(`${top.name} above at y ${top.y}`)
    if (top && top.name === 'bedrock') return stop(`bedrock above at y ${top.y}`)
    const inv = api.inventory()
    const blocks = SCAFFOLD.reduce((n, b) => n + (inv[b] || 0), 0)
    act.progress(`to the surface: y ${f[1]}, ${blocks} scaffold blocks`)
    // straight up: pillar with scaffold blocks, dig through what is above
    let r = await climbLeg(act, api, [p[0], f[1] + 16, p[2]], { kind: 'near', range: 1, dig: move.dig !== false, scaffold: blocks > 0 })
    if (act.signal.aborted) return null
    if (Math.floor(api.here().pos[1]) > f[1]) continue
    // a rising staircase dug into the wall, each side in turn
    let climbed = false
    for (const [dx, dz] of STAIRS) {
      r = await climbLeg(act, api, [p[0] + dx * 4, f[1] + 4, p[2] + dz * 4], { kind: 'near', range: 1, dig: move.dig !== false, scaffold: blocks > 0 })
      if (act.signal.aborted) return null
      if (Math.floor(api.here().pos[1]) > f[1]) { climbed = true; break }
    }
    if (!climbed) return stop(`no way up${blocks ? '' : ' (no scaffold blocks to pillar with)'}${r && r.why ? `: ${r.why.text}` : ''}`)
  }
  const p = api.here().pos
  return { status: 'partial', detail: `no open sky after 64 climbs (at y ${Math.floor(p[1])})`, data: { pos: p.map(r1), y: Math.floor(p[1]), climbed: Math.floor(p[1]) - y0 } }
}

/** "planner timeout after 5001 ms, 10020 nodes visited, its best plan ends at [25, 60, 0]; nearest point reached [x, y, z], 105.8 blocks from the goal" */
function plannerText (p) {
  if (!p) return 'no plan'
  const parts = [`planner ${p.status}${p.ms != null ? ` after ${p.ms} ms` : ''}`]
  if (p.visited != null) parts.push(`${p.visited} nodes visited`)
  if (p.plan_end) parts.push(`its best plan ends at [${p.plan_end.join(', ')}]`)
  return parts.join(', ') + (p.nearest ? `; nearest point reached [${p.nearest.join(', ')}], ${p.nearest_dist} blocks from the goal` : '')
}

module.exports = { run, file: __filename }
