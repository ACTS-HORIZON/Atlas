'use strict'
// Item vs block: the loot-table map (minecraft-data 26.1) and the reasons
// mine / collect / dig give when the mind asks for an item.
const test = require('node:test')
const assert = require('node:assert/strict')
const registry = require('prismarine-registry')('26.1')
const { dropsOf, sourcesOf, mineHint, collectHint } = require('../src/drops')
const { world, setup, run } = require('./verbHarness')

test('the map comes from the loot tables (normal mining, no silk touch)', () => {
  assert.deepEqual(dropsOf(registry, 'stone'), ['cobblestone'])
  assert.deepEqual(dropsOf(registry, 'coal_ore'), ['coal'])
  assert.deepEqual(dropsOf(registry, 'iron_ore'), ['raw_iron'])
  assert.deepEqual(dropsOf(registry, 'oak_log'), ['oak_log'])
  assert.deepEqual(dropsOf(registry, 'grass_block'), ['dirt'])
  assert.deepEqual(dropsOf(registry, 'gravel').sort(), ['flint', 'gravel'])
  assert.equal(sourcesOf(registry, 'cobblestone')[0], 'stone')
  assert.equal(sourcesOf(registry, 'raw_iron')[0], 'iron_ore', 'the plain ore before its deepslate variant')
  assert.ok(sourcesOf(registry, 'raw_iron').includes('deepslate_iron_ore'))
  assert.equal(sourcesOf(registry, 'dirt')[0], 'grass_block')
  assert.equal(sourcesOf(registry, 'coal')[0], 'coal_ore')
  assert.deepEqual(sourcesOf(registry, 'iron_ingot'), [], 'smelted, not dropped')
})

test('hints', () => {
  assert.equal(mineHint(registry, 'raw_iron'), 'raw_iron is an item, not a block; it drops from iron_ore or deepslate_iron_ore. Use mine iron_ore')
  assert.equal(mineHint(registry, 'cobblestone'), 'cobblestone the item drops from stone (also cobblestone drops from cobblestone blocks). Use mine stone')
  assert.equal(mineHint(registry, 'cobblestone', { inView: true }), null, 'cobblestone blocks in view: fine to mine')
  assert.equal(mineHint(registry, 'iron_ingot'), 'iron_ingot is an item, not a block, and no block drops it (it is crafted, smelted or found)')
  assert.equal(mineHint(registry, 'stone'), null)
  assert.equal(mineHint(registry, 'oak_log'), null)
  assert.equal(collectHint(registry, 'iron_ore'), 'mining iron_ore drops raw_iron, not iron_ore; collect raw_iron')
  assert.equal(collectHint(registry, 'oak_log'), null)
})

test('mine / collect / dig give the reason, so the mind stops looking for cobblestone', async () => {
  // flat stone ground, nothing else: no cobblestone blocks anywhere
  let s = setup(world())
  let r = await run('mine', s.act, { block: 'cobblestone', count: 3 })
  assert.deepEqual(r, { status: 'failed', detail: 'mine: no cobblestone in view within 24 blocks; cobblestone the item drops from stone (also cobblestone drops from cobblestone blocks). Use mine stone' })
  assert.equal(s.motor.calls.length, 0, 'no walking, no exploring')
  r = await run('mine', s.act, { block: 'raw_iron', count: 3 })
  assert.deepEqual(r, { status: 'failed', detail: 'mine: raw_iron is an item, not a block; it drops from iron_ore or deepslate_iron_ore. Use mine iron_ore' })
  r = await run('mine', s.act, { block: 'coal' })
  assert.match(r.detail, /^mine: coal is an item, not a block; it drops from coal_ore/)
  assert.deepEqual(await run('mine', s.act, { block: 'not_a_thing' }), { status: 'failed', detail: 'mine: unknown block not_a_thing' })

  // cobblestone blocks in view are a fine target
  s = setup(world().set(2, 10, 5, 'cobblestone'))
  r = await run('mine', s.act, { block: 'cobblestone', count: 1 })
  assert.equal(r.status, 'done')

  s = setup(world(), { drops: [] })
  r = await run('collect', s.act, { item: 'iron_ore' })
  assert.equal(r.detail, 'no iron_ore drops in sight (mining iron_ore drops raw_iron, not iron_ore; collect raw_iron)')

  s = setup(world())
  r = await run('dig', s.act, { pos: [0, 9, 2] }) // visible stone, with a pickaxe
  assert.equal(r.detail, 'dug stone at [0, 9, 2] (drops cobblestone)')
  assert.deepEqual(r.data.drops, ['cobblestone'])
})
