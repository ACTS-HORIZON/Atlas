'use strict'
// Session 9b, eyes: the ground facts in obs.surroundings (standing on, placed by you, ground level, terrain,
// canopy), goto surface meaning the ground surface, and inspect (the region view). Fake worlds, real
// fair-play builder, real filtered API and verbs.
const test = require('node:test')
const assert = require('node:assert/strict')
const { FakeWorld, makeView } = require('./fakeWorld')
const { buildObs } = require('../src/fairplay/observe')
const { check } = require('../src/schema')
const { setup, run } = require('./verbHarness')

const flat = () => new FakeWorld({ fill: 'air' }).box([-20, 0, -20], [20, 9, 20], 'stone')
/** An oak: trunk at (0, 10..14, 0), leaves 5x5 at y 13..14 and 3x3 at 15..16 (no leaves in the trunk). */
function tree (w) {
  for (let y = 13; y <= 14; y++) for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) w.set(x, y, z, 'oak_leaves')
  for (let y = 15; y <= 16; y++) for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) w.set(x, y, z, 'oak_leaves')
  for (let y = 10; y <= 14; y++) w.set(0, y, 0, 'oak_log')
  return w
}
const surroundingsAt = (w, pos, placed = new Set()) => {
  const { obs } = buildObs(makeView(w, { pos, placedAt: (x, y, z) => placed.has(`${x},${y},${z}`) }), {})
  assert.equal(check('obs', obs), null, 'a valid obs')
  return obs.surroundings
}

test('ground facts on open flat ground: standing on natural stone, on the ground, flat terrain, no canopy', () => {
  const g = surroundingsAt(flat(), [0.5, 10, 0.5]).ground
  assert.deepEqual([g.standing_on, g.placed], ['stone', false])
  assert.deepEqual([g.level, g.below, g.at], [10, 0, [0, 10, 0]])
  assert.equal(g.terrain, 'flat 10-10')
  assert.equal(g.canopy, false)
})

test('under a canopy: no open sky, leaves above; still on the ground', () => {
  const s = surroundingsAt(tree(flat()), [1.5, 10, 0.5])
  assert.equal(s.sky, false)
  assert.equal(s.ground.canopy, true)
  assert.equal(s.ground.below, 0)
  assert.equal(s.roof, 2, 'the leaves at y 13 are 2 above the head')
})

test('on top of its own pillar: standing on cobblestone it placed, ground 5 below, not the surface', () => {
  const w = flat()
  const placed = new Set()
  for (let y = 10; y <= 14; y++) { w.set(5, y, 5, 'cobblestone'); placed.add(`5,${y},5`) }
  const s = surroundingsAt(w, [5.5, 15, 5.5], placed)
  assert.equal(s.sky, true)
  assert.deepEqual([s.ground.standing_on, s.ground.placed], ['cobblestone', true])
  assert.equal(s.ground.level, 10)
  assert.equal(s.ground.below, 5)
  assert.equal(require('../src/verbs/goto').atSurface(s), false, 'open sky, but not the surface')
  // the same pillar of natural stone (not placed): the top of it is ground, the surface
  const s2 = surroundingsAt(w, [5.5, 15, 5.5])
  assert.deepEqual([s2.ground.placed, s2.ground.below], [false, 0])
  assert.equal(require('../src/verbs/goto').atSurface(s2), true)
})

test('on top of a tree: standing on leaves, the natural ground seen below the edge, sloped and mixed terrain', () => {
  const s = surroundingsAt(tree(flat()), [0.5, 17, 0.5])
  assert.equal(s.sky, true)
  assert.deepEqual([s.ground.standing_on, s.ground.placed], ['oak_leaves', false])
  assert.equal(s.ground.level, 10)
  assert.equal(s.ground.below, 7)
  assert.equal(require('../src/verbs/goto').atSurface(s), false)
  // terrain: a slope (one step up every 2 blocks east) and a cliff
  const slope = new FakeWorld({ fill: 'air' })
  for (let x = -20; x <= 20; x++) slope.box([x, 0, -20], [x, 9 + Math.max(0, Math.floor(x / 2)), 20], 'stone')
  assert.match(surroundingsAt(slope, [0.5, 10, 0.5]).ground.terrain, /^sloped 10-1\d$/)
  const cliff = flat().box([3, 10, -20], [20, 15, 20], 'stone')
  assert.equal(surroundingsAt(cliff, [0.5, 10, 0.5]).ground.terrain, 'mixed 10-16')
})

test('goto surface on its own pillar under open sky: comes down to the natural ground, then done', async () => {
  const w = flat()
  const pillar = []
  for (let y = 10; y <= 14; y++) { w.set(5, y, 5, 'cobblestone'); pillar.push(`5,${y},5`) }
  const s = setup(w, { pos: [5.5, 15, 5.5], walk: '3d', placed: pillar })
  const r = await run('goto', s.act, { target: 'surface' })
  assert.equal(r.status, 'done', r.detail)
  assert.equal(r.data.y, 10)
  assert.ok(s.progress.some(p => /down from cobblestone \(placed by you\) to the ground at y 10 \(5 below\)/.test(p)), s.progress.join(' | '))
  const down = s.motor.calls.filter(c => c[0] === 'goto').at(-1)[1]
  assert.equal(down.scaffold, false, 'it does not pillar on the way down')
})

test('inspect: the blocks in a box it can see, as a compact list with counts; hidden ones counted, not named', () => {
  const w = flat()
  w.box([3, 10, -1], [3, 11, 1], 'cobblestone') // a little wall east of the bot
  w.set(4, 10, 0, 'diamond_ore') // behind the wall: hidden
  const s = setup(w, { pos: [0.5, 10, 0.5] })
  const r = require('../src/verbs/inspect').run(s.act, { box: [[3, 9, -1], [4, 11, 1]] })
  assert.equal(r.status, 'done')
  assert.equal(r.data.counts.cobblestone, 6)
  assert.ok(!r.data.counts.diamond_ore, 'the ore behind the wall is not seen')
  assert.ok(r.data.hidden >= 1)
  assert.ok(r.data.blocks.every(b => b.length === 4 && typeof b[3] === 'string'))
  assert.match(r.detail, /^inspected 2x3x3 box \[3, 9, -1\]\.\.\[4, 11, 1\]: \d+ visible blocks \(cobblestone 6.*\); \d+ hidden$/)
  assert.deepEqual(require('../src/verbs/inspect').run(s.act, { box: [[0, 0, 0], [40, 40, 40]] }).status, 'failed')
})
