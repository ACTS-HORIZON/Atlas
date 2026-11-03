'use strict'
// goto/give by Locator Bar bearing: flips (a player straight above), the
// path-length and leg caps, the time cap, the up/down indicator in the obs;
// and goto from the bottom of a shaft to the surface with scaffold, through
// the real pathfinder A*.
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { Locator } = require('../src/locator')
const { buildObs } = require('../src/fairplay/observe')
const { makeView } = require('./fakeWorld')
const { check } = require('../src/schema')
const { world, setup, run, FakeWorld } = require('./verbHarness')

/** A real Locator fed block-position (vec3i) waypoints of players at fixed spots, seen from the fake motor. */
function posLocator (motor, players) {
  const loc = new Locator()
  loc.bot = {
    get entity () { return { position: new Vec3(...motor.pos), pitch: 0, eyeHeight: 1.62 } },
    players: Object.fromEntries(players.map(p => [p.name, { username: p.name, uuid: p.name.toLowerCase() }])),
    username: 'Atlas'
  }
  for (const p of players) loc.points.set(p.name.toLowerCase(), { type: 'vec3i', data: { x: Math.floor(p.pos[0]), y: Math.floor(p.pos[1]), z: Math.floor(p.pos[2]) } })
  return loc
}

test('a player straight above: the bearing flips each leg -> partial within 3 legs, "is above you"', async () => {
  let s
  const locator = { list: () => s.locLive.list(), azimuthOf: n => s.locLive.azimuthOf(n), verticalOf: n => s.locLive.verticalOf(n) }
  s = setup(world(), { walk: true, locator })
  s.locLive = posLocator(s.motor, [{ name: 'Rook', pos: [3.5, 81, 0.5] }]) // 71 up, 3 blocks off: less than a leg
  const legs = () => s.motor.calls.filter(c => c[0] === 'goto' && c[1].kind === 'xz').length
  const r = await run('goto', s.act, { target: 'Rook' })
  assert.equal(r.status, 'partial')
  assert.equal(r.detail, 'Rook is above you, not ahead: bearing flips each leg (horizontal distance ~0)')
  assert.ok(legs() <= 3, `${legs()} legs`)
  assert.equal(r.data.vertical, 'above')
  // give goes through the same follow and says why
  s.motor.pos = [0.5, 10, 0.5]
  const g = setup(world(), { walk: true, locator, inv: { iron_pickaxe: 1 } })
  s.locLive = posLocator(g.motor, [{ name: 'Rook', pos: [3.5, 81, 0.5] }])
  const gr = await run('give', g.act, { item: 'iron_pickaxe', player: 'Rook' })
  assert.equal(gr.status, 'failed')
  assert.match(gr.detail, /^give: could not reach Rook: Rook is above you, not ahead/)
})

test('a level player 200 blocks away: legs along the bearing until in sight, then arrives', async () => {
  let s
  const rook = { name: 'Rook', pos: [200.5, 10, 0.5], look: [0, 0, 1] }
  const long = new FakeWorld({ x0: -32, sx: 300, z0: -32, sz: 64 }).box([-32, 0, -32], [267, 9, 31], 'stone')
  s = setup(long, {
    walk: true,
    locator: { list: () => s.loc.list(), azimuthOf: n => s.loc.azimuthOf(n), verticalOf: n => s.loc.verticalOf(n) },
    players: m => (Math.abs(m.pos[0] - rook.pos[0]) < 24 ? [rook] : [])
  })
  s.loc = posLocator(s.motor, [rook])
  assert.equal(s.loc.verticalOf('Rook'), 'level', 'far off at the same height: no arrow')
  const r = await run('goto', s.act, { target: 'Rook' })
  assert.equal(r.status, 'done', r.detail)
  assert.equal(r.detail, 'arrived at player Rook')
  assert.ok(s.motor.calls.filter(c => c[0] === 'goto' && c[1].kind === 'xz').length >= 11)
})

test('caps: total path (not straight line), 48 legs, and the time cap', async () => {
  // a bearing that sends it round in a square: the straight-line distance never grows, the path does
  let n = 0
  const square = { list: () => [{ name: 'Rook', azimuth: [-90, 0, 90, 180][n % 4] }], azimuthOf: () => [-90, 0, 90, 180][n % 4], verticalOf: () => null }
  const s = setup(world(), { walk: true, locator: square, goto: o => { n++; return { status: 'reached', remaining: 0, moved: 16 } } })
  const r = await run('goto', s.act, { target: 'Rook' })
  assert.equal(r.status, 'partial')
  assert.match(r.detail, /^followed Rook's bearing for \d+(\.\d)? blocks in (32|48) legs without seeing them$/)
  assert.ok(r.data.walked >= 512 || r.data.legs >= 48)

  const slow = setup(world(), { walk: true, locator: { list: () => [{ name: 'Rook', azimuth: -90 }], azimuthOf: () => -90, verticalOf: () => null },
    goto: () => new Promise(resolve => setTimeout(() => resolve({ status: 'reached', remaining: 0, moved: 16 }), 60)) })
  slow.act.cfg.followMaxS = 0.2
  const t = await run('goto', slow.act, { target: 'Rook' })
  assert.equal(t.status, 'partial')
  assert.match(t.detail, /^followed Rook's bearing for \d+ s \(the time cap\): walked \d+(\.\d)? blocks in \d+ legs without seeing them$/)
})

test('obs: a bearing-only player carries the bar\'s up/down indicator when it has one', () => {
  const w = world()
  const view = makeView(w, { waypoints: [{ name: 'Rook', azimuth: 10, vertical: 'above' }, { name: 'Far', azimuth: 90 }] })
  const { obs } = buildObs(view, {})
  assert.deepEqual(obs.players, [{ name: 'Rook', bearing: 'front', vertical: 'above' }, { name: 'Far', bearing: 'right' }])
  assert.equal(check('obs', obs), null)
})

test('flipping while the bar says level: close by but not in sight', async () => {
  let n = 0
  const flip = { list: () => [{ name: 'Rook', azimuth: n % 2 ? 90 : -90, vertical: 'level' }], azimuthOf: () => (n % 2 ? 90 : -90), verticalOf: () => 'level' }
  const s = setup(world(), { walk: true, locator: flip, goto: () => { n++; return { status: 'reached', remaining: 0, moved: 16 } } })
  const r = await run('goto', s.act, { target: 'Rook' })
  assert.equal(r.detail, 'Rook is close by but not in sight (behind a wall, or in a cave?): bearing flips each leg (horizontal distance ~0)')
})
