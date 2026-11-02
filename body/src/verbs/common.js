'use strict'
// Shared helpers for verbs: argument schemas and small checks.
// The argument shapes follow the CONTRACT.md verb table; where the table is
// silent (what a goto `target` may name, explore directions, limits) the
// choice is the body's and is documented in the README.
const Ajv = require('ajv')

const ajv = new Ajv({ allErrors: false, strict: false, useDefaults: true })
const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }
const SCHEMAS = {
  goto: {
    type: 'object',
    additionalProperties: false,
    properties: {
      pos: vec3,
      target: { type: 'string', minLength: 1, description: 'a visible player name, a visible entity type, an observed block type, or a player on the Locator Bar' },
      range: { type: 'number', minimum: 0, maximum: 32 },
      dig: { type: 'boolean', default: true },
      scaffold: { type: 'boolean', default: true }
    },
    oneOf: [{ required: ['pos'] }, { required: ['target'] }]
  },
  explore: {
    type: 'object',
    required: ['direction', 'distance'],
    additionalProperties: false,
    properties: {
      direction: { enum: ['north', 'south', 'east', 'west', 'north-east', 'north-west', 'south-east', 'south-west', 'forward'] },
      distance: { type: 'integer', minimum: 1, maximum: 512 }
    }
  },
  mine: {
    type: 'object',
    required: ['block'],
    additionalProperties: false,
    properties: {
      block: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 1, maximum: 512, default: 1 },
      radius: { type: 'integer', minimum: 1, maximum: 128, default: 32 }
    }
  },
  collect: {
    type: 'object',
    required: ['item'],
    additionalProperties: false,
    properties: { item: { type: 'string', minLength: 1 } }
  },
  craft: {
    type: 'object',
    required: ['item'],
    additionalProperties: false,
    properties: { item: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1, maximum: 576, default: 1 } }
  },
  place: {
    type: 'object',
    required: ['block', 'pos'],
    additionalProperties: false,
    properties: { block: { type: 'string', minLength: 1 }, pos: { type: 'array', items: { type: 'integer' }, minItems: 3, maxItems: 3 } }
  },
  equip: {
    type: 'object',
    required: ['item'],
    additionalProperties: false,
    properties: { item: { type: 'string', minLength: 1 }, slot: { enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'], default: 'hand' } }
  },
  dig: {
    type: 'object',
    required: ['pos'],
    additionalProperties: false,
    properties: { pos: { type: 'array', items: { type: 'integer' }, minItems: 3, maxItems: 3 } }
  },
  eat: {
    type: 'object',
    additionalProperties: false,
    properties: { item: { type: 'string', minLength: 1 } }
  }
}
const validators = Object.fromEntries(Object.entries(SCHEMAS).map(([k, s]) => [k, ajv.compile(s)]))

/** Validate (and fill defaults into) args. Returns an error string or null. */
function checkArgs (verb, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return `${verb}: args must be an object`
  if (verb === 'goto' && Object.hasOwn(args, 'pos') + Object.hasOwn(args, 'target') !== 1) return 'goto: give exactly one of pos or target'
  const v = validators[verb]
  if (v(args)) return null
  const e = v.errors[0]
  if (e.keyword === 'oneOf') return `${verb}: give exactly one of pos or target`
  if (e.keyword === 'additionalProperties') return `${verb}: unknown argument "${e.params.additionalProperty}"`
  return `${verb}: ${(e.instancePath || 'args').replace(/^\//, '')} ${e.message}`
}

const failed = detail => ({ status: 'failed', detail })
const refused = detail => ({ status: 'refused', detail })

/** Verbs that move or dig cannot run in spectator mode. */
function cannotAct (api, verb) {
  const gm = api.gamemode()
  return gm === 'spectator' ? failed(`${verb}: cannot act in spectator mode`) : null
}

module.exports = { checkArgs, failed, refused, cannotAct, SCHEMAS }
