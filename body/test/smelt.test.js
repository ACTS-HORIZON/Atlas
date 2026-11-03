'use strict'
// smelt: the verb (furnace choice, fuel, shortages, house rules) over the fake
// world and fake motor, and the motor's furnace handling over a fake furnace
// window that smelts one item per poll.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('26.1')
const { Motor } = require('../src/motor')
const { HouseRules } = require('../src/house')
const { world, setup, run } = require('./verbHarness')
const { bestFuel, fuelValue, furnacesFor, inputsFor } = require('../src/smelting')

/** Flat stone world with a furnace in view at (2, 10, 3). */
function withFurnace (type = 'furnace') { return world().set(2, 10, 3, type) }

test('smelt: loads input and just enough of the best fuel, reports n/N smelted', async () => {
  const s = setup(withFurnace(), { inv: { raw_iron: 8, coal: 3, oak_planks: 10, oak_log: 5 } })
  const r = await run('smelt', s.act, { item: 'iron_ingot', count: 8 })
  assert.equal(r.status, 'done')
  assert.equal(r.detail, 'smelted 8 iron_ingot in the furnace at [2, 10, 3]')
  assert.deepEqual(r.data, { item: 'iron_ingot', input: 'raw_iron', smelted: 8, requested: 8, fuel: 'coal', fuel_used: 1, furnace: [2, 10, 3] })
  const call = s.motor.calls.find(c => c[0] === 'smelt')
  assert.deepEqual(call[1], [2, 10, 3])
  assert.deepEqual([call[2].input, call[2].output, call[2].count, call[2].fuel, call[2].fuelCount], ['raw_iron', 'iron_ingot', 8, 'coal', 1])
  assert.equal(s.motor.calls.find(c => c[0] === 'goto')[1].kind, 'look', 'walked to the furnace first')
  assert.ok(s.progress.includes('3/8 smelted') && s.progress.includes('8/8 smelted'), s.progress.join(' | '))
})

test('smelt: the item can be the input; the fuel arg wins; planks before logs', async () => {
  let s = setup(withFurnace(), { inv: { raw_iron: 3, coal: 2, oak_planks: 4 } })
  let r = await run('smelt', s.act, { item: 'raw_iron', count: 3, fuel: 'oak_planks' })
  assert.equal(r.status, 'done')
  assert.deepEqual([r.data.item, r.data.fuel, r.data.fuel_used], ['iron_ingot', 'oak_planks', 2])
  s = setup(withFurnace(), { inv: { cobblestone: 4, oak_planks: 2, oak_log: 9 } })
  r = await run('smelt', s.act, { item: 'stone', count: 3 })
  assert.deepEqual([r.data.input, r.data.fuel, r.data.fuel_used], ['cobblestone', 'oak_planks', 2])
  assert.equal(bestFuel({ oak_log: 3, birch_planks: 1 }, 'raw_iron'), 'birch_planks')
  assert.equal(bestFuel({ oak_log: 3 }, 'oak_log'), null, 'never the input')
})

test('smelt: partial on an input or fuel shortage, naming it', async () => {
  let s = setup(withFurnace(), { inv: { raw_iron: 3, coal: 1 } })
  let r = await run('smelt', s.act, { item: 'iron_ingot', count: 8 })
  assert.equal(r.status, 'partial')
  assert.equal(r.detail, 'smelted 3 of 8 iron_ingot; only 3 raw_iron in inventory')

  s = setup(withFurnace(), { inv: { raw_iron: 8, oak_planks: 2 } })
  r = await run('smelt', s.act, { item: 'iron_ingot', count: 8 })
  assert.equal(r.status, 'partial')
  assert.equal(r.detail, 'smelted 3 of 8 iron_ingot; not enough fuel: 2 oak_planks smelts 3; 4 more oak_planks needed')
  assert.equal(s.motor.calls.find(c => c[0] === 'smelt')[2].count, 3, 'only what the fuel covers goes in')

  s = setup(withFurnace(), { inv: { raw_iron: 8, coal: 1 }, smelt: () => ({ ok: true, smelted: 5, reason: 'the furnace stopped: nothing came out for 25 s' }) })
  r = await run('smelt', s.act, { item: 'iron_ingot', count: 8 })
  assert.equal(r.detail, 'smelted 5 of 8 iron_ingot; the furnace stopped: nothing came out for 25 s')
})

test('smelt: failures before moving, and the furnace kinds', async () => {
  const s = setup(world(), { inv: { raw_iron: 2, coal: 1 } })
  assert.equal((await run('smelt', s.act, { item: 'iron_ingot', count: 2 })).detail,
    'smelt: needs a furnace or blast_furnace (none seen or known within 32 blocks)')
  const t = setup(withFurnace(), { inv: { raw_iron: 2 } })
  assert.equal((await run('smelt', t.act, { item: 'iron_ingot' })).detail, 'smelt: no fuel in inventory (coal, charcoal, planks or logs)')
  const u = setup(withFurnace(), { inv: { coal: 2 } })
  assert.match((await run('smelt', u.act, { item: 'iron_ingot' })).detail, /^smelt: nothing to smelt into iron_ingot: no raw_iron, iron_ore/)
  assert.equal((await run('smelt', u.act, { item: 'iron_pickaxe' })).detail, 'smelt: iron_pickaxe is not made in a furnace')
  const w = setup(withFurnace(), { inv: { raw_iron: 2, coal: 1, dirt: 5 } })
  assert.equal((await run('smelt', w.act, { item: 'iron_ingot', fuel: 'dirt' })).detail, 'smelt: dirt is not a fuel')
  assert.equal((await run('smelt', w.act, { item: 'iron_ingot', fuel: 'charcoal' })).detail, 'smelt: no charcoal in inventory')
  assert.equal(w.motor.calls.filter(c => c[0] === 'goto' || c[0] === 'smelt').length, 0)
  assert.equal(u.motor.calls.filter(c => c[0] === 'goto' || c[0] === 'smelt').length, 0, 'no walking for any of these')
  // food goes to a smoker, ores to a blast furnace, never the other way
  const v = setup(withFurnace('smoker'), { inv: { raw_iron: 2, coal: 1 } })
  assert.match((await run('smelt', v.act, { item: 'iron_ingot' })).detail, /needs a furnace or blast_furnace/)
  const b = setup(withFurnace('blast_furnace'), { inv: { raw_gold: 2, coal: 1 } })
  assert.equal((await run('smelt', b.act, { item: 'gold_ingot', count: 2 })).status, 'done')
  assert.deepEqual(furnacesFor('beef'), ['furnace', 'smoker'])
  assert.deepEqual(furnacesFor('sand'), ['furnace'])
  assert.ok(inputsFor('iron_ingot').includes('deepslate_iron_ore'))
  assert.equal(fuelValue('coal'), 8)
  assert.equal(fuelValue('oak_log'), 1.5)
})

test('smelt: refused when the only furnace is inside a protected region', async () => {
  const house = new HouseRules([{ name: 'spawn', dim: null, min: [0, 0, 0], max: [5, 20, 5] }])
  const s = setup(withFurnace(), { inv: { raw_iron: 2, coal: 1 }, house })
  const r = await run('smelt', s.act, { item: 'iron_ingot', count: 2 })
  assert.equal(r.status, 'refused')
  assert.equal(r.detail, 'house rules: no furnace use inside protected region "spawn" ([2, 10, 3])')
  assert.equal(s.motor.calls.filter(c => c[0] === 'goto').length, 0)
})

// ---- the motor against a fake furnace window ---------------------------------

/** A furnace window: smelts one input per poll while there is fuel (8 per coal). */
function fakeFurnace ({ input = null, fuel = null, output = null, outputMax = 64 } = {}) {
  const slot = (name, count) => (name && count ? { name, count } : null)
  const f = {
    inputs: input, fuels: fuel, outputs: output, burn: 0, closed: false, log: [],
    inputItem () { return f.inputs && slot(f.inputs.name, f.inputs.count) },
    fuelItem () { return f.fuels && slot(f.fuels.name, f.fuels.count) },
    outputItem () {
      // one tick of smelting per look at the output
      if (f.inputs?.count && (f.burn > 0 || f.fuels?.count) && (!f.outputs || f.outputs.count < outputMax)) {
        if (f.burn <= 0) { f.fuels.count--; f.burn += f.fuels.name === 'coal' ? 8 : 1.5 }
        f.burn--; f.inputs.count--
        f.outputs = { name: f.result, count: (f.outputs?.count || 0) + 1 }
      }
      return f.outputs && slot(f.outputs.name, f.outputs.count)
    },
    async putFuel (id, meta, n) { f.log.push(['fuel', registry.items[id].name, n]); f.fuels = { name: registry.items[id].name, count: (f.fuels?.count || 0) + n } },
    async putInput (id, meta, n) { f.log.push(['input', registry.items[id].name, n]); f.inputs = { name: registry.items[id].name, count: (f.inputs?.count || 0) + n } },
    async takeOutput () { const o = f.outputs; f.outputs = null; f.log.push(['takeOutput', o.count]); return o },
    async takeInput () { f.log.push(['takeInput', f.inputs.count]); f.inputs = null },
    async takeFuel () { f.log.push(['takeFuel', f.fuels.count]); f.fuels = null },
    close () { f.closed = true }
  }
  return f
}

function furnaceBot (f) {
  return {
    registry,
    on () {},
    blockAt: p => ({ name: 'furnace', position: p }),
    openFurnace: async () => f,
    inventory: { items: () => [] }
  }
}

test('motor.smelt: loads, collects as it goes, takes back leftovers, closes', async () => {
  const f = fakeFurnace(); f.result = 'iron_ingot'
  const seen = []
  const r = await new Motor(furnaceBot(f)).smelt([2, 10, 3], { input: 'raw_iron', output: 'iron_ingot', count: 3, fuel: 'coal', fuelCount: 1, pollMs: 1, onProgress: n => seen.push(n) })
  assert.deepEqual(r, { ok: true, smelted: 3, reason: null })
  assert.deepEqual(f.log.slice(0, 2), [['fuel', 'coal', 1], ['input', 'raw_iron', 3]])
  assert.deepEqual(seen, [1, 2, 3])
  assert.ok(f.closed)
})

test('motor.smelt: fuel runs out: partial count, the input left is taken back', async () => {
  const f = fakeFurnace(); f.result = 'iron_ingot'
  const r = await new Motor(furnaceBot(f)).smelt([2, 10, 3], { input: 'raw_iron', output: 'iron_ingot', count: 4, fuel: 'oak_planks', fuelCount: 1, pollMs: 1, stallMs: 30 })
  assert.equal(r.smelted, 2, '1 plank smelts 1.5 items: 2 come out before it stops')
  assert.match(r.reason, /^the furnace stopped: nothing came out for 0 s$/)
  assert.deepEqual(f.log.at(-1), ['takeInput', 2])
})

test('motor.smelt: a furnace holding someone else\'s items is left alone', async () => {
  const f = fakeFurnace({ input: { name: 'beef', count: 3 } }); f.result = 'cooked_beef'
  const r = await new Motor(furnaceBot(f)).smelt([2, 10, 3], { input: 'raw_iron', output: 'iron_ingot', count: 2, fuel: 'coal', fuelCount: 1, pollMs: 1 })
  assert.deepEqual(r, { ok: false, smelted: 0, reason: 'the furnace is in use: its input slot holds 3 beef' })
  assert.deepEqual(f.log, [], 'nothing put in or taken')
  assert.ok(f.closed)
})

test('motor.smelt: stop mid-way takes the output and the rest back', async () => {
  const f = fakeFurnace(); f.result = 'iron_ingot'
  const ac = new AbortController()
  const r = await new Motor(furnaceBot(f)).smelt([2, 10, 3], { input: 'raw_iron', output: 'iron_ingot', count: 8, fuel: 'coal', fuelCount: 2, pollMs: 1, signal: ac.signal, onProgress: n => n === 2 && ac.abort() })
  assert.ok(r.smelted >= 2 && r.smelted < 8)
  assert.ok(f.log.some(e => e[0] === 'takeInput'))
  assert.ok(f.log.some(e => e[0] === 'takeFuel'))
  void Vec3
})
