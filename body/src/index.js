'use strict'
const cfg = require('./config')
const { Body } = require('./body')

const body = new Body(cfg)
if (cfg.envFile) console.log(`[config] loaded ${cfg.envFile}`)
body.start().catch(err => { console.error(err); process.exit(1) })

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[body] ${sig}, shutting down`)
    body.stats.report()
    body.close().catch(err => console.warn(`[body] close: ${err.message}`))
    setTimeout(() => process.exit(0), 300)
  })
}
process.on('unhandledRejection', err => console.warn(`[body] unhandled rejection: ${err && err.stack ? err.stack : err}`))
