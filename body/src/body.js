'use strict'
// The body process: Mineflayer bot + fair-play observation + link.
const mineflayer = require('mineflayer')
const { Link, V } = require('./link')
const { JsonlLog } = require('./jsonl')
const { MineflayerView } = require('./view')
const { buildObs, recheckKnown } = require('./fairplay/observe')
const { KnownPlaces } = require('./places')
const { MotionTracker, SoundMemory } = require('./fairplay/perception')
const { runVerb } = require('./verbs')
const { BuildStats } = require('./stats')

class Body {
  constructor (cfg) {
    this.cfg = cfg
    this.log = new JsonlLog(cfg.logDir)
    this.bot = null
    this.spawned = false
    this.dead = false
    this.chat = []
    this.bossBars = new Map()
    this.motion = new MotionTracker()
    this.sounds = new SoundMemory()
    this.stats = new BuildStats()
    this.places = new KnownPlaces({ file: cfg.placesFile }).load()
    this.backoff = 5000
    this.timers = []
    this.link = new Link({
      host: cfg.link.host,
      port: cfg.link.port,
      log: this.log,
      handlers: {
        buildObs: () => this.obs(),
        onCall: call => this.onCall(call),
        onClient: n => console.log(`[link] ${n} mind client(s) connected`)
      }
    })
  }

  async start () {
    await this.link.ready
    console.log(`[link] listening on ws://${this.cfg.link.host}:${this.cfg.link.port}`)
    console.log(`[log] ${this.cfg.logDir}`)
    console.log(`[places] ${this.places.size} known places from ${this.cfg.placesFile}`)
    this.connect()
    this.timers.push(setInterval(() => {
      if (this.spawned && this.link.count) { const o = this.obs(); if (o) this.link.broadcast(o) }
    }, this.cfg.obsIntervalMs))
    this.timers.push(setInterval(() => this.stats.report(), 60000))
  }

  connect () {
    const { host, port, username, version } = this.cfg.mc
    console.log(`[bot] connecting to ${host}:${port} as ${username} (offline auth)`)
    const bot = mineflayer.createBot({
      host,
      port,
      username,
      auth: 'offline',
      version: version || false,
      viewDistance: Math.max(2, Math.ceil(this.cfg.sightRadius / 16)),
      respawn: true,
      hideErrors: true // we log errors ourselves
    })
    this.bot = bot
    this.view = new MineflayerView(bot, { sightRadius: this.cfg.sightRadius })
    let joinGraceUntil = Infinity
    let motionTimer = null

    bot.once('spawn', () => {
      console.log(`[bot] spawned in ${bot.game.dimension} at ${bot.entity.position.floored()} gamemode=${bot.game.gameMode} version=${bot.version}`)
      this.backoff = 5000
      joinGraceUntil = Date.now() + 3000 // the initial tab list is not "joining"
      motionTimer = setInterval(() => this.sampleMotion(), 250)
      this.spawned = true
      const o = this.obs()
      if (o) this.link.broadcast(o)
    })
    bot.on('spawn', () => {
      if (this.dead) {
        this.dead = false
        this.event('respawned', { pos: posOf(bot) })
      }
    })
    bot.on('death', () => {
      this.dead = true
      this.event('died', { pos: posOf(bot) })
    })
    bot.on('playerJoined', p => {
      if (p.username === bot.username || Date.now() < joinGraceUntil) return
      this.event('player_joined', { name: p.username })
    })
    bot.on('playerLeft', p => {
      if (p.username === bot.username) return
      this.event('player_left', { name: p.username })
    })
    bot.on('chat', (from, text) => {
      if (from === bot.username) return
      this.chat.push({ from, text, t: Number(bot.time.age) || 0 })
      if (this.chat.length > 20) this.chat.shift()
    })
    bot.on('soundEffectHeard', (name, pt) => this.sounds.add(name, [pt.x, pt.y, pt.z], Date.now()))
    bot.on('bossBarCreated', b => this.bossBars.set(b.entityUUID, b))
    bot.on('bossBarUpdated', b => this.bossBars.set(b.entityUUID, b))
    bot.on('bossBarDeleted', b => this.bossBars.delete(b.entityUUID))
    bot.on('kicked', reason => console.warn(`[bot] kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`))
    bot.on('error', err => console.warn(`[bot] error: ${err.message}`))
    let gone = false
    const reconnect = reason => {
      if (gone) return
      gone = true
      console.warn(`[bot] disconnected (${reason}); reconnecting in ${this.backoff / 1000}s`)
      clearInterval(motionTimer)
      this.spawned = false
      this.bossBars.clear()
      bot.removeAllListeners()
      bot.on('error', () => {}) // late errors from the dead connection must not crash the body
      try { bot.end() } catch {}
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 60000)
    }
    bot.on('end', reason => reconnect(reason))
    // With version auto-detection a failed ping only emits 'error', never 'end'.
    bot.on('error', err => { if (!this.spawned) reconnect(err.code || err.message) })
  }

  sampleMotion () {
    const bot = this.bot
    if (!bot?.entity) return
    const now = Date.now()
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !e.position) continue
      this.motion.sample(e.id, e.position.distanceTo(bot.entity.position), now)
    }
    this.motion.prune(now)
  }

  bossBar () {
    const bars = [...this.bossBars.values()]
    if (!bars.length) return null
    const b = bars[bars.length - 1]
    return { title: String(b.title ?? ''), health: Math.max(0, Math.min(1, Number(b.health) || 0)) }
  }

  /** Full-view obs, or null while not in game. */
  obs () {
    if (!this.spawned || !this.bot?.entity) return null
    try {
      const view = this.view.snapshot({ chat: this.chat, bossBar: this.bossBar(), task: null })
      const { obs, stats } = buildObs(view, { motion: this.motion, sounds: this.sounds })
      // Known places: record what passed the fair-play filter, and drop
      // remembered blocks the bot can now see are gone.
      const t0 = performance.now()
      this.places.applyRecheck(obs.self.dim, obs.t, recheckKnown(view, this.places.inDim(obs.self.dim)))
      this.places.recordObs(obs)
      stats.ms += performance.now() - t0
      this.stats.add(stats)
      return obs
    } catch (err) {
      console.warn(`[obs] build failed: ${err.stack || err}`)
      return null
    }
  }

  event (kind, detail) {
    this.link.broadcast({ type: 'event', v: V, kind, detail, obs: this.obs() })
  }

  async onCall (call) {
    const bot = this.bot
    const act = {
      connected: () => this.spawned && !!bot,
      chat: text => bot.chat(text),
      halt: () => bot.clearControlStates(),
      here: () => {
        const p = bot.entity.position
        return { pos: [p.x, p.y, p.z], dim: bot.game.dimension, t: Number(bot.time.age) || 0 }
      },
      places: this.places
    }
    const r = runVerb(act, call.verb, call.args)
    if (r.status === 'done' && call.verb === 'say') await new Promise(resolve => setTimeout(resolve, 50))
    return { ...r, obs: this.obs() }
  }
}

const posOf = bot => bot.entity ? [bot.entity.position.x, bot.entity.position.y, bot.entity.position.z].map(v => Math.round(v * 10) / 10) : null

module.exports = { Body }
