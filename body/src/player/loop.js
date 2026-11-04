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
//     until the model answers done or stuck (5 ticks in a row, or one at
//     confidence 0.5 or more; a lone weak stuck/done is done as wait), the
//     budget runs out, or stop;
//   watch(api, {settled, interrupt})  the override while a scripted verb runs:
//     intent "survive", only survival actions (+ continue_task) offered; any
//     other answer pauses the verb and acts; ~1 s of continue_task resumes it;
//     still paused after maxPauseMs: interrupt() (the verb ends interrupted).
//     It ticks at surviveHz (5) while no threat or damage is in view, at hz
//     (20) while one is.
//   watch(api, {settled, idle: true})  the same survive loop with no verb
//     running (body.idleSurvive): an action other than continue_task or wait
//     simply runs; nothing is paused.
const fs = require('fs')
const path = require('path')
const { offeredActions, describe, blockFor, stepOk, shore, waterBeside, DIRS, LEFT, RIGHT } = require('./offered')
const { reflexView, surviveView } = require('./view')

const r1 = v => Math.round(v * 10) / 10
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** logs/<prefix>-YYYY-MM-DD.jsonl, one line per tick (player-…: the loop; imitation-…: the recorder). */
class TickLog {
  constructor (dir, prefix = 'player') { this.dir = dir; this.prefix = prefix; this.day = null; this.stream = null }
  write (rec) {
    if (!this.dir) return
    const day = new Date().toISOString().slice(0, 10)
    if (day !== this.day) {
      if (this.stream) this.stream.end()
      fs.mkdirSync(this.dir, { recursive: true })
      this.day = day
      this.path = path.join(this.dir, `${this.prefix}-${day}.jsonl`)
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
  /**
   * endStreak / endConf: stuck and done end a run only after winning endStreak ticks in a row, or on one
   * tick at endConf or more; otherwise they are done as wait. surviveHz: the override's rate while no
   * threat or damage is in view (hz while one is, and for a second after damage).
   */
  constructor ({ chooser, logDir = null, hz = 20, surviveHz = 5, resumeTicks = 20, maxPauseMs = 20000, obsMaxAgeMs = 200, endStreak = 5, endConf = 0.5 } = {}) {
    this.chooser = chooser
    this.log = new TickLog(logDir)
    this.periodMs = 1000 / hz
    this.survivePeriodMs = 1000 / Math.min(hz, surviveHz)
    this.endStreak = endStreak
    this.endConf = endConf
    this.rates = { play: { ticks: 0, ms: 0 }, survive: { ticks: 0, ms: 0 } }
    this.resumeTicks = resumeTicks
    this.maxPauseMs = maxPauseMs
    this.obsMaxAgeMs = obsMaxAgeMs
    this.last = [] // the last 20 ticks, for the dashboard
    this.series = [] // the last 60 s of ticks: {t, ms, mode, timed_out}, for the dashboard's sparkline
    this.obsCache = { at: 0, obs: null }
  }

  obs (api) {
    const now = Date.now()
    if (!this.obsCache.obs || now - this.obsCache.at > this.obsMaxAgeMs) this.obsCache = { at: now, obs: api.observe() }
    return this.obsCache.obs
  }

  probe (api, st, obs = this.obs(api)) {
    const o = obs || {}
    const s = api.sight()
    const pos = api.here().pos
    const feet = [Math.floor(pos[0]), Math.floor(pos[1] + 1e-3), Math.floor(pos[2])] // 63.9999 standing on a block is 64
    return {
      sides: o.surroundings ? o.surroundings.sides : null,
      feet,
      dir: st.dir,
      cls: (x, y, z) => s.classAt(x, y, z),
      inventory: api.inventory(),
      food: o.self ? o.self.food : 20,
      foods: api.foods ? api.foods() : [],
      threats: (o.entities || []).filter(e => e.hostile).map(e => ({ type: e.type, rel: e.rel, dist: e.dist })),
      houseOk: (action, pos) => !api.houseCheck(action, pos),
      onGround: o.self ? o.self.on_ground !== false : true,
      inWater: !!(o.self && o.self.in_water),
      onFire: !!(api.onFire && api.onFire())
    }
  }

  /** What the player sees this tick: {obs, probe, offered, view, criteria} (shared with the imitation recorder). */
  snapshot (api, st, mode, obs = this.obs(api)) {
    const probe = this.probe(api, st, obs)
    const offered = offeredActions(probe, mode)
    const view = mode === 'survive'
      ? surviveView({ obs, probe, recent: st.recent })
      : reflexView({ obs, probe, intent: st.intent, target: st.target, recent: st.recent, offered, pitch: st.pitch, noProgress: st.noProgress })
    const criteria = describe(probe, offered, { sky: obs && obs.surroundings ? !!obs.surroundings.sky : null })
    return { obs, probe, offered, view, criteria }
  }

  /**
   * stuck/done: accepted (ends the run) on endStreak wins in a row or one at endConf or more; otherwise
   * done as wait. Returns the action to execute and, when held back, why.
   */
  endGate (st, chosen, confidence) {
    if (chosen !== 'stuck' && chosen !== 'done') { st.endRun = null; return { act: chosen } }
    st.endRun = st.endRun && st.endRun.action === chosen ? { action: chosen, n: st.endRun.n + 1 } : { action: chosen, n: 1 }
    const conf = typeof confidence === 'number' ? confidence : 0
    if (conf >= this.endConf || st.endRun.n >= this.endStreak) return { act: chosen }
    return { act: 'wait', held: `${chosen} held back (confidence ${conf.toFixed(2)}, ${st.endRun.n} of ${this.endStreak} in a row): waited` }
  }

  /** One tick: view, offered, choice, execute. {view, offered, chosen, latency, timedOut, effect, end?} */
  async tick (api, st, mode) {
    const { obs, probe, offered, view, criteria } = this.snapshot(api, st, mode)
    const c = await this.chooser.choose(view, offered, { mode, intent: mode === 'survive' ? null : (st.target ? `${st.intent} (target: ${st.target})` : st.intent), criteria })
    const before = { pos: api.here().pos, health: obs && obs.self ? obs.self.health : null }
    // a timeout or an error is no decision: survive carries on with the task, play waits; neither counts
    // toward a streak, pauses a verb, or is logged as a choice
    const decided = !c.timedOut && !c.error
    let res
    if (!decided) res = { effect: mode === 'survive' ? 'no decision: continuing the task' : 'no decision: waited' }
    else {
      const gate = mode === 'play' ? this.endGate(st, c.choice, c.confidence) : { act: c.choice }
      res = gate.held ? { effect: gate.held } : await this.execute(api, st, gate.act, probe)
    }
    this.obsCache.at = 0 // the world changed: look again next tick
    this.obsCache.obs = null
    const after = api.here().pos
    const moved = Math.hypot(after[0] - before.pos[0], after[1] - before.pos[1], after[2] - before.pos[2])
    const effect = res.effect || (moved >= 0.5 ? `moved ${r1(moved)}` : 'no change')
    if (decided) {
      st.recent.push({ action: c.choice, effect })
      if (st.recent.length > 5) st.recent.shift()
    }
    // no progress: the same block and the same surroundings sentence as last tick, and not moving
    const here = after.map(Math.floor).join(',') + '|' + ((this.obs(api) || {}).surroundings || {}).summary
    const drift = st.lastPos ? Math.hypot(after[0] - st.lastPos[0], after[2] - st.lastPos[2]) : 0
    st.noProgress = here === st.lastPlace && drift < 0.05 ? (st.noProgress || 0) + 1 : 0
    st.lastPlace = here
    st.lastPos = after
    if (res.dug) st.dug++
    if (res.placed) st.placed++
    st.ticks++
    const rec = {
      source: 'player',
      mode,
      intent: st.intent,
      target: st.target,
      view,
      offered,
      criteria,
      chosen: decided ? c.choice : null,
      ...(decided ? {} : { no_decision: c.timedOut ? 'timeout' : 'error' }),
      probabilities: c.probabilities,
      confidence: c.confidence ?? null,
      margin: c.margin ?? null,
      ...(c.serverChoice ? { server_choice: c.serverChoice } : {}),
      latency_ms: r1(c.latency),
      timed_out: c.timedOut,
      ...(c.error ? { error: c.error } : {}),
      effect
    }
    this.log.write(rec)
    this.last.push({ t: Date.now(), mode, offered, chosen: decided ? c.choice : `(${c.timedOut ? 'timeout' : 'error'})`, confidence: c.confidence ?? null, latency_ms: r1(c.latency), effect })
    if (this.last.length > 20) this.last.shift()
    const now = Date.now()
    this.series.push({ t: now, ms: r1(c.latency), mode, timed_out: !!c.timedOut })
    while (this.series.length && now - this.series[0].t > 60000) this.series.shift()
    return { ...rec, decided, end: res.end }
  }

  /** Do one micro-action through the filtered API. {effect?, dug?, placed?, end?} */
  async execute (api, st, action, probe) {
    const d = DIRS[st.dir]
    const [x, y, z] = probe.feet
    const fail = r => ({ effect: `failed: ${r.reason || r.status || 'no'}` })
    switch (action) {
      case 'step': case 'sprint': {
        // a forward press that lets go by itself after one block (two sprinting) or 300 ms; the tick
        // goes on as soon as the bot moves, and the next step re-arms it
        const r = await api.press(st.dir, { sprint: action === 'sprint' })
        return { effect: r.moving ? `${action === 'sprint' ? 'sprinting' : 'walking'} ${st.dir}` : `failed: did not move ${st.dir}` }
      }
      case 'jump': { const r = await api.jump(); return { effect: r && r.airborne === false ? 'jumped (stayed on the ground)' : 'jumped' } }
      case 'turn_left': case 'turn_right':
        if (api.release) api.release()
        st.dir = (action === 'turn_left' ? LEFT : RIGHT)[st.dir]
        await api.face(st.dir)
        return { effect: `facing ${st.dir}` }
      case 'look_up': case 'look_down':
        st.pitch = Math.max(-90, Math.min(90, st.pitch + (action === 'look_up' ? 30 : -30)))
        if (api.look) await api.look(st.pitch)
        return { effect: `pitch ${st.pitch}` }
      case 'dig_ahead': {
        if (api.release) api.release()
        const headSolid = probe.cls(x + d[0], y + 1, z + d[1])?.solid
        const r = await api.digAhead(st.dir, headSolid ? 1 : 0, {})
        return r.ok ? { effect: `dug ${r.name || 'a block'} ahead`, dug: true } : fail(r)
      }
      case 'dig_above': case 'dig_below': {
        if (api.release) api.release()
        const dy = action === 'dig_above' ? 2 : -1
        const name = probe.cls(x, y + dy, z)?.name
        const r = await api.digRel(0, dy, 0, {})
        return r.ok ? { effect: `dug ${name || 'a block'} ${action === 'dig_above' ? 'above' : 'below'}`, dug: true } : fail(r)
      }
      case 'place_below_and_jump': {
        if (api.release) api.release()
        const b = blockFor(probe)
        const r = await api.pillar(b)
        return r.ok ? { effect: `pillared up on ${b}`, placed: true } : fail(r)
      }
      case 'place_ahead': {
        if (api.release) api.release()
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
        const r = await api.press(away, {})
        st.dir = away
        return r.moving ? { effect: `stepping ${away}, away from the ${t.type}` } : { effect: `failed: did not move ${away}` }
      }
      case 'swim_up': {
        if (api.release) api.release()
        const r = await api.swimUp()
        return { effect: r.rose >= 0.5 ? `swam up ${Math.round(r.rose * 10) / 10}` : 'swam up (no headway)' }
      }
      case 'exit_water': {
        const s = shore(probe)
        if (!s) return { effect: 'no shore in sight' }
        st.dir = s.dir
        const r = await api.press(s.dir, { jump: true })
        return { effect: r.moving ? `swimming ${s.dir} to the ${s.block} shore (${s.dist} blocks)` : `failed: did not move ${s.dir}` }
      }
      case 'extinguish': {
        const w = waterBeside(probe)
        if (!w) return { effect: probe.inWater ? 'in the water, waiting for the fire to go out' : 'no water beside: waiting for the fire to go out' }
        st.dir = w
        const r = await api.press(w, {})
        return { effect: r.moving ? `stepping ${w} into the water` : `failed: did not move ${w}` }
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
      this.count('play', start)
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
  async watch (api, { settled, interrupt = () => {}, idle = false }) {
    // idle (Session 8b-2): no verb is running, so there is nothing to pause; a survive action is just done
    const st = { intent: 'survive', target: null, dir: api.facing(), pitch: 0, recent: [], ticks: 0, dug: 0, placed: 0 }
    let paused = false; let cont = 0; let pausedAt = 0
    const out = { ticks: 0, pauses: 0, interrupted: false }
    let hotUntil = 0; let lastHealth = null
    while (!settled()) {
      const start = Date.now()
      const tk = await this.tick(api, st, 'survive')
      out.ticks++
      if (!tk.decided) out.undecided = (out.undecided || 0) + 1
      // full rate while a threat or damage is in view (and a second after damage); otherwise surviveHz
      const h = tk.view && tk.view.self ? tk.view.self.health : null
      if (typeof h === 'number' && lastHealth !== null && h < lastHealth) hotUntil = Date.now() + 1000
      if (typeof h === 'number') lastHealth = h
      const hot = (tk.view && tk.view.threats && tk.view.threats.length > 0) || Date.now() < hotUntil
      if (!tk.decided || idle) {
        // no answer: nothing changes (it neither pauses the verb nor counts toward resuming it);
        // idle: the action already ran in tick(), and there is no verb to hold
        if (idle && tk.decided && tk.chosen !== 'continue_task' && tk.chosen !== 'wait') out.acted = (out.acted || 0) + 1
      } else if (tk.chosen === 'continue_task') {
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
      await sleep(Math.max(0, (hot || paused ? this.periodMs : this.survivePeriodMs) - (Date.now() - start)))
      this.count('survive', start)
    }
    if (paused) api.resumeVerb()
    return out
  }

  count (mode, start) { const r = this.rates[mode]; r.ticks++; r.ms += Date.now() - start }

  /** "play 19.8 Hz (1180 ticks in 59.6 s), survive 5.0 Hz (300 ticks in 60.0 s)", the rates achieved per mode; resets. */
  rateReport () {
    const parts = Object.entries(this.rates).filter(([, r]) => r.ticks).map(([m, r]) => `${m} ${(r.ticks / Math.max(0.001, r.ms / 1000)).toFixed(1)} Hz (${r.ticks} ticks in ${(r.ms / 1000).toFixed(1)} s)`)
    this.rates = { play: { ticks: 0, ms: 0 }, survive: { ticks: 0, ms: 0 } }
    return parts.length ? parts.join(', ') : null
  }

  /** The 60 s line for body.out: latency, errors, and the achieved rate per mode. */
  report (now = Date.now()) { return this.chooser.stats.report(now, this.rateReport()) }

  /**
   * The 60 s line plus a bare /v1/systemone request timed from the body, to tell a slower server
   * (contention: the bare request is slow too) from a slower body (only the ticks are slow).
   */
  async reportWithBare () {
    const line = this.report()
    if (!this.chooser.bare) return line
    const b = await this.chooser.bare()
    return `${line}; bare request ${b.ok ? `${r1(b.ms)} ms` : `failed after ${r1(b.ms)} ms (${b.error})`}`
  }

  close () { return this.log.close() }
}

module.exports = { PlayerLoop, TickLog }
