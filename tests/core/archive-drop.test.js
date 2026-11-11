import test from 'node:test'
import assert from 'node:assert/strict'
import { applyGroupDrop, checkGroupDrop } from '../../src/core/archive-drop.js'
import { resolveGroupDrop } from '../../src/core/group-drag.js'
import { findArchiveViolation } from '../../src/shared/archive.js'
import { childrenOf, createGroup, emptyDoc, findGroup, moveGroup, setGroupArchived } from '../../src/shared/model.js'

/**
 * 0.4.0-beta.62 group archive: group-drop legality (P3).
 *
 * The archived anchor set is built from the *full* doc, not from the rendered
 * (possibly pruned) view: every effectively archived group keeps its own
 * `(parentId, sibling index)` and so does every ancestor of an archived group.
 * A drop is legal only when the simulated removal + insertion leaves each of
 * those indices unchanged.
 */

const idOf = (doc, name) => {
  const group = doc.groups.find((item) => item.name === name)
  assert.ok(group, `missing group ${name}`)
  return group.id
}

const namesOf = (groups) => groups.map((group) => group.name)

const addGroup = (doc, name, parentId = null) => createGroup(doc, { name, parentId })

const archiveGroup = (doc, name) => setGroupArchived(doc, idOf(doc, name), true)

const check = (doc, draggedId, target) => checkGroupDrop(doc, draggedId, target)

/** Root children [R, B, A(archived), C]; R owns X. A hidden sibling sits between B and C. */
const hiddenBetweenFixture = () => {
  let doc = emptyDoc()
  doc = addGroup(doc, 'R')
  doc = addGroup(doc, 'B')
  doc = addGroup(doc, 'A')
  doc = addGroup(doc, 'C')
  doc = addGroup(doc, 'X', idOf(doc, 'R'))
  doc = archiveGroup(doc, 'A')
  return {
    doc,
    r: idOf(doc, 'R'),
    b: idOf(doc, 'B'),
    a: idOf(doc, 'A'),
    c: idOf(doc, 'C'),
    x: idOf(doc, 'X'),
  }
}

/** Root children [R, B, A]; R owns X; `archivedName` is the frozen sibling. */
const pairFixture = (archivedName) => {
  let doc = emptyDoc()
  doc = addGroup(doc, 'R')
  doc = addGroup(doc, 'B')
  doc = addGroup(doc, 'A')
  doc = addGroup(doc, 'X', idOf(doc, 'R'))
  doc = archiveGroup(doc, archivedName)
  return { doc, b: idOf(doc, 'B'), a: idOf(doc, 'A'), x: idOf(doc, 'X') }
}

test('archive-anchor: slots before a hidden archived sibling shift it and are rejected', () => {
  const { doc, b, x } = hiddenBetweenFixture()
  assert.deepEqual(check(doc, x, { kind: 'before', targetId: b }), { ok: false, reason: 'archived-anchor' })
  assert.deepEqual(check(doc, x, { kind: 'after', targetId: b }), { ok: false, reason: 'archived-anchor' })
  assert.deepEqual(check(doc, x, { kind: 'before', targetId: idOf(doc, 'A') }), { ok: false, reason: 'archived-anchor' })
})

test('archive-anchor: slots that keep the archived sibling in place are allowed', () => {
  const { doc, a, c, x } = hiddenBetweenFixture()
  // Between B and C: the insertion lands after A, so A keeps index 2.
  assert.deepEqual(check(doc, x, { kind: 'before', targetId: c }), {
    ok: true,
    noop: false,
    parentId: null,
    index: 3,
  })
  assert.deepEqual(check(doc, x, { kind: 'after', targetId: c }), { ok: true, noop: false, parentId: null, index: 4 })
  // Directly after the archived group is conditional-legal: A keeps index 2.
  assert.deepEqual(check(doc, x, { kind: 'after', targetId: a }), { ok: true, noop: false, parentId: null, index: 3 })
  // Root end appends behind every root sibling, so no anchor moves.
  assert.deepEqual(check(doc, x, { kind: 'root-end' }), { ok: true, noop: false, parentId: null, index: 4 })
})

test('archive-anchor: [B, A(archived)] rejects both sides of B but allows after A', () => {
  const { doc, b, a, x } = pairFixture('A')
  assert.deepEqual(check(doc, x, { kind: 'before', targetId: b }), { ok: false, reason: 'archived-anchor' })
  assert.deepEqual(check(doc, x, { kind: 'after', targetId: b }), { ok: false, reason: 'archived-anchor' })
  assert.deepEqual(check(doc, x, { kind: 'after', targetId: a }), { ok: true, noop: false, parentId: null, index: 3 })
})

test('archive-anchor: [B(archived), A] allows the slot after B (the frozen group keeps index 1)', () => {
  const { doc, b, x } = pairFixture('B')
  assert.deepEqual(check(doc, x, { kind: 'before', targetId: b }), { ok: false, reason: 'archived-anchor' })
  assert.deepEqual(check(doc, x, { kind: 'after', targetId: b }), { ok: true, noop: false, parentId: null, index: 2 })
})

test('archive-anchor applies to same-parent moves after the implied removal step', () => {
  // Root [X, A(archived)]: before A is X's current slot (no-op), after A would
  // remove X from index 0 and shift A from 1 to 0.
  let doc = emptyDoc()
  doc = addGroup(doc, 'X')
  doc = addGroup(doc, 'A')
  doc = archiveGroup(doc, 'A')
  const x = idOf(doc, 'X')
  const a = idOf(doc, 'A')
  assert.deepEqual(check(doc, x, { kind: 'before', targetId: a }), { ok: true, noop: true, parentId: null, index: 0 })
  assert.deepEqual(check(doc, x, { kind: 'after', targetId: a }), { ok: false, reason: 'archived-anchor' })

  // Root [A(archived), C, X]: dragging X right after A removes it from the end,
  // so A keeps index 0 and the move is legal.
  doc = emptyDoc()
  doc = addGroup(doc, 'A')
  doc = addGroup(doc, 'C')
  doc = addGroup(doc, 'X')
  doc = archiveGroup(doc, 'A')
  const a2 = idOf(doc, 'A')
  const x2 = idOf(doc, 'X')
  assert.deepEqual(check(doc, x2, { kind: 'after', targetId: a2 }), { ok: true, noop: false, parentId: null, index: 1 })

  // Same parent, but the removal of X from before A shifts A from 1 to 0: rejected.
  doc = emptyDoc()
  doc = addGroup(doc, 'X')
  doc = addGroup(doc, 'A')
  doc = addGroup(doc, 'C')
  doc = archiveGroup(doc, 'A')
  const x3 = idOf(doc, 'X')
  const a3 = idOf(doc, 'A')
  assert.deepEqual(check(doc, x3, { kind: 'after', targetId: a3 }), { ok: false, reason: 'archived-anchor' })
})

test('checkGroupDrop rejects an archived dragged group', () => {
  const { doc, a, b } = pairFixture('A')
  assert.deepEqual(check(doc, a, { kind: 'root-end' }), { ok: false, reason: 'archived-source' })
  assert.deepEqual(check(doc, a, { kind: 'after', targetId: b }), { ok: false, reason: 'archived-source' })
  assert.deepEqual(check(doc, a, { kind: 'before', targetId: b }), { ok: false, reason: 'archived-source' })
})

test('checkGroupDrop rejects a dragged group that contains an archived descendant', () => {
  let doc = emptyDoc()
  doc = addGroup(doc, 'P')
  doc = addGroup(doc, 'Q')
  doc = addGroup(doc, 'A', idOf(doc, 'P'))
  doc = archiveGroup(doc, 'A')
  const p = idOf(doc, 'P')
  const q = idOf(doc, 'Q')
  assert.deepEqual(check(doc, p, { kind: 'root-end' }), { ok: false, reason: 'archived-source-subtree' })
  assert.deepEqual(check(doc, p, { kind: 'after', targetId: q }), { ok: false, reason: 'archived-source-subtree' })

  // Moving a normal group into the unarchived ancestor (outside the frozen
  // group) is content addition, not an anchor shift: allowed.
  const q2 = idOf(doc, 'Q')
  const p2 = idOf(doc, 'P')
  const a2 = idOf(doc, 'A')
  assert.deepEqual(check(doc, q2, { kind: 'after', targetId: a2 }), { ok: true, noop: false, parentId: p2, index: 1 })
})

test('checkGroupDrop rejects append/head/child destinations inside an archived group', () => {
  let doc = emptyDoc()
  doc = addGroup(doc, 'A')
  doc = addGroup(doc, 'A1', idOf(doc, 'A'))
  doc = addGroup(doc, 'A2', idOf(doc, 'A'))
  doc = addGroup(doc, 'X')
  doc = archiveGroup(doc, 'A')
  const a = idOf(doc, 'A')
  const a1 = idOf(doc, 'A1')
  const a2 = idOf(doc, 'A2')
  const x = idOf(doc, 'X')

  // `child` without an anchor appends; `beforeGroupId` can only address the head.
  assert.deepEqual(check(doc, x, { kind: 'child', parentId: a, beforeGroupId: null }), { ok: false, reason: 'archived-destination' })
  assert.deepEqual(check(doc, x, { kind: 'child', parentId: a, beforeGroupId: a1 }), { ok: false, reason: 'archived-destination' })
  assert.deepEqual(check(doc, x, { kind: 'before', targetId: a1 }), { ok: false, reason: 'archived-destination' })
  assert.deepEqual(check(doc, x, { kind: 'after', targetId: a2 }), { ok: false, reason: 'archived-destination' })

  // An empty archived group still rejects the append (index 0) destination.
  doc = addGroup(doc, 'E')
  doc = archiveGroup(doc, 'E')
  assert.deepEqual(check(doc, x, { kind: 'child', parentId: idOf(doc, 'E') }), { ok: false, reason: 'archived-destination' })

  // Inserting before the archived group itself moves it; X already sits directly
  // after A, so that slot is a no-op rather than an anchor shift.
  assert.deepEqual(check(doc, x, { kind: 'before', targetId: a }), { ok: false, reason: 'archived-anchor' })
  assert.deepEqual(check(doc, x, { kind: 'after', targetId: a }), { ok: true, noop: true, parentId: null, index: 1 })
})

test('checkGroupDrop protects an archived group ancestor chain', () => {
  let doc = emptyDoc()
  doc = addGroup(doc, 'R')
  doc = addGroup(doc, 'P')
  doc = addGroup(doc, 'D')
  doc = addGroup(doc, 'X', idOf(doc, 'P'))
  doc = addGroup(doc, 'A', idOf(doc, 'P'))
  doc = addGroup(doc, 'Y', idOf(doc, 'R'))
  doc = archiveGroup(doc, 'A')
  const p = idOf(doc, 'P')
  const x = idOf(doc, 'X')
  const y = idOf(doc, 'Y')

  // Inserting in front of X shifts A from index 1 to 2 inside P.
  assert.deepEqual(check(doc, y, { kind: 'child', parentId: p, beforeGroupId: x }), { ok: false, reason: 'archived-anchor' })
  // Appending below P inserts after A: the archived anchor keeps index 1.
  assert.deepEqual(check(doc, y, { kind: 'child', parentId: p, beforeGroupId: null }), {
    ok: true,
    noop: false,
    parentId: p,
    index: 2,
  })
  // Inserting before an ancestor of the frozen subtree shifts the ancestor.
  assert.deepEqual(check(doc, y, { kind: 'before', targetId: p }), { ok: false, reason: 'archived-anchor' })
})

test('root-end is rejected when removing the dragged group shifts an archived root anchor', () => {
  let doc = emptyDoc()
  doc = addGroup(doc, 'X')
  doc = addGroup(doc, 'A')
  doc = addGroup(doc, 'C')
  doc = archiveGroup(doc, 'A')
  const x = idOf(doc, 'X')
  assert.deepEqual(check(doc, x, { kind: 'root-end' }), { ok: false, reason: 'archived-anchor' })

  // Root [A(archived), X, C]: X's removal leaves A at index 0, so the append is legal.
  doc = emptyDoc()
  doc = addGroup(doc, 'A')
  doc = addGroup(doc, 'X')
  doc = addGroup(doc, 'C')
  doc = archiveGroup(doc, 'A')
  assert.deepEqual(check(doc, idOf(doc, 'X'), { kind: 'root-end' }), { ok: true, noop: false, parentId: null, index: 3 })
})

test('checkGroupDrop reports the current position as a no-op before the anchor rule', () => {
  // Root [B, A(archived)]: B already sits before A, so the anchor shift is moot.
  let doc = emptyDoc()
  doc = addGroup(doc, 'B')
  doc = addGroup(doc, 'A')
  doc = archiveGroup(doc, 'A')
  assert.deepEqual(check(doc, idOf(doc, 'B'), { kind: 'before', targetId: idOf(doc, 'A') }), {
    ok: true,
    noop: true,
    parentId: null,
    index: 0,
  })

  // Nested children [X, A(archived), Y]: Y is already the last child.
  doc = emptyDoc()
  doc = addGroup(doc, 'P')
  doc = addGroup(doc, 'X', idOf(doc, 'P'))
  doc = addGroup(doc, 'A', idOf(doc, 'P'))
  doc = addGroup(doc, 'Y', idOf(doc, 'P'))
  doc = archiveGroup(doc, 'A')
  assert.deepEqual(check(doc, idOf(doc, 'Y'), { kind: 'child', parentId: idOf(doc, 'P'), beforeGroupId: null }), {
    ok: true,
    noop: true,
    parentId: idOf(doc, 'P'),
    index: 2,
  })

  // root-end for the last root group is the same slot.
  doc = emptyDoc()
  doc = addGroup(doc, 'A')
  doc = addGroup(doc, 'C')
  doc = addGroup(doc, 'X')
  doc = archiveGroup(doc, 'A')
  assert.deepEqual(check(doc, idOf(doc, 'X'), { kind: 'root-end' }), { ok: true, noop: true, parentId: null, index: 3 })
})

/** Root children [P, B, X]; P's only child A is archived. */
const invalidFixture = () => {
  let doc = emptyDoc()
  doc = addGroup(doc, 'P')
  doc = addGroup(doc, 'A', idOf(doc, 'P'))
  doc = addGroup(doc, 'B')
  doc = addGroup(doc, 'X')
  doc = archiveGroup(doc, 'A')
  return {
    doc,
    a: idOf(doc, 'A'),
    b: idOf(doc, 'B'),
    p: idOf(doc, 'P'),
    x: idOf(doc, 'X'),
  }
}

test('checkGroupDrop propagates the resolver invalid reasons unchanged', () => {
  const { doc, a, b, p, x } = invalidFixture()

  assert.deepEqual(check(doc, 'missing', { kind: 'root-end' }), { ok: false, reason: 'dragged-missing' })
  assert.deepEqual(check(doc, b, null), { ok: false, reason: 'target-invalid' })
  assert.deepEqual(check(doc, b, { kind: 'nope' }), { ok: false, reason: 'target-invalid' })
  assert.deepEqual(check(doc, b, { kind: 'before', targetId: 'missing' }), { ok: false, reason: 'target-missing' })
  assert.deepEqual(check(doc, b, { kind: 'before', targetId: b }), { ok: false, reason: 'self' })
  assert.deepEqual(check(doc, b, { kind: 'child', parentId: 'missing' }), { ok: false, reason: 'parent-missing' })
  assert.deepEqual(check(doc, b, { kind: 'child', parentId: p, beforeGroupId: 'missing' }), { ok: false, reason: 'anchor-missing' })
  assert.deepEqual(check(doc, p, { kind: 'child', parentId: a }), { ok: false, reason: 'descendant' })
  assert.deepEqual(checkGroupDrop(null, b, { kind: 'root-end' }), { ok: false, reason: 'doc-invalid' })
  assert.equal(check(doc, b, { kind: 'root-end' }).ok, true, 'sanity: the fixture itself accepts a plain move')
  assert.equal(check(doc, x, { kind: 'root-end' }).ok, true)
})

test('checking a group drop never mutates the doc', () => {
  const { doc, x, c } = hiddenBetweenFixture()
  const snapshot = JSON.stringify(doc)
  check(doc, x, { kind: 'after', targetId: c })
  check(doc, x, { kind: 'before', targetId: c })
  assert.equal(JSON.stringify(doc), snapshot)
})

test('applyGroupDrop commits allowed moves and keeps rejected/no-op docs identical', () => {
  const { doc, a, b, c, x } = hiddenBetweenFixture()
  const snapshot = JSON.stringify(doc)

  const allowed = applyGroupDrop(doc, x, { kind: 'after', targetId: c })
  assert.equal(allowed.applied, true)
  assert.deepEqual(namesOf(childrenOf(allowed.doc, null)), ['R', 'B', 'A', 'C', 'X'])
  assert.equal(findArchiveViolation(doc, allowed.doc), null, 'an applied drop satisfies the shared frozen-subtree invariant')
  assert.equal(JSON.stringify(doc), snapshot, 'the input doc is never mutated')

  const rejected = applyGroupDrop(doc, x, { kind: 'after', targetId: b })
  assert.equal(rejected.applied, false)
  assert.equal(rejected.reason, 'archived-anchor')
  assert.equal(rejected.doc, doc)

  const noop = applyGroupDrop(doc, b, { kind: 'before', targetId: a })
  assert.equal(noop.applied, false)
  assert.equal(noop.noop, true)
  assert.equal(noop.doc, doc)

  const invalid = applyGroupDrop(doc, x, { kind: 'nope' })
  assert.equal(invalid.applied, false)
  assert.equal(invalid.reason, 'target-invalid')
  assert.equal(invalid.doc, doc)

  const sourceArchived = applyGroupDrop(doc, a, { kind: 'root-end' })
  assert.equal(sourceArchived.applied, false)
  assert.equal(sourceArchived.reason, 'archived-source')
  assert.equal(sourceArchived.doc, doc)

  assert.equal(applyGroupDrop(null, x, { kind: 'root-end' }).reason, 'doc-invalid')
})

test('preview and commit agree across the hidden-sibling matrix', () => {
  const { doc, b, c, x } = hiddenBetweenFixture()
  const cases = [
    { target: { kind: 'before', targetId: b }, ok: false, reason: 'archived-anchor' },
    { target: { kind: 'after', targetId: b }, ok: false, reason: 'archived-anchor' },
    { target: { kind: 'before', targetId: c }, ok: true, order: ['R', 'B', 'A', 'X', 'C'] },
    { target: { kind: 'after', targetId: c }, ok: true, order: ['R', 'B', 'A', 'C', 'X'] },
    { target: { kind: 'root-end' }, ok: true, order: ['R', 'B', 'A', 'C', 'X'] },
  ]
  for (const entry of cases) {
    const verdict = check(doc, x, entry.target)
    assert.equal(verdict.ok, entry.ok, `check verdict for ${JSON.stringify(entry.target)}`)
    if (!entry.ok) assert.equal(verdict.reason, entry.reason)
    const result = applyGroupDrop(doc, x, entry.target)
    assert.equal(result.applied, entry.ok, `commit verdict for ${JSON.stringify(entry.target)}`)
    if (entry.ok) {
      assert.deepEqual(namesOf(childrenOf(result.doc, null)), entry.order)
      assert.equal(findArchiveViolation(doc, result.doc), null)
    } else {
      assert.equal(result.doc, doc)
      assert.equal(result.reason, entry.reason)
    }
  }
})

test('archived-anchor rejections match the shared frozen-subtree invariant', () => {
  const { doc, a, b, x } = hiddenBetweenFixture()
  const targets = [
    { kind: 'before', targetId: b },
    { kind: 'after', targetId: b },
    { kind: 'before', targetId: a },
  ]
  for (const target of targets) {
    const verdict = check(doc, x, target)
    assert.equal(verdict.reason, 'archived-anchor')
    const resolved = resolveGroupDrop({ doc, draggedId: x, target })
    assert.equal(resolved.invalid, undefined)
    assert.throws(
      () => moveGroup(doc, x, resolved.parentId, resolved.index),
      (error) => error.kind === 'archive-frozen',
      `moveGroup must reject the same slot for ${JSON.stringify(target)}`,
    )
  }
})

test('applied group drops keep child order and the archived anchor intact', () => {
  const { doc, c, x } = hiddenBetweenFixture()
  const a = idOf(doc, 'A')
  const result = applyGroupDrop(doc, x, { kind: 'after', targetId: c })
  assert.equal(result.applied, true)
  assert.deepEqual(namesOf(childrenOf(result.doc, null)), ['R', 'B', 'A', 'C', 'X'])
  assert.equal(findGroup(result.doc, a).archived, true)
  assert.deepEqual(findGroup(result.doc, a).sessionIds, [])
})
