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

const deg = r => r * 180 / Math.PI
const norm180 = d => { d = ((d % 360) + 360) % 360; return d > 180 ? d - 360 : d }
/** Mineflayer yaw/pitch (radians, yaw 0 = north, pitch + = up) -> unit look vector. */
const lookVector = (yaw, pitch) => [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]
const snake = s => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/\s+/g, '_').toLowerCase()
const AIR_CLASS = classify('air')

class MineflayerView {
  constructor (bot, { sightRadius }) {
    this.bot = bot
    this.maxSight = sightRadius
    this.byState = [] // stateId -> classify() result, filled lazily
    this.cols = new Map()
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
    const k = cx * 1048576 + cz
    let col = this.cols.get(k)
    if (col === undefined) {
      col = this.bot.world.getColumn(cx, cz) || null
      this.cols.set(k, col)
    }
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

  /** Notable blocks within R of eye. Skips sections whose palette has none. */
  * scanNotable (eye, R) {
    const minY = this.bot.game.minY
    const cx0 = Math.floor((eye[0] - R) / 16); const cx1 = Math.floor((eye[0] + R) / 16)
    const cz0 = Math.floor((eye[2] - R) / 16); const cz1 = Math.floor((eye[2] + R) / 16)
    const R2 = R * R
    const axisGap = (v, lo) => v < lo ? lo - v : v > lo + 16 ? v - lo - 16 : 0
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const gx = axisGap(eye[0], cx * 16); const gz = axisGap(eye[2], cz * 16)
        if (gx * gx + gz * gz > R2) continue
        const col = this.column(cx, cz)
        if (!col) continue
        for (let sy = 0; sy < col.sections.length; sy++) {
          const sec = col.sections[sy]
          if (!sec) continue
          const by = minY + sy * 16
          const gy = axisGap(eye[1], by)
          if (gx * gx + gy * gy + gz * gz > R2) continue
          const data = sec.data
          const bx = cx * 16; const bz = cz * 16
          if (data.palette && data.data) { // indirect palette: test palette indices, not state ids
            const pal = data.palette
            const hit = new Array(pal.length)
            let any = false
            for (let j = 0; j < pal.length; j++) { hit[j] = this.stateClass(pal[j]).notable; any ||= hit[j] }
            if (!any) continue
            const bits = data.data
            for (let i = 0; i < 4096; i++) {
              const j = bits.get(i)
              if (hit[j]) yield { pos: [bx + (i & 15), by + (i >> 8), bz + ((i >> 4) & 15)], cls: this.stateClass(pal[j]) }
            }
            continue
          }
          if (data.value !== undefined && !data.palette) { // single-value section
            if (!this.stateClass(data.value).notable) continue
          }
          for (let i = 0; i < 4096; i++) { // single-value or direct (global) palette
            const c = this.stateClass(data.get(i))
            if (c.notable) yield { pos: [bx + (i & 15), by + (i >> 8), bz + ((i >> 4) & 15)], cls: c }
          }
        }
      }
    }
  }

  sightRadius () {
    const chunks = Math.min(this.bot.game.serverViewDistance || 32, clientViewChunks(this.bot))
    return Math.min(this.maxSight, chunks * 16)
  }

  isHostile (name) {
    const e = this.bot.registry.entitiesByName[name]
    return (e && e.category === 'Hostile mobs') || HOSTILE_FALLBACK.has(name)
  }

  /** Snapshot for buildObs. extra = {chat, bossBar, task}. */
  snapshot (extra = {}) {
    const bot = this.bot
    this.cols.clear()
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
    const feet = bot.blockAt(p.floored())
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
      scanNotable: (e, R) => this.scanNotable(e, R),
      entities,
      players,
      inventory,
      world: {
        dayTime: bot.time.timeOfDay ?? 0,
        raining: !!bot.isRaining,
        thundering: bot.thunderState > 0,
        light: feet ? Math.max(feet.light ?? 0, feet.skyLight ?? 0) : null,
        biome: feet && feet.biome ? feet.biome.name ?? null : null
      },
      bossBar: extra.bossBar ?? null,
      chat: extra.chat ?? [],
      task: extra.task ?? null
    }
  }
}

function clientViewChunks (bot) {
  const v = bot.settings.viewDistance
  if (typeof v === 'number') return v
  return { far: 12, normal: 10, short: 8, tiny: 2 }[v] ?? 10
}

module.exports = { MineflayerView, lookVector, norm180 }
