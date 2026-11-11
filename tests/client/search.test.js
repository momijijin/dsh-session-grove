// tests/client/search.test.js
//
// Task 5 (v1.1): pure search index + reveal logic. Requirements:
// historical design archive (see docs/archive/README.md) §3.3/§4.4/§7.
// No DOM, no React: every assertion drives the exported pure functions.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  UNGROUPED_ID,
  buildSearchIndex,
  matchSessions,
  revealSession,
  splitSearchResultsByVisibility,
} from '../../src/core/search.js'

const searchBoxSource = readFileSync(new URL('../../src/client/components-search-box.js', import.meta.url), 'utf8')
const searchRevealSource = readFileSync(new URL('../../src/client/groups-view-search.js', import.meta.url), 'utf8')

/**
 * Index fixture:
 *   g-a          Alpha            s1 (workspace Bridge), s2 (archived)
 *     g-a1       Alpha One        s3 (workspace Docs)
 *       g-a1x    Alpha One X      s4 (workspace Docs)
 *   g-b          Beta             (empty)
 *   ungrouped:  u1;  host-derived: derived/blank/renamedBlank/untitled
 *   subagent rows: sub, sub2 (never indexed)
 */
const indexFixture = () => ({
  doc: {
    version: 1,
    revision: 4,
    groups: [
      { id: 'g-a', name: 'Alpha', icon: 'folder', parentId: null, sessionIds: ['s1', 's2'] },
      { id: 'g-a1', name: 'Alpha One', icon: 'folder', parentId: 'g-a', sessionIds: ['s3'] },
      { id: 'g-a1x', name: 'Alpha One X', icon: 'folder', parentId: 'g-a1', sessionIds: ['s4'] },
      { id: 'g-b', name: 'Beta', icon: 'folder', parentId: null, sessionIds: [] },
    ],
    ungrouped: ['u1'],
  },
  sessionsById: {
    s1: { id: 's1', displayTitle: 'Bridge report' },
    s2: { id: 's2', title: 'Quarterly numbers' },
    s3: { id: 's3', displayTitle: 'Planning notes' },
    s4: { id: 's4', displayTitle: 'Deep nested' },
    u1: { id: 'u1', title: 'Loose session' },
    derived: { id: 'derived', displayTitle: 'Derived ungrouped', updatedAt: 9 },
    blank: { id: 'blank', blank: true },
    renamedBlank: { id: 'renamedBlank', blank: true, title: 'Renamed blank' },
    untitled: { id: 'untitled' },
    sub: { id: 'sub', displayTitle: 'Fork helper', origin: 'subagent' },
    sub2: { id: 'sub2', title: 'Nested fork', origin: 'subagent', parentId: 's1' },
  },
  workspaces: [
    { workspaceId: 'w1', title: 'Bridge', path: 'C:\\work\\bridge', sessionIds: ['s1'] },
    {
      workspaceId: 'w2',
      title: 'Docs',
      path: 'C:\\work\\docs',
      sessionIds: ['s3', 's4', 'u1', 'derived', 'blank', 'renamedBlank', 'untitled'],
    },
  ],
  archivedSessionIds: ['s2'],
})

const indexedById = (source = indexFixture()) =>
  Object.fromEntries(buildSearchIndex(source).map((entry) => [entry.sessionId, entry]))

/** Matching fixture with a controlled rank spread (prefix / contains / workspace / path). */
const matchFixture = () => [
  { sessionId: 'prefix-arch', title: 'Alpha archived', workspace: '', groupPath: '', groupIds: [], archived: true },
  { sessionId: 'prefix-two', title: 'Alpha two', workspace: '', groupPath: '', groupIds: [], archived: false },
  { sessionId: 'prefix-one', title: 'Alpha one', workspace: '', groupPath: '', groupIds: [], archived: false },
  { sessionId: 'contains', title: 'The alpha in the middle', workspace: '', groupPath: '', groupIds: [], archived: false },
  { sessionId: 'workspace', title: 'Bridge report', workspace: 'Alpha workspace', groupPath: '', groupIds: [], archived: false },
  {
    sessionId: 'group-path',
    title: 'Gamma notes',
    workspace: 'Docs',
    groupPath: 'Alpha / Planning',
    groupIds: ['g-a'],
    archived: false,
  },
  { sessionId: 'none', title: 'Unrelated', workspace: 'Docs', groupPath: 'Other', groupIds: [], archived: false },
]

const revealFixture = () => ({
  version: 1,
  revision: 2,
  groups: [
    { id: 'g-a', name: 'Alpha', icon: 'folder', parentId: null, sessionIds: ['s1'] },
    { id: 'g-a1', name: 'Alpha One', icon: 'folder', parentId: 'g-a', sessionIds: ['s2'] },
    { id: 'g-a1x', name: 'Alpha One X', icon: 'folder', parentId: 'g-a1', sessionIds: ['s3'] },
    { id: 'g-b', name: 'Beta', icon: 'folder', parentId: null, sessionIds: ['s4'] },
  ],
  ungrouped: ['u1'],
})

// ---------------------------------------------------------------- buildSearchIndex

test('index excludes subagent rows and keeps every other session (archived, ungrouped, blank)', () => {
  const entries = buildSearchIndex(indexFixture())
  assert.deepEqual(
    entries.map((entry) => entry.sessionId).sort(),
    ['blank', 'derived', 'renamedBlank', 's1', 's2', 's3', 's4', 'u1', 'untitled']
  )
  assert.equal(entries.some((entry) => entry.sessionId === 'sub' || entry.sessionId === 'sub2'), false)
})

test('index entries expose the exact Entry fields: sessionId, title, workspace, groupPath, groupIds, groupId, archived, aliases', () => {
  const byId = indexedById()
  assert.deepEqual(byId.s1, {
    sessionId: 's1',
    title: 'Bridge report',
    workspace: 'Bridge',
    groupPath: 'Alpha',
    groupIds: ['g-a'],
    groupId: 'g-a',
    archived: false,
    aliases: [],
  })
  assert.deepEqual(byId.s3, {
    sessionId: 's3',
    title: 'Planning notes',
    workspace: 'Docs',
    groupPath: 'Alpha / Alpha One',
    groupIds: ['g-a', 'g-a1'],
    groupId: 'g-a1',
    archived: false,
    aliases: [],
  })
  assert.deepEqual(byId.s4, {
    sessionId: 's4',
    title: 'Deep nested',
    workspace: 'Docs',
    groupPath: 'Alpha / Alpha One / Alpha One X',
    groupIds: ['g-a', 'g-a1', 'g-a1x'],
    groupId: 'g-a1x',
    archived: false,
    aliases: [],
  })
  assert.deepEqual(byId.u1, {
    sessionId: 'u1',
    title: 'Loose session',
    workspace: 'Docs',
    groupPath: '',
    groupIds: [],
    groupId: null,
    archived: false,
    aliases: [],
  })
  // Derived (host-only) ungrouped sessions have an empty group path too.
  assert.deepEqual(byId.derived, {
    sessionId: 'derived',
    title: 'Derived ungrouped',
    workspace: 'Docs',
    groupPath: '',
    groupIds: [],
    groupId: null,
    archived: false,
    aliases: [],
  })
})

test('index titles follow sessionTitle rules and archive flags follow the host array', () => {
  const byId = indexedById()
  assert.equal(byId.blank.title, '新会话')
  assert.equal(byId.renamedBlank.title, 'Renamed blank')
  assert.equal(byId.untitled.title, '未命名')
  assert.equal(byId.s2.archived, true)
  assert.equal(byId.s2.workspace, '')
  assert.equal(byId.s1.archived, false)

  const withArchive = indexedById({ ...indexFixture(), archivedSessionIds: ['u1', 'unknown-id'] })
  assert.equal(withArchive.u1.archived, true)
  assert.equal(withArchive.s1.archived, false)
})

test('index tolerates missing, null or malformed inputs without throwing', () => {
  assert.deepEqual(buildSearchIndex(), [])
  assert.deepEqual(buildSearchIndex(null), [])
  assert.deepEqual(buildSearchIndex(42), [])
  assert.deepEqual(buildSearchIndex('nope'), [])
  assert.deepEqual(buildSearchIndex({ doc: null, sessionsById: null, workspaces: null, archivedSessionIds: null }), [])
  const entries = buildSearchIndex({ sessionsById: { x: { id: 'x', title: 'Solo' } } })
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0], {
    sessionId: 'x',
    title: 'Solo',
    workspace: '',
    groupPath: '',
    groupIds: [],
    groupId: null,
    archived: false,
    aliases: [],
  })
})

test('placeholder rows carry locale-neutral match aliases without changing the localized display title', () => {
  const byId = indexedById()
  assert.equal(byId.blank.title, '新会话')
  assert.deepEqual(byId.blank.aliases, ['new session', 'blank session', '新会话', '新建会话'])
  assert.equal(byId.untitled.title, '未命名')
  assert.deepEqual(byId.untitled.aliases, ['untitled', 'no title', '未命名'])
  // A user-renamed blank keeps its custom title and must not match "new session".
  assert.deepEqual(byId.renamedBlank.aliases, [])
  assert.deepEqual(byId.s1.aliases, [])

  const index = buildSearchIndex(indexFixture())
  assert.deepEqual(matchSessions(index, 'new session').map((entry) => entry.sessionId), ['blank'])
  assert.deepEqual(matchSessions(index, 'NEW SESSION').map((entry) => entry.sessionId), ['blank'])
  assert.deepEqual(matchSessions(index, 'untitled').map((entry) => entry.sessionId), ['untitled'])
  assert.deepEqual(matchSessions(index, 'renamed blank').map((entry) => entry.sessionId), ['renamedBlank'])
  assert.deepEqual(matchSessions(index, 'new session').some((entry) => entry.sessionId === 'renamedBlank'), false)
})

// ---------------------------------------------------------------------- matchSessions

test('match ranks title prefix over title contains over workspace / group path', () => {
  assert.deepEqual(
    matchSessions(matchFixture(), 'alpha').map((entry) => entry.sessionId),
    ['prefix-arch', 'prefix-one', 'prefix-two', 'contains', 'workspace', 'group-path']
  )
})

test('match is case-insensitive and trims the query', () => {
  assert.deepEqual(matchSessions(matchFixture(), 'ALPHA TWO').map((entry) => entry.sessionId), ['prefix-two'])
  assert.deepEqual(matchSessions(matchFixture(), '  aLpHa oNe  ').map((entry) => entry.sessionId), ['prefix-one'])
})

test('match searches workspace labels and group paths', () => {
  assert.deepEqual(matchSessions(matchFixture(), 'workspace').map((entry) => entry.sessionId), ['workspace'])
  assert.deepEqual(matchSessions(matchFixture(), 'planning').map((entry) => entry.sessionId), ['group-path'])
})

test('match returns nothing for empty, whitespace or non-string queries', () => {
  for (const query of ['', '   ', '\t\n', null, undefined, 42, {}]) {
    assert.deepEqual(matchSessions(matchFixture(), query), [])
  }
  assert.deepEqual(matchSessions(null, 'alpha'), [])
})

test('match caps results at 20 by default and honours an explicit limit', () => {
  const many = Array.from({ length: 25 }, (_, index) => {
    const label = String(index + 1).padStart(2, '0')
    return {
      sessionId: `n${label}`,
      title: `Item ${label}`,
      workspace: '',
      groupPath: '',
      groupIds: [],
      archived: false,
    }
  })
  const defaulted = matchSessions(many, 'item')
  assert.equal(defaulted.length, 20)
  assert.equal(defaulted[0].sessionId, 'n01')
  assert.equal(defaulted[19].sessionId, 'n20')
  assert.deepEqual(matchSessions(many, 'item', 3).map((entry) => entry.sessionId), ['n01', 'n02', 'n03'])
  assert.deepEqual(matchSessions(many, 'item', 0), [])
})

test('match sorts equal titles by session id for stable output', () => {
  const index = [
    { sessionId: 'zeta', title: 'Same title', workspace: '', groupPath: '', groupIds: [], archived: false },
    { sessionId: 'alpha', title: 'Same title', workspace: '', groupPath: '', groupIds: [], archived: false },
  ]
  assert.deepEqual(matchSessions(index, 'same').map((entry) => entry.sessionId), ['alpha', 'zeta'])
})

test('match returns archived entries with their archived flag (selection is the UI concern)', () => {
  const results = matchSessions(matchFixture(), 'archived')
  assert.equal(results.length, 1)
  assert.equal(results[0].sessionId, 'prefix-arch')
  assert.equal(results[0].archived, true)
})

// ---------------------------------------------------------------------- revealSession

test('revealSession exposes the ungrouped sentinel used by the collapsed map', () => {
  assert.equal(UNGROUPED_ID, '__ungrouped__')
})

test('revealSession expands the containing group and every ancestor in a nested path', () => {
  const doc = revealFixture()
  const collapsed = { 'g-a': true, 'g-a1': true, 'g-a1x': true, 'g-b': true }
  const snapshot = { ...collapsed }

  const next = revealSession(doc, collapsed, 's3')
  assert.notEqual(next, collapsed, 'a change must return a new collapsed object')
  assert.deepEqual(next, { 'g-b': true })
  assert.deepEqual(collapsed, snapshot, 'the input collapsed map must not be mutated')
})

test('revealSession removes a root-level containing group and leaves unrelated groups collapsed', () => {
  const doc = revealFixture()
  assert.deepEqual(revealSession(doc, { 'g-a': true, 'g-b': true }, 's1'), { 'g-b': true })
  assert.deepEqual(revealSession(doc, { 'g-b': true }, 's4'), {})
})

test('revealSession expands the ungrouped container for stored ungrouped sessions', () => {
  const doc = revealFixture()
  assert.deepEqual(revealSession(doc, { [UNGROUPED_ID]: true, 'g-b': true }, 'u1'), { 'g-b': true })
})

test('revealSession falls back to the ungrouped container when no group owns the session', () => {
  const doc = revealFixture()
  // `derived` is not in doc.groups nor doc.ungrouped: the host leaves it out of
  // the record (derived newest-first), so the fallback must still expand it.
  assert.deepEqual(revealSession(doc, { [UNGROUPED_ID]: true, 'g-b': true }, 'derived'), { 'g-b': true })
  // Same fallback for an id the tree does not know at all.
  assert.deepEqual(revealSession(doc, { [UNGROUPED_ID]: true }, 'missing-session'), {})
  assert.deepEqual(revealSession(undefined, { [UNGROUPED_ID]: true }, 'anything'), {})
})

test('revealSession returns the same collapsed reference when nothing is collapsed in the path', () => {
  const doc = revealFixture()
  const collapsed = { 'g-b': true }
  assert.equal(revealSession(doc, collapsed, 's3'), collapsed)
  assert.equal(revealSession(doc, collapsed, 'derived'), collapsed)
  const empty = {}
  assert.equal(revealSession(doc, empty, 's1'), empty)
  assert.equal(revealSession(doc, empty, 'derived'), empty)
})

test('revealSession treats only the boolean true as collapsed (truthy values stay expanded)', () => {
  const doc = revealFixture()
  // The store only ever writes `true`, but a legacy/foreign truthy value must not
  // be mistaken for a collapsed flag: expanded-by-default means non-true = open.
  const collapsed = { 'g-a': 1, 'g-a1': 'yes', [UNGROUPED_ID]: {} }
  assert.equal(revealSession(doc, collapsed, 's3'), collapsed)
  assert.equal(revealSession(doc, collapsed, 'derived'), collapsed)
  // A real `true` next to truthy noise is still removed and only that key.
  const mixed = { 'g-a': true, 'g-a1': 'yes', 'g-b': true }
  assert.deepEqual(revealSession(doc, mixed, 's1'), { 'g-a1': 'yes', 'g-b': true })
})

// ------------------------------------------- P2 group visibility (0.4.0-beta.62 §4.5)

/**
 * Group-visibility fixture:
 *   g-live        sessions [live, live-archived]   (live-archived is individually archived)
 *   g-arch        archived, sessions [archived]
 *   g-path        sessions [path-own]              (has an archived child, so it is pathOnly under "only")
 *     g-path-child archived, sessions [path-child]
 *   g-empty       no sessions
 *   ungrouped:    [loose]
 */
const visibilityFixture = () => ({
  doc: {
    version: 1,
    revision: 0,
    groups: [
      { id: 'g-live', name: 'Live', icon: 'folder', parentId: null, sessionIds: ['live', 'live-archived'] },
      { id: 'g-arch', name: 'Archived', icon: 'folder', parentId: null, sessionIds: ['archived'], archived: true },
      { id: 'g-path', name: 'Path', icon: 'folder', parentId: null, sessionIds: ['path-own'] },
      {
        id: 'g-path-child',
        name: 'Path child',
        icon: 'folder',
        parentId: 'g-path',
        sessionIds: ['path-child'],
        archived: true,
      },
      { id: 'g-empty', name: 'Empty', icon: 'folder', parentId: null, sessionIds: [] },
    ],
    ungrouped: ['loose'],
  },
  sessionsById: {
    live: { id: 'live', displayTitle: 'Live row' },
    'live-archived': { id: 'live-archived', displayTitle: 'Live archived row' },
    archived: { id: 'archived', displayTitle: 'Archived row' },
    'path-own': { id: 'path-own', displayTitle: 'Path own row' },
    'path-child': { id: 'path-child', displayTitle: 'Path child row' },
    loose: { id: 'loose', displayTitle: 'Loose row' },
  },
  workspaces: [],
  archivedSessionIds: ['live-archived'],
})

const visibleIds = (source, groupFilter) => {
  const entries = buildSearchIndex(source)
  const split = splitSearchResultsByVisibility(source.doc, entries, groupFilter)
  return {
    visible: split.visible.map((entry) => entry.sessionId).sort(),
    hidden: split.hidden.map((entry) => entry.sessionId).sort(),
  }
}

test('index keeps grouped sessions regardless of their group archive state and tags each entry with its groupId', () => {
  const source = visibilityFixture()
  const entries = buildSearchIndex(source)
  assert.equal(entries.length, 6, 'the index is a view-filter-agnostic projection')
  const byId = Object.fromEntries(entries.map((entry) => [entry.sessionId, entry]))
  assert.equal(byId.live.groupId, 'g-live')
  assert.equal(byId.archived.groupId, 'g-arch', 'archived groups still own their indexed rows')
  assert.equal(byId['path-own'].groupId, 'g-path')
  assert.equal(byId['path-child'].groupId, 'g-path-child')
  assert.equal(byId.loose.groupId, null)
  assert.equal(byId['live-archived'].archived, true)
})

test('splitSearchResultsByVisibility=hidden hides archived subtrees but keeps individually archived rows of live groups', () => {
  const split = visibleIds(visibilityFixture(), 'hidden')
  assert.deepEqual(split.visible, ['live', 'live-archived', 'loose', 'path-own'])
  assert.deepEqual(split.hidden, ['archived', 'path-child'], 'a live group keeps its own rows; pathOnly only applies under "only"')
})

test('splitSearchResultsByVisibility=all makes every grouped and ungrouped row visible', () => {
  const split = visibleIds(visibilityFixture(), 'all')
  assert.deepEqual(split.visible, ['archived', 'live', 'live-archived', 'loose', 'path-child', 'path-own'])
  assert.deepEqual(split.hidden, [])
})

test('splitSearchResultsByVisibility=only shows full groups only: pathOnly own rows and ungrouped stay hidden', () => {
  const split = visibleIds(visibilityFixture(), 'only')
  assert.deepEqual(split.visible, ['archived', 'path-child'])
  assert.deepEqual(split.hidden, ['live', 'live-archived', 'loose', 'path-own'])
})

test('splitSearchResultsByVisibility=only with no archived groups returns no visible rows', () => {
  const source = visibilityFixture()
  const plain = {
    ...source,
    doc: {
      ...source.doc,
      groups: source.doc.groups.filter((group) => group.archived !== true),
    },
  }
  const split = visibleIds(plain, 'only')
  assert.deepEqual(split.visible, [])
  assert.equal(split.hidden.length, 6)
})

test('splitSearchResultsByVisibility defaults to hidden and tolerates malformed input', () => {
  const source = visibilityFixture()
  const entries = buildSearchIndex(source)
  assert.deepEqual(
    splitSearchResultsByVisibility(source.doc, entries, 'bogus'),
    splitSearchResultsByVisibility(source.doc, entries, 'hidden'),
    'an out-of-vocabulary group filter is treated as "hidden"',
  )
  assert.deepEqual(splitSearchResultsByVisibility(null, null), { visible: [], hidden: [] })
  // An entry without a groupId is ungrouped: visible under hidden, hidden under only.
  const ungroupedEntry = { sessionId: 'x', title: 'x' }
  assert.deepEqual(splitSearchResultsByVisibility(null, [ungroupedEntry], 'hidden'), {
    visible: [ungroupedEntry],
    hidden: [],
  })
  assert.deepEqual(splitSearchResultsByVisibility(null, [ungroupedEntry], 'only'), {
    visible: [],
    hidden: [ungroupedEntry],
  })
})

test('matchSessions output feeds the group-visibility split (hidden hit count for the P9 hint)', () => {
  const source = visibilityFixture()
  const index = buildSearchIndex(source)
  const matches = matchSessions(index, 'row')
  const hiddenSplit = splitSearchResultsByVisibility(source.doc, matches, 'hidden')
  assert.deepEqual(hiddenSplit.visible.map((entry) => entry.sessionId).sort(), [
    'live',
    'live-archived',
    'loose',
    'path-own',
  ])
  assert.deepEqual(hiddenSplit.hidden.map((entry) => entry.sessionId).sort(), ['archived', 'path-child'])
  const onlySplit = splitSearchResultsByVisibility(source.doc, matches, 'only')
  assert.deepEqual(onlySplit.visible.map((entry) => entry.sessionId).sort(), ['archived', 'path-child'])
})

// ------------------------------------ P9 search UI wiring (0.4.0-beta.62 §4.5)

test('hidden matches never consume the visible search limit (split-before-limit contract)', () => {
  const source = visibilityFixture()
  const index = buildSearchIndex(source)
  const matches = matchSessions(index, 'row', 1000)
  const split = splitSearchResultsByVisibility(source.doc, matches, 'hidden')
  assert.equal(split.hidden.length, 2)
  assert.equal(split.visible.slice(0, 3).length, 3, 'visible rows are capped after the visibility split')
  assert.equal(split.visible.length + split.hidden.length, matches.length, 'every match is reported')
})

test('search box splits by group visibility before capping and only renders visible rows', () => {
  assert.match(
    searchBoxSource,
    /import \{ buildSearchIndex, matchSessions, splitSearchResultsByVisibility \} from '\.\.\/core\/search\.js'/
  )
  const budget = searchBoxSource.indexOf('matchSessions(index, query, SEARCH_MATCH_BUDGET)')
  const split = searchBoxSource.indexOf('splitSearchResultsByVisibility(')
  const slice = searchBoxSource.indexOf('split.visible.slice(')
  assert.ok(budget >= 0, 'full match set is requested for the hidden count')
  assert.ok(split > budget, 'visibility split runs on the full match set')
  assert.ok(slice > split, 'the visible limit applies after the split')
  assert.match(searchBoxSource, /const hiddenCount = split\.hidden\.length/)
  // Result rows are built from the limited visible list only.
  assert.match(searchBoxSource, /results\.map\(\(entry, position\) => \{/)
})

test('search hidden matches render a count and an explicit show-archived action (no auto switch)', () => {
  assert.match(searchBoxSource, /'data-testid': 'session-groups-search-hidden'/)
  assert.match(searchBoxSource, /'data-testid': 'session-groups-search-show-archived'/)
  assert.match(searchBoxSource, /hiddenCount > 0/)
  assert.match(searchBoxSource, /t\(hiddenMessageKey, \{ n: hiddenCount \}\)/)
  // The group filter only changes in the explicit action helper, which is only
  // reachable from the hidden-result button.
  const dispatch = searchBoxSource.indexOf("'group-archive-filter'")
  assert.ok(dispatch >= 0, 'the hidden-result action switches the group filter')
  const helper = searchBoxSource.indexOf('const revealHiddenMatches = () => {')
  assert.ok(helper >= 0 && dispatch > helper, 'the switch lives in the explicit action helper')
  assert.equal(searchBoxSource.split("'group-archive-filter'").length - 1, 1, 'exactly one group-filter write')
  assert.match(searchBoxSource, /onClick: \(event\) => \{\s*event\.stopPropagation\(\)\s*revealHiddenMatches\(\)/)
})

test('a filtered-out search target offers an explicit switch instead of auto switching the group filter', () => {
  assert.match(
    searchRevealSource,
    /splitSearchResultsByVisibility\(live\?\.doc, \[probe\], live\?\.groupArchiveFilter \?\? 'hidden'\)/
  )
  assert.match(searchRevealSource, /sessionContainer\(live\?\.doc, entry\.sessionId\)\.groupId/)
  assert.match(searchRevealSource, /search\.hiddenTarget/)
  const dispatch = searchRevealSource.indexOf("dispatch('group-archive-filter', { filter: 'all' })")
  const action = searchRevealSource.lastIndexOf('action: {', dispatch)
  assert.ok(dispatch >= 0, 'the explicit toast action switches the group filter')
  assert.ok(action >= 0 && action < dispatch, 'the switch is deferred to the toast action callback')
  // The existing session-archive behavior (list but not open) is unchanged: an
  // archived row is rejected before the group-visibility reveal.
  assert.ok(
    searchRevealSource.indexOf('entry.archived === true') <
      searchRevealSource.indexOf('const split = splitSearchResultsByVisibility')
  )
})
