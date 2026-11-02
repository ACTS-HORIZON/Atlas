'use strict'
// Measures a full fair-play obs build through the real Mineflayer adapter on
// synthetic 26.1 chunks (no server): 9x9 loaded chunks of stone with caves,
// ~1.5% ores, a lake, 30 mobs and 2 players, plus known-places upkeep
// (recheck of 2000 remembered blocks). Run: npm run bench
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('26.1')
const Chunk = require('prismarine-chunk')(registry)
const { MineflayerView } = require('../src/view')
const { buildObs, recheckKnown } = require('../src/fairplay/observe')
const { KnownPlaces } = require('../src/places')
const { MotionTracker, SoundMemory } = require('../src/fairplay/perception')

let seed = 42
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const S = n => registry.blocksByName[n].defaultState
const ORES = ['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'diamond_ore', 'lapis_ore']
const SURFACE = 64

console.log('generating 81 chunks...')
const cols = new Map()
const caves = []
for (let i = 0; i < 120; i++) caves.push([rand() * 144 - 72, rand() * 70 - 10, rand() * 144 - 72, 3 + rand() * 6])
const inCave = (x, y, z) => caves.some(([cx, cy, cz, r]) => (x - cx) ** 2 + (y - cy) ** 2 * 2 + (z - cz) ** 2 < r * r)
for (let cx = -5; cx <= 4; cx++) {
  for (let cz = -5; cz <= 4; cz++) {
    const ch = new Chunk({ minY: -64, worldHeight: 384 })
    const v = new Vec3(0, 0, 0)
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        const wx = cx * 16 + x; const wz = cz * 16 + z
        const top = SURFACE - 1 + Math.round(3 * Math.sin(wx / 9) + 2 * Math.cos(wz / 7))
        for (let y = -20; y <= top; y++) {
          v.set(x, y, z)
          let n = y === top ? 'grass_block' : y > top - 3 ? 'dirt' : 'stone'
          if (n === 'stone' && rand() < 0.015) n = ORES[Math.floor(rand() * ORES.length)]
          if (y < top - 4 && inCave(wx, y, wz)) n = 'air'
          if (wx > 20 && wx < 34 && wz > -10 && wz < 6 && y > top - 4) n = y > top - 1 ? 'water' : n === 'air' ? 'water' : 'water'
          ch.setBlockStateId(v, S(n))
        }
        if ((wx * 7 + wz * 13) % 97 === 0) for (let y = top + 1; y < top + 6; y++) { v.set(x, y, z); ch.setBlockStateId(v, S('oak_log')) }
      }
    }
    cols.set(`${cx},${cz}`, ch)
  }
}

function botAt (p, yaw) {
  const position = new Vec3(p[0], p[1], p[2])
  const entities = {}
  for (let i = 0; i < 30; i++) {
    entities[i + 1] = { id: i + 1, type: 'mob', name: i % 3 ? 'zombie' : 'cow', height: 1.9, position: new Vec3(p[0] + rand() * 80 - 40, p[1] + rand() * 10 - 5, p[2] + rand() * 80 - 40) }
  }
  for (const [i, name] of ['ACTS_HORIZON', 'Friend'].entries()) {
    entities[100 + i] = { id: 100 + i, type: 'player', username: name, height: 1.8, eyeHeight: 1.62, yaw: rand() * 6, pitch: -0.3, position: new Vec3(p[0] + 5 + i * 10, p[1], p[2] + 6) }
  }
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

// Known places shared across scenarios, pre-filled with 2000 remembered blocks
// scattered around (as after a long session), so the recheck has work to do.
const places = new KnownPlaces({ file: null, saveDelayMs: -1 })
places.recordObs({ t: 0, self: { dim: 'overworld' }, blocks_seen: Array.from({ length: 2000 }, () => ({ type: 'iron_ore', pos: [Math.floor(rand() * 140 - 70), Math.floor(rand() * 80 - 10), Math.floor(rand() * 140 - 70)] })) })

function run (label, bot, n = 30) {
  const view = new MineflayerView(bot, { sightRadius: 64 })
  const state = { motion: new MotionTracker(), sounds: new SoundMemory() }
  const ms = []; let last
  for (let i = 0; i < n; i++) {
    const v = view.snapshot()
    last = buildObs(v, state)
    // known-places upkeep, as the body does after every build
    const t0 = performance.now()
    places.applyRecheck('overworld', i, recheckKnown(v, places.inDim('overworld')))
    places.recordObs(last.obs)
    ms.push(last.stats.ms + performance.now() - t0)
  }
  const warm = ms.slice(3).sort((a, b) => a - b)
  const mean = warm.reduce((a, b) => a + b, 0) / warm.length
  const o = last.obs
  console.log(`${label.padEnd(26)} first ${ms[0].toFixed(1)} ms | warm mean ${mean.toFixed(1)} ms, p95 ${warm[Math.floor(warm.length * 0.95)].toFixed(1)} ms, max ${warm[warm.length - 1].toFixed(1)} ms` +
    ` | ${places.size} known places | ${last.stats.candidates} candidates, ${last.stats.raycasts} rays -> ${o.blocks_seen.length} blocks, ${o.entities.length}/30 mobs, ${o.players.length}/2 players`)
}

// find a cave to stand in
let cave = null
for (const [cx, cy, cz, r] of caves) if (r > 6 && Math.abs(cx) < 30 && Math.abs(cz) < 30 && cy < 40) { cave = [cx, Math.floor(cy - r / 2) + 1, cz]; break }
run('surface (y=70, radius 64)', botAt([0.5, 70, 0.5], 0))
if (cave) run(`cave (${cave.map(Math.round).join(',')})`, botAt(cave, 1))
run('surface, looking at lake', botAt([16.5, 68, 0.5], -Math.PI / 2))

