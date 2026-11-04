'use strict'
// mine {block, count = 1, radius = 32, y?}
//
// Only blocks it has seen are targets: notable types from blocks_seen and
// known places, and any type (stone, dirt, gravel, sand, logs…) visible in
// the terrain around it, by the same line-of-sight check. For each, nearest
// first: walk to where a face is in reach (the path may dig through what is
// in the way and pillar, as a player does), dig it with the best tool, pick
// up the drop. Ends with done at `count`, or partial with the count reached
// when none are left in the radius.
//
// Ores not in view: if none of that ore is observed when the verb
// starts, it strip-mines: a 1x2 tunnel forward at the current y, a
// branch-mine serpentine (straight for ATLAS_STRIP_LENGTH blocks, 3 across,
// back), mining any target that comes into view, until count or stop.
// A common type not in view fails ("no stone in view"); moving is the mind's
// decision.
//
// y (ores): the level to strip-mine at. Before tunnelling it digs a 1-wide
// staircase (2 high; 3 blocks cleared per step) down to y. It steps down only
// onto a solid floor it has seen through the opened step, never digs a fluid,
// and stops with the reason at water, lava (also one block further on), a drop
// or the bottom of the world. It only goes down: above y it tunnels where it
// is. With y, strip-mining also follows once the ores in view are mined.
//
// Refused: a dig on a position that was not observed (fair play) or inside a
// protected region (house rules), both enforced by the API. Failed: unknown
// block, a block that needs a tool the bot does not have, spectator or
// adventure mode, nothing of that type in view.
const { checkArgs, failed, refused, cannotAct } = require('./common')

const FLUIDS = new Set(['water', 'lava'])
const OPEN = new Set(['air', 'cave_air', 'void_air'])
const RIGHT = { north: 'east', east: 'south', south: 'west', west: 'north' }
const LEFT = { north: 'west', west: 'south', south: 'east', east: 'north' }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function run (act, args) {
  if (args && Object.hasOwn(args, 'box')) return mineBox(act, args)
  const err = checkArgs('mine', args)
  if (err) return failed(err)
  const api = act.api
  const { block, count, radius, y } = args
  if (!api.isBlock(block)) {
    const hint = api.mineHint(block) // e.g. raw_iron: "an item, not a block; it drops from iron_ore …"
    return failed(`mine: ${hint || `unknown block ${block}`}`)
  }
  const no = cannotAct(api, 'mine')
  if (no) return no
  if (api.gamemode() === 'adventure') return failed('mine: cannot dig in adventure mode')
  const tool = api.toolFor(block)
  if (!tool.ok) return failed(`mine: ${tool.reason}`)

  const skip = new Set() // targets that could not be reached or dug
  let protectedSkipped = 0; let houseReason = null
  const notable = api.isObservableType(block)
  const ore = /_ore$/.test(block) || block === 'ancient_debris'
  const initial = api.targetsOfType(block, radius)
  if (!initial.length && !ore) {
    const hint = api.mineHint(block, { inView: false }) // e.g. cobblestone: "the item drops from stone …"
    return failed(`mine: no ${block} in view within ${notable ? radius : Math.min(radius, 24)} blocks${hint ? `; ${hint}` : ''}`)
  }
  const strip = { allowed: ore && (initial.length === 0 || y !== undefined), dug: 0, stairs: 0, stopped: null, staircase: y !== undefined }
  let mined = 0
  const progress = note => act.progress(`${mined}/${count} ${block}${strip.stairs ? `, stairs ${strip.stairs}` : ''}${strip.dug ? `, tunnel ${strip.dug}` : ''}${note ? ': ' + note : ''}`)

  while (mined < count) {
    if (act.signal.aborted) return null
    const targets = api.targetsOfType(block, radius).filter(t => !skip.has(t.pos.join(',')))
    if (!targets.length) {
      if (!strip.allowed || strip.stopped) break
      if (strip.staircase) {
        const r = await staircase(act, api, block, radius, skip, y, strip, progress)
        if (act.signal.aborted) return null
        if (r === 'found') continue
        if (r === 'stopped') break
        strip.staircase = false // at y (or below it): tunnel from here
      }
      progress('none in view, strip-mining')
      const r = await stripMine(act, api, block, radius, skip, strip, progress)
      if (act.signal.aborted) return null
      if (r === 'found') continue
      break
    }
    const t = targets[0]
    const k = t.pos.join(',')
    progress(`going to [${t.pos.join(', ')}]`)
    const g = await api.goto(t.pos, { kind: 'look', dig: true, scaffold: true, signal: act.signal, onProgress: d => progress(`${d} blocks to [${t.pos.join(', ')}]`) })
    if (act.signal.aborted) return null
    if (g.status !== 'reached') { skip.add(k); continue }
    progress(`digging [${t.pos.join(', ')}]`)
    const d = await api.digObserved(t.pos, block, { signal: act.signal })
    if (act.signal.aborted) return null
    if (d.refused && /^house rules/.test(d.reason)) { skip.add(k); protectedSkipped++; houseReason = d.reason; continue }
    if (d.refused) return refused(d.reason)
    if (d.needsTool) return failed(`mine: ${d.reason}`)
    if (!d.ok) { skip.add(k); continue }
    mined++
    progress('picking up')
    await pickUpNearby(api, act.signal)
  }

  const data = { block, mined, requested: count, tunnel: strip.dug }
  if (y !== undefined) Object.assign(data, { y, stairs: strip.stairs, at_y: Math.floor(api.here().pos[1]) })
  if (mined >= count) return { status: 'done', detail: `mined ${mined} ${block}`, data }
  if (mined === 0 && protectedSkipped && !strip.stopped) return refused(`${houseReason}; no other ${block} in view`)
  const prot = protectedSkipped ? `; ${protectedSkipped} inside protected regions left alone` : ''
  const why = strip.stopped ? `${strip.stopIn || 'strip-mining'} stopped: ${strip.stopped}` : `none left in view within ${notable ? radius : Math.min(radius, 24)} blocks`
  return { status: 'partial', detail: `mined ${mined} of ${count} ${block}; ${why}${prot}`, data }
}

/** Walk over drops that landed in sight within 4 blocks. Best effort. */
async function pickUpNearby (api, signal) {
  await sleep(300) // let the drop pop out
  for (const d of api.visibleDrops(null, 4)) {
    if (signal.aborted) return
    await api.pickUp(d, { signal })
  }
}

const BRIDGE = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'blackstone']
const MAX_FALL = 3

/**
 * Open one cell in front at dy, re-digging gravel/sand that falls in. A
 * reason string when it has to stop. A dig the game says it can't see
 * ("Block not in view": the bot is off-centre or turned) is retried after
 * facing the way again and re-centring; if it still fails, the reason is
 * "blocked: …" and the tunnel turns instead of stopping.
 */
async function clearAhead (act, api, dir, dy) {
  let unseen = 0
  for (let tries = 0; ; tries++) {
    const name = api.peek(api.ahead(dir, dy))
    if (name === null || OPEN.has(name)) return null
    if (FLUIDS.has(name)) return `${name} ahead`
    if (tries >= 8) return `${name} keeps falling in`
    const r = await api.digAhead(dir, dy, { signal: act.signal })
    if (act.signal.aborted) return 'stopped'
    if (!r.ok && /not in view/i.test(r.reason || '')) {
      if (++unseen > 2) return `blocked: could not get a clear look at the ${name} ahead`
      await api.face(dir)
      await api.recenter({ signal: act.signal })
      continue
    }
    if (!r.ok) return r.reason
    await sleep(200)
  }
}

/**
 * The floor of the next step (at ahead(dir, floorDy)): 'ok', a fall
 * {fall: n} to take, or {stop: reason}. A hole is bridged with a block from
 * the inventory when there is one (cobblestone, dirt…); else, if the drop is
 * 3 or less, the bot steps down into it; deeper, it stops. extra = blocks
 * already dropped by the step itself (1 on the staircase).
 */
async function floorAhead (act, api, dir, floorDy, extra = 0) {
  const name = api.peek(api.ahead(dir, floorDy))
  if (name !== null && !OPEN.has(name) && !FLUIDS.has(name)) return 'ok'
  if (FLUIDS.has(name)) return { stop: `${name} under the next step` }
  const inv = api.inventory()
  const mat = BRIDGE.find(m => inv[m] > 0)
  if (mat) {
    const r = await api.place(mat, api.ahead(dir, floorDy))
    if (act.signal.aborted) return { stop: 'stopped' }
    if (r.ok) return 'ok'
  }
  // how deep: air below the step, as far as it can be seen
  let depth = 0
  for (let k = 0; k <= MAX_FALL + 1; k++) {
    const c = api.peek(api.ahead(dir, floorDy - k), { lean: dir })
    if (c === null) { depth = null; break }
    if (FLUIDS.has(c)) return { stop: `${c} ${k + 1} below the next step` }
    if (!OPEN.has(c)) break
    depth++
  }
  const nothing = mat ? '' : '; nothing to bridge it with'
  if (depth === null) return { stop: `a drop under the next step (can't see the bottom${nothing})` }
  if (depth + extra > MAX_FALL) return { stop: `a drop of ${depth + extra}${depth > MAX_FALL ? '+' : ''} under the next step${mat ? '' : ' (nothing to bridge it with)'}` }
  return { fall: depth }
}

/**
 * Staircase down to level y: per step, clear head+1, head and feet-1 in
 * front, check the floor that opened up (feet-2) is solid, step down.
 * 'found' when a target comes into view, 'arrived' at y, 'stopped' (reason
 * in strip.stopped).
 */
async function staircase (act, api, block, radius, skip, y, strip, progress) {
  const dir = api.facing()
  await api.face(dir)
  const minY = -64
  while (Math.floor(api.here().pos[1]) > y) {
    if (act.signal.aborted) return 'stopped'
    if (api.seenBlocks(block, radius).some(t => !skip.has(t.pos.join(',')))) return 'found'
    const at = Math.floor(api.here().pos[1])
    const stop = reason => { strip.stopped = reason; strip.stopIn = `staircase at y ${at}`; return 'stopped' }
    if (at - 2 < minY) return stop('the bottom of the world')
    for (const dy of [1, 0, -1]) {
      const why = await clearAhead(act, api, dir, dy)
      if (act.signal.aborted) return 'stopped'
      if (why) return stop(why)
    }
    // the next step's floor, seen through the opened cell: solid ground, a
    // bridged hole, or a short fall (3 at most, the step included)
    const floor = await floorAhead(act, api, dir, -2, 1)
    if (act.signal.aborted) return 'stopped'
    if (floor.stop) return stop(floor.stop)
    for (const [dy, n] of [[-1, 2], [0, 2], [-2, 1]]) { // lava one block further on, or seeping in
      const beyond = api.peek(api.ahead(dir, dy, n))
      if (beyond === 'lava') return stop('lava ahead')
    }
    const s = await api.stepDown(dir, { signal: act.signal, depth: 1 + (floor.fall || 0) })
    if (act.signal.aborted) return 'stopped'
    if (s.status !== 'reached') return stop('could not step down')
    strip.stairs++
    progress(`staircase ${dir}, y ${Math.floor(api.here().pos[1])} -> ${y}`)
  }
  return 'arrived'
}

/**
 * Tunnel until a target of `block` comes into view ('found') or the tunnel
 * has to stop ('stopped', reason in strip.stopped).
 */
async function stripMine (act, api, block, radius, skip, strip, progress) {
  const cfg = act.cfg || {}
  const length = cfg.stripLength || 24
  const max = cfg.stripMax || 256
  let dir = api.facing()
  let leg = 'long'; let side = 'right'; let sinceTurn = 0; let turnsBlocked = 0
  await api.face(dir)
  while (strip.dug < max) {
    if (act.signal.aborted) return 'stopped'
    if (api.seenBlocks(block, radius).some(t => !skip.has(t.pos.join(',')))) return 'found'

    // clear the head block, then the feet block (gravel above falls into the gap: dig again)
    let blocked = null
    for (const dy of [1, 0]) {
      const why = await clearAhead(act, api, dir, dy)
      if (act.signal.aborted) return 'stopped'
      if (why && /^blocked: /.test(why)) { blocked = why; break }
      if (why) { strip.stopped = why; return 'stopped' }
    }
    if (blocked) { // re-plan: tunnel on in the next direction instead
      if (++turnsBlocked >= 4) { strip.stopped = blocked; return 'stopped' }
      dir = RIGHT[dir]; sinceTurn = 0
      await api.face(dir)
      progress(`${blocked}; turning ${dir}`)
      continue
    }
    turnsBlocked = 0
    // the opened cell's floor: a hole is bridged or stepped down into (3 at most); lava and water stop it
    const floor = await floorAhead(act, api, dir, -1)
    if (act.signal.aborted) return 'stopped'
    if (floor.stop) { strip.stopped = floor.stop; return 'stopped' }
    for (const dy of [0, 1]) {
      const beyond = api.peek(api.ahead(dir, dy, 2))
      if (beyond === 'lava') { strip.stopped = 'lava ahead'; return 'stopped' }
    }
    const s = floor.fall ? await api.stepDown(dir, { signal: act.signal, depth: floor.fall }) : await api.step(dir, { signal: act.signal })
    if (act.signal.aborted) return 'stopped'
    if (s.status !== 'reached') { strip.stopped = 'could not step forward'; return 'stopped' }
    strip.dug++
    sinceTurn++
    progress(`tunnelling ${dir}`)
    if ((leg === 'long' && sinceTurn >= length) || (leg === 'short' && sinceTurn >= 3)) {
      dir = side === 'right' ? RIGHT[dir] : LEFT[dir]
      if (leg === 'short') side = side === 'right' ? 'left' : 'right'
      leg = leg === 'long' ? 'short' : 'long'
      sinceTurn = 0
      await api.face(dir)
    }
  }
  strip.stopped = `tunnel limit of ${max} blocks reached`
  return 'stopped'
}

/**
 * mine {box: [[x1, y1, z1], [x2, y2, z2]], block?} (Session 10a, the contract's "box = dig out a region"): dig
 * every solid block in the box (only that type when block is named) (corners inclusive, at most 4096 cells), top layer first, nearest first within a
 * layer, standing wherever each block is in reach and in sight (src/verbs/site.js). Cells in a protected
 * region are skipped and reported. Water or lava in the box, or next to a block about to be dug, stops it
 * with the reason (it never opens a fluid). This is also how the mind levels a site.
 * data: {box, size, dug, protected, failed: [{pos, reason}] (first 20), stopped?}
 */
async function mineBox (act, args) {
  for (const k of Object.keys(args)) if (k !== 'box' && k !== 'block') return failed(`mine: with box, only block may go with it ("${k}")`)
  if (args.block !== undefined && (typeof args.block !== 'string' || !act.api.isBlock(args.block))) return failed(`mine: unknown block ${args.block}`)
  const b = args.box
  const v3 = v => Array.isArray(v) && v.length === 3 && v.every(Number.isInteger)
  if (!Array.isArray(b) || b.length !== 2 || !v3(b[0]) || !v3(b[1])) return failed('mine: box must be [[x1, y1, z1], [x2, y2, z2]] (whole numbers)')
  const lo = [0, 1, 2].map(i => Math.min(b[0][i], b[1][i])); const hi = [0, 1, 2].map(i => Math.max(b[0][i], b[1][i]))
  const size = [0, 1, 2].map(i => hi[i] - lo[i] + 1)
  if (size[0] * size[1] * size[2] > 4096) return failed(`mine: the box is ${size.join('x')} = ${size[0] * size[1] * size[2]} cells; at most 4096`)
  const api = act.api
  const no = cannotAct(api, 'mine')
  if (no) return no
  if (api.gamemode() === 'adventure') return failed('mine: cannot dig in adventure mode')
  const { Worksite, FLUID } = require('./site')
  const site = new Worksite(act)
  const out = { box: [lo, hi], size, dug: 0, protected: 0, failed: [] }
  let nFailed = 0; let firstProtected = null; let stopped = null
  const fail = (pos, reason) => { if (out.failed.length < 20) out.failed.push({ pos, reason }); nFailed++ }
  const here = api.here().pos
  const near = (p, q) => Math.hypot(p[0] + 0.5 - here[0], p[2] + 0.5 - here[2]) - Math.hypot(q[0] + 0.5 - here[0], q[2] + 0.5 - here[2])
  for (let y = hi[1]; y >= lo[1] && !stopped; y--) {
    const layer = []
    for (let x = lo[0]; x <= hi[0]; x++) for (let z = lo[2]; z <= hi[2]; z++) layer.push([x, y, z])
    layer.sort(near)
    for (const p of layer) {
      if (act.signal.aborted) return null
      const c = site.cls(p)
      if (!c) continue
      if (FLUID.test(c.name)) { stopped = `${c.name} at [${p.join(', ')}], in the box`; break }
      if (!c.solid) continue
      if (args.block && c.name !== args.block) continue // only that type, when one is named
      const why = api.houseCheck('dig', p)
      if (why) { out.protected++; firstProtected = firstProtected || p; continue }
      const wet = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]].map(([dx, dy, dz]) => [p[0] + dx, p[1] + dy, p[2] + dz]).find(q => { const k = site.cls(q); return k && FLUID.test(k.name) })
      if (wet) { stopped = `${site.cls(wet).name} next to [${p.join(', ')}] (at [${wet.join(', ')}])`; break }
      act.progress(`mine box: layer y ${y}, dug ${out.dug}, at [${p.join(', ')}] (${c.name})`)
      const r = await site.reach(p, 'dig')
      if (act.signal.aborted) return null
      if (!r.ok) { fail(p, `${c.name}: ${r.reason}`); continue }
      const d = await api.digObserved(p, c.name, { signal: act.signal, allowHand: true })
      if (act.signal.aborted) return null
      if (d.ok) out.dug++
      else fail(p, `${c.name}: ${d.reason}`)
    }
  }
  const detail = `mined out the ${size.join('x')} box [${lo.join(', ')}]..[${hi.join(', ')}]: dug ${out.dug}` +
    (out.protected ? `, skipped ${out.protected} in a protected region (first [${firstProtected.join(', ')}])` : '') +
    (nFailed ? `, failed ${nFailed}; first failure: [${out.failed[0].pos.join(', ')}] ${out.failed[0].reason}` : '') +
    (stopped ? `; stopped: ${stopped}` : '')
  return { status: stopped || nFailed || out.protected ? (out.dug ? 'partial' : (stopped ? 'partial' : 'failed')) : 'done', detail, data: { ...out, failed_count: nFailed, ...(stopped ? { stopped } : {}) } }
}

module.exports = { run, file: __filename, stripMine, staircase }
