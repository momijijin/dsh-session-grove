// tests/client/dialog-selection.test.js
//
// 0.2.6 selection-dialog contract: icon / move-to-group (session + group) /
// new-session workspace / group-color dialogs open on a visible current or
// inferred value, only accept known options, and hand Confirm a strict payload.
// The component renders these states; these pure helpers are the single source
// for initial highlight, validity and payload.

import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_GROUP_COLOR, GROUP_COLORS, GROUP_ICONS } from '../../src/shared/constants.js'
import {
  createGroup,
  emptyDoc,
  findGroup,
  moveGroup,
  normalizeColor,
  setGroupArchived,
} from '../../src/shared/model.js'
import {
  ARCHIVED_DESTINATION_REASON,
  archiveFailureKey,
  archiveFailureNeedsRefresh,
  archiveNeedsConfirm,
  archiveVisibilityAction,
  currentColorHexOf,
  currentColorOf,
  currentGroupIdOf,
  currentIconOf,
  currentParentOf,
  deleteGroupDestinationVerdict,
  deleteGroupNeedsDialog,
  deleteGroupOptions,
  dialogConfirmPayload,
  findGroupsFlat,
  groupArchiveCommitMatches,
  initialDialogSelection,
  isSelectionDialog,
  moveGroupOptions,
  moveGroupSafeIndex,
  moveGroupStepPrecheck,
  moveSessionOptions,
  pendingFollowShouldAssign,
  selectionIsValid,
  shouldConfirmGroupArchive,
  SELECTION_DIALOG_KINDS,
} from '../../src/core/dialog-selection.js'

/** Root A -> child B; root C with one session; session s1 in A, s2 ungrouped. */
const fixture = () => {
  let doc = createGroup(emptyDoc(), { name: 'A', color: 'purple' })
  const a = doc.groups[0].id
  doc = createGroup(doc, { name: 'B', parentId: a })
  const b = doc.groups[1].id
  doc = createGroup(doc, { name: 'C' })
  const c = doc.groups.find((group) => group.name === 'C').id
  doc = createGroup(doc, { name: 'B-child', parentId: b })
  const bChild = doc.groups[3].id
  doc = { ...doc, groups: doc.groups.map((group) => (group.id === a ? { ...group, sessionIds: ['s1'] } : group)) }
  return { doc, a, b, c, bChild }
}

test('selection dialog kinds are exactly the small pickers plus group-color and delete-group', () => {
  assert.deepEqual([...SELECTION_DIALOG_KINDS], [
    'move-session',
    'move-group',
    'icon',
    'group-color',
    'delete-group',
  ])
  for (const kind of SELECTION_DIALOG_KINDS) assert.equal(isSelectionDialog(kind), true)
  for (const kind of ['new-group', 'rename-group', 'rename-session', 'archive-running']) {
    assert.equal(isSelectionDialog(kind), false)
  }
})

test('initial highlight: current icon/color/parent/group, inferred workspace, else none', () => {
  const { doc, a, b } = fixture()
  assert.equal(initialDialogSelection({ kind: 'icon', current: 'star', icons: GROUP_ICONS }, doc), 'star')
  assert.equal(initialDialogSelection({ kind: 'icon', current: 'nope', icons: GROUP_ICONS }, doc), GROUP_ICONS[0])
  assert.equal(initialDialogSelection({ kind: 'group-color', current: 'orange' }, doc), 'orange')
  assert.equal(initialDialogSelection({ kind: 'group-color' }, doc), DEFAULT_GROUP_COLOR)
  assert.equal(initialDialogSelection({ kind: 'move-session', currentId: a }, doc), a)
  assert.equal(initialDialogSelection({ kind: 'move-session', currentId: null }, doc), null)
  assert.equal(initialDialogSelection({ kind: 'move-group', currentId: b }, doc), b)
  assert.equal(initialDialogSelection({ kind: 'move-group', currentId: null }, doc), null)
  assert.equal(initialDialogSelection({ kind: 'move-session' }, doc), undefined, 'missing current => nothing selected')
  assert.equal(initialDialogSelection(null, doc), undefined)
})

test('validity: only offered options confirm; move-group rejects self and descendants', () => {
  const { doc, a, b, c, bChild } = fixture()
  assert.equal(selectionIsValid({ kind: 'icon', icons: ['folder', 'star'] }, 'star', doc), true)
  assert.equal(selectionIsValid({ kind: 'icon', icons: ['folder', 'star'] }, 'rocket', doc), false)
  for (const color of GROUP_COLORS) assert.equal(selectionIsValid({ kind: 'group-color' }, color, doc), true)
  for (const bad of ['chartreuse', '', undefined, null, 3]) {
    assert.equal(selectionIsValid({ kind: 'group-color' }, bad, doc), false, `color ${String(bad)} must be invalid`)
  }
  assert.equal(selectionIsValid({ kind: 'move-session' }, a, doc), true)
  assert.equal(selectionIsValid({ kind: 'move-session' }, null, doc), true, 'Ungrouped is a valid move-session target')
  assert.equal(selectionIsValid({ kind: 'move-session' }, 'missing', doc), false)
  assert.equal(selectionIsValid({ kind: 'move-session' }, undefined, doc), false)
  assert.equal(selectionIsValid({ kind: 'move-group', groupId: c }, null, doc), true, 'root is a valid move-group target')
  assert.equal(selectionIsValid({ kind: 'move-group', groupId: c }, a, doc), true)
  assert.equal(selectionIsValid({ kind: 'move-group', groupId: a }, a, doc), false, 'cannot move into itself')
  assert.equal(selectionIsValid({ kind: 'move-group', groupId: a }, b, doc), false, 'cannot move into its child')
  assert.equal(selectionIsValid({ kind: 'move-group', groupId: a }, bChild, doc), false, 'cannot move into a deeper descendant')
  assert.equal(selectionIsValid({ kind: 'move-group', groupId: c }, 'missing', doc), false)
})

test('unknown dialog kinds are invalid and never produce a partial payload', () => {
  assert.equal(selectionIsValid({ kind: 'unknown-dialog' }, 'x', {}), false)
  assert.deepEqual(dialogConfirmPayload(null, 'x'), {})
  assert.deepEqual(dialogConfirmPayload({ kind: 'unknown-dialog' }, 'x'), {})
})

test('confirm payloads map to the host/model contract', () => {
  assert.deepEqual(dialogConfirmPayload({ kind: 'icon' }, 'star'), { icon: 'star' })
  assert.deepEqual(dialogConfirmPayload({ kind: 'group-color' }, 'purple'), { color: 'purple' })
  assert.deepEqual(dialogConfirmPayload({ kind: 'move-session' }, 'g1'), { groupId: 'g1' })
  assert.deepEqual(dialogConfirmPayload({ kind: 'move-session' }, null), { groupId: null })
  assert.deepEqual(dialogConfirmPayload({ kind: 'move-group' }, null), { groupId: null })
  assert.deepEqual(dialogConfirmPayload({ kind: 'delete-group' }, undefined), {})
})

test('move options: flat list preserves sibling order/depth; move-group excludes the cycle subtree', () => {
  const { doc, a, b, c, bChild } = fixture()
  const flat = findGroupsFlat(doc)
  assert.deepEqual(flat.map((group) => [group.name, group.depth]), [
    ['A', 0],
    ['B', 1],
    ['B-child', 2],
    ['C', 0],
  ])
  assert.deepEqual(moveGroupOptions(doc, a).map((group) => group.id), [c], 'self and descendants are not offered')
  assert.deepEqual(moveGroupOptions(doc, b).map((group) => group.id), [a, c], 'parent stays a valid target')
  assert.equal(moveGroupOptions(doc, c).some((group) => group.id === bChild), true)
})

test('delete options exclude self and the recursive subtree, and keep root implicit', () => {
  const { doc, a, b, c, bChild } = fixture()
  assert.deepEqual(deleteGroupOptions(doc, a).map((group) => group.id), [c])
  assert.deepEqual(deleteGroupOptions(doc, b).map((group) => group.id), [a, c], 'the parent stays a valid destination')
  assert.deepEqual(deleteGroupOptions(doc, c).map((group) => group.id), [a, b, bChild])
  assert.deepEqual(deleteGroupOptions(doc, 'missing'), [])
})

test('delete options exclude destinations too shallow for a child subtree (root stays allowed)', () => {
  let deep = createGroup(emptyDoc(), { name: 'T' })
  const target = deep.groups[0].id
  let parentId = target
  const chain = []
  for (let i = 1; i <= 7; i += 1) {
    deep = createGroup(deep, { name: `C${i}`, parentId })
    parentId = deep.groups.find((group) => group.name === `C${i}`).id
    chain.push(parentId)
  }
  deep = createGroup(deep, { name: 'D1' })
  const d1 = deep.groups.find((group) => group.name === 'D1').id
  deep = createGroup(deep, { name: 'D2', parentId: d1 })
  const d2 = deep.groups.find((group) => group.name === 'D2').id
  const options = deleteGroupOptions(deep, target)
  assert.deepEqual(options.map((group) => group.id), [d1], 'depth-2 D2 is excluded, depth-1 D1 fits')
  for (const id of [target, ...chain, d2]) {
    assert.equal(options.some((group) => group.id === id), false, `${id} must not be offered`)
  }
})

test('delete dialog selection: no default, root/valid destinations confirm, invalid ones cannot', () => {
  const { doc, a, b, c, bChild } = fixture()
  assert.equal(initialDialogSelection({ kind: 'delete-group', groupId: a }, doc), undefined)
  assert.equal(selectionIsValid({ kind: 'delete-group', groupId: a }, null, doc), true, 'root/ungrouped is valid')
  assert.equal(selectionIsValid({ kind: 'delete-group', groupId: a }, c, doc), true)
  assert.equal(selectionIsValid({ kind: 'delete-group', groupId: a }, a, doc), false, 'self is not a destination')
  assert.equal(selectionIsValid({ kind: 'delete-group', groupId: a }, b, doc), false, 'child is not a destination')
  assert.equal(selectionIsValid({ kind: 'delete-group', groupId: a }, bChild, doc), false, 'grandchild is not a destination')
  assert.equal(selectionIsValid({ kind: 'delete-group', groupId: a }, 'missing', doc), false)
  assert.equal(selectionIsValid({ kind: 'delete-group', groupId: a }, undefined, doc), false)
  assert.deepEqual(dialogConfirmPayload({ kind: 'delete-group' }, null), { destinationId: null })
  assert.deepEqual(dialogConfirmPayload({ kind: 'delete-group' }, c), { destinationId: c })
  assert.deepEqual(dialogConfirmPayload({ kind: 'delete-group' }, undefined), {})
})

test('delete dialog is only required when the group has sessions or direct child groups', () => {
  const { doc, a, b, c } = fixture()
  assert.equal(deleteGroupNeedsDialog(doc, a), true, 'a direct session requires a destination')
  assert.equal(deleteGroupNeedsDialog(doc, b), true, 'a direct child group requires a destination')
  assert.equal(deleteGroupNeedsDialog(doc, c), false, 'empty leaf deletes directly')
  assert.equal(deleteGroupNeedsDialog(doc, 'missing'), false)
})

test('custom colorHex selection: current custom wins, validity and payload are distinct', () => {
  assert.equal(initialDialogSelection({ kind: 'group-color', current: 'purple', currentHex: '#A1B2C3' }, {}), '#a1b2c3')
  assert.equal(initialDialogSelection({ kind: 'group-color', current: 'purple', currentHex: 'not-hex' }, {}), 'purple')
  assert.equal(selectionIsValid({ kind: 'group-color' }, '#a1b2c3', {}), true)
  assert.equal(selectionIsValid({ kind: 'group-color' }, '#A1B2C3', {}), false, 'selection is canonical')
  assert.equal(selectionIsValid({ kind: 'group-color' }, 'purple', {}), true)
  assert.equal(selectionIsValid({ kind: 'group-color' }, undefined, {}), false)
  assert.deepEqual(dialogConfirmPayload({ kind: 'group-color' }, '#a1b2c3'), { colorHex: '#a1b2c3' })
  assert.deepEqual(dialogConfirmPayload({ kind: 'group-color' }, 'gray'), { color: 'gray' })
})


test('current value helpers: icon/color/parent/owning group with blue/root defaults', () => {
  const { doc, a, b, c } = fixture()
  assert.equal(currentIconOf(doc, a), 'hash', 'new groups default to the hash icon')
  assert.equal(currentColorOf(doc, a), 'purple')
  assert.equal(currentColorOf(doc, c), 'blue', 'legacy/missing color displays blue')
  assert.equal(currentColorOf(doc, 'missing'), 'blue')
  assert.equal(currentColorHexOf(doc, a), null)
  assert.equal(currentParentOf(doc, b), a)
  assert.equal(currentParentOf(doc, a), null)
  assert.equal(currentParentOf(doc, 'missing'), null)
  assert.equal(currentGroupIdOf(doc, 's1'), a)
  assert.equal(currentGroupIdOf(doc, 's2'), null, 'ungrouped sessions start on the Ungrouped option')
  assert.equal(currentGroupIdOf(doc, 'missing'), null)
  assert.equal(normalizeColor(findGroup(doc, a).color), 'purple')
})

// ---------------------------------------------------------------------------
// 0.4.0-beta.62 archive freeze: destination guards (P9)
// ---------------------------------------------------------------------------

/**
 * Root order: D (archived, owns D-child) first, then A (owns B + session s1),
 * then C. Deleting A therefore never shifts the frozen D anchor.
 */
const archivedFixture = () => {
  let doc = createGroup(emptyDoc(), { name: 'D' })
  const d = doc.groups[0].id
  doc = createGroup(doc, { name: 'D-child', parentId: d })
  const dChild = doc.groups.find((group) => group.name === 'D-child').id
  doc = createGroup(doc, { name: 'A' })
  const a = doc.groups.find((group) => group.name === 'A').id
  doc = createGroup(doc, { name: 'B', parentId: a })
  const b = doc.groups.find((group) => group.name === 'B').id
  doc = createGroup(doc, { name: 'C' })
  const c = doc.groups.find((group) => group.name === 'C').id
  doc = { ...doc, groups: doc.groups.map((group) => (group.id === a ? { ...group, sessionIds: ['s1'] } : group)) }
  doc = setGroupArchived(doc, d, true)
  return { doc, a, b, c, d, dChild }
}

test('0.4.0-beta.62 move/delete/move-session destinations list archived groups disabled with a reason', () => {
  const { doc, a, b, c, d, dChild } = archivedFixture()
  const moveOptions = moveGroupOptions(doc, a)
  const archivedOption = moveOptions.find((group) => group.id === d)
  assert.equal(archivedOption.disabled, true)
  assert.equal(archivedOption.disabledReason, ARCHIVED_DESTINATION_REASON)
  assert.equal(moveOptions.find((group) => group.id === dChild).disabled, true, 'inherited archive state disables too')
  assert.equal(moveOptions.find((group) => group.id === b), undefined, 'the moved group subtree is not offered')

  const sessionOptions = moveSessionOptions(doc)
  assert.equal(sessionOptions.find((group) => group.id === d).disabled, true)
  assert.equal(sessionOptions.find((group) => group.id === a).disabled, undefined)

  const deleteOptions = deleteGroupOptions(doc, a)
  assert.equal(deleteOptions.find((group) => group.id === d).disabled, true)
  assert.equal(deleteOptions.find((group) => group.id === c).disabled, undefined)
  assert.equal(deleteGroupDestinationVerdict(doc, a, d).reason, 'group-destination-archived')
})

test('0.4.0-beta.62 selectionIsValid rejects archived destinations and disabled delete rows', () => {
  const { doc, a, c, d, dChild } = archivedFixture()
  assert.equal(selectionIsValid({ kind: 'move-session' }, d, doc), false)
  assert.equal(selectionIsValid({ kind: 'move-session' }, dChild, doc), false)
  assert.equal(selectionIsValid({ kind: 'move-session' }, c, doc), true)
  assert.equal(selectionIsValid({ kind: 'move-group', groupId: c }, d, doc), false)
  assert.equal(selectionIsValid({ kind: 'move-group', groupId: c }, a, doc), true)
  assert.equal(selectionIsValid({ kind: 'delete-group', groupId: a }, d, doc), false)
  assert.equal(selectionIsValid({ kind: 'delete-group', groupId: a }, c, doc), true)
  assert.equal(selectionIsValid({ kind: 'delete-group', groupId: a }, null, doc), true)
})

test('0.4.0-beta.62 delete destination verdict disables a relocation that shifts a frozen anchor', () => {
  // Root [G(session s1), L(live), Z(archived)]: deleting G shifts both live L
  // and the frozen Z sibling, so the sibling-set change is a position lock for
  // every destination (including the implicit root).
  let doc = createGroup(emptyDoc(), { name: 'G' })
  const g = doc.groups[0].id
  doc = createGroup(doc, { name: 'L' })
  const l = doc.groups.find((group) => group.name === 'L').id
  doc = createGroup(doc, { name: 'Z' })
  const z = doc.groups.find((group) => group.name === 'Z').id
  doc = { ...doc, groups: doc.groups.map((group) => (group.id === g ? { ...group, sessionIds: ['s1'] } : group)) }
  doc = setGroupArchived(doc, z, true)

  const verdict = deleteGroupDestinationVerdict(doc, g, null)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'group-position-locked')
  const options = deleteGroupOptions(doc, g)
  assert.equal(options.find((group) => group.id === z).disabled, true, 'archived destinations stay disabled')
  assert.equal(options.find((group) => group.id === l).disabled, true, 'anchor-shifting destinations are disabled')
  assert.equal(selectionIsValid({ kind: 'delete-group', groupId: g }, null, doc), false)
})

test('0.4.0-beta.62 delete root destination is invalid when it would shift a frozen root anchor', () => {
  let doc = createGroup(emptyDoc(), { name: 'G' })
  const g = doc.groups[0].id
  doc = createGroup(doc, { name: 'CG', parentId: g })
  doc = createGroup(doc, { name: 'Z' })
  const z = doc.groups.find((group) => group.name === 'Z').id
  doc = setGroupArchived(doc, z, true)
  const verdict = deleteGroupDestinationVerdict(doc, g, null)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'group-position-locked')
  assert.equal(selectionIsValid({ kind: 'delete-group', groupId: g }, null, doc), false)
})

test('0.4.0-beta.62 move-group dialog falls back to append when index 0 shifts a frozen anchor', () => {
  // Root G moves into target T, whose first child F is archived: index 0 would
  // shift F (0 -> 1), while appending keeps F in place.
  let doc = createGroup(emptyDoc(), { name: 'T' })
  const t = doc.groups[0].id
  doc = createGroup(doc, { name: 'F', parentId: t })
  const f = doc.groups.find((group) => group.name === 'F').id
  doc = createGroup(doc, { name: 'L', parentId: t })
  doc = createGroup(doc, { name: 'G' })
  const g = doc.groups.find((group) => group.name === 'G').id
  doc = setGroupArchived(doc, f, true)

  const plan = moveGroupSafeIndex(doc, g, t)
  assert.equal(plan.append, true)
  assert.equal(plan.index, 2, 'append index is the destination child count')
  assert.equal(plan.reason, 'group-position-locked')
  const appended = moveGroup(doc, g, t, plan.index)
  const children = appended.groups.filter((group) => group.parentId === t).map((group) => group.name)
  assert.deepEqual(children, ['F', 'L', 'G'], 'append keeps the frozen anchor in place')

  // A menu step across the frozen sibling is blocked with a reason: root
  // [A, F(archived), C], moving A down shifts F from 1 -> 0.
  let roots = createGroup(emptyDoc(), { name: 'A' })
  const a = roots.groups[0].id
  roots = createGroup(roots, { name: 'F' })
  const frozen = roots.groups.find((group) => group.name === 'F').id
  roots = createGroup(roots, { name: 'C' })
  const c = roots.groups.find((group) => group.name === 'C').id
  roots = setGroupArchived(roots, frozen, true)
  const step = moveGroupStepPrecheck(roots, a, 1)
  assert.equal(step.ok, false)
  assert.equal(step.reason, 'group-archived')
  // Moving A up is a boundary no-op with no reason key.
  assert.deepEqual(moveGroupStepPrecheck(roots, a, -1), { ok: false, reason: null })
  // Moving C up (C is last) shifts F as well.
  assert.equal(moveGroupStepPrecheck(roots, c, -1).reason, 'group-archived')
  assert.equal(moveGroupStepPrecheck(roots, c, 1).reason, null, 'last-sibling down is a boundary no-op')

  // Archived destination: the plan never falls back to another parent.
  assert.deepEqual(moveGroupSafeIndex(roots, c, frozen), {
    index: null,
    append: false,
    noop: false,
    reason: 'group-destination-archived',
  })
})

test('0.4.0-beta.62 move-group append is a no-op when the group is already the last child', () => {
  // Root [F(archived), A]: index 0 fails (F shifts), but A is already last, so
  // appending reproduces the current doc and the dialog must not write.
  let doc = createGroup(emptyDoc(), { name: 'F' })
  const f = doc.groups[0].id
  doc = createGroup(doc, { name: 'A' })
  const a = doc.groups.find((group) => group.name === 'A').id
  doc = setGroupArchived(doc, f, true)
  const plan = moveGroupSafeIndex(doc, a, null)
  assert.equal(plan.noop, true)
  assert.equal(plan.index, null)
  assert.equal(plan.reason, 'group-archived')
})

// ---------------------------------------------------------------------------
// 0.4.0-beta.62 P9/B1: archive orchestration policy extracted from plugin-host
//
// plugin-host.js cannot be imported by `node --test` (host-only DSH packages),
// so the confirmation boundary, inline archive-frozen copy/refresh, visibility
// toast action and pending-follow guard are pure helpers tested here.
// ---------------------------------------------------------------------------

test('archiveNeedsConfirm: an empty leaf group archives without confirmation', () => {
  assert.equal(archiveNeedsConfirm({}), false, 'missing counters default to zero')
  assert.equal(
    archiveNeedsConfirm({ directSessions: 0, directChildGroups: 0, runningSessions: 0, currentSessionInside: false }),
    false
  )
  // UI patch: the confirm decision is a pure helper. Only a needed boundary is
  // asked, and only the literal `true` opt-out suppresses it.
  assert.equal(shouldConfirmGroupArchive(true, false), true, 'needed confirmation is asked')
  assert.equal(shouldConfirmGroupArchive(false, false), false, 'empty leaf commits directly')
  assert.equal(shouldConfirmGroupArchive(false, true), false, 'skip cannot invent a confirmation')
  assert.equal(shouldConfirmGroupArchive(true, true), false, 'opt-out skips a needed confirmation')
  assert.equal(shouldConfirmGroupArchive(true, 'true'), true, 'only the literal true opt-out suppresses')
  assert.equal(shouldConfirmGroupArchive(true, 1), true, 'a non-boolean truthy skip does not suppress')
  assert.equal(shouldConfirmGroupArchive(true, undefined), true)
  assert.equal(shouldConfirmGroupArchive(true, null), true)
})

test('archiveNeedsConfirm: direct sessions or direct child groups require confirmation', () => {
  assert.equal(archiveNeedsConfirm({ directSessions: 1 }), true)
  assert.equal(archiveNeedsConfirm({ directChildGroups: 2 }), true)
  assert.equal(archiveNeedsConfirm({ directSessions: 3, directChildGroups: 1 }), true)
})

test('archiveNeedsConfirm: a running or currently open subtree session requires confirmation', () => {
  assert.equal(archiveNeedsConfirm({ runningSessions: 1 }), true)
  assert.equal(archiveNeedsConfirm({ currentSessionInside: true }), true)
  assert.equal(archiveNeedsConfirm({ runningSessions: 0, currentSessionInside: false }), false)
})

test('archiveFailureKey: every structured archive code carries inline dialog copy', () => {
  assert.equal(archiveFailureKey('group-archived'), 'dialog.groupArchived')
  assert.equal(archiveFailureKey('group-contains-archived'), 'dialog.groupContainsArchived')
  assert.equal(archiveFailureKey('group-destination-archived'), 'dialog.destinationArchived')
  assert.equal(archiveFailureKey('group-position-locked'), 'dialog.groupPositionLocked')
  assert.equal(archiveFailureKey('archive-frozen'), 'dialog.archiveFrozen')
})

test('archiveFailureKey: unknown or missing codes are not localized', () => {
  for (const code of ['conflict', 'invalid', '', undefined, null, 42]) {
    assert.equal(archiveFailureKey(code), null, `code ${String(code)} must not map to copy`)
  }
})

test('archiveFailureKey: an archive-frozen reason refines the generic frozen copy', () => {
  assert.equal(archiveFailureKey('archive-frozen', 'group-archived'), 'dialog.groupArchived')
  assert.equal(archiveFailureKey('archive-frozen', 'group-position-locked'), 'dialog.groupPositionLocked')
  assert.equal(archiveFailureKey('archive-frozen', 'unknown-reason'), 'dialog.archiveFrozen')
  assert.equal(archiveFailureKey('archive-frozen', null), 'dialog.archiveFrozen')
  assert.equal(archiveFailureKey('group-archived', 'ignored'), 'dialog.groupArchived', 'reason only refines archive-frozen')
})

test('archiveFailureNeedsRefresh: only archive-frozen re-reads the document', () => {
  assert.equal(archiveFailureNeedsRefresh('archive-frozen'), true)
  for (const code of [
    'group-archived',
    'group-contains-archived',
    'group-destination-archived',
    'group-position-locked',
    'conflict',
    undefined,
    null,
  ]) {
    assert.equal(archiveFailureNeedsRefresh(code), false, `code ${String(code)} must not refresh`)
  }
})

test('archiveVisibilityAction: hidden + archived offers showArchived, only + unarchived offers showAll', () => {
  assert.equal(archiveVisibilityAction('hidden', true), 'showArchived')
  assert.equal(archiveVisibilityAction('only', false), 'showAll')
})

test('archiveVisibilityAction: visible results and other filter combinations need no action', () => {
  assert.equal(archiveVisibilityAction('hidden', false), null, 'an unarchived group stays visible under hidden')
  assert.equal(archiveVisibilityAction('only', true), null, 'an archived group stays visible under only')
  assert.equal(archiveVisibilityAction('all', true), null)
  assert.equal(archiveVisibilityAction('all', false), null)
  assert.equal(archiveVisibilityAction('unknown', true), null)
  assert.equal(archiveVisibilityAction(undefined, false), null)
})

test('pendingFollowShouldAssign: only a live target group assigns; missing and archived cancel', () => {
  const { doc, a, b, d, dChild } = archivedFixture()
  assert.equal(pendingFollowShouldAssign(doc, a), true, 'a live root group accepts the follow')
  assert.equal(pendingFollowShouldAssign(doc, b), true, 'a live child group accepts the follow')
  assert.equal(pendingFollowShouldAssign(doc, d), false, 'an own-archived target cancels')
  assert.equal(pendingFollowShouldAssign(doc, dChild), false, 'an archived ancestor freezes the child')
  assert.equal(pendingFollowShouldAssign(doc, 'missing'), false, 'a deleted group cancels')
  assert.equal(pendingFollowShouldAssign({ groups: [] }, a), false)
})

// ---------------------------------------------------------------------------
// 0.4.0-beta.62 P9/B1: post-commit desired-state check
//
// `commitStrict` turns a CAS conflict into an adopted `result.doc` that has the
// same shape as a success. The archive action layer re-checks the desired flag
// so a stale/missing group can never surface a success toast.
// ---------------------------------------------------------------------------

test('groupArchiveCommitMatches: only an existing group carrying the desired flag matches', () => {
  const base = createGroup(emptyDoc(), { name: 'Target' })
  const target = base.groups[0].id
  assert.equal(groupArchiveCommitMatches(base, target, false), true, 'a missing flag matches unarchive')
  assert.equal(groupArchiveCommitMatches(base, target, true), false, 'a missing flag never matches archive')
  const archived = setGroupArchived(base, target, true)
  assert.equal(groupArchiveCommitMatches(archived, target, true), true, 'archived:true matches archive')
  assert.equal(groupArchiveCommitMatches(archived, target, false), false, 'archived:true never matches unarchive')
  const explicitFalse = { ...base, groups: base.groups.map((group) => ({ ...group, archived: false })) }
  assert.equal(groupArchiveCommitMatches(explicitFalse, target, false), true, 'archived:false matches unarchive')
  assert.equal(groupArchiveCommitMatches(explicitFalse, target, true), false, 'archived:false never matches archive')
})

test('groupArchiveCommitMatches: a deleted or absent group never matches either direction', () => {
  const base = createGroup(emptyDoc(), { name: 'Target' })
  const target = base.groups[0].id
  assert.equal(groupArchiveCommitMatches(base, 'missing', true), false, 'a deleted group never matches archive')
  assert.equal(groupArchiveCommitMatches(base, 'missing', false), false, 'a deleted group never matches unarchive')
  assert.equal(groupArchiveCommitMatches({ groups: [] }, target, true), false)
  assert.equal(groupArchiveCommitMatches({ groups: [] }, target, false), false)
})
