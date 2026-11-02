'use strict'
// Fair-play observation builder (CONTRACT.md, "Observation" / "Fair play").
//
// Input is a backend-neutral *view*. The Mineflayer adapter (src/view.js)
// builds one from the bot; tests build one from a hand-made voxel world
// (test/fakeWorld.js). Output is a contract `obs` message. A view has:
//   t, sightRadius
//   self      {pos (feet), eye, yaw/pitch (F3 degrees), dim, health, food, xp,
//              on_ground, in_water, held, armor, effects, gamemode}
//   classAt(x,y,z)          -> blocks.classify() result | null if unloaded
//   scanNotable(eye, R)     -> iterable of {pos:[x,y,z], cls} (notable only)
//   entities  [{id, type, pos (feet), height, hostile}]  (no players, no self)
//   players   [{name, pos (feet), height, eye, look (unit vector)}]
//   inventory, world {dayTime, raining, thundering, light, biome},
//   bossBar, chat, task
// The view may hold more than a player perceives; this module is the filter.
//
// Only what a player could perceive gets out:
//   blocks_seen  notable types, within sight radius, with line of sight
//   entities     line of sight, no health / AI target / other hidden state
//   players      visible only; looking_at only if the bot sees that block too
//   sounds       type + bearing + near/mid/far, never coordinates

const { blockVisible, clearTo, lookTarget } = require('./raycast')
const { bearing, timeOfDay } = require('./perception')

const CONTRACT_VERSION = '0.1'

const DEFAULTS = {
  maxBlocks: 48, // blocks_seen cap (nearest first)
  maxPerType: 12, // so one lake does not fill the list with water
  maxEntities: 24,
  maxPlayers: 16,
  maxChat: 10,
  maxRaycasts: 20000 // hard per-obs budget, keeps a worst case bounded
}

const r1 = v => Math.round(v * 10) / 10
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

function entityVisible (view, eye, pos, height) {
  const h = height || 1.8
  for (const dy of [h - 0.1, h / 2, 0.1]) {
    if (clearTo(view, eye, [pos[0], pos[1] + dy, pos[2]])) return true
  }
  return false
}

function seenBlocks (view, eye, R, opts, stats) {
  const cand = []
  for (const c of view.scanNotable(eye, R)) {
    const d = Math.hypot(c.pos[0] + 0.5 - eye[0], c.pos[1] + 0.5 - eye[1], c.pos[2] + 0.5 - eye[2])
    if (d <= R) cand.push({ pos: c.pos, cls: c.cls, d })
  }
  stats.candidates = cand.length
  cand.sort((a, b) => a.d - b.d)
  const out = []
  const perType = new Map()
  for (const c of cand) {
    if (out.length >= opts.maxBlocks || stats.raycasts >= opts.maxRaycasts) break
    const n = perType.get(c.cls.name) || 0
    if (n >= opts.maxPerType) continue
    if (!blockVisible(view, eye, c.pos[0], c.pos[1], c.pos[2], c.cls, stats)) continue
    perType.set(c.cls.name, n + 1)
    out.push({ type: c.cls.name, pos: [c.pos[0], c.pos[1], c.pos[2]], dist: r1(c.d) })
  }
  return out
}

/**
 * @param view   backend view (see module header)
 * @param state  {motion: MotionTracker, sounds: SoundMemory}
 * @param options overrides of DEFAULTS, plus now (ms)
 * @returns {{obs: object, stats: {ms:number, candidates:number, raycasts:number}}}
 */
function buildObs (view, state, options = {}) {
  const opts = { ...DEFAULTS, ...options }
  const now = opts.now ?? Date.now()
  const t0 = process.hrtime.bigint()
  const stats = { candidates: 0, raycasts: 0, ms: 0 }
  const s = view.self
  const eye = s.eye
  const R = view.sightRadius

  const blocks_seen = seenBlocks(view, eye, R, opts, stats)

  const entities = []
  for (const e of view.entities) {
    const rel = [e.pos[0] - s.pos[0], e.pos[1] - s.pos[1], e.pos[2] - s.pos[2]]
    const d = Math.hypot(rel[0], rel[1], rel[2])
    if (d > R) continue
    stats.raycasts++
    if (!entityVisible(view, eye, e.pos, e.height)) continue
    entities.push({
      type: e.type,
      rel: rel.map(Math.round),
      dist: r1(d),
      bearing: bearing(s.yaw, rel),
      approaching: state.motion ? state.motion.approaching(e.id, d, now) : false,
      hostile: !!e.hostile
    })
  }
  entities.sort((a, b) => a.dist - b.dist)
  entities.length = Math.min(entities.length, opts.maxEntities)

  const players = []
  for (const p of view.players) {
    const d = dist3(p.pos, s.pos)
    if (d > R) continue
    stats.raycasts++
    if (!entityVisible(view, eye, p.pos, p.height)) continue
    let looking_at = null
    if (p.eye && p.look) {
      const tgt = lookTarget(view, p.eye, p.look, R)
      if (tgt && dist3([tgt[0] + 0.5, tgt[1] + 0.5, tgt[2] + 0.5], eye) <= R &&
          blockVisible(view, eye, tgt[0], tgt[1], tgt[2], view.classAt(tgt[0], tgt[1], tgt[2]), stats)) {
        looking_at = tgt
      }
    }
    players.push({ name: p.name, pos: p.pos.map(r1), dist: r1(d), looking_at })
  }
  players.sort((a, b) => a.dist - b.dist)
  players.length = Math.min(players.length, opts.maxPlayers)

  const sounds = state.sounds ? state.sounds.reduce(s.pos, s.yaw, now) : []

  const w = view.world
  const obs = {
    type: 'obs',
    v: CONTRACT_VERSION,
    t: view.t,
    self: {
      pos: s.pos.map(r1),
      dim: s.dim,
      yaw: Math.round(s.yaw),
      pitch: Math.round(s.pitch),
      health: s.health,
      food: s.food,
      xp: s.xp,
      on_ground: !!s.on_ground,
      in_water: !!s.in_water,
      held: s.held ?? null,
      armor: s.armor || [],
      effects: s.effects || [],
      gamemode: s.gamemode
    },
    inventory: view.inventory || {},
    world: {
      time: timeOfDay(w.dayTime),
      weather: w.thundering ? 'thunder' : w.raining ? 'rain' : 'clear',
      light: w.light,
      biome: w.biome
    },
    blocks_seen,
    entities,
    players,
    sounds,
    boss_bar: view.bossBar ?? null,
    chat: (view.chat || []).slice(-opts.maxChat),
    task: view.task ?? null
  }
  stats.ms = Number(process.hrtime.bigint() - t0) / 1e6
  return { obs, stats }
}

module.exports = { buildObs, DEFAULTS, CONTRACT_VERSION }
