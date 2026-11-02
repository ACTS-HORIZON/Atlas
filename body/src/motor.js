'use strict'
// Motor: the Mineflayer side of the verbs (walk, dig, look, pick up).
// Like view.js this is backend code; verbs never see it. They get the
// filtered API in api.js, which decides what may be targeted (fair play)
// and calls in here. Everything returned is plain data.
//
// Fair play for movement (session 2 rule): the pathfinder may plan over the
// loaded-chunk terrain geometry, as a player sees the ground as they walk.
// What a verb may *target* is checked in api.js, not here.
const { Vec3 } = require('vec3')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const r1 = v => Math.round(v * 10) / 10
const TIERS = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite']
const tier = name => TIERS.indexOf(String(name).split('_')[0])
const CARDINAL = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }

/** Load the pathfinder plugin into a real Mineflayer bot (no-op on fakes). */
function equipBot (bot) {
  if (typeof bot.loadPlugin === 'function' && !bot.pathfinder) bot.loadPlugin(pathfinder)
}

class Motor {
  constructor (bot) {
    this.bot = bot
  }

  /** Pathfinder movement rules. No block placing, no pillaring; digging only when asked. */
  movements (dig) {
    const m = new Movements(this.bot)
    m.canDig = !!dig
    m.allow1by1towers = false
    m.scafoldingBlocks = []
    m.allowParkour = true
    m.allowSprinting = true
    m.dontCreateFlow = true
    m.dontMineUnderFallingBlock = true
    return m
  }

  here () {
    const p = this.bot.entity.position
    return [p.x, p.y, p.z]
  }

  gamemode () { return this.bot.game.gameMode }

  /** Cardinal direction the bot faces (yaw 0 = north in Mineflayer). */
  facing () {
    const y = ((this.bot.entity.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    return ['north', 'west', 'south', 'east'][Math.round(y / (Math.PI / 2)) % 4]
  }

  /**
   * Walk to a goal. kind: 'near' (pos, range), 'xz' (pos x/z only),
   * 'look' (stand where a face of block pos is in reach and view).
   * Resolves {status: reached|no_path|stuck|timeout|aborted, remaining, moved}.
   */
  goto ({ kind = 'near', pos, range = 1, dig = false, signal, timeoutMs, stuckMs = 15000, onProgress }) {
    const bot = this.bot
    if (!bot.pathfinder) return Promise.resolve({ status: 'no_path', remaining: null, moved: 0, reason: 'pathfinder not loaded' })
    const target = new Vec3(pos[0], pos[1], pos[2])
    let goal
    if (kind === 'xz') goal = new goals.GoalXZ(Math.floor(pos[0]), Math.floor(pos[2]))
    else if (kind === 'look') goal = new goals.GoalLookAtBlock(target.floored(), bot.world, { reach: 4.5 })
    else goal = new goals.GoalNear(pos[0], pos[1], pos[2], range)
    const centre = kind === 'look' ? target.floored().offset(0.5, 0.5, 0.5) : target
    const dist = () => kind === 'xz'
      ? Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z)
      : bot.entity.position.distanceTo(centre)
    const start = bot.entity.position.clone()
    const t0 = Date.now()
    const limit = timeoutMs ?? 30000 + 1500 * dist()
    let best = dist(); let lastGain = Date.now()
    bot.pathfinder.setMovements(this.movements(dig))
    return new Promise(resolve => {
      let finished = false
      const finish = status => {
        if (finished) return
        finished = true
        clearInterval(tick)
        bot.removeListener('goal_reached', onReached)
        bot.removeListener('path_update', onPath)
        signal?.removeEventListener('abort', onAbort)
        try { bot.pathfinder.setGoal(null) } catch {}
        bot.clearControlStates()
        resolve({ status, remaining: r1(dist()), moved: r1(bot.entity.position.distanceTo(start)) })
      }
      const atEnd = () => goal.isEnd(bot.entity.position.floored())
      const onReached = () => finish('reached')
      const onPath = r => {
        if (r.path.length === 0 && (r.status === 'noPath' || r.status === 'timeout')) finish(atEnd() ? 'reached' : 'no_path')
      }
      const onAbort = () => finish('aborted')
      const tick = setInterval(() => {
        const d = dist()
        try { onProgress?.(r1(d)) } catch {}
        if (d < best - 0.5 || bot.pathfinder.isMining()) { best = Math.min(best, d); lastGain = Date.now() }
        if (atEnd()) finish('reached')
        else if (Date.now() - lastGain > stuckMs) finish('stuck')
        else if (Date.now() - t0 > limit) finish('timeout')
      }, 500)
      bot.on('goal_reached', onReached)
      bot.on('path_update', onPath)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) return finish('aborted')
      if (atEnd()) return finish('reached')
      bot.pathfinder.setGoal(goal)
    })
  }

  /** Stop everything: path, digging, controls. */
  stop () {
    const bot = this.bot
    try { bot.pathfinder?.setGoal(null) } catch {}
    try { bot.stopDigging?.() } catch {}
    try { bot.clearControlStates() } catch {}
  }

  /** Name of the block at pos (for blocks the API already allows the verb to read). */
  blockName (pos) {
    const b = this.bot.blockAt(new Vec3(pos[0], pos[1], pos[2]))
    return b ? b.name : null
  }

  /** Inventory counts by item name. */
  inventory () {
    const out = {}
    for (const it of this.bot.inventory.items()) out[it.name] = (out[it.name] || 0) + it.count
    return out
  }

  /**
   * Best tool in the inventory for digging a block type: {ok, tool, digMs}.
   * A block with harvest tools (stone, ores) drops nothing without one: then
   * ok=false with a reason, unless allowHand (tunnelling through stone by
   * hand is slow but possible). In creative any tool, or the hand, will do.
   */
  toolFor (blockName, { allowHand = false } = {}) {
    const bot = this.bot
    const reg = bot.registry
    const def = reg.blocksByName[blockName]
    if (!def) return { ok: false, tool: null, reason: `unknown block ${blockName}` }
    if (def.diggable === false) return { ok: false, tool: null, reason: `${blockName} cannot be dug` }
    const creative = bot.game.gameMode === 'creative'
    const Block = require('prismarine-block')(reg)
    const block = Block.fromStateId(def.defaultState, 0)
    const time = type => block.digTime(type, creative, false, false, [], {})
    const needsTool = !!def.harvestTools && !creative
    let best = null
    let bestTime = needsTool && !allowHand ? Infinity : time(null)
    for (const it of bot.inventory.items()) {
      if (needsTool && !def.harvestTools[it.type]) continue
      const t = time(it.type)
      // ties (prismarine-block's 26.1 dig times rate some ores the same for
      // every pickaxe that can harvest them) go to the higher tier
      if (t < bestTime || (t === bestTime && best !== null && tier(it.name) > tier(best.name)) || (needsTool && best === null && !allowHand)) { best = it; bestTime = t }
    }
    if (bestTime === Infinity) {
      const need = Object.keys(def.harvestTools).map(id => reg.items[id]?.name).filter(Boolean)
      return { ok: false, tool: null, needsTool: true, reason: `${blockName} needs one of: ${need.join(', ')}; none in inventory` }
    }
    return { ok: true, tool: best ? best.name : null, digMs: Math.round(bestTime) }
  }

  /**
   * Dig the block at pos with the best tool. The bot must be in reach.
   * {ok, reason?, name}
   */
  async dig (pos, { signal, allowHand = false } = {}) {
    const bot = this.bot
    const block = bot.blockAt(new Vec3(pos[0], pos[1], pos[2]))
    if (!block) return { ok: false, reason: 'not loaded' }
    if (['air', 'cave_air', 'void_air'].includes(block.name)) return { ok: true, name: block.name, already: true }
    const tool = this.toolFor(block.name, { allowHand })
    if (!tool.ok) return { ok: false, reason: tool.reason, needsTool: true }
    if (tool.tool) {
      const item = bot.inventory.items().find(i => i.name === tool.tool)
      if (item && bot.heldItem?.name !== item.name) await bot.equip(item, 'hand')
    }
    if (signal?.aborted) return { ok: false, reason: 'aborted' }
    if (!bot.canDigBlock(block)) return { ok: false, reason: 'out of reach' }
    const onAbort = () => { try { bot.stopDigging() } catch {} }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await bot.dig(block, true, 'raycast')
      return { ok: true, name: block.name }
    } catch (err) {
      return { ok: false, reason: signal?.aborted ? 'aborted' : err.message }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Turn the head to a yaw (radians, Mineflayer) and pitch. */
  async look (yaw, pitch = 0) {
    await this.bot.look(yaw, pitch, true)
  }

  /** Face a cardinal direction. */
  async face (dir) {
    const yaw = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 }[dir]
    if (yaw !== undefined) await this.look(yaw, 0)
  }

  /** Dropped item entities, raw (api.js filters them by line of sight). */
  drops () {
    const out = []
    for (const e of Object.values(this.bot.entities)) {
      if (e.name !== 'item' || !e.position) continue
      let item = null
      try { item = e.getDroppedItem?.()?.name ?? null } catch {}
      if (!item) continue
      out.push({ id: e.id, item, pos: [e.position.x, e.position.y, e.position.z], height: e.height || 0.25 })
    }
    return out
  }

  entityExists (id) { return !!this.bot.entities[id] }
}

module.exports = { Motor, equipBot, CARDINAL }
