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
  assert.deepEqual(Object.keys(lines[0]).sort(), ['chosen', 'confidence', 'criteria', 'effect', 'intent', 'latency_ms', 'margin', 'mode', 'offered', 'probabilities', 'source', 'target', 'timed_out', 'ts', 'view'])
  assert.equal(lines[0].source, 'player')
  assert.equal(lines[0].criteria.dig_above, 'break the stone block above you (sky not visible)')
  assert.equal(lines[0].chosen, 'dig_above')
  assert.equal(lines[0].effect, 'dug stone above')
  assert.equal(lines.at(-1).chosen, 'done')
  assert.equal(loop.last.length, 20, 'the dashboard keeps the last 20')
  assert.ok(loop.series.length >= 20 && loop.series.every(x => typeof x.ms === 'number' && x.mode === 'play'), 'the 60 s latency series')
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

test('play verb (enabled with ATLAS_PLAYER_PLAY=1): runs the loop with the intent; detail says how it ended and what changed', async () => {
  const on = x => { x.act.cfg.playerPlay = true; return x }
  const s = on(setup(shaftWorld(), { pos: [0.5, 10, 0.5], inv: { cobblestone: 64 } }))
  s.act.player = new PlayerLoop({ chooser: new ScriptedChooser(climb), hz: 1000 })
  const r = await run('play', s.act, { intent: 'get to the surface', budget: 30 })
  assert.equal(r.status, 'done')
  assert.match(r.detail, /^play "get to the surface": done after \d+ ticks; moved 19 blocks \(\[0.5, 10, 0.5\] → \[0.5, 29, 0.5\]\), dug 18, placed 19, damage 0$/)
  assert.equal(r.data.end, 'done')
  const t = on(setup(shaftWorld(), { pos: [0.5, 10, 0.5] })) // no blocks: it can dig up but not climb
  t.act.player = new PlayerLoop({ chooser: new ScriptedChooser(climb), hz: 1000 })
  const p = await run('play', t.act, { intent: 'get to the surface', budget: { ticks: 50 } })
  assert.equal(p.status, 'partial')
  assert.match(p.detail, /the player is stuck after \d+ ticks/)
  const b = on(setup(shaftWorld(), { pos: [0.5, 10, 0.5] }))
  b.act.player = new PlayerLoop({ chooser: new ScriptedChooser(() => 'wait'), hz: 1000 })
  const q = await run('play', b.act, { intent: 'wait around', budget: { ticks: 5 } })
  assert.match(q.detail, /out of budget after 5 ticks/)
  const n = on(setup(shaftWorld()))
  assert.deepEqual(await run('play', n.act, { intent: 'x' }), { status: 'failed', detail: 'play: no decision model configured (ATLAS_PLAYER_URL)' })
})

test('play is parked: refused "play layer is off" unless ATLAS_PLAYER_PLAY=1, even with a decision model', async () => {
  const s = setup(shaftWorld(), { pos: [0.5, 10, 0.5], inv: { cobblestone: 64 } })
  s.act.player = new PlayerLoop({ chooser: new ScriptedChooser(climb), hz: 1000 })
  assert.deepEqual(await run('play', s.act, { intent: 'get to the surface' }), { status: 'refused', detail: 'play layer is off' })
  if (process.env.ATLAS_PLAYER_PLAY === undefined) assert.equal(require('../src/config').playerPlay, false, 'off by default')
})

test('override: a non-continue answer pauses the verb, ~1 s (20 ticks) of continue_task resumes it, too long paused interrupts', async () => {
  const s = setup(flat(), { pos: [0.5, 10, 0.5] })
  const seq = [...Array(5).fill('continue_task'), 'jump', ...Array(25).fill('continue_task')]
  const loop = new PlayerLoop({ chooser: new ScriptedChooser(() => seq.shift() || 'continue_task'), hz: 1000, surviveHz: 1000 })
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
  const l2 = new PlayerLoop({ chooser: new ScriptedChooser(() => 'wait'), hz: 200, surviveHz: 200, maxPauseMs: 100 })
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
  let c = new DecisionClient({ url: 'http://10.0.0.140:8000/upstream/d1-2b/v1/systemone', fetchImpl: reply(ok) })
  let r = await c.choose({ self: { health: 9 } }, ['retreat', 'wait'])
  assert.equal(r.choice, 'retreat')
  assert.deepEqual(r.probabilities, { retreat: 0.5, wait: 0.2 })
  assert.equal(sent[0].state, '{"self":{"health":9}}', 'the view goes as a JSON string')
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
  assert.match(c.stats.report(), /^\[player\] 1 ticks in [\d.]+ s \([\d.]+ Hz achieved\), latency p50 [\d.]+ ms p95 [\d.]+ ms, 0 timeouts, 1 errors \(ECONNREFUSED x1\), 0 answers not offered$/)
})

// ---- the /v1/systemone contract, as verified on Horizon (Session 6b-2) ----
const http = require('http')
const { DESCRIPTIONS, MICRO } = require('../src/player/offered')

const KNOWN_VIEW = { self: { health: 14, food: 17, held: 'stone_pickaxe', y: 10, facing: 'south', pitch: 0, on_ground: true },
  intent: 'get to the surface', threats: [], hazards: ['drop 2 east'], surroundings: 'in a 1-wide shaft 5 deep, stone all sides, roof 1 above', sky: false,
  recent: [{ action: 'dig_above', effect: 'dug stone above' }], offered: ['jump', 'dig_above', 'place_below_and_jump', 'wait', 'done', 'stuck'] }

const KNOWN_CRITERIA = { jump: 'jump in place (stone above your head)', dig_above: 'break the stone block above you (sky not visible)',
  place_below_and_jump: 'jump and place cobblestone under your feet to climb one block (12 cobblestone left)', wait: 'do nothing this tick',
  done: 'the goal is satisfied now', stuck: 'no offered action can make progress toward the goal' }

test('systemone contract: the request body, byte for byte, for a known view', () => {
  const c = new DecisionClient({ url: 'http://10.0.0.140:8000/upstream/d1-2b/v1/systemone' })
  const body = JSON.stringify(c.request(KNOWN_VIEW, KNOWN_VIEW.offered, { intent: 'get to the surface', criteria: KNOWN_CRITERIA }))
  const expected = '{"model":"d1-2b","state":"{\\"self\\":{\\"health\\":14,\\"food\\":17,\\"held\\":\\"stone_pickaxe\\",\\"y\\":10,\\"facing\\":\\"south\\",\\"pitch\\":0,\\"on_ground\\":true},' +
    '\\"intent\\":\\"get to the surface\\",\\"threats\\":[],\\"hazards\\":[\\"drop 2 east\\"],\\"surroundings\\":\\"in a 1-wide shaft 5 deep, stone all sides, roof 1 above\\",\\"sky\\":false,' +
    '\\"recent\\":[{\\"action\\":\\"dig_above\\",\\"effect\\":\\"dug stone above\\"}],\\"offered\\":[\\"jump\\",\\"dig_above\\",\\"place_below_and_jump\\",\\"wait\\",\\"done\\",\\"stuck\\"]}",' +
    '"questions":{"action":{"type":"choice","instructions":"Goal: get to the surface. Pick the one action that makes progress toward it now. If no offered action can make progress, answer stuck. Answer done only when the goal is satisfied.",' +
    '"criteria":{"jump":"jump in place (stone above your head)","dig_above":"break the stone block above you (sky not visible)",' +
    '"place_below_and_jump":"jump and place cobblestone under your feet to climb one block (12 cobblestone left)",' +
    '"wait":"do nothing this tick","done":"the goal is satisfied now","stuck":"no offered action can make progress toward the goal"}}}}'
  assert.equal(body, expected)
  const parsed = JSON.parse(body)
  assert.deepEqual(Object.keys(parsed), ['model', 'state', 'questions'])
  assert.equal(typeof parsed.state, 'string')
  assert.deepEqual(JSON.parse(parsed.state), KNOWN_VIEW)
  assert.deepEqual(Object.keys(parsed.questions.action), ['type', 'instructions', 'criteria'])
  for (const a of MICRO) assert.equal(typeof DESCRIPTIONS[a], 'string', `a description for ${a}`)
  // the intent defaults to the view's own; the survive override asks its own question
  assert.match(c.request(KNOWN_VIEW, ['wait']).questions.action.instructions, /^Goal: get to the surface\. /)
  assert.equal(c.request(KNOWN_VIEW, ['wait', 'continue_task'], { intent: null }).questions.action.instructions,
    'Goal: stay alive while the running task goes on. Pick continue_task unless a threat or a hazard needs a reaction now.')
  assert.equal(c.request(KNOWN_VIEW, ['wait']).questions.action.criteria.wait, 'do nothing this tick', 'no criteria given: the static base line')
})

test('systemone: a stub server with the real response shape; the URL is used as is; an answer outside the offered set is wait', async (t) => {
  const got = []
  let answer = 'dig_above'
  let probs = { dig_above: 0.71, jump: 0.2, wait: 0.09 }
  const server = http.createServer((req, res) => {
    let b = ''
    req.on('data', d => { b += d })
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, body: b, type: req.headers['content-type'] })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ answers: { action: { choice: answer, probabilities: probs, confidence: 0.71 } }, usage: { input_tokens: 231, output_tokens: 0 } }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}/upstream/d1-2b/v1/systemone`
  const c = new DecisionClient({ url, timeoutMs: 1000 })
  const r = await c.choose(KNOWN_VIEW, KNOWN_VIEW.offered)
  assert.equal(r.choice, 'dig_above')
  assert.deepEqual(r.probabilities, { dig_above: 0.71, jump: 0.2, wait: 0.09 })
  assert.equal(r.confidence, 0.71)
  assert.deepEqual(c.usage, { input_tokens: 231, output_tokens: 0 })
  assert.deepEqual([got[0].method, got[0].url, got[0].type], ['POST', '/upstream/d1-2b/v1/systemone', 'application/json'])
  assert.equal(got[0].body, JSON.stringify(c.request(KNOWN_VIEW, KNOWN_VIEW.offered)))
  answer = 'sprint'; probs = { sprint: 0.9 } // not offered, and no probability for anything offered
  const n = await c.choose(KNOWN_VIEW, KNOWN_VIEW.offered)
  assert.equal(n.choice, 'wait')
  assert.equal(n.error, 'answer not offered: sprint')
})

// ---- 6b-4: the filter never offers a step into a wall; criteria say what is true now; no progress; budget and errors
const { describe } = require('../src/player/offered')

test('a tunnel facing a wall: no step or sprint, dig_ahead offered; and never a step the surroundings rule out', () => {
  const w = new FakeWorld({ fill: 'stone' }).box([0, 10, -5], [0, 11, 0], 'air') // a 1-wide tunnel running north, its end at z 0; stone to the south
  const p = probe(w, { feet: [0, 10, 0], dir: 'south' })
  const o = offeredActions(p)
  assert.ok(!o.includes('step') && !o.includes('sprint'), o.join(' '))
  assert.ok(o.includes('dig_ahead'))
  const n = offeredActions(probe(w, { feet: [0, 10, 0], dir: 'north' }))
  assert.ok(n.includes('step'), 'down the tunnel is fine')
  // the cells say open, but the surroundings the model sees say stone 1 ahead: no step
  const q = { ...probe(w, { feet: [0, 10, 0], dir: 'north' }), sides: { north: ['stone 1', 'stone 1'] } }
  assert.ok(!offeredActions(q).includes('step'))
  // head-high wall only: still no step
  const h = new FakeWorld({ fill: 'air' }).box([-5, 0, -5], [5, 9, 5], 'stone').set(0, 11, 1, 'stone')
  assert.ok(!offeredActions(probe(h, { dir: 'south' })).includes('step'))
})

test('criteria are written for this tick: what is above, ahead, to each side', () => {
  const w = new FakeWorld({ fill: 'stone' }).box([0, 10, -5], [0, 11, 0], 'air').box([0, 10, 1], [0, 11, 1], 'air') // tunnel north, one open cell south
  const p = probe(w, { feet: [0, 10, 0], dir: 'south', inventory: { cobblestone: 12 }, food: 12, foods: ['bread'], threats: [{ type: 'zombie', rel: [0, 0, -3], dist: 3 }] })
  const offered = offeredActions(p)
  const c = describe(p, offered, { sky: false })
  assert.equal(c.dig_above, 'break the stone block above you (sky not visible)')
  assert.equal(c.step, 'walk one block south into open air')
  assert.equal(c.turn_left, 'face east (stone)')
  assert.equal(c.turn_right, 'face west (stone)')
  assert.equal(c.dig_below, 'break the stone block under your feet (stone below it)')
  assert.equal(c.eat, 'eat bread (food 12/20)')
  assert.equal(c.retreat, 'step south, away from the zombie')
  assert.equal(c.attack, 'hit the zombie 3 blocks away')
  assert.equal(c.wait, 'do nothing this tick', 'no fact: the base line')
  assert.deepEqual(Object.keys(c), offered)
})

test('the view carries the last 5 actions and "no progress for N ticks"; the loop sends intent and criteria', async () => {
  const w = new FakeWorld({ fill: 'stone' }).box([0, 10, 0], [0, 11, 0], 'air')
  const s = setup(w, { pos: [0.5, 10, 0.5] })
  const seen = []
  const loop = new PlayerLoop({ chooser: new ScriptedChooser((v, offered, opts) => { seen.push({ v, opts }); return 'wait' }), hz: 1000 })
  await loop.run(s.api, { intent: 'get to the surface', budgetTicks: 8 })
  const last = seen.at(-1)
  assert.equal(last.v.recent.length, 5)
  assert.equal(last.v.progress, 'no progress for 6 ticks', 'the 8th view: ticks 2-7 changed nothing')
  assert.equal(seen[0].v.progress, undefined, 'nothing to compare on the first tick')
  assert.equal(last.opts.intent, 'get to the surface')
  assert.equal(last.opts.criteria.dig_above, 'break the stone block above you (sky not visible)')
})

test('budget and errors: 60 ms default, the achieved tick rate, errors logged and counted by kind, unoffered counted', async () => {
  const logged = []
  const ok = { answers: { action: { choice: 'sprint', probabilities: {}, confidence: 0.4 } } }
  let mode = 'unoffered'
  const c = new DecisionClient({
    url: 'x',
    log: m => logged.push(m),
    fetchImpl: async () => {
      if (mode === 'reset') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } })
      if (mode === '503') return { ok: false, status: 503, json: async () => ({}) }
      return { ok: true, json: async () => ok }
    }
  })
  assert.equal(c.timeoutMs, 60)
  await c.choose({}, ['wait', 'step'])
  mode = 'reset'; await c.choose({}, ['wait']); await c.choose({}, ['wait'])
  mode = '503'; await c.choose({}, ['wait'])
  assert.deepEqual(logged, ['[player] answer not offered: sprint', '[player] decision error: fetch failed: UND_ERR_SOCKET', '[player] decision error: fetch failed: UND_ERR_SOCKET', '[player] decision error: HTTP 503'])
  const r = c.stats.report(c.stats.since + 2000)
  assert.equal(r.replace(/p50 [\d.]+ ms p95 [\d.]+ ms/, 'p50 X p95 X'),
    '[player] 4 ticks in 2.0 s (2.0 Hz achieved), latency p50 X p95 X, 0 timeouts, 3 errors (fetch failed: UND_ERR_SOCKET x2, HTTP 503 x1), 1 answers not offered')
  for (let i = 0; i < 10; i++) await c.choose({}, ['wait'])
  assert.equal(logged.length, 5, 'at most 5 lines a minute; the rest are only counted')
})

test('scripts/player_eval.py: the 10 hand-written views, and its requests are byte-identical to DecisionClient.request()', () => {
  const { execFileSync } = require('child_process')
  const root = path.join(__dirname, '..', '..')
  const views = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'player_eval_views.json'), 'utf8')).views
  assert.equal(views.length, 10)
  const wants = views.map(v => v.want.join('/'))
  for (const w of ['dig_above', 'step', 'turn_left', 'retreat', 'done', 'stuck']) assert.ok(wants.some(x => x.split('/').includes(w)), `a view wants ${w}`)
  let py = null
  try { execFileSync('python3', ['--version']) ; py = 'python3' } catch { }
  if (!py) return
  const c = new DecisionClient({ url: 'x' })
  views.forEach((v, i) => {
    for (const a of v.offered) assert.ok(v.state.offered.includes(a), `view ${i}: offered matches the view`)
    const out = execFileSync(py, [path.join(root, 'scripts', 'player_eval.py'), '--print-request', String(i)], { encoding: 'utf8' })
    const want = JSON.stringify(c.request(v.state, v.offered, { intent: v.mode === 'survive' ? null : v.intent, criteria: v.criteria }))
    assert.equal(out, want, `view ${i} (${v.name})`)
  })
})

// ---- 6b-5: greedy decoding, end-of-run discipline, survive rate
const { decode } = require('../src/player/client')

test('decoding: the argmax of the probabilities over the offered actions, never the sampled choice; confidence and margin', async () => {
  assert.deepEqual(decode({ choice: 'stuck', probabilities: { stuck: 0.2, dig_above: 0.45, wait: 0.35 } }, ['dig_above', 'wait', 'stuck']), { choice: 'dig_above', confidence: 0.45, margin: 0.1 })
  assert.deepEqual(decode({ choice: 'jump', probabilities: { sprint: 0.6, jump: 0.3, wait: 0.1 } }, ['jump', 'wait']), { choice: 'jump', confidence: 0.3, margin: 0.2 }, 'unoffered options are not candidates')
  assert.deepEqual(decode({ choice: 'wait', confidence: 0.8 }, ['jump', 'wait']), { choice: 'wait', confidence: 0.8, margin: null }, 'no probabilities: the server choice')
  const c = new DecisionClient({ url: 'x', fetchImpl: async () => ({ ok: true, json: async () => ({ answers: { action: { choice: 'stuck', probabilities: { stuck: 0.2, dig_above: 0.45, wait: 0.35 }, confidence: 0.2 } } }) }) })
  const r = await c.choose({}, ['dig_above', 'wait', 'stuck'])
  assert.deepEqual([r.choice, r.confidence, r.margin, r.serverChoice], ['dig_above', 0.45, 0.1, 'stuck'])
})

test('end of run: a lone stuck at 0.2 is a wait and the run goes on; five in a row end it; one at 0.6 ends it', async () => {
  const runWith = async seq => {
    const s = setup(flat(), { pos: [0.5, 10, 0.5] })
    const q = [...seq]
    const loop = new PlayerLoop({ chooser: new ScriptedChooser(() => q.shift() || { choice: 'wait' }), hz: 1000 })
    const r = await loop.run(s.api, { intent: 'x', budgetTicks: 12 })
    return { r, last: loop.last }
  }
  const lone = await runWith([{ choice: 'stuck', confidence: 0.2 }])
  assert.equal(lone.r.end, 'budget', 'a stuck at 0.2 once: the run continues')
  assert.equal(lone.r.ticks, 12)
  const five = await runWith(Array(5).fill({ choice: 'stuck', confidence: 0.2 }))
  assert.equal(five.r.end, 'stuck')
  assert.equal(five.r.ticks, 5)
  assert.match(five.last[0].effect, /^stuck held back \(confidence 0\.20, 1 of 5 in a row\): waited$/)
  const broken = await runWith([...Array(4).fill({ choice: 'stuck', confidence: 0.2 }), 'jump', { choice: 'stuck', confidence: 0.2 }])
  assert.equal(broken.r.end, 'budget', 'the streak resets on any other answer')
  const sure = await runWith([{ choice: 'done', confidence: 0.6 }])
  assert.equal(sure.r.end, 'done')
  assert.equal(sure.r.ticks, 1)
})

test('survive mode: 5 Hz with nothing in view, 20 Hz with a threat; rates reported per mode', async () => {
  const s = setup(flat(), { pos: [0.5, 10, 0.5] })
  const loop = new PlayerLoop({ chooser: new ScriptedChooser(() => 'continue_task'), hz: 20, surviveHz: 5 })
  let done = false
  const w = loop.watch(s.api, { settled: () => done, interrupt: () => {} })
  await new Promise(resolve => setTimeout(resolve, 1000))
  done = true
  const calm = await w
  assert.ok(calm.ticks >= 4 && calm.ticks <= 7, `~5 ticks in 1 s, got ${calm.ticks}`)
  assert.match(loop.rateReport(), /^survive [45]\.\d Hz \(\d+ ticks in [\d.]+ s\)$/)
  const t = setup(flat(), { pos: [0.5, 10, 0.5], entities: [{ id: 7, type: 'zombie', pos: [0.5, 10, 3.5], hostile: true }] })
  const l2 = new PlayerLoop({ chooser: new ScriptedChooser(() => 'continue_task'), hz: 20, surviveHz: 5 })
  done = false
  const w2 = l2.watch(t.api, { settled: () => done, interrupt: () => {} })
  await new Promise(resolve => setTimeout(resolve, 1000))
  done = true
  const hot = await w2
  assert.ok(hot.ticks >= 15, `~20 ticks in 1 s with a zombie in view, got ${hot.ticks}`)
})

test('imitation labels: step, turn, dig_ahead, wait, and an ambiguous diagonal move is skipped', () => {
  const { ImitationRecorder, intentOf } = require('../src/player/imitation')
  const w = flat()
  w.set(0, 10, 2, 'stone') // a block two south, at feet height
  const s = setup(w, { pos: [0.5, 10, 0.5] })
  s.motor.dir = 'south'
  const rec = new ImitationRecorder({ loop: new PlayerLoop({ chooser: null }) })
  const sess = rec.begin(s.api, 'explore', { direction: 'south', distance: 32 })
  assert.equal(sess.st.intent, 'explore south 32')
  s.motor.pos = [0.5, 10, 0.9]
  assert.equal(rec.sample(sess), null, 'walking inside the block: in progress')
  s.motor.pos = [0.5, 10, 1.5]
  assert.equal(rec.sample(sess), 'step')
  w.set(0, 10, 2, 'air')
  assert.equal(rec.sample(sess), 'dig_ahead')
  s.motor.dir = 'east'
  assert.equal(rec.sample(sess), 'turn_left')
  assert.equal(rec.sample(sess), 'wait', 'nothing changed, the motor idle')
  s.motor.pos = [1.5, 10, 2.5]
  assert.equal(rec.sample(sess), 'skip')
  assert.deepEqual(sess.counts, { recorded: { step: 1, dig_ahead: 1, turn_left: 1, wait: 1 }, skipped: { 'diagonal or vertical move': 1 } })
  assert.deepEqual(sess.st.recent.map(r => r.action), ['step', 'dig_ahead', 'turn_left', 'wait'])
  assert.deepEqual(intentOf('goto', { target: 'Rook' }), { intent: 'go to Rook', target: 'Rook' })
  assert.deepEqual(intentOf('goto', { target: 'surface' }), { intent: 'get to the surface', target: null })
})

// ---- 6b-6: timeouts never override; micro-actions are control presses; the survive view
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { Motor } = require('../src/motor')
const { surviveView, SURVIVE_MAX_TOKENS } = require('../src/player/view')

/** A bot with just enough physics for control presses: 20 game ticks a second, walking 4.3 b/s, sprinting 5.6. */
function physBot (w, pos) {
  const bot = Object.assign(new EventEmitter(), {
    registry: require('prismarine-registry')('26.1'),
    game: { gameMode: 'survival', dimension: 'overworld' },
    entity: { position: new Vec3(...pos), yaw: Math.PI, pitch: 0, onGround: true, eyeHeight: 1.62 },
    entities: {},
    inventory: { items: () => [], slots: [] },
    heldItem: null,
    food: 20,
    controlState: {},
    setControlState (c, v) { this.controlState[c] = v },
    clearControlStates () { this.controlState = {} },
    look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  })
  const solid = (x, y, z) => { const c = w.classAt(Math.floor(x), Math.floor(y), Math.floor(z)); return !!(c && c.solid) }
  bot.timer = setInterval(() => {
    const cs = bot.controlState
    // water: holding jump swims up (~2.4 blocks/s), otherwise it sinks slowly
    const q = bot.entity.position
    const wet = typeof w.get === 'function' && w.get(Math.floor(q.x), Math.floor(q.y), Math.floor(q.z)) === 'water'
    bot.entity.isInWater = wet
    if (wet) {
      const ny = q.y + (cs.jump ? 0.12 : -0.02)
      if (!solid(q.x, ny, q.z) && !solid(q.x, ny + 1.8, q.z)) bot.entity.position = new Vec3(q.x, ny, q.z)
    }
    if (cs.jump && bot.entity.onGround && !wet) { bot.entity.onGround = false; setTimeout(() => { bot.entity.onGround = true }, 400) }
    if (!cs.forward) return
    const v = (cs.sprint ? 5.6 : 4.3) / 20
    const p = bot.entity.position
    const ux = -Math.sin(bot.entity.yaw); const uz = -Math.cos(bot.entity.yaw)
    const nx = p.x + ux * v; const nz = p.z + uz * v
    const ex = nx + ux * 0.3; const ez = nz + uz * 0.3 // the leading edge of the 0.6-wide hitbox
    if (solid(ex, p.y, ez) || solid(ex, p.y + 1, ez)) return
    bot.entity.position = new Vec3(nx, p.y, nz)
  }, 50)
  return bot
}

test('timeouts never override: 50% timeouts in survive mode during a scripted goto never pause it; no decision is logged as no choice', async () => {
  const s = setup(flat(), { pos: [0.5, 10, 0.5] })
  let n = 0
  const c = new DecisionClient({
    url: 'x',
    timeoutMs: 20,
    log: () => {},
    fetchImpl: (url, o) => (n++ % 2
      ? new Promise((resolve, reject) => {
        const keep = setTimeout(() => {}, 1000) // AbortSignal.timeout's timer is unref'd: keep the test process alive
        o.signal.addEventListener('abort', () => { clearTimeout(keep); reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })) }, { once: true })
      })
      : Promise.resolve({ ok: true, json: async () => ({ answers: { action: { choice: 'continue_task', probabilities: { continue_task: 0.8, wait: 0.2 } } } }) }))
  })
  const loop = new PlayerLoop({ chooser: c, hz: 100, surviveHz: 100 })
  let done = false // the scripted verb is still running while this is false (as in body.onCall)
  const w = loop.watch(s.api, { settled: () => done, interrupt: () => assert.fail('no interrupt') })
  await new Promise(resolve => setTimeout(resolve, 800))
  done = true
  const out = await w
  assert.ok(out.ticks >= 10, `ticks: ${out.ticks}`)
  assert.ok(out.undecided >= out.ticks * 0.3, `about half timed out: ${out.undecided}/${out.ticks}`)
  assert.equal(out.pauses, 0)
  assert.deepEqual(s.motor.calls.filter(x => x[0] === 'pause' || x[0] === 'resume'), [], 'never paused')
  const timedOut = loop.last.find(t => t.chosen === '(timeout)')
  assert.ok(timedOut, 'the dashboard shows the timeout as no choice')
})

test('play: a timeout is a wait, not a decision: it neither ends a streak nor counts toward one, and is not logged as a choice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-player-'))
  const s = setup(flat(), { pos: [0.5, 10, 0.5] })
  const seq = ['stuck', 'timeout', 'stuck', 'timeout', 'stuck', 'stuck', 'stuck']
  const chooser = {
    stats: { add () {} },
    async choose (v, offered) {
      const a = seq.shift() || 'wait'
      if (a === 'timeout') return { choice: 'wait', probabilities: null, confidence: null, margin: null, latency: 60, timedOut: true }
      return { choice: a, probabilities: null, confidence: 0.2, margin: null, latency: 5, timedOut: false }
    }
  }
  const loop = new PlayerLoop({ chooser, logDir: dir, hz: 1000 })
  const r = await loop.run(s.api, { intent: 'x', budgetTicks: 20 })
  await loop.close()
  assert.equal(r.end, 'stuck')
  assert.equal(r.ticks, 7, 'five stucks in a row, the two timeouts in between skipped over')
  const lines = fs.readFileSync(r.log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(lines.map(l => l.chosen), ['stuck', null, 'stuck', null, 'stuck', 'stuck', 'stuck'])
  assert.equal(lines[1].no_decision, 'timeout')
  assert.equal(lines[1].effect, 'no decision: waited')
})

test('a step is a forward press: it completes one block in under 400 ms; the tick goes on as soon as the bot moves', async () => {
  const w = flat()
  const bot = physBot(w, [0.5, 10, -10.5])
  try {
    const m = new Motor(bot)
    const t0 = Date.now()
    const r = await m.press('south')
    const startMs = Date.now() - t0
    assert.equal(r.moving, true)
    assert.ok(startMs < 100, `returns once moving: ${startMs} ms`)
    const d = await m.pressing.done
    const total = Date.now() - t0
    assert.ok(total < 400, `one block in ${total} ms`)
    assert.ok(d.moved >= 0.95 && d.moved < 1.3, `moved ${d.moved}`)
    assert.equal(bot.controlState.forward, false, 'let go by itself')
    // into a wall: no movement, the press reports it within startMs
    w.set(0, 10, 5, 'stone').set(0, 11, 5, 'stone')
    bot.entity.position = new Vec3(0.5, 10, 4.5)
    const b = await m.press('south')
    assert.equal(b.moving, false)
    await m.pressing?.done
  } finally { clearInterval(bot.timer) }
})

test('a 100-tick walk on flat ground with a stub model runs at 10 Hz or more', async () => {
  const w = flat()
  const bot = physBot(w, [0.5, 10, -19.5])
  try {
    const s = setup(w, { motor: new Motor(bot) })
    const chooser = new DecisionClient({
      url: 'x',
      timeoutMs: 60,
      fetchImpl: async () => { await new Promise(resolve => setTimeout(resolve, 15)); return { ok: true, json: async () => ({ answers: { action: { choice: 'step', probabilities: { step: 0.9, wait: 0.1 } } } }) } }
    })
    const loop = new PlayerLoop({ chooser, hz: 20 })
    const r = await loop.run(s.api, { intent: 'walk south', budgetTicks: 100, budgetMs: 30000 })
    assert.equal(r.ticks, 100)
    const hz = r.ticks / r.seconds
    assert.ok(hz >= 10, `${hz.toFixed(1)} Hz`)
    if (process.env.ATLAS_SHOW_RATE) console.log(`walk: ${hz.toFixed(1)} Hz, ${(r.to[2] - r.from[2]).toFixed(1)} blocks`)
    assert.ok(r.to[2] - r.from[2] >= 15, `walked ${r.to[2] - r.from[2]} blocks south`)
    assert.match(loop.rateReport(), /^play \d+\.\d Hz \(100 ticks in [\d.]+ s\)$/)
  } finally { clearInterval(bot.timer) }
})

test('the survive view is small: vitals, threats, hazards, the last action; ≤120 tokens', () => {
  const obs = {
    self: { health: 6, food: 12, held: 'stone_pickaxe', on_ground: true },
    surroundings: { summary: 'on open flat ground, a long sentence about everything around that survive mode does not need at all', sky: true },
    entities: [1, 2, 3, 4].map(i => ({ type: 'zombie', rel: [i, 0, 1], dist: i + 0.5, bearing: 'front-left', approaching: true, hostile: true }))
  }
  const v = surviveView({ obs, probe: null, recent: [{ action: 'continue_task', effect: 'continuing the task' }, { action: 'attack', effect: 'hit zombie' }] })
  assert.deepEqual(Object.keys(v), ['self', 'threats', 'hazards', 'last'])
  assert.deepEqual(v.self, { health: 6, food: 12 })
  assert.equal(v.threats.length, 3)
  assert.deepEqual(v.last, { action: 'attack', effect: 'hit zombie' })
  assert.ok(tokens(v) <= SURVIVE_MAX_TOKENS, `${tokens(v)} tokens`)
})

test('bare request: timed outside the tick stats, and logged next to them', async () => {
  const c = new DecisionClient({ url: 'x', fetchImpl: async (u, o) => { await new Promise(resolve => setTimeout(resolve, 5)); return { ok: true, json: async () => ({ body: JSON.parse(o.body) }) } } })
  const b = await c.bare()
  assert.equal(b.ok, true)
  assert.equal(c.stats.ticks, 0)
  c.stats.add(30)
  const loop = new PlayerLoop({ chooser: c })
  assert.match(await loop.reportWithBare(), /^\[player\] 1 ticks in .*; bare request [\d.]+ ms$/)
  const f = new DecisionClient({ url: 'x', fetchImpl: async () => ({ ok: false, status: 503 }) })
  f.stats.add(30)
  assert.match(await new PlayerLoop({ chooser: f }).reportWithBare(), /; bare request failed after [\d.]+ ms \(HTTP 503\)$/)
})

test('the imitation recorder keeps recording at its own rate while survive mode is quiet (5 Hz)', async () => {
  const { ImitationRecorder } = require('../src/player/imitation')
  const s = setup(flat(), { pos: [0.5, 10, 0.5] })
  s.motor.dir = 'south'
  const watcher = new PlayerLoop({ chooser: new ScriptedChooser(() => 'continue_task'), hz: 20, surviveHz: 5 })
  const rec = new ImitationRecorder({ loop: new PlayerLoop({ chooser: null }), hz: 50 })
  let finish; const finished = new Promise(resolve => { finish = resolve })
  let settled = false
  const watching = watcher.watch(s.api, { settled: () => settled, interrupt: () => assert.fail('no interrupt') })
  const recording = rec.record(s.api, { verb: 'goto', args: { pos: [0.5, 10, 6.5] }, finished })
  for (let i = 0; i < 6; i++) { await new Promise(resolve => setTimeout(resolve, 60)); s.motor.pos = [0.5, 10, s.motor.pos[2] + 1] }
  await new Promise(resolve => setTimeout(resolve, 60))
  finish({ status: 'done' }); settled = true
  const counts = await recording
  const out = await watching
  assert.equal(counts.recorded.step, 6, JSON.stringify(counts))
  assert.equal(counts.recorded.done, 1)
  assert.ok(out.ticks <= 4, `survive stayed quiet: ${out.ticks} ticks`)
  assert.equal(out.pauses, 0)
})

// ---- 8b: survive mode in water and fire
const { shore, waterBeside } = require('../src/player/offered')

/** A pool: water x/z -3..3 from y 5 up to y 12, stone floor at 4, stone around; open air above y 12. */
function pool () {
  const w = new FakeWorld({ fill: 'air' }).box([-20, 0, -20], [20, 12, 20], 'stone')
  w.box([-3, 5, -3], [3, 12, 3], 'water')
  return w
}

test('survive mode in water: swim_up offered with room above, exit_water when a shore is in sight; extinguish when burning', () => {
  const w = pool()
  const deep = { ...probe(w, { feet: [0, 6, 0] }), inWater: true }
  const o = offeredActions(deep, 'survive')
  assert.ok(o.includes('swim_up'), o.join(' '))
  assert.ok(o.includes('continue_task'))
  assert.ok(o.every(a => SURVIVAL.has(a)))
  assert.ok(!o.includes('exit_water'), 'no shore within reach six blocks down: ' + o.join(' '))
  const top = { ...probe(w, { feet: [2, 12, 0] }), inWater: true }
  const s = shore(top)
  assert.deepEqual([s.dir, s.block], ['east', 'stone'])
  assert.ok(offeredActions(top, 'survive').includes('exit_water'))
  assert.match(describe(top, ['exit_water', 'swim_up'], {}).exit_water, /^swim east to the shore, 2 blocks \(stone\)$/)
  const capped = new FakeWorld({ fill: 'stone' }).box([0, 6, 0], [0, 7, 0], 'water') // water with stone right above the head
  assert.ok(!offeredActions({ ...probe(capped, { feet: [0, 6, 0] }), inWater: true }, 'survive').includes('swim_up'))
  // on fire: extinguish, into water beside the feet if there is some
  const burning = { ...probe(w, { feet: [4, 12, 0] }), onFire: true }
  assert.ok(offeredActions(burning, 'survive').includes('extinguish'))
  assert.equal(waterBeside(burning), 'west')
  assert.equal(describe(burning, ['extinguish'], {}).extinguish, 'step west into the water to put the fire out')
  assert.equal(describe({ ...probe(flat(), { feet: [0, 10, 0] }), onFire: true }, ['extinguish'], {}).extinguish, 'wait for the fire to go out')
  assert.ok(!offeredActions(probe(flat(), { feet: [0, 10, 0] }), 'survive').some(a => ['swim_up', 'exit_water', 'extinguish'].includes(a)), 'dry and not burning: none of them')
})

test('survive mode: swim_up chosen in deep water makes the bot rise (real Motor, the jump control held)', async () => {
  const w = pool()
  const bot = physBot(w, [0.5, 6, 0.5])
  try {
    const s = setup(w, { motor: new Motor(bot) })
    const seen = []
    const loop = new PlayerLoop({ chooser: new ScriptedChooser((v, offered) => { seen.push({ v, offered }); return offered.includes('swim_up') ? 'swim_up' : 'continue_task' }), hz: 20, surviveHz: 20 })
    let done = false
    const watching = loop.watch(s.api, { settled: () => done, interrupt: () => {} })
    await new Promise(resolve => setTimeout(resolve, 2500))
    done = true
    await watching
    assert.ok(seen[0].offered.includes('swim_up'), seen[0].offered.join(' '))
    assert.equal(seen[0].v.self.in_water, true, 'the survive view says in_water')
    assert.ok(bot.entity.position.y >= 10.5, `rose from y 6 to ${bot.entity.position.y.toFixed(2)}`)
    assert.match(loop.last.find(t => t.chosen === 'swim_up').effect, /^swam up/)
    assert.equal(bot.controlState.jump, false, 'jump let go between presses')
  } finally { clearInterval(bot.timer) }
})
