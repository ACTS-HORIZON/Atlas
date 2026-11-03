'use strict'
// Locator Bar waypoints (CONTRACT.md, Fair play: players out of line of
// sight are reported by bearing only, exactly when the game's Locator Bar
// would show them).
//
// Source: the 26.1 `tracked_waypoint` play packet, as parsed by
// minecraft-protocol (Mineflayer 4.39 has no handler of its own, so this
// listens on bot._client). The server decides who is on the bar: a player
// it hides (sneaking, invisible, out of range…) gets no waypoint, or an
// untrack, so this never shows anyone the game doesn't.
//
//   {operation: 'track'|'untrack'|'update',
//    waypoint: {hasUUID, uuid | id, icon: {style, color?},
//               type: 'empty'|'vec3i'|'chunk'|'azimuth',
//               data: {x,y,z} | {chunkX, chunkZ} | <float radians> | undefined}}
//
// Only waypoints whose UUID belongs to a player in the tab list are used.
// What leaves this file is a bearing (azimuth) and, when the bar would show
// one, an up/down indicator; positions never do.
//
// Up/down: the client draws an arrow above or below a waypoint's dot when
// the waypoint is outside the screen vertically. Only a 'vec3i' waypoint
// (the server sends a block position when the player is close) carries a
// height; 'chunk' and 'azimuth' waypoints have none, so the bar shows no
// arrow for them and this reports none. For vec3i: the elevation from the
// bot's eye to the block, relative to the camera pitch, beyond half the
// vertical field of view (70° by default) -> 'above' / 'below', else
// 'level'. (minecraft.wiki was unreachable when this was written; the rule
// follows the packet's data and the client's on-screen test.)
//
// Azimuth convention: Locator.list() returns F3 degrees, the yaw at which
// the bot would face the player (0 = south, 90 = west). For 'azimuth'
// waypoints the server sends that yaw in radians (it computes
// atan2(dx, -dz) of receiver minus source; the client compares it with the
// camera yaw). For 'vec3i' and 'chunk' waypoints it is computed here from
// the block or the chunk centre.

const RAD = 180 / Math.PI
const norm180 = d => { d = ((d % 360) + 360) % 360; return d > 180 ? d - 360 : d }
/** F3 yaw (degrees) facing from (bx, bz) towards (tx, tz). */
const yawTowards = (bx, bz, tx, tz) => norm180(Math.atan2(-(tx - bx), tz - bz) * RAD)

class Locator {
  constructor ({ fov = 70 } = {}) {
    this.fov = fov
    this.available = true
    this.points = new Map() // waypoint id (uuid) -> {type, data}
    this.bot = null
  }

  /** Listen to a (new) bot's connection. Clears what an old one knew. */
  attach (bot) {
    this.points.clear()
    this.bot = bot
    const client = bot && bot._client
    if (!client || typeof client.on !== 'function') return
    client.on('tracked_waypoint', p => this.onPacket(p))
    // dimension change or respawn: the server tracks afresh; an 'update' for
    // an unknown waypoint is treated as a track, so nothing is lost
    if (typeof bot.on === 'function') bot.on('respawn', () => this.points.clear())
  }

  onPacket (p) {
    const w = p && p.waypoint
    if (!w || !w.hasUUID || typeof w.uuid !== 'string') return // non-entity waypoints: not players
    const id = w.uuid.toLowerCase()
    if (p.operation === 'untrack') this.points.delete(id)
    else if (p.operation === 'track' || p.operation === 'update') this.points.set(id, { type: w.type, data: w.data })
  }

  /** Tab-list name for a UUID, or null (not a player, or left). */
  nameOf (uuid) {
    const players = this.bot && this.bot.players
    if (!players) return null
    for (const p of Object.values(players)) {
      if (p && typeof p.uuid === 'string' && p.uuid.toLowerCase() === uuid) return p.username
    }
    return null
  }

  azimuthFor (pt) {
    const me = this.bot && this.bot.entity && this.bot.entity.position
    if (pt.type === 'azimuth') return typeof pt.data === 'number' && Number.isFinite(pt.data) ? norm180(pt.data * RAD) : null
    if (!me) return null
    if (pt.type === 'vec3i' && pt.data) return yawTowards(me.x, me.z, pt.data.x + 0.5, pt.data.z + 0.5)
    if (pt.type === 'chunk' && pt.data) return yawTowards(me.x, me.z, pt.data.chunkX * 16 + 8, pt.data.chunkZ * 16 + 8)
    return null // 'empty': on the bar, no direction
  }

  /** 'above' | 'below' | 'level' for a waypoint with a height (vec3i), else null (the bar shows no arrow). */
  verticalFor (pt) {
    const e = this.bot && this.bot.entity
    if (pt.type !== 'vec3i' || !pt.data || !e || !e.position) return null
    const me = e.position
    const dy = pt.data.y + 0.5 - (me.y + (e.eyeHeight || 1.62))
    const dh = Math.hypot(pt.data.x + 0.5 - me.x, pt.data.z + 0.5 - me.z)
    const elev = Math.atan2(dy, dh) * RAD
    const pitch = (e.pitch || 0) * RAD // Mineflayer: + looks up
    const rel = elev - pitch
    if (rel > this.fov / 2) return 'above'
    if (rel < -this.fov / 2) return 'below'
    return 'level'
  }

  /** [{name, azimuth, vertical?}] for players on the bar (never the bot itself). */
  list () {
    const out = []
    for (const [uuid, pt] of this.points) {
      const name = this.nameOf(uuid)
      if (!name || name === (this.bot && this.bot.username)) continue
      const azimuth = this.azimuthFor(pt)
      if (azimuth === null) continue
      const vertical = this.verticalFor(pt)
      out.push({ name, azimuth: Math.round(azimuth * 10) / 10, ...(vertical ? { vertical } : {}) })
    }
    return out
  }

  azimuthOf (name) {
    const w = this.list().find(x => x.name === name)
    return w ? w.azimuth : null
  }

  verticalOf (name) {
    const w = this.list().find(x => x.name === name)
    return (w && w.vertical) || null
  }
}

/** A fixed set of waypoints, for tests: [{name, azimuth}]. */
class StaticLocator {
  constructor (waypoints = []) { this.available = true; this.waypoints = waypoints }
  list () { return this.waypoints.map(w => ({ ...w })) }
  azimuthOf (name) { const w = this.waypoints.find(x => x.name === name); return w ? w.azimuth : null }
  verticalOf (name) { const w = this.waypoints.find(x => x.name === name); return (w && w.vertical) || null }
}

module.exports = { Locator, StaticLocator, yawTowards }
