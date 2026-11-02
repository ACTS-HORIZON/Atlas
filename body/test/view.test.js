'use strict'
// The Mineflayer adapter against real prismarine-chunk 26.1 columns (no server):
// checks the fast section indexing and palette skipping used by the scan.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('26.1')
const Chunk = require('prismarine-chunk')(registry)
const { MineflayerView } = require('../src/view')
const { buildObs } = require('../src/fairplay/observe')
const { check } = require('../src/schema')

function fakeBot () {
  const cols = new Map()
  const S = n => registry.blocksByName[n].defaultState
  const world = {
    getColumn: (x, z) => cols.get(`${x},${z}`),
    set (x, y, z, name) {
      const k = `${x >> 4},${z >> 4}`
      if (!cols.has(k)) cols.set(k, new Chunk({ minY: -64, worldHeight: 384 }))
      cols.get(k).setBlockStateId(new Vec3(x & 15, y, z & 15), S(name))
    },
    roundTrip () {
      for (const [k, c] of cols) {
        const n = new Chunk({ minY: -64, worldHeight: 384 })
        n.load(c.dump())
        cols.set(k, n)
      }
    }
  }
  // two loaded columns around the origin, stone up to y=63
  for (const [cx, cz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = -64; y < 64; y++) world.set(cx * 16 + x, y, cz * 16 + z, 'stone')
  }
  const position = new Vec3(0.5, 64, 0.5)
  position.floored = () => new Vec3(0, 64, 0)
  return {
    world,
    registry,
    username: 'Atlas',
    game: { minY: -64, height: 384, serverViewDistance: 10, dimension: 'overworld', gameMode: 'survival' },
    settings: { viewDistance: 5 },
    entity: { position, eyeHeight: 1.62, yaw: 0, pitch: 0, onGround: true, effects: {} },
    entities: {},
    inventory: { items: () => [{ name: 'cobblestone', count: 41 }, { name: 'cobblestone', count: 3 }], slots: [] },
    time: { age: 1234, timeOfDay: 13000 },
    health: 20,
    food: 20,
    experience: { level: 2 },
    heldItem: null,
    blockAt: () => null
  }
}

test('MineflayerView reads chunk sections correctly and filters like the fake world', () => {
  const bot = fakeBot()
  bot.world.set(3, 64, -5, 'iron_ore') // standing on the surface, north of the bot
  bot.world.set(-7, 63, 2, 'diamond_ore') // surface block (top face exposed)
  bot.world.set(2, 40, 2, 'diamond_ore') // deep inside stone
  bot.world.set(-12, 20, -12, 'gold_ore') // buried, 49 blocks away
  bot.world.set(-12, -60, -12, 'gold_ore') // beyond the 64-block sight radius
  bot.world.roundTrip() // as received from the network: dump() -> load()
  const view = new MineflayerView(bot, { sightRadius: 64 })
  assert.equal(view.classAt(3, 64, -5).name, 'iron_ore')
  assert.equal(view.classAt(0, 64, 0).name, 'air')
  assert.equal(view.classAt(0, -10, 0).name, 'stone')
  assert.equal(view.classAt(100, 64, 100), null, 'unloaded')
  const found = [...view.scanNotable([0.5, 65.62, 0.5], 64)].map(c => c.cls.name + '@' + c.pos.join(','))
  assert.deepEqual(found.sort(), ['diamond_ore@-7,63,2', 'diamond_ore@2,40,2', 'gold_ore@-12,20,-12', 'iron_ore@3,64,-5'])

  bot.world.set(3, 65, 0, 'stone') // a block at head height between the bot and a player
  bot.world.roundTrip()
  const ppos = new Vec3(6.5, 64, 0.5)
  bot.entities[7] = { id: 7, type: 'player', username: 'ACTS_HORIZON', position: ppos, height: 1.8, eyeHeight: 1.62, yaw: 0, headYaw: Math.PI / 2, pitch: 0 }
  bot.entities[8] = { id: 8, type: 'mob', name: 'zombie', position: new Vec3(0.5, 64, -4.5), height: 1.95, health: 20 }
  const v = view.snapshot()
  assert.equal(v.self.yaw, 180, 'mineflayer yaw 0 (north) is F3 180')
  assert.equal(v.sightRadius, 64, '5-chunk client view distance -> 80, capped to 64')
  const { obs } = buildObs(v, {})
  assert.deepEqual(obs.blocks_seen.map(b => b.type + '@' + b.pos.join(',')).sort(), ['diamond_ore@-7,63,2', 'iron_ore@3,64,-5'])
  // mineflayer head yaw pi/2 = looking west (-X), straight at the stone block
  assert.deepEqual(obs.players, [{ name: 'ACTS_HORIZON', pos: [6.5, 64, 0.5], dist: 6, looking_at: [3, 65, 0] }])
  // bot faces north (mineflayer yaw 0): the zombie at -Z is in front
  assert.deepEqual(obs.entities, [{ type: 'zombie', rel: [0, 0, -5], dist: 5, bearing: 'front', approaching: false, hostile: true }])
  assert.deepEqual(obs.inventory, { cobblestone: 44 })
  assert.equal(obs.world.time, 'dusk')
  assert.equal(check('obs', obs), null)
})
