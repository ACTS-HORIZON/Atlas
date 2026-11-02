'use strict'
// Forest scene for obs build cost: dense spruce forest (thousands of logs
// with leaf canopies) over stone with ~1.5% ores and some caves, 9x9 chunks
// of 26.1 terrain, through the real Mineflayer adapter. Prints timing, the
// work counters and a checksum of the observable output (blocks_seen,
// entities, players) so optimisations can be shown not to change what is
// observed. Run: npm run bench:forest   (or: node bench/forest-bench.js --profile)
const crypto = require('crypto')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('26.1')
const Chunk = require('prismarine-chunk')(registry)
const { MineflayerView } = require('../src/view')
const { buildObs, recheckKnown } = require('../src/fairplay/observe')
const { KnownPlaces } = require('../src/places')
const { MotionTracker, SoundMemory } = require('../src/fairplay/perception')

let seed = 7
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const S = n => registry.blocksByName[n].defaultState
const ORES = ['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore']

const cols = new Map()
const v = new Vec3(0, 0, 0)
const col = (x, z) => {
  const k = `${x >> 4},${z >> 4}`
  let c = cols.get(k)
  if (!c) { c = new Chunk({ minY: -64, worldHeight: 384 }); cols.set(k, c) }
  return c
}
const set = (x, y, z, n) => { v.set(x & 15, y, z & 15); col(x, z).setBlockStateId(v, S(n)) }
const get = (x, y, z) => { v.set(x & 15, y, z & 15); return col(x, z).getBlockStateId(v) }
const top = (x, z) => 70 + Math.round(2 * Math.sin(x / 11) + 2 * Math.cos(z / 9))

const t0 = Date.now()
const caves = []
for (let i = 0; i < 700; i++) caves.push([rand() * 160 - 80, rand() * 64 - 8, rand() * 160 - 80, 2 + rand() * 6])
const inCave = (x, y, z) => caves.some(([cx, cy, cz, r]) => (x - cx) ** 2 + (y - cy) ** 2 * 2 + (z - cz) ** 2 < r * r)
for (let x = -80; x < 80; x++) {
  for (let z = -80; z < 80; z++) {
    const h = top(x, z)
    for (let y = -10; y <= h; y++) {
      let n = y === h ? 'podzol' : y > h - 4 ? 'dirt' : 'stone'
      if (n === 'stone' && rand() < 0.015) n = ORES[Math.floor(rand() * ORES.length)]
      if (y < h - 5 && inCave(x, y, z)) n = 'air'
      set(x, y, z, n)
    }
  }
}
// spruce trees on a jittered 3-4 block grid, keeping a clearing at the centre
let trees = 0; let logs = 0
const spruce = new Set([S('spruce_log'), S('spruce_leaves')])
for (let gx = -78; gx < 78; gx += 3 + Math.floor(rand() * 2)) {
  for (let gz = -78; gz < 78; gz += 3 + Math.floor(rand() * 2)) {
    const x = gx + Math.floor(rand() * 2); const z = gz + Math.floor(rand() * 2)
    if (x * x + z * z < 36) continue
    const h = top(x, z); const height = 7 + Math.floor(rand() * 6)
    for (let y = h + 1; y <= h + height; y++) { set(x, y, z, 'spruce_log'); logs++ }
    // conical canopy over the upper part of the trunk, from 3 blocks above the ground
    for (let y = h + 3; y <= h + height + 1; y++) {
      const r = Math.max(0, Math.round((h + height + 1 - y) / 3))
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if ((dx || dz) && Math.abs(dx) + Math.abs(dz) <= r + 1 && !spruce.has(get(x + dx, y, z + dz))) set(x + dx, y, z + dz, 'spruce_leaves')
        }
      }
    }
    set(x, h + height + 1, z, 'spruce_leaves')
    trees++
  }
}
console.log(`forest: ${trees} trees, ${logs} logs, generated in ${((Date.now() - t0) / 1000).toFixed(1)} s`)

function botAt (p, yaw) {
  const position = new Vec3(p[0], p[1], p[2])
  const entities = {}
  for (let i = 0; i < 20; i++) {
    const ex = Math.floor(rand() * 100 - 50); const ez = Math.floor(rand() * 100 - 50)
    entities[i + 1] = { id: i + 1, type: 'mob', name: i % 4 ? 'wolf' : 'zombie', height: 1.9, position: new Vec3(ex + 0.5, top(ex, ez) + 1, ez + 0.5) }
  }
  entities[100] = { id: 100, type: 'player', username: 'ACTS_HORIZON', height: 1.8, eyeHeight: 1.62, yaw: 1, pitch: -0.3, position: new Vec3(p[0] + 4, p[1], p[2] + 3) }
  const self = { position, eyeHeight: 1.62, yaw, pitch: 0, onGround: true, effects: {} }
  entities[0] = self
  return {
    world: { getColumn: (x, z) => cols.get(`${x},${z}`) },
    registry,
    username: 'Atlas',
    game: { minY: -64, height: 384, serverViewDistance: 10, dimension: 'overworld', gameMode: 'survival' },
    settings: { viewDistance: 5 },
    entity: self,
    entities,
    inventory: { items: () => [], slots: [] },
    time: { age: 1000, timeOfDay: 6000 },
    health: 20,
    food: 20,
    experience: { level: 0 },
    heldItem: null,
    blockAt: () => null
  }
}

const scenes = [
  ['forest floor, clearing', [0.5, top(0, 0) + 1, 0.5], 0],
  ['forest floor, facing east', [0.5, top(0, 0) + 1, 0.5], -Math.PI / 2],
  ['above the canopy', [0.5, top(0, 0) + 18, 0.5], 0]
]

const N = Number(process.env.BENCH_N || 40)
const all = []
for (const [label, pos, yaw] of scenes) {
  const view = new MineflayerView(botAt(pos, yaw), { sightRadius: 64 })
  const state = { motion: new MotionTracker(), sounds: new SoundMemory() }
  const places = new KnownPlaces({ file: null, saveDelayMs: -1 })
  const ms = []; const obsMs = []; let last
  for (let i = 0; i < N; i++) {
    const vw = view.snapshot()
    last = buildObs(vw, state, { now: 1000 })
    const p0 = performance.now()
    places.applyRecheck('overworld', i, recheckKnown(vw, places.inDim('overworld')))
    places.recordObs(last.obs)
    obsMs.push(last.stats.ms)
    ms.push(last.stats.ms + performance.now() - p0)
  }
  const warm = ms.slice(5).sort((a, b) => a - b)
  const warmObs = obsMs.slice(5).sort((a, b) => a - b)
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length
  const o = last.obs
  const sum = crypto.createHash('sha1').update(JSON.stringify([o.blocks_seen, o.entities, o.players])).digest('hex').slice(0, 12)
  all.push(sum)
  console.log(`${label.padEnd(26)} first ${obsMs[0].toFixed(1)} ms | obs+places mean ${mean(warm).toFixed(1)} ms, p95 ${warm[Math.floor(warm.length * 0.95)].toFixed(1)} | obs only mean ${mean(warmObs).toFixed(1)} ms` +
    ` | ${last.stats.candidates} candidates, ${last.stats.raycasts} rays | ${o.blocks_seen.length} blocks, ${o.entities.length} mobs, ${o.players.length} players | output ${sum}`)
}
console.log(`output checksum: ${crypto.createHash('sha1').update(all.join()).digest('hex').slice(0, 12)}`)
