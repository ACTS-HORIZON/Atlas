'use strict'
// Validators for the contract messages, from ../contract/*.schema.json.
const fs = require('fs')
const path = require('path')
const Ajv2020 = require('ajv/dist/2020')

const DIR = path.join(__dirname, '..', '..', 'contract')
const ajv = new Ajv2020({ allErrors: true, strict: false })
const names = ['obs', 'call', 'result', 'event', 'observe', 'trace', 'recall']
for (const n of names) ajv.addSchema(JSON.parse(fs.readFileSync(path.join(DIR, `${n}.schema.json`), 'utf8')))

const validators = {}
for (const n of names) validators[n] = ajv.getSchema(`https://atlas.local/contract/${n}.schema.json`)

validators.recallArgs = ajv.getSchema('https://atlas.local/contract/recall.schema.json#/$defs/args')
validators.recallData = ajv.getSchema('https://atlas.local/contract/recall.schema.json#/$defs/data')

/** @returns {string|null} error text, or null when valid */
function check (kind, msg) {
  const v = validators[kind]
  if (!v) return `unknown message type: ${kind}`
  return v(msg) ? null : ajv.errorsText(v.errors)
}

module.exports = { check }
