'use strict'
// Block classification for the fair-play observation builder.
// Pure: works on block names (plus an optional collision box hint), so it is
// the same for Mineflayer, a future Fabric backend, and the unit tests.

// Notable block types (CONTRACT.md, Observation): ores, logs, water, lava,
// chests, crafting tables, furnaces, beds, portals, spawners, and a few more a
// player would point out. Everything else (stone, dirt...) is never reported.
const NOTABLE_EXACT = new Set([
  'ancient_debris',
  'water', 'lava',
  'chest', 'trapped_chest', 'ender_chest', 'barrel',
  'crafting_table', 'furnace', 'blast_furnace', 'smoker',
  'nether_portal', 'end_portal', 'end_portal_frame', 'end_gateway',
  'spawner', 'trial_spawner', 'vault',
  'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil', 'brewing_stand',
  'obsidian', 'crying_obsidian'
])
const NOTABLE_PATTERNS = [
  /_ore$/, // coal_ore, deepslate_iron_ore, nether_gold_ore, ...
  /_log$/, // oak_log, stripped_oak_log, ...
  /^(crimson|warped)_stem$/,
  /_bed$/,
  /_shulker_box$/, /^shulker_box$/
]

function isNotable (name) {
  if (NOTABLE_EXACT.has(name)) return true
  for (const re of NOTABLE_PATTERNS) if (re.test(name)) return true
  return false
}

// Fluids are see-through for sight lines (you can see an ore at the bottom of
// a pool) except lava. A fluid *target* only counts where its surface shows,
// see observe.js.
const FLUIDS = new Set(['water', 'lava'])

// Blocks with a full collision box that a player can still see through.
// Leaves are deliberately NOT here: "the first solid block wins", and the
// conservative answer is the fair one.
const SEE_THROUGH_PATTERNS = [
  /^glass$/, /^tinted_glass$/, /_stained_glass$/, /glass_pane$/,
  /^ice$/, /^frosted_ice$/, /^iron_bars$/, /^barrier$/
]
const AIR = new Set(['air', 'cave_air', 'void_air'])

// Small built-in list of non-colliding blocks, used when the backend gives no
// collision hint (the tests). The Mineflayer adapter passes the registry's
// boundingBox instead, which covers every block.
const NON_COLLIDING_FALLBACK = [
  /^short_grass$/, /^tall_grass$/, /^fern$/, /^large_fern$/, /^dead_bush$/,
  /torch$/, /^rail$/, /_rail$/, /_sign$/, /_button$/, /^lever$/, /_carpet$/,
  /^snow$/, /^vine$/, /_sapling$/, /^dandelion$/, /^poppy$/, /_tulip$/,
  /^redstone_wire$/, /^light$/, /^structure_void$/, /^seagrass$/, /^tall_seagrass$/,
  /^kelp$/, /^kelp_plant$/, /^fire$/, /^soul_fire$/, /^cobweb$/
]

/**
 * @param {string} name block name without namespace
 * @param {string} [boundingBox] 'block' | 'empty' if the backend knows it
 * @returns {{name:string, opaque:boolean, fluid:boolean, notable:boolean}}
 *   opaque = blocks a sight line.
 */
function classify (name, boundingBox) {
  const fluid = FLUIDS.has(name)
  let opaque
  if (AIR.has(name)) opaque = false
  else if (name === 'water') opaque = false
  else if (name === 'lava') opaque = true
  else if (SEE_THROUGH_PATTERNS.some(re => re.test(name))) opaque = false
  else if (boundingBox === 'empty') opaque = false
  else if (boundingBox === 'block') opaque = true
  else opaque = !NON_COLLIDING_FALLBACK.some(re => re.test(name))
  return { name, opaque, fluid, notable: isNotable(name) }
}

module.exports = { classify, isNotable, AIR }
