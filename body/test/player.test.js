'use strict'
// The player loop (src/player) without the model: the offered-action filter
// on fake worlds, the reflex view, a scripted chooser driving the loop up a
// 20-block shaft and to a visible player, the play verb, the override, the
// tick log, the decision-model client, and that the loop never blocks the
// event loop (the obs builder keeps running).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { FakeWorld } = require('./fakeWorld')
const { setup, run } = require('./verbHarness')
const { offeredActions, SURVIVAL } = require('../src/player/offered')
const { reflexView, tokens, MAX_TOKENS } = require('../src/player/view')
const { PlayerLoop } = require('../src/player/loop')
const { DecisionClient, ScriptedChooser } = require('../src/player/client')

/** A probe straight from a fake world (no sight filter needed for the rules). */
function probe (w, { feet = [0, 10, 0], dir = 'south', inventory = {}, food = 20, foods = [], threats = [] } = {}) {
  return { feet, dir, cls: (x, y, z) => w.classAt(x, y, z), inventory, food, foods, threats, houseOk: () => true, onGround: true }
}
const flat = () => new FakeWorld({ fill: 'air' }).box([-20, 0, -20], [20, 9, 20], 'stone')

test('offered: lava ahead -> no step or sprint; a drop over 3 -> no step; 3 or less -> step', () => {
  let w = flat().set(0, 10, 1, 'lava')
  let o = offeredActions(probe(w))
  assert.ok(!o.includes('step') && !o.includes('sprint'), o.join(' '))
  w = flat().set(0, 9, 1, 'lava') // lava as the floor ahead
  assert.ok(!offeredActions(probe(w)).includes('step'))
  w = flat().box([-1, 4, 1], [1, 9, 3], 'air') // a 6-deep pit ahead
  assert.ok(!offeredActions(probe(w)).includes('step'), 'a drop of 6')
  w = flat().box([-1, 7, 1], [1, 9, 3], 'air') // 3 deep
  o = offeredActions(probe(w))
  assert.ok(o.includes('step'), '3 is fine')
  w = flat()
  o = offeredActions(probe(w))
  assert.ok(o.includes('step') && o.includes('sprint'))
  assert.ok(!offeredActions(probe(w, { food: 4 })).includes('sprint'), 'no sprinting hungry')
})

test('offered: air under the block below -> no dig_below; stone under it -> dig_below', () => {
  let w = flat().set(0, 8, 0, 'air') // the block under the feet floats over air
  assert.ok(!offeredActions(probe(w)).includes('dig_below'))
  w = flat()
  assert.ok(offeredActions(probe(w)).includes('dig_below'))
  w = flat().set(0, 8, 0, 'lava')
  assert.ok(!offeredActions(probe(w)).includes('dig_below'), 'not into lava either')
  w = flat().set(0, 9, 0, 'bedrock')
  assert.ok(!offeredActions(probe(w)).includes('dig_below'), 'bedrock can not be dug')
})

test('offered: cobblestone in inventory -> place_below_and_jump; none -> not; no food -> no eat', () => {
  const w = flat()
  assert.ok(offeredActions(probe(w, { inventory: { cobblestone: 5 } })).includes('place_below_and_jump'))
  assert.ok(!offeredActions(probe(w)).includes('place_below_and_jump'))
  assert.ok(!offeredActions(probe(w, { food: 10 })).includes('eat'), 'no food')
  assert.ok(offeredActions(probe(w, { food: 10, foods: ['bread'] })).includes('eat'))
  assert.ok(!offeredActions(probe(w, { food: 20, foods: ['bread'] })).includes('eat'), 'not hungry')
  const roofed = flat().set(0, 12, 0, 'stone')
  assert.ok(!offeredActions(probe(roofed, { inventory: { cobblestone: 5 } })).includes('place_below_and_jump'), 'no room to rise')
  assert.ok(offeredActions(probe(roofed)).includes('dig_above'))
})

test('offered: threats -> attack in reach, retreat when a safe step away exists; survive mode is survival-only', () => {
  const w = flat()
  const zombie = [{ type: 'zombie', rel: [0, 0, 2], dist: 2 }]
  const o = offeredActions(probe(w, { threats: zombie }))
  assert.ok(o.includes('attack') && o.includes('retreat'))
  assert.ok(!o.includes('block'), 'no shield')
  assert.ok(offeredActions(probe(w, { threats: zombie, inventory: { shield: 1 } })).includes('block'))
  const s = offeredActions(probe(w, { threats: zombie, foods: ['bread'], food: 10 }), 'survive')
  assert.ok(s.every(a => SURVIVAL.has(a)), s.join(' '))
  assert.ok(s.includes('continue_task') && !s.includes('done') && !s.includes('step'))
  assert.deepEqual(offeredActions(probe(w), 'play').slice(-2), ['done', 'stuck'])
})

test('reflex view: hazards around and below, threats, recent, offered, within 250 tokens', () => {
  const w = flat().set(1, 10, 0, 'lava').box([-1, 3, -1], [-1, 9, -1], 'air')
  const p = probe(w)
  const obs = { self: { health: 14, food: 17, held: 'stone_pickaxe', on_ground: true },
    entities: [{ type: 'zombie', rel: [3, 0, 1], dist: 3.2, bearing: 'front-left', approaching: true, hostile: true }, { type: 'cow', dist: 2, hostile: false }],
    surroundings: { summary: 'on open flat ground', sky: true } }
  const v = reflexView({ obs, probe: p, intent: 'walk to Rook', target: 'Rook', recent: [{ action: 'step', effect: 'moved 1' }], offered: offeredActions(p) })
  assert.deepEqual(v.threats, [{ type: 'zombie', bearing: 'front-left', dist: 3.2, approaching: true }])
  assert.ok(v.hazards.includes('lava east'), v.hazards.join(', '))
  assert.ok(v.hazards.some(h => /north-west/.test(h)), 'the pit to the north-west')
  assert.equal(v.intent, 'walk to Rook (target: Rook)')
  assert.ok(tokens(v) <= MAX_TOKENS, `${tokens(v)} tokens`)
})

/** A shaft world: stone x/z -3..3 up to y 29, a 1x2 pocket at (0, 10..11, 0), open air above y 29. */
function shaftWorld () {
  return new FakeWorld({ fill: 'air' }).box([-3, 0, -3], [3, 29, 3], 'stone').box([0, 10, 0], [0, 11, 0], 'air')
}

/** "get to the surface", as a scripted policy: dig above, pillar up, done once out under the sky. */
const climb = v => {
  if (v.sky && !/1-wide shaft/.test(v.surroundings || '')) return 'done'
  if (v.offered.includes('dig_above')) return 'dig_above'
  if (v.offered.includes('place_below_and_jump')) return 'place_below_and_jump'
  return 'stuck'
}

test('scripted chooser: up a 20-block shaft by dig_above / place_below_and_jump until open sky -> done', async () => {
  const w = shaftWorld()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-player-'))
  const s = setup(w, { pos: [0.5, 10, 0.5], inv: { cobblestone: 64 } })
  const loop = new PlayerLoop({ chooser: new ScriptedChooser(climb), logDir: dir, hz: 1000 })
  const r = await loop.run(s.api, { intent: 'get to the surface', budgetTicks: 200 })
  assert.equal(r.end, 'done')
  assert.equal(r.to[1], 29, 'feet in the top layer, head out under the sky')
  assert.equal(r.dug, 18, 'dug the 18 blocks above the pocket (y 12..29)')
  assert.equal(r.placed, 19)
  await loop.close()
  const lines = fs.readFileSync(r.log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(lines.length, r.ticks)
  assert.deepEqual(Object.keys(lines[0]).sort(), ['chosen', 'effect', 'intent', 'latency_ms', 'mode', 'offered', 'probabilities', 'target', 'timed_out', 'ts', 'view'])
  assert.equal(lines[0].chosen, 'dig_above')
  assert.equal(lines[0].effect, 'dug stone above')
  assert.equal(lines.at(-1).chosen, 'done')
  assert.equal(loop.last.length, 10, 'the dashboard keeps the last 10')
})

test('scripted chooser: walk to a visible player -> done next to them', async () => {
  const w = flat()
  const rook = { name: 'Rook', pos: [0.5, 10, 8.5], look: [0, 0, -1] }
  const s = setup(w, { pos: [0.5, 10, 0.5], walk: true, players: [rook] })
  const near = () => Math.hypot(s.motor.pos[0] - rook.pos[0], s.motor.pos[2] - rook.pos[2]) <= 1.5
  const loop = new PlayerLoop({ chooser: new ScriptedChooser(v => (near() ? 'done' : v.self.facing !== 'south' ? 'turn_left' : 'step')), hz: 1000 })
  const r = await loop.run(s.api, { intent: 'walk to Rook', target: 'Rook', budgetTicks: 40 })
  assert.equal(r.end, 'done')
  assert.ok(near())
  assert.equal(r.moved, 7)
})

test('play verb: runs the loop with the intent; detail says how it ended and what changed', async () => {
  const s = setup(shaftWorld(), { pos: [0.5, 10, 0.5], inv: { cobblestone: 64 } })
  s.act.player = new PlayerLoop({ chooser: new ScriptedChooser(climb), hz: 1000 })
  const r = await run('play', s.act, { intent: 'get to the surface', budget: 30 })
  assert.equal(r.status, 'done')
  assert.match(r.detail, /^play "get to the surface": done after \d+ ticks; moved 19 blocks \(\[0.5, 10, 0.5\] → \[0.5, 29, 0.5\]\), dug 18, placed 19, damage 0$/)
  assert.equal(r.data.end, 'done')
  const t = setup(shaftWorld(), { pos: [0.5, 10, 0.5] }) // no blocks: it can dig up but not climb
  t.act.player = new PlayerLoop({ chooser: new ScriptedChooser(climb), hz: 1000 })
  const p = await run('play', t.act, { intent: 'get to the surface', budget: { ticks: 50 } })
  assert.equal(p.status, 'partial')
  assert.match(p.detail, /the player is stuck after \d+ ticks/)
  const b = setup(shaftWorld(), { pos: [0.5, 10, 0.5] })
  b.act.player = new PlayerLoop({ chooser: new ScriptedChooser(() => 'wait'), hz: 1000 })
  const q = await run('play', b.act, { intent: 'wait around', budget: { ticks: 5 } })
  assert.match(q.detail, /out of budget after 5 ticks/)
  const n = setup(shaftWorld())
  assert.deepEqual(await run('play', n.act, { intent: 'x' }), { status: 'failed', detail: 'play: no decision model configured (ATLAS_PLAYER_URL)' })
})

test('override: a non-continue answer pauses the verb, ~1 s (20 ticks) of continue_task resumes it, too long paused interrupts', async () => {
  const s = setup(flat(), { pos: [0.5, 10, 0.5] })
  const seq = [...Array(5).fill('continue_task'), 'jump', ...Array(25).fill('continue_task')]
  const loop = new PlayerLoop({ chooser: new ScriptedChooser(() => seq.shift() || 'continue_task'), hz: 1000 })
  let done = false
  const w = loop.watch(s.api, { settled: () => done, interrupt: () => assert.fail('no interrupt') })
  await new Promise(resolve => setTimeout(resolve, 300))
  done = true
  const out = await w
  const pr = s.motor.calls.filter(c => c[0] === 'pause' || c[0] === 'resume').map(c => c[0])
  assert.deepEqual(pr, ['pause', 'resume'])
  assert.equal(out.pauses, 1)
  const offered = loop.last.at(-1).offered
  assert.ok(offered.includes('continue_task') && offered.every(a => SURVIVAL.has(a)))

  const t = setup(flat(), { pos: [0.5, 10, 0.5] })
  const l2 = new PlayerLoop({ chooser: new ScriptedChooser(() => 'wait'), hz: 200, maxPauseMs: 100 })
  let why = null
  const o2 = await l2.watch(t.api, { settled: () => why !== null, interrupt: r => { why = r } })
  assert.equal(o2.interrupted, true)
  assert.equal(why, 'the player loop paused it to survive and could not resume it')
  assert.deepEqual(t.motor.calls.filter(c => c[0] === 'pause' || c[0] === 'resume').map(c => c[0]), ['pause', 'resume'])
})

test('timing: the loop never blocks the event loop (a slow model, and the obs builder keeps running)', async () => {
  const s = setup(shaftWorld(), { pos: [0.5, 10, 0.5], inv: { cobblestone: 64 } })
  const slow = new ScriptedChooser(async v => { await new Promise(resolve => setTimeout(resolve, 30)); return 'wait' })
  const loop = new PlayerLoop({ chooser: slow, hz: 20 })
  let fired = 0; let maxLag = 0; let obsBuilt = 0; let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now(); maxLag = Math.max(maxLag, now - last - 10); last = now; fired++
    if (s.api.observe()) obsBuilt++ // what the body's periodic full view does
  }, 10)
  const r = await loop.run(s.api, { intent: 'wait around', budgetMs: 1000 })
  clearInterval(timer)
  assert.equal(r.end, 'budget')
  assert.ok(fired >= 60, `the 10 ms timer fired ${fired} times in 1 s`)
  assert.ok(obsBuilt >= 60, `${obsBuilt} full obs built alongside`)
  assert.ok(maxLag < 50, `worst lag ${maxLag} ms`)
  assert.ok(r.ticks >= 15 && r.ticks <= 21, `${r.ticks} ticks at 20 Hz with a 30 ms model`)
})

test('decision client: the request, the answer, wait on timeout or an answer not offered, latency stats', async () => {
  const sent = []
  const reply = (body, ms = 0) => async (url, init) => {
    sent.push(JSON.parse(init.body))
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms)
      init.signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })) })
    })
    return { ok: true, json: async () => body }
  }
  const ok = { model: 'd1-2B', answers: { action: { type: 'choice', choice: 'retreat', probabilities: { retreat: 0.5, wait: 0.2 }, confidence: 0.5 } } }
  let c = new DecisionClient({ url: 'http://horizon:9931/v1/systemone', model: 'd1-2B', fetchImpl: reply(ok) })
  let r = await c.choose({ self: { health: 9 } }, ['retreat', 'wait'])
  assert.equal(r.choice, 'retreat')
  assert.deepEqual(r.probabilities, { retreat: 0.5, wait: 0.2 })
  assert.deepEqual(sent[0], { model: 'd1-2B', state: { self: { health: 9 } }, questions: { action: { type: 'choice', question: sent[0].questions.action.question, choices: ['retreat', 'wait'] } } })
  r = await c.choose({}, ['wait', 'step']) // answers retreat, which isn't offered
  assert.equal(r.choice, 'wait')
  c = new DecisionClient({ url: 'x', timeoutMs: 40, fetchImpl: reply(ok, 200) })
  const t0 = Date.now()
  r = await c.choose({}, ['retreat', 'wait'])
  assert.deepEqual([r.choice, r.timedOut], ['wait', true])
  assert.ok(Date.now() - t0 < 150, 'gave up at the 40 ms budget')
  c = new DecisionClient({ url: 'x', fetchImpl: async () => { throw new Error('ECONNREFUSED') } })
  r = await c.choose({}, ['step', 'wait'])
  assert.deepEqual([r.choice, r.error], ['wait', 'ECONNREFUSED'])
  assert.match(c.stats.report(), /^\[player\] 1 ticks, latency p50 [\d.]+ ms p95 [\d.]+ ms, 0 timeouts, 1 errors$/)
})
