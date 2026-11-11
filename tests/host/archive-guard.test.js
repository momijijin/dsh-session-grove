/**
 * Host commit-layer group-archive guard (0.4.0-beta.62, P4).
 *
 * Covers the store half of SPEC §3.4/§6.3/§9:
 * - old clients that drop the additive `archived` field keep the current flag;
 * - every write persists an explicit boolean, missing still validates on read;
 * - the frozen-subtree invariant runs inside `store.commit` and returns
 *   `kind:'archive-frozen'` without writing or bumping the revision;
 * - `store.save` keeps its no-transition-guard exception.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { makeTempStore } from './helpers.js'

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')
const cloneDoc = (doc) => JSON.parse(JSON.stringify(doc))

/** One archived group nested under a normal root, plus an unrelated root group. */
const archiveFixture = () => ({
  version: 1,
  groups: [
    { id: 'g-root', name: 'Root', icon: 'folder', color: 'purple', parentId: null, sessionIds: ['s-1'] },
    {
      id: 'g-arch',
      name: 'Archived',
      icon: 'folder',
      color: 'blue',
      parentId: 'g-root',
      sessionIds: ['s-2', 's-3'],
      archived: true,
    },
    { id: 'g-other', name: 'Other', icon: 'hash', color: 'green', parentId: null, sessionIds: ['s-4'] },
  ],
  ungrouped: ['s-5'],
})

/** Drop the additive field the way a pre-0.4.0-beta.62 client serializes the doc. */
const withoutArchived = (doc) => {
  const next = cloneDoc(doc)
  for (const group of next.groups) delete group.archived
  return next
}

const groupOf = (doc, groupId) => doc.groups.find((group) => group.id === groupId)
const commitOk = async (temp, baseRevision, doc) => {
  const result = await temp.store.commit(baseRevision, doc)
  assert.equal(result.kind, 'ok', `expected ok, got ${JSON.stringify(result)}`)
  return result
}

const expectFrozen = (result, { code, groupId, field }) => {
  assert.equal(result.kind, 'archive-frozen')
  assert.equal(result.code, code)
  assert.equal(result.groupId, groupId)
  assert.equal(result.field, field)
  assert.equal(result.message, code)
}

// ---------------------------------------------------------------------------
// §3.4 inheritance for old clients
// ---------------------------------------------------------------------------

test('old client: a missing archived flag inherits true from the current document', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await commitOk(temp, 0, archiveFixture())

  const oldClientDoc = withoutArchived(archiveFixture())
  const committed = await commitOk(temp, 1, oldClientDoc)

  assert.equal(committed.revision, 2)
  assert.equal(groupOf(committed.doc, 'g-arch').archived, true)
  assert.equal(groupOf(committed.doc, 'g-root').archived, false)
  assert.equal(groupOf(committed.doc, 'g-other').archived, false)
  const onDisk = JSON.parse(await readFile(temp.filePath, 'utf8'))
  assert.equal(groupOf(onDisk, 'g-arch').archived, true)
})

test('old client: a missing archived flag + edit is rejected as archive-frozen without writing', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await commitOk(temp, 0, archiveFixture())
  const before = await sha256(temp.filePath)

  const renamed = withoutArchived(archiveFixture())
  groupOf(renamed, 'g-arch').name = 'Renamed by an old client'
  const result = await temp.store.commit(1, renamed)

  expectFrozen(result, { code: 'group-archived', groupId: 'g-arch', field: 'name' })
  assert.equal(await sha256(temp.filePath), before, 'the guard must not write')
  const loaded = await temp.store.load()
  assert.equal(loaded.revision, 1, 'the guard must not bump the revision')
  assert.equal(groupOf(loaded.doc, 'g-arch').archived, true)
})

test('old client: removing an archived group is rejected (deleted anchor)', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await commitOk(temp, 0, archiveFixture())

  const deleted = withoutArchived(archiveFixture())
  deleted.groups = deleted.groups.filter((group) => group.id !== 'g-arch')
  expectFrozen(await temp.store.commit(1, deleted), {
    code: 'group-archived',
    groupId: 'g-arch',
    field: 'deleted',
  })
})

test('explicit boolean wins over inheritance: false unarchives, true archives', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await commitOk(temp, 0, archiveFixture())

  const unarchived = archiveFixture()
  groupOf(unarchived, 'g-arch').archived = false
  const first = await commitOk(temp, 1, unarchived)
  assert.equal(groupOf(first.doc, 'g-arch').archived, false)

  const archivedAgain = archiveFixture()
  const second = await commitOk(temp, 2, archivedAgain)
  assert.equal(groupOf(second.doc, 'g-arch').archived, true)
})

test('explicit false + edit is rejected while explicit true + archive-state edit is allowed', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await commitOk(temp, 0, archiveFixture())

  const unarchivePlusEdit = archiveFixture()
  groupOf(unarchivePlusEdit, 'g-arch').archived = false
  groupOf(unarchivePlusEdit, 'g-arch').name = 'Renamed'
  expectFrozen(await temp.store.commit(1, unarchivePlusEdit), {
    code: 'group-archived',
    groupId: 'g-arch',
    field: 'name',
  })

  // `g-other` is not archived in the before-state, so archiving it together
  // with an edit is legal (strict before-state).
  const archivePlusEdit = archiveFixture()
  groupOf(archivePlusEdit, 'g-other').archived = true
  groupOf(archivePlusEdit, 'g-other').name = 'Archived and renamed'
  const allowed = await commitOk(temp, 1, archivePlusEdit)
  assert.equal(groupOf(allowed.doc, 'g-other').archived, true)
  assert.equal(groupOf(allowed.doc, 'g-other').name, 'Archived and renamed')
})

test('new groups without archived are persisted as false; the inbound doc is not mutated', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await commitOk(temp, 0, withoutArchived(archiveFixture()))

  const incoming = withoutArchived(archiveFixture())
  incoming.groups.push({
    id: 'g-new',
    name: 'New',
    icon: 'folder',
    color: 'teal',
    parentId: null,
    sessionIds: ['s-9'],
  })
  assert.equal(Object.hasOwn(incoming.groups[0], 'archived'), false)
  const committed = await commitOk(temp, 1, incoming)

  assert.equal(groupOf(committed.doc, 'g-new').archived, false)
  for (const group of committed.doc.groups) assert.equal(typeof group.archived, 'boolean')
  assert.equal(Object.hasOwn(incoming.groups[0], 'archived'), false, 'inbound doc must not be mutated')
})

test('every committed group is normalized to an explicit boolean archived flag', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const committed = await commitOk(temp, 0, withoutArchived(archiveFixture()))

  for (const group of committed.doc.groups) assert.equal(group.archived, false)
  const onDisk = JSON.parse(await readFile(temp.filePath, 'utf8'))
  for (const group of onDisk.groups) assert.equal(group.archived, false)
})

// ---------------------------------------------------------------------------
// Normalization must not create false violations
// ---------------------------------------------------------------------------

test('host normalization (color, archived) does not flag a legacy current document', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  // Current document predates `color` and `archived`; the archived group has no color.
  const legacy = {
    version: 1,
    revision: 1,
    groups: [
      { id: 'g-legacy', name: 'Legacy', icon: 'folder', parentId: null, sessionIds: ['s-1'], archived: true },
    ],
    ungrouped: [],
  }
  await writeFile(temp.filePath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')

  // The host adds the palette color on write; comparing raw fields would flag a
  // change that the user never made (SPEC §6.2 normalization rule).
  const incoming = withoutArchived(legacy)
  groupOf(incoming, 'g-legacy').color = 'blue'
  const committed = await commitOk(temp, 1, incoming)
  assert.equal(groupOf(committed.doc, 'g-legacy').archived, true)
  assert.equal(groupOf(committed.doc, 'g-legacy').color, 'blue', 'the host adds the palette color')
})

test('colorHex normalization does not flag an equivalent archived group', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const current = archiveFixture()
  groupOf(current, 'g-arch').colorHex = '#A1B2C3'
  await commitOk(temp, 0, current)

  const incoming = archiveFixture()
  groupOf(incoming, 'g-arch').colorHex = '#a1b2c3'
  const committed = await commitOk(temp, 1, incoming)
  assert.equal(groupOf(committed.doc, 'g-arch').colorHex, '#a1b2c3')
})

// ---------------------------------------------------------------------------
// §6 frozen-subtree guard matrix
// ---------------------------------------------------------------------------

test('archived group metadata edits are rejected field by field', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await commitOk(temp, 0, archiveFixture())

  const cases = [
    ['name', (group) => { group.name = 'New name' }],
    ['icon', (group) => { group.icon = 'star' }],
    ['color', (group) => { group.color = 'red' }],
    ['colorHex', (group) => { group.colorHex = '#A1B2C3' }],
  ]
  for (const [field, mutate] of cases) {
    const incoming = archiveFixture()
    mutate(groupOf(incoming, 'g-arch'))
    expectFrozen(await temp.store.commit(1, incoming), { code: 'group-archived', groupId: 'g-arch', field })
  }
})

test('archived group sessionIds reorder/removal are group-archived, additions are destination-archived', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await commitOk(temp, 0, archiveFixture())

  const reordered = archiveFixture()
  groupOf(reordered, 'g-arch').sessionIds = ['s-3', 's-2']
  expectFrozen(await temp.store.commit(1, reordered), {
    code: 'group-archived',
    groupId: 'g-arch',
    field: 'sessionIds',
  })

  const removed = archiveFixture()
  groupOf(removed, 'g-arch').sessionIds = ['s-2']
  expectFrozen(await temp.store.commit(1, removed), {
    code: 'group-archived',
    groupId: 'g-arch',
    field: 'sessionIds',
  })

  // 's-5' moves from ungrouped into the archived group (session ownership stays unique).
  const added = archiveFixture()
  groupOf(added, 'g-arch').sessionIds = ['s-2', 's-3', 's-5']
  added.ungrouped = []
  expectFrozen(await temp.store.commit(1, added), {
    code: 'group-destination-archived',
    groupId: 'g-arch',
    field: 'sessionIds',
  })
})

test('archived group child changes are rejected: insert (destination), reorder/remove (archived)', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const nested = () => {
    const doc = archiveFixture()
    doc.groups.push(
      { id: 'g-kid-b', name: 'Kid B', icon: 'folder', color: 'blue', parentId: 'g-arch', sessionIds: ['s-6'] },
      { id: 'g-kid-a', name: 'Kid A', icon: 'folder', color: 'blue', parentId: 'g-arch', sessionIds: [] },
    )
    return doc
  }
  await commitOk(temp, 0, nested())

  const inserted = nested()
  inserted.groups.push({
    id: 'g-kid-c',
    name: 'Kid C',
    icon: 'folder',
    color: 'blue',
    parentId: 'g-arch',
    sessionIds: [],
  })
  expectFrozen(await temp.store.commit(1, inserted), {
    code: 'group-destination-archived',
    groupId: 'g-arch',
    field: 'children',
  })

  const reordered = nested()
  const kids = reordered.groups.filter((group) => group.parentId === 'g-arch')
  reordered.groups = reordered.groups.filter((group) => group.parentId !== 'g-arch')
  reordered.groups.push(kids[1], kids[0])
  expectFrozen(await temp.store.commit(1, reordered), {
    code: 'group-archived',
    groupId: 'g-arch',
    field: 'children',
  })

  const removed = nested()
  removed.groups = removed.groups.filter((group) => group.id !== 'g-kid-a')
  expectFrozen(await temp.store.commit(1, removed), {
    code: 'group-archived',
    groupId: 'g-arch',
    field: 'children',
  })
})

test('moving an archived group or shifting its sibling anchor is rejected', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await commitOk(temp, 0, archiveFixture())

  const moved = archiveFixture()
  groupOf(moved, 'g-arch').parentId = 'g-other'
  expectFrozen(await temp.store.commit(1, moved), {
    code: 'group-archived',
    groupId: 'g-arch',
    field: 'parentId',
  })

  // Insert a new sibling before the archived child: indirect anchor shift.
  const shifted = archiveFixture()
  shifted.groups.splice(1, 0, {
    id: 'g-sib',
    name: 'Sibling',
    icon: 'folder',
    color: 'blue',
    parentId: 'g-root',
    sessionIds: [],
  })
  expectFrozen(await temp.store.commit(1, shifted), {
    code: 'group-position-locked',
    groupId: 'g-arch',
    field: 'index',
  })

  // Swap two existing siblings: same child set, direct index change.
  const withSibling = archiveFixture()
  withSibling.groups.splice(2, 0, {
    id: 'g-sib',
    name: 'Sibling',
    icon: 'folder',
    color: 'blue',
    parentId: 'g-root',
    sessionIds: [],
  })
  await commitOk(temp, 1, withSibling)
  const swapped = cloneDoc(withSibling)
  const sibling = swapped.groups.splice(2, 1)[0]
  swapped.groups.splice(1, 0, sibling)
  expectFrozen(await temp.store.commit(2, swapped), {
    code: 'group-archived',
    groupId: 'g-arch',
    field: 'index',
  })
})

test('moving or deleting an ancestor of an archived group is rejected', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await commitOk(temp, 0, archiveFixture())

  const moved = archiveFixture()
  groupOf(moved, 'g-root').parentId = 'g-other'
  expectFrozen(await temp.store.commit(1, moved), {
    code: 'group-contains-archived',
    groupId: 'g-root',
    field: 'parentId',
  })

  const deleted = archiveFixture()
  deleted.groups = deleted.groups.filter((group) => group.id !== 'g-root' && group.id !== 'g-arch')
  expectFrozen(await temp.store.commit(1, deleted), {
    code: 'group-contains-archived',
    groupId: 'g-root',
    field: 'deleted',
  })
})

test('deleting an archived group, or deleting another group into it, is rejected', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await commitOk(temp, 0, archiveFixture())

  const deletedArchived = archiveFixture()
  deletedArchived.groups = deletedArchived.groups.filter((group) => group.id !== 'g-arch')
  expectFrozen(await temp.store.commit(1, deletedArchived), {
    code: 'group-archived',
    groupId: 'g-arch',
    field: 'deleted',
  })

  // Moving another group's sessions into the archived group (the delete-group
  // destination path) appends content, so it is destination-archived.
  const toArchivedDestination = archiveFixture()
  toArchivedDestination.groups = toArchivedDestination.groups.filter((group) => group.id !== 'g-other')
  groupOf(toArchivedDestination, 'g-arch').sessionIds = ['s-2', 's-3', 's-4']
  expectFrozen(await temp.store.commit(1, toArchivedDestination), {
    code: 'group-destination-archived',
    groupId: 'g-arch',
    field: 'sessionIds',
  })
})

// ---------------------------------------------------------------------------
// Validation vs guard, and ordering with CAS
// ---------------------------------------------------------------------------

test('a non-boolean archived value is a validation error, not a guard result', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await commitOk(temp, 0, archiveFixture())

  const invalid = archiveFixture()
  groupOf(invalid, 'g-other').archived = 'yes'
  const result = await temp.store.commit(1, invalid)
  assert.equal(result.kind, 'invalid')
  assert.match(result.errors.join('; '), /group-archived-type:g-other/)
})

test('a stale baseRevision conflicts before the archive guard runs', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await commitOk(temp, 0, archiveFixture())

  const renamed = archiveFixture()
  groupOf(renamed, 'g-arch').name = 'Renamed'
  const result = await temp.store.commit(0, renamed)
  assert.equal(result.kind, 'conflict')
})
