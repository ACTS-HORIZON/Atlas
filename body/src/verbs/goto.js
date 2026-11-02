'use strict'
// goto {pos | target, range?}: walk there with the pathfinder (no digging,
// no block placing). A target must be observed: a visible player, a visible
// entity type, or a block type in blocks_seen / known places.
// done: arrived. partial: gave up (stuck or out of time) with the distance
// remaining. failed: no path at all.
const { checkArgs, failed, refused, cannotAct } = require('./common')

async function run (act, args) {
  const err = checkArgs('goto', args)
  if (err) return failed(err)
  const api = act.api
  const no = cannotAct(api, 'goto')
  if (no) return no
  let pos = args.pos
  let what = pos ? `[${pos.join(', ')}]` : null
  let range = args.range
  if (args.target) {
    const t = api.resolveTarget(args.target)
    if (!t) return refused(`fair play: ${args.target} has not been observed (not a visible player or entity, not a seen or known block)`)
    pos = t.kind === 'block' ? [t.pos[0] + 0.5, t.pos[1] + 0.5, t.pos[2] + 0.5] : t.pos
    what = `${t.kind} ${t.name} at [${t.pos.map(v => Math.round(v * 10) / 10).join(', ')}]`
    range ??= 2
  }
  range ??= 1
  act.progress(`to ${what}`)
  const r = await api.goto(pos, { range, signal: act.signal, onProgress: d => act.progress(`to ${what}: ${d} blocks left`) })
  const data = { pos: pos.map(v => Math.round(v * 10) / 10), remaining: r.remaining }
  if (r.status === 'reached') return { status: 'done', detail: `arrived at ${what}`, data }
  if (r.status === 'no_path' && r.moved < 1) return { status: 'failed', detail: `no path to ${what}`, data }
  const why = { no_path: 'no further path', stuck: 'stuck', timeout: 'took too long', aborted: 'stopped' }[r.status] || r.status
  return { status: 'partial', detail: `gave up ${r.remaining} blocks short of ${what} (${why})`, data }
}

module.exports = { run, file: __filename }
