'use strict'
// Locator Bar: real-shaped tracked_waypoint packets (serialised and parsed by
// minecraft-protocol for 26.1, exactly as a server's would be) -> bearings.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { states } = require('minecraft-protocol')
const { createSerializer, createDeserializer } = require('minecraft-protocol/src/transforms/serializer')
const { Locator, yawTowards } = require('../src/locator')
const { MineflayerView } = require('../src/view')
const { buildObs } = require('../src/fairplay/observe')
const { check } = require('../src/schema')
const { maskSecrets } = require('../src/dashboard')
const { fakeBot } = require('./fakeBot')
const { client, startBody } = require('./bodyHarness')

const ser = createSerializer({ state: states.PLAY, isServer: true, version: '26.1' })
const de = createDeserializer({ state: states.PLAY, isServer: false, version: '26.1' })
/** Serialise as a server would, parse as the bot's client does. */
function wire (params) {
  return new Promise((resolve, reject) => {
    de.once('data', p => resolve(p.data.params))
    de.once('error', reject)
    de.write(ser.createPacketBuffer({ name: 'tracked_waypoint', params }))
  })
}
const COLLIN = '0f8fad5b-d9cb-469f-a165-70867728950e'
const FRIEND = '6a2f41a3-c54c-4c1d-8f1b-3a2e7f0d9e11'
const SELF = '11111111-2222-3333-4444-555555555555'
const wp = (operation, uuid, type, data) => ({ operation, waypoint: { hasUUID: true, uuid, icon: { style: 'minecraft:default' }, type, data } })

function locatorBot () {
  const bot = Object.assign(new EventEmitter(), fakeBot())
  bot._client = new EventEmitter()
  bot.players = {
    ACTS_HORIZON: { username: 'ACTS_HORIZON', uuid: COLLIN },
    Friend: { username: 'Friend', uuid: FRIEND.toUpperCase() },
    Atlas: { username: 'Atlas', uuid: SELF }
  }
  return bot
}

test('tracked_waypoint packets -> players on the bar with an azimuth', async () => {
  const bot = locatorBot()
  const loc = new Locator()
  loc.attach(bot)
  const send = async p => bot._client.emit('tracked_waypoint', await wire(p))

  await send(wp('track', COLLIN, 'vec3i', { x: 120, y: 64, z: -30 }))
  assert.deepEqual(loc.list(), [{ name: 'ACTS_HORIZON', azimuth: Math.round(yawTowards(0.5, 0.5, 120.5, -29.5) * 10) / 10 }])
  assert.ok(loc.azimuthOf('ACTS_HORIZON') < -90 && loc.azimuthOf('ACTS_HORIZON') > -120, 'east, a little north')

  await send(wp('update', COLLIN, 'azimuth', 1.25)) // far away: only a direction
  assert.equal(loc.azimuthOf('ACTS_HORIZON'), Math.round(1.25 * 180 / Math.PI * 10) / 10)
  await send(wp('update', COLLIN, 'chunk', { chunkX: 0, chunkZ: 20 })) // due south
  assert.equal(loc.azimuthOf('ACTS_HORIZON'), Math.round(yawTowards(0.5, 0.5, 8, 328) * 10) / 10)
  assert.ok(Math.abs(loc.azimuthOf('ACTS_HORIZON')) < 2, 'south is yaw 0')

  await send(wp('track', FRIEND, 'azimuth', -Math.PI / 2)) // UUID case differs from the tab list
  await send(wp('track', SELF, 'vec3i', { x: 0, y: 64, z: 0 })) // never the bot itself
  await send(wp('track', '99999999-9999-9999-9999-999999999999', 'azimuth', 0)) // not a player in the tab list
  await send({ operation: 'track', waypoint: { hasUUID: false, id: 'custom_marker', icon: { style: 'minecraft:bowtie' }, type: 'vec3i', data: { x: 1, y: 2, z: 3 } } })
  assert.deepEqual(loc.list().map(w => w.name).sort(), ['ACTS_HORIZON', 'Friend'])
  assert.equal(loc.azimuthOf('Friend'), -90)

  await send(wp('update', FRIEND, 'empty')) // on the bar with no direction: no bearing
  assert.equal(loc.azimuthOf('Friend'), null)
  await send(wp('untrack', COLLIN, 'empty')) // the server hides them (sneaking, invisible, out of range)
  assert.equal(loc.azimuthOf('ACTS_HORIZON'), null)
  await send(wp('update', COLLIN, 'azimuth', 0)) // an update for an unknown waypoint counts as a track
  assert.equal(loc.azimuthOf('ACTS_HORIZON'), 0)
  bot.emit('respawn')
  assert.deepEqual(loc.list(), [], 'cleared on respawn / dimension change')
  delete bot.players.ACTS_HORIZON
  await send(wp('track', COLLIN, 'azimuth', 0))
  assert.deepEqual(loc.list(), [], 'left the game: unknown name, not listed')
})

test('obs: a player on the bar but out of sight is bearing-only; in sight, the full entry only', async () => {
  const bot = locatorBot()
  const loc = new Locator()
  loc.attach(bot)
  const view = new MineflayerView(bot, { sightRadius: 64, locator: loc })
  bot._client.emit('tracked_waypoint', await wire(wp('track', COLLIN, 'azimuth', Math.PI / 2))) // yaw 90 = west
  let obs = buildObs(view.snapshot(), {}).obs
  // the bot faces north (mineflayer yaw 0): west is on its left
  assert.deepEqual(obs.players, [{ name: 'ACTS_HORIZON', bearing: 'left' }])
  assert.equal(check('obs', obs), null)
  bot.entities[7] = { id: 7, type: 'player', username: 'ACTS_HORIZON', position: new Vec3(-5.5, 64, 0.5), height: 1.8, eyeHeight: 1.62, yaw: 0, pitch: 0 }
  obs = buildObs(view.snapshot(), {}).obs
  assert.deepEqual(obs.players.map(p => Object.keys(p).sort().join(',')), ['dist,looking_at,name,pos'])
})

test('through the body: bearing-only players reach the mind, goto by bearing is enabled', async (t) => {
  const { bot, linkUrl } = await startBody(t)
  bot.players = { ACTS_HORIZON: { username: 'ACTS_HORIZON', uuid: COLLIN } }
  const mind = client(linkUrl)
  await mind.opened
  bot._client.emit('tracked_waypoint', await wire(wp('track', COLLIN, 'azimuth', Math.PI))) // yaw 180 = north
  mind.send({ type: 'observe', v: '0.1' })
  const o = await mind.wait(m => m.type === 'obs' && m.players.length)
  assert.deepEqual(o.players, [{ name: 'ACTS_HORIZON', bearing: 'front' }], 'the bot faces north too')
  mind.send({ type: 'call', v: '0.1', id: 'g1', verb: 'goto', args: { target: 'ACTS_HORIZON' } })
  const r = await mind.wait(m => m.type === 'result' && m.id === 'g1')
  assert.equal(check('result', r), null)
  // not refused: it follows the bearing (the fake bot has no pathfinder, so the first leg finds no path)
  assert.deepEqual([r.status, r.detail], ['failed', "blocked while following ACTS_HORIZON's bearing after 0 blocks (no_path)"])
  mind.ws.close()
})

test('dashboard config masking covers ATLAS_LLM_KEY, by name and by value', () => {
  const saved = process.env.ATLAS_LLM_KEY
  process.env.ATLAS_LLM_KEY = 'sk-live-abc123'
  try {
    const m = maskSecrets({ ATLAS_LLM_KEY: 'sk-live-abc123', llm: { url: 'http://gpu:8080/v1', key: 'x1', llmKey: 'x2' }, note: 'uses sk-live-abc123 inside', model: 'gemma' })
    assert.deepEqual(m, { ATLAS_LLM_KEY: '***', llm: { url: 'http://gpu:8080/v1', key: '***', llmKey: '***' }, note: '***', model: 'gemma' })
  } finally {
    if (saved === undefined) delete process.env.ATLAS_LLM_KEY; else process.env.ATLAS_LLM_KEY = saved
  }
})
