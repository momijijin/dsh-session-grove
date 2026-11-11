import test from 'node:test'
import assert from 'node:assert/strict'
import { createGroup, emptyDoc, setGroupArchived } from '../../src/shared/model.js'
import { groupHeaderZoneFromRect, isCurrentGroupPosition, resolveGroupDrop } from '../../src/core/group-drag.js'

const idOf = (doc, name) => {
  const group = doc.groups.find((item) => item.name === name)
  assert.ok(group, `missing group ${name}`)
  return group.id
}

const fixture = () => {
  let doc = emptyDoc()
  doc = createGroup(doc, { name: 'A' })
  doc = createGroup(doc, { name: 'B' })
  doc = createGroup(doc, { name: 'C' })
  return doc
}

test('groupHeaderZoneFromRect maps top/bottom quarters and rejects the middle', () => {
  const rect = { top: 100, height: 40 }
  assert.equal(groupHeaderZoneFromRect(rect, 101), 'before')
  assert.equal(groupHeaderZoneFromRect(rect, 109), 'before')
  assert.equal(groupHeaderZoneFromRect(rect, 120), null)
  assert.equal(groupHeaderZoneFromRect(rect, 131), 'after')
  assert.equal(groupHeaderZoneFromRect(rect, 139), 'after')
  assert.equal(groupHeaderZoneFromRect(null, 120), null)
  assert.equal(groupHeaderZoneFromRect({ top: 100, height: 0 }, 120), null)
})

test('isCurrentGroupPosition recognizes a no-op sibling position', () => {
  const doc = fixture()
  const ids = doc.groups.map((group) => group.id)
  assert.equal(isCurrentGroupPosition(doc, ids[1], { parentId: null, index: 1 }, { kind: 'group' }), true)
  assert.equal(isCurrentGroupPosition(doc, ids[1], { parentId: null, index: 0 }, { kind: 'group' }), false)
  assert.equal(isCurrentGroupPosition(doc, ids[1], { parentId: 'other', index: 1 }, { kind: 'group' }), false)
  assert.equal(isCurrentGroupPosition(doc, ids[2], { parentId: null, index: 2 }, { kind: 'root-end' }), true)
})

test('isCurrentGroupPosition resolves the current slot next to an archived sibling', () => {
  let doc = emptyDoc()
  doc = createGroup(doc, { name: 'B' })
  doc = createGroup(doc, { name: 'A' })
  const b = idOf(doc, 'B')
  const a = idOf(doc, 'A')
  doc = setGroupArchived(doc, a, true)

  const beforeA = resolveGroupDrop({ doc, draggedId: b, target: { kind: 'before', targetId: a } })
  assert.deepEqual(beforeA, { parentId: null, index: 0 })
  assert.equal(isCurrentGroupPosition(doc, b, beforeA, { kind: 'before', targetId: a }), true)

  const afterA = resolveGroupDrop({ doc, draggedId: b, target: { kind: 'after', targetId: a } })
  assert.deepEqual(afterA, { parentId: null, index: 1 })
  assert.equal(isCurrentGroupPosition(doc, b, afterA, { kind: 'after', targetId: a }), false)
})

test('isCurrentGroupPosition recognizes the last child slot below an archived sibling', () => {
  let doc = emptyDoc()
  doc = createGroup(doc, { name: 'P' })
  const p = idOf(doc, 'P')
  doc = createGroup(doc, { name: 'X', parentId: p })
  doc = createGroup(doc, { name: 'A', parentId: p })
  doc = createGroup(doc, { name: 'Y', parentId: p })
  const y = idOf(doc, 'Y')
  const a = idOf(doc, 'A')
  doc = setGroupArchived(doc, a, true)

  const target = { kind: 'child', parentId: p, beforeGroupId: null }
  const resolved = resolveGroupDrop({ doc, draggedId: y, target })
  // The append index is measured on the pre-removal children; the client
  // compares it against the post-removal count, which is the current slot here.
  assert.deepEqual(resolved, { parentId: p, index: 2 })
  assert.equal(isCurrentGroupPosition(doc, y, resolved, target), true)
})

test('resolveGroupDrop keeps post-removal coordinates around archived siblings', () => {
  let doc = emptyDoc()
  doc = createGroup(doc, { name: 'B' })
  doc = createGroup(doc, { name: 'A' })
  doc = createGroup(doc, { name: 'C' })
  const b = idOf(doc, 'B')
  const a = idOf(doc, 'A')
  const c = idOf(doc, 'C')
  doc = setGroupArchived(doc, a, true)

  // Removing B shifts the anchor list, so the resolver reports the index the
  // anchor simulation must use (the archive guard rejects this slot).
  assert.deepEqual(resolveGroupDrop({ doc, draggedId: b, target: { kind: 'after', targetId: a } }), {
    parentId: null,
    index: 1,
  })
  assert.deepEqual(resolveGroupDrop({ doc, draggedId: c, target: { kind: 'before', targetId: b } }), {
    parentId: null,
    index: 0,
  })
})
