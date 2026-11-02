'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { FakeWorld, makeView, lookVec } = require('./fakeWorld')
const { buildObs } = require('../src/fairplay/observe')
const { MotionTracker, SoundMemory, bearing, soundType } = require('../src/fairplay/perception')
const { classify } = require('../src/fairplay/blocks')
const { check } = require('../src/schema')

// Ground at y<=9 (stone), air above. Bot stands at (0.5, 10, 0.5), eye y=11.62,
// facing south (+Z, yaw 0).
function flat () { return new FakeWorld().box([-32, 0, -32], [31, 9, 31], 'stone') }
const obsOf = (w, o) => buildObs(makeView(w, o), {}).obs
const types = obs => obs.blocks_seen.map(b => b.type)

test('ore in plain sight is seen, ore behind one block of stone is not', () => {
  const w = flat()
  w.set(0, 10, 6, 'iron_ore') // on the ground, in the open
  w.set(4, 10, 8, 'stone').set(4, 10, 9, 'gold_ore') // wall between bot and gold
  w.box([3, 10, 9], [5, 12, 9], 'stone').set(4, 10, 9, 'gold_ore') // gold embedded in a wall, exposed only on +Z (away)
  const obs = obsOf(w)
  assert.deepEqual(types(obs), ['iron_ore'])
  assert.deepEqual(obs.blocks_seen[0].pos, [0, 10, 6])
})

test('ores inside rock never appear, even right next to the bot', () => {
  const w = flat()
  w.set(0, 8, 0, 'diamond_ore').set(1, 7, 1, 'coal_ore').set(0, 9, 2, 'iron_ore') // 0,9,2 is the ground surface: its top face is exposed
  const obs = obsOf(w)
  assert.deepEqual(types(obs), ['iron_ore'], 'only the surface ore')
})

test('a cave wall ore is visible only from inside the cave', () => {
  const w = flat()
  w.box([-3, 3, 10], [3, 6, 16], 'air') // closed cave under the ground
  w.set(0, 4, 17, 'redstone_ore') // in the cave's far wall
  assert.deepEqual(types(obsOf(w)), [], 'from the surface: behind rock')
  assert.deepEqual(types(obsOf(w, { pos: [0.5, 3, 11.5] })), ['redstone_ore'], 'from inside the cave')
})

test('sight passes glass and water, stops at leaves and lava', () => {
  const w = flat()
  w.box([-2, 10, 4], [2, 13, 4], 'glass'); w.set(0, 10, 6, 'coal_ore')
  assert.deepEqual(types(obsOf(w)), ['coal_ore'])
  w.box([-2, 10, 4], [2, 13, 4], 'oak_leaves')
  assert.deepEqual(types(obsOf(w)), [])
  // ore at the bottom of a pool: visible through the water; only the pool surface counts as "water"
  const p = flat(); p.box([-2, 6, 4], [2, 9, 8], 'water'); p.set(0, 5, 6, 'emerald_ore')
  const o = obsOf(p, { pos: [0.5, 10, 3.5] }) // at the pool's edge
  assert.ok(types(o).includes('emerald_ore'))
  for (const b of o.blocks_seen.filter(b => b.type === 'water')) assert.equal(b.pos[1], 9, 'water below the surface is not listed')
  // lava hides what is under it
  const l = flat(); l.box([-2, 8, 4], [2, 9, 8], 'lava'); l.set(0, 7, 6, 'gold_ore')
  assert.ok(!types(obsOf(l)).includes('gold_ore'))
})

test('render distance limits blocks_seen', () => {
  const w = flat(); w.set(0, 10, 20, 'oak_log')
  assert.deepEqual(types(obsOf(w, { sightRadius: 32 })), ['oak_log'])
  assert.deepEqual(types(obsOf(w, { sightRadius: 16 })), [])
})

test('only notable types; nearest first; capped overall and per type', () => {
  const w = flat()
  for (let z = 3; z < 20; z++) w.set(0, 10, z, 'oak_log') // 17 logs in a row on the ground... each hides the next's front face
  for (let z = 3; z < 20; z++) w.set(3, 9, z, 'water') // a 1-wide stream at ground level
  w.set(-3, 10, 3, 'cobblestone').set(-3, 10, 4, 'dirt').set(-4, 10, 4, 'crafting_table')
  const obs = buildObs(makeView(w), {}, { maxBlocks: 10, maxPerType: 4 }).obs
  assert.ok(obs.blocks_seen.length <= 10)
  for (const t of ['oak_log', 'water']) assert.ok(obs.blocks_seen.filter(b => b.type === t).length <= 4)
  assert.ok(!types(obs).includes('cobblestone') && !types(obs).includes('dirt'))
  assert.ok(types(obs).includes('crafting_table'))
  const d = obs.blocks_seen.map(b => b.dist)
  assert.deepEqual(d, [...d].sort((a, b) => a - b))
})

test('entities: line of sight only, no hidden state, bearing relative to facing', () => {
  const w = flat()
  w.box([-3, 10, -6], [3, 13, -6], 'stone') // wall behind the bot (north)
  const entities = [
    { id: 1, type: 'zombie', pos: [0.5, 10, 6.5], height: 1.95, hostile: true, health: 20, target: 'Atlas' },
    { id: 2, type: 'skeleton', pos: [0.5, 10, -9.5], height: 1.99, hostile: true }, // behind the wall
    { id: 3, type: 'cow', pos: [-4.5, 10, 0.5], height: 1.4, hostile: false }
  ]
  const obs = obsOf(w, { entities })
  assert.deepEqual(obs.entities.map(e => e.type), ['cow', 'zombie'])
  const z = obs.entities.find(e => e.type === 'zombie')
  assert.deepEqual(z, { type: 'zombie', rel: [0, 0, 6], dist: 6, bearing: 'front', approaching: false, hostile: true })
  // facing south, -X (west) is on the right hand
  assert.equal(obs.entities.find(e => e.type === 'cow').bearing, 'right')
  assert.equal(check('obs', obs), null)
})

test('approaching comes from distance history', () => {
  const w = flat(); const m = new MotionTracker()
  m.sample(1, 12, 0); m.sample(1, 9, 1000)
  const view = makeView(w, { entities: [{ id: 1, type: 'zombie', pos: [0.5, 10, 7.5], hostile: true }] })
  assert.equal(buildObs(view, { motion: m }, { now: 1800 }).obs.entities[0].approaching, true)
  const m2 = new MotionTracker(); m2.sample(1, 7, 0); m2.sample(1, 7, 1000)
  assert.equal(buildObs(view, { motion: m2 }, { now: 1800 }).obs.entities[0].approaching, false)
})

test('players: visible only; looking_at is their target block if the bot sees it too', () => {
  const w = flat()
  w.set(4, 10, 10, 'stone') // a block on the ground the player looks at
  // player at (4.5,10,5.5) looking south and down at (4,10,10)
  const eye = [4.5, 11.62, 5.5]
  const toT = [4.5 - eye[0], 10.9 - eye[1], 10.1 - eye[2]]; const L = Math.hypot(...toT)
  const look = toT.map(v => v / L)
  let obs = obsOf(w, { players: [{ name: 'ACTS_HORIZON', pos: [4.5, 10, 5.5], look }] })
  assert.equal(obs.players.length, 1)
  assert.deepEqual(obs.players[0].looking_at, [4, 10, 10])
  assert.deepEqual(Object.keys(obs.players[0]).sort(), ['dist', 'looking_at', 'name', 'pos'])

  // player looks straight ahead at a wall that the bot also sees
  w.box([1, 10, 9], [8, 13, 9], 'stone')
  obs = obsOf(w, { players: [{ name: 'ACTS_HORIZON', pos: [4.5, 10, 5.5], look: lookVec(0, 0) }] })
  assert.deepEqual(obs.players[0].looking_at, [4, 11, 9], 'player looks at the wall, bot sees the wall face')

  // a target the bot cannot see: player looks over a wall at a block hidden from the bot
  const w2 = flat()
  w2.box([-6, 10, 3], [6, 16, 3], 'stone') // tall wall in front of the bot
  w2.set(0, 10, 8, 'gold_block')
  // player standing on top of the wall (y=17) looking down at the gold block
  const pe = [0.5, 18.62, 3.5]; const d = [0.5 - pe[0], 10.9 - pe[1], 8.5 - pe[2]]; const n = Math.hypot(...d)
  obs = obsOf(w2, { players: [{ name: 'ACTS_HORIZON', pos: [0.5, 17, 3.5], look: d.map(v => v / n) }] })
  assert.equal(obs.players.length, 1, 'player on top of the wall is visible')
  assert.equal(obs.players[0].looking_at, null, 'their target is behind the wall from the bot')

  // a player behind the wall is not reported at all
  obs = obsOf(w2, { players: [{ name: 'Hidden', pos: [0.5, 10, 6.5], look: lookVec(0, 0) }] })
  assert.deepEqual(obs.players, [])
  assert.equal(check('obs', obs), null)
})

test('sounds: type + bearing + bucket, never coordinates; old sounds expire', () => {
  const s = new SoundMemory({ windowMs: 3000 })
  s.add('minecraft:entity.creeper.primed', [0.5, 10, -3], 0) // behind (bot faces south)
  s.add('minecraft:entity.zombie.ambient', [20, 10, 0.5], 500) // +X (east) is on the left when facing south
  s.add('minecraft:block.stone.break', [0.5, 10, 60], 900)
  s.add('minecraft:block.stone.step', [0.5, 10, 0.6], 900) // own footstep
  s.add('minecraft:music.game', [0, 0, 0], 900)
  const obs = buildObs(makeView(flat()), { sounds: s }, { now: 1000 }).obs
  assert.deepEqual(new Set(obs.sounds.map(x => JSON.stringify(x))), new Set([
    { type: 'creeper_hiss', bearing: 'behind', dist: 'near' },
    { type: 'zombie_ambient', bearing: 'left', dist: 'mid' },
    { type: 'stone_break', bearing: 'front', dist: 'far' }
  ].map(x => JSON.stringify(x))))
  for (const x of obs.sounds) assert.deepEqual(Object.keys(x).sort(), ['bearing', 'dist', 'type'])
  assert.deepEqual(buildObs(makeView(flat()), { sounds: s }, { now: 4000 }).obs.sounds, [], 'all older than 3 s')
})

test('bearings and helpers', () => {
  assert.equal(bearing(0, [0, 0, 5]), 'front')
  assert.equal(bearing(0, [0, 0, -5]), 'behind')
  assert.equal(bearing(0, [-5, 0, 0]), 'right')
  assert.equal(bearing(90, [-5, 0, 0]), 'front') // yaw 90 = facing west
  assert.equal(bearing(180, [5, 0, 0]), 'right') // facing north, east is right
  assert.equal(bearing(0, [3, 0, 3]), 'front-left')
  assert.equal(bearing(0, [0, 5, 0.2]), 'above')
  assert.equal(soundType('minecraft:entity.zombie.ambient'), 'zombie_ambient')
  assert.equal(classify('glass').opaque, false)
  assert.equal(classify('stone').opaque, true)
  assert.equal(classify('deepslate_diamond_ore').notable, true)
  assert.equal(classify('stone').notable, false)
})

test('self, world and the rest of the full view match the contract', () => {
  const view = makeView(flat(), {
    inventory: { cobblestone: 41 },
    chat: [{ from: 'ACTS_HORIZON', text: '@Atlas hi', t: 900 }],
    bossBar: { title: 'Ender Dragon', health: 0.5 }
  })
  view.self.gamemode = 'creative'
  const { obs, stats } = buildObs(view, {})
  assert.equal(obs.self.gamemode, 'creative')
  assert.equal(obs.world.time, 'day')
  assert.equal(obs.v, '0.1')
  assert.equal(check('obs', obs), null)
  assert.ok(stats.ms >= 0)
  // the schema rejects hidden entity state
  const bad = structuredClone(obs)
  bad.entities.push({ type: 'zombie', rel: [1, 0, 1], dist: 1.4, bearing: 'front', approaching: false, hostile: true, health: 20 })
  assert.notEqual(check('obs', bad), null)
})
