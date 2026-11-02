'use strict'
// Locator Bar waypoints (CONTRACT.md, Fair play: players out of line of
// sight are reported by bearing only, exactly when the game's Locator Bar
// would show them).
//
// STATUS: not available. In 26.1 the server sends the bar's data in the
// `tracked_waypoint` play packet (operation track/untrack/update; a waypoint
// keyed by player UUID, carrying a block position, a chunk, or only an
// azimuth). minecraft-protocol parses that packet, but Mineflayer 4.39 has no
// handler for it, so nothing reaches this class and it reports no
// waypoints. Bearings are deliberately NOT derived from entity positions:
// that would show players the game hides (sneaking, invisible, out of range).
//
// Interface the rest of the body uses (so wiring a real source later changes
// only this file):
//   list()          -> [{name, azimuth}]  azimuth: F3 degrees from the bot
//                                           towards the player (0 = south)
//   azimuthOf(name) -> number | null
class Locator {
  constructor () { this.available = false }
  list () { return [] }
  azimuthOf () { return null }
}

/** A fixed set of waypoints, for tests: [{name, azimuth}]. */
class StaticLocator {
  constructor (waypoints = []) { this.available = true; this.waypoints = waypoints }
  list () { return this.waypoints.map(w => ({ ...w })) }
  azimuthOf (name) { const w = this.waypoints.find(x => x.name === name); return w ? w.azimuth : null }
}

module.exports = { Locator, StaticLocator }
