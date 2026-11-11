import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_GROUP_COLOR, DEFAULT_NEW_GROUP_ICON, GROUP_COLORS, GROUP_ICONS } from '../../src/shared/constants.js'
import {
  GROUP_ARCHIVED,
  GROUP_CONTAINS_ARCHIVED,
  GROUP_DESTINATION_ARCHIVED,
  GROUP_POSITION_LOCKED,
  computeGroupVisibility,
} from '../../src/shared/archive.js'
import {
  assignSession,
  buildRenderTree,
  childrenOf,
  createGroup,
  deleteGroup,
  deleteGroupTo,
  detachSession,
  emptyDoc,
  findGroup,
  groupColor,
  groupColorHex,
  groupSubtreeHeight,
  inferWorkspaceId,
  isColorHex,
  isDescendant,
  isKnownColor,
  moveGroup,
  normalizeColor,
  normalizeColorHex,
  renameGroup,
  reorderUngrouped,
  setGroupArchived,
  setGroupColor,
  setGroupColorHex,
  setGroupIcon,
  validateDoc,
  workspaceLabel,
  workspaceOfSession,
} from '../../src/shared/model.js'

const ws = (workspaceId, title, path, sessionIds = []) => ({ workspaceId, title, path, sessionIds })

const groupDef = (id, parentId = null, extra = {}) => ({
  id,
  name: id.toUpperCase(),
  icon: 'folder',
  color: 'blue',
  parentId,
  sessionIds: [],
  ...extra,
})
const docDef = (groups, ungrouped = []) => ({ version: 1, revision: 0, groups, ungrouped })
/** Root siblings [a (archived), b, e]; a owns sessions [s1, s4] and child c [s2]; b owns d and [s3]. */
const archivedDoc = () =>
  docDef([
    groupDef('a', null, { archived: true, sessionIds: ['s1', 's4'] }),
    groupDef('b', null, { sessionIds: ['s3'] }),
    groupDef('d', 'b'),
    groupDef('e'),
    groupDef('c', 'a', { sessionIds: ['s2'] }),
  ])
const archiveError = (fn) => {
  try {
    fn()
    return null
  } catch (error) {
    return error
  }
}
const assertArchiveError = (fn, expected) => {
  const error = archiveError(fn)
  assert.ok(error, `expected the archive invariant to reject the mutation (${expected.code}/${expected.field})`)
  assert.equal(error.code, expected.code)
  assert.equal(error.groupId, expected.groupId)
  assert.equal(error.field, expected.field)
}

test('emptyDoc is valid and versioned', () => {
  const doc = emptyDoc()
  assert.equal(doc.version, 1)
  assert.equal(doc.revision, 0)
  assert.deepEqual(doc.groups, [])
  assert.deepEqual(doc.ungrouped, [])
  assert.equal(validateDoc(doc).ok, true)
})

test('createGroup trims names, normalizes icons and nests', () => {
  let doc = createGroup(emptyDoc(), { name: '  施工中  ', icon: 'rocket' })
  assert.equal(doc.groups[0].name, '施工中')
  assert.equal(doc.groups[0].icon, 'rocket')
  doc = createGroup(doc, { name: '默认图标' })
  assert.equal(doc.groups[1].icon, DEFAULT_NEW_GROUP_ICON, 'new groups default to hash')
  assert.equal(doc.groups[1].icon, 'hash')
  doc = createGroup(doc, { name: '子组', icon: 'not-an-icon', parentId: doc.groups[0].id })
  assert.equal(doc.groups[2].icon, 'folder', 'invalid explicit icons still normalize to the legacy fallback')
  assert.equal(doc.groups[2].parentId, doc.groups[0].id)
  assert.deepEqual(childrenOf(doc, doc.groups[0].id).map((g) => g.name), ['子组'])
})

test('createGroup rejects empty and too-long names', () => {
  assert.throws(() => createGroup(emptyDoc(), { name: '   ' }), /name-required/)
  assert.throws(() => createGroup(emptyDoc(), { name: 'x'.repeat(81) }), /name-too-long/)
})

test('renameGroup and setGroupIcon update only the target', () => {
  let doc = createGroup(emptyDoc(), { name: 'A' })
  const id = doc.groups[0].id
  doc = renameGroup(doc, id, ' B ')
  doc = setGroupIcon(doc, id, 'star')
  assert.equal(doc.groups[0].name, 'B')
  assert.equal(doc.groups[0].icon, 'star')
})

test('group palette: default blue, known colors, setGroupColor, unknown -> blue', () => {
  assert.deepEqual([...GROUP_COLORS], ['blue', 'green', 'orange', 'red', 'purple', 'gray', 'teal', 'pink', 'brown', 'cyan', 'navy', 'magenta'])
  assert.equal(DEFAULT_GROUP_COLOR, 'blue')
  assert.equal(isKnownColor('purple'), true)
  assert.equal(isKnownColor('pink'), true)
  assert.equal(isKnownColor('chartreuse'), false)
  assert.equal(normalizeColor(undefined), 'blue')
  assert.equal(normalizeColor('chartreuse'), 'blue')
  assert.equal(normalizeColor('pink'), 'pink')
  assert.equal(normalizeColor('gray'), 'gray')

  let doc = createGroup(emptyDoc(), { name: 'A' })
  assert.equal(doc.groups[0].color, 'blue', 'new groups default to blue')
  doc = createGroup(doc, { name: 'B', color: 'purple' })
  assert.equal(doc.groups[1].color, 'purple')
  doc = createGroup(doc, { name: 'C', color: 'not-a-color' })
  assert.equal(doc.groups[2].color, 'blue', 'unknown input normalizes to blue')

  const a = doc.groups[0].id
  doc = setGroupColor(doc, a, 'orange')
  assert.equal(groupColor(doc.groups[0]), 'orange')
  assert.equal(groupColor({ name: 'legacy' }), 'blue', 'docs without color display blue')
  assert.equal(groupColor(null), 'blue')
  assert.throws(() => setGroupColor(doc, 'missing', 'red'), /group-not-found/)
  assert.equal(doc.groups[0].color, 'orange', 'setGroupColor is pure')
})

test('custom colorHex: normalization, precedence, validation and quarantine shape', () => {
  assert.equal(normalizeColorHex('#A1B2C3'), '#a1b2c3')
  assert.equal(normalizeColorHex('a1b2c3'), '#a1b2c3')
  assert.equal(normalizeColorHex('#abc'), '#aabbcc')
  assert.equal(normalizeColorHex('ABC'), '#aabbcc')
  assert.equal(normalizeColorHex('#abcd'), null, 'alpha short form is rejected')
  assert.equal(normalizeColorHex('#11223344'), null, 'alpha long form is rejected')
  assert.equal(normalizeColorHex('red'), null)
  assert.equal(normalizeColorHex(''), null)
  assert.equal(isColorHex('#a1b2c3'), true)
  assert.equal(isColorHex('#A1B2C3'), false, 'persisted shape is canonical lowercase')
  assert.equal(isColorHex('#abc'), false)

  let doc = createGroup(emptyDoc(), { name: 'A', color: 'purple', colorHex: '#A1B2C3' })
  assert.equal(doc.groups[0].colorHex, '#a1b2c3')
  assert.equal(groupColorHex(doc.groups[0]), '#a1b2c3')
  assert.equal(groupColor(doc.groups[0]), 'purple', 'palette identity stays available')
  assert.equal(validateDoc(doc).ok, true)

  const id = doc.groups[0].id
  doc = setGroupColorHex(doc, id, '#0F0')
  assert.equal(doc.groups[0].colorHex, '#00ff00')
  doc = setGroupColor(doc, id, 'orange')
  assert.equal(doc.groups[0].colorHex, undefined, 'picking a preset clears the custom color')
  assert.equal(groupColor(doc.groups[0]), 'orange')

  const invalidHex = { ...doc, groups: [{ ...doc.groups[0], colorHex: '#A1B2C3' }] }
  const verdict = validateDoc(invalidHex)
  assert.equal(verdict.ok, false)
  assert.match(verdict.errors.join(';'), /group-color-hex/)
  for (const bad of ['#abcd', '#11223344', 'red', '', 7]) {
    const invalid = { ...doc, groups: [{ ...doc.groups[0], colorHex: bad }] }
    assert.equal(validateDoc(invalid).ok, false, `colorHex ${JSON.stringify(bad)} must be rejected`)
  }
})

test('validateDoc: color is optional but must be a known palette id when present', () => {
  const doc = createGroup(emptyDoc(), { name: 'A' })
  const group = doc.groups[0]
  assert.equal(validateDoc(doc).ok, true)
  for (const color of GROUP_COLORS) {
    const valid = { ...doc, groups: [{ ...group, color }] }
    assert.equal(validateDoc(valid).ok, true, color)
  }
  const legacyGroup = { ...group }
  delete legacyGroup.color
  assert.equal(validateDoc({ ...doc, groups: [legacyGroup] }).ok, true, 'legacy groups without color stay valid')
  for (const color of ['chartreuse', '', 7, null, true]) {
    const verdict = validateDoc({ ...doc, groups: [{ ...group, color }] })
    assert.equal(verdict.ok, false, `color ${JSON.stringify(color)} must be rejected`)
    assert.match(verdict.errors.join(';'), /group-color/)
  }
})

test('moveGroup reorders siblings and keeps the subtree', () => {
  let doc = createGroup(emptyDoc(), { name: 'A' })
  doc = createGroup(doc, { name: 'B' })
  doc = createGroup(doc, { name: 'C', parentId: doc.groups[0].id })
  const a = doc.groups.find((g) => g.name === 'A')
  doc = moveGroup(doc, a.id, null, 1)
  assert.deepEqual(childrenOf(doc, null).map((g) => g.name), ['B', 'A'])
  assert.equal(childrenOf(doc, doc.groups.find((g) => g.name === 'A').id).length, 1)
})

test('dialog move semantics insert a session and group at the target head', () => {
  let doc = createGroup(emptyDoc(), { name: 'Target' })
  const target = doc.groups[0].id
  doc = createGroup(doc, { name: 'Source' })
  const source = doc.groups[1].id
  doc = createGroup(doc, { name: 'TargetChildA', parentId: target })
  doc = createGroup(doc, { name: 'TargetChildB', parentId: target })
  doc = assignSession(doc, 'old', target)
  doc = assignSession(doc, 'moved', null)
  doc = assignSession(doc, 'moved', target, 0)
  assert.deepEqual(findGroup(doc, target).sessionIds, ['moved', 'old'])
  doc = moveGroup(doc, source, target, 0)
  assert.deepEqual(childrenOf(doc, target).map((g) => g.name), ['Source', 'TargetChildA', 'TargetChildB'])
})

test('moveGroup rejects cycles and depth overflow', () => {
  let doc = createGroup(emptyDoc(), { name: 'A' })
  const a = doc.groups[0].id
  doc = createGroup(doc, { name: 'B', parentId: a })
  const b = doc.groups[1].id
  assert.throws(() => moveGroup(doc, a, b, 0), /cycle/)
  assert.throws(() => moveGroup(doc, a, a, 0), /cycle/)
  assert.equal(isDescendant(doc, b, a), true)

  let deep = emptyDoc()
  let parentId = null
  for (let i = 0; i < 8; i += 1) {
    deep = createGroup(deep, { name: `L${i}`, parentId })
    parentId = deep.groups[deep.groups.length - 1].id
  }
  assert.throws(() => createGroup(deep, { name: 'L9', parentId }), /depth-exceeded/)
})

test('deleteGroup promotes children and moves sessions to parent head', () => {
  let doc = createGroup(emptyDoc(), { name: 'A' })
  const a = doc.groups[0].id
  doc = createGroup(doc, { name: 'B', parentId: a })
  const b = doc.groups.find((g) => g.name === 'B').id
  doc = createGroup(doc, { name: 'C' })
  const c = doc.groups.find((g) => g.name === 'C').id
  doc = assignSession(doc, 's1', a, 0)
  doc = assignSession(doc, 's2', b, 0)
  doc = assignSession(doc, 's3', c, 0)
  doc = deleteGroup(doc, a)
  assert.equal(doc.groups.some((g) => g.id === a), false)
  assert.equal(doc.groups.find((g) => g.id === b).parentId, null)
  assert.deepEqual(doc.ungrouped.slice(0, 1), ['s1'])
  assert.deepEqual(doc.groups.find((g) => g.id === b).sessionIds, ['s2'])
})

test('deleteGroupTo moves direct sessions and child groups to an explicit destination', () => {
  let doc = createGroup(emptyDoc(), { name: 'A' })
  const a = doc.groups[0].id
  doc = createGroup(doc, { name: 'B', parentId: a })
  const b = doc.groups.find((group) => group.name === 'B').id
  doc = createGroup(doc, { name: 'B-child', parentId: b })
  const bChild = doc.groups.find((group) => group.name === 'B-child').id
  doc = createGroup(doc, { name: 'Dest' })
  const dest = doc.groups.find((group) => group.name === 'Dest').id
  doc = createGroup(doc, { name: 'Dest-child', parentId: dest })
  const destChild = doc.groups.find((group) => group.name === 'Dest-child').id
  doc = assignSession(doc, 's1', a, 0)
  doc = assignSession(doc, 's2', a, 0)
  doc = assignSession(doc, 's3', b, 0)
  doc = assignSession(doc, 'existing', destChild, 0)

  const next = deleteGroupTo(doc, a, destChild)
  assert.equal(next.groups.some((group) => group.id === a), false)
  assert.deepEqual(
    next.groups.find((group) => group.id === destChild).sessionIds,
    ['s2', 's1', 'existing'],
    'direct sessions are prepended to the chosen destination'
  )
  assert.equal(next.groups.find((group) => group.id === b).parentId, destChild)
  assert.equal(next.groups.find((group) => group.id === bChild).parentId, b, 'the child subtree is preserved')
  assert.deepEqual(next.groups.find((group) => group.id === b).sessionIds, ['s3'])
  assert.equal(next.ungrouped.includes('s1'), false)
  assert.equal(next.ungrouped.includes('s2'), false)
  assert.equal(doc.groups.some((group) => group.id === a), true, 'deleteGroupTo is pure')
})

test('deleteGroupTo supports the ungrouped/root destination and deleteGroup stays a parent wrapper', () => {
  let doc = createGroup(emptyDoc(), { name: 'A' })
  const a = doc.groups[0].id
  doc = createGroup(doc, { name: 'B', parentId: a })
  const b = doc.groups.find((group) => group.name === 'B').id
  doc = createGroup(doc, { name: 'B-child', parentId: b })
  const bChild = doc.groups.find((group) => group.name === 'B-child').id
  doc = assignSession(doc, 's1', a, 0)
  doc = assignSession(doc, 's2', a, 0)
  doc = assignSession(doc, 'old', null, 0)

  const rooted = deleteGroupTo(doc, a, null)
  assert.equal(rooted.groups.some((group) => group.id === a), false)
  assert.deepEqual(rooted.ungrouped, ['s2', 's1', 'old'], 'sessions are prepended to Ungrouped')
  assert.equal(rooted.groups.find((group) => group.id === b).parentId, null)
  assert.equal(rooted.groups.find((group) => group.id === bChild).parentId, b)

  const wrapped = deleteGroup(doc, a)
  assert.deepEqual(
    wrapped.groups.find((group) => group.id === b).parentId,
    null,
    'deleteGroup defaults to the deleted group parent (root here)'
  )
  assert.deepEqual(wrapped.ungrouped, ['s2', 's1', 'old'])
})

test('deleteGroupTo validates group/destination/cycle/depth', () => {
  let doc = createGroup(emptyDoc(), { name: 'A' })
  const a = doc.groups[0].id
  doc = createGroup(doc, { name: 'B', parentId: a })
  const b = doc.groups.find((group) => group.name === 'B').id
  doc = createGroup(doc, { name: 'C', parentId: b })
  const c = doc.groups.find((group) => group.name === 'C').id
  assert.throws(() => deleteGroupTo(doc, 'missing', null), /group-not-found/)
  assert.throws(() => deleteGroupTo(doc, a, 'missing'), /parent-not-found/)
  assert.throws(() => deleteGroupTo(doc, a, a), /cycle/)
  assert.throws(() => deleteGroupTo(doc, a, b), /cycle/)
  assert.throws(() => deleteGroupTo(doc, a, c), /cycle/)

  let deep = createGroup(emptyDoc(), { name: 'T' })
  const t = deep.groups[0].id
  let parentId = t
  for (let i = 1; i <= 7; i += 1) {
    deep = createGroup(deep, { name: `C${i}`, parentId })
    parentId = deep.groups.find((group) => group.name === `C${i}`).id
  }
  deep = createGroup(deep, { name: 'D1' })
  const d1 = deep.groups.find((group) => group.name === 'D1').id
  deep = createGroup(deep, { name: 'D2', parentId: d1 })
  const d2 = deep.groups.find((group) => group.name === 'D2').id
  assert.equal(groupSubtreeHeight(deep, t), 7)
  assert.throws(() => deleteGroupTo(deep, t, d2), /depth-exceeded/)
  assert.doesNotThrow(() => deleteGroupTo(deep, t, d1), 'depth 1 destination fits the 8-level cap')
  assert.doesNotThrow(() => deleteGroupTo(deep, t, null), 'root destination is always allowed')
})

test('assignSession moves across groups without duplication', () => {
  let doc = createGroup(emptyDoc(), { name: 'A' })
  const a = doc.groups[0].id
  doc = createGroup(doc, { name: 'B' })
  const b = doc.groups[1].id
  doc = assignSession(doc, 's1', a)
  doc = assignSession(doc, 's2', a)
  doc = assignSession(doc, 's1', b, 0)
  assert.deepEqual(doc.groups.find((g) => g.id === a).sessionIds, ['s2'])
  assert.deepEqual(doc.groups.find((g) => g.id === b).sessionIds, ['s1'])
  doc = assignSession(doc, 's2', null, 0)
  assert.deepEqual(doc.ungrouped, ['s2'])
  doc = assignSession(doc, 's2', a)
  assert.deepEqual(doc.ungrouped, [], 'assigning a session back into a group removes it from Ungrouped')
  assert.deepEqual(doc.groups.find((g) => g.id === a).sessionIds, ['s2'])
})

test('reorderUngrouped dedupes and keeps order', () => {
  let doc = assignSession(emptyDoc(), 's1', null)
  doc = assignSession(doc, 's2', null)
  doc = reorderUngrouped(doc, ['s2', 's1', 's2', ''])
  assert.deepEqual(doc.ungrouped, ['s2', 's1'])
})

test('validateDoc catches duplicate sessions, missing parents and cycles', () => {
  const doc = {
    version: 1,
    revision: 1,
    groups: [
      { id: 'g1', name: 'A', icon: 'folder', parentId: 'g2', sessionIds: ['s1'] },
      { id: 'g2', name: 'B', icon: 'folder', parentId: 'g1', sessionIds: ['s1'] },
    ],
    ungrouped: [],
  }
  const result = validateDoc(doc)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('duplicate-session')))
  assert.ok(result.errors.some((e) => e.includes('cycle')))
})

test('buildRenderTree applies archive tri-state, hides subagent/blank, keeps empty groups', () => {
  let doc = createGroup(emptyDoc(), { name: 'A' })
  const a = doc.groups[0].id
  doc = createGroup(doc, { name: 'Empty' })
  doc = assignSession(doc, 's1', a)
  const sessions = {
    s1: { id: 's1', updatedAt: 10 },
    s2: { id: 's2', updatedAt: 20 },
    s3: { id: 's3', updatedAt: 30, origin: 'subagent', parentId: 's1' },
    s4: { id: 's4', updatedAt: 40, blank: true },
    s5: { id: 's5', updatedAt: 50 },
  }
  const workspaces = [ws('w1', 'W1', 'C:/p/w1', ['s1', 's2', 's3', 's4', 's5'])]
  const statuses = new Map([['s1', { running: true }]])

  const hidden = buildRenderTree(doc, sessions, workspaces, {
    archivedSessionIds: ['s2'],
    filter: 'hidden',
    currentSessionId: null,
    statuses,
  })
  assert.deepEqual(hidden.ungrouped.map((n) => n.session.id), ['s5'])
  const aNode = hidden.groups.find((n) => n.group.id === a)
  assert.equal(aNode.visibleCount, 1)
  assert.equal(aNode.children[0].status.running, true)
  assert.equal(hidden.groups.find((n) => n.group.name === 'Empty').emptyVisible, true)

  const all = buildRenderTree(doc, sessions, workspaces, { archivedSessionIds: ['s2'], filter: 'all' })
  assert.ok(all.ungrouped.some((n) => n.session.id === 's2' && n.archived === true))
  assert.equal(all.ungrouped.some((n) => n.session.id === 's3'), false)
  assert.equal(all.ungrouped.some((n) => n.session.id === 's4'), false)

  const only = buildRenderTree(doc, sessions, workspaces, {
    archivedSessionIds: ['s2'],
    filter: 'only',
    currentSessionId: null,
  })
  assert.deepEqual(only.ungrouped.map((n) => n.session.id), ['s2'])

  const blankCurrent = buildRenderTree(doc, sessions, workspaces, {
    archivedSessionIds: [],
    filter: 'all',
    currentSessionId: 's4',
  })
  assert.equal(blankCurrent.ungrouped.some((n) => n.session.id === 's4'), true)

  const counted = buildRenderTree(doc, sessions, workspaces, {
    archivedSessionIds: [],
    filter: 'hidden',
    currentSessionId: null,
    statuses,
    subagentCounts: new Map([['s1', 2]]),
  })
  const countedNode = counted.groups.find((n) => n.group.id === a).children.find((n) => n.session.id === 's1')
  assert.equal(countedNode.runningSubagentCount, 2)
  const plainNode = counted.ungrouped.find((n) => n.session.id === 's5')
  assert.equal(plainNode.runningSubagentCount, 0)
})

test('ungrouped derives unseen sessions newest-first before stored order', () => {
  let doc = assignSession(emptyDoc(), 'old', null, 0)
  const sessions = {
    old: { id: 'old', updatedAt: 1 },
    new1: { id: 'new1', updatedAt: 10 },
    new2: { id: 'new2', updatedAt: 20 },
  }
  const tree = buildRenderTree(doc, sessions, [], { filter: 'all', archivedSessionIds: [] })
  assert.deepEqual(tree.ungrouped.map((n) => n.session.id), ['new2', 'new1', 'old'])
})

test('workspace mapping and inference follow D6', () => {
  let doc = createGroup(emptyDoc(), { name: 'A' })
  const a = doc.groups[0].id
  doc = assignSession(doc, 's1', a, 0)
  doc = assignSession(doc, 's2', a, 1)
  const w1 = ws('w1', 'W1', 'C:/p/w1', ['s1', 's3'])
  const w2 = ws('w2', 'W2', 'C:/p/w2', ['s2', 's4'])
  const sessions = { s1: {}, s2: {}, s3: {}, s4: {} }
  assert.equal(workspaceOfSession([w1, w2], 's2').workspaceId, 'w2')
  assert.equal(inferWorkspaceId(doc, a, sessions, [w1, w2], 's3'), 'w1')
  assert.equal(inferWorkspaceId(doc, a, sessions, [w1, w2], 's4'), 'w2')
  const empty = createGroup(doc, { name: 'Empty' })
  assert.equal(inferWorkspaceId(empty, empty.groups[1].id, sessions, [w1, w2], 's4'), 'w2')
  assert.equal(workspaceLabel(w1), 'W1')
  assert.equal(workspaceLabel({ path: 'C:/p/foo' }), 'foo')
})

test('0.2.12 group icon palette is expanded with common glyphs', () => {
  assert.ok(GROUP_ICONS.length >= 20)
  for (const icon of ['briefcase', 'book', 'code', 'database', 'terminal', 'globe', 'heart', 'home', 'layers', 'calendar', 'chart', 'target']) {
    assert.ok(GROUP_ICONS.includes(icon), `missing icon ${icon}`)
  }
})

test('detachSession removes the abandoned placeholder from groups and ungrouped', () => {
  let doc = createGroup(emptyDoc(), { name: 'Target' })
  const target = doc.groups[0].id
  doc = assignSession(doc, 'stale-blank', target, 0)
  doc = assignSession(doc, 'keep', null, 0)
  const next = detachSession(doc, 'stale-blank')
  assert.deepEqual(findGroup(next, target).sessionIds, [])
  assert.deepEqual(next.ungrouped, ['keep'])
  assert.deepEqual(findGroup(doc, target).sessionIds, ['stale-blank'], 'detachSession is pure')
  assert.throws(() => detachSession(doc, ''), /session-required/)
})

test('validateDoc: group.archived is optional but must be a boolean', () => {
  const doc = createGroup(emptyDoc(), { name: 'A' })
  const group = doc.groups[0]
  assert.equal(validateDoc(doc).ok, true)
  assert.equal(validateDoc({ ...doc, groups: [{ ...group, archived: true }] }).ok, true)
  assert.equal(validateDoc({ ...doc, groups: [{ ...group, archived: false }] }).ok, true)
  assert.equal(
    validateDoc({ ...doc, groups: [{ ...group, archived: undefined }] }).ok,
    true,
    'an explicit undefined equals missing',
  )
  for (const archived of ['true', 'yes', 1, 0, null, {}, []]) {
    const verdict = validateDoc({ ...doc, groups: [{ ...group, archived }] })
    assert.equal(verdict.ok, false, `archived ${JSON.stringify(archived)} must be rejected`)
    assert.deepEqual(verdict.errors, [`group-archived-type:${group.id}`])
  }
  const mixed = validateDoc({ ...doc, groups: [{ ...group, archived: 'yes', color: 'chartreuse' }] })
  assert.deepEqual(mixed.errors, [`group-color:${group.id}`, `group-archived-type:${group.id}`])
})

test('setGroupArchived toggles one flag, returns the same doc for no-ops and never cascades', () => {
  const doc = archivedDoc()
  assert.equal(setGroupArchived(doc, 'b', false), doc, 'missing archived already means false')
  assert.equal(setGroupArchived(doc, 'a', true), doc, 'the same true value is a no-op')

  const archivedB = setGroupArchived(doc, 'b', true)
  assert.notEqual(archivedB, doc)
  assert.equal(findGroup(archivedB, 'b').archived, true)
  assert.equal(findGroup(doc, 'b').archived, undefined, 'setGroupArchived is pure')
  assert.equal(findGroup(archivedB, 'd').archived, undefined, 'archiving a parent does not cascade to child groups')
  assert.deepEqual(findGroup(archivedB, 'a').sessionIds, ['s1', 's4'], 'sessions and their archive state are untouched')

  const restored = setGroupArchived(archivedB, 'b', false)
  assert.equal(findGroup(restored, 'b').archived, false, 'unarchiving persists an explicit false')
  assert.equal(setGroupArchived(restored, 'b', false), restored)
  assert.throws(() => setGroupArchived(doc, 'missing', true), /group-not-found/)
  assert.equal(validateDoc(doc).ok, true)
  assert.equal(validateDoc(archivedB).ok, true)
})

test('frozen groups reject metadata edits at every mutator', () => {
  const doc = archivedDoc()
  assertArchiveError(() => renameGroup(doc, 'a', 'Renamed'), { code: GROUP_ARCHIVED, groupId: 'a', field: 'name' })
  assertArchiveError(() => renameGroup(doc, 'c', 'Renamed'), { code: GROUP_ARCHIVED, groupId: 'c', field: 'name' })
  assertArchiveError(() => setGroupIcon(doc, 'a', 'star'), { code: GROUP_ARCHIVED, groupId: 'a', field: 'icon' })
  assertArchiveError(() => setGroupColor(doc, 'a', 'red'), { code: GROUP_ARCHIVED, groupId: 'a', field: 'color' })
  assertArchiveError(() => setGroupColorHex(doc, 'c', '#123456'), {
    code: GROUP_ARCHIVED,
    groupId: 'c',
    field: 'colorHex',
  })

  assert.equal(findGroup(renameGroup(doc, 'b', 'Renamed'), 'b').name, 'Renamed')
  assert.equal(findGroup(setGroupIcon(doc, 'b', 'star'), 'b').icon, 'star')
  assert.equal(findGroup(setGroupColor(doc, 'e', 'red'), 'e').color, 'red')
  assert.equal(findGroup(setGroupColorHex(doc, 'b', '#abc'), 'b').colorHex, '#aabbcc')
})

test('frozen groups reject session content changes while outside edits stay legal', () => {
  const doc = archivedDoc()
  assertArchiveError(() => assignSession(doc, 's3', 'a'), {
    code: GROUP_DESTINATION_ARCHIVED,
    groupId: 'a',
    field: 'sessionIds',
  })
  assertArchiveError(() => assignSession(doc, 's1', 'b'), {
    code: GROUP_ARCHIVED,
    groupId: 'a',
    field: 'sessionIds',
  })
  assertArchiveError(() => assignSession(doc, 's4', 'a', 0), {
    code: GROUP_ARCHIVED,
    groupId: 'a',
    field: 'sessionIds',
  })
  assertArchiveError(() => detachSession(doc, 's1'), { code: GROUP_ARCHIVED, groupId: 'a', field: 'sessionIds' })

  assert.deepEqual(findGroup(assignSession(doc, 's5', 'b', 0), 'b').sessionIds, ['s5', 's3'])
  assert.deepEqual(findGroup(assignSession(doc, 's5', null), 'b').sessionIds, ['s3'])
  assert.deepEqual(findGroup(detachSession(doc, 's3'), 'b').sessionIds, [])
})

test('frozen structure rejects child insertion, sibling shifts and deletion', () => {
  const doc = archivedDoc()
  assertArchiveError(() => createGroup(doc, { name: 'N', parentId: 'a' }), {
    code: GROUP_DESTINATION_ARCHIVED,
    groupId: 'a',
    field: 'children',
  })
  assertArchiveError(() => createGroup(doc, { name: 'N', index: 0 }), {
    code: GROUP_POSITION_LOCKED,
    groupId: 'a',
    field: 'index',
  })
  assertArchiveError(() => moveGroup(doc, 'a', null, 1), { code: GROUP_ARCHIVED, groupId: 'a', field: 'index' })
  assertArchiveError(() => moveGroup(doc, 'a', 'b', 0), { code: GROUP_ARCHIVED, groupId: 'a', field: 'parentId' })
  assertArchiveError(() => moveGroup(doc, 'b', 'a', 0), {
    code: GROUP_DESTINATION_ARCHIVED,
    groupId: 'a',
    field: 'children',
  })
  assertArchiveError(() => deleteGroup(doc, 'a'), { code: GROUP_ARCHIVED, groupId: 'a', field: 'deleted' })
  assertArchiveError(() => deleteGroupTo(doc, 'a', 'b'), { code: GROUP_ARCHIVED, groupId: 'a', field: 'deleted' })

  assert.equal(createGroup(doc, { name: 'N' }).groups.length, doc.groups.length + 1)
  assert.equal(createGroup(doc, { name: 'N', parentId: 'b' }).groups.length, doc.groups.length + 1)
  assert.equal(deleteGroup(doc, 'b').groups.some((group) => group.id === 'b'), false)
  assert.equal(deleteGroupTo(doc, 'b', 'e').groups.some((group) => group.id === 'b'), false)
  assert.equal(moveGroup(doc, 'b', null, 2).groups.some((group) => group.id === 'b'), true)
})

test('moving or deleting an ancestor of a frozen group is rejected', () => {
  const nested = docDef([groupDef('p', null, { sessionIds: ['s1'] }), groupDef('x'), groupDef('q', 'p', { archived: true })])
  assertArchiveError(() => deleteGroup(nested, 'p'), {
    code: GROUP_CONTAINS_ARCHIVED,
    groupId: 'p',
    field: 'deleted',
  })
  assertArchiveError(() => deleteGroupTo(nested, 'p', 'x'), {
    code: GROUP_CONTAINS_ARCHIVED,
    groupId: 'p',
    field: 'deleted',
  })
  assertArchiveError(() => moveGroup(nested, 'p', null, 1), {
    code: GROUP_CONTAINS_ARCHIVED,
    groupId: 'p',
    field: 'index',
  })
  assertArchiveError(() => moveGroup(nested, 'p', 'x', 0), {
    code: GROUP_CONTAINS_ARCHIVED,
    groupId: 'p',
    field: 'parentId',
  })
  assertArchiveError(() => createGroup(nested, { name: 'N', index: 0 }), {
    code: GROUP_POSITION_LOCKED,
    groupId: 'p',
    field: 'index',
  })

  assert.equal(findGroup(renameGroup(nested, 'p', 'Renamed'), 'p').name, 'Renamed', 'ancestor metadata may change')
  assert.equal(deleteGroup(nested, 'x').groups.some((group) => group.id === 'x'), false)
})

test('unarchiving unlocks the subtree only in a later commit', () => {
  const doc = archivedDoc()
  assertArchiveError(() => renameGroup(doc, 'a', 'Renamed'), { code: GROUP_ARCHIVED, groupId: 'a', field: 'name' })
  const unarchived = setGroupArchived(doc, 'a', false)
  assert.equal(findGroup(renameGroup(unarchived, 'a', 'Renamed'), 'a').name, 'Renamed')
  assert.equal(findGroup(renameGroup(unarchived, 'c', 'Renamed'), 'c').name, 'Renamed')
  assert.equal(findGroup(setGroupArchived(unarchived, 'c', true), 'c').archived, true)
})

// ---------------------------------------------------------------- P2 group visibility

/**
 * P2 visibility fixture (0.4.0-beta.62 §4):
 *
 *   p (live, sessions [p1])
 *     q (own-archived, sessions [q1, ghost])
 *       r (not own-archived, inherits; sessions [r1])
 *   x (live, sessions [x1])
 *   z (own-archived, empty)
 *   ungrouped: [u1]
 *
 * `ghost` lives in the archived group but is present in `sessionsById`, so a
 * leak through ungrouped derivation would be visible.
 */
const visibilityDoc = () =>
  docDef(
    [
      groupDef('p', null, { sessionIds: ['p1'] }),
      groupDef('q', 'p', { archived: true, sessionIds: ['q1', 'ghost'] }),
      groupDef('r', 'q', { sessionIds: ['r1'] }),
      groupDef('x', null, { sessionIds: ['x1'] }),
      groupDef('z', null, { archived: true }),
    ],
    ['u1'],
  )

const visibilitySessions = () => ({
  p1: { id: 'p1', updatedAt: 1 },
  q1: { id: 'q1', updatedAt: 2 },
  r1: { id: 'r1', updatedAt: 3 },
  x1: { id: 'x1', updatedAt: 4 },
  u1: { id: 'u1', updatedAt: 5 },
  ghost: { id: 'ghost', updatedAt: 6 },
})

const nodeId = (node) => (node.kind === 'group' ? `g:${node.group.id}` : `s:${node.session.id}`)

const sessionIdsIn = (nodes) =>
  nodes.flatMap((node) => (node.kind === 'session' ? [node.session.id] : sessionIdsIn(node.children ?? [])))

test('computeGroupVisibility: full/path/sessionGroups per hidden/all/only (N1 ungrouped)', () => {
  const doc = visibilityDoc()
  const hidden = computeGroupVisibility(doc)
  assert.deepEqual([...hidden.full].sort(), ['q', 'r', 'z'], 'full is always the effective-archived set')
  assert.equal(hidden.path.size, 0)
  assert.deepEqual([...hidden.sessionGroups].sort(), ['p', 'x'], 'an archived subtree prunes below a live parent')
  assert.equal(hidden.ungroupedVisible, true)

  const all = computeGroupVisibility(doc, 'all')
  assert.deepEqual([...all.full].sort(), ['q', 'r', 'z'])
  assert.equal(all.path.size, 0)
  assert.deepEqual([...all.sessionGroups].sort(), ['p', 'q', 'r', 'x', 'z'])
  assert.equal(all.ungroupedVisible, true)

  const only = computeGroupVisibility(doc, 'only')
  assert.deepEqual([...only.full].sort(), ['q', 'r', 'z'])
  assert.deepEqual([...only.path], ['p'], 'only non-archived ancestors of full groups are path-only')
  assert.deepEqual([...only.sessionGroups].sort(), ['q', 'r', 'z'], 'path-only ancestors never contribute sessions')
  assert.equal(only.ungroupedVisible, false, 'N1: only hides the ungrouped container')

  assert.deepEqual(computeGroupVisibility(doc, 'bogus'), hidden, 'unknown filters fall back to hidden')
  assert.deepEqual(computeGroupVisibility(null), {
    full: new Set(),
    path: new Set(),
    sessionGroups: new Set(),
    ungroupedVisible: true,
  })

  // Corrupt cycles terminate defensively instead of looping.
  const cyclic = docDef([groupDef('a', 'b'), groupDef('b', 'a', { archived: true })])
  const cycleVisibility = computeGroupVisibility(cyclic, 'only')
  assert.deepEqual([...cycleVisibility.full].sort(), ['a', 'b'])
  assert.equal(cycleVisibility.path.size, 0)
})

test('buildRenderTree groupFilter=hidden prunes archived subtrees but keeps live ancestors', () => {
  const tree = buildRenderTree(visibilityDoc(), visibilitySessions(), [], { filter: 'hidden' })
  assert.deepEqual(tree.groups.map((node) => node.group.id), ['p', 'x'])
  const p = tree.groups[0]
  assert.equal(p.pathOnly, false)
  assert.equal(p.effectiveArchived, false)
  assert.equal(p.ownArchived, false)
  assert.equal(p.archivedBy, null)
  assert.equal(p.visibleCount, 1)
  assert.equal(p.emptyVisible, false)
  assert.deepEqual(p.children.map(nodeId), ['s:p1'], 'the live parent keeps its own sessions; its archived child is pruned')
  assert.deepEqual(tree.ungrouped.map((node) => node.session.id), ['u1'])
  assert.equal(sessionIdsIn(tree.groups).includes('ghost'), false, 'archived-group sessions never leak into ungrouped')
  assert.equal(sessionIdsIn(tree.groups).includes('q1'), false)
})

test('buildRenderTree groupFilter=all keeps archived groups flagged effective/own/archivedBy', () => {
  const tree = buildRenderTree(visibilityDoc(), visibilitySessions(), [], { filter: 'hidden', groupFilter: 'all' })
  assert.deepEqual(tree.groups.map((node) => node.group.id), ['p', 'x', 'z'])
  const p = tree.groups[0]
  const q = p.children.find((node) => node.kind === 'group' && node.group.id === 'q')
  const r = q.children.find((node) => node.kind === 'group' && node.group.id === 'r')
  assert.equal(q.effectiveArchived, true)
  assert.equal(q.ownArchived, true)
  assert.equal(q.archivedBy, 'q')
  assert.equal(q.pathOnly, false)
  assert.equal(r.effectiveArchived, true, 'descendants inherit the archived state')
  assert.equal(r.ownArchived, false)
  assert.equal(r.archivedBy, 'q')
  assert.equal(r.pathOnly, false)
  assert.deepEqual(sessionIdsIn(q.children).sort(), ['ghost', 'q1', 'r1'])
  const z = tree.groups[2]
  assert.equal(z.effectiveArchived, true)
  assert.equal(z.visibleCount, 0)
  assert.equal(z.emptyVisible, true, 'an empty archived group still renders its locked empty row')
  assert.deepEqual(sessionIdsIn(tree.groups).sort(), ['ghost', 'p1', 'q1', 'r1', 'x1'])
})

test('buildRenderTree groupFilter=only renders full groups and header-only path ancestors', () => {
  const tree = buildRenderTree(visibilityDoc(), visibilitySessions(), [], { filter: 'hidden', groupFilter: 'only' })
  assert.deepEqual(tree.groups.map((node) => node.group.id), ['p', 'z'], 'x has no archived descendant and is pruned')
  const p = tree.groups[0]
  assert.equal(p.pathOnly, true)
  assert.equal(p.effectiveArchived, false)
  assert.equal(p.archivedBy, null)
  assert.equal(p.visibleCount, 3, 'a path-only group counts only its visible descendants')
  assert.equal(p.emptyVisible, false)
  assert.deepEqual(p.children.map(nodeId), ['g:q'], 'path-only rows keep only the path/full child chain')
  assert.equal(sessionIdsIn(p.children).includes('p1'), false, 'path-only own sessions never render')
  const q = p.children[0]
  assert.equal(q.pathOnly, false)
  assert.equal(q.effectiveArchived, true)
  assert.deepEqual(sessionIdsIn(q.children).sort(), ['ghost', 'q1', 'r1'])
  const z = tree.groups[1]
  assert.equal(z.pathOnly, false)
  assert.equal(z.effectiveArchived, true)
  assert.equal(z.visibleCount, 0)
  assert.equal(z.emptyVisible, true)
  assert.deepEqual(tree.ungrouped, [], 'N1: only hides ungrouped even for stored rows')
  assert.equal(sessionIdsIn(tree.groups).includes('u1'), false)
})

test('buildRenderTree groupFilter=only still applies the session tri-state inside full groups', () => {
  const archived = ['p1', 'q1']
  const tree = buildRenderTree(visibilityDoc(), visibilitySessions(), [], {
    filter: 'only',
    groupFilter: 'only',
    archivedSessionIds: archived,
  })
  const p = tree.groups[0]
  assert.equal(p.pathOnly, true)
  assert.deepEqual(p.children.map(nodeId), ['g:q'])
  const q = p.children[0]
  assert.deepEqual(sessionIdsIn(q.children), ['q1'], 'session-only keeps archived rows inside a full group')
  assert.equal(q.visibleCount, 1)
  assert.equal(p.visibleCount, 1)
  assert.equal(sessionIdsIn(p.children).includes('p1'), false, 'path-only own rows stay hidden even when archived')
})

test('buildRenderTree groupFilter=hidden keeps group pruning under the session all filter', () => {
  const tree = buildRenderTree(visibilityDoc(), visibilitySessions(), [], {
    filter: 'all',
    groupFilter: 'hidden',
    archivedSessionIds: ['x1', 'u1'],
  })
  assert.deepEqual(tree.groups.map((node) => node.group.id), ['p', 'x'])
  assert.deepEqual(sessionIdsIn(tree.groups).sort(), ['p1', 'x1'], 'archived rows inside visible groups still show')
  assert.deepEqual(tree.ungrouped.map((node) => node.session.id), ['u1'])
  assert.equal(sessionIdsIn(tree.groups).includes('q1'), false)
})

test('buildRenderTree: groupFilter defaults to hidden and old archived-free docs are unchanged', () => {
  const doc = docDef([groupDef('a', null, { sessionIds: ['a1'] }), groupDef('b')], ['u1'])
  const sessions = { a1: { id: 'a1', updatedAt: 1 }, u1: { id: 'u1', updatedAt: 2 } }
  const implicit = buildRenderTree(doc, sessions, [], { filter: 'all' })
  const explicit = buildRenderTree(doc, sessions, [], { filter: 'all', groupFilter: 'hidden' })
  const bogus = buildRenderTree(doc, sessions, [], { filter: 'all', groupFilter: 'bogus' })
  assert.deepEqual(implicit, explicit)
  assert.deepEqual(bogus, explicit)
  assert.deepEqual(implicit.groups.map((node) => node.group.id), ['a', 'b'])
  assert.deepEqual(implicit.ungrouped.map((node) => node.session.id), ['u1'])
  for (const node of implicit.groups) {
    assert.equal(node.effectiveArchived, false)
    assert.equal(node.ownArchived, false)
    assert.equal(node.archivedBy, null)
    assert.equal(node.pathOnly, false)
  }
})

test('buildRenderTree groupFilter=only with no archived groups renders an empty view', () => {
  const doc = docDef([groupDef('a', null, { sessionIds: ['a1'] })], ['u1'])
  const sessions = { a1: { id: 'a1' }, u1: { id: 'u1' } }
  const tree = buildRenderTree(doc, sessions, [], { filter: 'all', groupFilter: 'only' })
  assert.deepEqual(tree.groups, [])
  assert.deepEqual(tree.ungrouped, [], 'only hides ungrouped even though the session filter is all')
})

test('buildRenderTree groupFilter × session filter matrix keeps group pruning above the session tri-state', () => {
  const doc = visibilityDoc()
  const sessions = visibilitySessions()
  const archivedSessionIds = ['p1', 'q1', 'u1']
  const roots = { hidden: ['p', 'x'], all: ['p', 'x', 'z'], only: ['p', 'z'] }
  // p1 (p) · q1+ghost (q) · r1 (r) · x1 (x) · u1 (ungrouped)
  const expected = {
    'hidden:hidden': ['x1'],
    'hidden:all': ['p1', 'u1', 'x1'],
    'hidden:only': ['p1', 'u1'],
    'all:hidden': ['ghost', 'r1', 'x1'],
    'all:all': ['ghost', 'p1', 'q1', 'r1', 'u1', 'x1'],
    'all:only': ['p1', 'q1', 'u1'],
    'only:hidden': ['ghost', 'r1'],
    'only:all': ['ghost', 'q1', 'r1'],
    'only:only': ['q1'],
  }
  for (const groupFilter of ['hidden', 'all', 'only']) {
    for (const filter of ['hidden', 'all', 'only']) {
      const tree = buildRenderTree(doc, sessions, [], { filter, groupFilter, archivedSessionIds })
      const label = `${groupFilter}:${filter}`
      assert.deepEqual(tree.groups.map((node) => node.group.id), roots[groupFilter], `root groups under ${groupFilter}`)
      assert.deepEqual(
        sessionIdsIn(tree.groups).concat(tree.ungrouped.map((node) => node.session.id)).sort(),
        expected[label],
        `session rows under ${label}`,
      )
    }
  }
})
