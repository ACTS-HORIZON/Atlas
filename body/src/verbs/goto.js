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
const { checkArgs, failed, refused, cannotAct } = require('./common')

const LEG = 16
const MAX_FOLLOW = 512
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
  const why = { no_path: 'no further path', stuck: 'stuck', timeout: 'took too long', aborted: 'stopped' }[r.status] || r.status
  return { status: 'partial', detail: `gave up ${r.remaining} blocks short of ${what} (${why}${because})${tried}`, data }
}

/** Walk along a player's Locator Bar bearing until they are in sight. */
async function followBearing (act, api, name, move, range) {
  const start = api.here().pos
  const walked = () => { const p = api.here().pos; return r1(Math.hypot(p[0] - start[0], p[2] - start[2])) }
  for (;;) {
    if (act.signal.aborted) return null
    const t = api.resolveTarget(name)
    if (t && t.kind === 'player') return walkTo(act, api, t.pos, `player ${name}`, range, move)
    if (!t || t.kind !== 'bearing') {
      return { status: 'partial', detail: `lost ${name}'s bearing after ${walked()} blocks (not in sight, not on the Locator Bar)`, data: { pos: null, remaining: null } }
    }
    if (walked() >= MAX_FOLLOW) return { status: 'partial', detail: `followed ${name}'s bearing for ${walked()} blocks without seeing them`, data: { pos: null, remaining: null } }
    const a = t.azimuth * Math.PI / 180
    const here = api.here().pos
    const next = [here[0] - Math.sin(a) * LEG, here[1], here[2] + Math.cos(a) * LEG]
    act.progress(`following ${name}'s bearing (${Math.round(t.azimuth)}°), ${walked()} blocks so far`)
    const r = await api.goto(next, { kind: 'xz', ...move, signal: act.signal })
    if (act.signal.aborted) return null
    if (r.status !== 'reached' && r.moved < 1) {
      return { status: r.status === 'no_path' ? 'failed' : 'partial', detail: `blocked while following ${name}'s bearing after ${walked()} blocks (${r.status})`, data: { pos: null, remaining: null } }
    }
  }
}

module.exports = { run, file: __filename }
