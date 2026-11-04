'use strict'
// play {intent, target?, budget?}: hand the controls to the player loop
// (src/player, CONTRACT.md "Player loop"). The decision model plays at
// ~20 Hz with this intent until it answers done or stuck, the budget
// (seconds, or {ticks, seconds}; default 60 s) runs out, or stop.
// done: the model said the intent is done. partial: stuck, or out of budget.
// failed: no decision model configured. Every tick is in logs/player-<date>.jsonl.
const { checkArgs, failed, cannotAct } = require('./common')

async function run (act, args) {
  const err = checkArgs('play', args)
  if (err) return failed(err)
  if (!act.player) return failed('play: no decision model configured (ATLAS_PLAYER_URL)')
  const api = act.api
  const no = cannotAct(api, 'play')
  if (no) return no
  const b = args.budget
  const budgetMs = (typeof b === 'number' ? b : (b && b.seconds) || 60) * 1000
  const budgetTicks = (b && typeof b === 'object' && b.ticks) || Math.ceil(budgetMs / 50) + 1
  const r = await act.player.run(api, { intent: args.intent, target: args.target || null, budgetMs, budgetTicks, signal: act.signal, onProgress: p => act.progress(p) })
  if (act.signal.aborted || r.end === 'aborted') return null
  const why = { done: `done after ${r.ticks} ticks`, stuck: `the player is stuck after ${r.ticks} ticks`, budget: `out of budget after ${r.ticks} ticks (${r.seconds} s)` }[r.end]
  const changed = `moved ${r.moved} blocks ([${r.from.join(', ')}] → [${r.to.join(', ')}]), dug ${r.dug}, placed ${r.placed}, damage ${r.damage}`
  const data = { end: r.end, ticks: r.ticks, seconds: r.seconds, moved: r.moved, from: r.from, to: r.to, dug: r.dug, placed: r.placed, damage: r.damage, log: r.log }
  return { status: r.end === 'done' ? 'done' : 'partial', detail: `play "${args.intent}": ${why}; ${changed}`, data }
}

module.exports = { run, file: __filename }
