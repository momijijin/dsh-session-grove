/**
 * Drag & drop model for the groups tree.
 *
 * Pure functions only: `hitTest` maps pointer geometry to a drop target,
 * `checkSessionDrop` answers whether that target is structurally legal (the
 * live preview shares it with the commit), and `applyDrop` maps an allowed
 * target to the next GroupDoc via the shared model mutators. Components own the
 * HTML5 drag events, insertion line, floating label and the 500ms
 * collapsed-group auto-expand timer; they call these functions.
 */
import { effectiveArchived } from '../shared/archive.js'
import { assignSession, findGroup, reorderUngrouped } from '../shared/model.js'

/**
 * 0.2.21: insertion placeholders move rows under a resting pointer. Recomputing
 * the hit target from the shifted row makes the placeholder jump a row (or two)
 * back and forth. Keep the current target while the pointer stays inside this
 * small radius; a deliberate move releases the lock.
 */
export const DRAG_TARGET_STICKY_PX = 4

/**
 * Return the locked target while the pointer is within the sticky radius.
 * @param {{x:number,y:number,target:object}|null} lock
 * @param {number} x
 * @param {number} y
 * @param {number} [radius]
 * @returns {object|null}
 */
export const stickyDropTarget = (lock, x, y, radius = DRAG_TARGET_STICKY_PX) => {
  if (!lock || !lock.target) return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return Math.hypot(x - lock.x, y - lock.y) <= radius ? lock.target : null
}

/** Rows shorter than this still split into before/after halves. */
const MIN_ROW_HEIGHT = 8

/**
 * Resolve where a session currently lives.
 * @returns {{ groupId: string|null, index: number }}
 */
export const sessionLocation = (doc, sessionId) => {
  const groups = Array.isArray(doc?.groups) ? doc.groups : []
  for (const group of groups) {
    const index = Array.isArray(group.sessionIds) ? group.sessionIds.indexOf(sessionId) : -1
    if (index >= 0) return { groupId: group.id, index }
  }
  const ungrouped = Array.isArray(doc?.ungrouped) ? doc.ungrouped : []
  const index = ungrouped.indexOf(sessionId)
  return { groupId: null, index }
}

/**
 * Map pointer geometry + row identity to a drop target.
 *
 * - session row: top half -> before, bottom half -> after (same group)
 * - group row (header): append to the end of that group
 * - group head area (indent guide at the top of a group body): head of group
 * - ungrouped header / empty area: move out of all groups
 * - dragging over itself or an unknown row: invalid
 *
 * @param {{
 *   source: { kind: 'session', sessionId: string },
 *   rowKind: 'session'|'group'|'ungrouped'|'blank',
 *   pointerY: number,
 *   rowTop: number,
 *   rowHeight: number,
 *   targetGroupId?: string|null,
 *   targetSessionId?: string|null,
 * }} input
 * @returns {{ kind: string, groupId?: string|null, sessionId?: string|null, index?: number }}
 */
export const hitTest = ({ source, rowKind, pointerY, rowTop, rowHeight, targetGroupId = null, targetSessionId = null }) => {
  const sessionId = source?.kind === 'session' ? source.sessionId : null
  if (!sessionId) return { kind: 'invalid' }
  const height = Number.isFinite(rowHeight) && rowHeight > 0 ? Math.max(rowHeight, MIN_ROW_HEIGHT) : MIN_ROW_HEIGHT
  const upper = pointerY <= rowTop + height / 2

  switch (rowKind) {
    case 'session':
      if (!targetSessionId) return { kind: 'invalid' }
      if (targetSessionId === sessionId) return { kind: 'invalid' }
      return {
        kind: upper ? 'session-before' : 'session-after',
        groupId: targetGroupId ?? null,
        sessionId: targetSessionId,
      }
    case 'group':
      if (!targetGroupId) return { kind: 'invalid' }
      return { kind: 'group-append', groupId: targetGroupId }
    case 'group-head':
      if (!targetGroupId) return { kind: 'invalid' }
      return { kind: 'group-head', groupId: targetGroupId }
    case 'ungrouped':
      return { kind: 'ungrouped' }
    default:
      return { kind: 'invalid' }
  }
}

/**
 * Resolve a body-level drop in the virtualized ungrouped list.
 *
 * The header means "top of the list", but the body must follow the visible
 * rows: above a row's midpoint -> before it, a gap -> before the next row,
 * below the last midpoint -> after the last row. An empty body is the only
 * body-level case that means the ungrouped section itself.
 *
 * @param {{sessionId:string, top:number, height:number}[]} rows visible rows in visual order
 * @param {number} pointerY
 * @returns {{kind:string, groupId?:null, sessionId?:string}}
 */
export const ungroupedBodyTarget = (rows, pointerY) => {
  const visible = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row.sessionId === 'string' && Number.isFinite(row.top))
    .map((row) => ({
      sessionId: row.sessionId,
      top: row.top,
      height: Number.isFinite(row.height) && row.height > 0 ? Math.max(row.height, MIN_ROW_HEIGHT) : MIN_ROW_HEIGHT,
    }))
    .sort((left, right) => left.top - right.top)
  if (visible.length === 0 || !Number.isFinite(pointerY)) return { kind: 'ungrouped' }
  for (const row of visible) {
    if (pointerY < row.top + row.height / 2) {
      return { kind: 'session-before', groupId: null, sessionId: row.sessionId }
    }
  }
  return { kind: 'session-after', groupId: null, sessionId: visible[visible.length - 1].sessionId }
}

/**
 * Resolve a session drop to its insertion slot.
 *
 * `index` is the post-removal insertion index inside the destination list, which
 * is what the shared mutators (`assignSession`) expect: the dragged session is
 * removed first. Invalid/unknown targets return `{ reason: 'invalid' }`.
 *
 * @returns {{ groupId: string|null, index: number, moving: { groupId: string|null, index: number } } | { reason: string }}
 */
const sessionDropPosition = (doc, sessionId, target) => {
  if (!target || typeof target !== 'object') return { reason: 'invalid' }
  switch (target.kind) {
    case 'session-before':
    case 'session-after': {
      if (typeof target.sessionId !== 'string' || target.sessionId === '' || target.sessionId === sessionId) {
        return { reason: 'invalid' }
      }
      const anchor = sessionLocation(doc, target.sessionId)
      if (anchor.index < 0) return { reason: 'invalid' }
      const moving = sessionLocation(doc, sessionId)
      const insertAt = target.kind === 'session-before' ? anchor.index : anchor.index + 1
      // Removing the moved id first shifts anchors inside the same list.
      let index = insertAt
      if (moving.groupId === anchor.groupId && moving.index >= 0 && moving.index < insertAt) index -= 1
      return { groupId: anchor.groupId, index, moving }
    }
    case 'group-append': {
      if (typeof target.groupId !== 'string' || target.groupId === '') return { reason: 'invalid' }
      const group = findGroup(doc, target.groupId)
      if (!group) return { reason: 'invalid' }
      const moving = sessionLocation(doc, sessionId)
      const length = Array.isArray(group.sessionIds) ? group.sessionIds.length : 0
      // A same-group append removes the session before inserting, so its last
      // reachable index is `length - 1`; a cross-group append lands at `length`.
      const index = moving.groupId === group.id ? Math.max(0, length - 1) : length
      return { groupId: group.id, index, moving }
    }
    case 'group-head': {
      if (typeof target.groupId !== 'string' || target.groupId === '') return { reason: 'invalid' }
      const group = findGroup(doc, target.groupId)
      if (!group) return { reason: 'invalid' }
      return { groupId: group.id, index: 0, moving: sessionLocation(doc, sessionId) }
    }
    case 'ungrouped':
      return { groupId: null, index: null, moving: sessionLocation(doc, sessionId) }
    default:
      return { reason: 'invalid' }
  }
}

/**
 * Structural legality of one session drop (0.4.0-beta.62 archived containers).
 *
 * Pure: never clones or mutates the doc, so the drag preview can call it on every
 * `dragover` and the commit can call it again on the latest confirmed doc — the
 * two always agree. The returned `noop` means the drop resolves to the session's
 * current slot, so the caller must not write a new doc (and must not bump the
 * revision).
 *
 * An effectively archived group is a locked container (spec §2 `containerLock`,
 * §6.2): sessions inside it cannot be reordered, moved out or moved between
 * groups, and nothing can be dropped into / reordered inside it. Reordering a
 * sibling *outside* an archived subtree stays legal. An individually archived
 * session (`session.archived`) is host state, not part of GroupDoc, so it is
 * intentionally not consulted here (spec §1 non-goal).
 *
 * Reasons are stable machine-readable strings:
 * - `invalid` — missing/unknown source, self drop, unknown group/session, unknown kind.
 * - `archived-container` — the source session lives in an archived container.
 * - `archived-destination` — the destination group is an archived container.
 *
 * @param {object} doc
 * @param {{ kind: 'session', sessionId: string } | null | undefined} source
 * @param {{ kind: string, groupId?: string|null, sessionId?: string|null } | null | undefined} target
 * @returns {{ ok: true, noop: boolean } | { ok: false, reason: string }}
 */
export const checkSessionDrop = (doc, source, target) => {
  const sessionId = source?.kind === 'session' ? source.sessionId : null
  if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, reason: 'invalid' }
  if (!doc || !Array.isArray(doc.groups)) return { ok: false, reason: 'invalid' }
  const position = sessionDropPosition(doc, sessionId, target)
  if (position.reason) return { ok: false, reason: position.reason }
  const { moving } = position
  if (moving.groupId !== null && effectiveArchived(doc, moving.groupId)) {
    return { ok: false, reason: 'archived-container' }
  }
  if (position.groupId !== null && effectiveArchived(doc, position.groupId)) {
    return { ok: false, reason: 'archived-destination' }
  }
  // The ungrouped section is outside the archive tree. Without the visible
  // ungrouped order the check cannot tell a no-op from a visible reorder, so the
  // drop is legal here and `applyDrop` resolves the concrete outcome.
  if (position.groupId === null) return { ok: true, noop: false }
  const noop = moving.groupId === position.groupId && moving.index === position.index
  return { ok: true, noop }
}

/**
 * Apply one drop to the doc.
 *
 * The archive guard runs first and shares its predicate with the live preview
 * (`checkSessionDrop`). A rejected drop returns the input doc untouched plus a
 * stable `reason`; an allowed drop keeps the previous clone/mutate behavior of
 * the shared model mutators. A no-op drop returns the input doc identity with
 * `{ applied: false, noop: true }` so the queue never bumps the revision.
 *
 * Only `{ kind: 'ungrouped' }` is a container target ("move out / to the top").
 * Every row anchor (`session-before` / `session-after`) uses its resolved
 * insertion index, including the `groupId: null` anchors of the ungrouped list.
 *
 * @param {object} doc
 * @param {{ kind: 'session', sessionId: string }} source
 * @param {{ kind: string, groupId?: string|null, sessionId?: string|null }} target
 * @param {string[]} [visibleUngrouped] full visible ungrouped order (first reorder writes it)
 * @returns {{ doc: object, applied: true } | { doc: object, applied: false, reason: string } | { doc: object, applied: false, noop: true }}
 */
export const applyDrop = (doc, source, target, visibleUngrouped = null) => {
  const verdict = checkSessionDrop(doc, source, target)
  if (!verdict.ok) return { doc, applied: false, reason: verdict.reason }
  if (verdict.noop) return { doc, applied: false, noop: true }
  const sessionId = source.sessionId
  const position = sessionDropPosition(doc, sessionId, target)
  // Defensive: checkSessionDrop already validated the same payload.
  if (position.reason) return { doc, applied: false, reason: position.reason }

  // Only the `{ kind: 'ungrouped' }` container target means "top of the ungrouped
  // section". Session anchors (`session-before` / `session-after`, including the
  // `groupId: null` ones inside the ungrouped list) already resolved a concrete
  // insertion index, so they take the shared `assignSession` path below.
  if (target.kind === 'ungrouped') {
    const moving = position.moving
    if (moving.groupId === null && Array.isArray(visibleUngrouped) && visibleUngrouped.length > 0) {
      // Reorder the visible ungrouped list, persisting the manual order.
      const order = visibleUngrouped.filter((id) => id !== sessionId)
      order.unshift(sessionId)
      return { doc: reorderUngrouped(doc, order), applied: true }
    }
    if (moving.groupId === null) return { doc, applied: false, noop: true }
    return { doc: assignSession(doc, sessionId, null, 0), applied: true }
  }
  return { doc: assignSession(doc, sessionId, position.groupId, position.index), applied: true }
}

/** Stable drop-target fields. Geometry/indices are never part of a view target. */
const TARGET_FIELDS = Object.freeze(['kind', 'sessionId', 'groupId', 'targetId', 'parentId', 'beforeGroupId'])

/**
 * Stable equality for view drop targets.
 *
 * A dragover fires continuously while the pointer rests on one row, and the
 * handler rebuilds a fresh target object every time. Comparing the stable
 * vocabulary (kind + row/group identity + insertion anchor) lets the view skip
 * the React update when the resolved target did not actually move. `undefined`
 * and `null` are equivalent for every field, because targets are built with
 * `?? null` in some paths and omitted in others.
 *
 * This is deliberately pure so it is unit-tested without React.
 *
 * @param {object|null|undefined} left
 * @param {object|null|undefined} right
 * @returns {boolean}
 */
export const sameDropTarget = (left, right) => {
  if (left === right) return true
  // An absent target is the same "no line" state whether it was null or
  // undefined (the initial ref is null; handlers clear with null).
  if (left === null || left === undefined) return right === null || right === undefined
  if (right === null || right === undefined) return false
  if (typeof left !== 'object' || typeof right !== 'object') return false
  for (const field of TARGET_FIELDS) {
    const a = left[field] ?? null
    const b = right[field] ?? null
    if (a !== b) return false
  }
  return true
}
