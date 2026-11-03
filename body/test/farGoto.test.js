'use strict'
// goto toward a far goal underground, with the real mineflayer-pathfinder
// A* (and movement rules) on 26.1 chunks. The pathfinder plugin's loop is
// stood in for by a small simulator with the plugin's semantics: plan
// (status partial while searching, then success / timeout / noPath), walk
// the path node by node (breaking toBreak blocks, 'diggingCompleted'), and
// go idle when a timed-out path runs out without reaching the goal.
// ATLAS_SLOW_TESTS=1 runs the far goal through a big block of stone (about a
// minute) instead of a confined slab.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('26.1')
const Chunk = require('prismarine-chunk')(registry)
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const { Motor } = require('../src/motor')
const { setup, run, world } = require('./verbHarness')

function underground ({ confined = true } = {}) {
  const cols = new Map()
  const col = (x, z) => { const k = `${x >> 4},${z >> 4}`; if (!cols.has(k)) cols.set(k, new Chunk({ minY: -64, worldHeight: 384 })); return cols.get(k) }
  const set = (x, y, z, n) => col(x, z).setBlockStateId(new Vec3(x & 15, y, z & 15), registry.blocksByName[n].defaultState)
  const blockAt = p => {
    const q = p.floored ? p.floored() : p
    const c = cols.get(`${q.x >> 4},${q.z >> 4}`)
    if (!c) return null
    const b = c.getBlock(new Vec3(q.x & 15, q.y, q.z & 15))
    b.position = new Vec3(q.x, q.y, q.z)
    return b
  }
  // a slab of solid stone (y 58-63, z -2..2) in a shell of bedrock the planner can't break: a long tunnel to dig
  // confined: a slab of solid stone (y 58-63, z -2..2) in a shell of bedrock the planner can't break (a quick test);
  // else a big block of solid stone, which is what makes one long search time out
  if (confined) for (let x = -8; x < 120; x++) for (let z = -3; z <= 3; z++) for (let y = 57; y <= 64; y++) set(x, y, z, Math.abs(z) === 3 || y === 57 || y === 64 || x === -8 ? 'bedrock' : 'stone')
  else for (let x = -8; x < 120; x++) for (let z = -8; z < 8; z++) for (let y = 50; y < 80; y++) set(x, y, z, 'stone')
  set(0, 60, 0, 'air'); set(0, 61, 0, 'air')
  return { set, blockAt }
}

/** A bot whose pathfinder is the real A* behind a plugin-like loop. */
function simBot (w, { neverPlans = false } = {}) {
  const bot = Object.assign(new EventEmitter(), {
    registry,
    version: '26.1',
    game: { dimension: 'overworld', minY: -64, height: 384, gameMode: 'survival' },
    entity: { position: new Vec3(0.5, 60, 0.5), effects: {}, onGround: true, eyeHeight: 1.62 },
    entities: {},
    inventory: { items: () => [], slots: [] },
    heldItem: null,
    blockAt: w.blockAt,
    canDigBlock: () => true,
    equip: async () => {},
    dig: async b => { w.set(b.position.x, b.position.y, b.position.z, 'air'); bot.emit('diggingCompleted', b) },
    setControlState: () => {},
    clearControlStates: () => {},
    plans: []
  })
  let goal = null; let path = []; let updated = false; let astar = null
  const tick = setInterval(() => {
    if (!goal) return
    const feet = bot.entity.position.floored()
    if (goal.isEnd(feet)) { const g = goal; goal = null; bot.emit('goal_reached', g); return }
    if (neverPlans) { bot.emit('path_update', { status: 'partial', path: [], visitedNodes: 42000, time: 15 }); return }
    if (astar) { // plan a little per tick, like the plugin (tickTimeout 40 ms)
      const r = astar.compute()
      if (r.status === 'partial') return
      astar = null
      bot.plans.push({ status: r.status, len: r.path.length })
      bot.emit('path_update', { status: r.status, path: r.path, visitedNodes: r.visitedNodes, time: r.time })
      path = r.path
      return
    }
    if (!path.length) {
      if (!updated) { updated = true; astar = new AStar(new Move(feet.x, feet.y, feet.z, 0, 0), bot.movements, goal, 5000, 40, -1) }
      return // a timed-out path that ran out: the plugin idles here
    }
    const n = path.shift()
    for (const b of n.toBreak) { w.set(b.x, b.y, b.z, 'air'); bot.emit('diggingCompleted', w.blockAt(new Vec3(b.x, b.y, b.z))) }
    bot.entity.position = new Vec3(n.x + 0.5, n.y, n.z + 0.5)
  }, 2)
  bot.pathfinder = {
    bestHarvestTool: () => null,
    setMovements: m => { bot.movements = m },
    setGoal: g => { goal = g; path = []; updated = false; astar = null },
    isMining: () => false
  }
  bot.stopSim = () => clearInterval(tick)
  return bot
}

test('far goal through solid stone, dig on: walked in 16-block legs, each plannable, and reached', { timeout: 120000 }, async () => {
  const w = underground({ confined: process.env.ATLAS_SLOW_TESTS !== '1' })
  const bot = simBot(w)
  try {
    const r = await new Motor(bot).goto({ pos: [100.5, 60, 0.5], range: 1, dig: true, stallMs: 8000 })
    assert.equal(r.status, 'reached')
    assert.ok(r.legs >= 6, `legs: ${r.legs}`)
    if (process.env.ATLAS_SLOW_TESTS !== '1') assert.ok(bot.plans.every(p => p.status === 'success'), `every leg planned in time: ${JSON.stringify(bot.plans)}`)
    assert.ok(Math.abs(bot.entity.position.x - 100.5) <= 1.5)
  } finally { bot.stopSim() }
})

test('the same goal in one search, in a big block of stone: the real planner times out with a partial path short of it', () => {
  const w = underground({ confined: false })
  const bot = simBot(w)
  bot.stopSim()
  const m = new Motor(bot)
  const { goals } = require('mineflayer-pathfinder')
  const a = new AStar(new Move(0, 60, 0, 0, 0), m.movements({ dig: true }), new goals.GoalNear(100.5, 60, 0.5, 1), 5000, 40, -1)
  let r = a.compute()
  while (r.status === 'partial') r = a.compute()
  assert.equal(r.status, 'timeout')
  assert.ok(r.path.length < 40, `a partial path of ${r.path.length} nodes`)
})

test('dig off through solid stone: no path, at once, with the reason', async () => {
  const w = underground()
  const bot = simBot(w)
  try {
    const t0 = Date.now()
    const r = await new Motor(bot).goto({ pos: [100.5, 60, 0.5], range: 1, dig: false })
    assert.ok(Date.now() - t0 < 15000)
    assert.equal(r.status, 'no_path')
    assert.match(r.why.text, /in front: stone \(dig off\)/)
  } finally { bot.stopSim() }
})

test('a planner that never returns a path: partial "no progress" within the watchdog, with the planner status', async () => {
  const w = underground()
  const bot = simBot(w, { neverPlans: true })
  try {
    const t0 = Date.now()
    const r = await new Motor(bot).goto({ pos: [30.5, 60, 0.5], range: 1, dig: true, planWatchMs: 1500, stallMs: 400 })
    const took = Date.now() - t0
    assert.equal(r.status, 'no_progress')
    assert.ok(took < 1500 + 1500, `took ${took} ms`)
    assert.equal(r.planner.status, 'partial')
    assert.equal(r.planner.visited, 42000)
    assert.deepEqual(r.planner.nearest, [0.5, 60, 0.5])
    assert.ok(r.recoveries >= 1, 'not moving counted although the pathfinder was "busy"')
  } finally { bot.stopSim() }
})

test('the pathfinder saying it is mining is not progress: a dig that never completes trips the watchdog', async () => {
  const w = underground()
  const bot = simBot(w, { neverPlans: true })
  bot.pathfinder.isMining = () => true
  try {
    const r = await new Motor(bot).goto({ pos: [30.5, 60, 0.5], range: 1, dig: true, planWatchMs: 1200, miningStallMs: 600 })
    assert.equal(r.status, 'no_progress')
  } finally { bot.stopSim() }
})

test('goto verb: no progress reads as a gave-up partial with the planner\'s status', async () => {
  const planner = { status: 'timeout', visited: 10020, ms: 5001, plan_end: [25, 60, 0], nearest: [-57.5, 63, -75.5], nearest_dist: 105.8 }
  const s = setup(world(), { goto: () => ({ status: 'no_progress', remaining: 105.8, moved: 0, recoveries: 3, tried: ['jump, re-planned'], planner, why: { text: 'feet air, head air, below stone' } }) })
  const r = await run('goto', s.act, { pos: [6, 82, 7] })
  assert.equal(r.status, 'partial')
  assert.equal(r.detail, 'gave up 105.8 blocks short of [6, 82, 7] (no path found yet: planner timeout after 5001 ms, 10020 nodes visited, its best plan ends at [25, 60, 0]; nearest point reached [-57.5, 63, -75.5], 105.8 blocks from the goal: feet air, head air, below stone); tried jump, re-planned')
  assert.deepEqual(r.data.planner, planner)
})
