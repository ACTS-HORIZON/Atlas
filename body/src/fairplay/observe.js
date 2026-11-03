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
//   scanNotable(eye, R, visit) calls visit(x, y, z, cls) for notable blocks
//                           with centre within ~R, in a fixed order
//   entities  [{id, type, pos (feet), height, hostile}]  (no players, no self)
//   players   [{name, pos (feet), height, eye, look (unit vector)}]
//   waypoints [{name, azimuth, vertical?}] Locator Bar waypoints (src/locator.js), optional
//   inventory, world {dayTime, raining, thundering, light, biome},
//   bossBar, chat, task
// The view may hold more than a player perceives; this module is the filter.
//
// Only what a player could perceive gets out:
//   surroundings the cells around the bot and what its eyes reach N/E/S/W (surroundings.js)
//   blocks_seen  notable types, within sight radius, with line of sight
//   entities     line of sight, no health / AI target / other hidden state
//   players      visible only; looking_at only if the bot sees that block too
//   sounds       type + bearing + near/mid/far, never coordinates

const { blockVisible, clearTo, lookTarget } = require('./raycast')
const { bearing, timeOfDay } = require('./perception')
const { buildSurroundings } = require('./surroundings')

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

// Candidate buffers, reused across builds (one body, one build at a time).
let cap = 0
let CX, CY, CZ, CD, CC
function grow (n) {
  const ncap = Math.max(1024, n * 2)
  const copy = (A, T) => { const B = new T(ncap); if (A) B.set(A.subarray(0, cap)); return B }
  CX = copy(CX, Int32Array); CY = copy(CY, Int32Array); CZ = copy(CZ, Int32Array); CD = copy(CD, Float64Array)
  const C = new Array(ncap); for (let i = 0; i < cap; i++) C[i] = CC[i]
  CC = C; cap = ncap
}

function seenBlocks (view, eye, R, opts, stats) {
  // 1. scan: notable blocks within R, distance from the eye to the block centre
  let n = 0
  view.scanNotable(eye, R, (x, y, z, cls) => {
    const d = Math.hypot(x + 0.5 - eye[0], y + 0.5 - eye[1], z + 0.5 - eye[2])
    if (d > R) return
    if (n >= cap) grow(n + 1)
    CX[n] = x; CY[n] = y; CZ[n] = z; CD[n] = d; CC[n] = cls; n++
  })
  stats.candidates = n

  // 2. nearest first: bucket by whole block of distance, then a stable sort
  //    inside each bucket as it is reached. Same order as one stable sort by
  //    distance over the scan order, but buckets past the caps are never sorted.
  const nb = Math.floor(R) + 2
  const counts = new Uint32Array(nb + 1)
  for (let i = 0; i < n; i++) counts[Math.floor(CD[i]) + 1]++
  for (let k = 1; k <= nb; k++) counts[k] += counts[k - 1]
  const order = new Uint32Array(n)
  const fillAt = counts.slice(0, nb)
  for (let i = 0; i < n; i++) order[fillAt[Math.floor(CD[i])]++] = i

  // 3. test candidates in that order; per-type and total caps prune early
  const out = []
  const perType = new Map()
  const capped = cls => (perType.get(cls.name) || 0) >= opts.maxPerType
  let done = false
  for (let k = 0; k < nb && !done; k++) {
    // Types already at their cap when the bucket starts are skipped whatever
    // the order, so they are dropped before sorting.
    const lo = counts[k]; const hi0 = counts[k + 1]
    let hi = lo
    for (let q = lo; q < hi0; q++) if (!capped(CC[order[q]])) order[hi++] = order[q]
    if (hi - lo > 1) order.subarray(lo, hi).sort((a, b) => CD[a] - CD[b] || a - b)
    for (let q = lo; q < hi; q++) {
      if (out.length >= opts.maxBlocks || stats.raycasts >= opts.maxRaycasts) { done = true; break }
      const i = order[q]
      const cls = CC[i]
      const m = perType.get(cls.name) || 0
      if (m >= opts.maxPerType) continue
      if (!blockVisible(view, eye, CX[i], CY[i], CZ[i], cls, stats)) continue
      perType.set(cls.name, m + 1)
      out.push({ type: cls.name, pos: [CX[i], CY[i], CZ[i]], dist: r1(CD[i]) })
    }
  }
  for (let i = 0; i < n; i++) CC[i] = undefined // don't keep block classes alive
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
  // Out of sight: bearing only, and only when the Locator Bar shows them
  // (view.waypoints; never derived from entity positions).
  const seenNames = new Set(players.map(p => p.name))
  for (const w of view.waypoints || []) {
    if (seenNames.has(w.name) || players.length >= opts.maxPlayers) continue
    const a = w.azimuth * Math.PI / 180
    players.push({ name: w.name, bearing: bearing(s.yaw, [-Math.sin(a) * 10, 0, Math.cos(a) * 10]), ...(w.vertical ? { vertical: w.vertical } : {}) })
    seenNames.add(w.name)
  }

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
    surroundings: buildSurroundings(view, w.light ?? null),
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

/**
 * Re-check remembered blocks against what the bot can see now (fair play:
 * same line-of-sight rule as blocks_seen). For each entry {type, pos} within
 * the sight radius whose voxel is visible: same type -> `seen`, anything
 * else -> `gone`. Entries out of sight are left alone (the bot can't know).
 * Nearest first, at most `max` entries per call.
 */
function recheckKnown (view, entries, { max = 256 } = {}) {
  const eye = view.self.eye
  const R = view.sightRadius
  const near = []
  for (const e of entries) {
    const d = Math.hypot(e.pos[0] + 0.5 - eye[0], e.pos[1] + 0.5 - eye[1], e.pos[2] + 0.5 - eye[2])
    if (d <= R) near.push([d, e])
  }
  near.sort((a, b) => a[0] - b[0])
  const seen = []; const gone = []
  for (const [, e] of near.slice(0, max)) {
    const cls = view.classAt(e.pos[0], e.pos[1], e.pos[2])
    if (cls === null) continue
    if (!blockVisible(view, eye, e.pos[0], e.pos[1], e.pos[2], cls, null)) continue
    ;(cls.name === e.type ? seen : gone).push(e)
  }
  return { seen, gone }
}

module.exports.recheckKnown = recheckKnown
module.exports.entityVisible = entityVisible
