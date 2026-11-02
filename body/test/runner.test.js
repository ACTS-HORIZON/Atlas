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

test('a new long verb preempts the running one; instant verbs do not', async () => {
  const r = new Runner({ ...VERBS, a: { run: never }, b: { run: never } })
  const act = fakeAct()
  const pa = r.run(act, { id: 'c1', verb: 'a' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await r.run(act, { id: 'c2', verb: 'say', args: { text: 'hi' } })).status, 'done')
  assert.equal(r.task().verb, 'a', 'say ran alongside')
  r.run(act, { id: 'c3', verb: 'b' })
  assert.equal((await pa).status, 'interrupted')
  assert.equal(r.task().verb, 'b')
  r.stop(act, 'test')
})

test('stop works with nothing running and while disconnected', async () => {
  const r = new Runner()
  const act = { ...fakeAct(), connected: () => false }
  assert.deepEqual(await r.run(act, { id: 'c1', verb: 'stop' }), { status: 'done', detail: 'stopped (nothing was running)' })
  assert.equal(act.halts, 1)
})
