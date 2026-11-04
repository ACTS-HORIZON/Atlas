'use strict'
// obs.surroundings: what is right around the bot, from blocks in line of
// sight only (the cells it stands in and on, and what its eyes reach along
// the four directions), plus one derived sentence for the model:
//   "in a 1-wide shaft 5 deep, stone all sides, open above"
//   "on a slope, drop of 6 to the south"
// Shape:
//   {summary, feet, head, below, above,
//    sides: {north: [feet, head], east…},  each "stone 1" (first solid block
//           and its distance, up to 8), "lava 3", or null (open / not seen)
//    drops: {north: n|null…}  how far the floor one step that way is below
//           the bot's floor (0 level, -1 a step up, null blocked / not seen)
//    sky: bool (nothing solid overhead), roof: n|null (the first solid block
//         above, counted from the head: 1 = right above it), light,
//    ground: {standing_on, placed, level, below, at, terrain, canopy}  (Session 9b)}
// ground, also from blocks in sight only (kept compact: surroundings stays within ~120 tokens):
//   standing_on, placed  the block under the feet (null: nothing solid), and whether the bot placed it
//   level/below/at  the natural ground: the top of the nearest natural solid
//                block (not leaves, logs, or a block the bot placed) in its own
//                column or the nearest one within 8 whose top it can see (from the
//                edge of its block, leaning that way, as for drops); level = the y one
//                stands at there, below = how far that is under the feet, at = that cell
//   terrain      within 8 blocks: "<flat|sloped|mixed> <lowest>-<highest>" of the natural ground
//                tops it can see (a face of); flat: within 1; sloped: no step of 2+ between
//                neighbouring columns; mixed: cliffs or holes. null underground or with too few seen
//   canopy       the first solid block overhead is leaves
// The floor of a drop counts as seen from the edge of the bot's block (a
// player steps up to the edge and looks down; the eye is moved 0.45 toward it).
const { blockVisible } = require('./raycast')

const DIRS = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' }
const REACH = 8
const MAX_DROP = 16
const MAX_UP = 384
// not the ground: what grows on it, and what was built (placed blocks are checked separately)
const NOT_GROUND = /(_leaves|_log|_wood|_stem|_hyphae)$|^(bamboo|cactus|scaffolding|mangrove_roots)$/
const LEAVES = /_leaves$/

function buildSurroundings (view, light = null) {
  const s = view.self
  const eye = s.eye
  const fx = Math.floor(s.pos[0]); const fy = Math.floor(s.pos[1]); const fz = Math.floor(s.pos[2])
  const at = (x, y, z) => view.classAt(x, y, z)
  const nm = c => (c ? c.name : null)
  const seen = (x, y, z, c) => blockVisible(view, eye, x, y, z, c, null)

  const sides = {}
  const drops = {}
  for (const [dir, [dx, dz]] of Object.entries(DIRS)) {
    sides[dir] = [0, 1].map(level => {
      for (let d = 1; d <= REACH; d++) {
        const x = fx + dx * d; const y = fy + level; const z = fz + dz * d
        const c = at(x, y, z)
        if (c === null) return null
        if (c.solid || c.fluid) return (d === 1 || seen(x, y, z, c)) ? `${c.name} ${d}` : null
      }
      return null
    })
    const edge = [eye[0] + dx * 0.45, eye[1], eye[2] + dz * 0.45]
    drops[dir] = dropAt(view, fx + dx, fy, fz + dz, (x, y, z, c) => blockVisible(view, edge, x, y, z, c, null))
  }

  let roof = null
  for (let k = 2; k < MAX_UP; k++) {
    const c = at(fx, fy + k, fz)
    if (c === null) break
    if (c.solid && !c.fluid) { roof = k - 1; break }
  }
  const sky = roof === null
  const roofCell = roof === null ? null : at(fx, fy + 1 + roof, fz)
  const ground = groundFacts(view, { fx, fy, fz, eye, sky, canopy: !!(roofCell && LEAVES.test(roofCell.name)) })

  const out = {
    summary: '',
    feet: nm(at(fx, fy, fz)),
    head: nm(at(fx, fy + 1, fz)),
    below: nm(at(fx, fy - 1, fz)),
    above: nm(at(fx, fy + 2, fz)),
    sides,
    drops,
    sky,
    roof,
    light,
    ground
  }
  out.summary = describe(view, out, fx, fy, fz)
  return out
}

/** The ground facts (see the top of this file). */
function groundFacts (view, { fx, fy, fz, eye, sky, canopy }) {
  const at = (x, y, z) => view.classAt(x, y, z)
  const placedAt = view.placedAt || (() => false)
  const natural = (x, y, z, c) => !!c && c.solid && !c.fluid && !NOT_GROUND.test(c.name) && !placedAt(x, y, z)
  const seen = (x, y, z, c) => blockVisible(view, eye, x, y, z, c, null)
  const under = at(fx, fy - 1, fz)
  const onSolid = !!(under && under.solid)
  const out = { standing_on: onSolid ? under.name : null, placed: onSolid && !!placedAt(fx, fy - 1, fz), level: null, below: null, at: null, terrain: null, canopy }
  // the natural ground: right under the feet, else the nearest column within 8 whose ground top is seen
  if (onSolid && natural(fx, fy - 1, fz, under)) {
    out.level = fy; out.below = 0; out.at = [fx, fy, fz]
  } else {
    const cols = []
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) if (Math.hypot(dx, dz) <= 8) cols.push([dx, dz, Math.hypot(dx, dz)])
    cols.sort((a, b) => a[2] - b[2])
    for (const [dx, dz, dist] of cols) {
      const x = fx + dx; const z = fz + dz
      const lean = dist ? [eye[0] + 0.45 * dx / dist, eye[1], eye[2] + 0.45 * dz / dist] : eye
      const seenFrom = (y, c) => blockVisible(view, lean, x, y, z, c, null)
      let found = null
      for (let y = fy - 1; y >= fy - 48; y--) {
        const c = at(x, y, z)
        if (c === null) break
        if (!c.solid && !c.fluid) continue
        if (c.fluid) break // water or lava on top: not ground to stand on
        if (NOT_GROUND.test(c.name) || placedAt(x, y, z)) continue // leaves, a trunk, a pillar: look past them
        const f = at(x, y + 1, z); const h = at(x, y + 2, z)
        if (f && !f.solid && !f.fluid && h && !h.solid && (seenFrom(y, c) || (dx === 0 && dz === 0 && y === fy - 1))) found = y + 1
        break
      }
      if (found !== null) { out.level = found; out.below = fy - found; out.at = [x, found, z]; break }
    }
  }
  // the terrain around: natural ground tops in sight, every column within 8 (not underground)
  if (sky || canopy) {
    const h = new Map()
    for (let dx = -8; dx <= 8; dx++) {
      for (let dz = -8; dz <= 8; dz++) {
        if (Math.hypot(dx, dz) > 8.5) continue
        const x = fx + dx; const z = fz + dz
        for (let y = fy + 6; y >= fy - 24; y--) {
          const c = at(x, y, z)
          if (c === null) break
          if (!c.solid && !c.fluid) continue
          if (natural(x, y, z, c) && seen(x, y, z, c)) h.set(`${dx},${dz}`, y + 1)
          break
        }
      }
    }
    if (h.size >= 3) {
      const ys = [...h.values()]
      const highest = Math.max(...ys); const lowest = Math.min(...ys)
      let cliff = false
      for (const [k, y] of h) {
        const [dx, dz] = k.split(',').map(Number)
        for (const n of [`${dx + 1},${dz}`, `${dx},${dz + 1}`]) if (h.has(n) && Math.abs(h.get(n) - y) >= 2) cliff = true
      }
      out.terrain = `${highest - lowest <= 1 ? 'flat' : cliff ? 'mixed' : 'sloped'} ${lowest}-${highest}`
    }
  }
  return out
}

/** Floor drop one step away: null if the step is walled or the floor isn't seen. */
function dropAt (view, x, fy, z, seen) {
  const feet = view.classAt(x, fy, z); const head = view.classAt(x, fy + 1, z)
  if (feet === null || head === null || head.solid) return null
  if (feet.solid) {
    const over = view.classAt(x, fy + 2, z)
    return over && !over.solid ? -1 : null // a step up (if there is headroom)
  }
  for (let k = 1; k <= MAX_DROP; k++) {
    const c = view.classAt(x, fy - k, z)
    if (c === null) return null
    if (c.solid || c.fluid) return seen(x, fy - k, z, c) ? k - 1 : null
  }
  return MAX_DROP
}

const wallAt1 = side => typeof side === 'string' && / 1$/.test(side) && !/^(water|lava) /.test(side)
const matOf = side => side.replace(/ \d+$/, '')

function describe (view, o, fx, fy, fz) {
  const walled = d => wallAt1(o.sides[d][0]) && wallAt1(o.sides[d][1])
  const all = Object.keys(DIRS).every(walled)
  const mats = Object.values(o.sides).flat().filter(wallAt1).map(matOf)
  const material = mats.length && mats.every(m => m === mats[0]) ? `${mats[0]} all sides` : `${[...new Set(mats)].slice(0, 2).join('/')} walls`
  const inFluid = /^(water|lava)$/.test(o.feet || '') ? `in ${o.feet}, ` : ''
  const fluidNear = Object.entries(o.sides).find(([, v]) => v.some(x => /^lava /.test(x || '')))
  const lava = fluidNear ? `; lava ${fluidNear[1].find(x => /^lava /.test(x || '')).split(' ')[1]} to the ${fluidNear[0]}` : ''

  if (all) {
    if (!o.sky && o.roof === 1) return `${inFluid}boxed in: ${material} and above${lava}`
    // how deep: levels upward with walls on all four sides and nothing in the middle
    let depth = 0
    for (let y = fy; y < fy + 64; y++) {
      const mid = view.classAt(fx, y, fz)
      if (mid === null || mid.solid) break
      const ok = Object.values(DIRS).every(([dx, dz]) => { const c = view.classAt(fx + dx, y, fz + dz); return c && c.solid })
      if (!ok) break
      depth++
    }
    return `${inFluid}in a 1-wide shaft ${depth} deep, ${material}, ${o.sky ? 'open above' : `roof ${o.roof} above`}${lava}`
  }
  for (const [a, b] of [['north', 'south'], ['east', 'west']]) {
    const other = a === 'north' ? ['east', 'west'] : ['north', 'south']
    if (walled(other[0]) && walled(other[1]) && !walled(a) && !walled(b)) {
      return `${inFluid}in a 1-wide tunnel running ${a}-${b}, ${material}${o.sky ? ', open above' : o.roof > 1 ? `, roof ${o.roof} above` : ''}${lava}`
    }
  }
  // the biggest drop next to it
  const [ddir, depth] = Object.entries(o.drops).filter(([, v]) => v !== null && v > 0).sort((p, q) => q[1] - p[1])[0] || []
  const rise = Object.entries(o.drops).find(([, v]) => v === -1)
  let ground
  if (!o.sky) ground = o.roof !== null && o.roof >= 2 ? `underground in an open space, roof ${o.roof} above` : `under cover, roof ${o.roof} above`
  else ground = 'on open ground'
  if (depth >= 4) return `${inFluid}${ground}, at the edge of a drop of ${depth}${depth >= MAX_DROP ? '+' : ''} to the ${ddir}${lava}`
  if (depth >= 1) return `${inFluid}${o.sky ? 'on a slope' : ground}, drop of ${depth} to the ${ddir}${lava}`
  if (rise) return `${inFluid}${o.sky ? 'on a slope' : ground}, rising to the ${rise[0]}${lava}`
  const blocked = Object.keys(DIRS).filter(walled)
  if (o.sky && !blocked.length) return `${inFluid}on open flat ground${lava}`
  return `${inFluid}${ground}${blocked.length ? `, wall to the ${blocked.join(' and ')}` : ''}${lava}`
}

module.exports = { buildSurroundings, OPPOSITE }
