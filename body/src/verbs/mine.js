'use strict'
// mine {block, count = 1, radius = 32}
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
  if (args && Object.hasOwn(args, 'box')) return failed('mine: box is not supported yet')
  const err = checkArgs('mine', args)
  if (err) return failed(err)
  const api = act.api
  const { block, count, radius } = args
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
  const strip = { allowed: ore && initial.length === 0, dug: 0, stopped: null }
  let mined = 0
  const progress = note => act.progress(`${mined}/${count} ${block}${strip.dug ? `, tunnel ${strip.dug}` : ''}${note ? ': ' + note : ''}`)

  while (mined < count) {
    if (act.signal.aborted) return null
    const targets = api.targetsOfType(block, radius).filter(t => !skip.has(t.pos.join(',')))
    if (!targets.length) {
      if (!strip.allowed || strip.stopped) break
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
  if (mined >= count) return { status: 'done', detail: `mined ${mined} ${block}`, data }
  if (mined === 0 && protectedSkipped && !strip.stopped) return refused(`${houseReason}; no other ${block} in view`)
  const prot = protectedSkipped ? `; ${protectedSkipped} inside protected regions left alone` : ''
  const why = strip.stopped ? `strip-mining stopped: ${strip.stopped}` : `none left in view within ${notable ? radius : Math.min(radius, 24)} blocks`
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

/**
 * Tunnel until a target of `block` comes into view ('found') or the tunnel
 * has to stop ('stopped', reason in strip.stopped).
 */
async function stripMine (act, api, block, radius, skip, strip, progress) {
  const cfg = act.cfg || {}
  const length = cfg.stripLength || 24
  const max = cfg.stripMax || 256
  let dir = api.facing()
  let leg = 'long'; let side = 'right'; let sinceTurn = 0
  await api.face(dir)
  while (strip.dug < max) {
    if (act.signal.aborted) return 'stopped'
    if (api.seenBlocks(block, radius).some(t => !skip.has(t.pos.join(',')))) return 'found'

    // clear the head block, then the feet block (gravel above falls into the gap: dig again)
    for (const dy of [1, 0]) {
      for (let tries = 0; ; tries++) {
        const name = api.peek(api.ahead(dir, dy))
        if (name === null || OPEN.has(name)) break
        if (FLUIDS.has(name)) { strip.stopped = `${name} ahead`; return 'stopped' }
        if (tries >= 8) { strip.stopped = `${name} keeps falling in`; return 'stopped' }
        const r = await api.digAhead(dir, dy, { signal: act.signal })
        if (act.signal.aborted) return 'stopped'
        if (!r.ok) { strip.stopped = r.reason; return 'stopped' }
        await sleep(200)
      }
    }
    // what the opened cell shows: no stepping into a hole, lava or water
    const floor = api.peek(api.ahead(dir, -1))
    if (floor === null || OPEN.has(floor) || FLUIDS.has(floor)) { strip.stopped = floor ? `${floor} under the next step` : 'drop ahead'; return 'stopped' }
    for (const dy of [0, 1]) {
      const beyond = api.peek(api.ahead(dir, dy, 2))
      if (beyond === 'lava') { strip.stopped = 'lava ahead'; return 'stopped' }
    }
    const s = await api.step(dir, { signal: act.signal })
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

module.exports = { run, file: __filename, stripMine }
