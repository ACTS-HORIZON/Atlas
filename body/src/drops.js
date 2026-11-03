'use strict'
// What blocks drop, from minecraft-data's block loot tables (normal mining,
// no silk touch): block -> items, and the reverse, item -> source blocks.
// Used to turn "mine cobblestone" / "mine raw_iron" into a reason the mind
// can act on ("it drops from stone; use mine stone").

const cache = new WeakMap()

/** Variants that are rarely what a player means come last. */
const rank = name => (/^(infested|waxed|exposed|weathered|oxidized|chiseled|cracked|mossy|polished|smooth)_/.test(name) ? 2 : /^deepslate_|^cobbled_deepslate/.test(name) ? 1 : 0)

function tables (registry) {
  let t = cache.get(registry)
  if (t) return t
  const drops = new Map() // block -> [items]
  const sources = new Map() // item -> [blocks]
  for (const [block, loot] of Object.entries(registry.blockLoot || {})) {
    const items = [...new Set((loot.drops || []).filter(d => !d.silkTouch && d.item).map(d => d.item))]
    drops.set(block, items)
    for (const item of items) {
      if (!sources.has(item)) sources.set(item, [])
      sources.get(item).push(block)
    }
  }
  // best first: plain variants, then the game's own registry order (common
  // natural blocks such as stone, grass_block and dirt are registered first)
  // blocks with no hardness are things placed from items (redstone_wire,
  // tripwire), not where the item is found: they go after natural blocks
  const id = b => registry.blocksByName[b]?.id ?? 1e9
  const placed = b => (registry.blocksByName[b]?.hardness === 0 ? 1 : 0)
  for (const list of sources.values()) list.sort((a, b) => placed(a) - placed(b) || rank(a) - rank(b) || id(a) - id(b))
  t = { drops, sources }
  cache.set(registry, t)
  return t
}

/** Items a block drops when mined normally (no silk touch). */
function dropsOf (registry, block) {
  return tables(registry).drops.get(block) || []
}

/** Blocks that drop an item when mined, best first, excluding the item's own block. */
function sourcesOf (registry, item) {
  return (tables(registry).sources.get(item) || []).filter(b => b !== item)
}

/**
 * What an item is crafted from, or null. Recipes that only unpack a storage
 * block (raw_iron <- raw_iron_block, coal <- coal_block, iron_ingot <- nuggets)
 * don't count: their ingredient is itself crafted from the item.
 * Returns a short description of the ingredients, e.g. "planks of any kind",
 * "oak_log", "coal + stick".
 */
function craftedFrom (registry, item) {
  const def = registry.itemsByName[item]
  if (!def) return null
  const { Recipe } = require('prismarine-recipe')(registry)
  const name = id => registry.items[id]?.name
  const consumes = (ingredient, target) => Recipe.find(registry.itemsByName[ingredient].id, null)
    .some(r => r.delta.some(d => d.count < 0 && name(d.id) === target))
  const real = Recipe.find(def.id, null).filter(r => {
    const ins = [...new Set(r.delta.filter(d => d.count < 0).map(d => name(d.id)))]
    return ins.length && !(ins.length === 1 && consumes(ins[0], item))
  })
  if (!real.length) return null
  const firsts = [...new Set(real.map(r => r.delta.filter(d => d.count < 0).map(d => name(d.id))).map(ins => [...new Set(ins)].join(' + ')))]
  if (firsts.length === 1) return firsts[0]
  const single = firsts.every(f => !f.includes(' + '))
  if (single) {
    // group variants by their last word: oak_planks, birch_planks … -> "planks of any kind"
    const count = new Map()
    for (const f of firsts) { const t = f.split('_').at(-1); count.set(t, (count.get(t) || 0) + 1) }
    const [tail, n] = [...count.entries()].sort((a, b) => b[1] - a[1])[0]
    if (n >= 2) {
      const others = firsts.filter(f => f.split('_').at(-1) !== tail).slice(0, 2)
      return `${tail} of any kind${others.length ? `, or ${others.join(', ')}` : ''}`
    }
    return list(firsts.slice(0, 3))
  }
  return firsts[0]
}

const list = names => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`

/**
 * Why `mine <name>` can't target name, and what to mine instead, or null.
 * inView: whether any block of that name is in view (only matters for names
 * that are blocks too, like cobblestone).
 */
function mineHint (registry, name, { inView = false } = {}) {
  const isBlock = !!registry.blocksByName[name]
  const isItem = !!registry.itemsByName[name]
  const src = sourcesOf(registry, name).slice(0, 3)
  const crafted = (isItem && !inView) ? craftedFrom(registry, name) : null
  if (crafted) {
    const what = isBlock ? `${name} is crafted from ${crafted}` : `${name} is an item, not a block; it is crafted from ${crafted}, not mined`
    return `${what}. Use craft ${name}`
  }
  if (!isBlock && isItem) {
    if (!src.length) return `${name} is an item, not a block, and no block drops it (it is crafted, smelted or found)`
    return `${name} is an item, not a block; it drops from ${list(src)}. Use mine ${src[0]}`
  }
  if (isBlock && !inView && src.length) {
    const self = dropsOf(registry, name).includes(name) ? ` (also ${name} drops from ${name} blocks)` : ''
    return `${name} the item drops from ${list(src)}${self}. Use mine ${src[0]}`
  }
  return null
}

/** For collect: mining this block drops something else; collect that instead. Or null. */
function collectHint (registry, item) {
  if (!registry.blocksByName[item]) return null
  const d = dropsOf(registry, item)
  if (!d.length || d.includes(item)) return null
  return `mining ${item} drops ${list(d)}, not ${item}; collect ${d[0]}`
}

module.exports = { dropsOf, sourcesOf, craftedFrom, mineHint, collectHint }
