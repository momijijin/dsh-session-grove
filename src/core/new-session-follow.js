/**
 * Decide whether the active session that replaced a group-head blank should be
 * moved into the group that initiated the create. Pure so the blank, workspace
 * and target-group guards are testable without a host.
 *
 * The intent stays armed for the whole pre-prompt blank lifetime, but it only
 * follows an active session from a different workspace. Clicking another blank
 * in the same workspace must not steal that group's placeholder.
 */

/**
 * @param {?{groupId: string, trackedSessionId: string, workspaceId: string}} pending
 * @param {string} activeSessionId
 * @param {Record<string, object>} sessionsById
 * @param {boolean} groupExists
 * @param {boolean} workspaceChanged
 * @returns {?{targetGroupId: string, previousSessionId: string, removePrevious: boolean}}
 */
export const newSessionFollow = (pending, activeSessionId, sessionsById, groupExists, workspaceChanged) => {
  if (!pending || typeof activeSessionId !== 'string' || activeSessionId === '') return null
  if (activeSessionId === pending.trackedSessionId) return null
  if (!groupExists || workspaceChanged !== true) return null
  const active = sessionsById?.[activeSessionId]
  if (!active || active.blank !== true || active.origin === 'subagent') return null
  const previous = sessionsById?.[pending.trackedSessionId]
  return {
    targetGroupId: pending.groupId,
    previousSessionId: pending.trackedSessionId,
    removePrevious: previous !== undefined && previous.blank === true,
  }
}

/** True while the tracked blank is still in the group that opened the follow intent. */
export const pendingFollowStillValid = (doc, pending) => {
  if (!pending || !Array.isArray(doc?.groups)) return false
  const group = doc.groups.find((entry) => entry?.id === pending.groupId)
  return Boolean(group && Array.isArray(group.sessionIds) && group.sessionIds.includes(pending.trackedSessionId))
}
