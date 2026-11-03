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
  const id = b => registry.blocksByName[b]?.id ?? 1e9
  for (const list of sources.values()) list.sort((a, b) => rank(a) - rank(b) || id(a) - id(b))
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

module.exports = { dropsOf, sourcesOf, mineHint, collectHint }
