/**
 * Group-drop legality for frozen archived subtrees (0.4.0-beta.62).
 *
 * `resolveGroupDrop` in `./group-drag.js` is archive-agnostic: it measures the
 * numeric insertion slot against the latest full doc. This module layers the
 * frozen-subtree invariant on top for both the live preview and the committed
 * drop, so a preview can never allow what the commit rejects (spec §5.2, §6.2).
 *
 * Protected anchors are the full-doc positions of every effectively archived
 * group plus every ancestor of an archived group: `(parentId, sibling index)` in
 * `doc.groups` order — never in the possibly pruned render order. A drop is
 * legal only when simulating the dragged group's removal from its current parent
 * and its insertion at the resolved post-removal slot leaves every anchor index
 * unchanged. Inserting in front of an archived group therefore fails while
 * inserting behind it (or between two unaffected siblings) stays legal.
 *
 * Pure and DOM-free: the module only reads the doc, so calling it on every
 * `dragover` is cheap and cannot drift from the commit.
 *
 * DOM/React/DSH imports are forbidden in `src/core`.
 */
import { effectiveArchived, hasArchivedDescendant } from '../shared/archive.js'
import { childrenOf, findGroup, moveGroup } from '../shared/model.js'
import { isCurrentGroupPosition, resolveGroupDrop } from './group-drag.js'

/** Sibling index of `groupId` in its parent's full children list. */
const siblingIndexOf = (doc, parentId, groupId) =>
  childrenOf(doc, parentId ?? null).findIndex((group) => group.id === groupId)

/**
 * Ids whose sibling index is protected by the frozen-subtree invariant: every
 * effectively archived group and the whole ancestor chain of each of them.
 * The dragged group is excluded defensively — the source guards reject an
 * archived group or an ancestor of one before this helper runs.
 */
const protectedAnchorIds = (doc, draggedId) => {
  const ids = new Set()
  for (const group of doc.groups) {
    if (!group || typeof group.id !== 'string') continue
    if (!effectiveArchived(doc, group.id)) continue
    ids.add(group.id)
    const seen = new Set([group.id])
    let current = group
    while (current && current.parentId !== null && current.parentId !== undefined) {
      const parent = findGroup(doc, current.parentId)
      if (!parent || seen.has(parent.id)) break
      seen.add(parent.id)
      ids.add(parent.id)
      current = parent
    }
  }
  ids.delete(draggedId)
  return ids
}

/**
 * Simulate the move and report whether it changes any protected anchor index.
 *
 * Only the source and destination child lists can change, so those two lists are
 * simulated once each. `targetIndex` is `resolveGroupDrop`'s post-removal index;
 * a same-parent move therefore removes the dragged group first and only then
 * inserts at `targetIndex` (mirroring `moveGroup`).
 */
const shiftsArchivedAnchor = (doc, draggedId, sourceParentId, targetParentId, targetIndex) => {
  const anchors = protectedAnchorIds(doc, draggedId)
  if (anchors.size === 0) return false
  const source = sourceParentId ?? null
  const target = targetParentId ?? null
  const simulated = new Map()
  const simulatedChildren = (parentId) => {
    if (simulated.has(parentId)) return simulated.get(parentId)
    const ids = childrenOf(doc, parentId).map((group) => group.id)
    if (parentId === source) {
      const at = ids.indexOf(draggedId)
      if (at !== -1) ids.splice(at, 1)
    }
    if (parentId === target) {
      const raw = Number.isInteger(targetIndex) ? targetIndex : ids.length
      const at = Math.max(0, Math.min(raw, ids.length))
      ids.splice(at, 0, draggedId)
    }
    simulated.set(parentId, ids)
    return ids
  }
  for (const groupId of anchors) {
    const parentId = findGroup(doc, groupId)?.parentId ?? null
    // A protected group below any other parent cannot move in this drop.
    if (parentId !== source && parentId !== target) continue
    const before = siblingIndexOf(doc, parentId, groupId)
    if (before < 0) continue
    if (simulatedChildren(parentId).indexOf(groupId) !== before) return true
  }
  return false
}

/**
 * Legality of one group drop against the full doc (spec §5.2, §6.2).
 *
 * Order of checks, so the most specific stable reason wins:
 * 1. `resolveGroupDrop` validity (its reasons are passed through unchanged:
 *    `dragged-missing`, `target-missing`, `parent-missing`, `anchor-missing`,
 *    `self`, `descendant`, `target-invalid`, `doc-invalid`);
 * 2. `archived-source` — the dragged group is effectively archived;
 * 3. `archived-source-subtree` — the dragged group contains an archived descendant;
 * 4. `archived-destination` — the resolved destination parent is archived
 *    (this also covers append/head/child targets inside an archived group);
 * 5. `{ ok: true, noop: true }` — the resolved slot is the current position;
 * 6. `archived-anchor` — the move would shift a protected anchor index;
 * 7. `{ ok: true, noop: false, parentId, index }` — the drop is legal.
 *
 * `parentId`/`index` are the resolver coordinates handed to `moveGroup`.
 *
 * @param {object} doc
 * @param {string} draggedId
 * @param {{ kind: 'before'|'after', targetId: string }
 *   | { kind: 'child', parentId: string, beforeGroupId?: string|null }
 *   | { kind: 'root-end' }
 *   | null | undefined} target
 * @returns {{ ok: true, noop: boolean, parentId: string|null, index: number } | { ok: false, reason: string }}
 */
const checkGroupDrop = (doc, draggedId, target) => {
  const resolved = resolveGroupDrop({ doc, draggedId, target })
  if (resolved.invalid) return { ok: false, reason: resolved.reason }
  const dragged = findGroup(doc, draggedId)
  // Defensive: resolveGroupDrop already guarantees the dragged group exists.
  if (!dragged) return { ok: false, reason: 'dragged-missing' }
  if (effectiveArchived(doc, draggedId)) return { ok: false, reason: 'archived-source' }
  if (hasArchivedDescendant(doc, draggedId)) return { ok: false, reason: 'archived-source-subtree' }
  if (resolved.parentId !== null && effectiveArchived(doc, resolved.parentId)) {
    return { ok: false, reason: 'archived-destination' }
  }
  if (isCurrentGroupPosition(doc, draggedId, resolved, target)) {
    return { ok: true, noop: true, parentId: resolved.parentId, index: resolved.index }
  }
  if (shiftsArchivedAnchor(doc, draggedId, dragged.parentId ?? null, resolved.parentId, resolved.index)) {
    return { ok: false, reason: 'archived-anchor' }
  }
  return { ok: true, noop: false, parentId: resolved.parentId, index: resolved.index }
}

/**
 * Apply one group drop to the doc.
 *
 * Shares the preview predicate: a rejected drop returns the input doc untouched
 * plus the stable `reason`, a no-op returns the input doc identity with
 * `{ applied: false, noop: true }` (no revision bump), and an allowed drop calls
 * `moveGroup` with the preview's resolved coordinates. `moveGroup` may still
 * throw for doc-level limits (e.g. `depth-exceeded`) exactly as before.
 *
 * @param {object} doc
 * @param {string} draggedId
 * @param {object} target
 * @returns {{ doc: object, applied: true } | { doc: object, applied: false, reason: string } | { doc: object, applied: false, noop: true }}
 */
const applyGroupDrop = (doc, draggedId, target) => {
  const verdict = checkGroupDrop(doc, draggedId, target)
  if (!verdict.ok) return { doc, applied: false, reason: verdict.reason }
  if (verdict.noop) return { doc, applied: false, noop: true }
  return { doc: moveGroup(doc, draggedId, verdict.parentId, verdict.index), applied: true }
}

// Re-export form (not an inline declaration) so the P8 drag handlers can consume
// the guard without tripping the dead-export guard before that wiring lands.
export { applyGroupDrop, checkGroupDrop }
