'use strict'
// give / deposit / withdraw without a server: the real filtered API over a
// fake world, a fake motor, and the real chest allowlist.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { world, setup, run } = require('./verbHarness')
const { StaticLocator } = require('../src/locator')
const { ChestAllowlist, parseChests } = require('../src/chests')

const collin = { name: 'ACTS_HORIZON', pos: [-4.5, 10, 3.5], look: [0, 0, 1] }

test('give: walk to a visible player, toss at their feet; done / partial / failed / refused', async () => {
  let s = setup(world(), { players: [collin], inv: { spruce_log: 12 } })
  let r = await run('give', s.act, { item: 'spruce_log', count: 8, player: 'ACTS_HORIZON' })
  assert.deepEqual(r, { status: 'done', detail: 'gave 8 spruce_log to ACTS_HORIZON', data: { item: 'spruce_log', given: 8 } })
  assert.deepEqual(s.motor.calls.map(c => c[0]), ['goto', 'toss'])
  assert.deepEqual([s.motor.calls[0][1].pos, s.motor.calls[0][1].range], [[-4.5, 10, 3.5], 2])
  assert.deepEqual(s.motor.calls[1], ['toss', 'spruce_log', 8, [-4.5, 10, 3.5]], 'aimed at their feet')

  s = setup(world(), { players: [collin], inv: { spruce_log: 5 } })
  r = await run('give', s.act, { item: 'spruce_log', count: 8, player: 'ACTS_HORIZON' })
  assert.deepEqual([r.status, r.detail, r.data], ['partial', 'gave 5 of 8 spruce_log to ACTS_HORIZON; only had 5', { item: 'spruce_log', given: 5 }])

  s = setup(world(), { players: [collin], inv: {} })
  assert.deepEqual(await run('give', s.act, { item: 'spruce_log', count: 8, player: 'ACTS_HORIZON' }), { status: 'failed', detail: 'give: no spruce_log in inventory' })
  assert.equal(s.motor.calls.length, 0, 'checked before walking')

  s = setup(world(), { players: [], inv: { spruce_log: 8 } })
  r = await run('give', s.act, { item: 'spruce_log', count: 8, player: 'ACTS_HORIZON' })
  assert.equal(r.status, 'refused')
  assert.match(r.detail, /fair play: ACTS_HORIZON has not been observed/)

  s = setup(world(), { players: [collin], inv: { spruce_log: 8 }, goto: () => ({ status: 'stuck', remaining: 9, moved: 4 }) })
  r = await run('give', s.act, { item: 'spruce_log', count: 8, player: 'ACTS_HORIZON' })
  assert.equal(r.status, 'failed')
  assert.match(r.detail, /^give: could not reach ACTS_HORIZON: gave up 9 blocks short/)
  assert.ok(!s.motor.calls.some(c => c[0] === 'toss'))
})

test('give: a player out of sight on the Locator Bar is followed, then given to', async () => {
  const s = setup(world(), {
    locator: new StaticLocator([{ name: 'ACTS_HORIZON', azimuth: -90 }]),
    walk: true,
    inv: { spruce_log: 8 },
    players: m => (m.pos[0] > 10 ? [{ name: 'ACTS_HORIZON', pos: [18.5, 10, 0.5], look: [0, 0, 1] }] : [])
  })
  const r = await run('give', s.act, { item: 'spruce_log', count: 8, player: 'ACTS_HORIZON' })
  assert.equal(r.status, 'done')
  assert.deepEqual(s.motor.calls.at(-1), ['toss', 'spruce_log', 8, [18.5, 10, 0.5]])
})

test('deposit: an observed chest, always allowed; partial when it fills up', async () => {
  const w = world().set(3, 10, 4, 'chest').set(5, 10, 4, 'furnace')
  let s = setup(w, { inv: { cobblestone: 20 } })
  let r = await run('deposit', s.act, { item: 'cobblestone', count: 16, chest: [3, 10, 4] })
  assert.deepEqual(r, { status: 'done', detail: 'put 16 cobblestone in the chest at [3, 10, 4]', data: { item: 'cobblestone', deposited: 16 } })
  assert.deepEqual(s.motor.calls.map(c => c[0]), ['goto', 'deposit'])
  r = await run('deposit', s.act, { item: 'cobblestone', chest: [3, 10, 4] })
  assert.equal(r.detail, 'put 4 cobblestone in the chest at [3, 10, 4]', 'count defaults to all of it')

  s = setup(w, { inv: { cobblestone: 20 }, chestRoom: 6 })
  r = await run('deposit', s.act, { item: 'cobblestone', count: 20, chest: [3, 10, 4] })
  assert.deepEqual([r.status, r.detail], ['partial', 'put 6 of 20 cobblestone in the chest at [3, 10, 4]; the chest is full'])

  s = setup(w, { inv: { cobblestone: 20 } })
  r = await run('deposit', s.act, { item: 'cobblestone', chest: [3, 6, 4] }) // buried: never seen
  assert.deepEqual([r.status, r.detail], ['refused', 'fair play: no chest has been observed at [3, 6, 4]'])
  r = await run('deposit', s.act, { item: 'cobblestone', chest: [5, 10, 4] })
  assert.deepEqual([r.status, r.detail], ['failed', 'deposit: [5, 10, 4] is furnace, not a chest or barrel'])
  assert.deepEqual(await run('deposit', s.act, { item: 'diamond', chest: [3, 10, 4] }), { status: 'failed', detail: 'deposit: no diamond in inventory' })
})

test('withdraw: only from chests given to the bot (house rules)', async () => {
  const w = world().set(3, 10, 4, 'chest').set(-3, 10, 4, 'barrel')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-chests-'))
  const file = path.join(dir, 'chests.json')
  const chests = new ChestAllowlist({ fromConfig: parseChests('[[-3, 10, 4]]'), file })
  let s = setup(w, { chests, chestItems: { iron_ingot: 3 } })
  let r = await run('withdraw', s.act, { item: 'iron_ingot', count: 2, chest: [3, 10, 4] })
  assert.equal(r.status, 'refused')
  assert.match(r.detail, /^house rules: the chest at \[3, 10, 4\] has not been given to Atlas/)
  assert.equal(s.motor.calls.length, 0)

  r = await run('withdraw', s.act, { item: 'iron_ingot', count: 2, chest: [-3, 10, 4] }) // from ATLAS_CHESTS
  assert.deepEqual(r, { status: 'done', detail: 'took 2 iron_ingot from the barrel at [-3, 10, 4]', data: { item: 'iron_ingot', withdrawn: 2 } })

  chests.add('overworld', [3, 10, 4], 'ACTS_HORIZON') // as from chat
  s = setup(w, { chests: new ChestAllowlist({ file }), chestItems: { iron_ingot: 3 } }) // reloaded from disk
  r = await run('withdraw', s.act, { item: 'iron_ingot', count: 8, chest: [3, 10, 4] })
  assert.deepEqual([r.status, r.detail, r.data], ['partial', 'took 3 of 8 iron_ingot from the chest at [3, 10, 4]; the chest had only 3', { item: 'iron_ingot', withdrawn: 3 }])
  r = await run('withdraw', s.act, { item: 'gold_ingot', chest: [3, 10, 4] })
  assert.deepEqual([r.status, r.detail], ['failed', 'withdraw: no gold_ingot in the chest'])
  assert.throws(() => parseChests('[[1,2]]'), /must be \[x, y, z\]/)
})
