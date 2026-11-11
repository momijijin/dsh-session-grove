import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ARCHIVE_FROZEN,
  GROUP_ARCHIVED,
  GROUP_CONTAINS_ARCHIVED,
  GROUP_DESTINATION_ARCHIVED,
  GROUP_POSITION_LOCKED,
  archivedInfo,
  assertArchiveInvariant,
  effectiveArchived,
  findArchiveViolation,
  hasArchivedDescendant,
  isOwnArchived,
  normalizeGroupArchived,
} from '../../src/shared/archive.js'

const group = (id, parentId = null, extra = {}) => ({
  id,
  name: id.toUpperCase(),
  icon: 'folder',
  color: 'blue',
  parentId,
  sessionIds: [],
  ...extra,
})

const docOf = (groups, ungrouped = []) => ({ version: 1, revision: 0, groups, ungrouped })

const clone = (value) => JSON.parse(JSON.stringify(value))

const replaceGroup = (doc, groupId, patch) => {
  const next = clone(doc)
  Object.assign(next.groups.find((item) => item.id === groupId), patch)
  return next
}

const removeGroups = (doc, groupIds) => {
  const next = clone(doc)
  next.groups = next.groups.filter((item) => !groupIds.includes(item.id))
  return next
}

/** Root siblings [a (archived), b, e]; a owns children [c, d] and sessions [s1, s2]. */
const rootTree = () =>
  docOf([
    group('a', null, { archived: true, sessionIds: ['s1', 's2'] }),
    group('c', 'a'),
    group('d', 'a'),
    group('b', null, { sessionIds: ['s3'] }),
    group('e'),
  ])

/** Root siblings [a (archived), b]; a's direct children follow `childIds` in doc order. */
const childOrderDoc = (childIds) =>
  docOf([group('a', null, { archived: true }), ...childIds.map((id) => group(id, 'a')), group('b')])

/** p is unarchived and owns x + q; q is archived, so p is an ancestor of a frozen subtree. */
const nestedArchivedDoc = () =>
  docOf([group('p', null, { sessionIds: ['s1'] }), group('x'), group('q', 'p', { archived: true })])

test('isOwnArchived only honours the literal true', () => {
  assert.equal(isOwnArchived({ archived: true }), true)
  for (const value of [false, undefined, null, 1, 0, 'true', {}, []]) {
    assert.equal(isOwnArchived({ archived: value }), false, `archived=${String(value)} must read as not archived`)
  }
  assert.equal(isOwnArchived({}), false)
  assert.equal(isOwnArchived(null), false)
})

test('normalizeGroupArchived maps missing and non-boolean values to false', () => {
  assert.equal(normalizeGroupArchived(undefined), false)
  assert.equal(normalizeGroupArchived(null), false)
  assert.equal(normalizeGroupArchived(false), false)
  assert.equal(normalizeGroupArchived(true), true)
  assert.equal(normalizeGroupArchived('true'), false, 'invalid types are rejected later by validateDoc')
  assert.equal(normalizeGroupArchived(1), false)
})

test('effectiveArchived/archivedInfo inherit the nearest archived ancestor', () => {
  const doc = docOf([
    group('root', null, { archived: true }),
    group('mid', 'root'),
    group('leaf', 'mid'),
    group('other'),
  ])
  assert.deepEqual(archivedInfo(doc, 'leaf'), { own: false, effective: true, archivedBy: 'root' })
  assert.deepEqual(archivedInfo(doc, 'root'), { own: true, effective: true, archivedBy: 'root' })
  assert.deepEqual(archivedInfo(doc, 'other'), { own: false, effective: false, archivedBy: null })
  assert.deepEqual(archivedInfo(doc, 'missing'), { own: false, effective: false, archivedBy: null })
  assert.equal(effectiveArchived(doc, 'leaf'), true)
  assert.equal(effectiveArchived(doc, 'other'), false)
  assert.equal(effectiveArchived(doc, 'missing'), false)

  const nested = docOf([
    group('a', null, { archived: true }),
    group('b', 'a', { archived: true }),
    group('c', 'b'),
  ])
  assert.deepEqual(
    archivedInfo(nested, 'c'),
    { own: false, effective: true, archivedBy: 'b' },
    'the nearest archived ancestor wins',
  )
})

test('cycle defence: inherited lookups terminate and never throw', () => {
  const doc = docOf([group('a', 'b'), group('b', 'a', { archived: true })])
  assert.deepEqual(archivedInfo(doc, 'a'), { own: false, effective: true, archivedBy: 'b' })
  assert.equal(effectiveArchived(doc, 'a'), true)
  assert.equal(hasArchivedDescendant(doc, 'a'), true)

  const selfCycle = docOf([group('self', 'self')])
  assert.doesNotThrow(() => archivedInfo(selfCycle, 'self'))
  assert.equal(archivedInfo(selfCycle, 'self').effective, false)
  assert.equal(hasArchivedDescendant(selfCycle, 'self'), false)
})

test('hasArchivedDescendant sees archived groups anywhere below', () => {
  const doc = docOf([
    group('p', null, { sessionIds: ['s1'] }),
    group('x', 'p'),
    group('q', 'x', { archived: true }),
    group('leaf'),
  ])
  assert.equal(hasArchivedDescendant(doc, 'p'), true)
  assert.equal(hasArchivedDescendant(doc, 'x'), true)
  assert.equal(hasArchivedDescendant(doc, 'leaf'), false)
  assert.equal(hasArchivedDescendant(doc, 'missing'), false)

  const archivedWithChild = docOf([group('a', null, { archived: true }), group('c', 'a')])
  assert.equal(hasArchivedDescendant(archivedWithChild, 'a'), true, 'children of an archived group are effective')
})

test('findArchiveViolation ignores documents without archived groups', () => {
  const before = docOf([group('a'), group('b', 'a')])
  const after = docOf([group('a', null, { name: 'Renamed' }), group('b', 'a', { sessionIds: ['s9'] }), group('z')])
  assert.equal(findArchiveViolation(before, after), null)
  assert.equal(findArchiveViolation(null, null), null)
  assert.equal(findArchiveViolation(docOf([]), docOf([])), null)
  assert.equal(findArchiveViolation(docOf([group('a')]), null), null, 'dropping an unfrozen document is not a violation')
})

test('frozen metadata is compared after normalization', () => {
  const before = rootTree()
  const cases = [
    [{ name: 'Renamed' }, { code: GROUP_ARCHIVED, groupId: 'a', field: 'name' }],
    [{ icon: 'star' }, { code: GROUP_ARCHIVED, groupId: 'a', field: 'icon' }],
    [{ color: 'red' }, { code: GROUP_ARCHIVED, groupId: 'a', field: 'color' }],
    [{ colorHex: '#123456' }, { code: GROUP_ARCHIVED, groupId: 'a', field: 'colorHex' }],
  ]
  for (const [patch, expected] of cases) {
    assert.deepEqual(findArchiveViolation(before, replaceGroup(before, 'a', patch)), expected)
  }
  assert.deepEqual(
    findArchiveViolation(before, replaceGroup(before, 'c', { name: 'Renamed' })),
    { code: GROUP_ARCHIVED, groupId: 'c', field: 'name' },
    'inherited archive state freezes descendants too',
  )
})

test('normalization does not fabricate violations, but real edits still report', () => {
  const legacy = docOf([
    { id: 'a', name: 'A', icon: 'folder', parentId: null, sessionIds: ['s1'], archived: true },
    { id: 'c', name: 'C', icon: 'folder', parentId: 'a', sessionIds: [] },
  ])
  const normalized = docOf([
    { id: 'a', name: 'A', icon: 'folder', color: 'blue', parentId: null, sessionIds: ['s1'], archived: true },
    { id: 'c', name: 'C', icon: 'folder', color: 'blue', parentId: 'a', sessionIds: [], archived: false },
  ])
  assert.equal(findArchiveViolation(legacy, normalized), null, 'default color/icon/archived backfill is not an edit')
  assert.deepEqual(
    findArchiveViolation(legacy, replaceGroup(normalized, 'c', { name: 'Renamed' })),
    { code: GROUP_ARCHIVED, groupId: 'c', field: 'name' },
    'a real rename is still reported',
  )
  assert.deepEqual(
    findArchiveViolation(legacy, replaceGroup(normalized, 'c', { color: 'red' })),
    { code: GROUP_ARCHIVED, groupId: 'c', field: 'color' },
    'a real recolor is still reported',
  )

  const upperHex = docOf([group('a', null, { archived: true, colorHex: '#4D6BFE' })])
  const lowerHex = docOf([group('a', null, { archived: true, colorHex: '#4d6bfe' })])
  assert.equal(findArchiveViolation(upperHex, lowerHex), null)
  const shortHex = docOf([group('a', null, { archived: true, colorHex: '#abc' })])
  const longHex = docOf([group('a', null, { archived: true, colorHex: '#aabbcc' })])
  assert.equal(findArchiveViolation(shortHex, longHex), null)
  const unknownColor = docOf([group('a', null, { archived: true, color: 'chartreuse' })])
  const blueColor = docOf([group('a', null, { archived: true, color: 'blue' })])
  assert.equal(findArchiveViolation(unknownColor, blueColor), null)
})

test('frozen session content is immutable', () => {
  const before = rootTree()
  assert.deepEqual(findArchiveViolation(before, replaceGroup(before, 'a', { sessionIds: ['s2', 's1'] })), {
    code: GROUP_ARCHIVED,
    groupId: 'a',
    field: 'sessionIds',
  })
  assert.deepEqual(findArchiveViolation(before, replaceGroup(before, 'a', { sessionIds: ['s1'] })), {
    code: GROUP_ARCHIVED,
    groupId: 'a',
    field: 'sessionIds',
  })
  assert.deepEqual(findArchiveViolation(before, replaceGroup(before, 'a', { sessionIds: ['s0', 's1', 's2'] })), {
    code: GROUP_DESTINATION_ARCHIVED,
    groupId: 'a',
    field: 'sessionIds',
  })
})

test('frozen child-group order and membership are immutable', () => {
  const before = childOrderDoc(['c', 'd'])
  assert.deepEqual(findArchiveViolation(before, childOrderDoc(['d', 'c'])), {
    code: GROUP_ARCHIVED,
    groupId: 'a',
    field: 'children',
  })
  assert.deepEqual(findArchiveViolation(before, childOrderDoc(['c'])), {
    code: GROUP_ARCHIVED,
    groupId: 'a',
    field: 'children',
  })
  assert.deepEqual(findArchiveViolation(before, childOrderDoc(['c', 'd', 'n'])), {
    code: GROUP_DESTINATION_ARCHIVED,
    groupId: 'a',
    field: 'children',
  })
  assert.deepEqual(findArchiveViolation(childOrderDoc(['c']), childOrderDoc(['n', 'c'])), {
    code: GROUP_DESTINATION_ARCHIVED,
    groupId: 'a',
    field: 'children',
  })
})

test('frozen groups cannot be deleted or moved', () => {
  const before = rootTree()
  assert.deepEqual(findArchiveViolation(before, removeGroups(before, ['a'])), {
    code: GROUP_ARCHIVED,
    groupId: 'a',
    field: 'deleted',
  })
  assert.deepEqual(findArchiveViolation(before, replaceGroup(before, 'a', { parentId: 'b' })), {
    code: GROUP_ARCHIVED,
    groupId: 'a',
    field: 'parentId',
  })
  const reordered = docOf([
    group('b', null, { sessionIds: ['s3'] }),
    group('a', null, { archived: true, sessionIds: ['s1', 's2'] }),
    group('c', 'a'),
    group('d', 'a'),
    group('e'),
  ])
  assert.deepEqual(findArchiveViolation(before, reordered), {
    code: GROUP_ARCHIVED,
    groupId: 'a',
    field: 'index',
  }, 'a direct sibling reorder moves the frozen group itself')
})

test('sibling insertion or deletion before a frozen group shifts its anchor', () => {
  const before = rootTree()
  const inserted = clone(before)
  inserted.groups.unshift(group('z'))
  assert.deepEqual(findArchiveViolation(before, inserted), {
    code: GROUP_POSITION_LOCKED,
    groupId: 'a',
    field: 'index',
  })
  const deleted = removeGroups(before, ['b'])
  assert.deepEqual(findArchiveViolation(before, deleted), null, 'removing a sibling after the anchor is legal')
  const appended = clone(before)
  appended.groups.push(group('z'))
  assert.equal(findArchiveViolation(before, appended), null, 'appending a sibling after the anchor is legal')
})

test('ancestors of a frozen group may not move or disappear, but may be renamed', () => {
  const before = nestedArchivedDoc()
  assert.deepEqual(findArchiveViolation(before, removeGroups(before, ['p', 'q'])), {
    code: GROUP_CONTAINS_ARCHIVED,
    groupId: 'p',
    field: 'deleted',
  })
  assert.deepEqual(
    findArchiveViolation(
      before,
      docOf([group('x'), group('p', null, { sessionIds: ['s1'] }), group('q', 'p', { archived: true })]),
    ),
    { code: GROUP_CONTAINS_ARCHIVED, groupId: 'p', field: 'index' },
  )
  assert.deepEqual(
    findArchiveViolation(
      before,
      docOf([group('x'), group('p', 'x', { sessionIds: ['s1'] }), group('q', 'p', { archived: true })]),
    ),
    { code: GROUP_CONTAINS_ARCHIVED, groupId: 'p', field: 'parentId' },
  )
  const inserted = clone(before)
  inserted.groups.unshift(group('z'))
  assert.deepEqual(findArchiveViolation(before, inserted), {
    code: GROUP_POSITION_LOCKED,
    groupId: 'p',
    field: 'index',
  })
  assert.equal(findArchiveViolation(before, removeGroups(before, ['x'])), null, 'removing a later sibling is legal')
  assert.equal(findArchiveViolation(before, replaceGroup(before, 'p', { name: 'Renamed' })), null)
})

test('the archived flag itself may change without violating the fingerprint', () => {
  const before = rootTree()
  assert.equal(findArchiveViolation(before, replaceGroup(before, 'a', { archived: false })), null)
  assert.equal(findArchiveViolation(before, replaceGroup(before, 'c', { archived: true })), null)

  const beforePlain = docOf([group('p')])
  const archiveAndEdit = docOf([group('p', null, { archived: true, name: 'Renamed' })])
  assert.equal(findArchiveViolation(beforePlain, archiveAndEdit), null, 'archive + edit is legal in one commit')

  const unarchiveAndEdit = replaceGroup(before, 'a', { archived: false, name: 'Renamed' })
  assert.deepEqual(
    findArchiveViolation(before, unarchiveAndEdit),
    { code: GROUP_ARCHIVED, groupId: 'a', field: 'name' },
    'unarchive + edit must be split into two commits (strict before-state)',
  )
})

test('findArchiveViolation reports the first violation deterministically', () => {
  const before = rootTree()
  const after = clone(before)
  after.groups.find((item) => item.id === 'b').sessionIds = []
  after.groups.find((item) => item.id === 'c').icon = 'star'
  after.groups.find((item) => item.id === 'a').name = 'Renamed'
  assert.deepEqual(findArchiveViolation(before, after), {
    code: GROUP_ARCHIVED,
    groupId: 'a',
    field: 'name',
  })
})

test('assertArchiveInvariant throws a structured archive-frozen error', () => {
  const before = rootTree()
  const after = replaceGroup(before, 'a', { name: 'Renamed' })
  let caught = null
  try {
    assertArchiveInvariant(before, after)
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof Error)
  assert.equal(caught.message, GROUP_ARCHIVED)
  assert.equal(caught.code, GROUP_ARCHIVED)
  assert.equal(caught.kind, ARCHIVE_FROZEN)
  assert.equal(caught.groupId, 'a')
  assert.equal(caught.field, 'name')

  assert.doesNotThrow(() => assertArchiveInvariant(before, replaceGroup(before, 'a', { archived: false })))
  assert.doesNotThrow(() => assertArchiveInvariant(null, null))
})
