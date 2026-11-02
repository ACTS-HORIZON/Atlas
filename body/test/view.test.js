'use strict'
// The Mineflayer adapter against real prismarine-chunk 26.1 columns (no server):
// checks the fast section indexing and palette skipping used by the scan.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { MineflayerView } = require('../src/view')
const { buildObs } = require('../src/fairplay/observe')
const { check } = require('../src/schema')
const { fakeBot } = require('./fakeBot')

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

test('sight radius: config value, clamped to the server and client render distance', () => {
  const bot = fakeBot()
  const at = (cfg, server, client) => {
    bot.game.serverViewDistance = server; bot.settings.viewDistance = client
    return new MineflayerView(bot, { sightRadius: cfg }).sightRadius()
  }
  assert.equal(at(64, 10, 5), 64, 'config is the limit')
  assert.equal(at(200, 10, 5), 80, 'bot render distance 5 chunks')
  assert.equal(at(200, 3, 12), 48, 'server view-distance 3 chunks')
  assert.equal(at(32, 3, 12), 32)
})
