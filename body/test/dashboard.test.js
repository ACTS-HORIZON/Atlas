'use strict'
// Body + dashboard end to end, with a fake bot (no Minecraft server).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { check } = require('../src/schema')
const { maskSecrets, parseBind } = require('../src/dashboard')
const { client, startBody } = require('./bodyHarness')

test('the tap delivers every link message type, as-is, to dashboard clients', async (t) => {
  const { body, bot, linkUrl, dashUrl } = await startBody(t)
  const dash = client(dashUrl.replace('http', 'ws') + '/tap')
  await dash.opened
  const mind = client(linkUrl)
  await mind.opened
  await mind.wait(m => m.type === 'obs')
  mind.send({ type: 'observe', v: '0.1' })
  mind.send({ type: 'call', v: '0.1', id: 'c1', verb: 'say', args: { text: 'hello' } })
  await mind.wait(m => m.type === 'result' && m.id === 'c1')
  mind.send({ type: 'trace', v: '0.1', t: 1234, kind: 'plan', text: 'look for iron', data: { why: 'asked' } })
  bot.emit('death')
  await mind.wait(m => m.type === 'event' && m.kind === 'died')

  for (const t of ['obs', 'observe', 'call', 'result', 'trace', 'event']) await dash.wait(e => e.msg.type === t)
  const trace = await dash.wait(e => e.msg.type === 'trace')
  assert.deepEqual(trace.msg, { type: 'trace', v: '0.1', t: 1234, kind: 'plan', text: 'look for iron', data: { why: 'asked' } })
  assert.equal(trace.dir, 'in')
  // a result on the tap is exactly what the mind received
  const res = await dash.wait(e => e.msg.type === 'result')
  assert.deepEqual(res.msg, mind.got.find(m => m.type === 'result'))
  for (const e of dash.got) {
    assert.deepEqual(Object.keys(e).sort(), ['dir', 'logged', 'msg', 'ts'])
    assert.equal(check(e.msg.type, e.msg), null)
  }
  // a dashboard client that connects later gets the recent messages replayed
  const late = client(dashUrl.replace('http', 'ws') + '/tap')
  await late.wait(e => e.msg.type === 'trace')
  mind.ws.close(); dash.ws.close(); late.ws.close()
  const logPath = body.log.path
  await body.close() // flushes the log

  // the trace was logged and nothing acted on it
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.ok(lines.some(l => l.msg.type === 'trace' && l.dir === 'in'))
  assert.deepEqual(bot.said, ['hello'])
})

test('the Stop endpoint stops a running verb directly, without the mind', async (t) => {
  const { body, bot, linkUrl, dashUrl } = await startBody(t)
  const mind = client(linkUrl)
  await mind.opened
  mind.send({ type: 'call', v: '0.1', id: 'c7', verb: 'dig_forever', args: {} })
  await new Promise(resolve => setTimeout(resolve, 50))
  mind.send({ type: 'observe', v: '0.1' })
  const o = await mind.wait(m => m.type === 'obs' && m.task)
  assert.deepEqual(o.task, { id: 'c7', verb: 'dig_forever', args: {}, progress: '0/1', state: 'running' })

  // over the link too: a second call while busy is refused, the first keeps running
  mind.send({ type: 'call', v: '0.1', id: 'c8', verb: 'dig_forever', args: {} })
  const busy = await mind.wait(m => m.type === 'result' && m.id === 'c8')
  assert.deepEqual([busy.status, busy.detail, busy.obs.task.id], ['refused', 'busy', 'c7'])

  const halts = bot.halts
  const r = await (await fetch(`${dashUrl}/api/stop`, { method: 'POST' })).json()
  assert.deepEqual(r, { status: 'done', detail: 'stopped dig_forever' })
  const res = await mind.wait(m => m.type === 'result' && m.id === 'c7')
  assert.equal(res.status, 'interrupted')
  assert.match(res.detail, /dashboard/)
  assert.equal(res.obs.task, null)
  assert.ok(bot.halts > halts, 'movement controls released')
  const ev = await mind.wait(m => m.type === 'event' && m.kind === 'stop_requested')
  assert.equal(ev.detail.from, 'dashboard')
  // nothing else is writable
  for (const p of ['/api/config', '/api/verbs', '/', '/api/places']) {
    assert.equal((await fetch(dashUrl + p, { method: 'POST' })).status, 405, p)
  }
  mind.ws.close()
  await body.close()
})

test('no backend internals reach the tap: only contract messages', async (t) => {
  const { body, bot, dashUrl } = await startBody(t)
  const dash = client(dashUrl.replace('http', 'ws') + '/tap')
  await dash.opened
  await dash.wait(e => e.msg.type === 'obs') // the spawn obs, replayed on connect
  const before = dash.got.length
  const obs = body.obs()
  // the obs itself carries the fair-play view, not the bot's (zombie health 17 stays hidden)
  assert.deepEqual(obs.entities.map(e => Object.keys(e).sort()), [['approaching', 'bearing', 'dist', 'hostile', 'rel', 'type']])

  const circular = { type: 'obs' }; circular.self = circular
  const attempts = [
    bot, // the raw bot
    bot.entities[9], // a raw entity
    { ...obs, bot }, // a contract message with a backend object attached
    { ...obs, entities: [{ ...obs.entities[0], health: 17 }] }, // hidden entity state
    { type: 'result', v: '0.1', id: 'x', status: 'done', detail: 'd', obs: bot }, // backend object as obs
    { type: 'event', v: '0.1', kind: 'died', detail: null, obs: null, _client: bot._client },
    circular,
    { type: 'debug', v: '0.1', state: 'anything' } // not a contract message type
  ]
  for (const m of attempts) body.link.broadcast(m)
  body.link.broadcast(obs) // the one valid message
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(dash.got.length, before + 1, 'only the valid obs got through')
  assert.equal(body.tap.dropped, attempts.length)
  const wire = JSON.stringify(dash.got)
  for (const s of ['_client', 'secretSocketState', 'registry', 'aiTarget', 'metadata', '"health":17', 'eyeHeight']) assert.ok(!wire.includes(s), s)
  dash.ws.close()
  await body.close()
})

test('dashboard read-only api: page, places, verbs, config (masked), log tail', async (t) => {
  const { body, dashUrl, cfg } = await startBody(t, { advisor: { enabled: false, apiKey: 'sk-live-123', maxDollars: 5 } })
  fs.mkdirSync(cfg.verbDir, { recursive: true })
  fs.writeFileSync(path.join(cfg.verbDir, 'pillar.js'), 'module.exports = async function pillar (api) {}\n')
  const get = async p => { const r = await fetch(dashUrl + p); return { status: r.status, body: r.headers.get('content-type').includes('json') ? await r.json() : await r.text() } }

  const page = await get('/')
  assert.equal(page.status, 200)
  assert.match(page.body, /<title>Atlas<\/title>/)

  body.obs() // records the visible iron ore
  const places = (await get('/api/places')).body
  assert.equal(places.count, 1)
  assert.deepEqual(places.nearest.map(p => p.type), ['iron_ore'])

  const verbs = (await get('/api/verbs')).body
  assert.deepEqual(verbs.map(v => `${v.name}:${v.kind}`).sort(), [...Object.keys(require('../src/verbs').VERBS).map(n => `${n}:built-in`), 'stop:built-in', 'pillar:live'].sort())
  assert.match((await get('/api/verbs/say')).body.source, /act\.chat\(text\)/)
  assert.match((await get('/api/verbs/mine')).body.source, /strip-mines/)
  assert.match((await get('/api/verbs/pillar')).body.source, /function pillar/)
  assert.equal((await get('/api/verbs/..%2F..%2Fpackage')).status, 404)

  const conf = (await get('/api/config')).body
  assert.equal(conf.advisor.apiKey, '***')
  assert.equal(conf.advisor.maxDollars, 5)
  assert.equal(conf.mc.username, 'Atlas')
  assert.ok(!JSON.stringify(conf).includes('sk-live-123'))

  const mind = client(`ws://127.0.0.1:${body.link.wss.address().port}`)
  await mind.wait(m => m.type === 'obs')
  let log = []
  for (let i = 0; i < 20 && !log.length; i++) { // the log stream flushes asynchronously
    log = (await get('/api/log?n=5')).body
    if (!log.length) await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(log.length >= 1 && log.every(l => l.msg && l.dir))
  mind.ws.close()
  await body.close()
})

test('helpers: bind parsing and secret masking', () => {
  assert.deepEqual(parseBind('0.0.0.0:8080'), { host: '0.0.0.0', port: 8080 })
  assert.deepEqual(parseBind('[::]:9000'), { host: '::', port: 9000 })
  assert.deepEqual(parseBind('8081'), { host: '0.0.0.0', port: 8081 })
  assert.equal(parseBind('off'), null)
  assert.throws(() => parseBind('x:http'))
  assert.deepEqual(maskSecrets({ a: { token: 't', password: '', n: 1 }, f () {} }), { a: { token: '***', password: '', n: 1 } })
})

test('damaged_badly: a drop of 4+ in one update, or any drop below 10 health; not small hits when healthy', async (t) => {
  const { bot, linkUrl } = await startBody(t)
  const mind = client(linkUrl)
  await mind.opened
  await mind.wait(m => m.type === 'obs')
  const hit = h => { bot.health = h; bot.emit('health') }
  hit(20); hit(18) // 2 at full health: nothing
  hit(13) // 5 at once
  const e = await mind.wait(m => m.type === 'event' && m.kind === 'damaged_badly')
  assert.deepEqual(e.detail, { health: 13, lost: 5, food: 20 })
  assert.equal(check('event', e), null)
  hit(9) // below 10: any drop
  await mind.wait(m => m.type === 'event' && m.kind === 'damaged_badly' && m.detail.health === 9)
  hit(10) // healing: nothing
  hit(8.5)
  await mind.wait(m => m.type === 'event' && m.kind === 'damaged_badly' && m.detail.health === 8.5)
  assert.equal(mind.got.filter(m => m.kind === 'damaged_badly').length, 3)
  mind.ws.close()
})

test('lessons: a lesson trace is a valid contract message and the dashboard has the notes & lessons panel', async (t) => {
  assert.equal(check('trace', { type: 'trace', v: '0.1', t: 5, kind: 'lesson', text: 'when a player is above me, goto surface first', data: {} }), null)
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8')
  assert.match(html, /<h2>Notes &amp; lessons/)
  assert.match(html, /m\.kind === 'note' \|\| m\.kind === 'lesson'/)
})
