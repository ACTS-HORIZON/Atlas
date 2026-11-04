'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Runner } = require('../src/runner')
const { VERBS } = require('../src/verbs')

const never = () => new Promise(() => {}) // a verb that ignores its abort signal
function fakeAct () { return { halts: 0, said: [], connected: () => true, chat (t) { this.said.push(t) }, halt () { this.halts++ } } }

test('stop interrupts the running verb; it returns interrupted', async () => {
  const r = new Runner({ ...VERBS, dig: { run: (act) => { act.progress('2/8'); return never() } } })
  const act = fakeAct()
  const p = r.run(act, { id: 'c1', verb: 'dig', args: { pos: [1, 2, 3] } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(r.task(), { id: 'c1', verb: 'dig', args: { pos: [1, 2, 3] }, progress: '2/8', state: 'running' })
  assert.deepEqual(await r.run(act, { id: 'c2', verb: 'stop' }), { status: 'done', detail: 'stopped dig' })
  const res = await p
  assert.equal(res.status, 'interrupted')
  assert.match(res.detail, /stopped by call c2/)
  assert.equal(r.task(), null)
  assert.ok(act.halts >= 1)
})

test('while a verb runs, other calls are refused "busy": not queued, nothing cancelled', async () => {
  let bRuns = 0
  const r = new Runner({ ...VERBS, a: { run: never }, b: { run: () => { bRuns++; return { status: 'done', detail: 'b' } } } })
  const act = { ...fakeAct(), here: () => ({ pos: [0, 0, 0], dim: 'overworld', t: 0 }), places: { recall: () => null } }
  let aSettled = false
  const pa = r.run(act, { id: 'c1', verb: 'a' }).then(x => { aSettled = true; return x })
  await new Promise(resolve => setImmediate(resolve))

  for (const [id, verb] of [['c2', 'b'], ['c3', 'a'], ['c4', 'mine'], ['c5', 'goto']]) {
    assert.deepEqual(await r.run(act, { id, verb, args: {} }), { status: 'refused', detail: 'busy' }, verb)
  }
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(bRuns, 0, 'refused, not queued')
  assert.equal(aSettled, false, 'the running verb was not cancelled')
  assert.equal(r.task().id, 'c1')
  assert.equal(act.halts, 0)

  // say, recall, inspect run alongside (this bare act has no api for inspect to look with, but it is not "busy")
  assert.deepEqual(await r.run(act, { id: 'c6', verb: 'say', args: { text: 'hi' } }), { status: 'done', detail: 'said: hi' })
  assert.deepEqual(await r.run(act, { id: 'c7', verb: 'recall', args: { type: 'iron_ore' } }), { status: 'failed', detail: 'unknown' })
  const ins = await r.run(act, { id: 'c8', verb: 'inspect', args: { box: [[0, 0, 0], [1, 1, 1]] } })
  assert.notEqual(ins.detail, 'busy')
  assert.match(ins.detail, /^inspect: /)
  assert.equal(r.task().id, 'c1', 'still the task')
  assert.deepEqual(act.said, ['hi'])

  // stop also runs alongside, and ends it; then other calls run again
  assert.deepEqual(await r.run(act, { id: 'c9', verb: 'stop' }), { status: 'done', detail: 'stopped a' })
  assert.equal((await pa).status, 'interrupted')
  assert.deepEqual(await r.run(act, { id: 'c10', verb: 'b' }), { status: 'done', detail: 'b' })
  assert.equal(bRuns, 1)
  assert.equal(r.task(), null)
})

test('say and recall never become the task', async () => {
  const r = new Runner()
  const act = { ...fakeAct(), here: () => ({ pos: [0, 0, 0], dim: 'overworld', t: 0 }), places: { recall: () => null } }
  await r.run(act, { id: 'c1', verb: 'say', args: { text: 'x' } })
  assert.equal(r.task(), null)
})

test('stop works with nothing running and while disconnected', async () => {
  const r = new Runner()
  const act = { ...fakeAct(), connected: () => false }
  assert.deepEqual(await r.run(act, { id: 'c1', verb: 'stop' }), { status: 'done', detail: 'stopped (nothing was running)' })
  assert.equal(act.halts, 1)
})
