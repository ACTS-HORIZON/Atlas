'use strict'
// The player loop (CONTRACT.md, "Player loop"): the decision model is the
// player, at ~20 Hz. Each tick: build the reflex view from the fair-play
// data, compute the offered micro-actions, ask one `choice` question, execute
// the answer through the filtered API (one step, one block of dig, one jump,
// one place…), and record the effect. Every tick is appended to
// logs/player-<date>.jsonl: the fine-tuning data for d1.
//
// Ticks are paced to 20 Hz from their start; a micro-action that takes longer
// (a dig) simply makes that tick longer. The loop always yields to the event
// loop between ticks, so the obs builder and the link keep running.
//
// Two ways to run:
//   run(api, {intent, target, budgetTicks, budgetMs, signal})  the play verb:
//     until the model answers done or stuck, the budget runs out, or stop;
//   watch(api, {settled, interrupt})  the override while a scripted verb runs:
//     intent "survive", only survival actions (+ continue_task) offered; any
//     other answer pauses the verb and acts; ~1 s of continue_task resumes it;
//     still paused after maxPauseMs: interrupt() (the verb ends interrupted).
const fs = require('fs')
const path = require('path')
const { offeredActions, blockFor, stepOk, DIRS, LEFT, RIGHT } = require('./offered')
const { reflexView } = require('./view')

const r1 = v => Math.round(v * 10) / 10
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** logs/player-YYYY-MM-DD.jsonl, one line per tick. */
class TickLog {
  constructor (dir) { this.dir = dir; this.day = null; this.stream = null }
  write (rec) {
    if (!this.dir) return
    const day = new Date().toISOString().slice(0, 10)
    if (day !== this.day) {
      if (this.stream) this.stream.end()
      fs.mkdirSync(this.dir, { recursive: true })
      this.day = day
      this.path = path.join(this.dir, `player-${day}.jsonl`)
      this.stream = fs.createWriteStream(this.path, { flags: 'a' })
    }
    this.stream.write(JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n')
  }

  close () {
    const st = this.stream; this.stream = null; this.day = null
    return st ? new Promise(resolve => st.end(resolve)) : Promise.resolve()
  }
}

class PlayerLoop {
  constructor ({ chooser, logDir = null, hz = 20, resumeTicks = 20, maxPauseMs = 20000, obsMaxAgeMs = 200 } = {}) {
    this.chooser = chooser
    this.log = new TickLog(logDir)
    this.periodMs = 1000 / hz
    this.resumeTicks = resumeTicks
    this.maxPauseMs = maxPauseMs
    this.obsMaxAgeMs = obsMaxAgeMs
    this.last = [] // the last 10 ticks, for the dashboard
    this.obsCache = { at: 0, obs: null }
  }

  obs (api) {
    const now = Date.now()
    if (!this.obsCache.obs || now - this.obsCache.at > this.obsMaxAgeMs) this.obsCache = { at: now, obs: api.observe() }
    return this.obsCache.obs
  }

  probe (api, st) {
    const o = this.obs(api) || {}
    const s = api.sight()
    const feet = api.here().pos.map(Math.floor)
    return {
      feet,
      dir: st.dir,
      cls: (x, y, z) => s.classAt(x, y, z),
      inventory: api.inventory(),
      food: o.self ? o.self.food : 20,
      foods: api.foods ? api.foods() : [],
      threats: (o.entities || []).filter(e => e.hostile).map(e => ({ type: e.type, rel: e.rel, dist: e.dist })),
      houseOk: (action, pos) => !api.houseCheck(action, pos),
      onGround: o.self ? o.self.on_ground !== false : true
    }
  }

  /** One tick: view, offered, choice, execute. {view, offered, chosen, latency, timedOut, effect, end?} */
  async tick (api, st, mode) {
    const probe = this.probe(api, st)
    const offered = offeredActions(probe, mode)
    const obs = this.obs(api)
    const view = reflexView({ obs, probe, intent: st.intent, target: st.target, recent: st.recent, offered, pitch: st.pitch })
    const c = await this.chooser.choose(view, offered)
    const before = { pos: api.here().pos, health: obs && obs.self ? obs.self.health : null }
    const res = await this.execute(api, st, c.choice, probe)
    this.obsCache.at = 0 // the world changed: look again next tick
    const after = api.here().pos
    const moved = Math.hypot(after[0] - before.pos[0], after[1] - before.pos[1], after[2] - before.pos[2])
    const effect = res.effect || (moved >= 0.5 ? `moved ${r1(moved)}` : 'no change')
    st.recent.push({ action: c.choice, effect })
    if (st.recent.length > 3) st.recent.shift()
    if (res.dug) st.dug++
    if (res.placed) st.placed++
    st.ticks++
    const rec = { mode, intent: st.intent, target: st.target, view, offered, chosen: c.choice, probabilities: c.probabilities, latency_ms: r1(c.latency), timed_out: c.timedOut, effect }
    this.log.write(rec)
    this.last.push({ t: Date.now(), mode, offered, chosen: c.choice, latency_ms: r1(c.latency), effect })
    if (this.last.length > 10) this.last.shift()
    return { ...rec, end: res.end }
  }

  /** Do one micro-action through the filtered API. {effect?, dug?, placed?, end?} */
  async execute (api, st, action, probe) {
    const d = DIRS[st.dir]
    const [x, y, z] = probe.feet
    const fail = r => ({ effect: `failed: ${r.reason || r.status || 'no'}` })
    switch (action) {
      case 'step': case 'sprint': {
        const n = action === 'sprint' ? 2 : 1
        for (let i = 0; i < n; i++) { const r = await api.step(st.dir, {}); if (r.status !== 'reached') return fail(r) }
        return {}
      }
      case 'jump': await api.jump(); return {}
      case 'turn_left': case 'turn_right':
        st.dir = (action === 'turn_left' ? LEFT : RIGHT)[st.dir]
        await api.face(st.dir)
        return { effect: `facing ${st.dir}` }
      case 'look_up': case 'look_down':
        st.pitch = Math.max(-90, Math.min(90, st.pitch + (action === 'look_up' ? 30 : -30)))
        if (api.look) await api.look(st.pitch)
        return { effect: `pitch ${st.pitch}` }
      case 'dig_ahead': {
        const headSolid = probe.cls(x + d[0], y + 1, z + d[1])?.solid
        const r = await api.digAhead(st.dir, headSolid ? 1 : 0, {})
        return r.ok ? { effect: `dug ${r.name || 'a block'} ahead`, dug: true } : fail(r)
      }
      case 'dig_above': case 'dig_below': {
        const dy = action === 'dig_above' ? 2 : -1
        const name = probe.cls(x, y + dy, z)?.name
        const r = await api.digRel(0, dy, 0, {})
        return r.ok ? { effect: `dug ${name || 'a block'} ${action === 'dig_above' ? 'above' : 'below'}`, dug: true } : fail(r)
      }
      case 'place_below_and_jump': {
        const b = blockFor(probe)
        const r = await api.pillar(b)
        return r.ok ? { effect: `pillared up on ${b}`, placed: true } : fail(r)
      }
      case 'place_ahead': {
        const b = blockFor(probe)
        const r = await api.place(b, [x + d[0], y, z + d[1]])
        return r.ok ? { effect: `placed ${b} ahead`, placed: true } : fail(r)
      }
      case 'attack': { const r = await api.attackNearest(3.5); return r.ok ? { effect: `hit ${r.type}` } : fail(r) }
      case 'block': { const r = await api.useShield(); return r.ok ? { effect: 'blocked with the shield' } : fail(r) }
      case 'retreat': {
        const t = probe.threats[0]
        if (!t) return { effect: 'nothing to retreat from' }
        const away = Math.abs(t.rel[0]) >= Math.abs(t.rel[2]) ? (t.rel[0] > 0 ? 'west' : 'east') : (t.rel[2] > 0 ? 'north' : 'south')
        if (!stepOk(probe, x, y, z, DIRS[away])) return { effect: 'no safe step away' }
        const r = await api.step(away, {})
        return r.status === 'reached' ? { effect: `stepped ${away}, away from the ${t.type}` } : fail(r)
      }
      case 'eat': {
        const food = (probe.foods || [])[0]
        const r = await api.eat(food)
        return r.ok ? { effect: `ate ${food}` } : fail(r)
      }
      case 'done': return { effect: 'intent done', end: 'done' }
      case 'stuck': return { effect: 'the player is stuck', end: 'stuck' }
      default: return { effect: action === 'continue_task' ? 'continuing the task' : 'waited' }
    }
  }

  /** The play verb's loop. {end: done|stuck|budget|aborted, ticks, dug, placed, from, to, damage} */
  async run (api, { intent, target = null, budgetTicks = 2400, budgetMs = 60000, signal, onProgress } = {}) {
    const o0 = this.obs(api)
    const st = { intent, target, dir: api.facing(), pitch: 0, recent: [], ticks: 0, dug: 0, placed: 0 }
    const from = api.here().pos
    const h0 = o0 && o0.self ? o0.self.health : null
    let minHealth = h0
    const t0 = Date.now()
    let end = null
    while (!end) {
      if (signal && signal.aborted) { end = 'aborted'; break }
      if (st.ticks >= budgetTicks || Date.now() - t0 >= budgetMs) { end = 'budget'; break }
      const start = Date.now()
      const tk = await this.tick(api, st, 'play')
      const h = this.obs(api)?.self?.health
      if (typeof h === 'number' && (minHealth === null || h < minHealth)) minHealth = h
      if (tk.end) end = tk.end
      if (onProgress) onProgress(`${intent}: tick ${st.ticks}, ${tk.chosen} (${tk.effect})`)
      await sleep(Math.max(0, this.periodMs - (Date.now() - start))) // 20 Hz, and always yield
    }
    const to = api.here().pos
    return {
      end,
      ticks: st.ticks,
      seconds: r1((Date.now() - t0) / 1000),
      dug: st.dug,
      placed: st.placed,
      from: from.map(r1),
      to: to.map(r1),
      moved: r1(Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2])),
      damage: h0 !== null && minHealth !== null ? r1(Math.max(0, h0 - minHealth)) : 0,
      log: this.log.path || null
    }
  }

  /** The override while a scripted verb runs (see the top of this file). Resolves when settled() is true. */
  async watch (api, { settled, interrupt }) {
    const st = { intent: 'survive', target: null, dir: api.facing(), pitch: 0, recent: [], ticks: 0, dug: 0, placed: 0 }
    let paused = false; let cont = 0; let pausedAt = 0
    const out = { ticks: 0, pauses: 0, interrupted: false }
    while (!settled()) {
      const start = Date.now()
      const tk = await this.tick(api, st, 'survive')
      out.ticks++
      if (tk.chosen === 'continue_task') {
        if (paused && ++cont >= this.resumeTicks) { api.resumeVerb(); paused = false; cont = 0 }
      } else {
        cont = 0
        if (!paused) { api.pauseVerb(); paused = true; pausedAt = Date.now(); out.pauses++ }
      }
      if (paused && Date.now() - pausedAt > this.maxPauseMs) {
        api.resumeVerb(); paused = false
        out.interrupted = true
        interrupt('the player loop paused it to survive and could not resume it')
        break
      }
      await sleep(Math.max(0, this.periodMs - (Date.now() - start)))
    }
    if (paused) api.resumeVerb()
    return out
  }

  close () { return this.log.close() }
}

module.exports = { PlayerLoop, TickLog }
