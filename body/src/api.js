'use strict'
// The body's filtered API: the only thing verbs get to act with
// (CONTRACT.md: "Verbs ... use the body's filtered API only, never the raw
// backend" and "A verb may only target blocks or entities the bot has
// actually observed"). Everything returned is plain data.
//
// What may be targeted:
//   - blocks: in the latest obs blocks_seen, or in known places (both are
//     things the bot has seen through the fair-play filter);
//   - players and entities: in the latest obs (visible now);
//   - dropped items: visible now (same line-of-sight rule as entities);
//   - the block right in front of the bot (tunnelling, as a player digs
//     forward).
// peek() reads a block only if a face of it is visible from the eyes.
// Movement may plan over the loaded terrain (the walker sees the ground).
const { blockVisible, reachesVoxel } = require('./fairplay/raycast')
const { entityVisible } = require('./fairplay/observe')
const { classify } = require('./fairplay/blocks')

const r1 = v => Math.round(v * 10) / 10
const DIRS = {
  north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
  'north-east': [Math.SQRT1_2, -Math.SQRT1_2], 'north-west': [-Math.SQRT1_2, -Math.SQRT1_2],
  'south-east': [Math.SQRT1_2, Math.SQRT1_2], 'south-west': [-Math.SQRT1_2, Math.SQRT1_2]
}
const AIRLIKE = new Set(['air', 'cave_air', 'void_air'])
const key = p => `${p[0]},${p[1]},${p[2]}`

class VerbApi {
  /**
   * motor: Motor; observe(): latest fair-play obs (builds one);
   * places: KnownPlaces; sight(): {classAt, eye, sightRadius};
   * registry: {isBlock(name), isItem(name)}
   */
  constructor ({ motor, observe, places, sight, registry }) {
    this.motor = motor
    this._observe = observe
    this.places = places
    this.sight = sight
    this.registry = registry
    this.lastObs = null
    this.dropIds = new Set()
  }

  // ---- observation -------------------------------------------------------
  observe () {
    const o = this._observe()
    if (o) this.lastObs = o
    return o
  }

  obs () { return this.lastObs || this.observe() }

  here () {
    const o = this.obs()
    return { pos: this.motor.here(), dim: o ? o.self.dim : null, t: o ? o.t : 0 }
  }

  gamemode () { return this.motor.gamemode() }
  facing () { return this.motor.facing() }
  isBlock (name) { return this.registry.isBlock(name) }
  isItem (name) { return this.registry.isItem(name) }
  isObservableType (name) { return classify(name).notable }

  /**
   * Observed blocks of a type within radius of the bot, nearest first:
   * latest blocks_seen plus known places in this dimension.
   */
  seenBlocks (type, radius = Infinity) {
    const o = this.observe()
    if (!o) return []
    const me = this.motor.here()
    const seen = new Map()
    const add = (pos, source) => {
      const d = Math.hypot(pos[0] + 0.5 - me[0], pos[1] + 0.5 - me[1], pos[2] + 0.5 - me[2])
      if (d <= radius && !seen.has(key(pos))) seen.set(key(pos), { pos: [...pos], dist: r1(d), source })
    }
    for (const b of o.blocks_seen) if (b.type === type) add(b.pos, 'seen')
    for (const e of this.places.inDim(o.self.dim)) if (e.type === type) add(e.pos, 'known')
    return [...seen.values()].sort((a, b) => a.dist - b.dist)
  }

  /** Is this exact block observed (blocks_seen or known places) as `type`? */
  observedAs (pos, type) {
    const o = this.obs()
    if (!o) return false
    if (o.blocks_seen.some(b => b.type === type && key(b.pos) === key(pos))) return true
    return this.places.inDim(o.self.dim).some(e => e.type === type && key(e.pos) === key(pos))
  }

  /**
   * A goto target by name: a visible player, else the nearest visible entity
   * of that type, else the nearest observed block of that type.
   * {kind, name, pos} or null when not observed.
   */
  resolveTarget (name) {
    const o = this.observe()
    if (!o) return null
    const p = o.players.find(x => x.name === name)
    if (p) return { kind: 'player', name, pos: p.pos }
    const e = o.entities.filter(x => x.type === name).sort((a, b) => a.dist - b.dist)[0]
    if (e) return { kind: 'entity', name, pos: [o.self.pos[0] + e.rel[0], o.self.pos[1] + e.rel[1], o.self.pos[2] + e.rel[2]] }
    const b = this.seenBlocks(name)[0]
    if (b) return { kind: 'block', name, pos: b.pos }
    return null
  }

  /**
   * The block at pos, only if the bot can see it (same rule as blocks_seen):
   * a face of a solid block is visible, or for air and see-through cells,
   * a sight line from the eyes reaches the cell. Else null.
   */
  peek (pos) {
    const s = this.sight()
    const view = { classAt: s.classAt }
    const [x, y, z] = pos
    const cls = s.classAt(x, y, z)
    if (!cls) return null
    if (Math.hypot(x + 0.5 - s.eye[0], y + 0.5 - s.eye[1], z + 0.5 - s.eye[2]) > s.sightRadius) return null
    if (blockVisible(view, s.eye, x, y, z, cls, null)) return cls.name
    if (!cls.opaque && reachesVoxel(view, s.eye, [x + 0.5, y + 0.5, z + 0.5], x, y, z)) return cls.name
    return null
  }

  /** Cell in front of the feet: dir (cardinal), forward n, level dy. */
  ahead (dir, dy = 0, n = 1) {
    const me = this.motor.here().map(Math.floor)
    const d = DIRS[dir]
    return [me[0] + d[0] * n, me[1] + dy, me[2] + d[1] * n]
  }

  // ---- movement ----------------------------------------------------------
  goto (pos, opts = {}) { return this.motor.goto({ pos, ...opts }) }

  /** One block forward (cardinal dir), at the same level. */
  step (dir, { signal } = {}) {
    const p = this.ahead(dir, 0, 1)
    return this.motor.goto({ pos: [p[0] + 0.5, p[1], p[2] + 0.5], range: 0, signal, stuckMs: 4000, timeoutMs: 8000 })
  }

  face (dir) { return this.motor.face(dir) }

  /** Look left, right and back to the front (the explore pause). */
  async lookAround (signal) {
    const base = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 }[this.motor.facing()] ?? 0
    for (const dy of [Math.PI / 2, -Math.PI / 2, 0]) {
      if (signal?.aborted) return
      await this.motor.look(base + dy, 0)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }

  // ---- digging -----------------------------------------------------------
  toolFor (type) { return this.motor.toolFor(type) }

  /**
   * Dig an observed block. Refused (fair play) unless pos is in blocks_seen or
   * known places as `type`. {ok, refused?, needsTool?, gone?, reason?}
   */
  async digObserved (pos, type, { signal } = {}) {
    if (!this.observedAs(pos, type)) return { ok: false, refused: true, reason: `fair play: no ${type} has been observed at [${pos.join(', ')}]` }
    const now = this.peek(pos)
    if (now !== null && now !== type) return { ok: false, gone: true, reason: `${type} at [${pos.join(', ')}] is now ${now}` }
    return this.motor.dig(pos, { signal })
  }

  /** Dig the block directly in front (dy 0 = feet level, 1 = head level). */
  async digAhead (dir, dy, { signal } = {}) {
    if (dy !== 0 && dy !== 1) return { ok: false, refused: true, reason: 'only the two blocks in front can be tunnelled' }
    return this.motor.dig(this.ahead(dir, dy, 1), { signal, allowHand: true })
  }

  // ---- items -------------------------------------------------------------
  /** Dropped items in sight: [{id, item, pos, dist}], nearest first. */
  visibleDrops (item = null, maxDist = Infinity) {
    const s = this.sight()
    const view = { classAt: s.classAt }
    const me = this.motor.here()
    const out = []
    for (const d of this.motor.drops()) {
      if (item && d.item !== item) continue
      const dist = Math.hypot(d.pos[0] - me[0], d.pos[1] - me[1], d.pos[2] - me[2])
      if (dist > Math.min(maxDist, s.sightRadius)) continue
      if (!entityVisible(view, s.eye, d.pos, d.height)) continue
      out.push({ id: d.id, item: d.item, pos: d.pos.map(r1), dist: r1(dist) })
    }
    out.sort((a, b) => a.dist - b.dist)
    for (const d of out) this.dropIds.add(d.id)
    return out
  }

  /** Walk onto a drop listed by visibleDrops and wait until it is picked up. */
  async pickUp (drop, { signal } = {}) {
    if (!this.dropIds.has(drop.id)) return { ok: false, refused: true, reason: 'fair play: that drop was not seen' }
    const g = await this.motor.goto({ pos: drop.pos, range: 1, signal, stuckMs: 6000 })
    const until = Date.now() + (g.status === 'reached' ? 3000 : 300)
    while (this.motor.entityExists(drop.id) && Date.now() < until && !signal?.aborted) await new Promise(resolve => setTimeout(resolve, 150))
    const ok = !this.motor.entityExists(drop.id)
    return { ok, reached: g.status === 'reached', reason: ok ? null : `could not reach ${drop.item} at [${drop.pos.join(', ')}] (${g.status})` }
  }

  inventoryCount (item) { return this.motor.inventory()[item] || 0 }

  /** Known-place keys in a dimension (to count new ones). */
  placeKeys (dim) { return new Set(this.places.inDim(dim).map(e => key(e.pos))) }
}

module.exports = { VerbApi, DIRS }
