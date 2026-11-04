'use strict'
// inspect {box: [[x1, y1, z1], [x2, y2, z2]]}: the region view (CONTRACT.md
// Observation): every block in the box the bot can see a face of from where
// it stands, line of sight as always. Runs alongside a running verb.
// Result data: {box, size, visible, hidden, counts: {block: n}, blocks:
// [[x, y, z, "block"], ...]} (air is never listed; at most 512 blocks listed,
// the counts cover all of them). hidden = solid cells it cannot see.
const { checkArgs, failed } = require('./common')
const { blockVisible } = require('../fairplay/raycast')

const MAX_CELLS = 32768 // 32^3
const MAX_LISTED = 512
const AIR = /^(air|cave_air|void_air)$/

function run (act, args) {
  const err = checkArgs('inspect', args)
  if (err) return failed(err)
  const [a, b] = args.box
  const lo = [0, 1, 2].map(i => Math.min(a[i], b[i])); const hi = [0, 1, 2].map(i => Math.max(a[i], b[i]))
  const size = [0, 1, 2].map(i => hi[i] - lo[i] + 1)
  if (size[0] * size[1] * size[2] > MAX_CELLS) return failed(`inspect: the box is ${size.join('x')} = ${size[0] * size[1] * size[2]} cells; at most ${MAX_CELLS}`)
  const s = act.api.sight()
  const view = { classAt: s.classAt }
  const counts = {}; const blocks = []
  let visible = 0; let hidden = 0
  for (let y = lo[1]; y <= hi[1]; y++) {
    for (let z = lo[2]; z <= hi[2]; z++) {
      for (let x = lo[0]; x <= hi[0]; x++) {
        const c = s.classAt(x, y, z)
        if (!c || AIR.test(c.name)) continue
        const d = Math.hypot(x + 0.5 - s.eye[0], y + 0.5 - s.eye[1], z + 0.5 - s.eye[2])
        if (d > s.sightRadius || !blockVisible(view, s.eye, x, y, z, c, null)) { if (c.solid) hidden++; continue }
        visible++
        counts[c.name] = (counts[c.name] || 0) + 1
        if (blocks.length < MAX_LISTED) blocks.push([x, y, z, c.name])
      }
    }
  }
  const top = Object.entries(counts).sort((p, q) => q[1] - p[1]).map(([k, n]) => `${k} ${n}`).join(', ')
  const detail = `inspected ${size.join('x')} box [${lo.join(', ')}]..[${hi.join(', ')}]: ${visible} visible block${visible === 1 ? '' : 's'}${top ? ` (${top})` : ''}; ${hidden} hidden${blocks.length < visible ? `; listed the first ${MAX_LISTED}` : ''}`
  return { status: 'done', detail, data: { box: [lo, hi], size, visible, hidden, counts, blocks } }
}

module.exports = { run, file: __filename }
