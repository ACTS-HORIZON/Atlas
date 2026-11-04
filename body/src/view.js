'use strict'
// Mineflayer -> backend-neutral view (see fairplay/observe.js for the shape).
// This is the only file in the observation path that knows about Mineflayer.
// It may read more than a player perceives (that is what a backend does);
// fairplay/observe.js decides what gets out.

const { classify } = require('./fairplay/blocks')

const HOSTILE_FALLBACK = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider',
  'cave_spider', 'witch', 'slime', 'magma_cube', 'phantom', 'blaze', 'ghast', 'wither_skeleton',
  'pillager', 'vindicator', 'evoker', 'illusioner', 'ravager', 'vex', 'guardian', 'elder_guardian',
  'shulker', 'silverfish', 'endermite', 'hoglin', 'zoglin', 'piglin_brute', 'warden', 'breeze',
  'creaking', 'wither', 'ender_dragon'
])

/** How much the sky's light is dimmed now: 0 by day, 11 at night (sky light 4), ramps at dusk and dawn; rain 3, thunder 5 more. */
function skyDarkness (timeOfDay, raining, thundering) {
  const t = ((Number(timeOfDay) % 24000) + 24000) % 24000
  let d
  if (t < 12000) d = 0
  else if (t < 13800) d = Math.round(11 * (t - 12000) / 1800)
  else if (t < 22200) d = 11
  else d = Math.round(11 * (24000 - t) / 1800)
  return Math.min(11, d + (thundering ? 5 : raining ? 3 : 0))
}

const deg = r => r * 180 / Math.PI
const norm180 = d => { d = ((d % 360) + 360) % 360; return d > 180 ? d - 360 : d }
/** Mineflayer yaw/pitch (radians, yaw 0 = north, pitch + = up) -> unit look vector. */
const lookVector = (yaw, pitch) => [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]
const snake = s => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/\s+/g, '_').toLowerCase()
const AIR_CLASS = classify('air')

class MineflayerView {
  constructor (bot, { sightRadius, locator = null, placedAt = null }) {
    this.bot = bot
    this.locator = locator
    this.placedAt = placedAt // (x, y, z) -> did the bot place that block (Motor.isPlaced)
    this.maxSight = sightRadius
    this.byState = [] // stateId -> classify() result, filled lazily
    this.cols = new Map()
    this.sectionHits = new WeakMap() // section -> cached notable indices, see sectionNotable()
    this.classAt = this.classAt.bind(this)
  }

  stateClass (id) {
    let c = this.byState[id]
    if (c === undefined) {
      const b = this.bot.registry.blocksByStateId[id]
      c = b ? classify(b.name, b.boundingBox) : AIR_CLASS
      this.byState[id] = c
    }
    return c
  }

  column (cx, cz) {
    if (cx === this.lastCx && cz === this.lastCz) return this.lastCol // rays are spatially coherent
    const k = cx * 1048576 + cz
    let col = this.cols.get(k)
    if (col === undefined) {
      col = this.bot.world.getColumn(cx, cz) || null
      this.cols.set(k, col)
    }
    this.lastCx = cx; this.lastCz = cz; this.lastCol = col
    return col
  }

  /** Fast voxel lookup straight from chunk sections; null = not loaded. */
  classAt (x, y, z) {
    const col = this.column(x >> 4, z >> 4)
    if (!col) return null
    const minY = this.bot.game.minY
    const sy = (y - minY) >> 4
    if (sy < 0) return null // below the world: void, can't see through it
    if (sy >= col.sections.length) return AIR_CLASS
    const sec = col.sections[sy]
    if (!sec) return AIR_CLASS
    return this.stateClass(sec.data.get(((y & 15) << 8) | ((z & 15) << 4) | (x & 15)))
  }

  /**
   * Notable blocks whose centre is within R of eye: visit(x, y, z, cls),
   * in a fixed order (columns, sections, then index within the section).
   * Sections whose palette has no notable state are skipped; packed section
   * data is decoded a word at a time (same arithmetic as BitArray.get).
   */
  scanNotable (eye, R, visit) {
    const minY = this.bot.game.minY
    const cx0 = Math.floor((eye[0] - R) / 16); const cx1 = Math.floor((eye[0] + R) / 16)
    const cz0 = Math.floor((eye[2] - R) / 16); const cz1 = Math.floor((eye[2] + R) / 16)
    const R2 = R * R
    const R2loose = R2 * (1 + 1e-9) // exact d <= R test happens in the builder
    const ex = eye[0] - 0.5; const ey = eye[1] - 0.5; const ez = eye[2] - 0.5 // block centre offsets
    const axisGap = (v, lo) => v < lo ? lo - v : v > lo + 16 ? v - lo - 16 : 0
    // emit(i, cls) for section-local index i, if its centre is within R
    let bx = 0; let by = 0; let bz = 0
    const emit = (i, c) => {
      const x = bx + (i & 15); const y = by + (i >> 8); const z = bz + ((i >> 4) & 15)
      const dx = x - ex; const dy = y - ey; const dz = z - ez
      if (dx * dx + dy * dy + dz * dz <= R2loose) visit(x, y, z, c)
    }
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const gx = axisGap(eye[0], cx * 16); const gz = axisGap(eye[2], cz * 16)
        if (gx * gx + gz * gz > R2) continue
        const col = this.column(cx, cz)
        if (!col) continue
        for (let sy = 0; sy < col.sections.length; sy++) {
          const sec = col.sections[sy]
          if (!sec) continue
          by = minY + sy * 16
          const gy = axisGap(eye[1], by)
          if (gx * gx + gy * gy + gz * gz > R2) continue
          const data = sec.data
          bx = cx * 16; bz = cz * 16
          if (data.palette && data.data) { // indirect palette: hits by palette index
            const h = this.sectionNotable(sec, data)
            for (let q = 0; q < h.idx.length; q++) emit(h.idx[q], h.cls[q])
            continue
          }
          if (data.value !== undefined && !data.palette) { // single-value section
            const c = this.stateClass(data.value)
            if (!c.notable) continue
            for (let i = 0; i < 4096; i++) emit(i, c)
            continue
          }
          if (data.data && data.data.valuesPerLong) { // direct (global) palette: values are state ids
            decode(data.data, id => { const c = this.stateClass(id); return c.notable ? c : null }, emit)
            continue
          }
          for (let i = 0; i < 4096; i++) { // anything else: the slow, generic way
            const c = this.stateClass(data.get(i))
            if (c.notable) emit(i, c)
          }
        }
      }
    }
  }

  /**
   * Notable blocks of an indirect-palette section as {idx, cls}. Cached per
   * section and reused only while its palette and packed words are exactly
   * equal to the copy taken when the cache entry was made; any block change
   * in the section changes those, so the result is always what a fresh
   * decode would give.
   */
  sectionNotable (sec, data) {
    const pal = data.palette; const bits = data.data; const words = bits.data
    const e = this.sectionHits.get(sec)
    if (e && e.data === data && e.bits === bits.bitsPerValue && sameArray(e.pal, pal) && sameArray(e.words, words)) return e
    const hit = new Array(pal.length)
    let any = false
    for (let j = 0; j < pal.length; j++) { const c = this.stateClass(pal[j]); hit[j] = c.notable ? c : null; any ||= c.notable }
    const idx = []; const cls = []
    if (any) decode(bits, j => hit[j], (i, c) => { idx.push(i); cls.push(c) })
    const entry = { data, bits: bits.bitsPerValue, pal: pal.slice(), words: Uint32Array.from(words), idx, cls }
    this.sectionHits.set(sec, entry)
    return entry
  }

  /** Line-of-sight context for the verb API: fresh caches, eye, radius. */
  sight () {
    this.cols.clear()
    this.lastCx = this.lastCz = undefined; this.lastCol = null
    const me = this.bot.entity
    const p = me.position
    return { classAt: this.classAt, eye: [p.x, p.y + (me.eyeHeight || 1.62), p.z], sightRadius: this.sightRadius() }
  }

  sightRadius () {
    const chunks = Math.min(this.bot.game.serverViewDistance || 32, clientViewChunks(this.bot))
    return Math.min(this.maxSight, chunks * 16)
  }

  /**
   * Light the bot stands in (0-15) and the biome name at a block.
   * Light: max(block light, sky light - how dark the sky is now), the way the
   * game combines them. Chunk light data is used where the server sent it;
   * sky light is also 15 wherever nothing solid is overhead (overworld), so a
   * missing or empty light section can't read as 0 at noon; block light with
   * no data is estimated from light-emitting blocks within 8 (no occlusion).
   * Biome: the chunk's biome id, named through the registry (prismarine-block's
   * own biome objects come back nameless on 26.1).
   */
  lightAndBiome (x, y, z) {
    const bot = this.bot
    const col = this.column(x >> 4, z >> 4)
    if (!col) return { light: null, biome: null }
    const local = { x: x & 15, y, z: z & 15 }
    const minY = bot.game.minY ?? -64
    const idx = Math.floor((y - minY) / 16) + 1
    const has = (mask, empty) => !!((mask && mask.get && mask.get(idx)) || (empty && empty.get && empty.get(idx)))
    let sky = 0; let block = null
    try { if (has(col.skyLightMask, col.emptySkyLightMask)) sky = col.getSkyLight(local) } catch {}
    try { if (has(col.blockLightMask, col.emptyBlockLightMask)) block = col.getBlockLight(local) } catch {}
    const overworld = String(bot.game.dimension || '').replace('minecraft:', '') === 'overworld'
    if (overworld && sky < 15 && this.openToSky(x, y, z)) sky = 15
    if (block === null) block = this.estimateBlockLight(x, y, z)
    const light = Math.max(block, overworld ? Math.max(0, sky - skyDarkness(bot.time?.timeOfDay ?? 0, bot.isRaining, bot.thunderState > 0)) : 0)
    let biome = null
    try {
      const id = col.getBiome(local)
      biome = bot.registry.biomes?.[id]?.name ?? null
    } catch {}
    return { light: Math.min(15, light), biome }
  }

  /** Nothing solid between this block and the top of the world. */
  openToSky (x, y, z) {
    const top = (this.bot.game.minY ?? -64) + (this.bot.game.height ?? 384)
    for (let yy = y + 1; yy < top; yy++) {
      const c = this.classAt(x, yy, z)
      if (c === null) return false
      if (c.opaque || (c.solid && !/glass|ice/.test(c.name))) return false
    }
    return true
  }

  /** Brightest emitter within 8 blocks, minus its taxicab distance. */
  estimateBlockLight (x, y, z) {
    const reg = this.bot.registry
    if (!this.emitByState) this.emitByState = []
    let best = 0
    for (let dx = -8; dx <= 8; dx++) {
      for (let dz = -8; dz <= 8; dz++) {
        const col = this.column((x + dx) >> 4, (z + dz) >> 4)
        if (!col) continue
        for (let dy = -8; dy <= 8; dy++) {
          const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz)
          if (d > 14) continue
          let id
          try { id = col.getBlockStateId({ x: (x + dx) & 15, y: y + dy, z: (z + dz) & 15 }) } catch { continue }
          let e = this.emitByState[id]
          if (e === undefined) { e = reg.blocksByStateId[id]?.emitLight || 0; this.emitByState[id] = e }
          if (e - d > best) best = e - d
        }
      }
    }
    return best
  }

  isHostile (name) {
    const e = this.bot.registry.entitiesByName[name]
    return (e && e.category === 'Hostile mobs') || HOSTILE_FALLBACK.has(name)
  }

  /** Snapshot for buildObs. extra = {chat, bossBar, task}. */
  snapshot (extra = {}) {
    const bot = this.bot
    this.cols.clear()
    this.lastCx = this.lastCz = undefined; this.lastCol = null
    const me = bot.entity
    const p = me.position
    const pos = [p.x, p.y, p.z]
    const eye = [p.x, p.y + (me.eyeHeight || 1.62), p.z]
    const entities = []
    const players = []
    for (const e of Object.values(bot.entities)) {
      if (e === me || !e.position) continue
      if (e.type === 'player') {
        if (!e.username || e.username === bot.username) continue
        players.push({
          name: e.username,
          pos: [e.position.x, e.position.y, e.position.z],
          height: e.height || 1.8,
          eye: [e.position.x, e.position.y + (e.eyeHeight || 1.62), e.position.z],
          look: lookVector(e.headYaw ?? e.yaw, e.pitch) // head yaw is where they look; body yaw lags
        })
      } else {
        entities.push({ id: e.id, type: e.name || e.type, pos: [e.position.x, e.position.y, e.position.z], height: e.height || 1, hostile: this.isHostile(e.name) })
      }
    }
    const inventory = {}
    for (const it of bot.inventory.items()) inventory[it.name] = (inventory[it.name] || 0) + it.count
    const armor = [5, 6, 7, 8].map(i => bot.inventory.slots[i]).filter(Boolean).map(i => i.name)
    const effects = Object.values(me.effects || {}).map(ef => {
      const r = bot.registry.effects[ef.id]
      return r ? snake(r.name) : String(ef.id)
    })
    const fx = Math.floor(p.x); const fy = Math.floor(p.y); const fz = Math.floor(p.z)
    const here = this.lightAndBiome(fx, fy, fz)
    return {
      t: Number(bot.time.age) || 0,
      sightRadius: this.sightRadius(),
      self: {
        pos,
        eye,
        yaw: norm180(180 - deg(me.yaw)),
        pitch: -deg(me.pitch),
        dim: bot.game.dimension,
        health: bot.health,
        food: bot.food,
        xp: bot.experience?.level ?? 0,
        on_ground: me.onGround,
        in_water: !!me.isInWater,
        held: bot.heldItem ? bot.heldItem.name : null,
        armor,
        effects,
        gamemode: bot.game.gameMode
      },
      classAt: this.classAt,
      placedAt: this.placedAt || (() => false),
      scanNotable: (e, R, visit) => this.scanNotable(e, R, visit),
      entities,
      players,
      waypoints: this.locator ? this.locator.list() : [],
      inventory,
      world: {
        dayTime: bot.time.timeOfDay ?? 0,
        raining: !!bot.isRaining,
        thundering: bot.thunderState > 0,
        light: here.light,
        biome: here.biome
      },
      bossBar: extra.bossBar ?? null,
      chat: extra.chat ?? [],
      task: extra.task ?? null
    }
  }
}

/**
 * Walk a prismarine-chunk BitArray (no-span layout: each 64-bit long holds
 * floor(64/bits) values, stored as [low 32, high 32] in a Uint32Array) and
 * call emit(i, x) for every index whose value v gives x = lookup(v) != null.
 * Bit for bit the same as BitArray.get(i), without a call per index.
 */
function decode (bits, lookup, emit) {
  const words = bits.data; const b = bits.bitsPerValue; const vpl = bits.valuesPerLong; const mask = bits.valueMask
  const cap = Math.min(bits.capacity, 4096)
  let i = 0
  for (let w = 0; i < cap; w += 2) {
    const lo = words[w]; const hi = words[w + 1]
    for (let k = 0, off = 0; k < vpl && i < cap; k++, i++, off += b) {
      let v
      if (off >= 32) v = (hi >>> (off - 32)) & mask
      else {
        v = lo >>> off
        if (off + b > 32) v |= hi << (32 - off)
        v &= mask
      }
      const x = lookup(v)
      if (x) emit(i, x)
    }
  }
}

function sameArray (a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function clientViewChunks (bot) {
  const v = bot.settings.viewDistance
  if (typeof v === 'number') return v
  return { far: 12, normal: 10, short: 8, tiny: 2 }[v] ?? 10
}

module.exports = { skyDarkness, MineflayerView, lookVector, norm180, decode }
