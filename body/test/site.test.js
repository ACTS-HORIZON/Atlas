'use strict'
// Session 10a: build on real ground. Plants are empty, stand spots are searched harder (and a cell with
// none fails alone), prepare levels the site, mine {box} digs a region out. The fake motor's goto here
// really walks: a breadth-first search over standable cells (step up 1, drop up to 3, no digging, no
// scaffolding), so an unreachable spot comes back no_path, as the live pathfinder's does.
const test = require('node:test')
const assert = require('node:assert/strict')
const { FakeWorld } = require('./fakeWorld')
const { setup, run } = require('./verbHarness')
const { HouseRules } = require('../src/house')

const HUT = { shape: 'box', corner: [3, 10, -2], size: [5, 5, 3], material: 'cobblestone', door: 'south', hollow: true, roof: true }

/** goto that walks: BFS over standable cells of the fake world; no_path when the spot can't be reached. */
function walking (s, w) {
  const solid = (x, y, z) => { const c = w.classAt(x, y, z); return !!c && c.solid && !c.fluid }
  const free = (x, y, z) => { const c = w.classAt(x, y, z); return !!c && !c.solid && !c.fluid }
  const standable = (x, y, z) => solid(x, y - 1, z) && free(x, y, z) && free(x, y + 1, z)
  s.motor.goto = async function (o) {
    this.calls.push(['goto', o])
    const start = this.pos.map(Math.floor)
    const goal = [Math.floor(o.pos[0]), Math.floor(o.pos[1]), Math.floor(o.pos[2])]
    const seen = new Set([start.join()])
    const q = [start]
    while (q.length && seen.size < 6000) {
      const [x, y, z] = q.shift()
      if (x === goal[0] && y === goal[1] && z === goal[2]) {
        this.pos = [x + 0.5, y, z + 0.5]
        return { status: 'reached', remaining: 0, moved: 1 }
      }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const dy of [1, 0, -1, -2, -3]) {
          const n = [x + dx, y + dy, z + dz]
          if (dy === 1 && !free(x, y + 2, z)) continue // a step up needs headroom
          if (!standable(...n) || seen.has(n.join())) continue
          seen.add(n.join()); q.push(n)
          break
        }
      }
    }
    return { status: 'no_path', remaining: Math.hypot(goal[0] - start[0], goal[2] - start[2]), moved: 0 }
  }
  return s
}

/** Built cells of the hut: count of its 55 cells holding cobblestone. */
function hutDone (w) {
  return require('../src/verbs/build').boxCells(HUT).filter(c => w.get(...c.pos) === 'cobblestone').length
}

test('plants in the footprint are empty: grass, flowers, a snow layer and a dead bush are built over', async () => {
  const w = new FakeWorld({ fill: 'air' }).box([-20, 0, -20], [20, 9, 20], 'stone')
  const plants = [[3, 10, -2, 'short_grass'], [4, 10, -2, 'dandelion'], [5, 10, -2, 'snow'], [6, 10, -2, 'dead_bush'], [7, 10, -2, 'tall_grass'], [7, 10, 0, 'poppy']]
  for (const [x, y, z, n] of plants) w.set(x, y, z, n)
  const s = walking(setup(w, { pos: [0.5, 10, 0.5], inv: { cobblestone: 64 } }), w)
  const r = await run('build', s.act, { ...HUT, roof: false })
  assert.equal(r.status, 'done', r.detail)
  for (const [x, y, z] of plants) assert.equal(w.get(x, y, z), 'cobblestone', `${x},${y},${z}`)
})

test('on a slope with a 2-block drop (spots up the hill unreachable once below): 90% or more of the roofed hut placed, failures per cell', async () => {
  // ground top at y 9 west of x 6, y 7 from x 6 east: walking down is fine, back up is not
  const w = new FakeWorld({ fill: 'air' }).box([-20, 0, -20], [5, 9, 20], 'stone').box([6, 0, -20], [20, 7, 20], 'stone')
  const s = walking(setup(w, { pos: [0.5, 10, 0.5], inv: { cobblestone: 64 } }), w)
  const r = await run('build', s.act, { ...HUT })
  const done = hutDone(w)
  assert.ok(done >= 0.9 * 55, `${done}/55 placed: ${r.detail}`)
  assert.ok(['done', 'partial'].includes(r.status))
  assert.equal(r.data.placed, done)
  assert.ok(s.motor.calls.some(c => c[0] === 'goto'), 'it walked')
})

test('prepare: true on a hillside: digs the terrain inside the box, fills the gap under it, then builds the whole hut', async () => {
  // a hill rising east: ground top y 8 at x 3, 9 at x 4, 10 at x 5, 11 at x 6, 12 at x 7 (and on east)
  const hill = () => {
    const h = new FakeWorld({ fill: 'air' }).box([-20, 0, -20], [2, 9, 20], 'stone')
    for (let x = 3; x <= 20; x++) h.box([x, 0, -20], [x, Math.min(12, 5 + x), 20], x <= 4 ? 'dirt' : 'stone')
    for (let x = 3; x <= 20; x++) for (let z = -20; z <= 20; z++) h.set(x, Math.min(12, 5 + x), z, 'grass_block')
    return h
  }
  const inv = () => ({ cobblestone: 64, dirt: 16, stone_pickaxe: 1 })
  // without prepare: the hill is in the way, and it says so
  const h0 = hill()
  const without = await run('build', walking(setup(h0, { pos: [0.5, 10, 0.5], inv: inv() }), h0).act, { ...HUT })
  assert.equal(without.status, 'partial')
  assert.ok(without.data.failed.some(f => /is there \(build never digs; prepare: true levels the site\)/.test(f.reason)), without.detail)
  // with prepare, on the same hill
  const w = hill()
  const s = walking(setup(w, { pos: [0.5, 10, 0.5], inv: inv() }), w)
  const r = await run('build', s.act, { ...HUT, prepare: true })
  assert.equal(r.status, 'done', r.detail)
  assert.equal(hutDone(w), 55)
  assert.ok(r.data.dug > 0 && r.data.filled === 5, `dug ${r.data.dug}, filled ${r.data.filled}`)
  assert.match(r.detail, /^built a hollow 5x5x3 cobblestone box at \[3, 10, -2\] with a door to the south, roofed: prepared \(dug \d+, filled 5\); placed 55, skipped 0 \(already there\), failed 0$/)
  for (let z = -2; z <= 2; z++) assert.equal(w.get(3, 9, z), 'dirt', 'the gap under the low side is filled with dirt')
  for (let x = 4; x <= 6; x++) assert.equal(w.get(x, 10, 0), 'air', 'the inside is dug out')
})

test('prepare: a protected region over the site refuses the build before anything changes', async () => {
  const w = new FakeWorld({ fill: 'air' }).box([-20, 0, -20], [20, 9, 20], 'stone').box([5, 10, -2], [7, 10, 2], 'dirt')
  const house = new HouseRules([{ name: 'garden', dim: null, min: [6, 10, -1], max: [6, 10, -1] }])
  const s = walking(setup(w, { pos: [0.5, 10, 0.5], inv: { cobblestone: 64 }, house }), w)
  const r = await run('build', s.act, { ...HUT, roof: false, prepare: true })
  assert.equal(r.status, 'refused')
  assert.match(r.detail, /^house rules: no dig inside protected region "garden" .*\(prepare: dig \[6, 10, -1\]\)$/)
  assert.equal(w.get(5, 10, -2), 'dirt', 'nothing dug')
})

test('mine {box}: digs a region out top-down', async () => {
  const w = new FakeWorld({ fill: 'air' }).box([-20, 0, -20], [20, 9, 20], 'stone').box([2, 9, -1], [4, 9, 1], 'dirt')
  const s = walking(setup(w, { pos: [0.5, 10, 0.5], inv: { stone_pickaxe: 1 } }), w)
  const r = await run('mine', s.act, { box: [[4, 8, 1], [2, 9, -1]] })
  assert.equal(r.status, 'done', r.detail)
  assert.equal(r.detail, 'mined out the 3x2x3 box [2, 8, -1]..[4, 9, 1]: dug 18')
  for (let x = 2; x <= 4; x++) for (let z = -1; z <= 1; z++) for (const y of [8, 9]) assert.equal(w.get(x, y, z), 'air')
  const ys = s.motor.calls.filter(c => c[0] === 'dig').map(c => c[1][1])
  assert.deepEqual(ys, [...ys].sort((p, q) => q - p), 'top-down')
  // block: only that type in the box
  const v = new FakeWorld({ fill: 'air' }).box([-20, 0, -20], [20, 9, 20], 'stone').box([2, 9, -1], [4, 9, 1], 'dirt')
  const f = walking(setup(v, { pos: [0.5, 10, 0.5] }), v)
  const only = await run('mine', f.act, { box: [[2, 8, -1], [4, 9, 1]], block: 'dirt' })
  assert.equal(only.detail, 'mined out the 3x2x3 box [2, 8, -1]..[4, 9, 1]: dug 9')
  assert.equal(v.get(3, 8, 0), 'stone')

})

test('mine {box}: protected cells and water', async () => {
  const w = new FakeWorld({ fill: 'air' }).box([-20, 0, -20], [20, 9, 20], 'stone')
  const house = new HouseRules([{ name: 'well', dim: null, min: [3, 9, 0], max: [3, 9, 0] }])
  const s = walking(setup(w, { pos: [0.5, 10, 0.5], house }), w)
  const r = await run('mine', s.act, { box: [[2, 9, -1], [4, 9, 1]] })
  assert.equal(r.status, 'partial')
  assert.equal(r.detail, 'mined out the 3x1x3 box [2, 9, -1]..[4, 9, 1]: dug 8, skipped 1 in a protected region (first [3, 9, 0])')
  assert.equal(w.get(3, 9, 0), 'stone')

  const wet = new FakeWorld({ fill: 'air' }).box([-20, 0, -20], [20, 9, 20], 'stone').set(5, 9, 0, 'water')
  const t = walking(setup(wet, { pos: [0.5, 10, 0.5] }), wet)
  const q = await run('mine', t.act, { box: [[2, 9, -1], [4, 9, 1]] })
  assert.equal(q.status, 'partial')
  assert.match(q.detail, /; stopped: water next to \[4, 9, 0\] \(at \[5, 9, 0\]\)$/)
  assert.equal(wet.get(4, 9, 0), 'stone', 'the block holding the water back is left')
  assert.deepEqual((await run('mine', t.act, { box: [[0, 0, 0], [40, 40, 40]] })).status, 'failed')
  assert.match((await run('mine', t.act, { box: [[0, 0, 0], [1, 1, 1]], count: 3 })).detail, /with box, only block may go with it/)
})
