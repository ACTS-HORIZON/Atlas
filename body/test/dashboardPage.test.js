'use strict'
// Dashboard v2 in a real browser: headless Chromium against a real Body with the fake bot.
// The page renders with no JS errors; the map shows the bot, a known place and a player bearing;
// the feed interleaves calls, results, traces and events in order; secrets stay masked.
// Skipped when Playwright (or its Chromium) is not installed.
const test = require('node:test')
const assert = require('node:assert/strict')
const { client, startBody } = require('./bodyHarness')

let chromium = null
try { chromium = require('playwright').chromium } catch {}

test('dashboard v2 in headless Chromium: no errors, map, merged feed, masked config', { skip: !chromium && 'playwright not installed', timeout: 60000 }, async (t) => {
  const { body, bot, linkUrl, dashUrl } = await startBody(t, { advisor: { enabled: false, apiKey: 'sk-live-123', maxDollars: 5 } })
  // a player out of sight, on the Locator Bar (bearing only), and a known place (the visible iron ore)
  body.locator.list = () => [{ name: 'Rook', azimuth: 90 }]
  body.obs()

  let browser
  try { browser = await chromium.launch() } catch (err) { t.skip(`chromium did not start: ${err.message}`); return }
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  const errors = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  await page.goto(dashUrl + '/')

  // the mind's turn: a thinking trace, a call (and its result), an event, a lesson
  const mind = client(linkUrl)
  await mind.opened
  await mind.wait(m => m.type === 'obs')
  const send = m => mind.send({ v: '0.1', ...m })
  send({ type: 'trace', t: 10, kind: 'decision', text: 'Rook asked for a hello. I will say it.', data: { action: 'call', verb: 'say', args: { text: 'hello' }, tokens: 182, task: 'T1' } })
  await new Promise(resolve => setTimeout(resolve, 30))
  send({ type: 'call', id: 'c1', verb: 'say', args: { text: 'hello' } })
  await mind.wait(m => m.type === 'result' && m.id === 'c1')
  bot.emit('death')
  await mind.wait(m => m.type === 'event' && m.kind === 'died')
  send({ type: 'trace', t: 11, kind: 'lesson', text: 'say hello before anything else' })
  send({ type: 'observe' })

  await page.waitForFunction(() => document.querySelectorAll('#feed .it.k-notes').length >= 1, null, { timeout: 10000 })
  await page.waitForSelector('#map [data-kind="place"]', { timeout: 10000 })

  // the map: Atlas, the known iron ore, Rook's bearing arrow
  const map = await page.evaluate(() => ({
    self: document.querySelectorAll('#map [data-kind="self"]').length,
    places: [...document.querySelectorAll('#map [data-kind="place"]')].map(e => e.dataset.type),
    bearing: [...document.querySelectorAll('#map [data-kind="bearing"]')].map(e => e.dataset.name),
    legend: document.getElementById('lg-places').textContent,
    players: document.getElementById('lg-players').textContent
  }))
  assert.equal(map.self, 1)
  assert.deepEqual(map.places, ['iron_ore'])
  assert.deepEqual(map.bearing, ['Rook'])
  assert.match(map.legend, /iron ore/)
  assert.match(map.players, /Rook · \w/)

  // the feed: one timeline, in order, the result inline under its call
  const feed = await page.evaluate(() => [...document.querySelectorAll('#feed .it')].map(e => ({
    kind: e.dataset.kind,
    text: e.textContent.replace(/\s+/g, ' ').trim(),
    result: e.querySelector('.res') ? e.querySelector('.res').dataset.result || null : undefined
  })))
  const kinds = feed.map(f => f.kind)
  const at = k => kinds.indexOf(k)
  assert.ok(at('think') >= 0 && at('calls') > at('think') && at('events') > at('calls') && at('notes') > at('events'), `in order: ${kinds.join(' ')}`)
  const call = feed.find(f => f.kind === 'calls')
  assert.equal(call.result, 'done', 'the result is inline under its call')
  assert.match(call.text, /say/)
  assert.equal(feed.filter(f => f.kind === 'calls').length, 1, 'no separate result row')
  assert.match(feed.find(f => f.kind === 'think').text, /Rook asked for a hello\. I will say it\..*182 tok/)

  // filters hide a kind
  await page.click('#filters button[data-f="think"]')
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#feed .it.k-think')).display), 'none')

  // the band, the player loop (off), the charts from traces
  const band = await page.evaluate(() => ({
    pos: document.getElementById('pos').textContent,
    health: document.getElementById('v-health').textContent,
    status: document.getElementById('status').textContent,
    mode: document.getElementById('pl-mode').textContent,
    tok: document.getElementById('c-tok-s').textContent
  }))
  assert.equal(band.pos, '0  64  0')
  assert.equal(band.health, '20')
  assert.match(band.status, /OK|hurt|obs/)
  assert.equal(band.mode, 'off')
  assert.match(band.tok, /last 182/)

  // secrets masked in the drawer's config
  const conf = await page.evaluate(() => document.getElementById('config').textContent)
  assert.match(conf, /"apiKey": "\*\*\*"/)
  assert.ok(!conf.includes('sk-live-123'))
  assert.ok(!(await page.content()).includes('sk-live-123'))

  // /api/stats exists for the obs chart; /api/places?radius gives the map its places
  const stats = await (await fetch(dashUrl + '/api/stats')).json()
  assert.ok(stats.obs && stats.obs.n >= 1 && Array.isArray(stats.recent_ms))
  const places = await (await fetch(dashUrl + '/api/places?radius=64')).json()
  assert.deepEqual(places.around.map(p => p.type), ['iron_ore'])

  // usable at 1080p and 2560x1440 without page-level horizontal scroll
  for (const [w, h] of [[1920, 1080], [2560, 1440]]) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(100)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok(overflow <= 0, `no horizontal scroll at ${w}x${h}: ${overflow}px`)
  }
  if (process.env.ATLAS_DASH_SHOT) await page.screenshot({ path: process.env.ATLAS_DASH_SHOT })

  assert.deepEqual(errors, [])
  mind.ws.close()
  await body.close()
})
