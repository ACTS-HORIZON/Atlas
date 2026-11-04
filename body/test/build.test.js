'use strict'
// Session 9c, hands: build a box or a block list, bottom-up, from inventory. Real filtered API, sight and
// house rules over a fake world; the fake motor walks (teleports) and places.
const test = require('node:test')
const assert = require('node:assert/strict')
const { FakeWorld } = require('./fakeWorld')
const { setup, run } = require('./verbHarness')
const { boxCells } = require('../src/verbs/build')
const { HouseRules } = require('../src/house')

const flat = () => new FakeWorld({ fill: 'air' }).box([-20, 0, -20], [20, 9, 20], 'stone')
const BOX = { shape: 'box', corner: [3, 10, -2], size: [5, 5, 3], material: 'cobblestone', door: 'south', hollow: true }

/** What is built: "x,y,z" of every cobblestone in the box's bounding region. */
function built (w, [x0, y0, z0], [sx, sz, sy]) {
  const out = new Set()
  for (let y = y0; y < y0 + sy; y++) for (let z = z0; z < z0 + sz; z++) for (let x = x0; x < x0 + sx; x++) if (w.get(x, y, z) === 'cobblestone') out.add(`${x},${y},${z}`)
  return out
}

test('boxCells: a hollow 5x5x3 with a south door is 46 cells: three rings of 16, less the 1x2 gap', () => {
  const cells = boxCells({ ...BOX })
  assert.equal(cells.length, 46)
  const has = (x, y, z) => cells.some(c => c.pos.join() === [x, y, z].join())
  assert.ok(!has(5, 10, 2) && !has(5, 11, 2), 'the door gap: middle of the south wall, bottom two')
  assert.ok(has(5, 12, 2), 'and a block over it')
  assert.ok(!has(5, 10, 0), 'hollow')
  assert.equal(boxCells({ ...BOX, roof: true }).length, 46 + 9, 'roof: the 3x3 inside of the top layer too')
  assert.equal(boxCells({ ...BOX, hollow: false, door: undefined }).length, 75)
})

test('build a hollow 5x5x3 cobblestone box with a south door on flat ground', async () => {
  const w = flat()
  const s = setup(w, { pos: [0.5, 10, 0.5], walk: '3d', inv: { cobblestone: 64 } })
  const r = await run('build', s.act, { ...BOX })
  assert.equal(r.status, 'done', r.detail)
  assert.equal(r.detail, 'built a hollow 5x5x3 cobblestone box at [3, 10, -2] with a door to the south: placed 46, skipped 0 (already there), failed 0')
  assert.deepEqual([r.data.placed, r.data.skipped, r.data.failed_count], [46, 0, 0])
  const b = built(w, [3, 10, -2], [5, 5, 3])
  assert.equal(b.size, 46)
  assert.ok(!b.has('5,10,2') && !b.has('5,11,2') && b.has('5,12,2'))
  assert.equal(w.get(5, 10, 0), 'air', 'the inside is empty')
  // bottom-up: no block placed before every block of the layer below it (each place call's y never decreases)
  const ys = s.motor.calls.filter(c => c[0] === 'place').map(c => c[3][1])
  assert.deepEqual(ys, [...ys].sort((p, q) => p - q))
  // never stood in a cell it was building
  for (const c of s.motor.calls.filter(c => c[0] === 'goto')) assert.ok(!boxCells(BOX).some(x => x.pos[0] === Math.floor(c[1].pos[0]) && x.pos[2] === Math.floor(c[1].pos[2]) && x.pos[1] === Math.floor(c[1].pos[1])))
  assert.equal(s.motor.inventory().cobblestone, 64 - 46)
  // again: everything already there
  const again = await run('build', s.act, { ...BOX })
  assert.equal(again.status, 'done')
  assert.deepEqual([again.data.placed, again.data.skipped], [0, 46])
})

test('on a slope: the low side has air under its bottom row, built from its neighbours; the high side stands on ground', async () => {
  // ground top at y 9 for x < 6, y 8 for x >= 6: the box's east two columns hang one block over the slope
  const w = new FakeWorld({ fill: 'air' }).box([-20, 0, -20], [5, 9, 20], 'stone').box([6, 0, -20], [20, 8, 20], 'stone')
  const s = setup(w, { pos: [0.5, 10, 0.5], walk: '3d', inv: { cobblestone: 64 } })
  const r = await run('build', s.act, { ...BOX })
  assert.equal(r.status, 'done', r.detail)
  assert.equal(r.data.placed, 46)
  assert.equal(w.get(7, 10, -2), 'cobblestone')
  assert.equal(w.get(7, 9, -2), 'air', 'it does not fill under the shape')
})

test('a roofed box: the roof grows in from the walls (standing inside, through the door, for the middle)', async () => {
  const w = flat()
  const s = setup(w, { pos: [0.5, 10, 0.5], walk: '3d', inv: { cobblestone: 64 } })
  const r = await run('build', s.act, { ...BOX, roof: true })
  assert.equal(r.status, 'done', r.detail)
  assert.equal(r.data.placed, 55)
  assert.equal(w.get(5, 12, 0), 'cobblestone', 'the middle of the roof')
})

test('short of material: partial with the count missing; protected region: refused; something in the way: failed for that cell', async () => {
  const w = flat()
  const s = setup(w, { pos: [0.5, 10, 0.5], walk: '3d', inv: { cobblestone: 30 } })
  const r = await run('build', s.act, { ...BOX })
  assert.equal(r.status, 'partial')
  assert.equal(r.data.placed, 30)
  assert.deepEqual(r.data.short, { cobblestone: 16 })
  assert.match(r.detail, /placed 30, skipped 0 \(already there\), failed 0; short 16 cobblestone$/)

  const house = new HouseRules([{ name: 'base', dim: null, min: [6, 0, -10], max: [10, 20, 10] }])
  const h = setup(flat(), { pos: [0.5, 10, 0.5], walk: '3d', inv: { cobblestone: 64 }, house })
  const no = await run('build', h.act, { ...BOX })
  assert.equal(no.status, 'refused')
  assert.match(no.detail, /^house rules: no place inside protected region "base" \(\[6, 10, -2\]\) \(cell \[6, 10, -2\] of the build\)$/)
  assert.equal(h.motor.calls.filter(c => c[0] === 'place').length, 0, 'nothing placed')

  const o = flat().set(4, 10, -2, 'dirt')
  const t = setup(o, { pos: [0.5, 10, 0.5], walk: '3d', inv: { oak_planks: 4 } })
  const list = await run('build', t.act, { blocks: [{ block: 'oak_planks', pos: [4, 10, -2] }, { block: 'oak_planks', pos: [5, 10, -2] }, { block: 'oak_planks', pos: [5, 11, -2] }] })
  assert.equal(list.status, 'partial')
  assert.deepEqual([list.data.placed, list.data.failed_count], [2, 1])
  assert.deepEqual(list.data.failed[0], { pos: [4, 10, -2], reason: 'dirt is there (build never digs)' })
  assert.equal(o.get(4, 10, -2), 'dirt', 'never dug')
  assert.equal(o.get(5, 11, -2), 'oak_planks')
})

test('build arguments: a box or a block list, a door needs 3 high', async () => {
  const s = setup(flat(), { pos: [0.5, 10, 0.5], inv: {} })
  assert.match((await run('build', s.act, { shape: 'box', corner: [0, 10, 0] })).detail, /^build: give either \{shape: "box", corner, size, material\} or \{blocks/)
  assert.equal((await run('build', s.act, { ...BOX, size: [5, 5, 2] })).detail, 'build: a door needs a box at least 3 high (a 2-high gap and a block over it)')
  assert.equal((await run('build', s.act, { blocks: [{ block: 'unobtainium', pos: [0, 10, 0] }] })).detail, 'build: unknown block unobtainium')
})
