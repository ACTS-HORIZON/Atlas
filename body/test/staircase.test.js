'use strict'
// mine with y: a 1-wide staircase down to y, then the strip-mine tunnel, on a
// fake voxel world with the real filtered API and sight checks.
const test = require('node:test')
const assert = require('node:assert/strict')
const { FakeWorld, setup, run } = require('./verbHarness')

/** Solid stone; the bot in a 1x2 pocket at (0, 10, 0), facing south (+z). */
function underground () {
  const w = new FakeWorld({ fill: 'stone' })
  w.box([0, 10, 0], [0, 11, 0], 'air')
  return w
}

const digs = motor => motor.calls.filter(c => c[0] === 'dig').map(c => c[1])

test('mine y: staircase down to y, then the tunnel at that level', async () => {
  const w = underground()
  const s = setup(w, { pos: [0.5, 10, 0.5], walk: '3d' })
  const below = []
  const dig = s.motor.dig.bind(s.motor)
  s.motor.dig = async (pos, o) => { const f = s.motor.pos.map(Math.floor); below.push(pos[0] === f[0] && pos[1] === f[1] - 1 && pos[2] === f[2]); return dig(pos, o) }
  const r = await run('mine', s.act, { block: 'iron_ore', count: 1, y: 4 }) // cfg: tunnel cap 6
  assert.equal(r.status, 'partial')
  assert.equal(r.detail, 'mined 0 of 1 iron_ore; strip-mining stopped: tunnel limit of 6 blocks reached')
  assert.deepEqual([r.data.y, r.data.stairs, r.data.at_y], [4, 6, 4])
  assert.equal(Math.floor(s.motor.pos[1]), 4, 'tunnelled at y 4')
  assert.ok(!below.some(Boolean), 'never dug the block under its own feet')
  const stairDigs = digs(s.motor).slice(0, 18)
  for (let i = 0; i < 6; i++) { // step i from y 10-i at z i: clears z i+1 at y 11-i, 10-i, 9-i
    assert.deepEqual(stairDigs.slice(i * 3, i * 3 + 3), [[0, 11 - i, i + 1], [0, 10 - i, i + 1], [0, 9 - i, i + 1]])
  }
  assert.ok(s.progress.some(p => /stairs 6.*staircase south, y 4 -> 4/.test(p)), s.progress.join('\n'))
})

test('mine y: the staircase stops at lava, without digging it or stepping toward it', async () => {
  const w = underground()
  w.set(0, 7, 3, 'lava')
  const s = setup(w, { pos: [0.5, 10, 0.5], walk: '3d' })
  const r = await run('mine', s.act, { block: 'iron_ore', count: 2, y: 0 })
  assert.equal(r.status, 'partial')
  assert.equal(r.detail, 'mined 0 of 2 iron_ore; staircase at y 8 stopped: lava ahead')
  assert.deepEqual([r.data.stairs, r.data.at_y, r.data.tunnel], [2, 8, 0])
  assert.ok(!digs(s.motor).some(p => p.join(',') === '0,7,3'), 'the lava was never dug')
  assert.equal(w.get(0, 7, 3), 'lava')
})

test('mine y: lava one block beyond the next step stops it before stepping', async () => {
  const w = underground()
  w.set(0, 8, 3, 'lava') // level with the step after next, one further on
  const s = setup(w, { pos: [0.5, 10, 0.5], walk: '3d' })
  const r = await run('mine', s.act, { block: 'iron_ore', y: 0 })
  assert.equal(r.detail, 'mined 0 of 1 iron_ore; staircase at y 9 stopped: lava ahead')
  assert.equal(Math.floor(s.motor.pos[1]), 9, 'no step toward it')
  assert.ok(!digs(s.motor).some(p => p.join(',') === '0,8,3'))
})

test('mine y: a drop under the next step stops it; a target in view on the way is mined', async () => {
  let w = underground()
  w.set(0, 7, 2, 'air').set(0, 6, 2, 'air') // a hole under the second step
  let s = setup(w, { pos: [0.5, 10, 0.5], walk: '3d' })
  let r = await run('mine', s.act, { block: 'iron_ore', y: 0 })
  assert.equal(r.detail, 'mined 0 of 1 iron_ore; staircase at y 9 stopped: a drop under the next step (air)')
  assert.equal(Math.floor(s.motor.pos[1]), 9, 'it did not step into the hole')

  w = underground()
  w.set(1, 8, 2, 'iron_ore') // beside the staircase: comes into view once the step is open
  s = setup(w, { pos: [0.5, 10, 0.5], walk: '3d' })
  r = await run('mine', s.act, { block: 'iron_ore', y: 0 })
  assert.equal(r.status, 'done')
  assert.equal(w.get(1, 8, 2), 'air')
})

test('mine y: already at or below y tunnels here; the schema bounds y', async () => {
  const w = underground()
  const s = setup(w, { pos: [0.5, 10, 0.5], walk: '3d' })
  const r = await run('mine', s.act, { block: 'coal_ore', y: 40 })
  assert.deepEqual([r.data.stairs, r.data.at_y], [0, 10])
  assert.match(r.detail, /strip-mining stopped: tunnel limit/)
  assert.equal((await run('mine', s.act, { block: 'coal_ore', y: -100 })).status, 'failed')
})
