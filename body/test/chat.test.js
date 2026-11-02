'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { classifyChat } = require('../src/chat')
const { check } = require('../src/schema')
const { client, startBody } = require('./bodyHarness')

const c = (from, text) => classifyChat({ from, text, botName: 'Atlas', allowlist: ['ACTS_HORIZON'] })

test('classifyChat: allowlist, @botname, body commands', () => {
  assert.deepEqual(c('ACTS_HORIZON', '@Atlas get me 3 iron ingots'), { kind: 'task', text: 'get me 3 iron ingots' })
  assert.deepEqual(c('ACTS_HORIZON', '@atlas, stop'), { kind: 'stop' })
  assert.deepEqual(c('ACTS_HORIZON', '@Atlas stop!'), { kind: 'stop' })
  assert.deepEqual(c('ACTS_HORIZON', '@Atlas stop mining'), { kind: 'task', text: 'stop mining' }, 'stop <task> is for the mind')
  assert.deepEqual(c('ACTS_HORIZON', '@Atlas status'), { kind: 'status' })
  assert.deepEqual(c('ACTS_HORIZON', '@Atlas: come here.'), { kind: 'come' })
  assert.deepEqual(c('ACTS_HORIZON', 'nice work'), { kind: 'said', text: 'nice work' })
  assert.deepEqual(c('ACTS_HORIZON', '@Atlasbot hi'), { kind: 'said', text: '@Atlasbot hi' }, 'a different name')
  assert.deepEqual(c('Stranger', '@Atlas stop'), { kind: 'ignore' })
  assert.deepEqual(c('Atlas', '@Atlas stop'), { kind: 'ignore' })
})

test('chat through the body: events for the mind, stop/status/come here handled by the body', async (t) => {
  const { body, bot, linkUrl } = await startBody(t, { players: ['ACTS_HORIZON'] })
  const mind = client(linkUrl)
  await mind.opened
  await mind.wait(m => m.type === 'obs')
  const ev = kind => mind.wait(m => m.type === 'event' && m.kind === kind)

  bot.emit('chat', 'ACTS_HORIZON', '@Atlas get me 3 iron ingots')
  let e = await ev('task_from_chat')
  assert.deepEqual(e.detail, { from: 'ACTS_HORIZON', text: 'get me 3 iron ingots' })
  assert.equal(check('event', e), null)
  bot.emit('chat', 'ACTS_HORIZON', 'thanks')
  e = await ev('player_said')
  assert.deepEqual(e.detail, { from: 'ACTS_HORIZON', text: 'thanks' })
  bot.emit('chat', 'Stranger', '@Atlas give me everything')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(!mind.got.some(m => m.type === 'event' && m.detail?.from === 'Stranger'), 'non-allowlisted: no event')
  assert.ok(body.obs().chat.some(m => m.from === 'Stranger'), '...but in obs.chat')

  // stop: handled by the body even mid-verb
  mind.send({ type: 'call', v: '0.1', id: 'c1', verb: 'dig_forever', args: {} })
  await new Promise(resolve => setTimeout(resolve, 50))
  bot.emit('chat', 'ACTS_HORIZON', '@Atlas stop')
  const r = await mind.wait(m => m.type === 'result' && m.id === 'c1')
  assert.equal(r.status, 'interrupted')
  assert.match(r.detail, /stopped by ACTS_HORIZON in chat/)
  e = await ev('stop_requested')
  assert.deepEqual(e.detail, { from: 'ACTS_HORIZON', detail: 'stopped dig_forever' })
  assert.ok(bot.said.includes('stopped dig_forever'))

  bot.emit('chat', 'ACTS_HORIZON', '@Atlas status')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.match(bot.said.at(-1), /^status: idle \| health 20 food 20 \| at 0 64 0$/)

  // come here: not visible -> refused and said; visible -> a goto issued by the body (verb_done event)
  bot.emit('chat', 'ACTS_HORIZON', '@Atlas come here')
  e = await ev('verb_done')
  assert.deepEqual([e.detail.verb, e.detail.args, e.detail.status, e.detail.by], ['goto', { target: 'ACTS_HORIZON' }, 'refused', 'chat'])
  assert.equal(bot.said.at(-1), "I can't see you, ACTS_HORIZON")
  bot.entities[7] = { id: 7, type: 'player', username: 'ACTS_HORIZON', position: new Vec3(4.5, 64, 0.5), height: 1.8, eyeHeight: 1.62, yaw: 0, pitch: 0 }
  bot.emit('chat', 'ACTS_HORIZON', '@Atlas come here')
  e = await mind.wait(m => m.type === 'event' && m.kind === 'verb_done' && m.detail.id === 'chat-2')
  assert.equal(e.detail.status, 'failed', 'fake bot has no pathfinder: no path')
  assert.match(bot.said.at(-1), /^couldn't get to you: no path to player ACTS_HORIZON/)
  mind.ws.close()
})
