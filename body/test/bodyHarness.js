'use strict'
// Shared harness: a real Body (link, tap, dashboard) driven by a fake bot.
const fs = require('fs')
const os = require('os')
const path = require('path')
const WebSocket = require('ws')
const { Vec3 } = require('vec3')
const { Body } = require('../src/body')
const { VERBS } = require('../src/verbs')
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

/**
 * A real Body with a fake bot. opts.spawn (default true) emits 'spawn';
 * opts.vitals (default true) leaves health/food known, false makes them
 * unknown as right after a real spawn.
 */
async function startBody (t, extraCfg = {}, { spawn = true, vitals = true } = {}) {
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
  if (!vitals) { bot.health = undefined; bot.food = undefined }
  const body = new Body(cfg, { createBot: () => bot })
  body.runner.verbs = { ...VERBS, dig_forever: { run: act => { act.progress('0/1'); return new Promise(() => {}) } } }
  t.after(() => body.close()) // also on failure, so no server is left open
  await body.start()
  if (spawn) bot.emit('spawn')
  const linkUrl = `ws://127.0.0.1:${body.link.wss.address().port}`
  const dashUrl = `http://127.0.0.1:${body.dash.port}`
  return { body, bot, cfg, dir, linkUrl, dashUrl }
}

module.exports = { client, startBody }
