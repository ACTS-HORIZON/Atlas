'use strict'
// goto when stuck: the real mineflayer-pathfinder movement rules on 26.1
// chunks (a spruce canopy, a stone box), and the motor's stall recovery and
// diagnosis driven by a stand-in pathfinder (no physics, no server).
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const registry = require('prismarine-registry')('26.1')
const Chunk = require('prismarine-chunk')(registry)
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')
const { goals } = require('mineflayer-pathfinder')
const { Motor } = require('../src/motor')
const { world: flatWorld, setup, run } = require('./verbHarness')

/** A world of real 26.1 chunks with a bot standing in it; pathfinder behaviour is scripted. */
function pathWorld ({ botAt, onGoal }) {
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
  for (let x = -12; x < 16; x++) for (let z = -12; z < 12; z++) { for (let y = 58; y < 64; y++) set(x, y, z, 'stone'); set(x, 64, z, 'grass_block') }
  const bot = Object.assign(new EventEmitter(), {
    registry,
    version: '26.1',
    game: { dimension: 'overworld', minY: -64, height: 384, gameMode: 'survival' },
    entity: { position: new Vec3(...botAt), effects: {}, onGround: true },
    entities: {},
    inventory: { items: () => [] },
    heldItem: null,
    controls: [],
    digs: [],
    goals: [],
    blockAt,
    canDigBlock: () => true,
    equip: async () => {},
    dig: async b => { bot.digs.push(b.name); set(b.position.x, b.position.y, b.position.z, 'air') },
    setControlState: (k, v) => bot.controls.push(`${k}:${v}`),
    clearControlStates: () => {},
    pathfinder: {
      bestHarvestTool: () => null,
      setMovements: m => { bot.movements = m },
      setGoal: g => { if (g) { bot.goals.push(g); setTimeout(() => onGoal && onGoal(bot, g, bot.goals.length), 10) } },
      isMining: () => false
    }
  })
  return { bot, set, blockAt }
}

/** A spruce: trunk at (0, 65..77, 0), leaves around it at y 70..78 (radius 2). */
function canopy (w, leaves = 'spruce_leaves') {
  for (let y = 70; y <= 78; y++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (dx || dz) w.set(dx, y, dz, leaves)
  for (let y = 65; y <= 77; y++) w.set(0, y, 0, 'spruce_log')
}

function plan (motor, start, goal) {
  const a = new AStar(new Move(...start, 0, 0), motor.movements_, goal, 10000, 40, -1)
  let r = a.compute()
  for (let i = 0; r.status === 'partial' && i < 50; i++) r = a.compute()
  return r
}

test('the real pathfinder rules plan down out of a spruce canopy only with dig on (leaves are breakable)', () => {
  const w = pathWorld({ botAt: [0.5, 78, 0.5] })
  canopy(w)
  const motor = new Motor(w.bot)
  const goal = new goals.GoalNear(10.5, 65, 0.5, 1)
  motor.movements_ = motor.movements({ dig: true })
  let r = plan(motor, [0, 78, 0], goal)
  assert.equal(r.status, 'success')
  const broken = r.path.flatMap(p => p.toBreak.map(b => w.blockAt(b).name))
  assert.ok(broken.includes('spruce_leaves'), 'it digs through the leaves')
  assert.ok(r.path.at(-1).y === 65, 'down to the ground')
  motor.movements_ = motor.movements({ dig: false })
  r = plan(motor, [0, 78, 0], goal)
  assert.equal(r.status, 'noPath', 'without digging the canopy is a trap (drops over 4 blocks are not allowed)')
})

test('canopy: a stall is recovered by digging the leaves in front, then the goto reaches the ground', async () => {
  const w = pathWorld({
    botAt: [0.5, 78, 0.5],
    onGoal: (bot, g, n) => {
      // first plan: the bot doesn't move (stuck in the canopy). After a recovery has
      // cleared the leaf in front, the re-plan works: walk out and down.
      if (n >= 2 && w.blockAt(new Vec3(1, 78, 0)).name === 'air') {
        bot.entity.position = new Vec3(10.5, 65, 0.5)
        bot.emit('goal_reached', g)
      }
    }
  })
  canopy(w)
  const r = await new Motor(w.bot).goto({ pos: [10.5, 65, 0.5], range: 1, dig: true, stallMs: 150, stuckMs: 3000 })
  assert.equal(r.status, 'reached')
  assert.equal(r.recoveries, 1)
  assert.deepEqual(w.bot.digs, ['spruce_leaves'])
  assert.match(r.tried[0], /^jump, dug spruce_leaves, re-planned$/)
  assert.ok(w.bot.controls.includes('jump:true') && w.bot.controls.includes('jump:false'))
})

test('boxed in by stone with dig off: no path, and the blocking block is named', async () => {
  const w = pathWorld({
    botAt: [0.5, 65, 0.5],
    onGoal: (bot) => bot.emit('path_update', { status: 'noPath', path: [] })
  })
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { w.set(x, 65, z, 'stone'); w.set(x, 66, z, 'stone') }
  w.set(0, 67, 0, 'stone')
  const motor = new Motor(w.bot)
  motor.movements_ = motor.movements({ dig: false })
  assert.equal(plan(motor, [0, 65, 0], new goals.GoalNear(10.5, 65, 0.5, 1)).status, 'noPath', 'the real rules agree')
  const r = await motor.goto({ pos: [10.5, 65, 0.5], range: 1, dig: false, stallMs: 150 })
  assert.equal(r.status, 'no_path')
  assert.equal(r.why.front_feet.name, 'stone')
  assert.equal(r.why.front_feet.breakable, false)
  assert.equal(r.why.text, 'feet air, head air, below grass_block; in front: stone (dig off) at [1, 65, 0], stone (dig off) at [1, 66, 0]; dig off, scaffold off; last plan: noPath, no next step')
})

test('boxed in, the pathfinder silently stalls: 3 recoveries (jump, re-plan; no digging with dig off), then stuck, with why', async () => {
  const w = pathWorld({ botAt: [0.5, 65, 0.5] })
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { w.set(x, 65, z, 'stone'); w.set(x, 66, z, 'stone') }
  const r = await new Motor(w.bot).goto({ pos: [10.5, 65, 0.5], range: 1, dig: false, stallMs: 100, stuckMs: 1500 })
  assert.equal(r.status, 'stuck')
  assert.equal(r.recoveries, 3, 'max 3 per goto')
  assert.deepEqual(r.tried, ['jump, re-planned', 'jump, re-planned', 'jump, re-planned'])
  assert.deepEqual(w.bot.digs, [], 'dig off: nothing dug')
  assert.match(r.why.text, /in front: stone \(dig off\) at \[1, 65, 0\]/)
})

test('the goto verb puts the why and what it tried in its result', async () => {
  const why = { feet: { name: 'air' }, front_feet: { name: 'spruce_leaves', solid: true, breakable: true }, dig: true, scaffold: true, plan: 'partial', next_step: null, text: 'feet air, head air, below spruce_log; in front: spruce_leaves (would dig) at [-13, 76, -10]; dig on, scaffold on; last plan: partial, no next step' }
  const s = setup(flatWorld(), { goto: () => ({ status: 'stuck', remaining: 13.3, moved: 0, recoveries: 3, tried: ['jump, dug spruce_leaves, re-planned', 'jump, re-planned', 'jump, re-planned'], why }) })
  const r = await run('goto', s.act, { pos: [0, 64, 10] })
  assert.equal(r.status, 'partial')
  assert.equal(r.detail, 'gave up 13.3 blocks short of [0, 64, 10] (stuck: feet air, head air, below spruce_log; in front: spruce_leaves (would dig) at [-13, 76, -10]; dig on, scaffold on; last plan: partial, no next step); tried jump, dug spruce_leaves, re-planned / jump, re-planned / jump, re-planned')
  assert.equal(r.data.recoveries, 3)
  assert.equal(r.data.why.front_feet.name, 'spruce_leaves')
  assert.equal(r.data.why.text, undefined, 'the text is in the detail, the data carries the fields')
})
