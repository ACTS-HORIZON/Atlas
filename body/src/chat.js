'use strict'
// Chat from players (CONTRACT.md, "Chat tasks", Events, House rules).
// Only players on the allowlist (ATLAS_PLAYERS) are listened to:
//   "@<botname> stop"                 -> handled by the body: stop the running verb
//   "@<botname> status"               -> handled by the body: a one-line status in chat
//   "@<botname> that chest is yours"  -> handled by the body (house rules): the chest
//                                        the player is looking at joins the withdraw allowlist
//   "@<botname> <anything else>"      -> event task_from_chat {from, text}  (incl. "come here")
//   any other chat                    -> event player_said {from, text}
// Everyone else's chat only shows in obs.chat.

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * @returns {{kind: 'ignore'|'stop'|'status'|'chest'|'task'|'said', text?: string}}
 */
function classifyChat ({ from, text, botName, allowlist }) {
  if (!from || from === botName || !allowlist.includes(from)) return { kind: 'ignore' }
  const m = String(text).trim().match(new RegExp(`^@${escape(botName)}(?![\\w])[\\s,:]*(.*)$`, 'is'))
  if (!m) return { kind: 'said', text: String(text).trim() }
  const rest = m[1].trim()
  const cmd = rest.toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim()
  if (cmd === 'stop') return { kind: 'stop' }
  if (cmd === 'status') return { kind: 'status' }
  if (/^(that|this) chest is (yours|for you)$/.test(cmd)) return { kind: 'chest' }
  if (!rest) return { kind: 'said', text: String(text).trim() }
  return { kind: 'task', text: rest }
}

module.exports = { classifyChat }
