'use strict'
// Shared harness for verb tests: the real filtered API (src/api.js) over a
// fake voxel world and the real fair-play builder, with a fake motor
// standing in for Mineflayer movement, digging, crafting and eating.
const { FakeWorld, makeView } = require('./fakeWorld')
const { buildObs, recheckKnown } = require('../src/fairplay/observe')
const { KnownPlaces } = require('../src/places')
const { VerbApi } = require('../src/api')
const { VERBS } = require('../src/verbs')
const { mineHint, collectHint, dropsOf } = require('../src/drops')
const REG = require('prismarine-registry')('26.1')

// Flat stone ground at y<=9, bot standing at (0.5, 10, 0.5) facing south (+Z).
function world () { return new FakeWorld().box([-32, 0, -32], [31, 9, 31], 'stone') }

/** Fake motor: records calls; movement and digging are scripted. */
function fakeMotor (w, opt = {}) {
  const m = {
    pos: opt.pos || [0.5, 10, 0.5],
    calls: [],
    picked: new Set(),
    here () { return [...this.pos] },
    gamemode () { return opt.gamemode || 'survival' },
    facing () { return this.dir || opt.facing || 'south' },
    goto (o) {
      this.calls.push(['goto', o])
      const r = opt.goto ? opt.goto(o, this) : { status: 'reached', remaining: 0, moved: 3 }
      if (r === 'never') {
        return new Promise(resolve => o.signal.addEventListener('abort', () => resolve({ status: 'aborted', remaining: 5, moved: 0 }), { once: true }))
      }
      if (r.status === 'reached' && o.kind !== 'look' && opt.walk) this.pos = [o.pos[0], opt.walk === '3d' ? o.pos[1] : this.pos[1], o.pos[2]]
      return Promise.resolve(r)
    },
    stop () { this.calls.push(['stop']) },
    toolFor (name) { return opt.tool ? opt.tool(name) : { ok: true, tool: 'iron_pickaxe' } },
    async dig (pos, o = {}) {
      this.calls.push(['dig', pos, !!o.allowHand])
      const fail = opt.digFail && opt.digFail(pos, this)
      if (fail) return { ok: false, reason: fail }
      w.set(pos[0], pos[1], pos[2], 'air')
      return { ok: true, name: 'x' }
    },
    async look (yaw, pitch) { this.calls.push(['look', yaw, pitch]) },
    async jump () { this.calls.push(['jump']); return { ok: true } },
    // the player's step/sprint press: one block (two sprinting) at once in the fake world
    async press (dir, o = {}) {
      this.calls.push(['press', dir, !!o.sprint])
      this.dir = dir
      const d = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[dir]
      const n = o.sprint ? 2 : 1
      this.pos = [this.pos[0] + d[0] * n, this.pos[1], this.pos[2] + d[1] * n]
      return { ok: true, moving: true }
    },
    release () {},
    async pillar (item) {
      this.calls.push(['pillar', item])
      const f = this.pos.map(Math.floor)
      w.set(f[0], f[1], f[2], item)
      this.pos = [this.pos[0], this.pos[1] + 1, this.pos[2]]
      return { ok: true }
    },
    async attack (type, pos) { this.calls.push(['attack', type, pos]); return { ok: true } },
    async shield () { this.calls.push(['shield']); return { ok: true } },
    pause () { this.calls.push(['pause']); this.paused = true },
    resume () { this.calls.push(['resume']); this.paused = false },
    async face (d) { this.calls.push(['face', d]); this.dir = d },
    drops () { return (opt.drops || []).filter(d => !this.picked.has(d.id)) },
    entityExists (id) { return (opt.drops || []).some(d => d.id === id) && !this.picked.has(id) },
    inventory () { return { ...(opt.inv || {}), ...(opt.invAfter ? opt.invAfter(this) : {}) } },
    dimension () { return 'overworld' },
    food () { return opt.food ?? 20 },
    foods () { return opt.foods || [] },
    isFood (n) { return (opt.edible || ['bread', 'cooked_beef', 'rotten_flesh', 'apple']).includes(n) },
    async eat (item) { this.calls.push(['eat', item]); opt.food = Math.min(20, (opt.food ?? 20) + 5); return { ok: true } },
    async equip (item, slot) { this.calls.push(['equip', item, slot]); return { ok: true } },
    async place (item, ref, pos) { this.calls.push(['place', item, ref, pos]); w.set(pos[0], pos[1], pos[2], item); return { ok: true } },
    craftPlan (item, count) { return opt.craftPlan ? opt.craftPlan(item, count) : { known: true, options: [] } },
    async craft (item, count, tablePos) { this.calls.push(['craft', item, count, tablePos]); return { ok: true, crafted: count } },
    async toss (item, count, at) {
      this.calls.push(['toss', item, count, at])
      const have = (opt.inv || {})[item] || 0
      const n = Math.min(count, have)
      if (opt.inv) opt.inv[item] = have - n
      return n ? { ok: true, tossed: n } : { ok: false, tossed: 0, reason: `no ${item} in inventory` }
    },
    async deposit (pos, item, count) {
      this.calls.push(['deposit', pos, item, count])
      const room = opt.chestRoom ?? Infinity
      const moved = Math.min(count, room)
      if (opt.inv) opt.inv[item] -= moved
      return { ok: moved > 0, moved, reason: moved < count ? 'the chest is full' : null }
    },
    async smelt (pos, o) {
      this.calls.push(['smelt', pos, { ...o, signal: undefined, onProgress: undefined }])
      const r = opt.smelt ? opt.smelt(pos, o) : { ok: true, smelted: o.count }
      for (let i = 1; i <= r.smelted; i++) o.onProgress(i)
      return r
    },
    async withdraw (pos, item, count) {
      this.calls.push(['withdraw', pos, item, count])
      const available = (opt.chestItems || {})[item] || 0
      if (!available) return { ok: false, moved: 0, available, reason: `no ${item} in the chest` }
      const moved = Math.min(count, available)
      return { ok: true, moved, available }
    }
  }
  return m
}

/** act for a verb, with the real VerbApi over the fake world. */
function setup (w, opt = {}) {
  const motor = opt.motor || fakeMotor(w, opt)
  const places = new KnownPlaces({ file: null })
  const players = opt.players || []
  const entities = opt.entities || []
  const viewNow = () => makeView(w, { pos: motor.here(), yaw: 0, players: typeof players === 'function' ? players(motor) : players, entities, waypoints: opt.locator ? opt.locator.list() : [] })
  const observe = () => {
    const v = viewNow()
    const { obs } = buildObs(v, {})
    places.applyRecheck(obs.self.dim, obs.t, recheckKnown(v, places.inDim(obs.self.dim)))
    places.recordObs(obs)
    return obs
  }
  const api = new VerbApi({
    motor,
    house: opt.house || null,
    chests: opt.chests || null,
    locator: opt.locator || null,
    observe,
    places,
    sight: () => { const v = viewNow(); return { classAt: v.classAt, eye: v.self.eye, sightRadius: v.sightRadius } },
    registry: {
      isBlock: n => !!REG.blocksByName[n],
      isItem: n => !!REG.itemsByName[n],
      mineHint: (n, o) => mineHint(REG, n, o),
      collectHint: n => collectHint(REG, n),
      dropsOf: n => dropsOf(REG, n)
    }
  })
  const progress = []
  const act = {
    connected: () => true,
    chat () {},
    halt () { motor.stop() },
    here: () => api.here(),
    places,
    api,
    cfg: { stripLength: 4, stripMax: 6 },
    signal: new AbortController().signal,
    progress: p => progress.push(p)
  }
  return { act, motor, api, places, progress }
}

const run = (verb, act, args) => VERBS[verb].run(act, structuredClone(args))

module.exports = { world, fakeMotor, setup, run, FakeWorld }
