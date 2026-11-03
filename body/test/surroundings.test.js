'use strict'
// obs.surroundings on fake worlds (shaft, cliff edge, flat ground, cave,
// tunnel), and the Mineflayer view's light and biome.
const test = require('node:test')
const assert = require('node:assert/strict')
const { FakeWorld, makeView } = require('./fakeWorld')
const { buildObs } = require('../src/fairplay/observe')
const { check } = require('../src/schema')
const { MineflayerView, skyDarkness } = require('../src/view')
const { fakeBot } = require('./fakeBot')

function surr (w, pos, light = 15) {
  const v = makeView(w, { pos })
  v.world = { ...v.world, light }
  const { obs } = buildObs(v, {})
  assert.equal(check('obs', obs), null)
  return obs.surroundings
}

const tokens = s => Math.ceil(JSON.stringify(s).length / 4)

test('surroundings: a 1-wide shaft, stone all sides, open above', () => {
  const w = new FakeWorld({ fill: 'air' }).box([-8, 0, -8], [8, 20, 8], 'stone')
  w.box([0, 16, 0], [0, 20, 0], 'air') // shaft from the surface (y 21) down to y 16
  const s = surr(w, [0.5, 16, 0.5])
  assert.equal(s.summary, 'in a 1-wide shaft 5 deep, stone all sides, open above')
  assert.deepEqual([s.feet, s.head, s.below, s.above], ['air', 'air', 'stone', 'air'])
  assert.deepEqual(s.sides.north, ['stone 1', 'stone 1'])
  assert.equal(s.sky, true)
  assert.equal(s.roof, null)
  assert.equal(s.light, 15)
  assert.ok(tokens(s) <= 120, `${tokens(s)} tokens`)
})

test('surroundings: boxed in, and a capped shaft', () => {
  const w = new FakeWorld({ fill: 'stone' }).box([0, 10, 0], [0, 11, 0], 'air')
  assert.equal(surr(w, [0.5, 10, 0.5]).summary, 'boxed in: stone all sides and above')
  w.box([0, 12, 0], [0, 13, 0], 'air').set(1, 10, 0, 'dirt')
  assert.equal(surr(w, [0.5, 10, 0.5]).summary, 'in a 1-wide shaft 4 deep, stone/dirt walls, roof 3 above')
})

test('surroundings: on a cliff edge, the drop and its direction', () => {
  const w = new FakeWorld({ fill: 'air' }).box([-10, 0, -10], [10, 3, 10], 'stone')
  w.box([-10, 4, -10], [10, 9, 0], 'stone') // a plateau (top at y 9) for z <= 0; the ground below is y 3
  const s = surr(w, [0.5, 10, 0.5])
  assert.equal(s.drops.south, 6)
  assert.equal(s.drops.north, 0)
  assert.equal(s.summary, 'on open ground, at the edge of a drop of 6 to the south')
  w.box([-10, 4, 1], [10, 6, 1], 'stone').box([-10, 4, 2], [10, 5, 10], 'stone') // terrace it: 3 down, then lower
  assert.equal(surr(w, [0.5, 10, 0.5]).summary, 'on a slope, drop of 3 to the south')
})

test('surroundings: flat ground, open all round', () => {
  const w = new FakeWorld({ fill: 'air' }).box([-30, 0, -30], [30, 9, 30], 'grass_block')
  const s = surr(w, [0.5, 10, 0.5], 12)
  assert.equal(s.summary, 'on open flat ground')
  assert.deepEqual(s.sides.east, [null, null])
  assert.deepEqual(Object.values(s.drops), [0, 0, 0, 0])
  assert.equal(s.light, 12)
  w.set(0, 10, -1, 'stone')
  assert.equal(surr(w, [0.5, 10, 0.5]).summary, 'on a slope, rising to the north', 'one block up at the feet is a step')
})

test('surroundings: a cave, roof above, wall and lava in sight', () => {
  const w = new FakeWorld({ fill: 'stone' }).box([-6, 10, -6], [6, 14, 6], 'air') // a 13x5x13 room
  w.set(3, 10, 0, 'lava')
  const s = surr(w, [0.5, 10, 0.5])
  assert.equal(s.sky, false)
  assert.equal(s.roof, 4)
  assert.deepEqual(s.sides.east, ['lava 3', 'stone 7'])
  assert.deepEqual(s.sides.west, ['stone 7', 'stone 7'])
  assert.equal(s.summary, 'underground in an open space, roof 4 above; lava 3 to the east')
})

test('surroundings: a tunnel, and walls not in sight are not reported', () => {
  const w = new FakeWorld({ fill: 'stone' }).box([0, 10, -5], [0, 11, 5], 'air')
  assert.equal(surr(w, [0.5, 10, 0.5]).summary, 'in a 1-wide tunnel running north-south, stone all sides')
  // a long corridor bends: the far wall beyond the bend is not seen
  const v = new FakeWorld({ fill: 'stone' }).box([0, 10, 0], [0, 11, 3], 'air').box([1, 10, 3], [4, 11, 3], 'air')
  const s = surr(v, [0.5, 10, 0.5])
  assert.deepEqual(s.sides.south, ['stone 4', 'stone 4'])
})

test('view: light from the sky follows the time of day; biome is named', () => {
  const bot = fakeBot() // stone up to y 63, standing at (0.5, 64, 0.5), no light data in the chunks
  bot.time.timeOfDay = 6000
  let w = new MineflayerView(bot, { sightRadius: 64 }).snapshot().world
  assert.equal(w.light, 15, 'noon under open sky, even with no light data')
  assert.equal(typeof w.biome, 'string')
  assert.ok(w.biome.length > 0)
  bot.time.timeOfDay = 18000
  assert.equal(new MineflayerView(bot, { sightRadius: 64 }).snapshot().world.light, 4, 'night: sky light 4')
  bot.world.set(0, 70, 0, 'stone') // a roof
  bot.world.set(2, 64, 1, 'torch') // 3 blocks away (taxicab)
  bot.time.timeOfDay = 6000
  assert.equal(new MineflayerView(bot, { sightRadius: 64 }).snapshot().world.light, 11, 'under a roof: the torch, 14 - 3')
  assert.deepEqual([skyDarkness(0), skyDarkness(18000), skyDarkness(6000, true), skyDarkness(12900)], [0, 11, 3, 6])
})
