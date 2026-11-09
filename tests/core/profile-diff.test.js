import test from 'node:test'
import assert from 'node:assert/strict'

import { diffDocs, normalizeDocForCompare, sameDocs } from '../../src/core/profile-diff.js'

const group = (id, name, parentId = null, sessionIds = [], extra = {}) => ({
  id,
  name,
  icon: 'folder',
  color: 'blue',
  parentId,
  sessionIds,
  ...extra,
})

const doc = (groups = [], ungrouped = [], revision = 0) => ({
  version: 1,
  revision,
  groups,
  ungrouped,
})

const emptySummary = () => ({
  groups: { current: 0, target: 0, added: 0, removed: 0, changed: 0, reordered: false },
  grouped: { current: 0, target: 0 },
  ungrouped: { current: 0, target: 0 },
  sessions: { moved: 0, newlyGrouped: 0, ungrouped: 0, stale: 0 },
})

test('normalizeDocForCompare strips metadata and keeps the comparison fields', () => {
  const source = doc(
    [group('g1', 'Work', null, ['s2', 's1'], { icon: 'briefcase', colorHex: '#aabbcc' })],
    ['s3'],
    12,
  )
  const normalized = normalizeDocForCompare(source)
  assert.deepEqual(normalized, {
    groups: [
      {
        id: 'g1',
        parentId: null,
        name: 'Work',
        icon: 'briefcase',
        color: 'blue',
        colorHex: '#aabbcc',
        sessionIds: ['s2', 's1'],
      },
    ],
    ungrouped: ['s3'],
  })
  assert.equal('version' in normalized, false)
  assert.equal('revision' in normalized, false)
})

test('normalizeDocForCompare tolerates missing or empty collections', () => {
  assert.deepEqual(normalizeDocForCompare({}), { groups: [], ungrouped: [] })
  assert.deepEqual(normalizeDocForCompare(doc()), { groups: [], ungrouped: [] })
})

test('sameDocs ignores version and revision only', () => {
  const base = doc([group('g1', 'A', null, ['s1'])], ['s2'], 3)
  const copy = { ...structuredClone(base), version: 2, revision: 99 }
  assert.equal(sameDocs(base, copy), true)
})

test('sameDocs compares groups, ids, parents, names, appearance and order', () => {
  const base = doc([group('g1', 'A', null, ['s1'])], ['s2'])
  assert.equal(sameDocs(base, structuredClone(base)), true)
  assert.equal(sameDocs(base, doc([group('g1', 'B', null, ['s1'])], ['s2'])), false)
  assert.equal(sameDocs(base, doc([group('g2', 'A', null, ['s1'])], ['s2'])), false)
  assert.equal(sameDocs(base, doc([group('g1', 'A', null, ['s1'], { icon: 'briefcase' })], ['s2'])), false)
  assert.equal(sameDocs(base, doc([group('g1', 'A', null, ['s1'], { color: 'red' })], ['s2'])), false)
  assert.equal(sameDocs(base, doc([group('g1', 'A', null, ['s1'], { colorHex: '#aabbcc' })], ['s2'])), false)
  assert.equal(sameDocs(base, doc([group('g1', 'A', null, ['s1'])], ['s2', 's3'])), false)

  const nested = doc([group('p', 'P'), group('c', 'C', 'p')])
  assert.equal(sameDocs(nested, doc([group('p', 'P'), group('c', 'C', null)])), false)
  assert.equal(sameDocs(doc([group('a', 'A'), group('b', 'B')]), doc([group('b', 'B'), group('a', 'A')])), false)
  assert.equal(sameDocs(doc([group('a', 'A', null, ['s1', 's2'])]), doc([group('a', 'A', null, ['s2', 's1'])])), false)
  assert.equal(sameDocs(doc([], ['s1', 's2']), doc([], ['s2', 's1'])), false)
})

test('diffDocs reports no changes for equivalent docs and ignores revision', () => {
  const current = doc([group('a', 'A', null, ['s1'])], ['s2'], 1)
  const target = doc([group('a', 'A', null, ['s1'])], ['s2'], 9)
  const diff = diffDocs(current, target, ['s1', 's2'])
  assert.deepEqual(diff, {
    summary: {
      groups: { current: 1, target: 1, added: 0, removed: 0, changed: 0, reordered: false },
      grouped: { current: 1, target: 1 },
      ungrouped: { current: 1, target: 1 },
      sessions: { moved: 0, newlyGrouped: 0, ungrouped: 0, stale: 0 },
    },
    groups: { added: [], removed: [], changed: [], reordered: false },
    sessions: { moved: [], newlyGrouped: [], ungrouped: [], stale: [] },
    truncated: { groups: false, sessions: false },
  })
})

test('diffDocs lists added groups by path in DFS order', () => {
  const current = doc([group('a', 'A')])
  // Deliberately not stored in DFS order: the flat array is A, B, A1, B1.
  const target = doc([group('a', 'A'), group('b', 'B'), group('a1', 'A1', 'a'), group('b1', 'B1', 'b')])
  const diff = diffDocs(current, target)
  assert.deepEqual(diff.groups.added, ['A/A1', 'B', 'B/B1'])
  assert.deepEqual(diff.groups.removed, [])
  assert.equal(diff.summary.groups.added, 3)
  assert.equal(diff.summary.groups.current, 1)
  assert.equal(diff.summary.groups.target, 4)
  assert.equal(diff.groups.reordered, false)
})

test('diffDocs lists removed groups by path in DFS order', () => {
  const current = doc([group('a', 'A'), group('b', 'B'), group('a1', 'A1', 'a'), group('b1', 'B1', 'b')])
  const target = doc([group('a', 'A')])
  const diff = diffDocs(current, target)
  assert.deepEqual(diff.groups.removed, ['A/A1', 'B', 'B/B1'])
  assert.deepEqual(diff.groups.added, [])
  assert.equal(diff.summary.groups.removed, 3)
})

test('diffDocs classifies rename, move, rename+move and appearance changes', () => {
  const current = doc([
    group('p', 'Parent'),
    group('c', 'Child', 'p'),
    group('d', 'Old', 'p'),
    group('e', 'Both', 'p'),
    group('f', 'Look', 'p'),
  ])
  const target = doc([
    group('p', 'Parent'),
    group('c', 'NewName', 'p'),
    group('d', 'Old', null),
    group('e', 'Both2', null),
    group('f', 'Look', 'p', [], { icon: 'briefcase' }),
  ])
  const diff = diffDocs(current, target)
  assert.deepEqual(diff.groups.changed, [
    { id: 'c', from: 'Parent/Child', to: 'Parent/NewName', renamed: true, moved: false, appearance: false },
    { id: 'd', from: 'Parent/Old', to: 'Old', renamed: false, moved: true, appearance: false },
    { id: 'e', from: 'Parent/Both', to: 'Both2', renamed: true, moved: true, appearance: false },
    { id: 'f', from: 'Parent/Look', to: 'Parent/Look', renamed: false, moved: false, appearance: true },
  ])
  assert.equal(diff.summary.groups.changed, 4)
  assert.equal(diff.groups.reordered, false)
})

test('diffDocs flags icon, palette and custom color changes as appearance', () => {
  const base = (extra) => doc([group('g', 'G', null, [], extra)])
  for (const extra of [{ icon: 'briefcase' }, { color: 'red' }, { colorHex: '#112233' }]) {
    const diff = diffDocs(base(), base(extra))
    assert.deepEqual(diff.groups.changed, [
      { id: 'g', from: 'G', to: 'G', renamed: false, moved: false, appearance: true },
    ])
  }
})

test('diffDocs flags sibling reordering globally without changed rows', () => {
  const reorderedRoot = diffDocs(
    doc([group('a', 'A'), group('b', 'B'), group('c', 'C')]),
    doc([group('a', 'A'), group('c', 'C'), group('b', 'B')]),
  )
  assert.equal(reorderedRoot.groups.reordered, true)
  assert.equal(reorderedRoot.summary.groups.reordered, true)
  assert.deepEqual(reorderedRoot.groups.changed, [])
  assert.equal(reorderedRoot.summary.groups.changed, 0)

  const reorderedChildren = diffDocs(
    doc([group('p', 'P'), group('x', 'X', 'p'), group('y', 'Y', 'p')]),
    doc([group('p', 'P'), group('y', 'Y', 'p'), group('x', 'X', 'p')]),
  )
  assert.equal(reorderedChildren.groups.reordered, true)

  const reorderedAfterMove = diffDocs(
    doc([group('p', 'P'), group('x', 'X', 'p'), group('y', 'Y', 'p')]),
    doc([group('p', 'P'), group('x', 'X', 'p'), group('y', 'Y', null)]),
  )
  assert.equal(reorderedAfterMove.groups.reordered, false)
  assert.deepEqual(reorderedAfterMove.groups.changed.map((entry) => entry.id), ['y'])
})

test('diffDocs treats a unique equal path with a different id as the same logical group', () => {
  const current = doc([group('old', 'Work', null, ['s1'])])
  const target = doc([group('new', 'Work', null, ['s1'])])
  const diff = diffDocs(current, target, ['s1'])
  assert.deepEqual(diff.groups.added, [])
  assert.deepEqual(diff.groups.removed, [])
  assert.deepEqual(diff.groups.changed, [])
  assert.equal(diff.groups.reordered, false)
  assert.deepEqual(diff.sessions.moved, [])
  assert.equal(sameDocs(current, target), false)

  const appearance = diffDocs(current, doc([group('new', 'Work', null, ['s1'], { colorHex: '#aabbcc' })]))
  assert.deepEqual(appearance.groups.changed, [
    { id: 'new', from: 'Work', to: 'Work', renamed: false, moved: false, appearance: true },
  ])
})

test('diffDocs pairs path-identical parents with different ids without reporting moves', () => {
  const current = doc([group('p1', 'P'), group('x1', 'X', 'p1'), group('y1', 'Y', 'p1')])
  const target = doc([group('p2', 'P'), group('y2', 'Y', 'p2'), group('x2', 'X', 'p2')])
  const diff = diffDocs(current, target)
  assert.deepEqual(diff.groups.added, [])
  assert.deepEqual(diff.groups.removed, [])
  assert.deepEqual(diff.groups.changed, [])
  assert.equal(diff.groups.reordered, true)
})

test('diffDocs does not guess duplicate paths', () => {
  const current = doc([group('c1', 'Dup'), group('c2', 'Dup')])
  const target = doc([group('t1', 'Dup')])
  const diff = diffDocs(current, target)
  assert.deepEqual(diff.groups.added, ['Dup'])
  assert.deepEqual(diff.groups.removed, ['Dup', 'Dup'])
  assert.equal(diff.summary.groups.added, 1)
  assert.equal(diff.summary.groups.removed, 2)

  const both = diffDocs(
    doc([group('c1', 'Dup'), group('c2', 'Dup')]),
    doc([group('t1', 'Dup'), group('t2', 'Dup')]),
  )
  assert.deepEqual(both.groups.added, ['Dup', 'Dup'])
  assert.deepEqual(both.groups.removed, ['Dup', 'Dup'])
  assert.deepEqual(both.groups.changed, [])
})

test('diffDocs reports moved sessions between groups', () => {
  const current = doc([group('a', 'A', null, ['s1', 's2']), group('b', 'B')])
  const target = doc([group('a', 'A', null, ['s1']), group('b', 'B', null, ['s2'])])
  const diff = diffDocs(current, target, ['s1', 's2'])
  assert.deepEqual(diff.sessions.moved, [{ sessionId: 's2', from: 'A', to: 'B' }])
  assert.equal(diff.summary.sessions.moved, 1)
  assert.deepEqual(diff.sessions.newlyGrouped, [])
  assert.deepEqual(diff.sessions.ungrouped, [])
  assert.deepEqual(diff.summary.grouped, { current: 2, target: 2 })
  assert.deepEqual(diff.summary.ungrouped, { current: 0, target: 0 })
  // Session membership is reported in `sessions`, not as a group change.
  assert.deepEqual(diff.groups.changed, [])
})

test('diffDocs reports newly grouped sessions and only live ungrouped sessions', () => {
  const current = doc([group('a', 'A')], ['s1', 's2'])
  const target = doc([group('a', 'A', null, ['s1'])], ['s2'])
  const grouped = diffDocs(current, target, ['s1', 's2'])
  assert.deepEqual(grouped.sessions.newlyGrouped, [{ sessionId: 's1', to: 'A' }])
  assert.deepEqual(grouped.sessions.ungrouped, [])
  assert.deepEqual(grouped.summary.grouped, { current: 0, target: 1 })
  assert.deepEqual(grouped.summary.ungrouped, { current: 2, target: 1 })

  const back = diffDocs(target, current, ['s1', 's2'])
  assert.deepEqual(back.sessions.ungrouped, [{ sessionId: 's1', from: 'A' }])
  assert.deepEqual(back.sessions.newlyGrouped, [])

  const withoutLive = diffDocs(target, current)
  assert.deepEqual(withoutLive.sessions.ungrouped, [])
})

test('diffDocs reports stale target references only when live ids are supplied', () => {
  const target = doc([group('a', 'A', null, ['s1', 's2'])])
  const live = diffDocs(doc(), target, ['s1'])
  assert.deepEqual(live.sessions.stale, ['s2'])
  // A dead reference still exists in the target document: it is both newly
  // grouped there and stale for the live session list.
  assert.deepEqual(live.sessions.newlyGrouped, [
    { sessionId: 's1', to: 'A' },
    { sessionId: 's2', to: 'A' },
  ])
  assert.deepEqual(live.summary.sessions.stale, 1)

  const withoutLive = diffDocs(doc(), target)
  assert.deepEqual(withoutLive.sessions.stale, [])
})

test('diffDocs counts grouped and ungrouped from liveSessionIds', () => {
  const current = doc([group('a', 'A', null, ['s1', 's2'])], ['s3'])
  const target = doc([group('a', 'A', null, ['s1']), group('b', 'B', null, ['s4'])], ['s3'])
  const diff = diffDocs(current, target, ['s1', 's2', 's3', 's5'])
  assert.deepEqual(diff.summary.grouped, { current: 2, target: 1 })
  assert.deepEqual(diff.summary.ungrouped, { current: 2, target: 3 })
  assert.deepEqual(diff.sessions.ungrouped, [{ sessionId: 's2', from: 'A' }])
  assert.deepEqual(diff.sessions.newlyGrouped, [{ sessionId: 's4', to: 'B' }])
  assert.deepEqual(diff.sessions.stale, ['s4'])
})

test('diffDocs falls back to document counts when liveSessionIds are empty', () => {
  const current = doc([group('a', 'A', null, ['s1', 's2'])], ['s3'])
  const target = doc([group('a', 'A', null, ['s1']), group('b', 'B', null, ['s4'])], ['s3'])
  const diff = diffDocs(current, target)
  assert.deepEqual(diff.summary.grouped, { current: 2, target: 2 })
  assert.deepEqual(diff.summary.ungrouped, { current: 1, target: 1 })
  assert.deepEqual(diff.sessions.stale, [])
  assert.deepEqual(diff.sessions.newlyGrouped, [{ sessionId: 's4', to: 'B' }])
  assert.deepEqual(diff.sessions.ungrouped, [])
})

test('diffDocs reports deep paths and empty documents', () => {
  const empty = diffDocs(doc(), doc(), [])
  assert.deepEqual(empty.groups.added, [])
  assert.deepEqual(empty.groups.removed, [])
  assert.deepEqual(empty.groups.changed, [])
  assert.deepEqual(empty.summary.groups, { current: 0, target: 0, added: 0, removed: 0, changed: 0, reordered: false })
  assert.deepEqual(empty.summary, emptySummary())
  assert.deepEqual(empty.truncated, { groups: false, sessions: false })

  const current = doc([group('a', 'A'), group('b', 'B', 'a'), group('c', 'C', 'b'), group('d', 'D', 'c')])
  const target = doc([group('a', 'A'), group('b', 'B', 'a'), group('c', 'C', 'b'), group('d', 'E', 'c')])
  const diff = diffDocs(current, target)
  assert.deepEqual(diff.groups.changed, [
    { id: 'd', from: 'A/B/C/D', to: 'A/B/C/E', renamed: true, moved: false, appearance: false },
  ])
  assert.equal(diff.groups.reordered, false)
})

test('diffDocs reports an ancestor rename once and keeps descendants unchanged', () => {
  const current = doc([group('a', 'Old'), group('b', 'Child', 'a')])
  const target = doc([group('a', 'New'), group('b', 'Child', 'a')])
  const diff = diffDocs(current, target)
  assert.deepEqual(diff.groups.changed, [
    { id: 'a', from: 'Old', to: 'New', renamed: true, moved: false, appearance: false },
  ])
  assert.equal(diff.groups.reordered, false)
})

test('diffDocs returns complete arrays with truncated always false', () => {
  const currentGroups = [group('bucket', 'Bucket')]
  const targetGroups = [group('bucket', 'Bucket')]
  const live = []
  for (let index = 0; index < 340; index += 1) {
    currentGroups.push(group(`slot${index}`, `Slot ${index}`, null, [`sess${index}`]))
    targetGroups.push(group(`slot${index}`, `Slot ${index}`))
    live.push(`sess${index}`)
  }
  for (let index = 0; index < 120; index += 1) {
    targetGroups.push(group(`extra${index}`, `Extra ${index}`))
  }
  targetGroups[0].sessionIds = live
  const diff = diffDocs(doc(currentGroups, []), doc(targetGroups, []), live)
  assert.equal(diff.groups.added.length, 120)
  assert.equal(diff.summary.groups.added, 120)
  assert.equal(diff.sessions.moved.length, 340)
  assert.equal(diff.summary.sessions.moved, 340)
  assert.deepEqual(diff.truncated, { groups: false, sessions: false })
})

test('diffDocs is pure and deterministic', () => {
  const current = doc([group('a', 'A', null, ['s1']), group('b', 'B')], ['s2'])
  const target = doc([group('a', 'A'), group('c', 'C', null, ['s1'])], ['s2', 's3'])
  const before = structuredClone([current, target])
  const first = diffDocs(current, target, ['s1', 's2'])
  const second = diffDocs(current, target, ['s1', 's2'])
  assert.deepEqual(first, second)
  assert.deepEqual([current, target], before)
})
