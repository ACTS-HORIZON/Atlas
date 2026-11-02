'use strict'
// Configuration: environment variables, optionally from <repo>/atlas.env
// (or the file named by ATLAS_ENV_FILE). Real env vars win over the file.
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const envFile = process.env.ATLAS_ENV_FILE || path.join(ROOT, 'atlas.env')
if (fs.existsSync(envFile)) process.loadEnvFile(envFile)

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k])
const int = (k, d) => {
  const v = Number.parseInt(env(k, String(d)), 10)
  if (!Number.isFinite(v)) throw new Error(`${k} must be an integer`)
  return v
}

module.exports = {
  mc: {
    host: env('ATLAS_MC_HOST', 'localhost'),
    port: int('ATLAS_MC_PORT', 25565),
    username: env('ATLAS_USERNAME', 'Atlas'),
    version: env('ATLAS_MC_VERSION', false) // false = ask the server
  },
  link: {
    host: env('ATLAS_LINK_HOST', '127.0.0.1'),
    port: int('ATLAS_LINK_PORT', 8765)
  },
  logDir: path.resolve(ROOT, env('ATLAS_LOG_DIR', 'logs')),
  obsIntervalMs: int('ATLAS_OBS_INTERVAL_MS', 2000),
  // Upper bound on sight, in blocks. The effective radius is also limited by
  // the render distance (client and server view distance).
  sightRadius: int('ATLAS_SIGHT_RADIUS', 64),
  envFile: fs.existsSync(envFile) ? envFile : null
}
