/**
 * Selection-dialog logic (0.2.6).
 *
 * The small picker dialogs (icon, move-to-group, new-session workspace and the
 * new group-color dialog) share one interaction contract: clicking an option
 * only highlights it (`aria-selected`/`aria-checked`), the footer Confirm button
 * applies the current selection and Cancel closes without writing. These pure
 * helpers own the initial selection, validity and confirm payload so the React
 * component only renders state; unit tests cover the full matrix without a DOM.
 */
import { DEFAULT_GROUP_COLOR, DEFAULT_ICON, GROUP_ICONS, MAX_DEPTH } from '../shared/constants.js'
import {
  childrenOf,
  deleteGroupTo,
  findGroup,
  groupColor,
  groupColorHex,
  groupDepth,
  groupSubtreeHeight,
  isColorHex,
  isDescendant,
  isKnownColor,
  moveGroup,
  normalizeColorHex,
} from '../shared/model.js'
import {
  ARCHIVE_FROZEN,
  GROUP_ARCHIVED,
  GROUP_CONTAINS_ARCHIVED,
  GROUP_DESTINATION_ARCHIVED,
  GROUP_POSITION_LOCKED,
  effectiveArchived,
  hasArchivedDescendant,
} from '../shared/archive.js'

/** Dialog kinds whose body is a selectable option list. */
export const SELECTION_DIALOG_KINDS = Object.freeze([
  'move-session',
  'move-group',
  'icon',
  'group-color',
  'delete-group',
])

export const isSelectionDialog = (kind) => SELECTION_DIALOG_KINDS.includes(kind)

/** Flat depth-first group list (root first), used by the move pickers. */
export const findGroupsFlat = (doc) => {
  const out = []
  const walk = (parentId, depth) => {
    for (const group of doc.groups.filter((item) => item.parentId === parentId)) {
      out.push({ ...group, depth })
      walk(group.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/**
 * 0.4.0-beta.62 §5.3: archived destinations stay listed but are disabled with a
 * reason. The picker renders `disabled`/`disabledReason`; the pure validity
 * helpers below reject the same rows so Confirm can never apply them.
 */
export const ARCHIVED_DESTINATION_REASON = 'dialog.destinationArchived'

const ARCHIVE_CODES = new Set([
  GROUP_ARCHIVED,
  GROUP_CONTAINS_ARCHIVED,
  GROUP_DESTINATION_ARCHIVED,
  GROUP_POSITION_LOCKED,
  ARCHIVE_FROZEN,
])

/** Structured archive error code (`group-archived`, …) or `null` for other failures. */
const archiveCodeOf = (error) => (isArchiveCode(error?.code) ? error.code : null)

const isArchiveCode = (code) => typeof code === 'string' && ARCHIVE_CODES.has(code)

/** Whether a structured operation error code belongs to the archive-freeze family. */
export const isArchiveErrorCode = (code) => isArchiveCode(code)

/** Decorate a flat group list with the archived-destination disabled state. */
const markArchivedDestinations = (doc, groups) =>
  groups.map((group) =>
    effectiveArchived(doc, group.id)
      ? { ...group, disabled: true, disabledReason: ARCHIVED_DESTINATION_REASON }
      : group
  )

/**
 * Options offered by a move-group dialog: every group except the moved group
 * and its descendants (those would be rejected as cycles anyway). The implicit
 * "Ungrouped" (root) option is rendered by the component as `null`.
 */
export const moveGroupOptions = (doc, groupId) =>
  markArchivedDestinations(
    doc,
    findGroupsFlat(doc).filter((group) => group.id !== groupId && !isDescendant(doc, group.id, groupId))
  )

/** Move-session destinations: every custom group, archived ones disabled (§5.3). */
export const moveSessionOptions = (doc) => markArchivedDestinations(doc, findGroupsFlat(doc))

/** Whether `destinationId` can hold a delete-group relocation without violating the freeze. */
export const deleteGroupDestinationVerdict = (doc, groupId, destinationId = null) => {
  const group = findGroup(doc, groupId)
  if (!group) return { ok: false, reason: 'group-not-found' }
  if (effectiveArchived(doc, groupId)) return { ok: false, reason: GROUP_ARCHIVED }
  if (hasArchivedDescendant(doc, groupId)) return { ok: false, reason: GROUP_CONTAINS_ARCHIVED }
  if (destinationId !== null) {
    if (!findGroup(doc, destinationId)) return { ok: false, reason: 'parent-not-found' }
    if (effectiveArchived(doc, destinationId)) return { ok: false, reason: GROUP_DESTINATION_ARCHIVED }
  }
  try {
    deleteGroupTo(doc, groupId, destinationId)
    return { ok: true, reason: null }
  } catch (error) {
    return { ok: false, reason: archiveCodeOf(error) ?? error?.message ?? 'invalid' }
  }
}

/**
 * Destinations offered when deleting a non-empty group (0.2.9). Excludes the
 * group itself and every recursive descendant (cycle), and — when the group has
 * child groups — any destination whose depth cannot hold every direct child
 * subtree (`destinationDepth + 1 + subtreeHeight(child) > MAX_DEPTH`). Archived
 * destinations and destinations whose relocation would shift a frozen anchor
 * are listed but disabled with a reason (N5). The implicit root/ungrouped
 * option (`null`) is always offered by the component and validated separately.
 */
export const deleteGroupOptions = (doc, groupId) => {
  const group = findGroup(doc, groupId)
  if (!group) return []
  const childGroups = childrenOf(doc, groupId)
  const maxChildHeight = childGroups.reduce(
    (height, child) => Math.max(height, groupSubtreeHeight(doc, child.id)),
    0
  )
  const candidates = findGroupsFlat(doc).filter((candidate) => {
    if (candidate.id === groupId || isDescendant(doc, candidate.id, groupId)) return false
    if (childGroups.length === 0) return true
    return groupDepth(doc, candidate.id) + 1 + maxChildHeight <= MAX_DEPTH
  })
  return candidates.map((candidate) => {
    const verdict = deleteGroupDestinationVerdict(doc, groupId, candidate.id)
    if (verdict.ok || !isArchiveCode(verdict.reason)) return candidate
    return { ...candidate, disabled: true, disabledReason: ARCHIVED_DESTINATION_REASON }
  })
}

/**
 * 0.2.9 delete contract: a group with no direct sessions and no direct child
 * groups deletes immediately (no dialog); otherwise the destination picker is
 * required because sessions/children must be relocated first.
 */
export const deleteGroupNeedsDialog = (doc, groupId) => {
  const group = findGroup(doc, groupId)
  if (!group) return false
  return group.sessionIds.length > 0 || childrenOf(doc, groupId).length > 0
}

/**
 * Initial highlight for a selection dialog. `move-*` dialogs store the current
 * location in `currentId` (a group id or `null` for Ungrouped/root). Icon and
 * color dialogs start on the group's current value; new-session prefers the
 * inferred workspace. A missing/unusable value yields `undefined` (no
 * selection), which disables Confirm instead of silently defaulting to the
 * first row.
 */
export const initialDialogSelection = (dialog, doc) => {
  if (!dialog) return undefined
  switch (dialog.kind) {
    case 'icon': {
      const icons = Array.isArray(dialog.icons) ? dialog.icons : GROUP_ICONS
      return typeof dialog.current === 'string' && icons.includes(dialog.current) ? dialog.current : DEFAULT_ICON
    }
    case 'group-color': {
      const hex = normalizeColorHex(dialog.currentHex)
      if (hex) return hex
      return isKnownColor(dialog.current) ? dialog.current : DEFAULT_GROUP_COLOR
    }
    case 'move-session':
    case 'move-group':
      return dialog.currentId === undefined ? undefined : dialog.currentId
    default:
      return undefined
  }
}

/** Whether a highlighted value can be applied for this dialog. */
export const selectionIsValid = (dialog, selection, doc) => {
  if (!dialog) return false
  switch (dialog.kind) {
    case 'icon': {
      const icons = Array.isArray(dialog.icons) ? dialog.icons : GROUP_ICONS
      return typeof selection === 'string' && icons.includes(selection)
    }
    case 'group-color':
      return isKnownColor(selection) || isColorHex(selection)
    case 'move-session':
      if (selection === null) return true
      return typeof selection === 'string' && findGroup(doc, selection) !== null && !effectiveArchived(doc, selection)
    case 'move-group': {
      if (selection === null) return true
      if (typeof selection !== 'string' || selection === dialog.groupId) return false
      if (!findGroup(doc, selection)) return false
      if (effectiveArchived(doc, selection)) return false
      return !isDescendant(doc, selection, dialog.groupId)
    }
    case 'delete-group': {
      if (selection === null) return deleteGroupDestinationVerdict(doc, dialog.groupId, null).ok
      if (typeof selection !== 'string' || selection === dialog.groupId) return false
      const option = deleteGroupOptions(doc, dialog.groupId).find((group) => group.id === selection)
      return option !== undefined && option.disabled !== true
    }
    default:
      return false
  }
}

/** Payload handed to `confirmDialog` once the user confirms the selection. */
export const dialogConfirmPayload = (dialog, selection) => {
  if (!dialog) return {}
  switch (dialog.kind) {
    case 'icon':
      return { icon: selection }
    case 'group-color':
      return isColorHex(selection) ? { colorHex: selection } : { color: selection }
    case 'move-session':
    case 'move-group':
      return { groupId: selection }
    case 'delete-group':
      return selection === undefined ? {} : { destinationId: selection }
    default:
      return {}
  }
}

/** Current display value for the icon dialog (group icon at open time). */
export const currentIconOf = (doc, groupId) => findGroup(doc, groupId)?.icon ?? DEFAULT_ICON

/** Current display value for the color dialog (blue fallback for legacy docs). */
export const currentColorOf = (doc, groupId) => groupColor(findGroup(doc, groupId))

/** Current custom color at dialog-open time (null for palette/legacy groups). */
export const currentColorHexOf = (doc, groupId) => groupColorHex(findGroup(doc, groupId))

/** Current parent id for the move-group dialog (`null` means root). */
export const currentParentOf = (doc, groupId) => findGroup(doc, groupId)?.parentId ?? null

/** Current owning group id for the move-session dialog (`null` = ungrouped). */
export const currentGroupIdOf = (doc, sessionId) => {
  for (const group of doc.groups) {
    if (group.sessionIds.includes(sessionId)) return group.id
  }
  return null
}

/**
 * Precheck one menu move-up/move-down step (N5). The candidate document is
 * resolved against the complete doc, so a step that would shift a frozen
 * sibling anchor answers `{ ok: false, reason }` without writing anything.
 * Boundary steps (first/last sibling) answer `reason: null`; the caller keeps
 * its existing boundary-disabled presentation.
 *
 * @returns {{ ok: boolean, reason: string|null }}
 */
export const moveGroupStepPrecheck = (doc, groupId, delta) => {
  const group = findGroup(doc, groupId)
  if (!group || !Number.isInteger(delta)) return { ok: false, reason: null }
  const siblings = childrenOf(doc, group.parentId)
  const currentIndex = siblings.findIndex((item) => item.id === groupId)
  const nextIndex = currentIndex + delta
  if (currentIndex === -1 || nextIndex < 0 || nextIndex >= siblings.length) return { ok: false, reason: null }
  try {
    moveGroup(doc, groupId, group.parentId, nextIndex)
    return { ok: true, reason: null }
  } catch (error) {
    return { ok: false, reason: archiveCodeOf(error) ?? 'invalid' }
  }
}

/**
 * Resolve the numeric destination index for the move-group dialog (N5).
 *
 * The historical dialog always inserted the moved group as the first child
 * (index 0). That insertion can shift a frozen sibling anchor and is rejected
 * by the invariant even though the dialog is still legal. Appending is always
 * safe for existing children, so when index 0 violates the archive freeze the
 * resolved plan falls back to the end of the destination list (`append: true`).
 * An archived destination is never a valid target (the option is disabled).
 *
 * @returns {{ index: number|null, append: boolean, noop: boolean, reason: string|null }}
 */
export const moveGroupSafeIndex = (doc, groupId, parentId = null) => {
  const group = findGroup(doc, groupId)
  if (!group) return { index: null, append: false, noop: false, reason: 'group-not-found' }
  if (parentId !== null && effectiveArchived(doc, parentId)) {
    return { index: null, append: false, noop: false, reason: GROUP_DESTINATION_ARCHIVED }
  }
  try {
    moveGroup(doc, groupId, parentId, 0)
    return { index: 0, append: false, noop: false, reason: null }
  } catch (error) {
    const reason = archiveCodeOf(error)
    if (reason === null) return { index: null, append: false, noop: false, reason: error?.message ?? 'invalid' }
    // Already the last child: appending would reproduce the current position.
    const siblings = childrenOf(doc, parentId)
    if (group.parentId === parentId && siblings[siblings.length - 1]?.id === groupId) {
      return { index: null, append: false, noop: true, reason }
    }
    try {
      const count = siblings.length
      moveGroup(doc, groupId, parentId, count)
      return { index: count, append: true, noop: false, reason }
    } catch (appendError) {
      return { index: null, append: false, noop: false, reason: archiveCodeOf(appendError) ?? reason }
    }
  }
}

// ---------------------------------------------------------------------------
// Group-archive host policy (0.4.0-beta.62 §5.5/§8, P9/B1)
//
// `plugin-host.js` cannot be imported by `node --test` (it pulls host-only DSH
// packages), so the decisions its archive orchestration makes live here as pure
// functions: the confirmation boundary, the inline copy/refresh mapping for a
// structured failure, the post-archive visibility toast action and the pending
// new-session follow guard. The host only gathers inputs and performs effects.
// ---------------------------------------------------------------------------

/** Inline dialog copy keys for the structured archive-freeze failure family (§6.4; resources ship in P10). */
const ARCHIVE_FAILURE_DIALOG_KEYS = new Map([
  [GROUP_ARCHIVED, 'dialog.groupArchived'],
  [GROUP_CONTAINS_ARCHIVED, 'dialog.groupContainsArchived'],
  [GROUP_DESTINATION_ARCHIVED, 'dialog.destinationArchived'],
  [GROUP_POSITION_LOCKED, 'dialog.groupPositionLocked'],
  [ARCHIVE_FROZEN, 'dialog.archiveFrozen'],
])

/**
 * Whether archiving a group needs the confirmation dialog (N12): any direct
 * session, any direct child group, a running session anywhere in the subtree or
 * the session currently open in the main view. An empty leaf archives directly.
 *
 * @param {{ directSessions?: number, directChildGroups?: number, runningSessions?: number, currentSessionInside?: boolean }} [state]
 * @returns {boolean}
 */
export const archiveNeedsConfirm = ({
  directSessions = 0,
  directChildGroups = 0,
  runningSessions = 0,
  currentSessionInside = false,
} = {}) => directSessions > 0 || directChildGroups > 0 || runningSessions > 0 || currentSessionInside === true

/**
 * Whether the archive action must open the confirmation dialog (UI patch).
 * The persisted opt-out only suppresses a boundary that was actually needed:
 * strict equality keeps a missing, false or non-boolean skip value from
 * bypassing the confirmation by accident.
 *
 * @param {boolean} needsConfirm result of `archiveNeedsConfirm`
 * @param {boolean} skip persisted "don't ask again" flag
 * @returns {boolean}
 */
export const shouldConfirmGroupArchive = (needsConfirm, skip) => needsConfirm === true && skip !== true

/**
 * Inline dialog copy key for a structured archive-freeze failure, or `null` for
 * every other failure. A host-level `archive-frozen` rejection carries the
 * operation code in `reason`; a known reason refines the copy and an unknown one
 * falls back to the generic frozen message.
 *
 * @param {string|undefined|null} code structured error code
 * @param {string|null} [reason] operation code carried by an `archive-frozen` rejection
 * @returns {string|null}
 */
export const archiveFailureKey = (code, reason = null) => {
  if (code === ARCHIVE_FROZEN) {
    return (typeof reason === 'string' ? ARCHIVE_FAILURE_DIALOG_KEYS.get(reason) : undefined) ?? ARCHIVE_FAILURE_DIALOG_KEYS.get(ARCHIVE_FROZEN)
  }
  return typeof code === 'string' ? ARCHIVE_FAILURE_DIALOG_KEYS.get(code) ?? null : null
}

/** Whether a structured failure requires re-reading the document (`archive-frozen` only). */
export const archiveFailureNeedsRefresh = (code) => code === ARCHIVE_FROZEN

/**
 * Toast action for an archive/unarchive whose group is invisible under the
 * current filter. `hidden` + effectively archived offers "show archived";
 * `only` + no longer archived offers "show all". A visible result needs no
 * action, so every other combination answers `null`.
 *
 * @param {string} groupFilter
 * @param {boolean} effectiveArchivedAfter
 * @returns {'showArchived'|'showAll'|null}
 */
export const archiveVisibilityAction = (groupFilter, effectiveArchivedAfter) => {
  if (groupFilter === 'hidden' && effectiveArchivedAfter === true) return 'showArchived'
  if (groupFilter === 'only' && effectiveArchivedAfter !== true) return 'showAll'
  return null
}

/**
 * Whether a pending group-head new-session follow may still assign into its
 * target group (§8 follow race): the group must exist and not be effectively
 * archived. A missing or archived target cancels the intent instead of leaving
 * a half-moved blank.
 *
 * @param {object} doc
 * @param {string} groupId
 * @returns {boolean}
 */
export const pendingFollowShouldAssign = (doc, groupId) =>
  findGroup(doc, groupId) !== null && !effectiveArchived(doc, groupId)

/**
 * Whether a post-commit document proves the desired own-archive state (§5.5
 * B1). `commitStrict` adopts a CAS conflict as `result.doc`, so success is not
 * enough: the strict queue returns the *host's* document, which may still carry
 * the old flag or no longer contain the group. Only an existing group whose own
 * `archived` flag equals `archived` counts. A missing/false flag therefore
 * matches unarchive (legacy docs), while a deleted group never matches either
 * direction.
 *
 * @param {object} doc
 * @param {string} groupId
 * @param {boolean} archived desired own-archive flag
 * @returns {boolean}
 */
export const groupArchiveCommitMatches = (doc, groupId, archived) => {
  const group = findGroup(doc, groupId)
  if (!group) return false
  return (group.archived === true) === archived
}
