'use strict'
// Read-only tap of the link for the dashboard. Every message that crosses the
// link (or would, see Link.broadcast) is pushed here as-is, wrapped like a log
// line: {ts, dir: "in"|"out", logged, msg}.
//
// Only contract messages get through: each one is copied through JSON (so no
// live object, prototype or function survives) and the copy must validate
// against its contract schema. Anything else is dropped, never forwarded.
const { EventEmitter } = require('events')
const { check } = require('./schema')

const TAPPED = new Set(['obs', 'call', 'result', 'event', 'trace', 'observe'])

class Tap extends EventEmitter {
  constructor ({ replay = 200 } = {}) {
    super()
    this.replayMax = replay
    this.recent = []
    this.dropped = 0
  }

  /** @returns {boolean} whether the message was forwarded */
  push (dir, msg, logged = true) {
    // 1. cheap checks on the original, so a large backend object attached to
    //    a message is rejected before anything walks it
    if (!msg || typeof msg !== 'object' || Object.getPrototypeOf(msg) !== Object.prototype) return this.drop('not a plain object')
    const type = msg.type
    if (!TAPPED.has(type)) return this.drop(`type ${JSON.stringify(type)}`)
    let err
    try { err = check(type, msg) } catch (e) { err = e.message }
    if (err) return this.drop(`invalid ${type}: ${err}`)
    // 2. copy through JSON (no live objects survive) and validate the copy
    let copy
    try { copy = JSON.parse(JSON.stringify(msg)) } catch { return this.drop('not serialisable') }
    err = check(type, copy)
    if (err) return this.drop(`invalid ${type} after copy: ${err}`)
    const env = { ts: new Date().toISOString(), dir: dir === 'in' ? 'in' : 'out', logged: !!logged, msg: copy }
    this.recent.push(env)
    if (this.recent.length > this.replayMax) this.recent.shift()
    this.emit('message', env)
    return true
  }

  drop (why) {
    this.dropped++
    console.warn(`[tap] dropped a non-contract message (${why})`)
    return false
  }
}

module.exports = { Tap }
