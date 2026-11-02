'use strict'
// A stand-in for a Mineflayer bot backed by real 26.1 prismarine-chunk
// columns: enough for MineflayerView.snapshot() and the Body's listeners.
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('26.1')
const Chunk = require('prismarine-chunk')(registry)

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

/** fakeBot() plus the event emitter and the few methods Body calls. */
function fakeLiveBot () {
  const bot = Object.assign(new EventEmitter(), fakeBot())
  bot.said = []
  bot.halts = 0
  bot.chat = text => { bot.said.push(text) }
  bot.clearControlStates = () => { bot.halts++ }
  bot.quit = () => {}
  bot.end = () => {}
  bot.version = '26.1'
  return bot
}

module.exports = { fakeBot, fakeLiveBot }
