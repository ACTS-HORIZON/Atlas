'use strict'
// Observation build timing, printed to stdout (not the contract log).
class BuildStats {
  constructor () { this.ms = []; this.last = null; this.total = 0 }
  add (s) {
    this.last = s
    this.total++
    this.ms.push(s.ms)
    if (this.ms.length > 1000) this.ms.shift()
    if (this.total === 1) console.log(`[obs] first build ${s.ms.toFixed(1)} ms (${s.candidates} candidate blocks, ${s.raycasts} rays)`)
  }

  summary () {
    if (!this.ms.length) return null
    const a = [...this.ms].sort((x, y) => x - y)
    const pct = p => a[Math.min(a.length - 1, Math.floor(p * a.length))]
    return { n: a.length, mean: a.reduce((x, y) => x + y, 0) / a.length, p50: pct(0.5), p95: pct(0.95), max: a[a.length - 1] }
  }

  report () {
    const s = this.summary()
    if (!s) return
    const l = this.last
    console.log(`[obs] build time over last ${s.n}: mean ${s.mean.toFixed(1)} ms, p50 ${s.p50.toFixed(1)}, p95 ${s.p95.toFixed(1)}, max ${s.max.toFixed(1)} | last: ${l.candidates} candidates, ${l.raycasts} rays`)
  }
}
module.exports = { BuildStats }
