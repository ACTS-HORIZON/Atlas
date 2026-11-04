'use strict'
// Configuration: environment variables, optionally from <repo>/atlas.env
// (or the file named by ATLAS_ENV_FILE). Real env vars win over the file.
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const envFile = process.env.ATLAS_ENV_FILE || path.join(ROOT, 'atlas.env')
if (fs.existsSync(envFile)) process.loadEnvFile(envFile)

const { parseRegions } = require('./house')
const { parseChests } = require('./chests')

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k])
const int = (k, d) => {
  const v = Number.parseInt(env(k, String(d)), 10)
  if (!Number.isFinite(v)) throw new Error(`${k} must be an integer`)
  return v
}

/**
 * data/known-places.<host>_<port>.json. The host is lower-cased and anything
 * outside [a-z0-9.-] becomes '-', so IPv6 literals and odd names stay a
 * single safe file name.
 */
function placesFileFor (host, port) {
  const h = String(host).trim().toLowerCase().replace(/[^a-z0-9.-]/g, '-').replace(/^\.+/, '') || 'unknown'
  return path.join('data', `known-places.${h}_${port}.json`)
}

const positive = (k, d) => {
  const v = int(k, d)
  if (v < 1) throw new Error(`${k} must be at least 1`)
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
  // (sight_radius in CONTRACT.md, "Sight")
  sightRadius: positive('ATLAS_SIGHT_RADIUS', 64),
  // Known places file (CONTRACT.md, "Known places"): one per server, named
  // from host and port, unless ATLAS_PLACES_FILE (relative to the repo root,
  // or absolute) overrides it.
  placesFile: path.resolve(ROOT, env('ATLAS_PLACES_FILE', placesFileFor(env('ATLAS_MC_HOST', 'localhost'), int('ATLAS_MC_PORT', 25565)))),
  // mine: strip-mining when no target is in view (straight length before a turn, total cap)
  stripLength: positive('ATLAS_STRIP_LENGTH', 24),
  stripMax: positive('ATLAS_STRIP_MAX', 256),
  // The player loop (src/player): the decision model on Horizon; empty URL = off
  playerUrl: env('ATLAS_PLAYER_URL', ''),
  playerModel: env('ATLAS_PLAYER_MODEL', 'd1-2b'),
  playerTimeoutMs: positive('ATLAS_PLAYER_TIMEOUT_MS', 60),
  playerHz: positive('ATLAS_PLAYER_HZ', 20),
  // while a scripted verb runs, the loop ticks with intent "survive" (0 = off)
  playerOverride: env('ATLAS_PLAYER_OVERRIDE', '1') !== '0',
  // goto/give by Locator Bar bearing: hard time cap for one bearing-follow (seconds)
  followMaxS: positive('ATLAS_FOLLOW_MAX_S', 180),
  // House rules: protected regions, a JSON list of boxes (see src/house.js)
  protectedRegions: parseRegions(env('ATLAS_PROTECTED_REGIONS', '')),
  // House rules: chests the bot may take from (more are granted in chat); grants persist per server
  chests: parseChests(env('ATLAS_CHESTS', '')),
  chestsFile: path.resolve(ROOT, env('ATLAS_CHESTS_FILE', placesFileFor(env('ATLAS_MC_HOST', 'localhost'), int('ATLAS_MC_PORT', 25565)).replace('known-places.', 'chests.'))),
  // Players whose chat the bot listens to ("@<botname> …" tasks, stop, status, come here)
  players: env('ATLAS_PLAYERS', '').split(',').map(s => s.trim()).filter(Boolean),
  // Dashboard bind address, "host:port"; "off" disables it.
  dashBind: env('ATLAS_DASH_BIND', '0.0.0.0:8080'),
  // Live-written verb library (listed on the dashboard; written in a later step).
  verbDir: path.resolve(ROOT, env('ATLAS_VERB_DIR', 'data/verbs')),
  envFile: fs.existsSync(envFile) ? envFile : null,
  placesFileFor
}
