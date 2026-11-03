'use strict'
// Session 3 body features without a server: house rules (protected regions),
// goto dig/scaffold and target-by-bearing, bearing-only players in the obs,
// and the craft / place / equip / dig / eat verbs.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('26.1')
const { Recipe } = require('prismarine-recipe')(registry)
const { world, setup, run, FakeWorld } = require('./verbHarness')
const { makeView } = require('./fakeWorld')
const { HouseRules, parseRegions } = require('../src/house')
const { StaticLocator, Locator } = require('../src/locator')
const { Motor } = require('../src/motor')
const { buildObs } = require('../src/fairplay/observe')
const { check } = require('../src/schema')
const { describeMissing } = require('../src/verbs/craft')

const spawn = new HouseRules(parseRegions('[{"name":"spawn","from":[-3,0,4],"to":[3,20,8]}]'))

// ---- house rules ------------------------------------------------------------

test('protected regions: parsing and checks', () => {
  assert.deepEqual(parseRegions(''), [])
  assert.throws(() => parseRegions('{"from":[0,0,0]}'), /must be a JSON list/)
  assert.throws(() => parseRegions('[{"from":[0,0]}]'), /needs "from" and "to"/)
  assert.throws(() => parseRegions('nope'), /not valid JSON/)
  const h = new HouseRules(parseRegions('[{"name":"base","dim":"minecraft:the_nether","from":[10,0,10],"to":[0,5,0]}]'))
  assert.equal(h.check('dig', [5, 3, 5], 'the_nether'), 'house rules: no dig inside protected region "base" ([5, 3, 5])')
  assert.equal(h.check('dig', [5, 3, 5], 'overworld'), null, 'other dimension')
  assert.equal(h.check('place', [11, 3, 5], 'the_nether'), null)
})

test('protected regions: verbs refuse, the motor guard rejects, the pathfinder excludes', async () => {
  const w = world()
  w.set(0, 10, 6, 'iron_ore') // inside the protected box
  w.set(2, 10, 2, 'cobblestone') // a place target next to the box... outside it
  const { act, motor, api } = setup(w, { house: spawn, inv: { cobblestone: 5 } })
  let r = await run('dig', act, { pos: [0, 10, 6] })
  assert.deepEqual([r.status, r.detail], ['refused', 'house rules: no dig inside protected region "spawn" ([0, 10, 6])'])
  r = await run('place', act, { block: 'cobblestone', pos: [1, 10, 4] })
  assert.equal(r.status, 'refused')
  assert.match(r.detail, /house rules: no place/)
  r = await run('mine', act, { block: 'iron_ore', count: 1 })
  assert.equal(r.status, 'refused', 'the only iron is protected: left alone')
  assert.match(r.detail, /^house rules: no dig inside protected region "spawn" .*; no other iron_ore in view$/)
  assert.equal(motor.calls.filter(c => c[0] === 'dig' || c[0] === 'place').length, 0)
  assert.equal((await api.digAhead('south', 0, {})).refused, undefined, 'outside the box: allowed') // (0,10,1)

  // the guard around bot.dig / bot.placeBlock, whoever calls them
  const calls = []
  const bot = {
    registry,
    game: { dimension: 'overworld' },
    inventory: { items: () => [] },
    dig: async b => calls.push(['dig', b.position.toArray()]),
    placeBlock: async (ref, face) => calls.push(['place', ref.position.plus(face).toArray()])
  }
  const m = new Motor(bot, { house: spawn })
  await assert.rejects(bot.dig({ position: new Vec3(0, 10, 6) }), /house rules: no dig/)
  await assert.rejects(bot.placeBlock({ position: new Vec3(0, 9, 5) }, new Vec3(0, 1, 0)), /house rules: no place/)
  await bot.dig({ position: new Vec3(0, 10, 20) })
  assert.deepEqual(calls, [['dig', [0, 10, 20]]])
  // pathfinder movements: breaking inside costs >= 100 (never broken), placing is never worth it
  const mv = m.movements({ dig: true, scaffold: true })
  assert.equal(mv.canDig, true)
  assert.equal(mv.allow1by1towers, true)
  assert.ok(mv.scafoldingBlocks.length >= 2)
  assert.equal(mv.exclusionBreak({ position: new Vec3(0, 10, 6) }), 100)
  assert.equal(mv.exclusionBreak({ position: new Vec3(0, 10, 9) }), 0)
  assert.ok(mv.exclusionPlace({ position: new Vec3(0, 10, 6) }) >= 1e9)
  const off = m.movements({ dig: false, scaffold: false })
  assert.deepEqual([off.canDig, off.allow1by1towers, off.scafoldingBlocks.length], [false, false, 0])
})

// ---- goto ------------------------------------------------------------------

test('goto: dig and scaffold default to true and can be turned off', async () => {
  const { act, motor } = setup(world())
  await run('goto', act, { pos: [10, 10, 10] })
  assert.deepEqual([motor.calls[0][1].dig, motor.calls[0][1].scaffold], [true, true])
  await run('goto', act, { pos: [10, 10, 10], dig: false, scaffold: false })
  assert.deepEqual([motor.calls[1][1].dig, motor.calls[1][1].scaffold], [false, false])
  assert.equal((await run('goto', act, { pos: [1, 2, 3], dig: 'yes' })).status, 'failed')
})

test('goto a player by Locator Bar bearing: legs along the bearing, then to them once in sight', async () => {
  // ACTS_HORIZON is far to the east (azimuth -90 = east in F3 terms), out of sight
  const locator = new StaticLocator([{ name: 'ACTS_HORIZON', azimuth: -90 }])
  let legs = 0
  const s = setup(world(), {
    locator,
    walk: true,
    players: m => (m.pos[0] > 20 ? [{ name: 'ACTS_HORIZON', pos: [28.5, 10, 0.5], look: [0, 0, 1] }] : []),
    goto: (o) => { if (o.kind === 'xz') legs++; return { status: 'reached', remaining: 0, moved: 16 } }
  })
  const r = await run('goto', s.act, { target: 'ACTS_HORIZON' })
  assert.equal(r.status, 'done')
  assert.equal(r.detail, 'arrived at player ACTS_HORIZON')
  assert.equal(legs, 2, 'two 16-block legs east, then the player was in sight')
  const xz = s.motor.calls.filter(c => c[1].kind === 'xz').map(c => c[1].pos.map(v => Math.round(v)))
  assert.deepEqual(xz.map(p => [p[0], p[2]]), [[17, 1], [33, 1]])
  assert.ok(s.progress.some(p => /following ACTS_HORIZON's bearing \(-90°\)/.test(p)))

  // the bar stops showing them (they sneak): partial, lost the bearing
  const lose = new StaticLocator([{ name: 'Sneaky', azimuth: 0 }])
  const t = setup(world(), { locator: lose, walk: true, goto: () => { lose.waypoints = []; return { status: 'reached', remaining: 0, moved: 16 } } })
  const p = await run('goto', t.act, { target: 'Sneaky' })
  assert.equal(p.status, 'partial')
  assert.match(p.detail, /lost Sneaky's bearing after 16 blocks/)
  // without a Locator Bar source (as with Mineflayer today) an unseen player is refused
  const u = setup(world(), { locator: new Locator() })
  assert.equal((await run('goto', u.act, { target: 'ACTS_HORIZON' })).status, 'refused')
})

test('obs: players out of sight appear by bearing only, and only when the Locator Bar shows them', () => {
  const w = world().box([4, 10, -6], [6, 15, 6], 'stone') // wall to the east
  const view = makeView(w, {
    players: [{ name: 'Visible', pos: [-4.5, 10, 3.5], look: [0, 0, 1] }, { name: 'Behind', pos: [9.5, 10, 0.5], look: [0, 0, 1] }],
    waypoints: [{ name: 'Behind', azimuth: -90 }, { name: 'Visible', azimuth: 90 }, { name: 'FarAway', azimuth: 180 }]
  })
  const { obs } = buildObs(view, {})
  assert.deepEqual(obs.players.map(p => Object.keys(p).sort().join(',')), ['dist,looking_at,name,pos', 'bearing,name', 'bearing,name'])
  assert.deepEqual(obs.players.slice(1), [{ name: 'Behind', bearing: 'left' }, { name: 'FarAway', bearing: 'behind' }])
  assert.equal(check('obs', obs), null)
  // no waypoint, no entry: a hidden player without a Locator Bar waypoint is not reported at all
  const { obs: o2 } = buildObs(makeView(w, { players: [{ name: 'Behind', pos: [9.5, 10, 0.5], look: [0, 0, 1] }] }), {})
  assert.deepEqual(o2.players, [])
  assert.deepEqual(new Locator().list(), [], 'Mineflayer source: unavailable, reports nothing')
})

// ---- craft -------------------------------------------------------------------

/** A Motor over a fake bot with a real 26.1 recipe book and a given inventory. */
function craftMotor (inv) {
  const items = () => Object.entries(inv).map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id }))
  const bot = {
    registry,
    game: { gameMode: 'survival', dimension: 'overworld' },
    inventory: { items },
    recipesAll: (id, meta, table) => Recipe.find(id, meta).filter(r => !r.requiresTable || table)
  }
  return new Motor(bot)
}

test('craft plans against the real 26.1 recipes: precise "missing" reasons', () => {
  let m = craftMotor({})
  assert.equal(describeMissing(m.craftPlan('stick', 4).options), '2 planks (any kind)')
  assert.equal(describeMissing(m.craftPlan('oak_planks', 8).options), '2 oak_log')
  assert.equal(describeMissing(m.craftPlan('stone_pickaxe', 1).options), '3 of cobbled_deepslate, blackstone or cobblestone, 2 stick')
  m = craftMotor({ oak_planks: 1 })
  assert.equal(describeMissing(m.craftPlan('crafting_table', 1).options), '4 planks (any kind)', 'never one variant when any works')
  m = craftMotor({ spruce_log: 3 })
  const hint = names => { for (const v of names) { const o = m.craftPlan(v, 1).options.find(o => !Object.keys(o.missing).length); if (o) return `you have ${Object.keys(o.uses)[0]} 3: craft ${v}` } return null }
  assert.equal(describeMissing(m.craftPlan('stick', 4).options, hint), '2 planks (any kind) — you have spruce_log 3: craft spruce_planks')
  assert.equal(describeMissing(m.craftPlan('oak_planks', 4).options, hint), '1 oak_log', 'a named item stays named')
  m = craftMotor({ oak_planks: 3, stick: 2 })
  const p = m.craftPlan('wooden_pickaxe', 1)
  assert.deepEqual(p.options[0], { requiresTable: true, yields: 1, times: 1, missing: {}, uses: { oak_planks: 3, stick: 2 } })
  assert.deepEqual(craftMotor({}).craftPlan('not_an_item', 1), { known: false, options: [] })
})

test('craft: 2x2 without a table; 3x3 needs an observed table and walks to it', async () => {
  const plan = (needTable, missing = {}) => () => ({ known: true, options: [{ requiresTable: needTable, yields: 1, times: 1, missing }] })
  let s = setup(world(), { craftPlan: plan(false) })
  let r = await run('craft', s.act, { item: 'crafting_table' })
  assert.deepEqual(r, { status: 'done', detail: 'crafted 1 crafting_table', data: { item: 'crafting_table', crafted: 1, table: null } })

  s = setup(world(), { craftPlan: plan(true) })
  r = await run('craft', s.act, { item: 'wooden_pickaxe' })
  assert.deepEqual([r.status, r.detail], ['failed', 'craft: wooden_pickaxe needs crafting_table nearby (none seen or known within 48 blocks)'])
  assert.equal(s.motor.calls.length, 0, 'it does not place or go looking for one')

  const w = world().set(3, 10, 5, 'crafting_table')
  s = setup(w, { craftPlan: plan(true) })
  r = await run('craft', s.act, { item: 'wooden_pickaxe' })
  assert.equal(r.status, 'done')
  assert.deepEqual(s.motor.calls.map(c => c[0]), ['goto', 'craft'])
  assert.deepEqual(s.motor.calls[0][1].pos, [3, 10, 5])
  assert.deepEqual(s.motor.calls[1], ['craft', 'wooden_pickaxe', 1, [3, 10, 5]])

  s = setup(world(), { craftPlan: plan(false, { oak_planks: 3 }) })
  assert.deepEqual(await run('craft', s.act, { item: 'crafting_table' }), { status: 'failed', detail: 'craft: missing 3 oak_planks for 1 crafting_table' })
  s = setup(world())
  assert.deepEqual(await run('craft', s.act, { item: 'diamond' }), { status: 'failed', detail: 'craft: diamond has no crafting recipe' })
})

// ---- place, equip, dig, eat --------------------------------------------------

test('place: adjacent, empty, visible, in reach, from the inventory', async () => {
  const s = setup(world(), { inv: { cobblestone: 4 } })
  assert.deepEqual(await run('place', s.act, { block: 'cobblestone', pos: [0, 10, 2] }), { status: 'done', detail: 'placed cobblestone at [0, 10, 2]', data: { block: 'cobblestone', pos: [0, 10, 2] } })
  assert.deepEqual(s.motor.calls.at(-1), ['place', 'cobblestone', [0, 9, 2], [0, 10, 2]], 'against the ground below')
  const fails = [
    [{ block: 'cobblestone', pos: [0, 10, 12] }, /out of reach \(\d+(\.\d)? blocks, max 4.5\); goto closer first/],
    [{ block: 'cobblestone', pos: [0, 10, 2] }, /is not empty \(cobblestone\)/],
    [{ block: 'cobblestone', pos: [0, 10, 0] }, /is where Atlas is standing/],
    [{ block: 'cobblestone', pos: [0, 7, 1] }, /not visible from here/],
    [{ block: 'dirt', pos: [1, 10, 1] }, /no dirt in inventory/],
    [{ block: 'cobblestone', pos: [1, 13, 1] }, /nothing solid next to/]
  ]
  for (const [args, re] of fails) {
    const r = await run('place', s.act, args)
    assert.equal(r.status, 'failed', JSON.stringify(args))
    assert.match(r.detail, re)
  }
})

test('equip, dig, eat: precise failures, otherwise done', async () => {
  let s = setup(world(), { inv: { iron_pickaxe: 1 } })
  assert.deepEqual(await run('equip', s.act, { item: 'iron_pickaxe' }), { status: 'done', detail: 'equipped iron_pickaxe (hand)', data: { item: 'iron_pickaxe', slot: 'hand' } })
  assert.deepEqual(await run('equip', s.act, { item: 'shield', slot: 'off-hand' }), { status: 'failed', detail: 'equip: no shield in inventory' })
  assert.equal((await run('equip', s.act, { item: 'shield', slot: 'pocket' })).status, 'failed')

  const w = world().set(0, 7, 3, 'diamond_ore').set(1, 10, 3, 'bedrock')
  s = setup(w, { tool: n => (n === 'bedrock' ? { ok: false, tool: null, reason: 'bedrock cannot be dug' } : n === 'stone' ? { ok: false, needsTool: true, reason: 'stone needs one of: wooden_pickaxe' } : { ok: true, tool: 'iron_pickaxe' }) })
  let r = await run('dig', s.act, { pos: [0, 7, 3] })
  assert.deepEqual([r.status, r.detail], ['refused', 'fair play: the block at [0, 7, 3] has not been observed'])
  r = await run('dig', s.act, { pos: [1, 10, 3] })
  assert.deepEqual([r.status, r.detail], ['failed', 'dig: bedrock cannot be dug'])
  r = await run('dig', s.act, { pos: [0, 9, 2] }) // the ground in front: visible stone, no pickaxe
  assert.equal(r.status, 'done')
  assert.equal(r.detail, 'dug stone at [0, 9, 2] by hand (stone drops nothing without the right tool)')
  assert.deepEqual(r.data, { pos: [0, 9, 2], block: 'stone', dropped: false, drops: [] })
  assert.equal((await run('dig', s.act, { pos: [0, 9, 2] })).detail, 'dig: [0, 9, 2] is already empty (air)')

  s = setup(world(), { food: 20 })
  assert.deepEqual(await run('eat', s.act, {}), { status: 'failed', detail: 'eat: not hungry (food 20/20)' })
  s = setup(world(), { food: 12, foods: [] })
  assert.deepEqual(await run('eat', s.act, {}), { status: 'failed', detail: 'eat: no food in inventory' })
  s = setup(world(), { food: 12, foods: [{ name: 'rotten_flesh', count: 3, harmful: true }], inv: { rotten_flesh: 3 } })
  assert.match((await run('eat', s.act, {})).detail, /only harmful food in inventory \(rotten_flesh\); name it to eat it anyway/)
  assert.equal((await run('eat', s.act, { item: 'rotten_flesh' })).status, 'done')
  s = setup(world(), { food: 12, foods: [{ name: 'bread', count: 2, harmful: false }], inv: { bread: 2 } })
  assert.deepEqual(await run('eat', s.act, {}), { status: 'done', detail: 'ate bread; food 12 → 17', data: { item: 'bread', food_before: 12, food_after: 17 } })
  assert.deepEqual(await run('eat', s.act, { item: 'stone' }), { status: 'failed', detail: 'eat: stone is not food' })
})

test('craft: a missing tag ingredient is "any kind", with what the inventory makes it from', async () => {
  const opt = (missing, uses) => ({ requiresTable: false, yields: 4, times: 1, missing, uses })
  const craftPlan = item => {
    if (item === 'stick') return { known: true, options: [opt({ oak_planks: 2 }, { oak_planks: 2 }), opt({ spruce_planks: 2 }, { spruce_planks: 2 }), opt({ birch_planks: 2 }, { birch_planks: 2 })] }
    if (item === 'spruce_planks') return { known: true, options: [opt({}, { spruce_log: 1 })] }
    return { known: true, options: [opt({ [item.replace('planks', 'log')]: 1 }, {})] }
  }
  const s = setup(world(), { craftPlan, inv: { spruce_log: 3 } })
  const r = await run('craft', s.act, { item: 'stick', count: 4 })
  assert.deepEqual(r, { status: 'failed', detail: 'craft: missing 2 planks (any kind) for 4 stick — you have spruce_log 3: craft spruce_planks' })
})

test('place without pos: the nearest free, visible spot next to the bot, skipping occupied sides', async () => {
  const w = world().set(0, 10, -1, 'stone').set(1, 10, 0, 'oak_log') // north and east taken at feet level
  const s = setup(w, { inv: { furnace: 1 } })
  const r = await run('place', s.act, { block: 'furnace' })
  assert.deepEqual(r, { status: 'done', detail: 'placed furnace at [0, 10, 1]', data: { block: 'furnace', pos: [0, 10, 1] } })
  assert.equal(s.motor.calls.filter(c => c[0] === 'place').length, 1, 'no failed attempts on occupied spots')
  assert.equal(w.get(0, 10, 1), 'furnace')

  const boxed = world()
  for (const [x, z] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) boxed.set(x, 10, z, 'stone').set(x, 11, z, 'stone')
  const b = setup(boxed, { inv: { furnace: 1 } })
  assert.deepEqual(await run('place', b.act, { block: 'furnace' }), { status: 'failed', detail: 'place: no free spot next to Atlas for furnace (every side is occupied or not visible)' })
  assert.deepEqual(await run('place', b.act, { block: 'crafting_table' }), { status: 'failed', detail: 'place: no crafting_table in inventory' })
})

test('motor.craft: the count comes from the inventory once the window settles, not from the craft call', async () => {
  const items = [{ name: 'oak_planks', count: 2, type: registry.itemsByName.oak_planks.id }]
  const bot = {
    registry,
    on () {},
    inventory: { items: () => items },
    recipesFor: () => [{ requiresTable: false, result: { count: 4 } }],
    // the real window: the call resolves, the result slot lands ~300 ms later
    craft: async () => { setTimeout(() => { items[0].count = 0; items.push({ name: 'stick', count: 4 }) }, 300) }
  }
  const m = new Motor(bot)
  const t0 = Date.now()
  assert.deepEqual(await m.craft('stick', 4), { ok: true, crafted: 4 })
  assert.ok(Date.now() - t0 >= 250, 'it waited for the items')
  bot.craft = async () => { throw new Error('Server rejected transaction') } // and they never come
  const r = await m.craft('stick', 4, null, { settleMs: 300 })
  assert.deepEqual(r, { ok: false, crafted: 0, reason: 'Server rejected transaction' })
  bot.craft = async () => { setTimeout(() => items.push({ name: 'stick', count: 4 }), 100); throw new Error('timeout') } // the call errs, the items arrive
  assert.deepEqual(await m.craft('stick', 4), { ok: true, crafted: 4 })
})
