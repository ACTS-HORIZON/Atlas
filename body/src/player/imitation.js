'use strict'
// The imitation recorder (Session 6b-5): while a scripted verb runs (goto,
// mine, explore, …), record at the player's tick rate the view the player
// loop would see, labelled with the micro-action the script is effectively
// performing. logs/imitation-<date>.jsonl, the same schema as the player log
// plus source "script:<verb>": the training set for fine-tuning d1.
//
// How a tick is labelled. The recorder keeps an anchor: the view at the last
// decision point, plus the cells around the feet as they were then. Each
// tick it compares the world and the bot with the anchor:
//   the block 2 above the feet became air          dig_above
//   the block under the feet became air            dig_below
//   a block ahead (feet or head height) became air dig_ahead (another side: turn_left/turn_right first)
//   feet one block up, the old feet cell now solid place_below_and_jump
//   a block ahead at feet height became solid      place_ahead
//   feet one block over in the facing direction    step (another side: turn_left/turn_right first)
//   facing changed by 90°, nothing else            turn_left / turn_right
//   nothing changed, the motor idle, not moving    wait
//   the verb finished done                         done
// The pair (anchor view, label) is written and the current state becomes the
// next anchor. Anything else (two changes at once, a diagonal or vertical
// move, a turn of 180°, a label the filter did not offer at the anchor) is
// ambiguous: nothing is written and the anchor moves on. Mid-action ticks
// (walking inside a block, a dig in progress) keep the anchor and wait.
const { TickLog } = require('./loop')
const { DIRS, LEFT, RIGHT, isSolid } = require('./offered')

const r1 = v => Math.round(v * 10) / 10
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The verbs that act on the world through the motor; the rest have no micro-actions to imitate.
const RECORDED = new Set(['goto', 'explore', 'mine', 'collect', 'dig', 'place'])

// Cells watched around the anchor feet: above the head, below, the feet cell, and each side at feet and head height.
const CELLS = [[0, 2, 0], [0, -1, 0], [0, 0, 0], [0, 1, 0]]
for (const [dx, dz] of Object.values(DIRS)) CELLS.push([dx, 0, dz], [dx, 1, dz])
const key = (dx, dy, dz) => `${dx},${dy},${dz}`
const dirOf = (dx, dz) => Object.keys(DIRS).find(d => DIRS[d][0] === dx && DIRS[d][1] === dz) || null
const turnTo = (from, to) => (RIGHT[from] === to ? 'turn_right' : LEFT[from] === to ? 'turn_left' : null)

/** The intent a player would have been given for this call: "get to the surface", "go to Rook", "mine iron_ore". */
function intentOf (verb, args = {}) {
  if (verb === 'goto') {
    if (args.target === 'surface') return { intent: 'get to the surface', target: null }
    if (args.target) return { intent: `go to ${args.target}`, target: String(args.target) }
    if (Array.isArray(args.pos)) return { intent: `go to ${args.pos.join(' ')}`, target: null }
  }
  const words = Object.values(args).filter(v => ['string', 'number'].includes(typeof v) || (Array.isArray(v) && v.every(x => typeof x === 'number'))).map(v => (Array.isArray(v) ? v.join(' ') : String(v)))
  return { intent: [verb, ...words].join(' '), target: null }
}

class ImitationRecorder {
  /** loop: a PlayerLoop (its snapshot() builds the view); logDir: where imitation-<date>.jsonl goes. */
  constructor ({ loop, logDir = null, hz = 20 } = {}) {
    this.loop = loop
    this.log = new TickLog(logDir, 'imitation')
    this.periodMs = 1000 / hz
    this.totals = {}
  }

  /** A recording session for one verb call. */
  begin (api, verb, args = {}) {
    const { intent, target } = intentOf(verb, args)
    const sess = { api, verb, source: `script:${verb}`, st: { intent, target, dir: api.facing(), pitch: 0, recent: [], noProgress: 0, lastPlace: null }, anchor: null, lastPos: api.here().pos, counts: { recorded: {}, skipped: {} } }
    this.anchor(sess)
    return sess
  }

  /** Take the current state as the decision point the next label belongs to. */
  anchor (sess) {
    const { api, st } = sess
    st.dir = api.facing()
    const snap = this.loop.snapshot(api, st, 'play', api.observe())
    const [x, y, z] = snap.probe.feet
    const cells = {}
    for (const [dx, dy, dz] of CELLS) cells[key(dx, dy, dz)] = snap.probe.cls(x + dx, y + dy, z + dz)
    sess.anchor = { ...snap, feet: snap.probe.feet, dir: st.dir, cells, pos: api.here().pos }
  }

  /** One tick: label the anchor if the script finished a micro-action since; returns the label, 'skip', or null (still in progress). */
  sample (sess) {
    const { api } = sess
    const A = sess.anchor
    const pos = api.here().pos
    const feet = [Math.floor(pos[0]), Math.floor(pos[1] + 1e-3), Math.floor(pos[2])]
    const dir = api.facing()
    const cls = api.sight().classAt
    const [ax, ay, az] = A.feet
    const changes = []
    for (const [dx, dy, dz] of CELLS) {
      const was = A.cells[key(dx, dy, dz)]; const now = cls(ax + dx, ay + dy, az + dz)
      if (!was || !now || isSolid(was) === isSolid(now)) continue
      changes.push({ rel: [dx, dy, dz], dug: isSolid(was), was, now })
    }
    const df = [feet[0] - ax, feet[1] - ay, feet[2] - az]
    const moved = df.some(v => v !== 0)
    const step = Math.hypot(pos[0] - sess.lastPos[0], pos[2] - sess.lastPos[2])
    sess.lastPos = pos
    let label = null; let why = null; let effect = null
    if (moved) {
      const below = changes.find(c => c.rel.join() === '0,0,0' && !c.dug)
      if (df.join() === '0,1,0' && below && changes.length === 1) { label = 'place_below_and_jump'; effect = `pillared up on ${below.now.name}` } else if (changes.length) why = 'moved and changed blocks at once'
      else if (Math.abs(df[0]) + Math.abs(df[2]) === 1 && df[1] <= 0 && df[1] >= -3) {
        const d = dirOf(df[0], df[2])
        label = d === A.dir ? 'step' : turnTo(A.dir, d)
        effect = d === A.dir ? `moved ${r1(Math.hypot(pos[0] - A.pos[0], pos[1] - A.pos[1], pos[2] - A.pos[2]))}` : `facing ${d}`
        if (!label) why = 'stepped backwards'
      } else why = 'diagonal or vertical move'
    } else if (changes.length > 1) why = 'several blocks changed at once'
    else if (changes.length === 1) {
      const c = changes[0]; const [dx, dy, dz] = c.rel; const d = dirOf(dx, dz)
      if (c.dug && dy === 2 && !dx && !dz) { label = 'dig_above'; effect = `dug ${c.was.name} above` } else if (c.dug && dy === -1 && !dx && !dz) { label = 'dig_below'; effect = `dug ${c.was.name} below` } else if (c.dug && d && (dy === 0 || dy === 1)) {
        label = d === A.dir ? 'dig_ahead' : turnTo(A.dir, d)
        effect = d === A.dir ? `dug ${c.was.name} ahead` : `facing ${d}`
        if (!label) why = 'dug behind'
      } else if (!c.dug && d === A.dir && dy === 0) { label = 'place_ahead'; effect = `placed ${c.now.name} ahead` } else why = 'a change no micro-action makes'
    } else if (dir !== A.dir) {
      label = turnTo(A.dir, dir); effect = `facing ${dir}`
      if (!label) why = 'turned around'
    } else if (!api.motorActive() && step < 0.01) { label = 'wait'; effect = 'waited' } else return null // mid-action: keep the anchor
    if (label && !A.offered.includes(label)) { why = `${label} not offered`; label = null }
    if (!label) {
      sess.counts.skipped[why] = (sess.counts.skipped[why] || 0) + 1
      this.anchor(sess)
      return 'skip'
    }
    this.write(sess, label, effect)
    return label
  }

  write (sess, label, effect) {
    const A = sess.anchor; const st = sess.st
    this.log.write({
      source: sess.source,
      mode: 'play',
      intent: st.intent,
      target: st.target,
      view: A.view,
      offered: A.offered,
      criteria: A.criteria,
      chosen: label,
      probabilities: null,
      confidence: null,
      margin: null,
      latency_ms: 0,
      timed_out: false,
      effect
    })
    sess.counts.recorded[label] = (sess.counts.recorded[label] || 0) + 1
    this.totals[label] = (this.totals[label] || 0) + 1
    st.recent.push({ action: label, effect })
    if (st.recent.length > 5) st.recent.shift()
    const here = sess.api.here().pos.map(Math.floor).join(',') + '|' + ((sess.api.observe() || {}).surroundings || {}).summary
    st.noProgress = here === st.lastPlace ? (st.noProgress || 0) + 1 : 0
    st.lastPlace = here
    this.anchor(sess)
  }

  /** The verb ended: "done" for the state it ended in, when it ended done. */
  end (sess, result) {
    if (result && result.status === 'done') {
      this.anchor(sess)
      if (sess.anchor.offered.includes('done')) this.write(sess, 'done', 'intent done')
    }
    return sess.counts
  }

  /** Record a verb call at the tick rate until `finished` (its result promise) settles. Returns the session's counts. */
  async record (api, { verb, args, finished }) {
    if (!RECORDED.has(verb)) return null
    const sess = this.begin(api, verb, args)
    let result = null
    finished.then(r => { result = r || { status: 'failed' } }, () => { result = { status: 'failed' } })
    while (!result) {
      const start = Date.now()
      try { this.sample(sess) } catch (err) { sess.counts.skipped[`error: ${err.message}`] = (sess.counts.skipped[`error: ${err.message}`] || 0) + 1 }
      await sleep(Math.max(0, this.periodMs - (Date.now() - start)))
    }
    try { return this.end(sess, result) } catch { return sess.counts }
  }

  close () { return this.log.close() }
}

module.exports = { ImitationRecorder, intentOf, RECORDED }
