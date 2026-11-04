'use strict'
// Motor: the Mineflayer side of the verbs (walk, dig, look, pick up).
// Like view.js this is backend code; verbs never see it. They get the
// filtered API in api.js, which decides what may be targeted (fair play)
// and calls in here. Everything returned is plain data.
//
// Fair play for movement (CONTRACT.md): the pathfinder may plan over the
// loaded-chunk terrain geometry, as a player sees the ground as they walk.
// What a verb may *target* is checked in api.js, not here.
//
// House rules: protected regions are excluded from the pathfinder's digging
// and placing, and bot.dig / bot.placeBlock are guarded so nothing (verb or
// pathfinder) can dig or place inside one.
const { Vec3 } = require('vec3')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const r1 = v => Math.round(v * 10) / 10
const TIERS = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite']
const tier = name => TIERS.indexOf(String(name).split('_')[0])
const CARDINAL = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }

const SCAFFOLD = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff']
const SLOTS = new Set(['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'])
// Foods that hurt (hunger, poison, nausea): eaten only when named explicitly.
const HARMFUL_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit'])

/** Load the pathfinder plugin into a real Mineflayer bot (no-op on fakes). */
function equipBot (bot) {
  if (typeof bot.loadPlugin === 'function' && !bot.pathfinder) bot.loadPlugin(pathfinder)
}

/**
 * Wrap bot.dig and bot.placeBlock so neither can act inside a protected
 * region, whoever calls them. Idempotent.
 */
function guardHouseRules (bot, house) {
  if (!house || bot._atlasGuarded) return
  bot._atlasGuarded = true
  const dim = () => bot.game?.dimension
  if (typeof bot.dig === 'function') {
    const dig = bot.dig.bind(bot)
    bot.dig = (block, ...rest) => {
      const why = block?.position && house.check('dig', [block.position.x, block.position.y, block.position.z], dim())
      if (why) return Promise.reject(new Error(why))
      return dig(block, ...rest)
    }
  }
  if (typeof bot.placeBlock === 'function') {
    const place = bot.placeBlock.bind(bot)
    bot.placeBlock = (ref, face, ...rest) => {
      const p = ref?.position && face ? [ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z] : null
      const why = p && house.check('place', p, dim())
      if (why) return Promise.reject(new Error(why))
      return place(ref, face, ...rest)
    }
  }
}

class Motor {
  /** house: HouseRules (protected regions), optional */
  constructor (bot, { house = null } = {}) {
    this.bot = bot
    this.house = house
    guardHouseRules(bot, house)
  }

  /**
   * Pathfinder movement rules. dig: may break blocks in the way (tunnel);
   * scaffold: may place blocks to pillar up and bridge, from what's in the
   * inventory. Protected regions are excluded from both.
   */
  movements ({ dig = false, scaffold = false } = {}) {
    const bot = this.bot
    const m = new Movements(bot)
    m.canDig = !!dig
    m.allow1by1towers = !!scaffold
    m.scafoldingBlocks = scaffold ? SCAFFOLD.map(n => bot.registry.itemsByName[n]?.id).filter(id => id !== undefined) : []
    m.allowParkour = true
    m.allowSprinting = true
    m.dontCreateFlow = true
    m.dontMineUnderFallingBlock = true
    if (this.house && this.house.regions.length) {
      const inside = b => b && b.position && this.house.regionAt([b.position.x, b.position.y, b.position.z], bot.game?.dimension)
      m.exclusionAreasBreak.push(b => (inside(b) ? 100 : 0)) // >= 100: never broken
      m.exclusionAreasPlace.push(b => (inside(b) ? 1e9 : 0)) // never worth a path
    }
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
   * Resolves {status: reached|no_path|stuck|timeout|aborted, remaining, moved,
   * recoveries, tried, why?}.
   *
   * Stall recovery: if the bot hasn't moved for stallMs (and isn't digging),
   * one recovery cycle runs: jump; with dig, dig the head and feet blocks in
   * front (towards the target) and the block above, when the pathfinder's own
   * rules would break them; re-plan from where it stands. At most
   * maxRecoveries cycles per goto.
   * On stuck / no_path / timeout / no_progress, `why` says what is around
   * the bot and whether the pathfinder would dig it, plus its last plan (see
   * diagnose()).
   *
   * Not moving is measured by the bot's own position, whatever the
   * pathfinder says it is doing: a step is the feet entering another block,
   * or a block actually broken ('diggingCompleted'). Its "mining" state alone
   * is not progress (a dig that keeps failing, e.g. "Block not in view",
   * flips it on and off forever). Planning watchdog: no step within
   * planWatchMs (15 s) of the call or of the last step -> no_progress, with
   * `planner` {status, visited, ms, plan_end, nearest, nearest_dist}.
   *
   * Far goals (more than legAt = 48 blocks, kind near/xz): walked in legs of
   * legLength (16) blocks along the straight line, each leg its own plan
   * (GoalNearXZ, range 3), then the real goal for the last stretch. Through
   * solid stone with dig, the real planner times out (5 s, ~10k nodes) on a
   * 24+ block goal and returns a partial path; a 16-block leg plans in ~3 s.
   */
  async goto (opts) {
    const { kind = 'near', pos, legAt = 48, legLength = 16 } = opts
    const bot = this.bot
    if (!bot.pathfinder || kind === 'look') return this._leg(opts)
    const target = new Vec3(pos[0], pos[1], pos[2])
    const flat = () => Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z)
    const dist = () => kind === 'xz' ? flat() : bot.entity.position.distanceTo(target)
    if (dist() <= legAt) return this._leg(opts)
    const start = bot.entity.position.clone()
    const t0 = Date.now()
    const out = { recoveries: 0, tried: [], legs: 0 }
    const progress = () => { try { opts.onProgress?.(r1(dist())) } catch {} }
    while (dist() > legLength) { // legs all the way in, so the last plan is a short one too
      if (opts.signal?.aborted) return { status: 'aborted', remaining: r1(dist()), moved: r1(bot.entity.position.distanceTo(start)), ...out }
      const p = bot.entity.position
      const dy = target.y - p.y
      // mostly up or down (a shaft to the surface): 3D legs of legLength along the line;
      // else horizontal legs (GoalNearXZ), the terrain decides the height
      const vertical = kind !== 'xz' && Math.abs(dy) > flat()
      const f = Math.min(1, legLength / (vertical ? Math.abs(dy) : (flat() || 1)))
      const leg = [p.x + (target.x - p.x) * f, p.y + dy * f, p.z + (target.z - p.z) * f]
      const left = opts.timeoutMs !== undefined ? Math.max(1000, opts.timeoutMs - (Date.now() - t0)) : undefined
      const before = dist()
      const r = vertical
        ? await this._leg({ ...opts, kind: 'near', pos: leg, range: 2, timeoutMs: left, onProgress: progress })
        : await this._leg({ ...opts, kind: 'nearxz', pos: [leg[0], p.y, leg[2]], range: 3, timeoutMs: left, onProgress: progress })
      out.legs++
      out.recoveries += r.recoveries || 0
      out.tried.push(...(r.tried || []))
      if (r.status !== 'reached') {
        return { ...r, ...out, remaining: r1(dist()), moved: r1(bot.entity.position.distanceTo(start)), leg: out.legs }
      }
      if (dist() > before - 1) break // a leg that got no closer: plan the real goal from here
    }
    const left = opts.timeoutMs !== undefined ? Math.max(1000, opts.timeoutMs - (Date.now() - t0)) : undefined
    const r = await this._leg({ ...opts, timeoutMs: left })
    return { ...r, recoveries: out.recoveries + (r.recoveries || 0), tried: [...out.tried, ...(r.tried || [])], legs: out.legs + 1, moved: r1(bot.entity.position.distanceTo(start)) }
  }

  /** One planned walk to one goal (see goto); a held lane waits before it starts. */
  async _leg (o) {
    await this.waitHeld(o.lane, o.signal)
    return this._legRun(o)
  }

  _legRun ({ kind = 'near', pos, range = 1, dig = false, scaffold = false, signal, timeoutMs, stuckMs = 15000, stallMs = 3000, miningStallMs = 12000, planWatchMs = 15000, maxRecoveries = 3, onProgress, lane = null }) {
    const bot = this.bot
    if (!bot.pathfinder) return Promise.resolve({ status: 'no_path', remaining: null, moved: 0, recoveries: 0, tried: [], reason: 'pathfinder not loaded' })
    const target = new Vec3(pos[0], pos[1], pos[2])
    let goal
    if (kind === 'xz') goal = new goals.GoalXZ(Math.floor(pos[0]), Math.floor(pos[2]))
    else if (kind === 'nearxz') goal = new goals.GoalNearXZ(pos[0], pos[2], range)
    else if (kind === 'look') goal = new goals.GoalLookAtBlock(target.floored(), bot.world, { reach: 4.5 })
    else goal = new goals.GoalNear(pos[0], pos[1], pos[2], range)
    const centre = kind === 'look' ? target.floored().offset(0.5, 0.5, 0.5) : target
    const dist = () => kind === 'xz' || kind === 'nearxz'
      ? Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z)
      : bot.entity.position.distanceTo(centre)
    const start = bot.entity.position.clone()
    let t0 = Date.now()
    let heldSince = null
    const t0Shift = () => { if (heldSince) { t0 += Date.now() - heldSince; heldSince = null } }
    const limit = timeoutMs ?? 30000 + 1500 * dist()
    let best = dist(); let lastGain = Date.now()
    const movements = this.movements({ dig, scaffold })
    bot.pathfinder.setMovements(movements)
    let lastPlan = null
    let lastPos = bot.entity.position.clone(); let lastMove = Date.now()
    let lastCell = bot.entity.position.floored(); let lastStep = Date.now()
    let nearest = bot.entity.position.clone(); let nearestDist = dist()
    let recoveries = 0; let recovering = false
    const tried = []
    const onDug = () => { lastStep = Date.now(); lastMove = Date.now() } // a block really broken counts as a step
    return new Promise(resolve => {
      let finished = false
      const finish = status => {
        if (finished) return
        finished = true
        clearInterval(tick)
        bot.removeListener('goal_reached', onReached)
        bot.removeListener('path_update', onPath)
        bot.removeListener('diggingCompleted', onDug)
        signal?.removeEventListener('abort', onAbort)
        try { bot.pathfinder.setGoal(null) } catch {}
        bot.clearControlStates()
        const out = { status, remaining: r1(dist()), moved: r1(bot.entity.position.distanceTo(start)), recoveries, tried }
        if (status === 'stuck' || status === 'no_path' || status === 'timeout' || status === 'no_progress') {
          try { out.why = this.diagnose(movements, target, lastPlan, { dig, scaffold }) } catch {}
          out.planner = {
            status: lastPlan ? lastPlan.status : 'no plan yet',
            visited: lastPlan?.visited ?? null,
            ms: lastPlan?.ms ?? null,
            plan_end: lastPlan?.end ?? null,
            nearest: [nearest.x, nearest.y, nearest.z].map(r1),
            nearest_dist: r1(nearestDist)
          }
        }
        resolve(out)
      }
      const atEnd = () => goal.isEnd(bot.entity.position.floored())
      const onReached = () => { if (!this.held(lane)) finish('reached') } // (a watch sub-call's goto reaching its own goal is not ours)
      const onPath = r => {
        if (this.held(lane)) return // a watch sub-call's plan, not ours
        const end = r.path && r.path.length ? r.path[r.path.length - 1] : null
        lastPlan = { status: r.status, next: r.path && r.path[0] ? r.path[0] : null, visited: r.visitedNodes ?? null, ms: r.time != null ? Math.round(r.time) : null, end: end ? [end.x, end.y, end.z] : null }
        if (r.path.length === 0 && (r.status === 'noPath' || r.status === 'timeout')) {
          if (atEnd()) finish('reached')
          else if (recovering) { /* re-planning after a recovery: wait for it */ } else finish('no_path')
        }
      }
      const onAbort = () => finish('aborted')
      let held = false
      const tick = setInterval(() => {
        if (this.held(lane)) { // the player loop or a watch holds the verb: no goal, no clocks running
          if (!held) { held = true; heldSince = Date.now(); try { bot.pathfinder.setGoal(null) } catch {}; bot.clearControlStates() }
          const now = Date.now()
          lastMove = lastStep = lastGain = now
          return
        }
        if (held) { held = false; t0Shift(); try { bot.pathfinder.setMovements(movements); bot.pathfinder.setGoal(goal) } catch {} } // re-plan from wherever it is now
        const d = dist()
        try { onProgress?.(r1(d)) } catch {}
        const mining = bot.pathfinder.isMining()
        const now = Date.now()
        if (d < best - 0.5) { best = Math.min(best, d); lastGain = now }
        if (d < nearestDist) { nearestDist = d; nearest = bot.entity.position.clone() }
        if (bot.entity.position.distanceTo(lastPos) > 0.3) { lastPos = bot.entity.position.clone(); lastMove = now }
        const cell = bot.entity.position.floored()
        if (!cell.equals(lastCell)) { lastCell = cell; lastStep = now; lastGain = Math.max(lastGain, now - stuckMs / 2) }
        if (atEnd()) return finish('reached')
        if (now - t0 > limit) return finish('timeout')
        if (now - lastStep > planWatchMs) return finish('no_progress')
        if (!recovering && now - lastMove > (mining ? miningStallMs : stallMs)) {
          if (recoveries < maxRecoveries) {
            recovering = true
            recoveries++
            this.recover(goal, movements, target, dig, signal)
              .then(steps => { tried.push(steps) })
              .catch(err => { tried.push(`recovery failed: ${err.message}`) })
              .finally(() => { recovering = false; lastMove = Date.now(); lastGain = Math.max(lastGain, Date.now() - stuckMs / 2) })
            return
          }
        }
        if (!recovering && Date.now() - lastGain > stuckMs) finish('stuck')
      }, Math.min(500, Math.max(50, stallMs / 3)))
      bot.on('goal_reached', onReached)
      bot.on('path_update', onPath)
      bot.on('diggingCompleted', onDug)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) return finish('aborted')
      if (atEnd()) return finish('reached')
      bot.pathfinder.setGoal(goal)
    })
  }

  /** The cells the bot would move through first, towards target: [head front, feet front, above head]. */
  frontCells (target) {
    const p = this.bot.entity.position
    const feet = p.floored()
    const dx = target.x - p.x; const dz = target.z - p.z
    const dir = Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx) || 1, 0, 0) : new Vec3(0, 0, Math.sign(dz) || 1)
    return [feet.plus(dir).offset(0, 1, 0), feet.plus(dir), feet.offset(0, 2, 0)]
  }

  /** One recovery cycle: jump, dig what's in the way (if dig), re-plan. Returns what it did. */
  async recover (goal, movements, target, dig, signal) {
    const bot = this.bot
    const done = []
    bot.setControlState('jump', true)
    await new Promise(resolve => setTimeout(resolve, 350))
    bot.setControlState('jump', false)
    done.push('jump')
    if (dig) {
      for (const p of this.frontCells(target)) {
        if (signal?.aborted) break
        const b = bot.blockAt(p)
        if (!b || b.boundingBox !== 'block') continue
        if (!movements.safeToBreak(b)) { done.push(`left ${b.name} (the pathfinder won't break it)`); continue }
        const r = await this.dig([p.x, p.y, p.z], { allowHand: true, signal })
        done.push(r.ok ? `dug ${b.name}` : `couldn't dig ${b.name}: ${r.reason}`)
      }
    }
    try { bot.pathfinder.setGoal(null); bot.pathfinder.setGoal(goal) } catch {}
    done.push('re-planned')
    return done.join(', ')
  }

  /**
   * Why goto is stuck: the blocks at the bot's feet, head, below, in front
   * (towards the target) and above, whether the pathfinder would break each
   * (dig on and its movement rules allow it), and its last plan.
   * Plain data plus a one-line `text`.
   */
  diagnose (movements, target, lastPlan, { dig, scaffold }) {
    const bot = this.bot
    const feet = bot.entity.position.floored()
    const [frontHead, frontFeet, above] = this.frontCells(target)
    const describe = p => {
      const b = bot.blockAt(p)
      if (!b) return { pos: [p.x, p.y, p.z], name: 'unloaded' }
      const solid = b.boundingBox === 'block'
      const out = { pos: [p.x, p.y, p.z], name: b.name, solid }
      if (solid) out.breakable = dig ? !!movements.safeToBreak(b) : false
      return out
    }
    const cells = { feet: describe(feet), head: describe(feet.offset(0, 1, 0)), below: describe(feet.offset(0, -1, 0)), front_feet: describe(frontFeet), front_head: describe(frontHead), above: describe(above) }
    const next = lastPlan && lastPlan.next
      ? { pos: [lastPlan.next.x, lastPlan.next.y, lastPlan.next.z], break: (lastPlan.next.toBreak || []).map(q => bot.blockAt(q)?.name || '?'), place: (lastPlan.next.toPlace || []).length }
      : null
    const label = c => !c.solid ? c.name : `${c.name} (${c.breakable ? 'would dig' : dig ? "won't dig" : 'dig off'})`
    const blocking = [cells.front_feet, cells.front_head].filter(c => c.solid)
    const text = [
      `feet ${cells.feet.name}, head ${cells.head.name}, below ${cells.below.name}`,
      blocking.length ? `in front: ${blocking.map(c => `${label(c)} at [${c.pos.join(', ')}]`).join(', ')}` : 'nothing solid in front',
      `dig ${dig ? 'on' : 'off'}, scaffold ${scaffold ? 'on' : 'off'}`,
      lastPlan ? `last plan: ${lastPlan.status}${next ? `, next step [${next.pos.join(', ')}]${next.break.length ? ` breaking ${next.break.join('+')}` : ''}${next.place ? ` placing ${next.place}` : ''}` : ', no next step'}` : 'no plan yet'
    ].join('; ')
    return { ...cells, dig: !!dig, scaffold: !!scaffold, plan: lastPlan ? lastPlan.status : null, next_step: next, text }
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
  async dig (pos, { signal, allowHand = false, lane = null } = {}) {
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
    await this.waitHeld(lane, signal) // held by the player loop, or by a watch while its sub-call runs
    if (signal?.aborted) return { ok: false, reason: 'aborted' }
    if (!bot.canDigBlock(block)) return { ok: false, reason: 'out of reach' }
    const onAbort = () => { try { bot.stopDigging() } catch {} }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      try {
        await bot.dig(block, true, 'raycast')
      } catch (err) {
        // Mineflayer's raycast found no face it can see (bot off-centre, or a
        // corner in the way). The server only checks reach: dig the face that
        // points at the eye instead.
        if (!/not in view/i.test(err.message) || signal?.aborted) throw err
        const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
        const d = eye.minus(block.position.offset(0.5, 0.5, 0.5))
        const ax = Math.abs(d.x) >= Math.abs(d.y) && Math.abs(d.x) >= Math.abs(d.z) ? 'x' : Math.abs(d.y) >= Math.abs(d.z) ? 'y' : 'z'
        const face = new Vec3(ax === 'x' ? Math.sign(d.x) : 0, ax === 'y' ? Math.sign(d.y) : 0, ax === 'z' ? Math.sign(d.z) : 0)
        await bot.dig(block, true, face)
      }
      return { ok: true, name: block.name }
    } catch (err) {
      return { ok: false, reason: signal?.aborted ? 'aborted' : err.message }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  // ---- the player loop's primitives: control presses, not pathfinder calls ----
  /**
   * step / sprint: face dir and hold forward (and sprint) until the bot has moved one block (two
   * sprinting) or maxMs (300) has passed, then let go by itself. Resolves as soon as the movement is
   * observed (or startMs passes without any): {ok, moving}; `this.pressing.done` resolves when the press
   * ends, with {moved, ms}. A new press, or release(), ends the running one first.
   */
  async press (dir, { sprint = false, maxMs = 300, startMs = 100 } = {}) {
    const bot = this.bot
    this.release()
    if (dir) await this.face(dir)
    const p0 = bot.entity.position.clone ? bot.entity.position.clone() : { ...bot.entity.position }
    const t0 = Date.now()
    const blocks = sprint ? 2 : 1
    const dist = () => { const p = bot.entity.position; return Math.hypot(p.x - p0.x, p.z - p0.z) }
    let started = null
    const start = new Promise(resolve => { started = resolve })
    const token = {}
    this.pressing = token
    bot.setControlState('sprint', !!sprint)
    bot.setControlState('forward', true)
    token.done = (async () => {
      let moving = false
      while (this.pressing === token && Date.now() - t0 < maxMs) {
        await new Promise(resolve => setTimeout(resolve, 10))
        const d = dist()
        if (!moving && d >= 0.02) { moving = true; started({ ok: true, moving: true }) }
        if (!moving && Date.now() - t0 >= startMs) started({ ok: true, moving: false })
        if (d >= blocks - 0.02) break
      }
      if (this.pressing === token) this.release()
      started({ ok: true, moving }) // (no-op when already resolved)
      return { moved: Math.round(dist() * 100) / 100, ms: Date.now() - t0 }
    })()
    return start
  }

  /** Let go of a running step/sprint press. */
  release () {
    if (!this.pressing) return
    this.pressing = null
    this.bot.setControlState('forward', false)
    this.bot.setControlState('sprint', false)
  }

  /** One jump press: hold jump until the bot leaves the ground (or 150 ms), then let go. */
  async jump () {
    const bot = this.bot
    bot.setControlState('jump', true)
    const t0 = Date.now()
    while (bot.entity.onGround !== false && Date.now() - t0 < 150) await new Promise(resolve => setTimeout(resolve, 10))
    bot.setControlState('jump', false)
    return { ok: true, airborne: bot.entity.onGround === false }
  }

  /** Jump and place item under the feet (where the bot stood). */
  async pillar (item) {
    const bot = this.bot
    const it = bot.inventory.items().find(i => i.name === item)
    if (!it) return { ok: false, reason: `no ${item} in inventory` }
    const feet = bot.entity.position.floored()
    const ref = bot.blockAt(feet.offset(0, -1, 0))
    if (!ref || ref.boundingBox !== 'block') return { ok: false, reason: 'nothing solid below to place on' }
    try {
      await bot.equip(it, 'hand')
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      bot.setControlState('jump', true)
      const t0 = Date.now()
      while (bot.entity.position.y < feet.y + 1 && Date.now() - t0 < 600) await new Promise(resolve => setTimeout(resolve, 20))
      await bot.placeBlock(ref, new Vec3(0, 1, 0))
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: err.message }
    } finally {
      bot.setControlState('jump', false)
    }
  }

  /** Hit the entity of this type nearest to pos (the obs reports type and position, not ids). */
  async attack (type, pos) {
    const bot = this.bot
    const at = new Vec3(pos[0], pos[1], pos[2])
    const e = Object.values(bot.entities).filter(x => x !== bot.entity && x.position && (x.name === type || x.type === type) && x.position.distanceTo(at) < 2.5)
      .sort((a, b) => a.position.distanceTo(at) - b.position.distanceTo(at))[0]
    if (!e) return { ok: false, reason: `no ${type} there any more` }
    try {
      await bot.lookAt(e.position.offset(0, (e.height || 1.8) * 0.8, 0), true)
      bot.attack(e)
      return { ok: true }
    } catch (err) { return { ok: false, reason: err.message } }
  }

  async shield () {
    try {
      this.bot.activateItem(true)
      await new Promise(resolve => setTimeout(resolve, 500))
      this.bot.deactivateItem()
      return { ok: true }
    } catch (err) { return { ok: false, reason: err.message } }
  }

  /** The override (src/player): goto and dig hold still while paused, and carry on when resumed. */
  /** Is the bot doing anything (walking a path, digging, building, holding a control)? For the imitation recorder's "idle". */
  active () {
    const bot = this.bot; const pf = bot.pathfinder
    const call = f => { try { return !!(pf && typeof pf[f] === 'function' && pf[f]()) } catch { return false } }
    if (bot.targetDigBlock || call('isMoving') || call('isMining') || call('isBuilding')) return true
    const cs = bot.controlState || {}
    return ['forward', 'back', 'left', 'right', 'jump', 'sprint'].some(c => cs[c])
  }

  pause () { this.paused = true }
  resume () { this.paused = false }

  /**
   * Holds. `paused` (the player loop's override) holds every goto and dig. `watchHold` holds only the
   * running verb's own ("main" lane) goto and dig while a watch's sub-call runs on the "watch" lane.
   */
  held (lane = null) { return !!this.paused || (!!this.watchHold && lane !== 'watch') }
  async waitHeld (lane, signal) { while (this.held(lane) && !signal?.aborted) await new Promise(resolve => setTimeout(resolve, 50)) }

  /** A watch fired: hold the running verb (its goto lets go of the goal, a dig in progress finishes, ≤5 s). */
  async holdMain () {
    this.watchHold = true
    const bot = this.bot
    await new Promise(resolve => setTimeout(resolve, 250)) // a running goto's tick sees the hold
    const t0 = Date.now()
    while (bot.targetDigBlock && Date.now() - t0 < 5000) await new Promise(resolve => setTimeout(resolve, 50))
    if (bot.targetDigBlock) { try { bot.stopDigging() } catch {} }
    try { bot.pathfinder?.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
  }

  /** The sub-call is over: let the running verb carry on (its goto re-plans from where the bot is now). */
  releaseMain () { this.watchHold = false }

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

  dimension () { return this.bot.game?.dimension }
  food () { return this.bot.food }

  // ---- crafting ----------------------------------------------------------

  /**
   * What crafting `count` of an item would take, from the inventory alone:
   * {known, options: [{requiresTable, yields, times, missing: {name: n}}]}
   * with the cheapest option first (fewest missing, then no table).
   */
  craftPlan (item, count = 1) {
    const bot = this.bot
    const reg = bot.registry
    const def = reg.itemsByName[item]
    if (!def) return { known: false, options: [] }
    const recipes = bot.recipesAll(def.id, null, true)
    const inv = this.inventory()
    const options = recipes.map(r => {
      const times = Math.ceil(count / r.result.count)
      const missing = {}
      const uses = {}
      for (const d of r.delta) {
        if (d.count >= 0) continue
        const name = reg.items[d.id]?.name
        uses[name] = (uses[name] || 0) - d.count * times
        const need = -d.count * times - (inv[name] || 0)
        if (need > 0) missing[name] = need
      }
      return { requiresTable: !!r.requiresTable, yields: r.result.count, times, missing, uses }
    })
    const total = o => Object.values(o.missing).reduce((a, b) => a + b, 0)
    options.sort((a, b) => total(a) - total(b) || a.requiresTable - b.requiresTable)
    return { known: true, options }
  }

  /** Craft with what's in the inventory, at a crafting table at tablePos if given. */
  /**
   * Craft with what's in the inventory, at a crafting table at tablePos if
   * given. The count crafted is the inventory delta of the item once the
   * window has settled (the result slot often lands after bot.craft
   * resolves): polled every 100 ms for up to settleMs; failed only if nothing
   * arrived by then. {ok, crafted, reason?}
   */
  async craft (item, count, tablePos, { settleMs = 1500 } = {}) {
    const bot = this.bot
    const def = bot.registry.itemsByName[item]
    let table = null
    if (tablePos) {
      table = bot.blockAt(new Vec3(tablePos[0], tablePos[1], tablePos[2]))
      if (!table || table.name !== 'crafting_table') return { ok: false, reason: `no crafting_table at [${tablePos.join(', ')}] any more` }
    }
    const recipes = bot.recipesFor(def.id, null, count, table)
    const recipe = recipes.find(r => !r.requiresTable) || recipes[0]
    if (!recipe) return { ok: false, reason: 'ingredients no longer in the inventory' }
    const before = this.inventory()[item] || 0
    const want = Math.ceil(count / recipe.result.count) * recipe.result.count
    let error = null
    try {
      await bot.craft(recipe, Math.ceil(count / recipe.result.count), recipe.requiresTable ? table : null)
    } catch (err) {
      error = err.message // the items may still arrive: the delta decides
    }
    const delta = () => (this.inventory()[item] || 0) - before
    const until = Date.now() + settleMs
    let last = delta()
    while (Date.now() < until && last < want) {
      await new Promise(resolve => setTimeout(resolve, 100))
      last = delta()
    }
    if (last > 0) return { ok: true, crafted: last }
    return { ok: false, crafted: 0, reason: error || `nothing came out: no ${item} arrived in the inventory` }
  }

  // ---- placing, equipping, eating ----------------------------------------

  /** Place an inventory block against the face of refPos pointing at pos. */
  async place (item, refPos, pos) {
    const bot = this.bot
    const it = bot.inventory.items().find(i => i.name === item)
    if (!it) return { ok: false, reason: `no ${item} in inventory` }
    const ref = bot.blockAt(new Vec3(refPos[0], refPos[1], refPos[2]))
    if (!ref) return { ok: false, reason: 'not loaded' }
    try {
      await bot.equip(it, 'hand')
      await bot.placeBlock(ref, new Vec3(pos[0] - refPos[0], pos[1] - refPos[1], pos[2] - refPos[2]))
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: err.message }
    }
  }

  async equip (item, slot = 'hand') {
    if (!SLOTS.has(slot)) return { ok: false, reason: `unknown slot ${slot}; one of ${[...SLOTS].join(', ')}` }
    const it = this.bot.inventory.items().find(i => i.name === item)
    if (!it) return { ok: false, reason: `no ${item} in inventory` }
    try {
      await this.bot.equip(it, slot)
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: err.message }
    }
  }

  /** Edible items in the inventory, best first; harmful ones last and flagged. */
  foods () {
    const reg = this.bot.registry
    const inv = this.inventory()
    return Object.keys(inv)
      .filter(n => reg.foodsByName?.[n])
      .map(n => ({ name: n, count: inv[n], points: reg.foodsByName[n].foodPoints, quality: reg.foodsByName[n].effectiveQuality, harmful: HARMFUL_FOOD.has(n) }))
      .sort((a, b) => a.harmful - b.harmful || b.quality - a.quality)
  }

  isFood (name) { return !!this.bot.registry.foodsByName?.[name] }

  // ---- giving and containers ---------------------------------------------

  /** Look at a point and toss up to count of an item there. {ok, tossed} */
  async toss (item, count, at) {
    const bot = this.bot
    const def = bot.registry.itemsByName[item]
    const have = this.inventory()[item] || 0
    const n = Math.min(count, have)
    if (!def || n <= 0) return { ok: false, tossed: 0, reason: `no ${item} in inventory` }
    try {
      if (at) await bot.lookAt(new Vec3(at[0], at[1], at[2]), true)
      await bot.toss(def.id, null, n)
    } catch (err) {
      return { ok: false, tossed: have - (this.inventory()[item] || 0), reason: err.message }
    }
    return { ok: true, tossed: have - (this.inventory()[item] || 0) }
  }

  async _withContainer (pos, fn) {
    const bot = this.bot
    const block = bot.blockAt(new Vec3(pos[0], pos[1], pos[2]))
    if (!block) return { ok: false, reason: 'not loaded' }
    let c
    try { c = await bot.openContainer(block) } catch (err) { return { ok: false, reason: `could not open the ${block.name}: ${err.message}` } }
    try { return await fn(c) } finally { try { c.close() } catch {} }
  }

  /** Put up to count (default: all) of an item into the container at pos. {ok, moved, reason?} */
  deposit (pos, item, count) {
    const def = this.bot.registry.itemsByName[item]
    return this._withContainer(pos, async c => {
      const before = this.inventory()[item] || 0
      const n = Math.min(count ?? before, before)
      if (n <= 0) return { ok: false, moved: 0, reason: `no ${item} in inventory` }
      let reason = null
      try { await c.deposit(def.id, null, n) } catch (err) { reason = /full|space|destination/i.test(err.message) ? 'the chest is full' : err.message }
      const moved = before - (this.inventory()[item] || 0)
      return { ok: moved > 0, moved, reason }
    })
  }

  /** Take up to count of an item from the container at pos. {ok, moved, available, reason?} */
  withdraw (pos, item, count) {
    const def = this.bot.registry.itemsByName[item]
    return this._withContainer(pos, async c => {
      const available = c.containerItems().filter(i => i.name === item).reduce((a, i) => a + i.count, 0)
      if (!available) return { ok: false, moved: 0, available, reason: `no ${item} in the chest` }
      const before = this.inventory()[item] || 0
      let reason = null
      try { await c.withdraw(def.id, null, Math.min(count, available)) } catch (err) { reason = /full|space/i.test(err.message) ? 'the inventory is full' : err.message }
      const moved = (this.inventory()[item] || 0) - before
      return { ok: moved > 0, moved, available, reason }
    })
  }

  /**
   * Smelt in the furnace at pos (within reach): put fuelCount fuel and count
   * input in, take the output as it comes, then take back whatever input and
   * fuel are left. The furnace must not hold someone else's items.
   * {ok, smelted, reason?}
   */
  async smelt (pos, { input, output, count, fuel, fuelCount, signal, onProgress, pollMs = 500, stallMs = 25000 }) {
    const bot = this.bot
    const block = bot.blockAt(new Vec3(pos[0], pos[1], pos[2]))
    if (!block) return { ok: false, smelted: 0, reason: 'not loaded' }
    const id = n => bot.registry.itemsByName[n].id
    let f
    try { f = await bot.openFurnace(block) } catch (err) { return { ok: false, smelted: 0, reason: `could not open the ${block.name}: ${err.message}` } }
    let smelted = 0; let reason = null
    const take = async () => {
      const o = f.outputItem()
      if (!o || !o.count) return
      try { await f.takeOutput(); smelted += o.count; onProgress && onProgress(smelted) } catch (err) { reason = /full|space/i.test(err.message) ? 'the inventory is full' : err.message }
    }
    try {
      for (const [slot, it, want] of [['input', f.inputItem(), input], ['fuel', f.fuelItem(), fuel], ['output', f.outputItem(), null]]) {
        if (it && it.count && it.name !== want) return { ok: false, smelted: 0, reason: `the ${block.name} is in use: its ${slot} slot holds ${it.count} ${it.name}` }
      }
      try {
        await f.putFuel(id(fuel), null, fuelCount)
        await f.putInput(id(input), null, count)
      } catch (err) { reason = err.message }
      let last = Date.now()
      while (!reason && smelted < count && !signal?.aborted) {
        await new Promise(resolve => setTimeout(resolve, pollMs))
        const before = smelted
        await take()
        if (smelted > before) last = Date.now()
        else if (Date.now() - last > stallMs) reason = `the ${block.name} stopped: nothing came out for ${Math.round(stallMs / 1000)} s`
      }
      await take()
      for (const [slot, get, back] of [['input', () => f.inputItem(), () => f.takeInput()], ['fuel', () => f.fuelItem(), () => f.takeFuel()]]) {
        if (get()?.count) { try { await back() } catch (err) { reason = reason || `could not take back the ${slot}: ${err.message}` } }
      }
      return { ok: smelted > 0, smelted, reason }
    } finally { try { f.close() } catch {} }
  }

  async eat (item) {
    const bot = this.bot
    const it = bot.inventory.items().find(i => i.name === item)
    if (!it) return { ok: false, reason: `no ${item} in inventory` }
    try {
      await bot.equip(it, 'hand')
      await bot.consume()
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: err.message }
    }
  }
}

module.exports = { Motor, equipBot, guardHouseRules, CARDINAL, SLOTS }
