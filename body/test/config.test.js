'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const CONFIG = require.resolve('../src/config')
const KEYS = ['ATLAS_MC_HOST', 'ATLAS_MC_PORT', 'ATLAS_PLACES_FILE', 'ATLAS_ENV_FILE']

/** Load config.js fresh with exactly these env vars (and no atlas.env file). */
function configWith (vars) {
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  process.env.ATLAS_ENV_FILE = path.join(__dirname, 'no-such.env')
  Object.assign(process.env, vars)
  try {
    delete require.cache[CONFIG]
    return require(CONFIG)
  } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    delete require.cache[CONFIG]
  }
}

const rel = p => path.relative(ROOT, p)

test('known-places file is named after the configured server', () => {
  assert.equal(rel(configWith({}).placesFile), 'data/known-places.localhost_25565.json')
  assert.equal(rel(configWith({ ATLAS_MC_HOST: '10.0.0.52', ATLAS_MC_PORT: '25565' }).placesFile), 'data/known-places.10.0.0.52_25565.json')
  assert.equal(rel(configWith({ ATLAS_MC_HOST: 'Coop.Example.org', ATLAS_MC_PORT: '25570' }).placesFile), 'data/known-places.coop.example.org_25570.json')
})

test('dev world and co-op server never share a file; same server always gets the same one', () => {
  const dev = configWith({ ATLAS_MC_HOST: 'localhost', ATLAS_MC_PORT: '25565' }).placesFile
  const coop = configWith({ ATLAS_MC_HOST: 'coop.example.org', ATLAS_MC_PORT: '25565' }).placesFile
  const otherPort = configWith({ ATLAS_MC_HOST: 'localhost', ATLAS_MC_PORT: '25566' }).placesFile
  assert.equal(new Set([dev, coop, otherPort]).size, 3)
  assert.equal(configWith({ ATLAS_MC_HOST: 'localhost', ATLAS_MC_PORT: '25565' }).placesFile, dev)
})

test('host is sanitised into a single file name inside data/', () => {
  const { placesFileFor } = configWith({})
  assert.equal(placesFileFor('::1', 25565), path.join('data', 'known-places.--1_25565.json'))
  assert.equal(placesFileFor('../../etc/x', 1), path.join('data', 'known-places.-..-etc-x_1.json'))
  for (const h of ['::1', '../../etc/x', 'a/b\\c', '..', ' ']) {
    const f = placesFileFor(h, 25565)
    assert.equal(path.dirname(f), 'data', h)
    assert.ok(!path.basename(f).startsWith('known-places..'), h)
  }
})

test('ATLAS_PLACES_FILE overrides the automatic name', () => {
  assert.equal(rel(configWith({ ATLAS_MC_HOST: '10.0.0.52', ATLAS_PLACES_FILE: 'data/mine.json' }).placesFile), 'data/mine.json')
  assert.equal(configWith({ ATLAS_PLACES_FILE: '/var/lib/atlas/kp.json' }).placesFile, '/var/lib/atlas/kp.json')
})
