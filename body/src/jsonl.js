'use strict'
// Append-only JSONL log of contract messages, one file per day:
//   logs/link-YYYY-MM-DD.jsonl   {"ts": ISO time, "dir": "in"|"out", "msg": <contract message>}
// Only contract messages go here, never backend details.
const fs = require('fs')
const path = require('path')

class JsonlLog {
  constructor (dir) {
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true })
    this.day = null
    this.stream = null
  }

  file () {
    const day = new Date().toISOString().slice(0, 10)
    if (day !== this.day) {
      if (this.stream) this.stream.end()
      this.day = day
      this.path = path.join(this.dir, `link-${day}.jsonl`)
      this.stream = fs.createWriteStream(this.path, { flags: 'a' })
    }
    return this.stream
  }

  write (dir, msg) {
    this.file().write(JSON.stringify({ ts: new Date().toISOString(), dir, msg }) + '\n')
  }

  /** Flush and close; resolves once everything written is on disk. */
  close () {
    const st = this.stream
    this.stream = null; this.day = null
    if (!st) return Promise.resolve()
    return new Promise(resolve => st.end(resolve))
  }
}

module.exports = { JsonlLog }
