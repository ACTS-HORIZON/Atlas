'use strict'
// Body + dashboard end to end, with a fake bot (no Minecraft server).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const WebSocket = require('ws')
const { Vec3 } = require('vec3')
const { Body } = require('../src/body')
const { VERBS } = require('../src/verbs')
const { check } = require('../src/schema')
const { maskSecrets, parseBind } = require('../src/dashboard')
const { fakeLiveBot } = require('./fakeBot')

/** A WebSocket client that collects messages and can wait for one. */
function client (url) {
  const ws = new WebSocket(url)
  const got = []
  const waiters = []
  ws.on('message', d => {
    const m = JSON.parse(d)
    got.push(m)
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m) }
  })
  const opened = new Promise(resolve => ws.once('open', resolve))
  const wait = (pred, ms = 3000) => {
    const hit = got.find(pred)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const w = { pred, resolve }
      waiters.push(w)
      setTimeout(() => reject(new Error('timed out waiting for a message')), ms).unref()
    })
  }
  return { ws, got, opened, wait, send: m => ws.send(JSON.stringify(m)) }
}

async function startBody (t, extraCfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-body-'))
  const cfg = {
    mc: { host: 'localhost', port: 25565, username: 'Atlas', version: false },
    link: { host: '127.0.0.1', port: 0 },
    logDir: path.join(dir, 'logs'),
    obsIntervalMs: 3600000,
    sightRadius: 64,
    placesFile: path.join(dir, 'kp.json'),
    dashBind: '127.0.0.1:0',
    verbDir: path.join(dir, 'verbs'),
    ...extraCfg
  }
  const bot = fakeLiveBot()
  // backend internals that must never reach the dashboard
  bot._client = { secretSocketState: 'x' }
  bot.entities[9] = { id: 9, type: 'mob', name: 'zombie', position: new Vec3(0.5, 64, -4.5), height: 1.95, health: 17, aiTarget: 'Atlas', metadata: [1, 2] }
  bot.world.set(2, 64, -3, 'iron_ore')
  const body = new Body(cfg, { createBot: () => bot })
  body.runner.verbs = { ...VERBS, dig_forever: { run: act => { act.progress('0/1'); return new Promise(() => {}) } } }
  t.after(() => body.close()) // also on failure, so no server is left open
  await body.start()
  bot.emit('spawn')
  const linkUrl = `ws://127.0.0.1:${body.link.wss.address().port}`
  const dashUrl = `http://127.0.0.1:${body.dash.port}`
  return { body, bot, cfg, dir, linkUrl, dashUrl }
}

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
  assert.deepEqual(verbs.map(v => `${v.name}:${v.kind}`).sort(), ['pillar:live', 'recall:built-in', 'say:built-in', 'stop:built-in'])
  assert.match((await get('/api/verbs/say')).body.source, /act\.chat\(text\)/)
  assert.match((await get('/api/verbs/pillar')).body.source, /function pillar/)
  assert.equal((await get('/api/verbs/..%2F..%2Fpackage')).status, 404)

  const conf = (await get('/api/config')).body
  assert.equal(conf.advisor.apiKey, '***')
  assert.equal(conf.advisor.maxDollars, 5)
  assert.equal(conf.mc.username, 'Atlas')
  assert.ok(!JSON.stringify(conf).includes('sk-live-123'))

  const mind = client(`ws://127.0.0.1:${body.link.wss.address().port}`)
  await mind.wait(m => m.type === 'obs')
  const log = (await get('/api/log?n=5')).body
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
