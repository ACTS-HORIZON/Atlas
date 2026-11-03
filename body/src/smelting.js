'use strict'
// Smelting knowledge the smelt verb needs: what turns into what, which
// furnace takes it, and how many items a fuel item smelts. Java Edition
// furnace recipes (minecraft-data has none). A blast furnace takes ores and
// raw metals at twice the speed; a smoker takes food at twice the speed.

const ORES = {
  raw_iron: 'iron_ingot',
  iron_ore: 'iron_ingot',
  deepslate_iron_ore: 'iron_ingot',
  raw_gold: 'gold_ingot',
  gold_ore: 'gold_ingot',
  deepslate_gold_ore: 'gold_ingot',
  nether_gold_ore: 'gold_ingot',
  raw_copper: 'copper_ingot',
  copper_ore: 'copper_ingot',
  deepslate_copper_ore: 'copper_ingot',
  coal_ore: 'coal',
  deepslate_coal_ore: 'coal',
  diamond_ore: 'diamond',
  deepslate_diamond_ore: 'diamond',
  emerald_ore: 'emerald',
  deepslate_emerald_ore: 'emerald',
  lapis_ore: 'lapis_lazuli',
  deepslate_lapis_ore: 'lapis_lazuli',
  redstone_ore: 'redstone',
  deepslate_redstone_ore: 'redstone',
  nether_quartz_ore: 'quartz',
  ancient_debris: 'netherite_scrap'
}

const FOOD = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
  kelp: 'dried_kelp'
}

const OTHER = {
  cobblestone: 'stone',
  stone: 'smooth_stone',
  cobbled_deepslate: 'deepslate',
  sand: 'glass',
  red_sand: 'glass',
  clay_ball: 'brick',
  clay: 'terracotta',
  netherrack: 'nether_brick',
  stone_bricks: 'cracked_stone_bricks',
  sandstone: 'smooth_sandstone',
  quartz_block: 'smooth_quartz',
  basalt: 'smooth_basalt',
  cactus: 'green_dye',
  sea_pickle: 'lime_dye',
  wet_sponge: 'sponge',
  chorus_fruit: 'popped_chorus_fruit'
}

const LOGS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']
for (const w of LOGS) {
  for (const k of [`${w}_log`, `${w}_wood`, `stripped_${w}_log`, `stripped_${w}_wood`]) OTHER[k] = 'charcoal'
}

const RECIPES = { ...ORES, ...FOOD, ...OTHER }
const FURNACES = ['furnace', 'blast_furnace', 'smoker']

/** Which furnace types can smelt this input. */
function furnacesFor (input) {
  if (ORES[input]) return ['furnace', 'blast_furnace']
  if (FOOD[input]) return ['furnace', 'smoker']
  return RECIPES[input] ? ['furnace'] : []
}

/** Inputs that smelt into output, in a sensible order (raw metal before ore blocks). */
function inputsFor (output) {
  return Object.keys(RECIPES).filter(k => RECIPES[k] === output)
}

/** Items one fuel item smelts in a furnace (vanilla burn time / 200 ticks). */
function fuelValue (name) {
  if (name === 'coal' || name === 'charcoal') return 8
  if (name === 'coal_block') return 80
  if (name === 'lava_bucket') return 100
  if (name === 'blaze_rod') return 12
  if (name === 'dried_kelp_block') return 20
  if (/_planks$|_log$|_wood$|_stem$|_hyphae$/.test(name)) return 1.5
  if (name === 'stick' || /_sapling$/.test(name)) return 0.5
  return 0
}

// Fuel picked when none is named: coal, charcoal, then planks, then logs.
const FUEL_ORDER = [n => n === 'coal', n => n === 'charcoal', n => n === 'coal_block', n => /_planks$/.test(n), n => /_log$|_wood$|_stem$|_hyphae$/.test(n)]

/** The best fuel in an inventory {name: count}, never the input itself. */
function bestFuel (inventory, input) {
  for (const match of FUEL_ORDER) {
    const names = Object.keys(inventory).filter(n => n !== input && inventory[n] > 0 && match(n))
    if (names.length) return names.sort((a, b) => inventory[b] - inventory[a])[0]
  }
  return null
}

module.exports = { RECIPES, FURNACES, furnacesFor, inputsFor, fuelValue, bestFuel }
