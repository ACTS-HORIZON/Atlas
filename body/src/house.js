'use strict'
// House rules (CONTRACT.md): the first one, protected regions. Boxes in
// which the bot never digs and never places, whoever asks (a verb, or the
// pathfinder tunnelling or pillaring on the way somewhere).
//
// ATLAS_PROTECTED_REGIONS is a JSON list, empty by default:
//   [{"name": "spawn", "dim": "overworld", "from": [-20, 50, -20], "to": [20, 120, 20]}]
// "dim" is optional (all dimensions); from/to are inclusive block corners.

function parseRegions (text) {
  if (text === undefined || text === null || String(text).trim() === '') return []
  let list
  try { list = JSON.parse(text) } catch (err) { throw new Error(`ATLAS_PROTECTED_REGIONS is not valid JSON: ${err.message}`) }
  if (!Array.isArray(list)) throw new Error('ATLAS_PROTECTED_REGIONS must be a JSON list')
  return list.map((r, i) => {
    const ok = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
    if (!r || !ok(r.from) || !ok(r.to)) throw new Error(`ATLAS_PROTECTED_REGIONS[${i}] needs "from" and "to" as [x, y, z]`)
    return {
      name: String(r.name ?? `region ${i + 1}`),
      dim: r.dim ? String(r.dim).replace(/^minecraft:/, '') : null,
      min: r.from.map((v, k) => Math.floor(Math.min(v, r.to[k]))),
      max: r.from.map((v, k) => Math.floor(Math.max(v, r.to[k])))
    }
  })
}

class HouseRules {
  constructor (regions = []) { this.regions = regions }

  /** The protected region containing block pos in dim, or null. */
  regionAt (pos, dim) {
    const x = Math.floor(pos[0]); const y = Math.floor(pos[1]); const z = Math.floor(pos[2])
    for (const r of this.regions) {
      if (r.dim && dim && r.dim !== dim) continue
      if (x >= r.min[0] && x <= r.max[0] && y >= r.min[1] && y <= r.max[1] && z >= r.min[2] && z <= r.max[2]) return r
    }
    return null
  }

  /** null if allowed, else the refusal reason. action: 'dig' | 'place'. */
  check (action, pos, dim) {
    const r = this.regionAt(pos, dim)
    return r ? `house rules: no ${action} inside protected region "${r.name}" ([${pos.map(Math.floor).join(', ')}])` : null
  }
}

module.exports = { HouseRules, parseRegions }
