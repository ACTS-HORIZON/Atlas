'use strict'
// No obs is built or sent until health and food are known.
const test = require('node:test')
const assert = require('node:assert/strict')
const { check } = require('../src/schema')
const { client, startBody } = require('./bodyHarness')

const settle = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms))

test('spawn before health: nothing is sent until the health event, then a valid obs', async (t) => {
  const { body, bot, linkUrl, dashUrl } = await startBody(t, {}, { vitals: false })
  const dash = client(dashUrl.replace('http', 'ws') + '/tap')
  const mind = client(linkUrl)
  await Promise.all([dash.opened, mind.opened])
  mind.send({ type: 'observe', v: '0.1' })
  mind.send({ type: 'call', v: '0.1', id: 'c1', verb: 'say', args: { text: 'too early' } })
  const early = await mind.wait(m => m.type === 'result' && m.id === 'c1')
  assert.deepEqual([early.status, early.detail, early.obs], ['failed', 'not connected to the server', null])
  await settle()
  assert.equal(body.obs(), null)
  assert.deepEqual(mind.got.filter(m => m.type === 'obs'), [], 'no obs to the mind')
  assert.deepEqual(dash.got.filter(e => e.msg.type === 'obs'), [], 'no obs on the tap')
  assert.equal(body.tap.dropped, 0, 'nothing invalid was even attempted')
  assert.deepEqual(bot.said, [])

  bot.health = 20; bot.food = 18
  bot.emit('health')
  const o = await mind.wait(m => m.type === 'obs')
  assert.equal(check('obs', o), null)
  assert.deepEqual([o.self.health, o.self.food], [20, 18])
  await dash.wait(e => e.msg.type === 'obs')
  mind.ws.close(); dash.ws.close()
})

test('health before spawn: the first obs goes out at spawn, exactly once', async (t) => {
  const { bot, linkUrl } = await startBody(t, {}, { spawn: false, vitals: false })
  const mind = client(linkUrl)
  await mind.opened
  bot.health = 20; bot.food = 20
  bot.emit('health') // not spawned yet
  await settle()
  assert.deepEqual(mind.got, [])
  bot.emit('spawn')
  await mind.wait(m => m.type === 'obs')
  bot.emit('health') // later health updates do not re-announce
  await settle()
  assert.equal(mind.got.filter(m => m.type === 'obs').length, 1)
  mind.ws.close()
})
