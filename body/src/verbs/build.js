'use strict'
// build: lay a shape, bottom-up, from inventory blocks (Session 9c).
//   {shape: "box", corner: [x, y, z], size: [w, d, h], material, hollow = true, roof = false, door?}
//     corner = the low north-west corner (smallest x, y, z); w along x (east), d along z (south),
//     h up. hollow: the four walls only (roof: true adds a full top layer); hollow: false fills it.
//     door: north|south|east|west, a 1-wide, 2-high gap at the bottom, in the middle of that wall.
//   {blocks: [{block, pos}, ...]}  any design, up to 1024 cells.
//   prepare = false (Session 10a): first level the site. Dig every solid block inside the shape's bounding
//     box from its bottom (the corner's y) up, top-down (grass, dirt, stone, logs…; not what is already the
//     right block of the shell); then fill the empty cells under the footprint (down to the ground, at most
//     6 deep), bottom-up, with dirt from the inventory or else the material, so the shell sits on a level
//     base. A fluid next to a block to dig stops the build there, with the reason.
// How: cells go in layer by layer from the bottom; within a layer, only cells with something solid next
// to them (below, beside or above) are placed, so walls grow from the ground and a roof grows in from
// the walls. For each cell it finds where to stand (src/verbs/site.js: any standable cell in reach and in
// sight, inside the footprint and on placed blocks too, never a cell it still has to fill), tries the
// nearest few, then looks again: already the right block -> skipped; a plant (grass, flowers, snow layer…)
// or empty -> placed (the game replaces plants); another block -> failed (without prepare it never digs).
// A cell it cannot get to fails that cell only. It does not fetch materials.
// Refused when any cell is inside a protected region (house rules). Out of a material: those cells are
// counted as short and the result is partial ("short 12 cobblestone").
// data: {cells, placed, skipped, failed: [{pos, reason}] (first 20), short: {block: n}, dug, filled}
const { checkArgs, failed, refused, cannotAct } = require('./common')
const { Worksite, REPLACEABLE, FLUID } = require('./site')

const key = p => p.join(',')
const MAX_FILL = 6 // prepare: deepest gap under the footprint it fills
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
  const target = new Map(cells.map(c => [key(c.pos), c.block]))
  const out = { cells: cells.length, placed: 0, skipped: 0, failed: [], short: {}, dug: 0, filled: 0 }
  let nFailed = 0
  const fail = (pos, reason) => { if (out.failed.length < 20) out.failed.push({ pos, reason }); nFailed++ }
  const shortOf = block => { out.short[block] = (out.short[block] || 0) + 1 }
  const probe = new Worksite(act)
  let stopped = null

  // ---- prepare: level the site (dig inside the bounding box, fill under the footprint) ----
  if (args.prepare) {
    const lo = [0, 1, 2].map(i => Math.min(...cells.map(c => c.pos[i]))); const hi = [0, 1, 2].map(i => Math.max(...cells.map(c => c.pos[i])))
    const digs = []; const fills = []
    for (let y = hi[1]; y >= lo[1]; y--) {
      for (let x = lo[0]; x <= hi[0]; x++) {
        for (let z = lo[2]; z <= hi[2]; z++) {
          const c = probe.cls([x, y, z])
          if (c && c.solid && !c.fluid && target.get(key([x, y, z])) !== c.name) digs.push([x, y, z])
        }
      }
    }
    for (let x = lo[0]; x <= hi[0]; x++) {
      for (let z = lo[2]; z <= hi[2]; z++) {
        const gap = []
        for (let y = lo[1] - 1; y >= lo[1] - MAX_FILL; y--) {
          if (probe.solid([x, y, z])) break
          const c = probe.cls([x, y, z])
          if (!c || (c.fluid && c.name === 'lava')) { gap.length = 0; break }
          gap.push([x, y, z])
        }
        fills.push(...gap.reverse())
      }
    }
    fills.sort((p, q) => p[1] - q[1])
    for (const p of digs) { const why = api.houseCheck('dig', p); if (why) return refused(`${why} (prepare: dig [${p.join(', ')}])`) }
    for (const p of fills) { const why = api.houseCheck('place', p); if (why) return refused(`${why} (prepare: fill [${p.join(', ')}])`) }
    const fillSite = new Worksite(act, { avoid: new Set(fills.map(key)) })
    for (const p of digs) {
      if (act.signal.aborted) return null
      const c = probe.cls(p)
      if (!c || !c.solid || c.fluid) continue // gone already (fell, or dug with another)
      const wet = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map(([dx, dy, dz]) => [p[0] + dx, p[1] + dy, p[2] + dz]).find(q => { const k = probe.cls(q); return k && FLUID.test(k.name) })
      if (wet) { stopped = `stopped preparing: ${probe.cls(wet).name} next to [${p.join(', ')}] (at [${wet.join(', ')}])`; break }
      act.progress(`build: preparing, digging [${p.join(', ')}] (${c.name}), dug ${out.dug}`)
      const r = await fillSite.reach(p, 'dig')
      if (!r.ok) { fail(p, `prepare: dig ${c.name}: ${r.reason}`); continue }
      const d = await api.digObserved(p, c.name, { signal: act.signal, allowHand: true })
      if (act.signal.aborted) return null
      if (d.refused) return refused(d.reason)
      if (d.ok) out.dug++
      else fail(p, `prepare: dig ${c.name}: ${d.reason}`)
    }
    const filler = () => api.inventoryCount('dirt') ? 'dirt' : (cells.map(c => c.block).find(b => api.inventoryCount(b)) || null)
    for (const p of stopped ? [] : fills) {
      if (act.signal.aborted) return null
      if (!probe.empty(p)) { fillSite.avoid.delete(key(p)); continue }
      const b = filler()
      if (!b) { shortOf('dirt'); fillSite.avoid.delete(key(p)); continue }
      act.progress(`build: preparing, filling [${p.join(', ')}] with ${b}, filled ${out.filled}`)
      fillSite.avoid.delete(key(p))
      const r = await fillSite.reach(p, 'place')
      if (!r.ok) { fail(p, `prepare: fill: ${r.reason}`); continue }
      const pl = await api.place(b, p)
      if (pl.refused) return refused(pl.reason)
      if (pl.ok) out.filled++
      else fail(p, `prepare: fill: ${pl.reason}`)
    }
  }

  // ---- the shell, bottom-up ----
  const todo = new Map(stopped ? [] : cells.map(c => [key(c.pos), c]))
  const site = new Worksite(act, { avoid: new Set(todo.keys()) })
  const supported = c => [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some(([dx, dy, dz]) => site.solid([c.pos[0] + dx, c.pos[1] + dy, c.pos[2] + dz]))
  const done = c => { todo.delete(key(c.pos)); site.avoid.delete(key(c.pos)) }
  while (todo.size) {
    if (act.signal.aborted) return null
    // out of a material: its cells still to do are short (or skipped when already right), whatever holds them up
    for (const c of [...todo.values()]) {
      if (api.inventoryCount(c.block)) continue
      const k = site.cls(c.pos)
      if (k && k.name === c.block) out.skipped++
      else shortOf(c.block)
      done(c)
    }
    if (!todo.size) break
    // the lowest layer still to do; in it, a cell with something solid next to it (or already filled), nearest first
    const rest = [...todo.values()]
    const layer = Math.min(...rest.map(c => c.pos[1]))
    const here = api.here().pos
    const ready = rest.filter(c => c.pos[1] === layer && (supported(c) || !site.empty(c.pos)))
    if (!ready.length) {
      for (const c of rest.filter(c => c.pos[1] === layer)) { fail(c.pos, 'nothing solid next to it to place against'); done(c) }
      continue
    }
    ready.sort((p, q) => Math.hypot(p.pos[0] - here[0], p.pos[2] - here[2]) - Math.hypot(q.pos[0] - here[0], q.pos[2] - here[2]))
    const c = ready[0]
    done(c)
    act.progress(`build: ${out.placed + out.skipped}/${out.cells} cells (placed ${out.placed}), at [${c.pos.join(', ')}]`)
    const r = await site.reach(c.pos, 'place')
    if (act.signal.aborted) return null
    if (!r.ok) { fail(c.pos, r.reason); continue }
    // look again, now
    const now = api.peek(c.pos)
    if (now === c.block) { out.skipped++; continue }
    if (now !== null && !REPLACEABLE.test(now)) { fail(c.pos, `${now} is there (build never digs; prepare: true levels the site)`); continue }
    if (!api.inventoryCount(c.block)) { shortOf(c.block); continue }
    const pl = await api.place(c.block, c.pos)
    if (pl.refused) return refused(pl.reason)
    if (pl.ok) out.placed++
    else fail(c.pos, pl.reason)
  }

  const short = Object.entries(out.short).map(([b, n]) => `${n} ${b}`).join(', ')
  const prep = args.prepare ? `prepared (dug ${out.dug}, filled ${out.filled}); ` : ''
  const detail = `built ${what}: ${prep}placed ${out.placed}, skipped ${out.skipped} (already there), failed ${nFailed}` +
    (short ? `; short ${short}` : '') +
    (stopped ? `; ${stopped}` : '') +
    (out.failed.length ? `; first failure: [${out.failed[0].pos.join(', ')}] ${out.failed[0].reason}` : '')
  const status = !nFailed && !short && !stopped ? 'done' : (out.placed + out.skipped + out.dug + out.filled > 0 ? 'partial' : 'failed')
  return { status, detail, data: { ...out, failed_count: nFailed, at: api.here().pos.map(r1), ...(stopped ? { stopped } : {}) } }
}

module.exports = { run, boxCells, file: __filename }
