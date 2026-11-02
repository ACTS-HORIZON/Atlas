'use strict'
// Voxel raycasting (Amanatides & Woo DDA) over an abstract world:
//   world.classAt(x, y, z) -> {name, opaque, fluid, notable} | null (unloaded)
// Unloaded voxels block sight: you cannot see into chunks you don't have.

const EPS = 1e-9

/**
 * Walk the voxels a segment passes through, starting with the voxel AFTER the
 * one containing `o`. visit(x, y, z) returns true to stop. Returns true if
 * stopped by visit, false if the segment ended.
 */
function traverse (o, d, maxT, visit) {
  let x = Math.floor(o[0]); let y = Math.floor(o[1]); let z = Math.floor(o[2])
  const stepX = d[0] > 0 ? 1 : d[0] < 0 ? -1 : 0
  const stepY = d[1] > 0 ? 1 : d[1] < 0 ? -1 : 0
  const stepZ = d[2] > 0 ? 1 : d[2] < 0 ? -1 : 0
  const tDeltaX = stepX ? Math.abs(1 / d[0]) : Infinity
  const tDeltaY = stepY ? Math.abs(1 / d[1]) : Infinity
  const tDeltaZ = stepZ ? Math.abs(1 / d[2]) : Infinity
  let tMaxX = stepX > 0 ? (x + 1 - o[0]) * tDeltaX : stepX < 0 ? (o[0] - x) * tDeltaX : Infinity
  let tMaxY = stepY > 0 ? (y + 1 - o[1]) * tDeltaY : stepY < 0 ? (o[1] - y) * tDeltaY : Infinity
  let tMaxZ = stepZ > 0 ? (z + 1 - o[2]) * tDeltaZ : stepZ < 0 ? (o[2] - z) * tDeltaZ : Infinity
  for (;;) {
    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) { if (tMaxX > maxT) return false; x += stepX; tMaxX += tDeltaX } else { if (tMaxZ > maxT) return false; z += stepZ; tMaxZ += tDeltaZ }
    } else {
      if (tMaxY < tMaxZ) { if (tMaxY > maxT) return false; y += stepY; tMaxY += tDeltaY } else { if (tMaxZ > maxT) return false; z += stepZ; tMaxZ += tDeltaZ }
    }
    if (visit(x, y, z)) return true
  }
}

/** Unit direction and length from a to b. */
function segment (a, b) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const len = Math.hypot(d[0], d[1], d[2])
  if (len < EPS) return { d: [0, 0, 0], len: 0 }
  return { d: [d[0] / len, d[1] / len, d[2] / len], len }
}

/**
 * True if nothing opaque lies between `eye` and the point `p`
 * (the voxel containing p counts too).
 */
function clearTo (world, eye, p) {
  const { d, len } = segment(eye, p)
  if (len === 0) return true
  const blocked = traverse(eye, d, len, (x, y, z) => {
    const c = world.classAt(x, y, z)
    return c === null || c.opaque
  })
  return !blocked
}

/**
 * True if the ray from `eye` reaches voxel (tx,ty,tz) at point p without an
 * opaque voxel in between ("the first solid block wins").
 */
function reachesVoxel (world, eye, p, tx, ty, tz) {
  const { d, len } = segment(eye, p)
  if (Math.floor(eye[0]) === tx && Math.floor(eye[1]) === ty && Math.floor(eye[2]) === tz) return true
  let hit = false
  traverse(eye, d, len + 1e-6, (x, y, z) => {
    if (x === tx && y === ty && z === tz) { hit = true; return true }
    const c = world.classAt(x, y, z)
    return c === null || c.opaque
  })
  return hit
}

const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const INSET = 0.35 // corner samples, relative to face centre

/**
 * Is any part of block (x,y,z) visible from `eye`?
 * Cheap rejections first: a face only counts if it points at the eye and its
 * neighbour is see-through (for fluids: and not the same fluid, so only the
 * surface of a pool shows). Then up to 5 rays per candidate face (centre
 * first, then 4 inset points).
 * stats.raycasts is incremented per ray cast.
 */
function blockVisible (world, eye, x, y, z, cls, stats) {
  for (const n of FACES) {
    const fc = [x + 0.5 + n[0] * 0.5, y + 0.5 + n[1] * 0.5, z + 0.5 + n[2] * 0.5]
    if ((eye[0] - fc[0]) * n[0] + (eye[1] - fc[1]) * n[1] + (eye[2] - fc[2]) * n[2] <= 0) continue
    const nb = world.classAt(x + n[0], y + n[1], z + n[2])
    if (nb === null || nb.opaque) continue
    if (cls && cls.fluid && nb.name === cls.name) continue
    // sample points just inside the target voxel
    const base = [fc[0] - n[0] * 1e-3, fc[1] - n[1] * 1e-3, fc[2] - n[2] * 1e-3]
    const ax = n[0] !== 0 ? 1 : 0 // tangent axes
    const t1 = ax ? 1 : 0; const t2 = n[2] !== 0 ? 1 : 2
    const samples = [[0, 0], [-INSET, -INSET], [INSET, -INSET], [-INSET, INSET], [INSET, INSET]]
    for (const [u, v] of samples) {
      const p = base.slice()
      p[t1] += u; p[t2] += v
      if (stats) stats.raycasts++
      if (reachesVoxel(world, eye, p, x, y, z)) return true
    }
  }
  return false
}

/**
 * The block a player looks at: first opaque, non-fluid voxel along `dir`
 * (fluids are not targeted, as in the game). Returns [x,y,z] or null.
 */
function lookTarget (world, eye, dir, maxDist) {
  let out = null
  traverse(eye, dir, maxDist, (x, y, z) => {
    const c = world.classAt(x, y, z)
    if (c === null) return true
    if (c.opaque && !c.fluid) { out = [x, y, z]; return true }
    return false
  })
  return out
}

module.exports = { traverse, clearTo, reachesVoxel, blockVisible, lookTarget }
