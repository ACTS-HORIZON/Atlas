'use strict'
// House rules: the chest allowlist. The bot only takes (withdraw) from
// chests it has been given; giving (deposit) is always allowed.
// A chest is added by config (ATLAS_CHESTS) or by an allowlisted player in
// chat, looking at it: "@Atlas that chest is yours". Chat grants persist in
// data/chests.<host>_<port>.json (per server, like known places).
//
// ATLAS_CHESTS: JSON list of positions, optionally with a dimension:
//   [[10, 64, -3], {"pos": [40, 70, 12], "dim": "overworld"}]
const fs = require('fs')
const path = require('path')

const CONTAINERS = new Set(['chest', 'trapped_chest', 'barrel'])
const key = (dim, p) => `${dim || '*'}:${p[0]},${p[1]},${p[2]}`

function parseChests (text) {
  if (text === undefined || text === null || String(text).trim() === '') return []
  let list
  try { list = JSON.parse(text) } catch (err) { throw new Error(`ATLAS_CHESTS is not valid JSON: ${err.message}`) }
  if (!Array.isArray(list)) throw new Error('ATLAS_CHESTS must be a JSON list')
  return list.map((e, i) => {
    const pos = Array.isArray(e) ? e : e && e.pos
    if (!Array.isArray(pos) || pos.length !== 3 || !pos.every(Number.isFinite)) throw new Error(`ATLAS_CHESTS[${i}] must be [x, y, z] or {"pos": [x, y, z], "dim": ...}`)
    return { pos: pos.map(Math.floor), dim: (!Array.isArray(e) && e.dim) ? String(e.dim).replace(/^minecraft:/, '') : null, by: 'config' }
  })
}

class ChestAllowlist {
  constructor ({ fromConfig = [], file = null } = {}) {
    this.file = file
    this.entries = new Map()
    for (const e of fromConfig) this.entries.set(key(e.dim, e.pos), e)
    if (file && fs.existsSync(file)) {
      try {
        for (const e of JSON.parse(fs.readFileSync(file, 'utf8')).chests || []) this.entries.set(key(e.dim, e.pos), e)
      } catch (err) { console.warn(`[chests] could not read ${file}: ${err.message}`) }
    }
  }

  has (dim, pos) {
    const p = pos.map(Math.floor)
    return this.entries.has(key(dim, p)) || this.entries.has(key(null, p))
  }

  /** Add a chest (from chat). Persists. */
  add (dim, pos, by) {
    const e = { pos: pos.map(Math.floor), dim, by, at: new Date().toISOString() }
    this.entries.set(key(dim, e.pos), e)
    this.save()
    return e
  }

  list () { return [...this.entries.values()] }

  save () {
    if (!this.file) return
    const chests = this.list().filter(e => e.by !== 'config')
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, chests }, null, 1) + '\n')
    fs.renameSync(`${this.file}.tmp`, this.file)
  }
}

module.exports = { ChestAllowlist, parseChests, CONTAINERS }
