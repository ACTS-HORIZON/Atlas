'use strict'
// The link (CONTRACT.md, "Processes"): one WebSocket, JSON messages, v "0.1".
// Body side. Every contract message in or out is appended to the JSONL log.
const { WebSocketServer } = require('ws')
const { check } = require('./schema')

const V = '0.1'

class Link {
  /**
   * handlers: onCall(call) -> Promise<{status, detail, obs}>,
   *           buildObs() -> obs|null, onClient(count)
   */
  constructor ({ host, port, log, handlers }) {
    this.log = log
    this.h = handlers
    this.clients = new Set()
    this.wss = new WebSocketServer({ host, port })
    this.wss.on('connection', ws => this.accept(ws))
    this.ready = new Promise((resolve, reject) => {
      this.wss.once('listening', resolve)
      this.wss.once('error', reject)
    })
  }

  get count () { return this.clients.size }

  accept (ws) {
    this.clients.add(ws)
    ws.on('close', () => { this.clients.delete(ws); this.h.onClient?.(this.count) })
    ws.on('error', () => {})
    ws.on('message', data => this.receive(ws, data))
    this.h.onClient?.(this.count)
    const obs = this.h.buildObs()
    if (obs) this.sendTo(ws, obs) // full view on connect (or on spawn, if not yet in game)
  }

  async receive (ws, data) {
    let msg
    try { msg = JSON.parse(String(data)) } catch { return warn('ignored non-JSON message') }
    if (!msg || typeof msg !== 'object') return warn('ignored non-object message')
    if (msg.type === 'call') {
      const err = check('call', msg)
      if (err) {
        warn(`invalid call: ${err}`)
        if (typeof msg.id === 'string') this.sendTo(ws, { type: 'result', v: V, id: msg.id, status: 'failed', detail: `invalid call: ${err}`, obs: null })
        return
      }
      this.log.write('in', msg)
      const r = await this.h.onCall(msg)
      this.sendTo(ws, { type: 'result', v: V, id: msg.id, status: r.status, detail: r.detail, obs: r.obs ?? null })
    } else if (msg.type === 'observe') {
      const err = check('observe', msg)
      if (err) return warn(`invalid observe: ${err}`)
      this.log.write('in', msg)
      const obs = this.h.buildObs()
      if (obs) this.sendTo(ws, obs)
    } else {
      warn(`ignored message type ${JSON.stringify(msg.type)}`)
    }
  }

  sendTo (ws, msg) {
    this.log.write('out', msg)
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  broadcast (msg) {
    if (!this.clients.size) return
    this.log.write('out', msg)
    const s = JSON.stringify(msg)
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(s)
  }

  close () { for (const ws of this.clients) ws.terminate(); this.wss.close() }
}

function warn (m) { console.warn(`[link] ${m}`) }

module.exports = { Link, V }
