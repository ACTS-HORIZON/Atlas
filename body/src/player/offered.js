'use strict'
// Offered micro-actions (CONTRACT.md, "Player loop"): every tick the body
// offers only the actions that are possible AND not immediately lethal. The
// 2B decision model stays safe by what it is offered, not by what it knows.
//
// Works on a probe (built from the filtered API in loop.js, from fake worlds
// in tests):
//   feet [x, y, z] (block), dir (north|east|south|west: where it faces),
//   cls(x, y, z) -> blocks.classify() result | null (unknown / not loaded),
//   inventory {name: count}, food (0-20), foods [edible names held],
//   threats [{type, rel: [dx, dy, dz], dist}] (visible hostiles),
//   houseOk(action, pos) -> bool (protected regions), onGround
const DIRS = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }
const LEFT = { north: 'west', west: 'south', south: 'east', east: 'north' }
const RIGHT = { north: 'east', east: 'south', south: 'west', west: 'north' }

const MICRO = ['step', 'sprint', 'jump', 'turn_left', 'turn_right', 'look_up', 'look_down', 'dig_ahead', 'dig_above', 'dig_below',
  'place_below_and_jump', 'place_ahead', 'attack', 'block', 'retreat', 'eat', 'wait', 'done', 'stuck', 'continue_task']
// One line per micro-action: the `criteria` of the decision model's choice question.
const DESCRIPTIONS = {
  step: 'walk one block forward',
  sprint: 'sprint two blocks forward',
  jump: 'jump in place',
  turn_left: 'turn 90 degrees to the left',
  turn_right: 'turn 90 degrees to the right',
  look_up: 'tilt the view up',
  look_down: 'tilt the view down',
  dig_ahead: 'break the block in front at feet/head height',
  dig_above: 'break the block above the head',
  dig_below: 'break the block under the feet and drop into its space',
  place_below_and_jump: 'jump and place a block under the feet to climb one block',
  place_ahead: 'place a block in front at feet height',
  attack: 'hit the nearest hostile mob in reach',
  block: 'raise the shield',
  retreat: 'step away from the nearest threat',
  eat: 'eat food to restore hunger',
  wait: 'do nothing this tick',
  done: 'the intent is accomplished',
  stuck: 'the intent cannot be accomplished from here',
  continue_task: 'let the running task carry on'
}
const SURVIVAL = new Set(['attack', 'block', 'retreat', 'eat', 'jump', 'wait', 'continue_task'])

const HURTS = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire|cactus|sweet_berry_bush|powder_snow|wither_rose|pointed_dripstone)$/
const UNBREAKABLE = /^(bedrock|barrier|end_portal_frame|end_portal|nether_portal|command_block|structure_block|reinforced_deepslate|light)$/
// Blocks it may stand a pillar on or place ahead (full, ordinary blocks).
const PLACEABLE = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate',
  'blackstone', 'sandstone', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks']
const MAX_DROP = 3

const isSolid = c => !!c && c.solid && !c.fluid
const passable = c => !!c && !c.solid && !HURTS.test(c.name) && c.name !== 'lava'
const diggable = c => isSolid(c) && !UNBREAKABLE.test(c.name)

/** What a step into column (x, z) at feet level y lands on: {ok, depth, landing} (depth = blocks fallen). */
function landing (p, x, y, z) {
  for (let depth = 0; depth <= MAX_DROP + 1; depth++) {
    const c = p.cls(x, y - 1 - depth, z)
    if (c === null) return { ok: false, why: 'floor not seen' }
    if (c.name === 'lava' || HURTS.test(c.name)) return { ok: false, why: `${c.name} below` }
    if (isSolid(c) || c.name === 'water') return depth > MAX_DROP ? { ok: false, why: `drop of ${depth}` } : { ok: true, depth, landing: c.name }
    // air (or a plant): keep falling
  }
  return { ok: false, why: `drop over ${MAX_DROP}` }
}

/** Can it walk one block toward d from feet (x, y, z)? */
function stepOk (p, x, y, z, d) {
  const nx = x + d[0]; const nz = z + d[1]
  const feet = p.cls(nx, y, nz); const head = p.cls(nx, y + 1, nz)
  if (!passable(feet) || !passable(head)) return false
  return landing(p, nx, y, nz).ok
}

function blockFor (p) { return PLACEABLE.find(b => (p.inventory[b] || 0) > 0) || null }

/** The actions offered this tick, in a fixed order. mode: 'play' (an intent) or 'survive' (a scripted verb is running). */
function offeredActions (p, mode = 'play') {
  const [x, y, z] = p.feet
  const d = DIRS[p.dir] || DIRS.north
  const out = new Set(['wait'])
  const houseOk = p.houseOk || (() => true)

  // moving
  if (stepOk(p, x, y, z, d)) {
    out.add('step')
    if ((p.food ?? 20) > 6 && stepOk(p, x + d[0], y, z + d[1], d)) out.add('sprint')
  }
  const above = p.cls(x, y + 2, z)
  if (above && !isSolid(above) && above.name !== 'lava') out.add('jump')
  out.add('turn_left'); out.add('turn_right'); out.add('look_up'); out.add('look_down')

  // digging: one block, never into or under a fluid
  const ahead = [[x + d[0], y + 1, z + d[1]], [x + d[0], y, z + d[1]]].find(q => isSolid(p.cls(...q)))
  if (ahead && diggable(p.cls(...ahead)) && houseOk('dig', ahead)) {
    const behind = p.cls(ahead[0] + d[0], ahead[1], ahead[2] + d[1]); const over = p.cls(ahead[0], ahead[1] + 1, ahead[2])
    if (!(behind && behind.name === 'lava') && !(over && (over.name === 'lava' || over.name === 'water'))) out.add('dig_ahead')
  }
  const up = p.cls(x, y + 2, z); const upper = p.cls(x, y + 3, z)
  if (diggable(up) && houseOk('dig', [x, y + 2, z]) && !(upper && (upper.name === 'lava' || upper.name === 'water'))) out.add('dig_above')
  const below = p.cls(x, y - 1, z); const under = p.cls(x, y - 2, z)
  if (diggable(below) && houseOk('dig', [x, y - 1, z]) && isSolid(under)) out.add('dig_below') // never with air (or a fluid) under it

  // placing
  const block = blockFor(p)
  if (block && p.onGround !== false && above && !isSolid(above) && houseOk('place', [x, y, z])) out.add('place_below_and_jump')
  const af = p.cls(x + d[0], y, z + d[1])
  if (block && af && !isSolid(af) && af.name !== 'lava' && houseOk('place', [x + d[0], y, z + d[1]])) out.add('place_ahead')

  // fighting and eating
  const threats = (p.threats || []).filter(t => t.dist <= 16)
  if (threats.some(t => t.dist <= 3.5)) out.add('attack')
  if ((p.inventory.shield || 0) > 0 && threats.some(t => t.dist <= 8)) out.add('block')
  if (threats.length) {
    const t = threats[0]
    const away = Math.abs(t.rel[0]) >= Math.abs(t.rel[2]) ? (t.rel[0] > 0 ? DIRS.west : DIRS.east) : (t.rel[2] > 0 ? DIRS.north : DIRS.south)
    if (stepOk(p, x, y, z, away)) out.add('retreat')
  }
  if ((p.foods || []).length && (p.food ?? 20) < 20) out.add('eat')

  if (mode === 'survive') {
    out.add('continue_task')
    return MICRO.filter(a => out.has(a) && SURVIVAL.has(a))
  }
  out.add('done'); out.add('stuck')
  return MICRO.filter(a => out.has(a))
}

module.exports = { offeredActions, landing, stepOk, blockFor, MICRO, DESCRIPTIONS, SURVIVAL, DIRS, LEFT, RIGHT, PLACEABLE, isSolid }
