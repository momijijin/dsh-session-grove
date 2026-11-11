/**
 * Group archive domain kernel (0.4.0-beta.62).
 *
 * Pure projection helpers, the single-group archive mutator and the
 * frozen-subtree invariant shared by the model, host and control layers. This
 * module imports only `./constants.js`: `model.js` imports from here, so
 * importing the model back would create a cycle. DOM/React/DSH imports are
 * forbidden in `src/shared`.
 */

import { ARCHIVE_FILTERS, DEFAULT_GROUP_COLOR, DEFAULT_ICON, GROUP_COLORS, GROUP_ICONS } from './constants.js'

/** Structured operation errors (spec §6.4). Persistence type errors use `groupArchivedTypeError`. */
export const GROUP_ARCHIVED = 'group-archived'
export const GROUP_CONTAINS_ARCHIVED = 'group-contains-archived'
export const GROUP_DESTINATION_ARCHIVED = 'group-destination-archived'
export const GROUP_POSITION_LOCKED = 'group-position-locked'
/** Kind of a whole-commit violation (host maps it to a 409, spec §6.3). */
export const ARCHIVE_FROZEN = 'archive-frozen'

/** `validateDoc` error for a persisted `archived` value that is not a boolean (N7 naming). */
export const groupArchivedTypeError = (groupId) => `group-archived-type:${groupId}`

const groupsOf = (doc) => (Array.isArray(doc?.groups) ? doc.groups : [])

const indexGroups = (doc) => {
  const byId = new Map()
  for (const group of groupsOf(doc)) {
    if (group && typeof group.id === 'string' && !byId.has(group.id)) byId.set(group.id, group)
  }
  return byId
}

const parentIdOf = (group) => group?.parentId ?? null

const kidsOf = (groups, parentId) => groups.filter((group) => parentIdOf(group) === (parentId ?? null))

const childIdsOf = (groups, groupId) => kidsOf(groups, groupId).map((group) => group.id)

const siblingIndexOf = (groups, group) => childIdsOf(groups, parentIdOf(group)).indexOf(group.id)

/** `group.archived === true`; missing, `false` and every other value read as not archived. */
export const isOwnArchived = (group) => group?.archived === true

/**
 * Persistence normalization: missing and non-boolean values read as `false`.
 * Invalid persisted types are rejected by `validateDoc` (not repaired here).
 */
export const normalizeGroupArchived = (value) => value === true

/**
 * Local clone/lookup helpers: `model.js` re-exports `setGroupArchived` and
 * imports from this module, so importing the model back would create a cycle.
 */
const cloneDoc = (doc) => JSON.parse(JSON.stringify(doc))

const findGroupInDoc = (doc, groupId) =>
  groupsOf(doc).find((group) => group.id === groupId) ?? null

/**
 * Toggle a group's own `archived` flag (0.4.0-beta.62). Never cascades: child
 * groups and session archive state keep their own flags. The switch itself is
 * always legal (even inside an archived subtree) because the invariant ignores
 * the flag. A same-value request returns the input doc unchanged so the control
 * layer can answer `no-change` without bumping the revision; an unarchive
 * writes an explicit `false` (missing and `false` are equivalent on read).
 */
export const setGroupArchived = (doc, groupId, archived) => {
  const group = findGroupInDoc(doc, groupId)
  if (!group) throw new Error('group-not-found')
  const nextValue = normalizeGroupArchived(archived)
  if (normalizeGroupArchived(group.archived) === nextValue) return doc
  const next = cloneDoc(doc)
  findGroupInDoc(next, groupId).archived = nextValue
  return next
}

/**
 * Own flag plus the inherited state derived from the ancestor chain.
 * `archivedBy` is the nearest archived group id (self when own-archived) and
 * `null` when the group is not effectively archived. Defensive against cycles
 * in corrupt docs (`validateDoc` already rejects them).
 */
export const archivedInfo = (doc, groupId) => {
  const byId = indexGroups(doc)
  const start = byId.get(groupId) ?? null
  const own = isOwnArchived(start)
  const seen = new Set()
  let current = start
  let archivedBy = null
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (isOwnArchived(current) && archivedBy === null) archivedBy = current.id
    current = current.parentId === null || current.parentId === undefined ? null : byId.get(current.parentId) ?? null
  }
  return { own, effective: archivedBy !== null, archivedBy }
}

export const effectiveArchived = (doc, groupId) => archivedInfo(doc, groupId).effective

/**
 * True when any recursive descendant is effectively archived. Children of an
 * archived group inherit the flag, so an archived group with at least one child
 * answers `true`. Cycles terminate via the visited set.
 */
export const hasArchivedDescendant = (doc, groupId) => {
  const groups = groupsOf(doc)
  if (!indexGroups(doc).has(groupId)) return false
  const inherited = effectiveArchived(doc, groupId)
  const seen = new Set([groupId])
  const stack = kidsOf(groups, groupId).map((group) => ({ group, inherited }))
  while (stack.length > 0) {
    const { group, inherited: inheritedFlag } = stack.pop()
    if (seen.has(group.id)) continue
    seen.add(group.id)
    const effective = inheritedFlag || isOwnArchived(group)
    if (effective) return true
    for (const child of kidsOf(groups, group.id)) stack.push({ group: child, inherited: effective })
  }
  return false
}

/** Effective-archived id set for `doc` (memoized up the parent chain, cycle-safe). */
const effectiveArchivedSet = (doc) => {
  const byId = indexGroups(doc)
  const memo = new Map()
  const resolving = new Set()
  const resolve = (groupId) => {
    if (groupId === null || groupId === undefined) return false
    if (memo.has(groupId)) return memo.get(groupId)
    const group = byId.get(groupId)
    if (!group) return false
    if (resolving.has(groupId)) return false
    resolving.add(groupId)
    const effective = isOwnArchived(group) || resolve(parentIdOf(group))
    resolving.delete(groupId)
    memo.set(groupId, effective)
    return effective
  }
  const frozen = new Set()
  for (const groupId of byId.keys()) if (resolve(groupId)) frozen.add(groupId)
  return frozen
}

/**
 * Group-level visibility for one group filter (spec §4.2, 0.4.0-beta.62).
 *
 * Pure projection over the confirmed doc; the render tree, search results and
 * status counters all consume this so the three views cannot drift apart.
 *
 * - `full` is always the effective-archived id set (`own || ancestor`).
 * - `path` holds the non-archived ancestors that keep a header under `only`
 *   because a `full` descendant exists. It is empty for `hidden`/`all`, where
 *   such ancestors render normally.
 * - `sessionGroups` is the set of groups whose own sessions may render:
 *   every non-`full` group under `hidden`, every group under `all`, and only
 *   `full` groups under `only` (`path` rows never contribute sessions).
 * - `ungroupedVisible` follows N1: the ungrouped container is hidden under
 *   `only` and visible otherwise.
 *
 * Defensive against corrupt docs: cycle-safe walks, unknown parents stop the
 * chain, and unknown filter values fall back to `hidden`.
 */
export const computeGroupVisibility = (doc, groupFilter = 'hidden') => {
  const filter = ARCHIVE_FILTERS.includes(groupFilter) ? groupFilter : 'hidden'
  const byId = indexGroups(doc)
  const full = effectiveArchivedSet(doc)
  const path = new Set()
  if (filter === 'only') {
    for (const groupId of full) {
      let current = byId.get(groupId) ?? null
      const seen = new Set([groupId])
      while (current) {
        const parentId = parentIdOf(current)
        const parent = parentId === null ? null : byId.get(parentId) ?? null
        if (!parent || seen.has(parent.id)) break
        seen.add(parent.id)
        if (full.has(parent.id)) {
          current = parent
          continue
        }
        path.add(parent.id)
        current = parent
      }
    }
  }
  const sessionGroups = new Set()
  if (filter === 'only') {
    for (const groupId of full) sessionGroups.add(groupId)
  } else {
    for (const groupId of byId.keys()) {
      if (filter === 'all' || !full.has(groupId)) sessionGroups.add(groupId)
    }
  }
  return { full, path, sessionGroups, ungroupedVisible: filter !== 'only' }
}

const asString = (value) => (typeof value === 'string' ? value : '')

const normalizedName = (group) => asString(group?.name).trim()
const normalizedIcon = (group) => (GROUP_ICONS.includes(group?.icon) ? group.icon : DEFAULT_ICON)
const normalizedColor = (group) => (GROUP_COLORS.includes(group?.color) ? group.color : DEFAULT_GROUP_COLOR)

/** Canonical lowercase `#rrggbb`, or `null` when absent. Mirrors `model.normalizeColorHex`. */
const normalizedColorHex = (value) => {
  if (typeof value !== 'string') return null
  const raw = value.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`.toLowerCase()
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`
  return null
}

const sameIdOrder = (left, right) => left.length === right.length && left.every((id, index) => id === right[index])

const sameIdSet = (left, right) => left.length === right.length && left.every((id) => right.includes(id))

/** `before` is a subsequence of the strictly longer `after`: ids were only added. */
const addedIdsOnly = (before, after) => {
  if (after.length <= before.length) return false
  let cursor = 0
  for (const id of after) if (cursor < before.length && id === before[cursor]) cursor += 1
  return cursor === before.length
}

const violation = (code, groupId, field) => ({ code, groupId, field })

/**
 * Find the first frozen-subtree violation between two documents.
 *
 * For every group that is effectively archived in `before` the fingerprint is:
 * normalized `name`/`icon`/`color`/`colorHex`, `parentId`, full children index,
 * `sessionIds` order, direct child-group id order, and each ancestor's
 * `parentId` + children index (ancestor metadata is intentionally ignored).
 * The group's own `archived` flag is the only allowed change; groups that were
 * not archived in `before` are never checked, so `archive + edit` is legal
 * while `unarchive + edit` is not (strict before-state).
 *
 * Codes: `group-archived` (the frozen target changed/was deleted),
 * `group-contains-archived` (an ancestor moved/was deleted),
 * `group-destination-archived` (content was inserted into a frozen group),
 * `group-position-locked` (a frozen anchor shifted indirectly).
 */
export const findArchiveViolation = (before, after) => {
  const beforeGroups = groupsOf(before)
  const afterGroups = groupsOf(after)
  const afterById = indexGroups(after)
  const frozen = effectiveArchivedSet(before)
  if (frozen.size === 0) return null

  // Ancestors of a frozen subtree keep their own anchor: moving/removing them
  // would relocate the frozen anchor. Their metadata stays free to change.
  for (const group of beforeGroups) {
    if (!group || frozen.has(group.id)) continue
    if (!hasArchivedDescendant(before, group.id)) continue
    const now = afterById.get(group.id) ?? null
    if (!now) return violation(GROUP_CONTAINS_ARCHIVED, group.id, 'deleted')
    if (parentIdOf(group) !== parentIdOf(now)) return violation(GROUP_CONTAINS_ARCHIVED, group.id, 'parentId')
    if (siblingIndexOf(beforeGroups, group) !== siblingIndexOf(afterGroups, now)) {
      const indirect = !sameIdSet(childIdsOf(beforeGroups, parentIdOf(group)), childIdsOf(afterGroups, parentIdOf(now)))
      return violation(indirect ? GROUP_POSITION_LOCKED : GROUP_CONTAINS_ARCHIVED, group.id, 'index')
    }
  }

  // Frozen groups themselves: compare every fingerprint field normalized.
  for (const group of beforeGroups) {
    if (!group || !frozen.has(group.id)) continue
    const now = afterById.get(group.id) ?? null
    if (!now) return violation(GROUP_ARCHIVED, group.id, 'deleted')
    if (normalizedName(group) !== normalizedName(now)) return violation(GROUP_ARCHIVED, group.id, 'name')
    if (normalizedIcon(group) !== normalizedIcon(now)) return violation(GROUP_ARCHIVED, group.id, 'icon')
    if (normalizedColor(group) !== normalizedColor(now)) return violation(GROUP_ARCHIVED, group.id, 'color')
    if (normalizedColorHex(group.colorHex) !== normalizedColorHex(now.colorHex)) {
      return violation(GROUP_ARCHIVED, group.id, 'colorHex')
    }
    const parentId = parentIdOf(group)
    if (parentId !== parentIdOf(now)) return violation(GROUP_ARCHIVED, group.id, 'parentId')
    const sessionsBefore = Array.isArray(group.sessionIds) ? group.sessionIds : []
    const sessionsAfter = Array.isArray(now.sessionIds) ? now.sessionIds : []
    if (!sameIdOrder(sessionsBefore, sessionsAfter)) {
      const added = addedIdsOnly(sessionsBefore, sessionsAfter)
      return violation(added ? GROUP_DESTINATION_ARCHIVED : GROUP_ARCHIVED, group.id, 'sessionIds')
    }
    const childrenBefore = childIdsOf(beforeGroups, group.id)
    const childrenAfter = childIdsOf(afterGroups, group.id)
    if (!sameIdOrder(childrenBefore, childrenAfter)) {
      const added = addedIdsOnly(childrenBefore, childrenAfter)
      return violation(added ? GROUP_DESTINATION_ARCHIVED : GROUP_ARCHIVED, group.id, 'children')
    }
    if (siblingIndexOf(beforeGroups, group) !== siblingIndexOf(afterGroups, now)) {
      const indirect = !sameIdSet(childIdsOf(beforeGroups, parentId), childIdsOf(afterGroups, parentId))
      return violation(indirect ? GROUP_POSITION_LOCKED : GROUP_ARCHIVED, group.id, 'index')
    }
  }
  return null
}

/**
 * Throw the structured invariant violation (message = `code`) for `after` relative
 * to `before`. The error carries `kind: 'archive-frozen'` plus `code`,
 * `groupId` and `field` for host/control response mapping.
 */
export const assertArchiveInvariant = (before, after) => {
  const found = findArchiveViolation(before, after)
  if (found === null) return
  const error = new Error(found.code)
  error.kind = ARCHIVE_FROZEN
  error.code = found.code
  error.groupId = found.groupId
  error.field = found.field
  throw error
}
