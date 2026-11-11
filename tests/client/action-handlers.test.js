import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installClientRuntime } from '../../src/adapters/client-runtime.js'
import { createMenuHandlers, groupMenuLockReason, sessionMenuLockReason } from '../../src/client/groups-view-menu-handlers.js'
import { createDialogHandlers, deleteGroupActionReasonKey, groupArchiveMenuState, groupMoveStepReasonKey } from '../../src/client/groups-view-dialog-handlers.js'
import { setGroupArchived } from '../../src/shared/model.js'

const t = (key) => key

const makeDoc = () => ({
  version: 1,
  groups: [
    { id: 'g1', name: 'Group one', parentId: null, icon: 'folder', color: 'blue', sessionIds: ['s1'] },
    { id: 'g2', name: 'Group two', parentId: null, icon: 'folder', color: 'green', sessionIds: [] },
  ],
  ungrouped: [],
})

const installRuntime = (overrides = {}) => {
  const calls = { dispatch: [], dialog: [], notify: [], resetLayout: 0, deleteGroupDirect: [], copy: [], archive: [], newSessions: [], archiveGroups: [], unarchiveGroups: [], commits: 0 }
  const runtime = {
    store: {
      doc: makeDoc(),
      dispatch: (action, payload) => calls.dispatch.push([action, payload]),
    },
    openDialog: (payload) => calls.dialog.push(payload),
    notify: (payload) => calls.notify.push(payload),
    showToast: (kind, message) => calls.notify.push({ kind, message }),
    resetLayout: () => {
      calls.resetLayout += 1
    },
    deleteGroupDirect: (groupId) => calls.deleteGroupDirect.push(groupId),
    copySessionId: (sessionId) => calls.copy.push(sessionId),
    newSessionInGroup: (groupId, workspaceId) => {
      calls.newSessions.push([groupId, workspaceId])
      return Promise.resolve()
    },
    archiveSession: (sessionId) => calls.archive.push(sessionId),
    unarchiveSession: () => {},
    archiveGroup: (groupId) => calls.archiveGroups.push(groupId),
    unarchiveGroup: (groupId) => calls.unarchiveGroups.push(groupId),
    forkSession: () => {},
    retryLoad: () => {},
    actions: { openSession: () => {} },
    commitOptimistic: () => {
      calls.commits += 1
      return Promise.resolve({ ok: true })
    },
  }
  installClientRuntime({ ...runtime, ...overrides })
  return calls
}

const menuHandlers = (calls, overrides = {}) =>
  createMenuHandlers({
    t,
    dragRef: { current: null },
    consumeDragClick: () => false,
    handleWidthReset: () => {
      calls.dispatch.push(['width-reset'])
    },
    selectSearchResult: () => {},
    ...overrides,
  })

const dialogHandlers = (calls) => createDialogHandlers({ store: { doc: makeDoc() }, t, byId: {}, workspaceItems: [], currentId: null })

test('menu handlers dispatch navigation, archive filter and reset actions through the runtime bridge', () => {
  const calls = installRuntime()
  const menu = menuHandlers(calls)
  menu.toggleGroup('g1')
  menu.setArchiveFilter('only')
  menu.resetLayout()
  menu.searchArchived()
  menu.retryLoad()
  assert.deepEqual(calls.dispatch[0], ['toggle-group', { id: 'g1' }])
  assert.deepEqual(calls.dispatch[1], ['archive-filter', { filter: 'only' }])
  assert.equal(calls.dispatch[2][0], 'width-reset')
  assert.equal(calls.resetLayout, 1)
  assert.equal(calls.notify[0].message, 'search.archivedDisabled')
})

test('group archive filter dispatches only its own action key', () => {
  const calls = installRuntime()
  const menu = menuHandlers(calls)
  menu.setGroupArchiveFilter('only')
  assert.deepEqual(calls.dispatch, [['group-archive-filter', { filter: 'only' }]])
  menu.setArchiveFilter('all')
  assert.deepEqual(calls.dispatch, [
    ['group-archive-filter', { filter: 'only' }],
    ['archive-filter', { filter: 'all' }],
  ])
  assert.equal(calls.dispatch.filter(([action]) => action === 'archive-filter').length, 1)
  assert.equal(calls.dispatch.filter(([action]) => action === 'group-archive-filter').length, 1)
})

test('group click is consumed after a drag and open-close menu handlers use the latest snapshot', () => {
  const calls = installRuntime()
  const menu = menuHandlers(calls, { consumeDragClick: () => true })
  menu.onGroupClick('g1')
  assert.deepEqual(calls.dispatch, [])
  const open = menuHandlers(calls)
  open.closeMenu()
  assert.deepEqual(calls.dispatch.at(-1), ['menu', { menu: null }])
})

test('menu anchors set session and group menu state; context menus respect dragRef', () => {
  globalThis.innerWidth = 1280
  globalThis.innerHeight = 800
  const calls = installRuntime()
  const menu = menuHandlers(calls)
  const event = { preventDefault: () => {}, stopPropagation: () => {}, clientX: 30, clientY: 40 }
  menu.openGroupMenu(event, { id: 'g2' })
  assert.equal(calls.dispatch.at(-1)[0], 'menu')
  assert.equal(calls.dispatch.at(-1)[1].menu.groupId, 'g2')
  menu.onGroupContextMenu(event, { id: 'g2' })
  assert.equal(calls.dispatch.at(-1)[1].menu.groupId, 'g2')
  const blocked = menuHandlers(calls, { dragRef: { current: { kind: 'group' } } })
  const before = calls.dispatch.length
  blocked.onGroupContextMenu(event, { id: 'g2' })
  assert.equal(calls.dispatch.length, before)
})

test('group dialog handlers open the expected dialog kinds and empty leaf deletion is direct', () => {
  const calls = installRuntime()
  const dialog = dialogHandlers(calls)
  dialog.openNewGroup(undefined, null)
  dialog.openRenameGroup('g1')
  dialog.openIconGroup('g1')
  dialog.openGroupColor('g1')
  dialog.openMoveGroup('g1')
  dialog.openDeleteGroup('g2')
  dialog.openDeleteGroup('g1')
  assert.deepEqual(calls.dialog.map((entry) => entry.kind), [
    'new-group',
    'rename-group',
    'icon',
    'group-color',
    'move-group',
    'delete-group',
  ])
  assert.deepEqual(calls.deleteGroupDirect, ['g2'])
  assert.equal(calls.dialog.at(-1).groupId, 'g1')
  assert.equal(calls.dialog.at(-1).sessionCount, 1)
})

test('session dialog commands forward archive/fork/copy and rename payloads', () => {
  const calls = installRuntime()
  const dialog = dialogHandlers(calls)
  dialog.openRenameSession('s1', 'stale title')
  dialog.openMoveSession('s1')
  dialog.archiveSession('s1')
  dialog.unarchiveSession('s1')
  dialog.forkSession('s1')
  dialog.copySessionId('s1')
  assert.equal(calls.dialog[0].kind, 'rename-session')
  assert.equal(calls.dialog[0].value, 'stale title')
  assert.equal(calls.dialog[1].kind, 'move-session')
  assert.deepEqual(calls.archive, ['s1'])
  assert.deepEqual(calls.copy, ['s1'])
})

test('session menu anchors cover row/session context and session commands', () => {
  globalThis.innerWidth = 1280
  globalThis.innerHeight = 800
  const calls = installRuntime()
  const menu = menuHandlers(calls)
  const event = { preventDefault: () => {}, stopPropagation: () => {}, clientX: 30, clientY: 40 }
  const sessionNode = { session: { id: 's1', title: 'Session one' }, archived: false, sessionId: 's1' }
  menu.openSessionMenu(event, sessionNode)
  assert.equal(calls.dispatch.at(-1)[1].menu.sessionId, 's1')
  menu.openSessionMenuAtRow({ getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 30 }) }, sessionNode)
  assert.equal(calls.dispatch.at(-1)[1].menu.sessionId, 's1')
  menu.onSessionContextMenu(event, sessionNode)
  assert.equal(calls.dispatch.at(-1)[1].menu.sessionId, 's1')
  menu.openGroupMenuAtRow({ getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 30 }) }, { id: 'g1' })
  assert.equal(calls.dispatch.at(-1)[1].menu.groupId, 'g1')
  menu.openSession('s1')
  menu.onGroupClick('g1')
  assert.ok(calls.dispatch.some(([action]) => action === 'toggle-group'))
})

test('move steps execute the updater and swallow errors without a crash', async () => {
  const calls = installRuntime({ commitOptimistic: (updater) => Promise.resolve().then(() => updater(makeDoc())) })
  const dialog = dialogHandlers(calls)
  dialog.moveGroupStep('g1', 1)
  dialog.moveSessionStep('s1', 1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.notify.length, 0)
  const rejected = installRuntime({ commitOptimistic: () => Promise.reject(new Error('nope')) })
  const dialog2 = dialogHandlers(rejected)
  dialog2.moveGroupStep('g1', 1)
  dialog2.moveSessionStep('s1', 1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(rejected.notify.length, 0)
})

test('new session without a workspace emits the localized error toast', () => {
  const calls = installRuntime()
  const dialog = dialogHandlers(calls)
  dialog.openNewSession(undefined, 'g1')
  assert.equal(calls.notify.at(-1).kind, 'error')
  assert.equal(calls.notify.at(-1).message, 'dialog.noWorkspace')
})

test('new session uses the inferred workspace and does not open a dialog', () => {
  const calls = installRuntime()
  const dialog = createDialogHandlers({
    store: { doc: makeDoc() },
    t,
    byId: {},
    workspaceItems: [{ workspaceId: 'w1', title: 'Workspace one' }],
    currentId: null,
  })
  dialog.openNewSession(undefined, 'g1')
  assert.deepEqual(calls.newSessions, [['g1', 'w1']])
  assert.deepEqual(calls.dialog, [])
})

test('dialog move steps reject a no-op task without surfacing an error', async () => {
  const calls = installRuntime({ commitOptimistic: () => Promise.resolve({ ok: true }) })
  const dialog = dialogHandlers(calls)
  dialog.moveGroupStep('g1', 1)
  dialog.moveSessionStep('s1', 1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.notify.length, 0)
})

// ---------------------------------------------------------------------------
// 0.4.0-beta.62 archive freeze: menu meta + disabled policy (P8)
// ---------------------------------------------------------------------------
test('0.4.0-beta.62 menu state carries the archive structure meta', () => {
  globalThis.innerWidth = 1280
  globalThis.innerHeight = 800
  const calls = installRuntime()
  const menu = menuHandlers(calls)
  const event = { preventDefault: () => {}, stopPropagation: () => {}, clientX: 30, clientY: 40 }
  const row = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 30 }) }
  menu.openGroupMenu(event, { id: 'g2' }, { archived: true, containsArchived: false })
  assert.equal(calls.dispatch.at(-1)[1].menu.archived, true)
  assert.equal(calls.dispatch.at(-1)[1].menu.containsArchived, false)
  menu.openGroupMenuAtRow(row, { id: 'g2' }, { archived: false, containsArchived: true })
  assert.equal(calls.dispatch.at(-1)[1].menu.archived, false)
  assert.equal(calls.dispatch.at(-1)[1].menu.containsArchived, true)
  menu.onGroupContextMenu(event, { id: 'g2' }, { archived: true, containsArchived: true })
  assert.equal(calls.dispatch.at(-1)[1].menu.archived, true)
  assert.equal(calls.dispatch.at(-1)[1].menu.containsArchived, true)

  const sessionNode = { session: { id: 's1', title: 'Session one', blank: false }, archived: false }
  menu.openSessionMenu(event, sessionNode, true)
  assert.equal(calls.dispatch.at(-1)[1].menu.structuralLocked, true)
  menu.openSessionMenuAtRow(row, sessionNode, true)
  assert.equal(calls.dispatch.at(-1)[1].menu.structuralLocked, true)
  menu.onSessionContextMenu(event, sessionNode, true)
  assert.equal(calls.dispatch.at(-1)[1].menu.structuralLocked, true)
  menu.openSessionMenu(event, sessionNode)
  assert.equal(calls.dispatch.at(-1)[1].menu.structuralLocked, false, 'ungrouped/legacy callers stay unlocked')
})

test('0.4.0-beta.62 menu lock policy keeps the archive toggle and legal edits available', () => {
  const archived = { kind: 'group', groupId: 'g1', archived: true, containsArchived: false }
  for (const action of ['new-session', 'new-subgroup', 'rename', 'icon', 'color', 'move', 'move-up', 'move-down', 'delete']) {
    assert.equal(groupMenuLockReason(archived, action), 'menu.groupArchivedLocked', action)
  }
  // The only always-available group operation is the archive toggle (P9 adds the
  // entry; the policy already reserves it).
  for (const action of ['archive', 'unarchive']) assert.equal(groupMenuLockReason(archived, action), null, action)

  const contains = { kind: 'group', groupId: 'g1', archived: false, containsArchived: true }
  for (const action of ['move', 'move-up', 'move-down', 'delete']) {
    assert.equal(groupMenuLockReason(contains, action), 'menu.groupContainsArchivedLocked', action)
  }
  // Ancestor metadata and pathOnly content creation stay legal (SPEC §5.3/§6.2;
  // the invisible-result toast is P9).
  for (const action of ['new-session', 'new-subgroup', 'rename', 'icon', 'color']) {
    assert.equal(groupMenuLockReason(contains, action), null, action)
  }
  assert.equal(groupMenuLockReason({ kind: 'group', groupId: 'g1' }, 'rename'), null)
  assert.equal(groupMenuLockReason({ kind: 'session' }, 'rename'), null)
  assert.equal(groupMenuLockReason(null, 'rename'), null)

  const locked = { kind: 'session', sessionId: 's1', structuralLocked: true }
  for (const action of ['move', 'fork', 'move-up', 'move-down']) {
    assert.equal(sessionMenuLockReason(locked, action), 'menu.sessionStructuralLocked', action)
  }
  for (const action of ['rename', 'archive', 'unarchive', 'copy-id']) {
    assert.equal(sessionMenuLockReason(locked, action), null, action)
  }
  assert.equal(sessionMenuLockReason({ kind: 'session', sessionId: 's1' }, 'move'), null)
  assert.equal(sessionMenuLockReason({ kind: 'session', sessionId: 's1', structuralLocked: false }, 'fork'), null)
  assert.equal(sessionMenuLockReason({ kind: 'group', groupId: 'g1' }, 'move'), null)
})

// ---------------------------------------------------------------------------
// 0.4.0-beta.62 §5.5/§8: group archive actions, menu state and move prechecks (P9)
// ---------------------------------------------------------------------------

test('0.4.0-beta.62 group archive handlers forward to the host bridge', () => {
  const calls = installRuntime()
  const dialog = dialogHandlers(calls)
  dialog.archiveGroup('g1')
  dialog.unarchiveGroup('g2')
  assert.deepEqual(calls.archiveGroups, ['g1'])
  assert.deepEqual(calls.unarchiveGroups, ['g2'])
})

test('0.4.0-beta.62 group menu state exposes own vs effective archive flags', () => {
  let doc = {
    version: 1,
    groups: [
      { id: 'd', name: 'D', parentId: null, sessionIds: [], archived: true },
      { id: 'c', name: 'C', parentId: 'd', sessionIds: [] },
      { id: 'a', name: 'A', parentId: null, sessionIds: [] },
    ],
    ungrouped: [],
  }
  assert.deepEqual(groupArchiveMenuState(doc, 'd'), { ownArchived: true, effectiveArchived: true })
  // Inherited freeze: own=false, so the menu still offers "archive this group".
  assert.deepEqual(groupArchiveMenuState(doc, 'c'), { ownArchived: false, effectiveArchived: true })
  assert.deepEqual(groupArchiveMenuState(doc, 'a'), { ownArchived: false, effectiveArchived: false })
  assert.deepEqual(groupArchiveMenuState(doc, 'missing'), { ownArchived: false, effectiveArchived: false })
  doc = setGroupArchived(doc, 'a', true)
  assert.deepEqual(groupArchiveMenuState(doc, 'a'), { ownArchived: true, effectiveArchived: true })
})

test('0.4.0-beta.62 moveGroupStep prechecks the frozen anchor and never writes a blocked step', async () => {
  const doc = {
    version: 1,
    groups: [
      { id: 'a', name: 'A', parentId: null, sessionIds: [] },
      { id: 'f', name: 'F', parentId: null, sessionIds: [], archived: true },
      { id: 'c', name: 'C', parentId: null, sessionIds: [] },
    ],
    ungrouped: [],
  }
  assert.equal(groupMoveStepReasonKey(doc, 'a', 1), 'menu.groupArchivedLocked', 'live move over a frozen sibling is locked')
  assert.equal(groupMoveStepReasonKey(doc, 'a', -1), null, 'boundary no-op keeps the native disabled presentation')
  assert.equal(groupMoveStepReasonKey(doc, 'f', 1), 'menu.groupArchivedLocked', 'archived group steps stay locked by the P8 policy')

  const calls = installRuntime()
  const dialog = createDialogHandlers({ store: { doc }, t, byId: {}, workspaceItems: [], currentId: null })
  dialog.moveGroupStep('a', 1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.commits, 0, 'a blocked step queues no optimistic write')
  assert.deepEqual(calls.notify, [{ kind: 'info', message: 'menu.groupArchivedLocked' }])

  const freeDoc = makeDoc()
  const freeCalls = installRuntime()
  const freeDialog = createDialogHandlers({ store: { doc: freeDoc }, t, byId: {}, workspaceItems: [], currentId: null })
  freeDialog.moveGroupStep('g1', 1)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(freeCalls.commits, 1, 'a legal step still commits')
  assert.deepEqual(freeCalls.notify, [])
})

test('0.4.0-beta.62 delete entry is guarded for archived groups and frozen anchors', () => {
  const archDoc = {
    version: 1,
    groups: [{ id: 'd', name: 'D', parentId: null, sessionIds: [], archived: true }],
    ungrouped: [],
  }
  const calls = installRuntime()
  const dialog = createDialogHandlers({ store: { doc: archDoc }, t, byId: {}, workspaceItems: [], currentId: null })
  dialog.openDeleteGroup('d')
  assert.deepEqual(calls.dialog, [])
  assert.deepEqual(calls.deleteGroupDirect, [])
  assert.deepEqual(calls.notify, [{ kind: 'info', message: 'menu.groupArchivedLocked' }])

  // Root [G(session), Z(archived)]: deleting G would shift Z, so the action is
  // refused with the structured reason instead of opening an unusable dialog.
  const shiftDoc = {
    version: 1,
    groups: [
      { id: 'g', name: 'G', parentId: null, sessionIds: ['s1'] },
      { id: 'z', name: 'Z', parentId: null, sessionIds: [], archived: true },
    ],
    ungrouped: [],
  }
  const shiftCalls = installRuntime()
  const shiftDialog = createDialogHandlers({ store: { doc: shiftDoc }, t, byId: {}, workspaceItems: [], currentId: null })
  shiftDialog.openDeleteGroup('g')
  assert.deepEqual(shiftCalls.dialog, [])
  assert.deepEqual(shiftCalls.deleteGroupDirect, [])
  assert.equal(shiftCalls.notify.length, 1)
  assert.equal(shiftCalls.notify[0].message, 'menu.groupPositionLocked')

  // The menu item uses the same precheck reason (P8 policy + N5).
  assert.equal(deleteGroupActionReasonKey(archDoc, 'd'), 'menu.groupArchivedLocked')
  assert.equal(deleteGroupActionReasonKey(shiftDoc, 'g'), 'menu.groupPositionLocked')
  assert.equal(deleteGroupActionReasonKey(makeDoc(), 'g1'), null)
})



