import test from 'node:test'
import assert from 'node:assert/strict'
import { applyDrop, checkSessionDrop, hitTest, sameDropTarget, sessionLocation, stickyDropTarget, ungroupedBodyTarget } from '../../src/core/drag.js'
import { isCurrentGroupPosition, resolveGroupDrop } from '../../src/core/group-drag.js'
import { assignSession, createGroup, emptyDoc, findGroup, setGroupArchived } from '../../src/shared/model.js'

const docWithTwoGroups = () => {
  let doc = emptyDoc()
  doc = createGroup(doc, { name: 'A' })
  const a = doc.groups[0].id
  doc = createGroup(doc, { name: 'B' })
  const b = doc.groups[1].id
  doc = assignSession(doc, 's1', a)
  doc = assignSession(doc, 's2', a)
  doc = assignSession(doc, 's3', b)
  return { doc, a, b }
}

test('hitTest splits session rows into before/after halves', () => {
  const source = { kind: 'session', sessionId: 's1' }
  const top = hitTest({ source, rowKind: 'session', pointerY: 10, rowTop: 0, rowHeight: 20, targetGroupId: 'g', targetSessionId: 's2' })
  assert.deepEqual(top, { kind: 'session-before', groupId: 'g', sessionId: 's2' })
  const bottom = hitTest({ source, rowKind: 'session', pointerY: 18, rowTop: 0, rowHeight: 20, targetGroupId: 'g', targetSessionId: 's2' })
  assert.deepEqual(bottom, { kind: 'session-after', groupId: 'g', sessionId: 's2' })
})

test('hitTest maps group rows, ungrouped and invalid targets', () => {
  const source = { kind: 'session', sessionId: 's1' }
  assert.deepEqual(hitTest({ source, rowKind: 'group', pointerY: 5, rowTop: 0, rowHeight: 20, targetGroupId: 'g1' }), { kind: 'group-append', groupId: 'g1' })
  assert.deepEqual(hitTest({ source, rowKind: 'group-head', pointerY: 5, rowTop: 0, rowHeight: 20, targetGroupId: 'g1' }), { kind: 'group-head', groupId: 'g1' })
  assert.deepEqual(hitTest({ source, rowKind: 'ungrouped', pointerY: 0, rowTop: 0, rowHeight: 10 }), { kind: 'ungrouped' })
  assert.deepEqual(hitTest({ source, rowKind: 'session', pointerY: 5, rowTop: 0, rowHeight: 20, targetSessionId: 's1' }), { kind: 'invalid' })
  assert.deepEqual(hitTest({ source: null, rowKind: 'group', pointerY: 5, rowTop: 0, rowHeight: 20, targetGroupId: 'g1' }), { kind: 'invalid' })
})

test('applyDrop moves a session between groups without duplicates', () => {
  const { doc, a, b } = docWithTwoGroups()
  const result = applyDrop(doc, { kind: 'session', sessionId: 's1' }, { kind: 'group-append', groupId: b })
  assert.equal(result.applied, true)
  assert.deepEqual(findGroup(result.doc, b).sessionIds, ['s3', 's1'])
  assert.deepEqual(findGroup(result.doc, a).sessionIds, ['s2'])
  const all = result.doc.groups.flatMap((group) => group.sessionIds)
  assert.equal(new Set(all).size, all.length)
})

test('applyDrop reorders inside the same group with anchor shift', () => {
  const { doc, a } = docWithTwoGroups()
  const moved = applyDrop(doc, { kind: 'session', sessionId: 's1' }, { kind: 'session-after', groupId: a, sessionId: 's2' })
  assert.equal(moved.applied, true)
  assert.deepEqual(findGroup(moved.doc, a).sessionIds, ['s2', 's1'])
  const noop = applyDrop(moved.doc, { kind: 'session', sessionId: 's1' }, { kind: 'session-after', groupId: a, sessionId: 's2' })
  assert.equal(noop.applied, false)
})

test('applyDrop group-append and group-head place the session', () => {
  const { doc, a, b } = docWithTwoGroups()
  const head = applyDrop(doc, { kind: 'session', sessionId: 's3' }, { kind: 'group-head', groupId: a })
  assert.deepEqual(findGroup(head.doc, a).sessionIds, ['s3', 's1', 's2'])
  const append = applyDrop(head.doc, { kind: 'session', sessionId: 's3' }, { kind: 'group-append', groupId: b })
  assert.deepEqual(findGroup(append.doc, b).sessionIds, ['s3'])
})

test('applyDrop ungrouped removes the session from its group', () => {
  const { doc, a } = docWithTwoGroups()
  const result = applyDrop(doc, { kind: 'session', sessionId: 's1' }, { kind: 'ungrouped' })
  assert.equal(result.applied, true)
  assert.deepEqual(findGroup(result.doc, a).sessionIds, ['s2'])
  assert.deepEqual(result.doc.ungrouped, ['s1'])
})

test('applyDrop ungrouped reorder writes the full visible order once', () => {
  const { doc } = docWithTwoGroups()
  const withUngrouped = assignSession(doc, 'u1', null)
  const visible = ['u2', 'u1']
  const result = applyDrop(withUngrouped, { kind: 'session', sessionId: 'u1' }, { kind: 'ungrouped' }, visible)
  assert.equal(result.applied, true)
  assert.deepEqual(result.doc.ungrouped, ['u1', 'u2'])
})

test('applyDrop unknown target kinds are inert and preserve document identity', () => {
  const { doc } = docWithTwoGroups()
  const result = applyDrop(doc, { kind: 'session', sessionId: 's1' }, { kind: 'unknown-target' })
  assert.equal(result.applied, false)
  assert.equal(result.doc, doc)
})

test('applyDrop invalid target returns the original doc', () => {
  const { doc } = docWithTwoGroups()
  const result = applyDrop(doc, { kind: 'session', sessionId: 's1' }, { kind: 'invalid' })
  assert.equal(result.applied, false)
  assert.equal(result.doc, doc)
})

test('sessionLocation finds group and index', () => {
  const { doc, a, b } = docWithTwoGroups()
  assert.deepEqual(sessionLocation(doc, 's2'), { groupId: a, index: 1 })
  assert.deepEqual(sessionLocation(doc, 's3'), { groupId: b, index: 0 })
  assert.deepEqual(sessionLocation(doc, 'missing'), { groupId: null, index: -1 })
})

test('group drop resolution rejects cycles and treats the current slot as a no-op', () => {
  const { doc, a } = docWithTwoGroups()
  const withChild = createGroup(doc, { name: 'child', parentId: a })
  const child = withChild.groups.find((group) => group.name === 'child')
  const withGrand = createGroup(withChild, { name: 'grand', parentId: child.id })

  // A parent cannot move below its own descendant, nor a group onto itself.
  assert.deepEqual(
    resolveGroupDrop({ doc: withGrand, draggedId: a, target: { kind: 'child', parentId: child.id } }),
    { invalid: true, reason: 'descendant' },
  )
  assert.deepEqual(
    resolveGroupDrop({ doc: withGrand, draggedId: child.id, target: { kind: 'child', parentId: child.id } }),
    { invalid: true, reason: 'self' },
  )

  // The child's current slot resolves, but the client skips the no-op move.
  const target = { kind: 'child', parentId: a, beforeGroupId: null }
  const resolved = resolveGroupDrop({ doc: withGrand, draggedId: child.id, target })
  assert.deepEqual(resolved, { parentId: a, index: 0 })
  assert.equal(isCurrentGroupPosition(withGrand, child.id, resolved, target), true)
})

test('sameDropTarget treats equivalent dragover targets as equal (0.2.2 hover dedupe)', () => {
  // The same row/zone rebuilt as a new object must be a no-op, otherwise every
  // resting dragover re-renders the whole tree.
  assert.equal(sameDropTarget(null, null), true)
  assert.equal(sameDropTarget(undefined, null), true)
  assert.equal(sameDropTarget({ kind: 'group-append', groupId: 'g1' }, { kind: 'group-append', groupId: 'g1' }), true)
  assert.equal(sameDropTarget({ kind: 'ungrouped' }, { kind: 'ungrouped' }), true)
  assert.equal(
    sameDropTarget({ kind: 'session-before', groupId: 'g1', sessionId: 's2' }, { kind: 'session-before', groupId: 'g1', sessionId: 's2' }),
    true
  )
  // undefined/null anchors are equivalent for child slots.
  assert.equal(
    sameDropTarget({ kind: 'group-child', parentId: 'g1', beforeGroupId: null }, { kind: 'group-child', parentId: 'g1' }),
    true
  )
  assert.equal(sameDropTarget({ kind: 'group-before', targetId: 'g1' }, { kind: 'group-before', targetId: 'g2' }), false)
})

test('sameDropTarget distinguishes every semantic target change', () => {
  assert.equal(sameDropTarget({ kind: 'group-append', groupId: 'g1' }, { kind: 'group-append', groupId: 'g2' }), false)
  // Crossing a row's midline must move the insertion line.
  assert.equal(
    sameDropTarget({ kind: 'session-before', groupId: 'g1', sessionId: 's2' }, { kind: 'session-after', groupId: 'g1', sessionId: 's2' }),
    false
  )
  assert.equal(
    sameDropTarget({ kind: 'group-child', parentId: 'g1', beforeGroupId: null }, { kind: 'group-child', parentId: 'g1', beforeGroupId: 'g2' }),
    false
  )
  assert.equal(sameDropTarget({ kind: 'group-before', targetId: 'g1' }, { kind: 'group-forbidden', targetId: 'g1' }), false)
  assert.equal(sameDropTarget({ kind: 'group-append', groupId: 'g1' }, null), false)
  // No target -> a target is always a change; the ref starts at null.
  assert.equal(sameDropTarget(null, { kind: 'ungrouped' }), false)
})

test('0.2.21 sticky target holds while the pointer rests inside the radius', () => {
  const target = { kind: 'session-before', sessionId: 's1' }
  const lock = { x: 100, y: 200, target }
  assert.equal(stickyDropTarget(lock, 100, 200), target)
  assert.equal(stickyDropTarget(lock, 103, 201), target)
  assert.equal(stickyDropTarget(lock, 105, 200), null)
  assert.equal(stickyDropTarget(lock, Number.NaN, 200), null)
  assert.equal(stickyDropTarget(null, 100, 200), null)
})

test('0.2.54 ungrouped body fallback follows visible rows, not the section top', () => {
  const rows = [
    { sessionId: 's1', top: 100, height: 32 },
    { sessionId: 's2', top: 134, height: 32 },
    { sessionId: 's3', top: 168, height: 32 },
  ]
  assert.deepEqual(ungroupedBodyTarget(rows, 90), { kind: 'session-before', groupId: null, sessionId: 's1' })
  assert.deepEqual(ungroupedBodyTarget(rows, 110), { kind: 'session-before', groupId: null, sessionId: 's1' })
  assert.deepEqual(ungroupedBodyTarget(rows, 130), { kind: 'session-before', groupId: null, sessionId: 's2' })
  assert.deepEqual(ungroupedBodyTarget(rows, 165), { kind: 'session-before', groupId: null, sessionId: 's3' })
  assert.deepEqual(ungroupedBodyTarget(rows, 200), { kind: 'session-after', groupId: null, sessionId: 's3' })
  assert.deepEqual(ungroupedBodyTarget([], 200), { kind: 'ungrouped' })
  assert.deepEqual(ungroupedBodyTarget(null, 200), { kind: 'ungrouped' })
  assert.deepEqual(ungroupedBodyTarget(rows, Number.NaN), { kind: 'ungrouped' })
})

// ---------------------------------------------------------------------------
// 0.4.0-beta.62 group archive: session container lock (P3)
// ---------------------------------------------------------------------------
/** A(archived) owns [s1, s2, s3]; B owns [t1, t2]; C is empty; u1 is ungrouped. */
const archivedFixture = () => {
  let doc = emptyDoc()
  doc = createGroup(doc, { name: 'A' })
  doc = createGroup(doc, { name: 'B' })
  doc = createGroup(doc, { name: 'C' })
  const a = doc.groups[0].id
  const b = doc.groups[1].id
  const c = doc.groups[2].id
  doc = assignSession(doc, 's1', a)
  doc = assignSession(doc, 's2', a)
  doc = assignSession(doc, 's3', a)
  doc = assignSession(doc, 't1', b)
  doc = assignSession(doc, 't2', b)
  doc = assignSession(doc, 'u1', null)
  doc = setGroupArchived(doc, a, true)
  return { doc, a, b, c, snapshot: JSON.stringify(doc) }
}

test('checkSessionDrop locks every structural move whose source sits in an archived container', () => {
  const { doc, a, b, snapshot } = archivedFixture()
  const source = { kind: 'session', sessionId: 's1' }
  // Reordering inside the frozen container, moving to a group head/append, and
  // dragging a frozen session out to the ungrouped list are all container locks.
  assert.deepEqual(checkSessionDrop(doc, source, { kind: 'session-before', groupId: a, sessionId: 's2' }), {
    ok: false,
    reason: 'archived-container',
  })
  assert.deepEqual(checkSessionDrop(doc, source, { kind: 'session-after', groupId: a, sessionId: 's2' }), {
    ok: false,
    reason: 'archived-container',
  })
  assert.deepEqual(checkSessionDrop(doc, source, { kind: 'group-head', groupId: a }), { ok: false, reason: 'archived-container' })
  assert.deepEqual(checkSessionDrop(doc, source, { kind: 'group-append', groupId: a }), { ok: false, reason: 'archived-container' })
  assert.deepEqual(checkSessionDrop(doc, source, { kind: 'group-append', groupId: b }), { ok: false, reason: 'archived-container' })
  assert.deepEqual(checkSessionDrop(doc, source, { kind: 'ungrouped' }), { ok: false, reason: 'archived-container' })
  assert.equal(JSON.stringify(doc), snapshot, 'checking a drop never mutates the doc')
})

test('checkSessionDrop rejects dropping into an archived container from outside', () => {
  const { doc, a, b } = archivedFixture()
  const fromGroup = { kind: 'session', sessionId: 't1' }
  const fromUngrouped = { kind: 'session', sessionId: 'u1' }
  for (const source of [fromGroup, fromUngrouped]) {
    assert.deepEqual(checkSessionDrop(doc, source, { kind: 'group-append', groupId: a }), { ok: false, reason: 'archived-destination' })
    assert.deepEqual(checkSessionDrop(doc, source, { kind: 'group-head', groupId: a }), { ok: false, reason: 'archived-destination' })
    assert.deepEqual(checkSessionDrop(doc, source, { kind: 'session-before', groupId: a, sessionId: 's1' }), {
      ok: false,
      reason: 'archived-destination',
    })
    assert.deepEqual(checkSessionDrop(doc, source, { kind: 'session-after', groupId: a, sessionId: 's3' }), {
      ok: false,
      reason: 'archived-destination',
    })
  }
  // A non-archived destination is still fine for the same sources.
  assert.deepEqual(checkSessionDrop(doc, fromGroup, { kind: 'group-append', groupId: b }), { ok: true, noop: false })
  assert.deepEqual(checkSessionDrop(doc, fromUngrouped, { kind: 'session-before', groupId: b, sessionId: 't1' }), {
    ok: true,
    noop: false,
  })
})

test('checkSessionDrop keeps normal cross-group, ungrouped and reorder moves unchanged', () => {
  const { doc, b, c, snapshot } = archivedFixture()
  const fromB = { kind: 'session', sessionId: 't1' }
  assert.deepEqual(checkSessionDrop(doc, fromB, { kind: 'group-append', groupId: c }), { ok: true, noop: false })
  const moved = applyDrop(doc, fromB, { kind: 'group-append', groupId: c })
  assert.equal(moved.applied, true)
  assert.deepEqual(findGroup(moved.doc, c).sessionIds, ['t1'])
  assert.deepEqual(findGroup(moved.doc, b).sessionIds, ['t2'])

  const out = applyDrop(doc, fromB, { kind: 'ungrouped' })
  assert.equal(out.applied, true)
  assert.deepEqual(out.doc.ungrouped, ['t1', 'u1'])

  const inFromUngrouped = applyDrop(doc, { kind: 'session', sessionId: 'u1' }, { kind: 'group-head', groupId: b })
  assert.equal(inFromUngrouped.applied, true)
  assert.deepEqual(findGroup(inFromUngrouped.doc, b).sessionIds, ['u1', 't1', 't2'])

  const reordered = applyDrop(doc, fromB, { kind: 'session-after', groupId: b, sessionId: 't2' })
  assert.equal(reordered.applied, true)
  assert.deepEqual(findGroup(reordered.doc, b).sessionIds, ['t2', 't1'])
  assert.equal(JSON.stringify(doc), snapshot, 'checks and applies leave the input doc untouched')
})

test('checkSessionDrop marks real no-op positions without mutating the doc', () => {
  const { doc, b } = archivedFixture()
  assert.deepEqual(checkSessionDrop(doc, { kind: 'session', sessionId: 't1' }, { kind: 'session-before', groupId: b, sessionId: 't2' }), {
    ok: true,
    noop: true,
  })
  assert.deepEqual(checkSessionDrop(doc, { kind: 'session', sessionId: 't2' }, { kind: 'session-after', groupId: b, sessionId: 't1' }), {
    ok: true,
    noop: true,
  })
  assert.deepEqual(checkSessionDrop(doc, { kind: 'session', sessionId: 't1' }, { kind: 'group-head', groupId: b }), {
    ok: true,
    noop: true,
  })
  assert.deepEqual(checkSessionDrop(doc, { kind: 'session', sessionId: 't2' }, { kind: 'group-append', groupId: b }), {
    ok: true,
    noop: true,
  })
  // A same-group move with a real destination is not a no-op.
  assert.deepEqual(checkSessionDrop(doc, { kind: 'session', sessionId: 't1' }, { kind: 'session-after', groupId: b, sessionId: 't2' }), {
    ok: true,
    noop: false,
  })
  const noop = applyDrop(doc, { kind: 'session', sessionId: 't2' }, { kind: 'group-append', groupId: b })
  assert.equal(noop.applied, false)
  assert.equal(noop.noop, true)
  assert.equal(noop.doc, doc, 'a no-op drop returns the same doc and never bumps the revision')
})

test('checkSessionDrop rejects invalid and self targets with the invalid reason', () => {
  const { doc, b } = archivedFixture()
  const source = { kind: 'session', sessionId: 't1' }
  for (const target of [
    null,
    undefined,
    { kind: 'invalid' },
    { kind: 'unknown-target' },
    { kind: 'session-before' },
    { kind: 'session-before', groupId: b, sessionId: 't1' },
    { kind: 'session-after', groupId: b, sessionId: 't1' },
    { kind: 'session-before', groupId: b, sessionId: 'missing' },
    { kind: 'group-append' },
    { kind: 'group-append', groupId: 'missing' },
    { kind: 'group-head', groupId: 'missing' },
  ]) {
    assert.deepEqual(checkSessionDrop(doc, source, target), { ok: false, reason: 'invalid' })
  }
  assert.deepEqual(checkSessionDrop(doc, null, { kind: 'ungrouped' }), { ok: false, reason: 'invalid' })
  assert.deepEqual(checkSessionDrop(doc, { kind: 'group', groupId: b }, { kind: 'ungrouped' }), { ok: false, reason: 'invalid' })
})

test('applyDrop reports the archive reason and preserves the doc identity when rejected', () => {
  const { doc, a } = archivedFixture()
  const out = applyDrop(doc, { kind: 'session', sessionId: 's2' }, { kind: 'ungrouped' })
  assert.equal(out.applied, false)
  assert.equal(out.reason, 'archived-container')
  assert.equal(out.doc, doc)

  const into = applyDrop(doc, { kind: 'session', sessionId: 't1' }, { kind: 'group-append', groupId: a })
  assert.equal(into.applied, false)
  assert.equal(into.reason, 'archived-destination')
  assert.equal(into.doc, doc)
})

test('ungrouped drops stay legal for ungrouped sources and a no-op without a visible reorder list', () => {
  const { doc } = archivedFixture()
  const source = { kind: 'session', sessionId: 'u1' }
  // checkSessionDrop cannot see the visible ungrouped order, so it allows the
  // drop; applyDrop resolves the actual no-op (no visible list, same section).
  assert.deepEqual(checkSessionDrop(doc, source, { kind: 'ungrouped' }), { ok: true, noop: false })
  const result = applyDrop(doc, source, { kind: 'ungrouped' })
  assert.equal(result.applied, false)
  assert.equal(result.noop, true)
  assert.equal(result.doc, doc)
  // A visible manual order makes the same gesture a real rethink of the order.
  const reordered = applyDrop(doc, source, { kind: 'ungrouped' }, ['u1', 'u2'])
  assert.equal(reordered.applied, true)
  assert.deepEqual(reordered.doc.ungrouped, ['u1', 'u2'])
})

// ---------------------------------------------------------------------------
// 0.4.0-beta.62 B1: ungrouped *anchor* targets keep their resolved index;
// only the `{ kind: 'ungrouped' }` *container* target means "top of the list".
// ---------------------------------------------------------------------------
/** B owns [t1, t2]; the ungrouped list is [u1, u2, u3]. */
const ungroupedFixture = () => {
  let doc = emptyDoc()
  doc = createGroup(doc, { name: 'B' })
  const b = doc.groups[0].id
  doc = assignSession(doc, 't1', b)
  doc = assignSession(doc, 't2', b)
  doc = assignSession(doc, 'u1', null)
  doc = assignSession(doc, 'u2', null)
  doc = assignSession(doc, 'u3', null)
  return { doc, b }
}

test('B1 grouped sessions dropped on an ungrouped anchor land at the anchor index, not the top', () => {
  const { doc, b } = ungroupedFixture()
  // Dropping after u1 and before u2 both resolve to index 1 in the ungrouped list.
  for (const target of [
    { kind: 'session-after', groupId: null, sessionId: 'u1' },
    { kind: 'session-before', groupId: null, sessionId: 'u2' },
  ]) {
    const result = applyDrop(doc, { kind: 'session', sessionId: 't1' }, target)
    assert.equal(result.applied, true)
    assert.deepEqual(result.doc.ungrouped, ['u1', 't1', 'u2', 'u3'])
    assert.deepEqual(findGroup(result.doc, b).sessionIds, ['t2'])
  }
})

test('B1 ungrouped anchor drops between ungrouped rows really swap them', () => {
  const { doc } = ungroupedFixture()
  const after = applyDrop(doc, { kind: 'session', sessionId: 'u1' }, { kind: 'session-after', groupId: null, sessionId: 'u2' })
  assert.equal(after.applied, true)
  assert.deepEqual(after.doc.ungrouped, ['u2', 'u1', 'u3'])

  const before = applyDrop(doc, { kind: 'session', sessionId: 'u3' }, { kind: 'session-before', groupId: null, sessionId: 'u1' })
  assert.equal(before.applied, true)
  assert.deepEqual(before.doc.ungrouped, ['u3', 'u1', 'u2'])
})

test('B1 an ungrouped anchor target ignores the visible order when the source is already ungrouped', () => {
  const { doc } = ungroupedFixture()
  // The visible order is deliberately not the resolved insertion order; an
  // anchor drop must follow `sessionDropPosition`, never unshift to the top.
  const result = applyDrop(
    doc,
    { kind: 'session', sessionId: 'u1' },
    { kind: 'session-after', groupId: null, sessionId: 'u2' },
    ['u2', 'u1', 'u3'],
  )
  assert.equal(result.applied, true)
  assert.deepEqual(result.doc.ungrouped, ['u2', 'u1', 'u3'])
})

test('B1 an ungrouped anchor target resolves against doc.ungrouped without a visible order', () => {
  const { doc } = ungroupedFixture()
  // No visible list: the old container branch read this as a no-op.
  const result = applyDrop(doc, { kind: 'session', sessionId: 'u2' }, { kind: 'session-before', groupId: null, sessionId: 'u1' })
  assert.equal(result.applied, true)
  assert.deepEqual(result.doc.ungrouped, ['u2', 'u1', 'u3'])
})

test('B1 the {kind:"ungrouped"} container target keeps its top/reorder semantics', () => {
  const { doc } = ungroupedFixture()
  // A grouped session dropped on the container still moves to the top.
  const fromGroup = applyDrop(doc, { kind: 'session', sessionId: 't1' }, { kind: 'ungrouped' })
  assert.equal(fromGroup.applied, true)
  assert.deepEqual(fromGroup.doc.ungrouped, ['t1', 'u1', 'u2', 'u3'])

  // An ungrouped source with a visible order is still unshifted to the top of it.
  const reorder = applyDrop(doc, { kind: 'session', sessionId: 'u3' }, { kind: 'ungrouped' }, ['u1', 'u2', 'u3'])
  assert.equal(reorder.applied, true)
  assert.deepEqual(reorder.doc.ungrouped, ['u3', 'u1', 'u2'])

  // Without a visible order the container target is still the existing no-op.
  const noop = applyDrop(doc, { kind: 'session', sessionId: 'u1' }, { kind: 'ungrouped' })
  assert.equal(noop.applied, false)
  assert.equal(noop.noop, true)
  assert.equal(noop.doc, doc)
})
