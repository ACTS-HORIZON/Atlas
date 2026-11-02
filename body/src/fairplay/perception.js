'use strict'
// Small pure helpers: bearings, distance buckets, motion and sound memory.

const SECTORS = ['front', 'front-right', 'right', 'behind-right', 'behind', 'behind-left', 'left', 'front-left']

/**
 * Bearing of offset `rel` ([dx,dy,dz], world axes) relative to a facing yaw in
 * Minecraft F3 degrees (0 = south/+Z, 90 = west/-X). 8 sectors; straight
 * above/below when the horizontal offset is under one block.
 */
function bearing (yawDeg, rel) {
  const h = Math.hypot(rel[0], rel[2])
  if (h < 1) return rel[1] >= 0 ? 'above' : 'below'
  const yaw = yawDeg * Math.PI / 180
  const fx = -Math.sin(yaw); const fz = Math.cos(yaw) // forward
  const rx = -fz; const rz = fx // right-hand side
  const fwd = rel[0] * fx + rel[2] * fz
  const right = rel[0] * rx + rel[2] * rz
  const a = Math.atan2(right, fwd) * 180 / Math.PI // 0 front, +90 right
  const i = ((Math.round(a / 45) % 8) + 8) % 8
  return SECTORS[i]
}

function distBucket (d) {
  if (d <= 8) return 'near'
  if (d <= 24) return 'mid'
  return 'far'
}

/** Distance history per entity, sampled by the body a few times a second. */
class MotionTracker {
  constructor ({ windowMs = 3000 } = {}) { this.windowMs = windowMs; this.h = new Map() }
  sample (id, dist, now) {
    let a = this.h.get(id)
    if (!a) { a = []; this.h.set(id, a) }
    a.push([now, dist])
    while (a.length && now - a[0][0] > this.windowMs) a.shift()
  }
  /** Closer by > 0.5 blocks than ~0.7-2.5 s ago. */
  approaching (id, dist, now) {
    const a = this.h.get(id)
    if (!a) return false
    for (const [t, d] of a) {
      const age = now - t
      if (age <= 2500 && age >= 700) return d - dist > 0.5
    }
    return false
  }
  prune (now) {
    for (const [id, a] of this.h) if (!a.length || now - a[a.length - 1][0] > this.windowMs) this.h.delete(id)
  }
}

// Short names for a few sounds a player would describe differently.
const SOUND_ALIASES = {
  'entity.creeper.primed': 'creeper_hiss',
  'entity.tnt.primed': 'tnt_fuse',
  'entity.generic.explode': 'explosion'
}

/** "minecraft:entity.zombie.ambient" -> "zombie_ambient" */
function soundType (name) {
  const n = String(name).replace(/^minecraft:/, '')
  if (SOUND_ALIASES[n]) return SOUND_ALIASES[n]
  return n.replace(/^(entity|block|item|ambient|event)\./, '').replace(/\./g, '_')
}

/**
 * Recent sounds. Exact positions are kept internally only to compute a
 * bearing at observation time; they never leave this class.
 */
class SoundMemory {
  constructor ({ windowMs = 3000, max = 10 } = {}) { this.windowMs = windowMs; this.max = max; this.items = [] }
  add (name, pos, now) {
    if (/^(music|music_disc)\./.test(String(name).replace(/^minecraft:/, ''))) return
    this.items.push({ type: soundType(name), pos: [pos[0], pos[1], pos[2]], t: now })
    if (this.items.length > 200) this.items.splice(0, this.items.length - 200)
  }
  /** Reduce to [{type, bearing, dist}] relative to the listener. */
  reduce (selfPos, yawDeg, now) {
    this.items = this.items.filter(s => now - s.t <= this.windowMs)
    const seen = new Map()
    for (let i = this.items.length - 1; i >= 0; i--) { // newest first
      const s = this.items[i]
      const rel = [s.pos[0] - selfPos[0], s.pos[1] - selfPos[1], s.pos[2] - selfPos[2]]
      const d = Math.hypot(rel[0], rel[1], rel[2])
      if (d < 1.5 && /_step$/.test(s.type)) continue // own footsteps
      const out = { type: s.type, bearing: bearing(yawDeg, rel), dist: distBucket(d) }
      const k = out.type + '|' + out.bearing + '|' + out.dist
      if (!seen.has(k)) seen.set(k, out)
      if (seen.size >= this.max) break
    }
    return [...seen.values()]
  }
}

/** Day time ticks (0..23999) -> dawn/day/dusk/night. */
function timeOfDay (ticks) {
  const t = ((ticks % 24000) + 24000) % 24000
  if (t >= 23000 || t < 1000) return 'dawn'
  if (t < 11500) return 'day'
  if (t < 13500) return 'dusk'
  return 'night'
}

module.exports = { bearing, distBucket, MotionTracker, SoundMemory, soundType, timeOfDay }
