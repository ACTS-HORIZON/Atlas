'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const WebSocket = require('ws')
const { Link } = require('../src/link')
const { JsonlLog } = require('../src/jsonl')
const { runVerb } = require('../src/runner')
const { buildObs } = require('../src/fairplay/observe')
const { FakeWorld, makeView } = require('./fakeWorld')
const { check } = require('../src/schema')

function fakeAct () {
  const said = []
  const places = { recall: (type) => type === 'iron_ore' ? { type, pos: [1, 2, 3], dist: 4, age: 5 } : null }
  return { said, halted: 0, places, here: () => ({ pos: [0, 0, 0], dim: 'overworld', t: 0 }), connected: () => true, chat: t => said.push(t), halt () { this.halted++ } }
}

test('say and stop', async () => {
  const act = fakeAct()
  assert.deepEqual((await runVerb(act, 'say', { text: 'hello\nworld' })), { status: 'done', detail: 'said: hello world' })
  assert.deepEqual(act.said, ['hello world'])
  assert.equal((await runVerb(act, 'say', { text: '/gamemode creative' })).status, 'refused')
  assert.equal((await runVerb(act, 'say', { text: '  /op Atlas' })).status, 'refused')
  assert.equal((await runVerb(act, 'say', {})).status, 'failed')
  assert.equal((await runVerb(act, 'say', { text: 'x'.repeat(300) })).status, 'failed')
  assert.deepEqual(act.said, ['hello world'], 'nothing else was sent')
  assert.equal((await runVerb(act, 'stop')).status, 'done')
  assert.equal(act.halted, 1)
  assert.match((await runVerb(act, 'build', { blocks: [] })).detail, /not implemented/)
  assert.match((await runVerb(act, 'constructor')).detail, /not implemented/)
  assert.equal((await runVerb({ ...act, connected: () => false }, 'say', { text: 'hi' })).status, 'failed')
})

test('link: obs on connect and on request, call -> result, everything logged as JSONL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-log-'))
  const log = new JsonlLog(dir)
  const world = new FakeWorld().box([-32, 0, -32], [31, 9, 31], 'stone')
  const act = fakeAct()
  const obsNow = () => buildObs(makeView(world), {}).obs
  const link = new Link({
    host: '127.0.0.1',
    port: 0,
    log,
    handlers: { buildObs: obsNow, onCall: async c => ({ ...(await runVerb(act, c.verb, c.args)), obs: obsNow() }) }
  })
  await link.ready
  const ws = new WebSocket(`ws://127.0.0.1:${link.wss.address().port}`)
  const inbox = []
  const waiters = []
  ws.on('message', d => { const m = JSON.parse(d); const w = waiters.shift(); w ? w(m) : inbox.push(m) })
  const next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise(resolve => waiters.push(resolve))
  await new Promise(resolve => ws.once('open', resolve))

  const first = await next()
  assert.equal(first.type, 'obs')
  assert.equal(check('obs', first), null)

  ws.send(JSON.stringify({ type: 'observe', v: '0.1' }))
  assert.equal((await next()).type, 'obs')

  ws.send(JSON.stringify({ type: 'call', v: '0.1', id: 'c1', verb: 'say', args: { text: 'hi' } }))
  const r = await next()
  assert.equal(check('result', r), null)
  assert.deepEqual([r.id, r.status], ['c1', 'done'])
  assert.deepEqual(act.said, ['hi'])

  ws.send(JSON.stringify({ type: 'call', v: '0.1', id: 'c9', verb: 'recall', args: { type: 'iron_ore' } }))
  const rc = await next()
  assert.equal(check('result', rc), null)
  assert.deepEqual([rc.status, rc.data], ['done', { type: 'iron_ore', pos: [1, 2, 3], dist: 4, age: 5 }])

  ws.send(JSON.stringify({ type: 'call', v: '0.1', id: 'c2', verb: 'stop' }))
  assert.equal((await next()).status, 'done')

  ws.send(JSON.stringify({ type: 'call', v: '0.2', id: 'c3', verb: 'say', args: { text: 'x' } }))
  const bad = await next()
  assert.deepEqual([bad.id, bad.status], ['c3', 'failed'])

  ws.close(); await link.close(); await log.close() // flushed
  const lines = fs.readFileSync(log.path, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  for (const l of lines) {
    assert.deepEqual(Object.keys(l).sort(), ['dir', 'msg', 'ts'])
    assert.equal(l.msg.v, '0.1')
    assert.ok(['obs', 'observe', 'call', 'result', 'event'].includes(l.msg.type))
  }
  assert.deepEqual(lines.map(l => `${l.dir}:${l.msg.type}`), [
    'out:obs', 'in:observe', 'out:obs', 'in:call', 'out:result', 'in:call', 'out:result', 'in:call', 'out:result', 'out:result'
  ])
})
