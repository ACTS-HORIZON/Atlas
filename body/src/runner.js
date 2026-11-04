'use strict'
// Runs verbs (CONTRACT.md, Verbs): one verb at a time, shown as `task` in
// the obs. say, recall, inspect and stop run alongside a running verb; any
// other call while one is running is refused with reason "busy" (not queued,
// and the running verb is not cancelled).
// stop (from the mind's `stop` call or the dashboard's Stop button) aborts
// the running verb, which then returns `interrupted`, and releases every
// movement control. It works even when not connected.
//
// Watches (Session 8): a long verb (goto, explore, mine, collect) may carry
// args.watch = [{see, do: {verb, args}, max?}, ...]. While it runs, every
// tick (watchTickMs, 250 ms) the body checks what the bot sees, without any
// model: blocks_seen and entities by type, visible item drops by item name.
// On a new sighting it holds the running verb, runs `do` as a sub-call (its
// own progress, shown as task.sub), then lets the verb carry on from where
// the bot now is. A sub-call's result never fails the parent; every one is
// appended to the parent's detail ("; watched: ...") and data.watched. No
// watch inside a watch. stop ends both.
const { VERBS } = require('./verbs')

const ALONGSIDE = new Set(['say', 'recall', 'inspect', 'stop'])
const WATCHABLE = new Set(['goto', 'explore', 'mine', 'collect'])
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const key = p => p.join(',')

/** args.watch as given: null if fine, else what is wrong with it. */
function checkWatch (verb, watch, verbs) {
  if (!WATCHABLE.has(verb)) return `${verb}: watch is only for ${[...WATCHABLE].join(', ')}`
  if (!Array.isArray(watch) || watch.length < 1 || watch.length > 8) return `${verb}: watch must be a list of 1 to 8 {see, do, max?}`
  for (const [i, w] of watch.entries()) {
    const at = `${verb}: watch[${i}]`
    if (!w || typeof w !== 'object' || Array.isArray(w)) return `${at} must be {see, do, max?}`
    for (const k of Object.keys(w)) if (!['see', 'do', 'max'].includes(k)) return `${at}: unknown field "${k}"`
    if (typeof w.see !== 'string' || !w.see) return `${at}.see must be a block type, an entity type or an item name`
    if (!w.do || typeof w.do !== 'object' || typeof w.do.verb !== 'string') return `${at}.do must be {verb, args}`
    if (w.do.args !== undefined && (typeof w.do.args !== 'object' || w.do.args === null || Array.isArray(w.do.args))) return `${at}.do.args must be an object`
    if (w.do.args && w.do.args.watch !== undefined) return `${at}: nested watches are not allowed (a sub-call cannot watch)`
    if (['stop', 'play'].includes(w.do.verb) || !Object.hasOwn(verbs, w.do.verb)) return `${at}.do.verb: ${w.do.verb} cannot be a watch's sub-call`
    if (w.max !== undefined && !(Number.isInteger(w.max) && w.max >= 1)) return `${at}.max must be a whole number, 1 or more`
  }
  return null
}

const abortedP = signal => new Promise(resolve => {
  if (signal.aborted) resolve()
  else signal.addEventListener('abort', () => resolve(), { once: true })
})

class Runner {
  constructor (verbs = VERBS) {
    this.verbs = verbs
    this.current = null
  }

  /** The running verb as an obs `task`, or null. */
  task () {
    const c = this.current
    if (!c) return null
    const t = { id: c.id, verb: c.verb, args: c.watch ? { ...c.args, watch: c.watch } : c.args, state: 'running' }
    if (c.progress !== null) t.progress = c.progress
    if (c.sub) t.sub = { id: c.sub.id, verb: c.sub.verb, args: c.sub.args, ...(c.sub.progress !== null ? { progress: c.sub.progress } : {}) }
    return t
  }

  /** @returns {Promise<{status, detail, data?}>} */
  async run (act, call) {
    const { id, verb } = call
    // verbs get their own copy: validation fills in defaults
    const args = call.args && typeof call.args === 'object' ? JSON.parse(JSON.stringify(call.args)) : (call.args ?? {})
    if (verb === 'stop') return this.stop(act, `call ${id}`)
    if (this.current && !ALONGSIDE.has(verb)) return { status: 'refused', detail: 'busy' }
    const def = Object.hasOwn(this.verbs, verb) ? this.verbs[verb] : null
    if (!def) return { status: 'failed', detail: `verb not implemented yet: ${verb}` }
    if (!act.connected()) return { status: 'failed', detail: 'not connected to the server' }
    if (ALONGSIDE.has(verb)) {
      try { return await def.run(act, args) } catch (err) { return { status: 'failed', detail: `${verb}: ${err.message}` } }
    }
    let watch = null
    if (args && typeof args === 'object' && args.watch !== undefined) {
      const bad = checkWatch(verb, args.watch, this.verbs)
      if (bad) return { status: 'failed', detail: bad }
      watch = args.watch
      delete args.watch // the verb itself never sees it
    }
    const ctrl = new AbortController()
    const cur = { id, verb, args, ctrl, progress: null, watch, watched: [], sub: null, subP: null }
    this.current = cur
    const vact = { ...act, signal: ctrl.signal, progress: p => { cur.progress = String(p) } }
    const over = { v: false }
    const watching = watch && act.api ? this.watchLoop(vact, cur, watch, over).catch(err => console.warn(`[watch] ${err.message}`)) : null
    let r
    try {
      r = await Promise.race([Promise.resolve().then(() => def.run(vact, args)), abortedP(ctrl.signal)])
      if (cur.subP) await cur.subP // a sub-call still running when the verb ended: let it finish
      if (ctrl.signal.aborted) r = interrupted(cur)
      else r = r || { status: 'failed', detail: `${verb}: ended without a result` }
    } catch (err) {
      r = ctrl.signal.aborted ? interrupted(cur) : { status: 'failed', detail: `${verb}: ${err.message}` }
    } finally {
      over.v = true
      if (this.current === cur) this.current = null
    }
    if (watching) await watching
    return cur.watched.length ? withWatched(r, cur.watched) : r
  }

  /** The watch loop of one running verb (see the top of this file). */
  async watchLoop (act, cur, watch, over) {
    const tickMs = (act.cfg && act.cfg.watchTickMs) || 250
    const st = watch.map(w => ({ ...w, fired: 0, handled: new Set(), wasVisible: false }))
    while (!over.v && !cur.ctrl.signal.aborted) {
      await sleep(tickMs)
      if (over.v || cur.ctrl.signal.aborted) break
      let obs
      try { obs = act.api.observe() } catch { continue }
      if (!obs) continue
      for (const w of st) {
        if (w.max && w.fired >= w.max) continue
        const hit = sighting(act.api, obs, w)
        if (!hit) continue
        w.fired++
        cur.subP = this.runWatch(act, cur, w, hit)
        await cur.subP
        cur.subP = null
        try { const o = act.api.observe(); if (o) for (const x of st) sighting(act.api, o, x, { markOnly: true }) } catch {}
        break // one sub-call per tick
      }
    }
  }

  /** Hold the running verb, run the watch's `do` as a sub-call, let the verb go on. Never throws. */
  async runWatch (act, cur, w, hit) {
    const api = act.api
    const sub = { id: `${cur.id}.w${cur.watched.length + 1}`, verb: w.do.verb, args: JSON.parse(JSON.stringify(w.do.args || {})), progress: null, ctrl: new AbortController() }
    const onAbort = () => sub.ctrl.abort(cur.ctrl.signal.reason)
    cur.ctrl.signal.addEventListener('abort', onAbort, { once: true })
    let r
    try {
      await api.holdVerb()
      cur.sub = sub
      if (cur.ctrl.signal.aborted) throw Object.assign(new Error('stopped'), { stopped: true })
      const def = this.verbs[sub.verb]
      const sact = { ...act, api: api.forWatch ? api.forWatch() : api, signal: sub.ctrl.signal, progress: p => { sub.progress = String(p) } }
      r = await Promise.race([Promise.resolve().then(() => def.run(sact, sub.args)), abortedP(sub.ctrl.signal)])
      if (sub.ctrl.signal.aborted) r = { status: 'interrupted', detail: `${sub.verb}: ${sub.ctrl.signal.reason}` }
      r = r || { status: 'failed', detail: `${sub.verb}: ended without a result` }
    } catch (err) {
      r = err.stopped || sub.ctrl.signal.aborted ? { status: 'interrupted', detail: `${sub.verb}: ${cur.ctrl.signal.reason}` } : { status: 'failed', detail: `${sub.verb}: ${err.message}` }
    } finally {
      cur.sub = null
      cur.ctrl.signal.removeEventListener('abort', onAbort)
      try { api.releaseVerb() } catch {}
    }
    cur.watched.push({ id: sub.id, see: w.see, seen: hit.what, at: hit.at, verb: sub.verb, args: sub.args, status: r.status, detail: r.detail, ...(r.data ? { data: r.data } : {}) })
  }

  stop (act, source) {
    try { act.halt() } catch {}
    if (!this.current) return { status: 'done', detail: 'stopped (nothing was running)' }
    const v = this.current.verb
    this.interrupt(act, `stopped by ${source}`)
    return { status: 'done', detail: `stopped ${v}` }
  }

  interrupt (act, reason) {
    const c = this.current
    this.current = null
    c.ctrl.abort(reason)
    try { act.halt() } catch {}
  }
}

/**
 * A new sighting of w.see in obs, or null: a block type at a position not handled yet, an entity type
 * that came into sight, a drop of that item not seen before. markOnly: just remember what is in sight now.
 */
function sighting (api, obs, w, { markOnly = false } = {}) {
  const blocks = (obs.blocks_seen || []).filter(b => b.type === w.see)
  const fresh = blocks.filter(b => !w.handled.has(key(b.pos)))
  for (const b of blocks) w.handled.add(key(b.pos))
  const ents = (obs.entities || []).filter(e => e.type === w.see)
  const came = ents.length > 0 && !w.wasVisible
  w.wasVisible = ents.length > 0
  let drops = []
  try { drops = api.visibleDrops ? api.visibleDrops(w.see) : [] } catch {}
  const newDrops = drops.filter(d => !w.handled.has('drop:' + d.id))
  for (const d of drops) w.handled.add('drop:' + d.id)
  if (markOnly) return null
  if (fresh.length) return { what: 'block', at: fresh[0].pos }
  if (came) { const p = obs.self && obs.self.pos; const e = ents[0]; return { what: 'entity', at: p ? [p[0] + e.rel[0], p[1] + e.rel[1], p[2] + e.rel[2]].map(v => Math.round(v * 10) / 10) : null } }
  if (newDrops.length) return { what: 'drop', at: newDrops[0].pos }
  return null
}

/** The parent's result with its watches' sub-call results appended (they never change its status). */
function withWatched (r, watched) {
  const parts = watched.map(x => (x.status === 'done' ? x.detail : `${x.verb} ${x.status}: ${x.detail}`))
  return { ...r, detail: `${r.detail}; watched: ${parts.join('; ')}`, data: { ...(r.data || {}), watched } }
}

function interrupted (cur) {
  const at = cur.progress ? ` (at: ${cur.progress})` : ''
  return { status: 'interrupted', detail: `${cur.verb}: ${cur.ctrl.signal.reason}${at}` }
}

/** One-shot helper (tests, tools): run a verb on a fresh runner. */
function runVerb (act, verb, args = {}) {
  return new Runner().run(act, { id: 'x', verb, args })
}

module.exports = { Runner, runVerb, ALONGSIDE, WATCHABLE, checkWatch }
