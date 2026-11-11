import test from 'node:test'
import assert from 'node:assert/strict'
import { applyControlOperations, buildControlState, CONTROL_OPERATIONS, CONTROL_PROTOCOL, resolveGroupPath } from '../../src/core/control.js'
import {
  assignSession,
  createGroup,
  deleteGroupTo,
  emptyDoc,
  findGroup,
  setGroupArchived,
  validateDoc,
} from '../../src/shared/model.js'

const fixture = () => {
  let doc = emptyDoc()
  doc = createGroup(doc, { name: 'A' })
  const a = doc.groups[0].id
  doc = createGroup(doc, { name: 'B' })
  const b = doc.groups[1].id
  doc = assignSession(doc, 's1', a, 0)
  doc = assignSession(doc, 's2', null, 0)
  return { doc, a, b }
}

const idOf = (doc, name) => doc.groups.find((group) => group.name === name).id

/** Root A (B child), root C archived with child D; s1 in C, s2 in A, s3 ungrouped. */
const archiveFixture = () => {
  let doc = emptyDoc()
  doc = createGroup(doc, { name: 'A' })
  const a = idOf(doc, 'A')
  doc = createGroup(doc, { name: 'B', parentId: a })
  const b = idOf(doc, 'B')
  doc = createGroup(doc, { name: 'C' })
  const c = idOf(doc, 'C')
  doc = createGroup(doc, { name: 'D', parentId: c })
  const d = idOf(doc, 'D')
  doc = assignSession(doc, 's1', c, 0)
  doc = assignSession(doc, 's2', a, 0)
  doc = assignSession(doc, 's3', null, 0)
  doc = setGroupArchived(doc, c, true)
  return { doc, a, b, c, d }
}

test('control state exposes stable ids and operation vocabulary', () => {
  const { doc, a } = fixture()
  const state = buildControlState(doc, 7)
  assert.equal(state.protocol, CONTROL_PROTOCOL)
  assert.equal(state.revision, 7)
  assert.deepEqual(state.groups[0].sessionIds, ['s1'])
  assert.deepEqual(state.ungrouped, ['s2'])
  assert.deepEqual(CONTROL_OPERATIONS, [
    'group.create',
    'group.rename',
    'group.update',
    'group.archive',
    'group.move',
    'group.delete',
    'session.assign',
  ])
  assert.equal(findGroup(doc, a).name, 'A')
})

test('control resolves full paths and rejects missing, ambiguous and control-character paths', () => {
  let doc = emptyDoc()
  doc = createGroup(doc, { name: 'Work' })
  const work = doc.groups[0].id
  doc = createGroup(doc, { name: 'Front', parentId: work })
  doc = createGroup(doc, { name: 'Duplicate' })
  doc = createGroup(doc, { name: 'Duplicate' })
  const front = doc.groups.find((group) => group.name === 'Front')
  assert.deepEqual(buildControlState(doc, 1).groups.find((group) => group.id === front.id).path, ['Work', 'Front'])
  assert.equal(resolveGroupPath(doc, ['Work', 'Front']).groupId, front.id)
  assert.equal(resolveGroupPath(doc, ['Work', 'missing']).code, 'group-not-found')
  assert.equal(resolveGroupPath(doc, ['Duplicate']).code, 'ambiguous-path')
  assert.equal(resolveGroupPath(doc, ['Duplicate']).candidates.length, 2)
  assert.equal(resolveGroupPath(doc, ['Work\nFront']).code, 'invalid-path')
  assert.equal(resolveGroupPath(doc, []).code, 'invalid-path')
  assert.equal(resolveGroupPath(doc, ['Work', 1]).code, 'invalid-path')
})

test('group names reject control characters both on input and at validation', () => {
  assert.throws(() => createGroup(emptyDoc(), { name: 'bad\nname' }), /name-control-chars/)
  const verdict = validateDoc({
    version: 1,
    revision: 0,
    groups: [{ id: 'g-x', name: 'bad\nname', icon: 'folder', parentId: null, sessionIds: [] }],
    ungrouped: [],
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.errors.join(';'), /group-name:g-x/)
})

test('control creates, renames, updates, moves and assigns without mutating input', () => {
  const { doc, b } = fixture()
  const before = JSON.stringify(doc)
  const result = applyControlOperations(doc, [
    { op: 'group.create', name: 'C', parentId: null, index: 0 },
    { op: 'group.rename', groupId: b, name: 'B2' },
    { op: 'group.update', groupId: b, icon: 'star', color: 'green' },
    { op: 'group.move', groupId: b, parentId: null, index: 0 },
    { op: 'session.assign', sessionId: 's2', groupId: b, index: 0 },
  ])
  assert.equal(result.ok, true)
  assert.equal(JSON.stringify(doc), before)
  assert.equal(result.doc.groups.some((group) => group.name === 'C'), true)
  assert.equal(result.changes[0].created, true)
  assert.equal('groupId' in result.changes[0], false)
  const updated = findGroup(result.doc, b)
  assert.equal(updated.name, 'B2')
  assert.equal(updated.icon, 'star')
  assert.equal(updated.color, 'green')
  assert.deepEqual(updated.sessionIds, ['s2'])
  assert.equal(result.changes.length, 5)
})

test('control requires explicit destructive opt-in and validates the result', () => {
  const { doc, a } = fixture()
  const denied = applyControlOperations(doc, [{ op: 'group.delete', groupId: a }])
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'operation-failed')
  assert.equal(denied.message, 'destructive-disabled')

  const allowed = applyControlOperations(doc, [{ op: 'group.delete', groupId: a, destinationId: null }], {
    allowDestructive: true,
  })
  assert.equal(allowed.ok, true)
  assert.equal(findGroup(allowed.doc, a), null)
  assert.deepEqual(allowed.doc.ungrouped.sort(), ['s1', 's2'].sort())
})

test('control rejects extra and mistyped fields instead of silently coercing them', () => {
  const { doc, a } = fixture()
  const extra = applyControlOperations(doc, [
    { op: 'group.rename', groupId: a, name: 'A2', surprise: true },
  ])
  assert.equal(extra.ok, false)
  assert.equal(extra.code, 'invalid-operation')
  assert.equal(extra.operationIndex, 0)
  assert.equal(extra.field, 'surprise')

  const badIndex = applyControlOperations(doc, [
    { op: 'group.move', groupId: a, parentId: null, index: '0' },
  ])
  assert.equal(badIndex.code, 'invalid-operation')
  assert.equal(badIndex.field, 'index')
  assert.equal(badIndex.expected, 'non-negative integer')

  const badParent = applyControlOperations(doc, [
    { op: 'group.create', name: 'C', parentId: 123 },
  ])
  assert.equal(badParent.code, 'invalid-operation')
  assert.equal(badParent.field, 'parentId')

  const noUpdate = applyControlOperations(doc, [{ op: 'group.update', groupId: a }])
  assert.equal(noUpdate.code, 'invalid-operation')
  assert.equal(noUpdate.field, 'icon|color|colorHex')

  const nullOperation = applyControlOperations(doc, [null])
  assert.equal(nullOperation.code, 'invalid-operation')
  assert.equal(nullOperation.operationIndex, 0)
})

test('control rejects empty, unknown, oversized and invalid operations', () => {
  const { doc, a } = fixture()
  assert.equal(applyControlOperations(doc, []).code, 'operations-required')
  assert.equal(applyControlOperations(doc, [{ op: 'raw.commit' }]).code, 'unknown-operation')
  assert.equal(
    applyControlOperations(doc, Array.from({ length: 65 }, () => ({ op: 'group.rename', groupId: a, name: 'A' }))).code,
    'too-many-operations',
  )
  assert.equal(
    applyControlOperations(doc, [{ op: 'group.rename', groupId: a, name: '' }]).code,
    'invalid-operation',
  )
  assert.equal(
    applyControlOperations(doc, [{ op: 'group.update', groupId: a }]).code,
    'invalid-operation',
  )
})

test('control planning refuses an invalid candidate document instead of returning a plan', () => {
  const planned = applyControlOperations(emptyDoc(), [{ op: 'group.create', name: 'A', parentId: null }])
  assert.equal(planned.ok, true)

  const invalid = { version: 99, revision: 0, groups: [], ungrouped: [] }
  const result = applyControlOperations(invalid, [{ op: 'group.create', name: 'A', parentId: null }])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid-result')
  assert.match(result.message, /version/)
})

test('control state exposes own and inherited archive flags without view-only fields', () => {
  const { doc, a, b, c, d } = archiveFixture()
  const state = buildControlState(doc, 4)
  const byId = new Map(state.groups.map((group) => [group.id, group]))

  assert.deepEqual(
    {
      archived: byId.get(a).archived,
      effectiveArchived: byId.get(a).effectiveArchived,
      archivedBy: byId.get(a).archivedBy,
    },
    { archived: false, effectiveArchived: false, archivedBy: null },
  )
  assert.deepEqual(
    {
      archived: byId.get(b).archived,
      effectiveArchived: byId.get(b).effectiveArchived,
      archivedBy: byId.get(b).archivedBy,
    },
    { archived: false, effectiveArchived: false, archivedBy: null },
  )
  assert.deepEqual(
    {
      archived: byId.get(c).archived,
      effectiveArchived: byId.get(c).effectiveArchived,
      archivedBy: byId.get(c).archivedBy,
    },
    { archived: true, effectiveArchived: true, archivedBy: c },
  )
  // Own false under an archived ancestor: effective is inherited, own stays false.
  assert.deepEqual(
    {
      archived: byId.get(d).archived,
      effectiveArchived: byId.get(d).effectiveArchived,
      archivedBy: byId.get(d).archivedBy,
    },
    { archived: false, effectiveArchived: true, archivedBy: c },
  )
  for (const group of state.groups) {
    assert.equal('pathOnly' in group, false, 'pathOnly is view state and must not leak into control state')
  }
})

test('group.archive requires a boolean archived flag and a non-empty groupId', () => {
  const { doc, a } = fixture()

  const missingGroup = applyControlOperations(doc, [{ op: 'group.archive', archived: true }])
  assert.equal(missingGroup.ok, false)
  assert.equal(missingGroup.code, 'invalid-operation')
  assert.equal(missingGroup.field, 'groupId')
  assert.equal(missingGroup.expected, 'string')
  assert.equal(missingGroup.operationIndex, 0)

  const emptyGroup = applyControlOperations(doc, [{ op: 'group.archive', groupId: '', archived: true }])
  assert.equal(emptyGroup.code, 'invalid-operation')
  assert.equal(emptyGroup.field, 'groupId')

  const missingFlag = applyControlOperations(doc, [{ op: 'group.archive', groupId: a }])
  assert.equal(missingFlag.code, 'invalid-operation')
  assert.equal(missingFlag.field, 'archived')
  assert.equal(missingFlag.expected, 'boolean')

  for (const [value, receivedType] of [['true', 'string'], [1, 'integer'], [null, 'null'], [[], 'array']]) {
    const mistyped = applyControlOperations(doc, [{ op: 'group.archive', groupId: a, archived: value }])
    assert.equal(mistyped.code, 'invalid-operation', `archived=${JSON.stringify(value)}`)
    assert.equal(mistyped.field, 'archived')
    assert.equal(mistyped.receivedType, receivedType)
  }

  const extra = applyControlOperations(doc, [
    { op: 'group.archive', groupId: a, archived: true, cascade: true },
  ])
  assert.equal(extra.code, 'invalid-operation')
  assert.equal(extra.field, 'cascade')
  assert.match(extra.message, /unexpected field/)

  // group.update still only accepts icon/color/colorHex: archived must not sneak in.
  const sneakyUpdate = applyControlOperations(doc, [{ op: 'group.update', groupId: a, archived: true }])
  assert.equal(sneakyUpdate.code, 'invalid-operation')
  assert.equal(sneakyUpdate.field, 'archived')
  assert.equal(findGroup(doc, a).archived, undefined)
})

test('group.archive toggles only the own flag, never cascades and is idempotent per doc', () => {
  const { doc, a, b, c, d } = archiveFixture()
  const before = JSON.stringify(doc)

  const archived = applyControlOperations(doc, [{ op: 'group.archive', groupId: a, archived: true }])
  assert.equal(archived.ok, true)
  assert.equal(findGroup(archived.doc, a).archived, true)
  assert.equal(findGroup(archived.doc, b).archived, undefined, 'children keep their own flag')
  assert.deepEqual(archived.changes, [{ op: 'group.archive', groupId: a, archived: true }])
  assert.equal(JSON.stringify(doc), before, 'the input doc must not be mutated')

  const unarchived = applyControlOperations(archived.doc, [{ op: 'group.archive', groupId: a, archived: false }])
  assert.equal(unarchived.ok, true)
  assert.equal(findGroup(unarchived.doc, a).archived, false, 'unarchive persists an explicit false')

  // The switch itself is always legal inside an already-archived subtree.
  const nested = applyControlOperations(doc, [{ op: 'group.archive', groupId: d, archived: true }])
  assert.equal(nested.ok, true)
  assert.equal(findGroup(nested.doc, d).archived, true)
  assert.equal(findGroup(nested.doc, c).archived, true, 'archiving a child never changes the parent')

  const same = applyControlOperations(doc, [{ op: 'group.archive', groupId: a, archived: false }])
  assert.equal(same.ok, false)
  assert.equal(same.code, 'no-change')
  assert.equal(same.operationIndex, -1)

  const allSame = applyControlOperations(doc, [
    { op: 'group.archive', groupId: a, archived: false },
    { op: 'group.archive', groupId: c, archived: true },
  ])
  assert.equal(allSame.code, 'no-change', 'an all-same-value batch is still no-change')

  const mixed = applyControlOperations(doc, [
    { op: 'group.archive', groupId: a, archived: true },
    { op: 'group.archive', groupId: a, archived: true },
  ])
  assert.equal(mixed.ok, true)
  assert.equal(mixed.changes.length, 1, 'same-value operations must not push a change')

  const missing = applyControlOperations(doc, [{ op: 'group.archive', groupId: 'g-missing', archived: true }])
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'group-not-found')
  assert.equal(missing.groupId, 'g-missing')
  assert.equal(missing.field, 'groupId')
  assert.equal(missing.operationIndex, 0)
})

test('archive guards reject create/rename/update/move sources inside an archived subtree', () => {
  const { doc, a, c, d } = archiveFixture()

  const create = applyControlOperations(doc, [{ op: 'group.create', name: 'E', parentId: d }])
  assert.equal(create.ok, false)
  assert.equal(create.code, 'group-archived')
  assert.equal(create.groupId, d)
  assert.equal(create.field, 'parentId')
  assert.equal(create.operationIndex, 0)

  const createOwnArchived = applyControlOperations(doc, [{ op: 'group.create', name: 'E', parentId: c }])
  assert.equal(createOwnArchived.code, 'group-archived')
  assert.equal(createOwnArchived.groupId, c)

  const rename = applyControlOperations(doc, [{ op: 'group.rename', groupId: d, name: 'D2' }])
  assert.equal(rename.code, 'group-archived')
  assert.equal(rename.groupId, d)
  assert.equal(rename.field, 'groupId')

  const update = applyControlOperations(doc, [{ op: 'group.update', groupId: c, icon: 'star' }])
  assert.equal(update.code, 'group-archived')
  assert.equal(update.groupId, c)
  assert.equal(update.field, 'groupId')

  const move = applyControlOperations(doc, [{ op: 'group.move', groupId: c, parentId: a }])
  assert.equal(move.code, 'group-archived')
  assert.equal(move.groupId, c)

  const remove = applyControlOperations(doc, [{ op: 'group.delete', groupId: c, destinationId: null }], {
    allowDestructive: true,
  })
  assert.equal(remove.code, 'group-archived')
  assert.equal(remove.groupId, c)
})

test('archive guards separate source-with-archived-descendants and archived destinations', () => {
  // P is unarchived but contains the archived child C; Q is another root.
  let doc = emptyDoc()
  doc = createGroup(doc, { name: 'P' })
  const p = idOf(doc, 'P')
  doc = createGroup(doc, { name: 'C', parentId: p })
  const c = idOf(doc, 'C')
  doc = createGroup(doc, { name: 'Q' })
  const q = idOf(doc, 'Q')
  doc = setGroupArchived(doc, c, true)

  const moveAncestor = applyControlOperations(doc, [{ op: 'group.move', groupId: p, parentId: null, index: 1 }])
  assert.equal(moveAncestor.code, 'group-contains-archived')
  assert.equal(moveAncestor.groupId, p)
  assert.equal(moveAncestor.field, 'groupId')
  assert.equal(moveAncestor.operationIndex, 0)

  const deleteAncestor = applyControlOperations(doc, [{ op: 'group.delete', groupId: p, destinationId: null }], {
    allowDestructive: true,
  })
  assert.equal(deleteAncestor.code, 'group-contains-archived')
  assert.equal(deleteAncestor.groupId, p)

  const moveIntoArchived = applyControlOperations(doc, [{ op: 'group.move', groupId: q, parentId: c }])
  assert.equal(moveIntoArchived.code, 'group-destination-archived')
  assert.equal(moveIntoArchived.groupId, c)
  assert.equal(moveIntoArchived.field, 'parentId')

  const deleteIntoArchived = applyControlOperations(doc, [{ op: 'group.delete', groupId: q, destinationId: c }], {
    allowDestructive: true,
  })
  assert.equal(deleteIntoArchived.code, 'group-destination-archived')
  assert.equal(deleteIntoArchived.groupId, c)
  assert.equal(deleteIntoArchived.field, 'destinationId')
})

test('delete to an archived empty destination is refused even though the invariant alone allows it', () => {
  // Order matters: C stays at root index 0 after A (index 1) is deleted, so the
  // frozen fingerprint does not change. That is exactly why P7 needs the
  // explicit destination guard (carry-over from P1).
  let doc = emptyDoc()
  doc = createGroup(doc, { name: 'C' })
  const c = doc.groups[0].id
  doc = createGroup(doc, { name: 'A' })
  const a = doc.groups.at(-1).id
  doc = setGroupArchived(doc, c, true)

  const direct = deleteGroupTo(doc, a, c)
  assert.equal(direct.groups.some((group) => group.id === a), false)

  const guarded = applyControlOperations(doc, [{ op: 'group.delete', groupId: a, destinationId: c }], {
    allowDestructive: true,
  })
  assert.equal(guarded.ok, false)
  assert.equal(guarded.code, 'group-destination-archived')
  assert.equal(guarded.groupId, c)
  assert.equal(guarded.field, 'destinationId')
})

test('session.assign is guarded on both the archived source and the archived destination', () => {
  const { doc, a, c } = archiveFixture()

  const fromArchived = applyControlOperations(doc, [{ op: 'session.assign', sessionId: 's1', groupId: a }])
  assert.equal(fromArchived.code, 'group-archived')
  assert.equal(fromArchived.groupId, c)
  assert.equal(fromArchived.field, 'sessionId')
  assert.equal(fromArchived.operationIndex, 0)

  const toArchived = applyControlOperations(doc, [{ op: 'session.assign', sessionId: 's2', groupId: c }])
  assert.equal(toArchived.code, 'group-destination-archived')
  assert.equal(toArchived.groupId, c)
  assert.equal(toArchived.field, 'groupId')

  // An ungrouped session has no archived source; the move itself is allowed.
  const allowed = applyControlOperations(doc, [{ op: 'session.assign', sessionId: 's3', groupId: a, index: 1 }])
  assert.equal(allowed.ok, true)
  assert.deepEqual(findGroup(allowed.doc, a).sessionIds, ['s2', 's3'])
  assert.deepEqual(allowed.doc.ungrouped, [])
})

test('batch operations run in order; the whole-batch invariant uses the original doc', () => {
  const { doc, a, b, c } = archiveFixture()
  const before = JSON.stringify(doc)

  // rename + archive: the target was not archived in the before-state, so it is legal.
  const renameThenArchive = applyControlOperations(doc, [
    { op: 'group.rename', groupId: a, name: 'A2' },
    { op: 'group.archive', groupId: a, archived: true },
  ])
  assert.equal(renameThenArchive.ok, true)
  assert.equal(renameThenArchive.changes.length, 2)
  assert.equal(findGroup(renameThenArchive.doc, a).name, 'A2')
  assert.equal(findGroup(renameThenArchive.doc, a).archived, true)

  // archive + rename: the second operation targets an archived group and is rejected.
  const archiveThenRename = applyControlOperations(doc, [
    { op: 'group.archive', groupId: a, archived: true },
    { op: 'group.rename', groupId: a, name: 'A2' },
  ])
  assert.equal(archiveThenRename.ok, false)
  assert.equal(archiveThenRename.code, 'group-archived')
  assert.equal(archiveThenRename.operationIndex, 1)
  assert.equal(archiveThenRename.groupId, a)
  assert.equal(archiveThenRename.changes.length, 1)
  assert.equal('doc' in archiveThenRename, false, 'a rejected batch must not return a candidate doc')

  // archive + update: same per-operation guard.
  const archiveThenUpdate = applyControlOperations(doc, [
    { op: 'group.archive', groupId: a, archived: true },
    { op: 'group.update', groupId: a, icon: 'star' },
  ])
  assert.equal(archiveThenUpdate.code, 'group-archived')
  assert.equal(archiveThenUpdate.operationIndex, 1)

  // unarchive + edit: each step is individually legal (the target is no longer
  // archived for step 2) but the original before-state is frozen, so the whole
  // batch is rejected by the final invariant check.
  const unarchiveThenRename = applyControlOperations(doc, [
    { op: 'group.archive', groupId: c, archived: false },
    { op: 'group.rename', groupId: c, name: 'C2' },
  ])
  assert.equal(unarchiveThenRename.ok, false)
  assert.equal(unarchiveThenRename.code, 'group-archived')
  assert.equal(unarchiveThenRename.operationIndex, -1)
  assert.equal(unarchiveThenRename.groupId, c)
  assert.equal(unarchiveThenRename.field, 'name')
  assert.equal(unarchiveThenRename.changes.length, 2)
  assert.equal('doc' in unarchiveThenRename, false)

  // Unarchive alone is legal; reorder children of an unarchived parent is legal.
  const unarchiveOnly = applyControlOperations(doc, [{ op: 'group.archive', groupId: c, archived: false }])
  assert.equal(unarchiveOnly.ok, true)
  const renameChild = applyControlOperations(doc, [{ op: 'group.rename', groupId: b, name: 'B2' }])
  assert.equal(renameChild.ok, true)

  assert.equal(JSON.stringify(doc), before, 'rejected batches must not mutate the input doc')
})

test('mutator archive errors keep their own code instead of operation-failed', () => {
  // Root C is archived at index 0; inserting a new root before it shifts the
  // frozen anchor and the shared mutator reports group-position-locked.
  let doc = emptyDoc()
  doc = createGroup(doc, { name: 'C' })
  const c = doc.groups[0].id
  doc = createGroup(doc, { name: 'A' })
  doc = setGroupArchived(doc, c, true)

  const shifted = applyControlOperations(doc, [{ op: 'group.create', name: 'X', parentId: null, index: 0 }])
  assert.equal(shifted.ok, false)
  assert.equal(shifted.code, 'group-position-locked')
  assert.equal(shifted.groupId, c)
  assert.equal(shifted.field, 'index')
  assert.equal(shifted.operationIndex, 0)
})

test('applyControlOperations validates the final document even when the operation itself is valid', () => {
  const doc = {
    version: 1,
    revision: 0,
    groups: [
      { id: 'g-valid', name: 'Valid', icon: 'folder', parentId: null, sessionIds: [] },
      { id: 'g-invalid', name: '', icon: 'folder', parentId: null, sessionIds: [] },
    ],
    ungrouped: [],
  }
  const result = applyControlOperations(doc, [{ op: 'group.rename', groupId: 'g-valid', name: 'Renamed' }])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid-result')
  assert.match(result.message, /group-name:g-invalid/)
})
