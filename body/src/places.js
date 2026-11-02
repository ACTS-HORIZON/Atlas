'use strict'
// Known places (CONTRACT.md, "Known places"): every notable block the bot has
// observed, with position, dimension and last-seen time, persisted to a JSON
// file and reloaded on start.
//
// Fair play: the only way in is recordObs(obs), which reads obs.blocks_seen,
// i.e. the output of the fair-play builder. Nothing reads the backend here.
const fs = require('fs')
const path = require('path')

const FILE_VERSION = 1
const r1 = v => Math.round(v * 10) / 10
const keyOf = (dim, pos) => `${dim}:${pos[0]},${pos[1]},${pos[2]}`

class KnownPlaces {
  constructor ({ file, maxEntries = 20000, saveDelayMs = 10000 } = {}) {
    this.file = file
    this.maxEntries = maxEntries
    this.saveDelayMs = saveDelayMs
    this.map = new Map()
    this.dirty = false
    this.timer = null
  }

  get size () { return this.map.size }

  load () {
    if (!this.file || !fs.existsSync(this.file)) return this
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (j.version !== FILE_VERSION || !Array.isArray(j.entries)) throw new Error(`unsupported file version ${j.version}`)
      for (const e of j.entries) {
        if (typeof e.type !== 'string' || !Array.isArray(e.pos) || e.pos.length !== 3 || typeof e.dim !== 'string') continue
        this.map.set(keyOf(e.dim, e.pos), { type: e.type, pos: e.pos.map(Math.trunc), dim: e.dim, t: Number(e.t) || 0, seen_at: e.seen_at ?? null })
      }
    } catch (err) {
      const bad = `${this.file}.bad-${Date.now()}`
      console.warn(`[places] could not read ${this.file} (${err.message}); moved it to ${bad}, starting empty`)
      try { fs.renameSync(this.file, bad) } catch {}
    }
    return this
  }

  /** Record every block in a fair-play obs's blocks_seen. */
  recordObs (obs) {
    const dim = obs.self.dim
    const seenAt = new Date().toISOString()
    for (const b of obs.blocks_seen) {
      this.map.set(keyOf(dim, b.pos), { type: b.type, pos: [b.pos[0], b.pos[1], b.pos[2]], dim, t: obs.t, seen_at: seenAt })
    }
    if (obs.blocks_seen.length) this.changed()
  }

  /** Apply recheckKnown() output for dimension `dim` at game time t. */
  applyRecheck (dim, t, { seen, gone }) {
    const seenAt = new Date().toISOString()
    for (const e of seen) { const k = this.map.get(keyOf(dim, e.pos)); if (k) { k.t = t; k.seen_at = seenAt } }
    for (const e of gone) this.map.delete(keyOf(dim, e.pos))
    if (seen.length || gone.length) this.changed()
  }

  /** Entries in `dim` (all of them; recheckKnown filters by distance). */
  inDim (dim) {
    const out = []
    for (const e of this.map.values()) if (e.dim === dim) out.push(e)
    return out
  }

  /** Nearest entry of `type` in `dim` to `near`, or null. */
  recall (type, near, dim, now) {
    let best = null; let bd = Infinity
    for (const e of this.map.values()) {
      if (e.dim !== dim || e.type !== type) continue
      const d = Math.hypot(e.pos[0] + 0.5 - near[0], e.pos[1] + 0.5 - near[1], e.pos[2] + 0.5 - near[2])
      if (d < bd) { bd = d; best = e }
    }
    if (!best) return null
    return { type: best.type, pos: [...best.pos], dist: r1(bd), age: Math.max(0, Math.trunc(now - best.t)) }
  }

  changed () {
    this.dirty = true
    if (this.map.size > this.maxEntries) {
      const old = [...this.map.entries()].sort((a, b) => a[1].t - b[1].t)
      for (const [k] of old.slice(0, this.map.size - this.maxEntries)) this.map.delete(k)
    }
    if (this.file && !this.timer && this.saveDelayMs >= 0) {
      this.timer = setTimeout(() => { this.timer = null; this.save() }, this.saveDelayMs)
      this.timer.unref?.()
    }
  }

  /** Write atomically (tmp file + rename). */
  save () {
    if (!this.file || !this.dirty) return
    clearTimeout(this.timer); this.timer = null
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, entries: [...this.map.values()] }) + '\n')
    fs.renameSync(tmp, this.file)
    this.dirty = false
  }
}

module.exports = { KnownPlaces }
