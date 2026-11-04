'use strict'
// build: lay a shape, bottom-up, from inventory blocks (Session 9c).
//   {shape: "box", corner: [x, y, z], size: [w, d, h], material, hollow = true, roof = false, door?}
//     corner = the low north-west corner (smallest x, y, z); w along x (east), d along z (south),
//     h up. hollow: the four walls only (roof: true adds a full top layer); hollow: false fills it.
//     door: north|south|east|west, a 1-wide, 2-high gap at the bottom, in the middle of that wall.
//   {blocks: [{block, pos}, ...]}  any design, up to 1024 cells.
// How: cells go in layer by layer from the bottom; within a layer, only cells with something solid next
// to them (below, beside or above) are placed, so walls grow from the ground and a roof grows in from
// the walls. For each cell it stands where the cell is in reach (4.3 blocks) and in sight, walking there
// first (never digging, never standing in a cell it still has to fill), then looks again: already the
// right block -> skipped; another block there -> failed (it never digs anything out); empty -> placed.
// Hands, not a planner: it does not level ground, fetch materials or clear the site.
// Refused when any cell is inside a protected region (house rules). Out of a material: those cells are
// counted as short and the result is partial ("short 12 cobblestone").
// data: {cells, placed, skipped, failed: [{pos, reason}] (first 20), short: {block: n}}
const { checkArgs, failed, refused, cannotAct } = require('./common')
const { reachesVoxel, blockVisible } = require('../fairplay/raycast')

const REACH = 4.3
const EMPTY = /^(air|cave_air|void_air|water|short_grass|tall_grass|fern|large_fern|snow|dead_bush|seagrass|tall_seagrass|vine)$/
const key = p => p.join(',')
const r1 = v => Math.round(v * 10) / 10
const NEIGHBOURS = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]

/** The cells of a box (see the top of this file), bottom layer first. */
function boxCells ({ corner, size, material, hollow = true, roof = false, door = null }) {
  const [x0, y0, z0] = corner; const [w, d, h] = size
  const doorAt = (dx, dz) => {
    if (door === 'north') return dz === 0 && dx === Math.floor((w - 1) / 2)
    if (door === 'south') return dz === d - 1 && dx === Math.floor((w - 1) / 2)
    if (door === 'west') return dx === 0 && dz === Math.floor((d - 1) / 2)
    if (door === 'east') return dx === w - 1 && dz === Math.floor((d - 1) / 2)
    return false
  }
  const cells = []
  for (let ly = 0; ly < h; ly++) {
    for (let dz = 0; dz < d; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const edge = dx === 0 || dx === w - 1 || dz === 0 || dz === d - 1
        if (hollow && !edge && !(roof && ly === h - 1)) continue
        if (door && ly <= 1 && doorAt(dx, dz)) continue
        cells.push({ pos: [x0 + dx, y0 + ly, z0 + dz], block: material })
      }
    }
  }
  return cells
}

async function run (act, args) {
  const err = checkArgs('build', args)
  if (err) return failed(err)
  const api = act.api
  const no = cannotAct(api, 'build')
  if (no) return no
  if (api.gamemode() === 'adventure') return failed('build: cannot place blocks in adventure mode')
  let cells; let what
  if (args.blocks) {
    cells = args.blocks.map(b => ({ pos: b.pos, block: b.block }))
    what = `${cells.length} blocks`
  } else {
    if (args.door && args.size[2] < 3) return failed('build: a door needs a box at least 3 high (a 2-high gap and a block over it)')
    cells = boxCells(args)
    what = `a ${args.hollow ? 'hollow ' : ''}${args.size.join('x')} ${args.material} box at [${args.corner.join(', ')}]${args.door ? ` with a door to the ${args.door}` : ''}${args.roof ? ', roofed' : ''}`
  }
  if (cells.length > 1024) return failed(`build: ${cells.length} cells; at most 1024`)
  const seen = new Set()
  cells = cells.filter(c => !seen.has(key(c.pos)) && seen.add(key(c.pos)))
  for (const c of cells) if (!api.isBlock(c.block)) return failed(`build: unknown block ${c.block}`)
  for (const c of cells) {
    const why = api.houseCheck('place', c.pos)
    if (why) return refused(`${why} (cell [${c.pos.join(', ')}] of the build)`)
  }

  const s0 = api.sight()
  const at = (x, y, z) => s0.classAt(x, y, z)
  const isEmpty = p => { const c = at(...p); return !!c && EMPTY.test(c.name) }
  const solid = p => { const c = at(...p); return !!c && c.solid && !c.fluid }
  const todo = new Map(cells.map(c => [key(c.pos), c]))
  const out = { cells: cells.length, placed: 0, skipped: 0, failed: [], short: {} }
  const fail = (c, reason) => { if (out.failed.length < 20) out.failed.push({ pos: c.pos, reason }); out.nFailed = (out.nFailed || 0) + 1 }
  const shortOf = c => { out.short[c.block] = (out.short[c.block] || 0) + 1 }
  const supported = c => NEIGHBOURS.some(([dx, dy, dz]) => solid([c.pos[0] + dx, c.pos[1] + dy, c.pos[2] + dz]))

  /** Can it work on cell c from an eye at e: in reach, and the cell in sight. */
  const workable = (e, c) => {
    const ctr = [c.pos[0] + 0.5, c.pos[1] + 0.5, c.pos[2] + 0.5]
    if (Math.hypot(ctr[0] - e[0], ctr[1] - e[1], ctr[2] - e[2]) > REACH) return false
    const cls = at(...c.pos)
    if (cls && !EMPTY.test(cls.name)) return blockVisible({ classAt: s0.classAt }, e, ...c.pos, cls, null) // a block there: a face in sight
    return reachesVoxel({ classAt: s0.classAt }, e, ctr, ...c.pos)
  }
  const blocksStanding = (p, c) => (p[0] === c.pos[0] && p[2] === c.pos[2] && (p[1] === c.pos[1] || p[1] + 1 === c.pos[1]))

  /** A spot to stand at for cell c: in reach and sight, standable now, not a cell still to fill; nearest to here. */
  const spotFor = (c, here) => {
    let best = null; let bd = Infinity
    for (let x = c.pos[0] - 4; x <= c.pos[0] + 4; x++) {
      for (let z = c.pos[2] - 4; z <= c.pos[2] + 4; z++) {
        for (let y = c.pos[1] - 4; y <= c.pos[1] + 3; y++) {
          const p = [x, y, z]
          if (!solid([x, y - 1, z]) || !isEmpty(p) || !isEmpty([x, y + 1, z])) continue
          if (todo.has(key(p)) || todo.has(key([x, y + 1, z])) || blocksStanding(p, c)) continue
          if (!workable([x + 0.5, y + 1.62, z + 0.5], c)) continue
          const dd = Math.hypot(x + 0.5 - here[0], y - here[1], z + 0.5 - here[2])
          if (dd < bd) { bd = dd; best = p }
        }
      }
    }
    return best
  }

  while (todo.size) {
    if (act.signal.aborted) return null
    // out of a material: its cells still to do are short (or skipped when already right), whatever holds them up
    for (const c of [...todo.values()]) {
      if (api.inventoryCount(c.block)) continue
      const cls = at(...c.pos)
      if (cls && cls.name === c.block) out.skipped++
      else shortOf(c)
      todo.delete(key(c.pos))
    }
    if (!todo.size) break
    // the lowest layer still to do; in it, a cell with something solid next to it, nearest first
    const rest = [...todo.values()]
    const layer = Math.min(...rest.map(c => c.pos[1]))
    const here = api.here().pos
    const ready = rest.filter(c => c.pos[1] === layer && (supported(c) || !isEmpty(c.pos)))
    if (!ready.length) {
      for (const c of rest.filter(c => c.pos[1] === layer)) { fail(c, 'nothing solid next to it to place against'); todo.delete(key(c.pos)) }
      continue
    }
    ready.sort((p, q) => Math.hypot(p.pos[0] - here[0], p.pos[2] - here[2]) - Math.hypot(q.pos[0] - here[0], q.pos[2] - here[2]))
    const c = ready[0]
    todo.delete(key(c.pos))
    act.progress(`build: ${out.placed + out.skipped}/${out.cells} cells (placed ${out.placed}), at [${c.pos.join(', ')}]`)
    // in reach and in sight, and not standing in it
    const feet = here.map(Math.floor)
    if (!workable(api.sight().eye, c) || blocksStanding(feet, c)) {
      const spot = spotFor(c, here)
      if (!spot) { fail(c, 'no spot to stand where it is in reach and in sight'); continue }
      const r = await api.goto([spot[0] + 0.5, spot[1], spot[2] + 0.5], { range: 0.5, dig: false, scaffold: false, signal: act.signal })
      if (act.signal.aborted) return null
      if (r.status !== 'reached') { fail(c, `could not get to [${spot.join(', ')}] to reach it (${r.status})`); continue }
    }
    // look again, now
    const now = api.peek(c.pos)
    if (now === c.block) { out.skipped++; continue }
    if (now !== null && !EMPTY.test(now)) { fail(c, `${now} is there (build never digs)`); continue }
    if (!api.inventoryCount(c.block)) { shortOf(c); continue }
    const r = await api.place(c.block, c.pos)
    if (r.refused) return refused(r.reason)
    if (r.ok) out.placed++
    else fail(c, r.reason)
  }

  const nFailed = out.nFailed || 0
  delete out.nFailed
  const short = Object.entries(out.short).map(([b, n]) => `${n} ${b}`).join(', ')
  const detail = `built ${what}: placed ${out.placed}, skipped ${out.skipped} (already there), failed ${nFailed}` +
    (short ? `; short ${short}` : '') +
    (out.failed.length ? `; first failure: [${out.failed[0].pos.join(', ')}] ${out.failed[0].reason}` : '')
  const status = !nFailed && !short ? 'done' : (out.placed + out.skipped > 0 ? 'partial' : 'failed')
  return { status, detail, data: { ...out, failed_count: nFailed, at: api.here().pos.map(r1) } }
}

module.exports = { run, boxCells, file: __filename }
