'use strict'
// A dense voxel grid implementing the view interface used by buildObs, so the
// fair-play rules are testable without a Minecraft server.
const { classify } = require('../src/fairplay/blocks')

class FakeWorld {
  /** Grid covers [x0, x0+sx) x [y0, y0+sy) x [z0, z0+sz); outside = unloaded. */
  constructor ({ x0 = -32, y0 = 0, z0 = -32, sx = 64, sy = 64, sz = 64, fill = 'air' } = {}) {
    Object.assign(this, { x0, y0, z0, sx, sy, sz })
    this.names = []
    this.ids = new Map()
    this.cls = []
    this.grid = new Uint16Array(sx * sy * sz).fill(this.id(fill))
  }

  id (name) {
    let i = this.ids.get(name)
    if (i === undefined) {
      i = this.names.length
      this.names.push(name); this.ids.set(name, i); this.cls.push(classify(name))
    }
    return i
  }

  idx (x, y, z) {
    const lx = x - this.x0; const ly = y - this.y0; const lz = z - this.z0
    if (lx < 0 || ly < 0 || lz < 0 || lx >= this.sx || ly >= this.sy || lz >= this.sz) return -1
    return (ly * this.sz + lz) * this.sx + lx
  }

  set (x, y, z, name) { const i = this.idx(x, y, z); if (i >= 0) this.grid[i] = this.id(name); return this }
  get (x, y, z) { const i = this.idx(x, y, z); return i < 0 ? null : this.names[this.grid[i]] }

  box (a, b, name) {
    for (let x = Math.min(a[0], b[0]); x <= Math.max(a[0], b[0]); x++) {
      for (let y = Math.min(a[1], b[1]); y <= Math.max(a[1], b[1]); y++) {
        for (let z = Math.min(a[2], b[2]); z <= Math.max(a[2], b[2]); z++) this.set(x, y, z, name)
      }
    }
    return this
  }

  classAt (x, y, z) { const i = this.idx(x, y, z); return i < 0 ? null : this.cls[this.grid[i]] }

  scanNotable (eye, R, visit) {
    const notable = this.cls.map(c => c.notable)
    const xa = Math.max(this.x0, Math.floor(eye[0] - R)); const xb = Math.min(this.x0 + this.sx - 1, Math.ceil(eye[0] + R))
    const ya = Math.max(this.y0, Math.floor(eye[1] - R)); const yb = Math.min(this.y0 + this.sy - 1, Math.ceil(eye[1] + R))
    const za = Math.max(this.z0, Math.floor(eye[2] - R)); const zb = Math.min(this.z0 + this.sz - 1, Math.ceil(eye[2] + R))
    for (let y = ya; y <= yb; y++) {
      for (let z = za; z <= zb; z++) {
        for (let x = xa; x <= xb; x++) {
          const c = this.grid[this.idx(x, y, z)]
          if (notable[c]) visit(x, y, z, this.cls[c])
        }
      }
    }
  }
}

/** Direction vector from F3 yaw/pitch degrees (pitch + = down). */
function lookVec (yaw, pitch) {
  const y = yaw * Math.PI / 180; const p = pitch * Math.PI / 180
  return [-Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)]
}

function makeView (world, { pos = [0.5, 10, 0.5], yaw = 0, pitch = 0, sightRadius = 32, entities = [], players = [], ...rest } = {}) {
  const self = {
    pos,
    eye: [pos[0], pos[1] + 1.62, pos[2]],
    yaw,
    pitch,
    dim: 'overworld',
    health: 20,
    food: 20,
    xp: 0,
    on_ground: true,
    in_water: false,
    held: null,
    armor: [],
    effects: [],
    gamemode: 'survival'
  }
  return {
    t: 1000,
    sightRadius,
    self,
    classAt: (x, y, z) => world.classAt(x, y, z),
    scanNotable: (eye, R, visit) => world.scanNotable(eye, R, visit),
    entities,
    players: players.map(p => ({ height: 1.8, ...p, eye: p.eye || [p.pos[0], p.pos[1] + 1.62, p.pos[2]] })),
    inventory: {},
    world: { dayTime: 6000, raining: false, thundering: false, light: 15, biome: 'plains' },
    bossBar: null,
    chat: [],
    task: null,
    ...rest
  }
}

module.exports = { FakeWorld, makeView, lookVec }
