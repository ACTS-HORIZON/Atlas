'use strict'
// The new verbs through the real Body and link (fake bot, no pathfinder):
// refusals and results arrive as contract messages and reach the tap.
const test = require('node:test')
const assert = require('node:assert/strict')
const { check } = require('../src/schema')
const { client, startBody } = require('./bodyHarness')

test('verbs over the link: fair-play refusals, validation, result shapes', async (t) => {
  const { linkUrl, dashUrl } = await startBody(t)
  const dash = client(dashUrl.replace('http', 'ws') + '/tap')
  const mind = client(linkUrl)
  await Promise.all([mind.opened, dash.opened])
  await mind.wait(m => m.type === 'obs')
  const call = async (id, verb, args) => {
    mind.send({ type: 'call', v: '0.1', id, verb, args })
    const r = await mind.wait(m => m.type === 'result' && m.id === id)
    assert.equal(check('result', r), null)
    return r
  }
  let r = await call('c1', 'mine', { block: 'stone', count: 4 }) // stone in view, but no pickaxe
  assert.deepEqual([r.status, r.obs.task], ['failed', null])
  assert.match(r.detail, /stone needs one of: wooden_pickaxe/)
  r = await call('c2', 'goto', { target: 'diamond_ore' })
  assert.equal(r.status, 'refused')
  r = await call('c3', 'goto', { target: 'iron_ore' }) // seen in the fake world; no pathfinder on a fake bot
  assert.equal(r.status, 'failed')
  assert.deepEqual(Object.keys(r.data).sort(), ['pos', 'remaining'])
  r = await call('c4', 'explore', { direction: 'up', distance: 3 })
  assert.equal(r.status, 'failed')
  r = await call('c5', 'collect', { item: 'diamond' })
  assert.deepEqual([r.status, r.detail, r.data], ['done', 'no diamond drops in sight', { item: 'diamond', collected: 0, unreachable: 0 }])
  r = await call('c6', 'mine', { block: 'iron_ore', box: [[0, 0, 0], [1, 1, 1]] })
  assert.match(r.detail, /box is not supported yet/)
  await dash.wait(e => e.msg.type === 'result' && e.msg.id === 'c6')
  mind.ws.close(); dash.ws.close()
})
