'use strict'
// Working a site cell by cell (Session 10a): shared by build (placing), its prepare step and mine {box}
// (digging). Hands, not a planner: for one cell at a time it finds where to stand, walks there, and
// checks it can reach and see the cell from where it ended up.
//
// Stand spots: any standable cell (something solid under it, feet and head free: air or a plant the game
// replaces) within reach of the target whose eye has the target in sight. That includes cells inside the
// footprint and on top of blocks already placed. Never a cell the caller still has to fill (`avoid`), never
// the target itself, and, digging, never right on top of the target. Spots are tried nearest first (a spot
// lower than the bot costs 3 per block down), up to MAX_TRIES per cell; a spot the pathfinder could not
// reach is remembered and not tried again.
const { reachesVoxel, blockVisible } = require('../fairplay/raycast')
const { REPLACEABLE } = require('../replaceable')

const REACH = 4.5 // a player's block reach, from the eye
const FLUID = /^(water|lava)$/
const MAX_TRIES = 6
const key = p => p.join(',')

class Worksite {
  /** avoid: a Set of "x,y,z" the bot must not stand in (cells still to fill). */
  constructor (act, { avoid = new Set() } = {}) {
    this.act = act
    this.api = act.api
    this.avoid = avoid
    this.bad = new Set() // spots the pathfinder could not reach
  }

  cls (p) { return this.api.sight().classAt(p[0], p[1], p[2]) }
  empty (p) { const c = this.cls(p); return !!c && REPLACEABLE.test(c.name) && !FLUID.test(c.name) }
  solid (p) { const c = this.cls(p); return !!c && c.solid && !c.fluid }

  /** From an eye at e: target p in reach, and in sight (a face of a block; the empty cell itself for placing). */
  workable (e, p) {
    const ctr = [p[0] + 0.5, p[1] + 0.5, p[2] + 0.5]
    if (Math.hypot(ctr[0] - e[0], ctr[1] - e[1], ctr[2] - e[2]) > REACH) return false
    const s = this.api.sight()
    const view = { classAt: s.classAt }
    const c = s.classAt(p[0], p[1], p[2])
    if (c && !REPLACEABLE.test(c.name)) return blockVisible(view, e, p[0], p[1], p[2], c, null)
    return reachesVoxel(view, e, ctr, p[0], p[1], p[2])
  }

  /** Standing at feet cell f would be in the way of target p (in it, or, digging, right on top of it). */
  inTheWay (f, p, mode) {
    if (f[0] !== p[0] || f[2] !== p[2]) return false
    return f[1] === p[1] || f[1] + 1 === p[1] || (mode === 'dig' && f[1] - 1 === p[1])
  }

  /** Stand spots for target p, nearest to the bot first. */
  spots (p, mode) {
    const here = this.api.here().pos
    const out = []
    for (let x = p[0] - 4; x <= p[0] + 4; x++) {
      for (let z = p[2] - 4; z <= p[2] + 4; z++) {
        for (let y = p[1] - 5; y <= p[1] + 4; y++) {
          const f = [x, y, z]
          if (this.bad.has(key(f))) { this.badHits = (this.badHits || 0) + 1; continue }
          if (!this.solid([x, y - 1, z]) || !this.empty(f) || !this.empty([x, y + 1, z])) continue
          if (this.avoid.has(key(f)) || this.avoid.has(key([x, y + 1, z])) || this.inTheWay(f, p, mode)) continue
          if (!this.workable([x + 0.5, y + 1.62, z + 0.5], p)) continue
          // nearest first, but going down costs more than walking level: down a slope is often one way (no
          // digging, no scaffolding), so it works from where it is while it can
          out.push({ f, d: Math.hypot(x + 0.5 - here[0], y - here[1], z + 0.5 - here[2]) + 3 * Math.max(0, Math.floor(here[1]) - y) })
        }
      }
    }
    return out.sort((a, b) => a.d - b.d).map(s => s.f)
  }

  /** Get to where target p is in reach and in sight. {ok} or {ok: false, reason}. */
  async reach (p, mode) {
    const api = this.api
    const ok = () => {
      const feet = api.here().pos.map(Math.floor)
      return this.workable(api.sight().eye, p) && !this.inTheWay(feet, p, mode) && !this.avoid.has(key(feet))
    }
    if (ok()) return { ok: true }
    const tried = []
    this.badHits = 0
    for (const f of this.spots(p, mode).slice(0, MAX_TRIES)) {
      if (this.act.signal.aborted) return { ok: false, reason: 'stopped' }
      const r = await api.goto([f[0] + 0.5, f[1], f[2] + 0.5], { range: 0.5, dig: false, scaffold: false, signal: this.act.signal })
      if (this.act.signal.aborted) return { ok: false, reason: 'stopped' }
      if (ok()) return { ok: true } // there, or near enough
      if (r.status !== 'reached') this.bad.add(key(f))
      tried.push(`[${f.join(', ')}] ${r.status}`)
    }
    if (tried.length) return { ok: false, reason: `could not get within reach (tried ${tried.join(', ')})` }
    if (this.badHits) return { ok: false, reason: `could not get within reach: all ${this.badHits} stand spots in reach were unreachable before (walled in?)` }
    return { ok: false, reason: 'no spot to stand where it is in reach and in sight' }
  }
}

module.exports = { Worksite, REPLACEABLE, FLUID, REACH }
