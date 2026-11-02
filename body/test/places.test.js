'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { FakeWorld, makeView } = require('./fakeWorld')
const { buildObs, recheckKnown } = require('../src/fairplay/observe')
const { KnownPlaces } = require('../src/places')
const { runVerb } = require('../src/verbs')
const { check } = require('../src/schema')

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-places-')), 'known-places.json')

// Ground y<=9, bot at (0.5, 10, 0.5) facing south.
function world () {
  return new FakeWorld().box([-32, 0, -32], [31, 9, 31], 'stone')
    .set(0, 10, 6, 'iron_ore') // in the open: seen
    .set(0, 8, 0, 'diamond_ore') // inside rock, under the bot's feet: never seen
    .box([3, 10, 9], [5, 12, 9], 'stone').set(4, 10, 10, 'gold_ore') // behind a wall
}

/** One body tick: build the fair-play obs, then update known places from it. */
function tick (places, w, opts = {}) {
  const view = makeView(w, opts)
  const { obs } = buildObs(view, {})
  places.applyRecheck(obs.self.dim, obs.t, recheckKnown(view, places.inDim(obs.self.dim)))
  places.recordObs(obs)
  return obs
}

test('only blocks that passed the fair-play filter enter known places', () => {
  const places = new KnownPlaces({ file: null })
  for (let i = 0; i < 3; i++) tick(places, world())
  const types = places.inDim('overworld').map(e => e.type)
  assert.deepEqual(types, ['iron_ore'])
  assert.equal(places.recall('diamond_ore', [0.5, 10, 0.5], 'overworld', 1000), null, 'ore inside rock never gets in')
  assert.equal(places.recall('gold_ore', [0.5, 10, 0.5], 'overworld', 1000), null, 'ore behind a wall never gets in')
  assert.deepEqual(places.recall('iron_ore', [0.5, 10, 0.5], 'overworld', 1600), { type: 'iron_ore', pos: [0, 10, 6], dist: 6, age: 600 })
})

test('known places survive a restart', () => {
  const file = tmpFile()
  const a = new KnownPlaces({ file, saveDelayMs: -1 })
  tick(a, world())
  a.save()
  const b = new KnownPlaces({ file }).load()
  assert.equal(b.size, 1)
  assert.deepEqual(b.recall('iron_ore', [0.5, 10, 0.5], 'overworld', 4000), { type: 'iron_ore', pos: [0, 10, 6], dist: 6, age: 3000 })
  assert.equal(b.recall('iron_ore', [0.5, 10, 0.5], 'the_nether', 4000), null, 'other dimension')
})

test('a seen block stays known when out of sight, and is dropped once seen gone', () => {
  const places = new KnownPlaces({ file: null })
  const w = world()
  tick(places, w)
  // walk behind a wall: the iron is out of sight but still remembered
  w.box([-3, 10, -3], [3, 13, -3], 'stone')
  tick(places, w, { pos: [0.5, 10, -5.5] })
  assert.ok(places.recall('iron_ore', [0, 10, 0], 'overworld', 1000))
  // someone mines it while the bot can't see: still remembered
  w.set(0, 10, 6, 'air')
  tick(places, w, { pos: [0.5, 10, -5.5] })
  assert.ok(places.recall('iron_ore', [0, 10, 0], 'overworld', 1000))
  // back in view, the spot is empty: forgotten
  tick(places, w)
  assert.equal(places.recall('iron_ore', [0, 10, 0], 'overworld', 1000), null)
})

test('a file that cannot be read is moved aside, not fatal', () => {
  const file = tmpFile()
  fs.writeFileSync(file, '{not json')
  const p = new KnownPlaces({ file }).load()
  assert.equal(p.size, 0)
  assert.ok(fs.readdirSync(path.dirname(file)).some(f => f.includes('.bad-')))
})

test('recall verb: nearest known entry, or failed "unknown"', () => {
  const places = new KnownPlaces({ file: null })
  const w = world().set(-6, 10, 14, 'iron_ore')
  tick(places, w)
  const act = { connected: () => true, chat () {}, halt () {}, here: () => ({ pos: [0.5, 10, 0.5], dim: 'overworld', t: 1200 }), places }
  let r = runVerb(act, 'recall', { type: 'iron_ore' })
  assert.equal(r.status, 'done')
  assert.deepEqual(r.data, { type: 'iron_ore', pos: [0, 10, 6], dist: 6, age: 200 })
  assert.equal(check('recallData', r.data), null)
  r = runVerb(act, 'recall', { type: 'iron_ore', near: [-6, 10, 15] })
  assert.deepEqual(r.data.pos, [-6, 10, 14])
  assert.deepEqual(runVerb(act, 'recall', { type: 'diamond_ore' }), { status: 'failed', detail: 'unknown' })
  assert.equal(runVerb(act, 'recall', {}).status, 'failed')
  assert.equal(runVerb(act, 'recall', { type: 'iron_ore', near: [1, 2] }).status, 'failed')
})
