'use strict'
// goto, explore, mine, collect without a server: the real filtered API
// (src/api.js) over a fake voxel world and the real fair-play builder, with
// a fake motor standing in for Mineflayer movement and digging.
const test = require('node:test')
const assert = require('node:assert/strict')
const { FakeWorld } = require('./fakeWorld')
const { Runner } = require('../src/runner')

const { world, setup, run } = require('./verbHarness')

test('argument validation', async () => {
  const { act } = setup(world())
  const bad = [
    ['goto', {}, /exactly one of pos or target/],
    ['goto', { pos: [1, 2, 3], target: 'chest' }, /exactly one of pos or target/],
    ['goto', { pos: [1, 2] }, /pos/],
    ['goto', { pos: [1, 2, 3], speed: 3 }, /unknown argument "speed"/],
    ['explore', { direction: 'up', distance: 10 }, /direction/],
    ['explore', { direction: 'north', distance: 0 }, /distance/],
    ['explore', { direction: 'north' }, /distance/],
    ['mine', {}, /block/],
    ['mine', { block: 'iron_ore', count: 0 }, /count/],
    ['mine', { block: 'iron_ore', radius: 1000 }, /radius/],
    ['mine', { block: 'iron_ore', box: [[0, 0, 0], [1, 1, 1]], count: 2 }, /with box, only block may go with it/],
    ['mine', { block: 'not_a_block' }, /unknown block/],
    ['collect', {}, /item/],
    ['collect', { item: 'not_an_item' }, /unknown item/]
  ]
  for (const [verb, args, re] of bad) {
    const r = await run(verb, act, args)
    assert.equal(r.status, 'failed', `${verb} ${JSON.stringify(args)}`)
    assert.match(r.detail, re, `${verb} ${JSON.stringify(args)}`)
  }
})

test('goto: a target must have been observed (fair play); pos is free', async () => {
  const w = world()
  w.set(0, 10, 8, 'chest') // in the open: seen
  w.set(0, 7, 3, 'diamond_ore') // inside rock: never seen
  w.box([4, 10, 4], [8, 14, 4], 'stone') // wall
  const hidden = { name: 'Hidden', pos: [6.5, 10, 7.5], look: [0, 0, 1] }
  const visible = { name: 'ACTS_HORIZON', pos: [-4.5, 10, 5.5], look: [0, 0, 1] }
  const { act, motor } = setup(w, { players: [hidden, visible], entities: [{ id: 5, type: 'cow', pos: [-6.5, 10, -2.5], height: 1.4 }] })

  for (const t of ['diamond_ore', 'Hidden', 'zombie', 'iron_ore']) {
    const r = await run('goto', act, { target: t })
    assert.equal(r.status, 'refused', t)
    assert.match(r.detail, /fair play/)
  }
  assert.equal(motor.calls.filter(c => c[0] === 'goto').length, 0, 'never moved for an unobserved target')

  let r = await run('goto', act, { target: 'chest' })
  assert.equal(r.status, 'done')
  assert.deepEqual(motor.calls.at(-1)[1].pos, [0.5, 10.5, 8.5])
  assert.equal(motor.calls.at(-1)[1].range, 2)
  assert.match(r.detail, /block chest at \[0, 10, 8\]/)
  r = await run('goto', act, { target: 'ACTS_HORIZON' })
  assert.equal(r.status, 'done')
  assert.deepEqual(motor.calls.at(-1)[1].pos, [-4.5, 10, 5.5])
  r = await run('goto', act, { target: 'cow' })
  assert.equal(r.status, 'done')
  r = await run('goto', act, { pos: [100, 64, -20] })
  assert.deepEqual(r, { status: 'done', detail: 'arrived at [100, 64, -20]', data: { pos: [100, 64, -20], remaining: 0 } })
})

test('goto: done / partial (gave up, distance left) / failed (no path)', async () => {
  const outcomes = [
    [{ status: 'stuck', remaining: 12.3, moved: 20 }, 'partial', /gave up 12.3 blocks short .* \(stuck\)/],
    [{ status: 'timeout', remaining: 4, moved: 30 }, 'partial', /took too long/],
    [{ status: 'no_path', remaining: 40, moved: 0 }, 'failed', /no path to \[40, 64, 0\]/],
    [{ status: 'no_path', remaining: 9, moved: 25 }, 'partial', /no further path/]
  ]
  for (const [g, status, re] of outcomes) {
    const { act } = setup(world(), { goto: () => g })
    const r = await run('goto', act, { pos: [40, 64, 0] })
    assert.equal(r.status, status)
    assert.match(r.detail, re)
    assert.deepEqual(Object.keys(r.data).sort(), ['pos', 'remaining'])
    assert.equal(r.data.remaining, g.remaining)
  }
  const { act } = setup(world(), { gamemode: 'spectator' })
  assert.equal((await run('goto', act, { pos: [1, 2, 3] })).status, 'failed')
})

test('mine: only observed blocks are dug; visible common blocks count as observed', async () => {
  const w = world()
  w.set(0, 10, 6, 'iron_ore').set(3, 10, 7, 'iron_ore') // in the open
  w.set(0, 7, 2, 'iron_ore') // buried: never seen
  const { act, motor, api } = setup(w)

  let r = await run('mine', act, { block: 'iron_ore', count: 5, radius: 32 })
  assert.equal(r.status, 'partial')
  assert.match(r.detail, /mined 2 of 5 iron_ore; none left in view within 32 blocks/)
  assert.deepEqual(r.data, { block: 'iron_ore', mined: 2, requested: 5, tunnel: 0 })
  const dug = motor.calls.filter(c => c[0] === 'dig').map(c => c[1].join(','))
  assert.deepEqual(dug, ['0,10,6', '3,10,7'], 'nearest first, and never the buried one')
  assert.ok(motor.calls.some(c => c[0] === 'goto' && c[1].kind === 'look' && c[1].dig === true && c[1].scaffold === true))

  // the API itself refuses a dig at a position that was not observed
  const d = await api.digObserved([0, 7, 2], 'iron_ore', {})
  assert.equal(d.refused, true)
  assert.match(d.reason, /fair play: no iron_ore has been observed at \[0, 7, 2\]/)
  assert.equal(motor.calls.filter(c => c[0] === 'dig').length, 2)

  // stone is a common type: the visible ground counts, the stone underneath does not
  r = await run('mine', act, { block: 'stone', count: 3 })
  assert.equal(r.status, 'done')
  const stone = motor.calls.filter(c => c[0] === 'dig').slice(2).map(c => c[1])
  assert.equal(stone.length, 3)
  for (const p of stone) assert.equal(p[1], 9, 'only the exposed top layer of the ground')
})

test('mine: a common type or a non-ore not in view fails; ores not in view strip-mine', async () => {
  const w = new FakeWorld({ fill: 'air' }) // nothing to see at all
  const { act } = setup(w)
  assert.deepEqual(await run('mine', act, { block: 'gravel', count: 2 }), { status: 'failed', detail: 'mine: no gravel in view within 24 blocks' })
  assert.deepEqual(await run('mine', act, { block: 'oak_log', count: 2 }), { status: 'failed', detail: 'mine: no oak_log in view within 32 blocks' })
})

test('mine: done at count; missing tool fails before moving; unreachable targets are skipped', async () => {
  let w = world(); w.set(0, 10, 6, 'coal_ore').set(2, 10, 6, 'coal_ore').set(-2, 10, 6, 'coal_ore')
  let s = setup(w)
  let r = await run('mine', s.act, { block: 'coal_ore', count: 2 })
  assert.deepEqual([r.status, r.detail, r.data.mined], ['done', 'mined 2 coal_ore', 2])

  w = world(); w.set(0, 10, 6, 'diamond_ore')
  s = setup(w, { tool: () => ({ ok: false, needsTool: true, reason: 'diamond_ore needs one of: iron_pickaxe, diamond_pickaxe, netherite_pickaxe; none in inventory' }) })
  r = await run('mine', s.act, { block: 'diamond_ore' })
  assert.equal(r.status, 'failed')
  assert.match(r.detail, /needs one of: iron_pickaxe/)
  assert.equal(s.motor.calls.length, 0, 'did not walk anywhere')

  w = world(); w.set(0, 10, 6, 'gold_ore').set(5, 10, 9, 'gold_ore')
  s = setup(w, { goto: o => (o.pos[0] === 0 ? { status: 'no_path', remaining: 6, moved: 0 } : { status: 'reached', remaining: 0, moved: 4 }) })
  r = await run('mine', s.act, { block: 'gold_ore', count: 2 })
  assert.deepEqual([r.status, r.data.mined], ['partial', 1])
  assert.deepEqual(s.motor.calls.filter(c => c[0] === 'dig').map(c => c[1].join(',')), ['5,10,9'])
})

test('mine: none seen at all -> strip-mine a 1x2 tunnel at the current y, stopping for lava', async () => {
  // bot underground in a 1x2 pocket, facing south; stone all around
  const w = new FakeWorld({ fill: 'stone' })
  w.box([0, 10, 0], [0, 11, 0], 'air')
  w.set(0, 7, 4, 'diamond_ore') // buried below the tunnel line: never seen, never targeted
  w.set(0, 10, 4, 'lava') // the tunnel runs into it after a few blocks
  const { act, motor } = setup(w, { pos: [0.5, 10, 0.5], walk: true })
  const r = await run('mine', act, { block: 'diamond_ore', count: 2 })
  assert.equal(r.status, 'partial')
  assert.match(r.detail, /mined 0 of 2 diamond_ore; strip-mining stopped: lava ahead/)
  const digs = motor.calls.filter(c => c[0] === 'dig')
  assert.ok(digs.length >= 4)
  for (const [, pos, allowHand] of digs) {
    assert.equal(pos[0], 0); assert.ok(pos[1] === 10 || pos[1] === 11, 'feet or head level only'); assert.equal(allowHand, true)
  }
  assert.ok(!digs.some(c => c[1].join(',') === '0,7,4'), 'the buried diamond was never dug')
  assert.equal(r.data.tunnel, 2)
})

test('mine: strip-mining turns after the configured length (serpentine) and stops at the cap', async () => {
  const w = new FakeWorld({ fill: 'stone' })
  w.box([0, 10, 0], [0, 11, 0], 'air')
  const facings = []
  const { act, motor } = setup(w, { pos: [0.5, 10, 0.5], walk: true })
  const face = motor.face.bind(motor)
  motor.face = async d => { facings.push(d); return face(d) }
  const r = await run('mine', act, { block: 'emerald_ore', count: 1 }) // cfg: length 4, cap 6
  assert.equal(r.status, 'partial')
  assert.match(r.detail, /tunnel limit of 6 blocks reached/)
  assert.deepEqual(facings, ['south', 'west'], 'turned right after 4 blocks')
  assert.deepEqual(motor.pos.map(Math.floor), [-2, 10, 4])
})

test('collect: only drops in sight; partial when some stay out of reach', async () => {
  const w = world()
  w.box([3, 10, -3], [3, 13, 3], 'stone') // wall east of the bot
  const drops = [
    { id: 1, item: 'oak_log', pos: [0.5, 10, 4.5], height: 0.25 },
    { id: 2, item: 'oak_log', pos: [-3.5, 10, 2.5], height: 0.25 },
    { id: 3, item: 'oak_log', pos: [6.5, 10, 0.5], height: 0.25 }, // behind the wall
    { id: 4, item: 'cobblestone', pos: [1.5, 10, 2.5], height: 0.25 }
  ]
  let s = setup(w, {
    drops,
    goto: (o, m) => { const d = drops.find(x => x.pos[0] === o.pos[0] && x.pos[2] === o.pos[2]); if (d) m.picked.add(d.id); return { status: 'reached', remaining: 0, moved: 3 } },
    invAfter: m => ({ oak_log: [...m.picked].filter(id => id <= 3).length })
  })
  let r = await run('collect', s.act, { item: 'oak_log' })
  assert.deepEqual(r, { status: 'done', detail: 'collected 2 oak_log; none left in sight', data: { item: 'oak_log', collected: 2, unreachable: 0 } })
  const went = s.motor.calls.filter(c => c[0] === 'goto').map(c => c[1].pos.join(','))
  assert.ok(!went.includes('6.5,10,0.5'), 'never went for the drop behind the wall')
  assert.ok(!s.motor.picked.has(4), 'other items left alone')

  s = setup(w, { drops, goto: () => ({ status: 'stuck', remaining: 3, moved: 0 }) })
  r = await run('collect', s.act, { item: 'oak_log' })
  assert.equal(r.status, 'partial')
  assert.deepEqual(r.data, { item: 'oak_log', collected: 0, unreachable: 2 })

  s = setup(world(), { drops: [] })
  assert.deepEqual(await run('collect', s.act, { item: 'diamond' }), { status: 'done', detail: 'no diamond drops in sight', data: { item: 'diamond', collected: 0, unreachable: 0 } })
})

test('explore: walks in legs, reports what it saw and new known places', async () => {
  const w = world()
  w.set(2, 10, 10, 'oak_log') // visible from the start: seen, but not a new place
  w.box([-31, 10, 13], [31, 14, 13], 'stone') // a ridge; behind it, only visible after the first leg
  w.set(-2, 10, 20, 'oak_log').set(1, 10, 26, 'iron_ore')
  const { act, motor } = setup(w, { walk: true })
  const r = await run('explore', act, { direction: 'south', distance: 24 })
  assert.equal(r.status, 'done')
  assert.deepEqual(r.data, { direction: 'south', walked: 24, seen: { oak_log: 2, iron_ore: 1 }, new_places: 2 })
  assert.match(r.detail, /^walked 24 blocks south; saw oak_log 2, iron_ore 1; 2 new known places$/)
  assert.deepEqual(motor.calls.filter(c => c[0] === 'goto').map(c => [c[1].kind, c[1].pos[2]]), [['xz', 16.5], ['xz', 24.5]])

  const s = setup(world(), { goto: () => ({ status: 'stuck', remaining: 10, moved: 0 }) })
  const p = await run('explore', s.act, { direction: 'forward', distance: 30 })
  assert.equal(p.status, 'partial')
  assert.equal(p.data.direction, 'south', 'forward = the way the bot faces')
  assert.match(p.detail, /no way on in any direction: south \(blocked, nothing seen in front\); west/)
  assert.equal(p.data.direction, "south")
})

test('explore: dig defaults on (it tunnels through what is in front, never places); "no way on" names what blocked it', async () => {
  const w = world().box([-31, 10, 2], [31, 11, 2], 'stone').set(0, 11, 2, 'oak_leaves')
  let s = setup(w, { goto: () => ({ status: 'no_path', remaining: 10, moved: 0 }) })
  const r = await run('explore', s.act, { direction: 'south', distance: 20 })
  const g = s.motor.calls.find(c => c[0] === 'goto')[1]
  assert.deepEqual([g.dig, g.scaffold], [true, false])
  assert.match(r.detail, /^walked 0 of 20 blocks: no way on in any direction: south \(ahead south 2 blocks: stone at feet, oak_leaves at head\); west \(no way on, nothing seen in front\); east \(no way on, nothing seen in front\); north \(no way on, nothing seen in front\); saw/)
  assert.equal(s.motor.calls.filter(c => c[0] === 'goto').length, 4, 'all four directions tried')
  s = setup(world(), { walk: true })
  await run('explore', s.act, { direction: 'north', distance: 5, dig: false })
  assert.equal(s.motor.calls.find(c => c[0] === 'goto')[1].dig, false)
})

test('runner: long verbs are the task with progress, others are busy, stop interrupts', async () => {
  const { act, motor } = setup(world(), { goto: () => 'never' })
  const r = new Runner()
  const pending = r.run(act, { id: 'c1', verb: 'goto', args: { pos: [50, 64, 0] } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(r.task().verb, 'goto')
  assert.match(r.task().progress, /to \[50, 64, 0\]/)
  for (const verb of ['mine', 'explore', 'collect', 'goto']) {
    assert.deepEqual(await r.run(act, { id: 'x', verb, args: {} }), { status: 'refused', detail: 'busy' }, verb)
  }
  assert.equal((await r.run(act, { id: 'c2', verb: 'say', args: { text: 'on my way' } })).status, 'done')
  assert.deepEqual(await r.run(act, { id: 'c3', verb: 'stop' }), { status: 'done', detail: 'stopped goto' })
  const res = await pending
  assert.equal(res.status, 'interrupted')
  assert.match(res.detail, /^goto: stopped by call c3 \(at: to \[50, 64, 0\]\)$/)
  assert.ok(motor.calls.some(c => c[0] === 'stop'), 'movement stopped')
  assert.equal(r.task(), null)
})

test('runner: stop during strip-mining interrupts mine', async () => {
  const w = new FakeWorld({ fill: 'stone' })
  w.box([0, 10, 0], [0, 11, 0], 'air')
  const { act, motor } = setup(w, { pos: [0.5, 10, 0.5], walk: true })
  let digs = 0
  const dig = motor.dig.bind(motor)
  motor.dig = async (pos, o) => { digs++; await new Promise(resolve => setTimeout(resolve, 30)); return dig(pos, o) }
  const r = new Runner()
  const pending = r.run(act, { id: 'm1', verb: 'mine', args: { block: 'diamond_ore', count: 3 } })
  while (digs < 2) await new Promise(resolve => setTimeout(resolve, 10))
  assert.match(r.task().progress, /0\/3 diamond_ore/)
  r.stop(act, 'dashboard')
  const res = await pending
  assert.equal(res.status, 'interrupted')
  assert.match(res.detail, /^mine: stopped by dashboard/)
  const after = digs
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.ok(digs <= after + 1, 'no further digging after stop')
})

test('motor.toolFor picks the best tool from the inventory (real 26.1 registry)', () => {
  const { Motor } = require('../src/motor')
  const registry = require('prismarine-registry')('26.1')
  const bot = (items, gameMode = 'survival') => ({
    registry,
    game: { gameMode },
    inventory: { items: () => items.map(n => ({ name: n, type: registry.itemsByName[n].id, count: 1 })) }
  })
  let m = new Motor(bot(['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'dirt']))
  assert.deepEqual([m.toolFor('iron_ore').ok, m.toolFor('iron_ore').tool], [true, 'iron_pickaxe'])
  m = new Motor(bot(['wooden_pickaxe']))
  const t = m.toolFor('iron_ore')
  assert.equal(t.ok, false)
  assert.match(t.reason, /iron_ore needs one of: .*stone_pickaxe.*; none in inventory/)
  assert.equal(m.toolFor('diamond_ore').ok, false)
  assert.equal(m.toolFor('stone').tool, 'wooden_pickaxe')
  m = new Motor(bot([]))
  assert.equal(m.toolFor('stone').ok, false, 'stone drops nothing by hand')
  assert.deepEqual([m.toolFor('stone', { allowHand: true }).ok, m.toolFor('stone', { allowHand: true }).tool], [true, null], 'but a tunnel can be dug by hand')
  assert.deepEqual([m.toolFor('oak_log').ok, m.toolFor('oak_log').tool], [true, null], 'logs by hand')
  assert.equal(m.toolFor('bedrock').ok, false)
  assert.equal(new Motor(bot([], 'creative')).toolFor('diamond_ore').ok, true, 'creative needs no tool')
  m = new Motor(bot(['stone_axe', 'stone_pickaxe']))
  assert.equal(m.toolFor('oak_log').tool, 'stone_axe')
})

test('motor.facing maps mineflayer yaw to cardinal directions', () => {
  const { Motor } = require('../src/motor')
  const m = yaw => new Motor({ entity: { yaw } }).facing()
  assert.deepEqual([m(0), m(Math.PI / 2), m(Math.PI), m(-Math.PI / 2), m(3 * Math.PI / 2 + 0.2)], ['north', 'west', 'south', 'east', 'east'])
})

test('api.peek: reads a block only if the bot can see it', () => {
  const w = world()
  w.box([3, 10, -3], [3, 13, 3], 'stone') // wall east of the bot
  w.set(5, 10, 0, 'gold_block') // behind it
  w.box([-3, 5, -1], [-1, 7, 1], 'air') // a closed cave under the ground
  const { api } = setup(w)
  assert.equal(api.peek([3, 10, 0]), 'stone', 'the wall face')
  assert.equal(api.peek([5, 10, 0]), null, 'behind the wall')
  assert.equal(api.peek([4, 10, 0]), null, 'air behind the wall is not known either')
  assert.equal(api.peek([-2, 6, 0]), null, 'a hidden cave stays hidden')
  assert.equal(api.peek([0, 9, 2]), 'stone', 'the ground in front')
  assert.equal(api.peek([0, 10, 2]), 'air', 'open air in front')
  assert.equal(api.peek([0, 8, 2]), null, 'under the ground')
})

test('explore in a cave: the asked way is a wall, so it tries right, left and back, and goes the first way that moves', async () => {
  const w = world().box([-31, 10, -2], [31, 11, -2], 'stone') // a wall just north
  const s = setup(w, { walk: true, goto: o => (o.pos[2] < 0 ? { status: 'no_path', remaining: 16, moved: 0 } : o.pos[0] > 1 ? { status: 'reached', remaining: 0, moved: 16 } : { status: 'no_path', remaining: 16, moved: 0 }) })
  const r = await run('explore', s.act, { direction: 'north', distance: 16 })
  assert.equal(r.status, 'done')
  assert.match(r.detail, /^couldn't go north \(ahead north 2 blocks: stone at feet, stone at head\), so went east: walked 16 blocks east; saw/)
  assert.deepEqual([r.data.direction, r.data.asked], ['east', 'north'])
  assert.deepEqual(s.motor.calls.filter(c => c[0] === 'goto').map(c => [Math.round(c[1].pos[0]), Math.round(c[1].pos[2])]), [[1, -15], [17, 1]])
})
