'use strict'
// Dashboard server: serves dashboard/index.html and a read-only API.
//   GET  /                 the page
//   WS   /tap              every link message, as-is ({ts, dir, logged, msg}),
//                          replaying the recent ones on connect
//   GET  /api/places       {count, nearest: [...]}
//   GET  /api/verbs        [{name, kind: "built-in"|"live"}]
//   GET  /api/verbs/<name> {name, kind, source}
//   GET  /api/config       config as loaded, secrets masked
//   GET  /api/log?n=200    last lines of today's link log
//   POST /api/stop         the one control: the body's stop path, directly
// Data reaching the page is built from contract messages (the tap) and plain
// JSON the api functions return; never backend objects.
const fs = require('fs')
const http = require('http')
const path = require('path')
const { WebSocketServer } = require('ws')

const PAGE = path.join(__dirname, '..', 'dashboard', 'index.html')

/** "0.0.0.0:8080" | "[::]:8080" | "8080" -> {host, port}; "off" -> null */
function parseBind (s) {
  s = String(s || '').trim()
  if (!s || s === 'off' || s === 'false' || s === '0') return null
  const i = s.lastIndexOf(':')
  const host = i < 0 ? '0.0.0.0' : s.slice(0, i).replace(/^\[|\]$/g, '') || '0.0.0.0'
  const port = Number.parseInt(i < 0 ? s : s.slice(i + 1), 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`ATLAS_DASH_BIND: bad port in ${JSON.stringify(s)}`)
  return { host, port }
}

const SECRET = /secret|token|password|passwd|api[_-]?key|auth|credential|cookie/i

/** Deep copy of plain config data with secret-looking keys masked. */
function maskSecrets (v, key = '') {
  if (SECRET.test(key) && v !== null && v !== undefined && v !== '' && v !== false) return '***'
  if (Array.isArray(v)) return v.map(x => maskSecrets(x))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x !== 'function').map(([k, x]) => [k, maskSecrets(x, k)]))
  return v
}

class Dashboard {
  /** api: {places(), verbs(), verbSource(name), config(), logTail(n), stop()} */
  constructor ({ host, port, tap, api }) {
    this.tap = tap
    this.api = api
    this.server = http.createServer((req, res) => this.handle(req, res).catch(err => send(res, 500, { error: err.message })))
    this.wss = new WebSocketServer({ server: this.server, path: '/tap' })
    this.wss.on('connection', ws => {
      ws.on('error', () => {})
      ws.on('message', () => {}) // read-only: anything sent here is ignored
      for (const env of tap.recent) ws.send(JSON.stringify(env))
    })
    this.onTap = env => {
      const s = JSON.stringify(env)
      for (const ws of this.wss.clients) if (ws.readyState === ws.OPEN) ws.send(s)
    }
    tap.on('message', this.onTap)
    this.server.listen(port, host)
    this.ready = new Promise((resolve, reject) => {
      this.server.once('listening', resolve)
      this.server.once('error', reject)
    })
  }

  get count () { return this.wss.clients.size }
  get port () { return this.server.address().port }

  async handle (req, res) {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    if (req.method === 'POST' && p === '/api/stop') return send(res, 200, await this.api.stop())
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'read-only' })
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(PAGE)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(html)
    }
    if (p === '/api/places') return send(res, 200, this.api.places())
    if (p === '/api/verbs') return send(res, 200, this.api.verbs())
    if (p.startsWith('/api/verbs/')) {
      const v = this.api.verbSource(decodeURIComponent(p.slice('/api/verbs/'.length)))
      return v ? send(res, 200, v) : send(res, 404, { error: 'no such verb' })
    }
    if (p === '/api/config') return send(res, 200, maskSecrets(this.api.config()))
    if (p === '/api/log') return send(res, 200, this.api.logTail(Math.min(1000, Math.max(1, Number(url.searchParams.get('n')) || 200))))
    return send(res, 404, { error: 'not found' })
  }

  close () {
    this.tap.off('message', this.onTap)
    for (const ws of this.wss.clients) ws.terminate()
    return new Promise(resolve => {
      this.wss.close()
      this.server.close(() => resolve())
      this.server.closeAllConnections() // keep-alive HTTP clients would hold close() open
    })
  }
}

function send (res, code, body) {
  if (res.headersSent) return res.end()
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Built-in verbs plus live-written ones on disk (listed, never loaded here). */
function verbLibrary (builtins, liveDir) {
  const list = () => {
    const out = Object.keys(builtins).map(name => ({ name, kind: 'built-in' }))
    out.push({ name: 'stop', kind: 'built-in' })
    if (liveDir && fs.existsSync(liveDir)) {
      for (const f of fs.readdirSync(liveDir).sort()) {
        if (/^[A-Za-z0-9_]+\.js$/.test(f)) out.push({ name: f.slice(0, -3), kind: 'live' })
      }
    }
    return out
  }
  const source = name => {
    const v = list().find(x => x.name === name)
    if (!v) return null
    if (v.kind === 'live') return { ...v, source: fs.readFileSync(path.join(liveDir, `${name}.js`), 'utf8') }
    if (name === 'stop') return { ...v, source: '// stop is handled by the body itself (src/runner.js, Runner.stop):\n// it aborts the running verb (which returns "interrupted") and releases all controls.\n' + require('./runner').Runner.prototype.stop.toString() }
    const def = builtins[name]
    return { ...v, source: `${name}: {${def.instant ? ' instant: true,' : ''}\n  ${def.run.toString()}\n}` }
  }
  return { list, source }
}

/** Last n lines of a file, read from the end. */
function tailFile (file, n) {
  if (!file || !fs.existsSync(file)) return []
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    let pos = size; let buf = ''; let lines = []
    while (pos > 0 && lines.length <= n) {
      const len = Math.min(65536, pos)
      pos -= len
      const b = Buffer.alloc(len)
      fs.readSync(fd, b, 0, len, pos)
      buf = b.toString('utf8') + buf
      lines = buf.split('\n')
    }
    return lines.filter(Boolean).slice(-n)
  } finally { fs.closeSync(fd) }
}

module.exports = { Dashboard, parseBind, maskSecrets, verbLibrary, tailFile }
