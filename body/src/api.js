'use strict'
// The body's filtered API: the only thing verbs get to act with
// (CONTRACT.md: "Verbs ... use the body's filtered API only, never the raw
// backend" and "A verb may only target blocks or entities the bot has
// actually observed"). Everything returned is plain data.
//
// What may be targeted:
//   - blocks: in the latest obs blocks_seen, or in known places (both are
//     things the bot has seen through the fair-play filter), or any block
//     visible now by the same line-of-sight check (common types: stone,
//     dirt, gravel… that blocks_seen does not list);
//   - players by Locator Bar bearing (when the game shows them on the bar);
//   - players and entities: in the latest obs (visible now);
//   - dropped items: visible now (same line-of-sight rule as entities);
//   - the block right in front of the bot (tunnelling, as a player digs
//     forward).
// peek() reads a block only if a face of it is visible from the eyes.
// Movement may plan over the loaded terrain (the walker sees the ground).
// House rules: dig and place inside a protected region are refused here
// (and the motor guards them again underneath).
const { blockVisible, reachesVoxel } = require('./fairplay/raycast')
const { entityVisible } = require('./fairplay/observe')
const { classify } = require('./fairplay/blocks')

const r1 = v => Math.round(v * 10) / 10
const DIRS = {
  north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0],
  'north-east': [Math.SQRT1_2, -Math.SQRT1_2], 'north-west': [-Math.SQRT1_2, -Math.SQRT1_2],
  'south-east': [Math.SQRT1_2, Math.SQRT1_2], 'south-west': [-Math.SQRT1_2, Math.SQRT1_2]
}
const { CONTAINERS } = require('./chests')
const AIRLIKE = new Set(['air', 'cave_air', 'void_air'])
const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'vine', 'dead_bush', 'seagrass', 'tall_seagrass'])

// Offsets within radius R, nearest first (cached per R).
const OFFSETS = new Map()
function offsetsWithin (R) {
  const k = Math.ceil(R)
  if (OFFSETS.has(k)) return OFFSETS.get(k)
  const out = []
  for (let dx = -k; dx <= k; dx++) {
    for (let dy = -k; dy <= k; dy++) {
      for (let dz = -k; dz <= k; dz++) {
        const d = Math.hypot(dx, dy, dz)
        if (d <= k) out.push([dx, dy, dz, d])
      }
    }
  }
  out.sort((a, b) => a[3] - b[3])
  OFFSETS.set(k, out)
  return out
}
const key = p => `${p[0]},${p[1]},${p[2]}`

class VerbApi {
  /**
   * motor: Motor; observe(): latest fair-play obs (builds one);
   * places: KnownPlaces; sight(): {classAt, eye, sightRadius};
   * registry: {isBlock(name), isItem(name)}; house: HouseRules;
   * locator: Locator Bar waypoints (src/locator.js)
   */
  constructor ({ motor, observe, places, sight, registry, house = null, locator = null, chests = null }) {
    this.motor = motor
    this.chests = chests
    this.house = house
    this.locator = locator
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
  /** Game knowledge from the loot tables (src/drops.js): where an item comes from, what a block drops. */
  mineHint (name, opts) { return this.registry.mineHint ? this.registry.mineHint(name, opts) : null }
  collectHint (item) { return this.registry.collectHint ? this.registry.collectHint(item) : null }
  dropsOf (block) { return this.registry.dropsOf ? this.registry.dropsOf(block) : [] }
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

  /**
   * Blocks of `type` visible now, nearest first, by looking at the terrain
   * around the bot: the same line-of-sight check as blocks_seen, for any type
   * (blocks_seen lists notable types only). Looks at most `within` blocks
   * out (default 24) and returns at most `limit`.
   */
  visibleBlocks (type, { within = 24, limit = 16 } = {}) {
    const s = this.sight()
    const view = { classAt: s.classAt }
    const R = Math.min(within, s.sightRadius)
    const e = s.eye
    const ex = Math.floor(e[0]); const ey = Math.floor(e[1]); const ez = Math.floor(e[2])
    const out = []
    for (const [dx, dy, dz] of offsetsWithin(R)) {
      const x = ex + dx; const y = ey + dy; const z = ez + dz
      const c = s.classAt(x, y, z)
      if (!c || c.name !== type) continue
      if (!blockVisible(view, e, x, y, z, c, null)) continue
      out.push({ pos: [x, y, z], dist: r1(Math.hypot(x + 0.5 - e[0], y + 0.5 - e[1], z + 0.5 - e[2])), source: 'visible' })
      if (out.length >= limit) break
    }
    return out
  }

  /** Observed targets of a type: seenBlocks plus visibleBlocks, nearest first. */
  targetsOfType (type, radius = 32) {
    const all = new Map()
    for (const b of this.seenBlocks(type, radius)) all.set(key(b.pos), b)
    for (const b of this.visibleBlocks(type, { within: Math.min(radius, 24) })) if (!all.has(key(b.pos))) all.set(key(b.pos), b)
    return [...all.values()].sort((a, b) => a.dist - b.dist)
  }

  /** Locator Bar azimuth (F3 degrees, from the bot) of a player not in sight; null if the bar doesn't show them. */
  playerAzimuth (name) {
    return this.locator ? this.locator.azimuthOf(name) : null
  }

  /** House-rules check: null if allowed, else the refusal reason. */
  houseCheck (action, pos) {
    return this.house ? this.house.check(action, pos, this.motor.dimension?.() ?? this.obs()?.self.dim) : null
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
    const p = o.players.find(x => x.name === name && x.pos) // in sight (bearing-only entries have no pos)
    if (p) return { kind: 'player', name, pos: p.pos }
    const e = o.entities.filter(x => x.type === name).sort((a, b) => a.dist - b.dist)[0]
    if (e) return { kind: 'entity', name, pos: [o.self.pos[0] + e.rel[0], o.self.pos[1] + e.rel[1], o.self.pos[2] + e.rel[2]] }
    const b = this.seenBlocks(name)[0]
    if (b) return { kind: 'block', name, pos: b.pos }
    const az = this.playerAzimuth(name)
    if (az !== null) {
      const vertical = this.locator && this.locator.verticalOf ? this.locator.verticalOf(name) : null
      return { kind: 'bearing', name, azimuth: az, ...(vertical ? { vertical } : {}) }
    }
    return null
  }

  /**
   * The block at pos, only if the bot can see it (same rule as blocks_seen):
   * a face of a solid block is visible, or for air and see-through cells,
   * a sight line from the eyes reaches the cell. Else null.
   * lean: a direction (north…) to look from the edge of the bot's block, as a
   * player steps up to a hole and looks down into it (eye moved 0.45 that way).
   */
  peek (pos, { lean } = {}) {
    const s = { ...this.sight() }
    if (lean && DIRS[lean]) s.eye = [s.eye[0] + DIRS[lean][0] * 0.45, s.eye[1], s.eye[2] + DIRS[lean][1] * 0.45]
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

  /** One block forward and `depth` down (cardinal dir): a staircase step, or a short drop. */
  stepDown (dir, { signal, depth = 1 } = {}) {
    const p = this.ahead(dir, -depth, 1)
    return this.motor.goto({ pos: [p[0] + 0.5, p[1], p[2] + 0.5], range: 0, dig: false, scaffold: false, signal, stuckMs: 4000, timeoutMs: 8000 })
  }

  face (dir) { return this.motor.face(dir) }

  /** Walk back to the centre of the block it stands on. */
  recenter ({ signal } = {}) {
    const p = this.motor.here().map(Math.floor)
    return this.motor.goto({ pos: [p[0] + 0.5, p[1], p[2] + 0.5], range: 0, dig: false, scaffold: false, signal, stuckMs: 3000, timeoutMs: 5000 })
  }

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
   * known places as `type`, or is visible now as `type`; refused (house
   * rules) inside a protected region. {ok, refused?, needsTool?, gone?, reason?}
   */
  async digObserved (pos, type, { signal, allowHand = false } = {}) {
    const house = this.houseCheck('dig', pos)
    if (house) return { ok: false, refused: true, reason: house }
    const now = this.peek(pos)
    if (!this.observedAs(pos, type) && now !== type) return { ok: false, refused: true, reason: `fair play: no ${type} has been observed at [${pos.join(', ')}]` }
    if (now !== null && now !== type) return { ok: false, gone: true, reason: `${type} at [${pos.join(', ')}] is now ${now}` }
    return this.motor.dig(pos, { signal, allowHand })
  }

  /** Dig the block directly in front (dy 0 = feet level, 1 = head level, -1 = the next step down). */
  async digAhead (dir, dy, { signal } = {}) {
    if (dy !== 0 && dy !== 1 && dy !== -1) return { ok: false, refused: true, reason: 'only the blocks in front (feet, head, one below) can be tunnelled' }
    const pos = this.ahead(dir, dy, 1)
    const house = this.houseCheck('dig', pos)
    if (house) return { ok: false, refused: true, reason: house }
    return this.motor.dig(pos, { signal, allowHand: true })
  }

  // ---- the player loop's hands (src/player): one block, one jump, one hit --
  /** Dig one block next to the feet: dx, dz in -1..1, dy -1 (below) .. 2 (above the head). */
  async digRel (dx, dy, dz, { signal } = {}) {
    if (Math.abs(dx) > 1 || Math.abs(dz) > 1 || dy < -1 || dy > 2) return { ok: false, refused: true, reason: 'only the blocks right around the bot' }
    const f = this.motor.here().map(Math.floor)
    const pos = [f[0] + dx, f[1] + dy, f[2] + dz]
    const house = this.houseCheck('dig', pos)
    if (house) return { ok: false, refused: true, reason: house }
    return this.motor.dig(pos, { signal, allowHand: true })
  }

  jump () { return this.motor.jump() }

  /** Jump and place a block under the feet (a pillar step). */
  async pillar (block) {
    if (!block || !this.inventoryCount(block)) return { ok: false, reason: block ? `no ${block} in inventory` : 'no block to place' }
    const f = this.motor.here().map(Math.floor)
    const house = this.houseCheck('place', f)
    if (house) return { ok: false, refused: true, reason: house }
    return this.motor.pillar(block)
  }

  /** Hit the nearest visible hostile within maxDist. */
  async attackNearest (maxDist = 3.5) {
    const o = this.obs()
    const e = o && o.entities.filter(x => x.hostile && x.dist <= maxDist).sort((a, b) => a.dist - b.dist)[0]
    if (!e) return { ok: false, reason: 'nothing hostile in reach' }
    const pos = [o.self.pos[0] + e.rel[0], o.self.pos[1] + e.rel[1], o.self.pos[2] + e.rel[2]]
    const r = await this.motor.attack(e.type, pos)
    return { ...r, type: e.type }
  }

  useShield () {
    if (!this.inventoryCount('shield')) return Promise.resolve({ ok: false, reason: 'no shield' })
    return this.motor.shield()
  }

  /** Look up/down (degrees, + up) while facing the same way. */
  look (pitchDeg) {
    const yaw = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 }[this.motor.facing()] ?? 0
    return this.motor.look(yaw, pitchDeg * Math.PI / 180)
  }

  /** The override: hold the running scripted verb's movement and digging, and let it go again. */
  /** Is the motor doing anything right now (the imitation recorder's idle test)? */
  motorActive () { return this.motor.active ? this.motor.active() : false }
  pauseVerb () { if (this.motor.pause) this.motor.pause() }
  resumeVerb () { if (this.motor.resume) this.motor.resume() }

  /** What a block at pos is, if observed: visible now, or a known place there. */
  observedBlock (pos) {
    const now = this.peek(pos)
    if (now) return now
    const o = this.obs()
    const hit = o && (o.blocks_seen.find(b => key(b.pos) === key(pos)) || this.places.inDim(o.self.dim).find(e => key(e.pos) === key(pos)))
    return hit ? hit.type : null
  }

  // ---- placing, equipping, eating, crafting -------------------------------
  /**
   * Place an inventory block at pos: an empty cell the bot can see and reach
   * from where it stands, against a visible neighbouring block.
   * {ok, refused?, reason?}
   */
  async place (block, pos, { reach = 4.5 } = {}) {
    const house = this.houseCheck('place', pos)
    if (house) return { ok: false, refused: true, reason: house }
    if (!this.inventoryCount(block)) return { ok: false, reason: `no ${block} in inventory` }
    const s = this.sight()
    const d = Math.hypot(pos[0] + 0.5 - s.eye[0], pos[1] + 0.5 - s.eye[1], pos[2] + 0.5 - s.eye[2])
    if (d > reach) return { ok: false, reason: `[${pos.join(', ')}] is out of reach (${r1(d)} blocks, max ${reach}); goto closer first` }
    const feet = this.motor.here().map(Math.floor)
    if (pos[0] === feet[0] && pos[2] === feet[2] && (pos[1] === feet[1] || pos[1] === feet[1] + 1)) return { ok: false, reason: `[${pos.join(', ')}] is where Atlas is standing` }
    const here = this.peek(pos)
    if (here === null) return { ok: false, reason: `[${pos.join(', ')}] is not visible from here` }
    if (!REPLACEABLE.has(here)) return { ok: false, reason: `[${pos.join(', ')}] is not empty (${here})` }
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const ref = [pos[0] + dx, pos[1] + dy, pos[2] + dz]
      const c = s.classAt(ref[0], ref[1], ref[2])
      if (!c || !c.opaque || c.fluid) continue
      const r = await this.motor.place(block, ref, pos)
      return r.ok ? r : { ok: false, reason: r.reason }
    }
    return { ok: false, reason: `nothing solid next to [${pos.join(', ')}] to place against` }
  }

  /**
   * An observed container at pos (visible now or a known place): its type,
   * or a refusal / failure reason. {ok, type?, refused?, reason?}
   */
  container (pos) {
    const name = this.observedBlock(pos)
    if (!name) return { ok: false, refused: true, reason: `fair play: no chest has been observed at [${pos.join(', ')}]` }
    if (!CONTAINERS.has(name)) return { ok: false, reason: `[${pos.join(', ')}] is ${name}, not a chest or barrel` }
    return { ok: true, type: name }
  }

  /** House rules: may the bot take from the chest at pos? */
  mayTakeFrom (pos) {
    return !!(this.chests && this.chests.has(this.motor.dimension?.() ?? this.obs()?.self.dim, pos))
  }

  toss (item, count, at) { return this.motor.toss(item, count, at) }
  deposit (pos, item, count) { return this.motor.deposit(pos, item, count) }
  withdraw (pos, item, count) { return this.motor.withdraw(pos, item, count) }

  equip (item, slot) { return this.motor.equip(item, slot) }
  foods () { return this.motor.foods() }
  isFood (name) { return this.motor.isFood(name) }
  food () { return this.motor.food() }
  eat (item) { return this.motor.eat(item) }
  craftPlan (item, count) { return this.motor.craftPlan(item, count) }
  craft (item, count, tablePos) { return this.motor.craft(item, count, tablePos) }
  smelt (pos, opts) { return this.motor.smelt(pos, opts) }

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
  inventory () { return this.motor.inventory() }

  /** Known-place keys in a dimension (to count new ones). */
  placeKeys (dim) { return new Set(this.places.inDim(dim).map(e => key(e.pos))) }
}

module.exports = { VerbApi, DIRS }
