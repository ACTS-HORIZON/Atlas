'use strict'
// Watched verbs (Session 8): args.watch on a long verb fires a sub-call on sight, holds the verb meanwhile,
// and the verb carries on and finishes. Real runner, real filtered API and sight, real explore and mine
// verbs; a fake motor that walks one block per few ms and honours the holds.
const test = require('node:test')
const assert = require('node:assert/strict')
const { FakeWorld } = require('./fakeWorld')
const { setup } = require('./verbHarness')
const { Runner, checkWatch } = require('../src/runner')
const { VERBS } = require('../src/verbs')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Stone ground (top at y 9) from z 15 north to z -95, open air above; ores set into the ground. */
function longWorld (ores = []) {
  const w = new FakeWorld({ x0: -16, sx: 32, y0: 0, sy: 32, z0: -96, sz: 112 }).box([-16, 0, -96], [15, 9, 15], 'stone')
  for (const [x, z, type] of ores) w.set(x, 9, z, type || 'iron_ore')
  return w
}

/** The fake motor walks: one block every msPerBlock, holding still while its lane is held. */
function walker (motor, msPerBlock = 4) {
  motor.goto = async function (o) {
    this.calls.push(['goto', o.lane || 'main', o.kind || 'near'])
    const look = o.kind === 'look'
    const target = look ? [o.pos[0] + 0.5, this.pos[1], o.pos[2] + 1.5] : [o.pos[0], this.pos[1], o.pos[2]]
    const range = look ? 0.1 : (o.range ?? 1)
    let moved = 0
    for (;;) {
      if (o.signal?.aborted) return { status: 'aborted', remaining: 1, moved }
      if (this.held(o.lane)) { await sleep(5); continue }
      const dx = target[0] - this.pos[0]; const dz = target[2] - this.pos[2]; const d = Math.hypot(dx, dz)
      if (d <= range + 0.01) return { status: 'reached', remaining: Math.round(d * 10) / 10, moved: Math.round(moved) }
      const s = Math.min(1, d)
      this.pos = [this.pos[0] + dx / d * s, this.pos[1], this.pos[2] + dz / d * s]
      moved += s
      await sleep(msPerBlock)
    }
  }
  motor.look = async function () {} // explore's look-around pause: instant here
  return motor
}

function rig (ores, opt = {}) {
  const w = longWorld(ores)
  const s = setup(w, { pos: [0.5, 10, 0.5], inv: { stone_pickaxe: 1 }, ...opt })
  walker(s.motor, opt.msPerBlock)
  s.act.cfg.watchTickMs = 30
  s.world = w
  return s
}

test('a watch fires once on sight: the verb is held, the sub-call runs, the verb resumes and finishes', async () => {
  const s = rig([[2, -6]])
  const runner = new Runner()
  const running = runner.run(s.act, { id: 'c1', verb: 'explore', args: { direction: 'north', distance: 40, watch: [{ see: 'iron_ore', do: { verb: 'mine', args: { block: 'iron_ore', count: 1 } } }] } })
  // while the sub-call runs, the obs task shows it under the parent
  let sub = null
  for (let i = 0; i < 200 && !sub; i++) { await sleep(5); sub = runner.task() && runner.task().sub }
  assert.ok(sub, 'task.sub while the watch runs')
  assert.equal(sub.verb, 'mine')
  assert.equal(sub.id, 'c1.w1')
  assert.deepEqual(runner.task().args.watch[0].see, 'iron_ore', 'the task still shows the watch')
  const r = await running
  assert.equal(r.status, 'done', r.detail)
  assert.match(r.detail, /^walked [\d.]+ blocks north; .*; watched: mined 1 iron_ore/)
  assert.equal(r.data.watched.length, 1)
  const w = r.data.watched[0]
  assert.deepEqual([w.id, w.see, w.seen, w.verb, w.status], ['c1.w1', 'iron_ore', 'block', 'mine', 'done'])
  assert.deepEqual(w.at, [2, 9, -6])
  assert.equal(s.world.get(2, 9, -6), 'air', 'the ore is gone')
  // between hold and release only the watch lane moved; the explore went on after
  const calls = s.motor.calls.map(c => c[0] === 'goto' ? `goto:${c[1]}` : c[0])
  const h = calls.indexOf('hold'); const rel = calls.indexOf('release')
  assert.ok(h >= 0 && rel > h, calls.join(' '))
  assert.ok(calls.slice(h, rel).every(c => c !== 'goto:main'), 'the parent held still')
  assert.ok(calls.slice(rel).includes('goto:main'), 'the parent resumed')
  assert.ok(s.motor.pos[2] < -35, `and finished its walk north (z ${s.motor.pos[2]})`)
  assert.equal(s.motor.watchHold, false)
})

test('max caps a watch; without it a new sighting fires again; a failing sub-call does not fail the parent', async () => {
  const ores = [[2, -6], [2, -60]] // the second comes into sight (32 blocks) only on the way
  const capped = rig(ores)
  const r1 = await new Runner().run(capped.act, { id: 'c2', verb: 'explore', args: { direction: 'north', distance: 75, watch: [{ see: 'iron_ore', do: { verb: 'mine', args: { block: 'iron_ore' } }, max: 1 }] } })
  assert.equal(r1.status, 'done', r1.detail)
  assert.equal(r1.data.watched.length, 1, 'max 1: once')

  const free = rig(ores)
  const r2 = await new Runner().run(free.act, { id: 'c3', verb: 'explore', args: { direction: 'north', distance: 75, watch: [{ see: 'iron_ore', do: { verb: 'mine', args: { block: 'iron_ore' } } }] } })
  assert.equal(r2.status, 'done', r2.detail)
  assert.deepEqual(r2.data.watched.map(w => w.at), [[2, 9, -6], [2, 9, -60]], 'unlimited: each new ore')
  assert.match(r2.detail, /; watched: mined 1 iron_ore.*; mined 1 iron_ore/)

  const bad = rig([[2, -6]])
  const r3 = await new Runner().run(bad.act, { id: 'c4', verb: 'explore', args: { direction: 'north', distance: 30, watch: [{ see: 'iron_ore', do: { verb: 'mine', args: { block: 'diamond_ore' } } }] } })
  assert.equal(r3.status, 'done', 'the parent still finishes: ' + r3.detail)
  assert.notEqual(r3.data.watched[0].status, 'done')
  assert.match(r3.detail, /; watched: mine (failed|partial): /)
})

test('stop during a sub-call ends both, and lets go of the hold', async () => {
  const s = rig([[2, -6]], { msPerBlock: 15 })
  const runner = new Runner()
  const running = runner.run(s.act, { id: 'c5', verb: 'explore', args: { direction: 'north', distance: 60, watch: [{ see: 'iron_ore', do: { verb: 'goto', args: { pos: [0.5, 10, 80.5] } } }] } })
  for (let i = 0; i < 400 && !(runner.task() && runner.task().sub); i++) await sleep(5)
  assert.ok(runner.task().sub, 'the sub-call (a long goto south) is running')
  await sleep(60)
  assert.deepEqual(runner.stop(s.act, 'the dashboard'), { status: 'done', detail: 'stopped explore' })
  const r = await running
  assert.equal(r.status, 'interrupted')
  assert.match(r.detail, /^explore: stopped by the dashboard.*; watched: goto interrupted: goto: stopped by the dashboard/)
  assert.equal(r.data.watched[0].status, 'interrupted')
  assert.equal(runner.task(), null)
  assert.equal(s.motor.watchHold, false)
  const z = s.motor.pos[2]
  await sleep(80)
  assert.equal(s.motor.pos[2], z, 'nothing moves after stop')
})

test('watch arguments: only on long verbs, no nested watches, valid sub-calls; the verb never sees them', async () => {
  assert.equal(checkWatch('explore', [{ see: 'iron_ore', do: { verb: 'mine', args: { block: 'iron_ore', count: 8 } } }], VERBS), null)
  assert.match(checkWatch('craft', [{ see: 'x', do: { verb: 'say', args: {} } }], VERBS), /watch is only for goto, explore, mine, collect/)
  assert.match(checkWatch('explore', [{ see: 'iron_ore', do: { verb: 'mine', args: { block: 'iron_ore', watch: [] } } }], VERBS), /nested watches are not allowed/)
  assert.match(checkWatch('explore', [{ see: 'zombie', do: { verb: 'stop' } }], VERBS), /cannot be a watch's sub-call/)
  assert.match(checkWatch('explore', [{ see: 'zombie', do: { verb: 'fly' } }], VERBS), /cannot be a watch's sub-call/)
  assert.match(checkWatch('explore', [{ see: 'zombie', do: { verb: 'say', args: { text: 'hi' } }, max: 0 }], VERBS), /max must be/)
  assert.match(checkWatch('explore', [], VERBS), /list of 1 to 8/)
  const s = rig([])
  const r = await new Runner().run(s.act, { id: 'c6', verb: 'craft', args: { item: 'stick', watch: [{ see: 'x', do: { verb: 'say', args: {} } }] } })
  assert.deepEqual(r, { status: 'failed', detail: 'craft: watch is only for goto, explore, mine, collect' })
  // a watch on an entity: fires when it comes into sight; the verb finishes with nothing else watched
  const z = rig([], { entities: [{ id: 3, type: 'zombie', pos: [0.5, 10, -20.5], hostile: true }] })
  const said = []
  z.act.chat = t => said.push(t)
  const r2 = await new Runner().run(z.act, { id: 'c7', verb: 'goto', args: { pos: [0.5, 10, -10.5], watch: [{ see: 'zombie', do: { verb: 'say', args: { text: 'zombie ahead' } } }] } })
  assert.equal(r2.status, 'done', r2.detail)
  assert.equal(r2.data.watched.length, 1)
  assert.equal(r2.data.watched[0].seen, 'entity')
  assert.deepEqual(said, ['zombie ahead'])
})

test('the real Motor: a watch holds only the main lane, the player loop holds both; the watch API runs on the watch lane', async () => {
  const { Motor } = require('../src/motor')
  const { EventEmitter } = require('events')
  const bot = Object.assign(new EventEmitter(), { entity: { position: { x: 0, y: 64, z: 0 } }, pathfinder: { setGoal () {} }, clearControlStates () {} })
  const m = new Motor(bot)
  assert.deepEqual([m.held(), m.held('watch')], [false, false])
  await m.holdMain()
  assert.deepEqual([m.held(), m.held('watch')], [true, false], 'a watch: the running verb holds, its sub-call moves')
  m.pause()
  assert.deepEqual([m.held(), m.held('watch')], [true, true], 'the player loop: everything holds')
  m.resume(); m.releaseMain()
  assert.deepEqual([m.held(), m.held('watch')], [false, false])
  // forWatch: the sub-call's goto and dig carry lane "watch"; everything else is the same API
  const s = setup(longWorld([]))
  const seen = []
  s.motor.goto = async o => { seen.push(['goto', o.lane]); return { status: 'reached', remaining: 0, moved: 0 } }
  const orig = s.motor.dig.bind(s.motor)
  s.motor.dig = (pos, o = {}) => { seen.push(['dig', o.lane]); return orig(pos, o) }
  const sub = s.api.forWatch()
  await sub.goto([1, 10, 1])
  await sub.digRel(0, -1, 0)
  await s.api.goto([1, 10, 1])
  assert.deepEqual(seen, [['goto', 'watch'], ['dig', 'watch'], ['goto', undefined]])
  assert.equal(sub.places, s.api.places)
})
