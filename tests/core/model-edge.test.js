import test from 'node:test'
import assert from 'node:assert/strict'

import { ARCHIVE_FROZEN } from '../../src/shared/archive.js'
import {
  assignSession,
  cloneDoc,
  createGroup,
  emptyDoc,
  findGroup,
  newGroupId,
  renameGroup,
  setGroupArchived,
  validateDoc,
} from '../../src/shared/model.js'

test('newGroupId falls back to a stable-shaped random id when crypto.randomUUID is unavailable', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  if (!descriptor?.configurable) return
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
  try {
    const first = newGroupId()
    const second = newGroupId()
    assert.match(first, /^g-[0-9a-f]{12}$/)
    assert.match(second, /^g-[0-9a-f]{12}$/)
    assert.notEqual(first, second)
  } finally {
    Object.defineProperty(globalThis, 'crypto', descriptor)
  }
})

test('a rejected archive mutation leaves the input document untouched', () => {
  let doc = createGroup(emptyDoc(), { name: 'A' })
  const a = doc.groups[0].id
  doc = createGroup(doc, { name: 'B', parentId: a })
  const b = doc.groups[1].id
  doc = setGroupArchived(doc, a, true)
  const snapshot = JSON.stringify(doc)

  let caught = null
  try {
    renameGroup(doc, a, 'Renamed')
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof Error)
  assert.equal(caught.kind, ARCHIVE_FROZEN)
  assert.equal(caught.groupId, a)
  assert.throws(() => assignSession(doc, 's1', a), /group-destination-archived/)
  assert.equal(JSON.stringify(doc), snapshot, 'mutators clone before they mutate')
  assert.equal(findGroup(doc, b).parentId, a)
})

test('the group archived flag survives clone/JSON round-trips', () => {
  let doc = createGroup(emptyDoc(), { name: 'A' })
  const a = doc.groups[0].id
  doc = setGroupArchived(doc, a, true)
  assert.equal(validateDoc(doc).ok, true)

  const copy = cloneDoc(doc)
  assert.equal(findGroup(copy, a).archived, true)
  assert.deepEqual(JSON.parse(JSON.stringify(copy)), copy)

  const restored = setGroupArchived(copy, a, false)
  assert.equal(findGroup(restored, a).archived, false)
  assert.equal(validateDoc(restored).ok, true)
})

test('corrupt cyclic docs do not hang the archive invariant', () => {
  const cyclic = {
    version: 1,
    revision: 0,
    ungrouped: [],
    groups: [
      { id: 'a', name: 'A', icon: 'folder', parentId: 'b', sessionIds: [], archived: true },
      { id: 'b', name: 'B', icon: 'folder', parentId: 'a', sessionIds: [] },
    ],
  }
  assert.equal(validateDoc(cyclic).ok, false, 'the cycle is still a validation error')
  assert.throws(() => renameGroup(cyclic, 'b', 'Renamed'), /group-archived/)
  assert.equal(findGroup(cyclic, 'b').name, 'B', 'the rejected mutation is pure')
})
