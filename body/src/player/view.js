'use strict'
// The reflex view (CONTRACT.md, "Observation" / "Player loop"): what the
// decision model sees each tick, ≤250 tokens, from the same fair-play data
// as the obs: vitals, held item, the nearest threats with bearing and
// distance, hazards in the 8 cells around and below (lava, fire, water,
// drops), the surroundings sentence, the current intent, the last 5
// micro-actions with their effect, "no progress for N ticks" when the block
// and the surroundings haven't changed, and the offered actions.
const { landing, DIRS } = require('./offered')
const { bearing } = require('../fairplay/perception')

const AROUND = [['north', 0, -1], ['north-east', 1, -1], ['east', 1, 0], ['south-east', 1, 1], ['south', 0, 1], ['south-west', -1, 1], ['west', -1, 0], ['north-west', -1, -1]]
const MAX_TOKENS = 250
const tokens = o => Math.ceil(JSON.stringify(o).length / 4)

/** "lava north-east", "drop 5 south", "fire below", "water west": what would hurt or drop next to the feet. */
function hazards (p) {
  const [x, y, z] = p.feet
  const out = []
  for (const [name, dx, dz] of AROUND) {
    const c = p.cls(x + dx, y, z + dz)
    if (!c) continue
    if (/^(lava|fire|soul_fire|magma_block|cactus|sweet_berry_bush|powder_snow)$/.test(c.name)) { out.push(`${c.name} ${name}`); continue }
    if (c.name === 'water') { out.push(`water ${name}`); continue }
    if (!c.solid) {
      const l = landing(p, x + dx, y, z + dz)
      if (!l.ok) out.push(`${l.why} ${name}`)
      else if (l.depth >= 2) out.push(`drop ${l.depth} ${name}`)
    }
  }
  const below = p.cls(x, y - 1, z)
  if (below && /^(lava|fire|magma_block|water)$/.test(below.name)) out.push(`${below.name} below`)
  return out
}

/** Where the target is, as the player sees it: {name, dist, bearing} in sight, {name, bearing} on the Locator Bar, or "not in sight". */
function targetSeen (obs, name) {
  const s = (obs && obs.self) || {}
  const p = ((obs && obs.players) || []).find(x => x.name === name)
  if (p && p.pos && s.pos) return { name, dist: p.dist, bearing: bearing(s.yaw || 0, [p.pos[0] - s.pos[0], p.pos[1] - s.pos[1], p.pos[2] - s.pos[2]]) }
  if (p && p.bearing) return { name, bearing: p.bearing, ...(p.vertical ? { vertical: p.vertical } : {}) }
  const e = ((obs && obs.entities) || []).find(x => x.type === name)
  if (e) return { name, dist: e.dist, bearing: e.bearing }
  return { name, seen: false }
}

function reflexView ({ obs, probe, intent, target = null, recent = [], offered = [], pitch = 0, noProgress = 0 }) {
  const s = (obs && obs.self) || {}
  const threats = ((obs && obs.entities) || []).filter(e => e.hostile).slice(0, 3)
    .map(e => ({ type: e.type, bearing: e.bearing, dist: e.dist, ...(e.approaching ? { approaching: true } : {}) }))
  const sur = (obs && obs.surroundings) || {}
  const view = {
    self: { health: s.health, food: s.food, held: s.held ?? null, y: probe ? probe.feet[1] : null, facing: probe ? probe.dir : null, pitch: Math.round(pitch), on_ground: !!s.on_ground },
    intent: target ? `${intent} (target: ${target})` : intent,
    ...(target ? { target: targetSeen(obs, target) } : {}),
    threats,
    hazards: probe ? hazards(probe) : [],
    surroundings: sur.summary || null,
    sky: !!sur.sky,
    recent: recent.slice(-5),
    ...(noProgress > 0 ? { progress: `no progress for ${noProgress} ticks` } : {}),
    offered
  }
  // keep it under the budget: fewer hazards, then fewer threats, then a shorter surroundings sentence
  while (tokens(view) > MAX_TOKENS && view.recent.length > 3) view.recent.shift()
  while (tokens(view) > MAX_TOKENS && view.hazards.length > 2) view.hazards.pop()
  while (tokens(view) > MAX_TOKENS && view.threats.length > 1) view.threats.pop()
  if (tokens(view) > MAX_TOKENS && view.surroundings) view.surroundings = view.surroundings.slice(0, 60)
  return view
}

module.exports = { reflexView, targetSeen, hazards, tokens, MAX_TOKENS, DIRS }
