// tests/client/plugin-host-commands.test.js
//
// 0.4.0-beta.65 S2/S2b: the host command layer is a plain module — no DSH/react
// imports — so its factory surface, capability probe, archive/session actions,
// dialog confirms and follow guard can be exercised under node:test with fake
// dependencies only. S2b extends the S2 contract tests to the command paths that
// the split moved into `plugin-host-commands.js` (coverage denominator change).

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createHostCommands } from '../../src/client/plugin-host-commands.js'
import { ARCHIVE_CONFIRM_SKIP_KEY } from '../../src/client/state/persistence.js'

// --- fixtures -------------------------------------------------------------

const group = (overrides = {}) => ({
  id: 'g1',
  name: 'Group',
  icon: 'folder',
  color: 'blue',
  parentId: null,
  sessionIds: [],
  ...overrides,
})

/** Group document with one direct-session group unless a test needs another shape. */
const makeDoc = ({ groups = [group({ sessionIds: ['s1'] })], ungrouped = [] } = {}) => ({
  version: 1,
  revision: 0,
  groups,
  ungrouped,
})

const makeStore = (doc, overrides = {}) => {
  const listeners = []
  const calls = []
  const snapshot = {
    doc,
    viewMode: 'groups',
    menu: null,
    dialog: null,
    archiveFilter: 'all',
    groupArchiveFilter: 'hidden',
    ...overrides,
  }
  return {
    calls,
    listeners,
    snapshot,
    getSnapshot: () => snapshot,
    dispatch: (type, payload) => calls.push({ type, payload }),
    subscribe: (listener) => {
      listeners.push(listener)
      let subscribed = true
      return () => {
        // Idempotent and listener-scoped: a repeated dispose must not splice
        // (and therefore silently remove) another subscriber.
        if (!subscribed) return
        subscribed = false
        const index = listeners.indexOf(listener)
        if (index !== -1) listeners.splice(index, 1)
      }
    },
  }
}

const makeDocumentSync = (store) => {
  const calls = []
  const publish = (kind) => async (updater) => {
    calls.push([kind])
    const current = store.getSnapshot().doc
    const next = typeof updater === 'function' ? updater(current) : updater
    store.snapshot.doc = next
    return next
  }
  return {
    calls,
    commitDoc: publish('commitDoc'),
    commitOptimistic: publish('commitOptimistic'),
    refresh: (options) => calls.push(['refresh', options]),
    onStorePublish: () => {},
    load: () => {},
    dispose: () => {},
  }
}

/**
 * Build the command layer over fakes. `sync.commitDoc` / `sync.commitOptimistic`
 * replace the default document publish without hiding the call log.
 */
const makeCommands = ({
  doc = makeDoc(),
  overrides = {},
  services = () => ({}),
  clipboard = async () => true,
  sync = {},
} = {}) => {
  const store = makeStore(doc, overrides)
  const documentSync = makeDocumentSync(store)
  if (typeof sync.commitDoc === 'function') {
    documentSync.commitDoc = async (updater) => {
      documentSync.calls.push(['commitDoc'])
      return sync.commitDoc(updater, store)
    }
  }
  if (typeof sync.commitOptimistic === 'function') {
    documentSync.commitOptimistic = async (updater) => {
      documentSync.calls.push(['commitOptimistic'])
      return sync.commitOptimistic(updater, store)
    }
  }
  const notify = []
  const dialogs = []
  const closed = []
  const failures = []
  const commands = createHostCommands({
    store,
    t: (key) => key,
    documentSync,
    notify: (toast) => notify.push(toast),
    services,
    failDialog: (key) => failures.push(key),
    clipboard,
    getCurrentSessionId: () => null,
    openDialog: (dialog) => dialogs.push(dialog),
    closeDialog: () => closed.push(true),
  })
  return { commands, store, documentSync, notify, dialogs, closed, failures }
}

/** Fake host session service: explicit controller create + snapshot + retain. */
const makeSessions = ({ createId = 'blank-a', byId = {}, workspaces = [] } = {}) => {
  const calls = { created: [], retained: [] }
  const services = () => ({
    sessions: {
      create: async (request) => {
        calls.created.push(request)
        return createId
      },
      list: { getSnapshot: () => ({ ids: Object.keys(byId), byId }) },
      retain: (id, options) => calls.retained.push([id, options]),
    },
    workspaces: { list: { getSnapshot: () => ({ items: workspaces }) } },
    uiWorkspace: { startSession: () => {} },
  })
  return { services, calls }
}

/**
 * Install an explicit localStorage stub for one test (safeStorage reads the
 * global), returning the writes and always restoring the previous property.
 */
const withLocalStorage = async (initial, run) => {
  const values = new Map(Object.entries(initial))
  const writes = []
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => {
        writes.push([key, String(value)])
        values.set(key, String(value))
      },
    },
  })
  try {
    return await run({ writes, values })
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }
}

/** Capture `console.warn` so expected failure-path logs stay out of test output. */
const captureWarnings = async (run) => {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args)
  try {
    await run(warnings)
  } finally {
    console.warn = original
  }
  return warnings
}

const messages = (notify) => notify.map((toast) => `${toast.kind}:${toast.message}`)
const commitKinds = (documentSync) => documentSync.calls.map(([kind]) => kind)
const structuredError = (code, reason) =>
  Object.assign(new Error(code), reason === undefined ? { code } : { code, reason })

// --- factory surface and capabilities ------------------------------------

test('0.4.0-beta.65 createHostCommands exposes the 17 documented keys', () => {
  const { commands } = makeCommands()
  assert.deepEqual(Object.keys(commands), [
    'actions',
    'capabilities',
    'archiveSession',
    'unarchiveSession',
    'forkSession',
    'copySessionId',
    'archiveGroup',
    'unarchiveGroup',
    'newSessionInGroup',
    'reconcileNewSessionGroup',
    'confirmDialog',
    'deleteGroupDirect',
    'setArchiveFilter',
    'setGroupArchiveFilter',
    'applyEpoch',
    'installFollowGuard',
    'clearPendingFollow',
  ])
})

test('0.4.0-beta.65 capabilities probe mirrors the injected host services', () => {
  const { commands } = makeCommands()
  const empty = commands.capabilities()
  // `fork` is a predicate in the host contract; the other three are booleans.
  assert.equal(empty.fork('s1'), false)
  assert.deepEqual(
    { ...empty, fork: empty.fork('s1') },
    { fork: false, archive: false, unarchive: false, connect: false }
  )

  const sourceCalls = []
  let throwOnSource = false
  const hosted = makeCommands({
    services: () => ({
      uiWorkspace: {
        forkSession() {},
        archiveSession() {},
        unarchiveSession() {},
        connectWorkspace() {},
      },
      remoteAccess: {
        source: (...args) => {
          sourceCalls.push(args)
          if (throwOnSource) throw new Error('source-unavailable')
          return 'session/…'
        },
      },
    }),
  })
  const capabilities = hosted.commands.capabilities()
  assert.equal(capabilities.fork('s1'), true)
  assert.deepEqual(sourceCalls, [['session', 's1', 'session/fork']])
  assert.deepEqual(
    { ...capabilities, fork: capabilities.fork('s1') },
    { fork: true, archive: true, unarchive: true, connect: true }
  )
  // A host probe that throws degrades to "no fork" instead of breaking the menu.
  throwOnSource = true
  assert.equal(capabilities.fork('s2'), false)
})

test('0.4.0-beta.65 archive filter dispatches the shared view action', () => {
  const { commands, store } = makeCommands()
  commands.setArchiveFilter('all')
  assert.deepEqual(store.calls, [{ type: 'archive-filter', payload: { filter: 'all' } }])
  commands.setGroupArchiveFilter('only')
  assert.deepEqual(store.calls.at(-1), { type: 'group-archive-filter', payload: { filter: 'only' } })
})

// --- group archive commands ----------------------------------------------

test('0.4.0-beta.65 archiveGroup opens the confirm boundary before a group with sessions', async () => {
  await withLocalStorage({}, async (storage) => {
    const { commands, documentSync, notify, dialogs, store, closed } = makeCommands()
    const result = await commands.archiveGroup('g1')
    assert.equal(result, false)
    assert.deepEqual(dialogs, [
      { kind: 'archive-group', groupId: 'g1', archived: true, titleKey: 'dialog.archiveGroup' },
    ])
    // The commands never add the shell-owned x/y anchor and never commit early.
    assert.equal('x' in dialogs[0], false)
    assert.equal('y' in dialogs[0], false)
    assert.deepEqual(documentSync.calls, [])
    assert.deepEqual(store.calls, [])
    assert.deepEqual(notify, [])
    assert.deepEqual(closed, [])
    // A missing opt-out reads as `false` and must not be written by the read path.
    assert.deepEqual(storage.writes, [])
  })
})

test('0.4.0-beta.65 archiveGroup ignores missing and already archived groups', async () => {
  await withLocalStorage({}, async () => {
    const missing = makeCommands({ doc: makeDoc({ groups: [] }) })
    assert.equal(await missing.commands.archiveGroup('g1'), false)
    assert.deepEqual(missing.dialogs, [])
    assert.deepEqual(missing.documentSync.calls, [])
    assert.deepEqual(missing.notify, [])

    const archived = makeCommands({
      doc: makeDoc({ groups: [group({ archived: true, sessionIds: ['s1'] })] }),
    })
    assert.equal(await archived.commands.archiveGroup('g1'), false)
    assert.deepEqual(archived.dialogs, [])
    assert.deepEqual(archived.documentSync.calls, [])
    assert.deepEqual(archived.notify, [])
  })
})

test('0.4.0-beta.65 archiveGroup commits an empty leaf directly and toasts the visible result', async () => {
  await withLocalStorage({}, async () => {
    const { commands, documentSync, notify, store, closed } = makeCommands({
      doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
      overrides: { groupArchiveFilter: 'all' },
    })
    assert.equal(await commands.archiveGroup('g1'), true)
    assert.deepEqual(documentSync.calls, [['commitDoc']])
    assert.equal(store.snapshot.doc.groups[0].archived, true)
    assert.deepEqual(notify, [{ kind: 'success', message: 'toast.groupArchived' }])
    assert.deepEqual(closed, [])
  })
})

test('0.4.0-beta.65 archiveGroup honours the persisted confirmation opt-out', async () => {
  await withLocalStorage({ [ARCHIVE_CONFIRM_SKIP_KEY]: 'true' }, async (storage) => {
    const { commands, documentSync, notify, store } = makeCommands()
    assert.equal(await commands.archiveGroup('g1'), true)
    assert.equal(store.snapshot.doc.groups[0].archived, true)
    assert.deepEqual(documentSync.calls, [['commitDoc']])
    assert.equal(notify.length, 1)
    const [toast] = notify
    assert.equal(toast.kind, 'success')
    assert.equal(toast.message, 'toast.groupArchivedHidden')
    assert.equal(toast.action.label, 'toast.showArchivedGroups')
    toast.action.onClick()
    assert.deepEqual(store.calls, [{ type: 'group-archive-filter', payload: { filter: 'all' } }])
    // The opt-out path only reads the persisted flag.
    assert.deepEqual(storage.writes, [])
  })
})

test('0.4.0-beta.65 archiveGroup toasts and refreshes when the strict commit fails', async () => {
  await withLocalStorage({}, async () => {
    const { commands, documentSync, notify } = makeCommands({
      doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
      sync: {
        commitDoc: async () => {
          // `archive-frozen` + a known reason refines the inline copy and asks
          // for one forced re-read of the stale document.
          throw structuredError('archive-frozen', 'group-archived')
        },
      },
    })
    assert.equal(await commands.archiveGroup('g1'), false)
    assert.deepEqual(documentSync.calls, [['commitDoc'], ['refresh', { force: true }]])
    assert.deepEqual(notify, [{ kind: 'error', message: 'dialog.groupArchived' }])
  })
})

test('0.4.0-beta.65 archiveGroup reports a post-commit archive conflict', async () => {
  await withLocalStorage({}, async () => {
    const { commands, documentSync, notify } = makeCommands({
      doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
      // The strict queue adopts a CAS conflict as `result.doc`: same shape as
      // success but the group still carries the old flag.
      sync: { commitDoc: async (updater, store) => store.getSnapshot().doc },
    })
    assert.equal(await commands.archiveGroup('g1'), false)
    assert.deepEqual(documentSync.calls, [['commitDoc'], ['refresh', { force: true }]])
    assert.deepEqual(notify, [{ kind: 'error', message: 'toast.archiveFailed' }])
  })
})

test('0.4.0-beta.65 unarchiveGroup announces visible and hidden-filter results', async () => {
  const visible = makeCommands({ doc: makeDoc({ groups: [group({ archived: true })] }) })
  assert.equal(await visible.commands.unarchiveGroup('g1'), true)
  assert.equal(visible.store.snapshot.doc.groups[0].archived, false)
  assert.deepEqual(visible.notify, [{ kind: 'success', message: 'toast.groupUnarchived' }])
  // Unknown and already-unarchived groups are no-ops.
  assert.equal(await visible.commands.unarchiveGroup('missing'), false)
  assert.equal(await visible.commands.unarchiveGroup('g1'), false)
  assert.deepEqual(visible.documentSync.calls, [['commitDoc']])

  // `only` shows archived groups: a successful unarchive disappears from view
  // and the toast offers the explicit "show all" switch.
  const hidden = makeCommands({
    doc: makeDoc({ groups: [group({ archived: true })] }),
    overrides: { groupArchiveFilter: 'only' },
  })
  assert.equal(await hidden.commands.unarchiveGroup('g1'), true)
  const [toast] = hidden.notify
  assert.equal(toast.kind, 'success')
  assert.equal(toast.message, 'toast.groupUnarchivedHidden')
  assert.equal(toast.action.label, 'toast.showAllGroups')
  assert.equal(typeof toast.action.onClick, 'function')
})

test('0.4.0-beta.65 unarchiveGroup toasts and refreshes when the strict commit fails', async () => {
  const { commands, documentSync, notify } = makeCommands({
    doc: makeDoc({ groups: [group({ archived: true })] }),
    sync: {
      commitDoc: async () => {
        throw structuredError('archive-frozen', 'group-archived')
      },
    },
  })
  assert.equal(await commands.unarchiveGroup('g1'), false)
  assert.deepEqual(documentSync.calls, [['commitDoc'], ['refresh', { force: true }]])
  assert.deepEqual(notify, [{ kind: 'error', message: 'dialog.groupArchived' }])
})

// --- group-head new session ----------------------------------------------

test('0.4.0-beta.65 newSessionInGroup creates the session and toasts the placement', async () => {
  const { services, calls } = makeSessions({
    createId: 'new-1',
    byId: { 'new-1': { blank: true } },
    workspaces: [{ workspaceId: 'w1', sessionIds: ['new-1'] }],
  })
  const { commands, documentSync, notify, store } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
    services,
    overrides: { groupArchiveFilter: 'all' },
  })
  const result = await commands.newSessionInGroup('g1', 'w1')
  assert.equal(result.sessionId, 'new-1')
  assert.equal(result.created, true)
  assert.deepEqual(calls.created, [{ workspaceId: 'w1' }])
  assert.deepEqual(calls.retained, [['new-1', { source: 'mainView' }]])
  assert.deepEqual(documentSync.calls, [['commitDoc']])
  assert.deepEqual(store.snapshot.doc.groups[0].sessionIds, ['new-1'])
  assert.deepEqual(notify, [{ kind: 'success', message: 'toast.saved' }])
})

test('0.4.0-beta.65 newSessionInGroup resets an archive-only session filter', async () => {
  const { services } = makeSessions({
    createId: 'new-2',
    byId: { 'new-2': { blank: true } },
  })
  const { commands, notify, store } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
    services,
    overrides: { archiveFilter: 'only' },
  })
  await commands.newSessionInGroup('g1', 'w1')
  assert.deepEqual(store.calls, [{ type: 'archive-filter', payload: { filter: 'all' } }])
  assert.deepEqual(messages(notify), ['info:toast.archivedFilterChanged', 'success:toast.saved'])
})

test('0.4.0-beta.65 newSessionInGroup offers the switch when the group filter hides the session', async () => {
  const { services } = makeSessions({
    createId: 'new-3',
    byId: { 'new-3': { blank: true } },
  })
  const { commands, notify, store } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
    services,
    overrides: { groupArchiveFilter: 'only' },
  })
  await commands.newSessionInGroup('g1', 'w1')
  assert.deepEqual(messages(notify), ['info:toast.createdInvisible'])
  const [toast] = notify
  assert.equal(toast.action.label, 'toast.showAllGroups')
  toast.action.onClick()
  assert.deepEqual(store.calls, [{ type: 'group-archive-filter', payload: { filter: 'all' } }])
})

test('0.4.0-beta.65 newSessionInGroup guards missing and archived groups before creating', async () => {
  const readingServices = () => {
    throw new Error('services must not be read')
  }
  const missing = makeCommands({ doc: makeDoc({ groups: [] }), services: readingServices })
  assert.equal(await missing.commands.newSessionInGroup('g1', 'w1'), null)
  assert.deepEqual(missing.notify, [{ kind: 'error', message: 'dialog.createFailed' }])
  assert.deepEqual(missing.documentSync.calls, [])

  const archived = makeCommands({
    doc: makeDoc({ groups: [group({ archived: true })] }),
    services: readingServices,
  })
  assert.equal(await archived.commands.newSessionInGroup('g1', 'w1'), null)
  assert.deepEqual(archived.notify, [{ kind: 'info', message: 'menu.groupArchivedLocked' }])
  assert.deepEqual(archived.documentSync.calls, [])
})

test('0.4.0-beta.65 newSessionInGroup maps structured and generic create failures', async () => {
  const structured = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
    services: makeSessions({ createId: 'new-4' }).services,
    sync: {
      commitDoc: async () => {
        throw structuredError('group-archived')
      },
    },
  })
  await assert.rejects(() => structured.commands.newSessionInGroup('g1', 'w1'), /group-archived/)
  assert.deepEqual(structured.notify, [{ kind: 'info', message: 'menu.groupArchivedLocked' }])

  const generic = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
    services: makeSessions({ createId: 'new-5' }).services,
    sync: {
      commitDoc: async () => {
        throw new Error('create-failed')
      },
    },
  })
  await assert.rejects(() => generic.commands.newSessionInGroup('g1', 'w1'), /create-failed/)
  assert.deepEqual(generic.notify, [{ kind: 'error', message: 'dialog.createFailed' }])
})

// --- new-session follow reconciliation -----------------------------------

test('0.4.0-beta.65 reconcileNewSessionGroup exits without touching services when no follow is pending', async () => {
  const { commands, documentSync } = makeCommands({
    services: () => {
      throw new Error('services must not be read')
    },
  })
  await commands.reconcileNewSessionGroup('s1')
  await commands.reconcileNewSessionGroup()
  assert.deepEqual(documentSync.calls, [])
})

test('0.4.0-beta.65 reconcileNewSessionGroup moves the replacement blank into the target group', async () => {
  const { services } = makeSessions({
    createId: 'blank-a',
    byId: { 'blank-a': { blank: true }, 'blank-b': { blank: true } },
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['blank-a'] },
      { workspaceId: 'w2', sessionIds: ['blank-b'] },
    ],
  })
  const { commands, documentSync, store } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
    services,
  })
  await commands.newSessionInGroup('g1', 'w1')
  assert.deepEqual(store.snapshot.doc.groups[0].sessionIds, ['blank-a'])

  await commands.reconcileNewSessionGroup('blank-b')
  assert.deepEqual(commitKinds(documentSync), ['commitDoc', 'commitOptimistic'])
  // The replacement is placed at the group head and the abandoned blank is
  // removed from the document in the same optimistic write.
  assert.deepEqual(store.snapshot.doc.groups[0].sessionIds, ['blank-b'])
  assert.deepEqual(store.snapshot.doc.ungrouped, [])
})

test('0.4.0-beta.65 reconcileNewSessionGroup keeps the follow while the tracked blank stays blank', async () => {
  const { services } = makeSessions({
    createId: 'blank-a',
    byId: { 'blank-a': { blank: true }, 'blank-b': { blank: true } },
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['blank-a'] },
      { workspaceId: 'w2', sessionIds: ['blank-b'] },
    ],
  })
  const { commands, documentSync, store } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
    services,
  })
  await commands.newSessionInGroup('g1', 'w1')
  // Same id as the tracked blank: still blank, so the intent stays armed.
  await commands.reconcileNewSessionGroup('blank-a')
  assert.deepEqual(commitKinds(documentSync), ['commitDoc'])
  await commands.reconcileNewSessionGroup('blank-b')
  assert.deepEqual(commitKinds(documentSync), ['commitDoc', 'commitOptimistic'])
  assert.deepEqual(store.snapshot.doc.groups[0].sessionIds, ['blank-b'])
})

test('0.4.0-beta.65 reconcileNewSessionGroup clears the follow when the tracked blank stops being a blank', async () => {
  const { services } = makeSessions({
    createId: 'blank-a',
    byId: { 'blank-a': { blank: false }, 'blank-b': { blank: true } },
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['blank-a'] },
      { workspaceId: 'w2', sessionIds: ['blank-b'] },
    ],
  })
  const { commands, documentSync, store } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
    services,
  })
  await commands.newSessionInGroup('g1', 'w1')
  await commands.reconcileNewSessionGroup('blank-a')
  // The intent is gone: a later replacement must not be moved.
  await commands.reconcileNewSessionGroup('blank-b')
  assert.deepEqual(commitKinds(documentSync), ['commitDoc'])
  assert.deepEqual(store.snapshot.doc.groups[0].sessionIds, ['blank-a'])
})

test('0.4.0-beta.65 reconcileNewSessionGroup only follows a blank from another workspace', async () => {
  const { services } = makeSessions({
    createId: 'blank-a',
    byId: { 'blank-a': { blank: true }, 'same-ws': { blank: true }, normal: { blank: false } },
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['blank-a', 'same-ws'] },
      { workspaceId: 'w2', sessionIds: ['normal'] },
    ],
  })
  const { commands, documentSync, store } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
    services,
  })
  await commands.newSessionInGroup('g1', 'w1')
  // Same-workspace blank: clicking another blank must not steal the group slot.
  await commands.reconcileNewSessionGroup('same-ws')
  assert.deepEqual(commitKinds(documentSync), ['commitDoc'])
  // A non-blank active session ends the whole pre-prompt lifetime.
  await commands.reconcileNewSessionGroup('normal')
  await commands.reconcileNewSessionGroup('blank-a')
  assert.deepEqual(commitKinds(documentSync), ['commitDoc'])
})

test('0.4.0-beta.65 reconcileNewSessionGroup drops the intent when the target group was archived', async () => {
  const { services } = makeSessions({
    createId: 'blank-a',
    byId: { 'blank-a': { blank: true }, 'blank-b': { blank: true } },
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['blank-a'] },
      { workspaceId: 'w2', sessionIds: ['blank-b'] },
    ],
  })
  const { commands, documentSync, store } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
    services,
  })
  await commands.newSessionInGroup('g1', 'w1')
  store.snapshot.doc = makeDoc({ groups: [group({ archived: true, sessionIds: ['blank-a'] })] })
  await commands.reconcileNewSessionGroup('blank-b')
  // No half-move: the blank stays where the host put it and the intent is gone.
  await commands.reconcileNewSessionGroup('blank-b')
  assert.deepEqual(commitKinds(documentSync), ['commitDoc'])
  assert.deepEqual(store.snapshot.doc.groups[0].sessionIds, ['blank-a'])
})

test('0.4.0-beta.65 reconcileNewSessionGroup reports a structured follow failure', async () => {
  const { services } = makeSessions({
    createId: 'blank-a',
    byId: { 'blank-a': { blank: true }, 'blank-b': { blank: true } },
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['blank-a'] },
      { workspaceId: 'w2', sessionIds: ['blank-b'] },
    ],
  })
  const { commands, documentSync, notify } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
    services,
    sync: {
      commitOptimistic: async () => {
        throw structuredError('group-archived')
      },
    },
  })
  await commands.newSessionInGroup('g1', 'w1')
  await captureWarnings(async (warnings) => {
    await commands.reconcileNewSessionGroup('blank-b')
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0][0]), /active session follow failed/)
  })
  assert.deepEqual(messages(notify), ['success:toast.saved', 'info:menu.groupArchivedLocked'])
  assert.deepEqual(commitKinds(documentSync), ['commitDoc', 'commitOptimistic'])
})

// --- follow guard and epoch reset ----------------------------------------

test('0.4.0-beta.65 installFollowGuard disposes idempotently and keeps other subscribers', () => {
  const { commands, store } = makeCommands()
  const dispose = commands.installFollowGuard()
  assert.equal(store.listeners.length, 1)
  // A store publish before any pending intent is a cheap no-op.
  assert.doesNotThrow(() => store.listeners[0]())
  const other = () => {}
  const disposeOther = store.subscribe(other)
  assert.equal(store.listeners.length, 2)
  dispose()
  assert.doesNotThrow(() => dispose())
  // The second call must not splice the *other* listener from the tail.
  assert.deepEqual(store.listeners, [other])
  disposeOther()
  assert.equal(store.listeners.length, 0)
  // Both cleanup entry points are always safe to call.
  assert.doesNotThrow(() => commands.clearPendingFollow())
  assert.doesNotThrow(() => commands.applyEpoch())
})

test('0.4.0-beta.65 installFollowGuard drops the follow when the tracked blank leaves its group', async () => {
  const { services } = makeSessions({
    createId: 'blank-a',
    byId: { 'blank-a': { blank: true }, 'blank-b': { blank: true } },
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['blank-a'] },
      { workspaceId: 'w2', sessionIds: ['blank-b'] },
    ],
  })
  const { commands, documentSync, store } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
    services,
  })
  await commands.newSessionInGroup('g1', 'w1')
  commands.installFollowGuard()
  // Manual move of the tracked blank out of the group invalidates the intent.
  store.snapshot.doc = makeDoc({ groups: [group({ sessionIds: [] })], ungrouped: ['blank-a'] })
  for (const listener of [...store.listeners]) listener()
  await commands.reconcileNewSessionGroup('blank-b')
  assert.deepEqual(commitKinds(documentSync), ['commitDoc'])
})

test('0.4.0-beta.65 installFollowGuard drops the follow when the target group is archived', async () => {
  const { services } = makeSessions({
    createId: 'blank-a',
    byId: { 'blank-a': { blank: true }, 'blank-b': { blank: true } },
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['blank-a'] },
      { workspaceId: 'w2', sessionIds: ['blank-b'] },
    ],
  })
  const { commands, documentSync, store } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
    services,
  })
  await commands.newSessionInGroup('g1', 'w1')
  commands.installFollowGuard()
  // The blank is still in the group, but the group is frozen: never assign.
  store.snapshot.doc = makeDoc({ groups: [group({ archived: true, sessionIds: ['blank-a'] })] })
  for (const listener of [...store.listeners]) listener()
  await commands.reconcileNewSessionGroup('blank-b')
  assert.deepEqual(commitKinds(documentSync), ['commitDoc'])
})

test('0.4.0-beta.65 clearPendingFollow and applyEpoch both disarm a pending follow', async () => {
  const { services } = makeSessions({
    createId: 'blank-a',
    byId: { 'blank-a': { blank: true }, 'blank-b': { blank: true } },
    workspaces: [
      { workspaceId: 'w1', sessionIds: ['blank-a'] },
      { workspaceId: 'w2', sessionIds: ['blank-b'] },
    ],
  })
  const { commands, documentSync } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
    services,
  })
  await commands.newSessionInGroup('g1', 'w1')
  commands.clearPendingFollow()
  await commands.reconcileNewSessionGroup('blank-b')
  assert.deepEqual(commitKinds(documentSync), ['commitDoc'])

  await commands.newSessionInGroup('g1', 'w1')
  commands.applyEpoch()
  await commands.reconcileNewSessionGroup('blank-b')
  assert.deepEqual(commitKinds(documentSync), ['commitDoc', 'commitDoc'])
})

// --- direct group delete --------------------------------------------------

test('0.4.0-beta.65 deleteGroupDirect deletes an empty leaf in one commit', async () => {
  const { commands, documentSync, notify, store, closed, failures } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
  })
  const result = await commands.deleteGroupDirect('g1')
  assert.ok(result)
  assert.deepEqual(store.snapshot.doc.groups, [])
  assert.deepEqual(documentSync.calls, [['commitDoc']])
  assert.deepEqual(notify, [{ kind: 'success', message: 'toast.groupDeleted' }])
  assert.equal(closed.length, 1)
  assert.deepEqual(failures, [])
})

test('0.4.0-beta.65 deleteGroupDirect refuses archived and contains-archived groups', async () => {
  const archived = makeCommands({ doc: makeDoc({ groups: [group({ archived: true })] }) })
  assert.equal(await archived.commands.deleteGroupDirect('g1'), null)
  assert.deepEqual(archived.notify, [{ kind: 'info', message: 'menu.groupArchivedLocked' }])
  assert.deepEqual(archived.documentSync.calls, [])

  const nested = makeCommands({
    doc: makeDoc({
      groups: [
        group({ id: 'p', sessionIds: [] }),
        group({ id: 'child', parentId: 'p', sessionIds: [], archived: true }),
      ],
    }),
  })
  assert.equal(await nested.commands.deleteGroupDirect('p'), null)
  assert.deepEqual(nested.notify, [{ kind: 'info', message: 'menu.groupContainsArchivedLocked' }])
  assert.deepEqual(nested.documentSync.calls, [])
})

test('0.4.0-beta.65 deleteGroupDirect ignores unknown groups and maps commit failures', async () => {
  const unknown = makeCommands({ doc: makeDoc({ groups: [] }) })
  assert.equal(await unknown.commands.deleteGroupDirect('missing'), null)
  assert.deepEqual(unknown.notify, [])

  await captureWarnings(async (warnings) => {
    const failing = makeCommands({
      doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
      sync: {
        commitDoc: async () => {
          throw new Error('disk-failed')
        },
      },
    })
    assert.equal(await failing.commands.deleteGroupDirect('g1'), null)
    assert.deepEqual(failing.notify, [{ kind: 'error', message: 'toast.deleteFailed' }])
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0][0]), /direct delete failed/)
  })
})

// --- dialog confirms ------------------------------------------------------

test('0.4.0-beta.65 confirmDialog new-group commits, closes and toasts', async () => {
  const { commands, documentSync, notify, store, closed, failures } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
  })
  await commands.confirmDialog({ kind: 'new-group' }, { value: '  Fresh  ' })
  assert.equal(store.snapshot.doc.groups.length, 2)
  const created = store.snapshot.doc.groups.find((entry) => entry.name === 'Fresh')
  assert.ok(created)
  assert.equal(created.parentId, null)
  assert.deepEqual(documentSync.calls, [['commitDoc']])
  assert.equal(closed.length, 1)
  assert.deepEqual(notify, [{ kind: 'success', message: 'toast.saved' }])
  assert.deepEqual(failures, [])
})

test('0.4.0-beta.65 confirmDialog new-group rejects a blank name before committing', async () => {
  const { commands, documentSync, closed, failures, notify } = makeCommands()
  await commands.confirmDialog({ kind: 'new-group' }, { value: '   ' })
  assert.deepEqual(failures, ['name-required'])
  assert.deepEqual(documentSync.calls, [])
  assert.deepEqual(closed, [])
  assert.deepEqual(notify, [])
})

test('0.4.0-beta.65 confirmDialog new-group offers the switch when the new group is invisible', async () => {
  const { commands, notify, store, closed } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })] }),
    overrides: { groupArchiveFilter: 'only' },
  })
  await commands.confirmDialog({ kind: 'new-group' }, { value: 'Fresh' })
  assert.equal(closed.length, 1)
  assert.deepEqual(messages(notify), ['info:toast.createdInvisible'])
  const [toast] = notify
  assert.equal(toast.action.label, 'toast.showAllGroups')
  toast.action.onClick()
  assert.deepEqual(store.calls, [{ type: 'group-archive-filter', payload: { filter: 'all' } }])
})

test('0.4.0-beta.65 confirmDialog new-group maps a generic commit failure inline', async () => {
  await captureWarnings(async (warnings) => {
    const { commands, documentSync, notify, closed, failures } = makeCommands({
      sync: {
        commitDoc: async () => {
          throw new Error('disk-failed')
        },
      },
    })
    await commands.confirmDialog({ kind: 'new-group' }, { value: 'Fresh' })
    assert.deepEqual(failures, ['commit-failed'])
    assert.deepEqual(closed, [])
    assert.deepEqual(notify, [])
    assert.deepEqual(documentSync.calls, [['commitDoc']])
    assert.equal(warnings.length, 1)
    assert.match(String(warnings[0][0]), /dialog action failed/)
  })
})

test('0.4.0-beta.65 confirmDialog rename-group commits the trimmed name', async () => {
  const { commands, notify, store, closed, failures } = makeCommands()
  await commands.confirmDialog({ kind: 'rename-group', groupId: 'g1' }, { value: '  Renamed  ' })
  assert.equal(store.snapshot.doc.groups[0].name, 'Renamed')
  assert.equal(closed.length, 1)
  assert.deepEqual(notify, [{ kind: 'success', message: 'toast.saved' }])
  assert.deepEqual(failures, [])
})

test('0.4.0-beta.65 confirmDialog rename-group rejects a blank name', async () => {
  const { commands, documentSync, closed, failures } = makeCommands()
  await commands.confirmDialog({ kind: 'rename-group', groupId: 'g1' }, { value: '' })
  assert.deepEqual(failures, ['name-required'])
  assert.deepEqual(documentSync.calls, [])
  assert.deepEqual(closed, [])
})

test('0.4.0-beta.65 confirmDialog rename-group reports an archived target inline', async () => {
  await captureWarnings(async (warnings) => {
    const { commands, documentSync, notify, closed, failures } = makeCommands({
      doc: makeDoc({ groups: [group({ archived: true })] }),
    })
    await commands.confirmDialog({ kind: 'rename-group', groupId: 'g1' }, { value: 'Renamed' })
    // The model invariant rejects the frozen rename; the dialog keeps its inline
    // archive copy instead of falling back to the generic commit failure.
    assert.deepEqual(failures, ['dialog.groupArchived'])
    assert.deepEqual(closed, [])
    assert.deepEqual(notify, [])
    assert.deepEqual(documentSync.calls, [['commitDoc']])
    assert.equal(warnings.length, 1)
  })
})

test('0.4.0-beta.65 confirmDialog rename-session renames through the host session service', async () => {
  const renames = []
  const { commands, notify, closed, failures } = makeCommands({
    services: () => ({
      sessions: {
        using: async (id, options, run) =>
          run({
            binding: {
              session: {
                rename: async (title) => {
                  renames.push({ id, title, source: options.source })
                  return { ok: true }
                },
              },
            },
          }),
      },
    }),
  })
  await commands.confirmDialog({ kind: 'rename-session', sessionId: 's1' }, { value: '  Titled  ' })
  assert.deepEqual(renames, [{ id: 's1', title: 'Titled', source: 'workspaceOperation' }])
  assert.equal(closed.length, 1)
  assert.deepEqual(notify, [{ kind: 'success', message: 'toast.saved' }])
  assert.deepEqual(failures, [])
})

test('0.4.0-beta.65 confirmDialog rename-session rejects blank input and reports host failures', async () => {
  const unusedServices = () => {
    throw new Error('services must not be read')
  }
  const blank = makeCommands({ services: unusedServices })
  await blank.commands.confirmDialog({ kind: 'rename-session', sessionId: 's1' }, { value: ' ' })
  assert.deepEqual(blank.failures, ['name-required'])
  assert.deepEqual(blank.closed, [])

  await captureWarnings(async (warnings) => {
    const failing = makeCommands({
      services: () => ({
        sessions: {
          using: async () => {
            throw new Error('rename-failed')
          },
        },
      }),
    })
    await failing.commands.confirmDialog({ kind: 'rename-session', sessionId: 's1' }, { value: 'Titled' })
    // `actions.renameSession` and the dialog catch each report the host failure.
    assert.ok(failing.notify.some((toast) => toast.kind === 'error' && toast.message === 'toast.renameFailed'))
    assert.deepEqual(failing.closed, [])
    assert.ok(warnings.length >= 1)
  })
})

test('0.4.0-beta.65 confirmDialog delete-group relocates sessions to the destination', async () => {
  const { commands, notify, store, closed, failures } = makeCommands({
    doc: makeDoc({
      groups: [group({ id: 'g1', sessionIds: ['s1'] }), group({ id: 'g2', sessionIds: [] })],
    }),
  })
  await commands.confirmDialog({ kind: 'delete-group', groupId: 'g1' }, { destinationId: 'g2' })
  assert.equal(store.snapshot.doc.groups.some((entry) => entry.id === 'g1'), false)
  assert.deepEqual(store.snapshot.doc.groups[0].sessionIds, ['s1'])
  assert.equal(closed.length, 1)
  assert.deepEqual(notify, [{ kind: 'success', message: 'toast.groupDeleted' }])
  assert.deepEqual(failures, [])
})

test('0.4.0-beta.65 confirmDialog delete-group relocates sessions to ungrouped by default', async () => {
  const { commands, notify, store, closed } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: ['s1'] })] }),
  })
  await commands.confirmDialog({ kind: 'delete-group', groupId: 'g1' })
  assert.deepEqual(store.snapshot.doc.groups, [])
  assert.deepEqual(store.snapshot.doc.ungrouped, ['s1'])
  assert.equal(closed.length, 1)
  assert.deepEqual(notify, [{ kind: 'success', message: 'toast.groupDeleted' }])
})

test('0.4.0-beta.65 confirmDialog delete-group maps a generic failure inline', async () => {
  await captureWarnings(async (warnings) => {
    const { commands, notify, closed, failures } = makeCommands({
      doc: makeDoc({ groups: [group({ sessionIds: ['s1'] })] }),
      sync: {
        commitDoc: async () => {
          throw new Error('disk-failed')
        },
      },
    })
    await commands.confirmDialog({ kind: 'delete-group', groupId: 'g1' }, { destinationId: null })
    assert.deepEqual(failures, ['commit-failed'])
    assert.deepEqual(closed, [])
    assert.deepEqual(notify, [])
    assert.equal(warnings.length, 1)
  })
})

test('0.4.0-beta.65 confirmDialog icon applies the selected glyph', async () => {
  const { commands, notify, store, closed, failures } = makeCommands()
  await commands.confirmDialog({ kind: 'icon', groupId: 'g1' }, { icon: 'star' })
  assert.equal(store.snapshot.doc.groups[0].icon, 'star')
  assert.equal(closed.length, 1)
  assert.deepEqual(notify, [{ kind: 'success', message: 'toast.saved' }])
  assert.deepEqual(failures, [])
})

test('0.4.0-beta.65 confirmDialog group-color supports palette and custom hex', async () => {
  const palette = makeCommands()
  await palette.commands.confirmDialog({ kind: 'group-color', groupId: 'g1' }, { color: 'green' })
  assert.equal(palette.store.snapshot.doc.groups[0].color, 'green')
  assert.equal('colorHex' in palette.store.snapshot.doc.groups[0], false)
  assert.equal(palette.closed.length, 1)

  const custom = makeCommands()
  await custom.commands.confirmDialog({ kind: 'group-color', groupId: 'g1' }, { colorHex: '#ABC' })
  assert.equal(custom.store.snapshot.doc.groups[0].colorHex, '#aabbcc')
  assert.equal(custom.closed.length, 1)
})

test('0.4.0-beta.65 confirmDialog move-session moves to the head and toasts', async () => {
  const { commands, notify, store, closed, failures } = makeCommands({
    doc: makeDoc({
      groups: [group({ id: 'g1', sessionIds: ['s1'] }), group({ id: 'g2', sessionIds: [] })],
    }),
  })
  await commands.confirmDialog({ kind: 'move-session', sessionId: 's1' }, { groupId: 'g2' })
  assert.deepEqual(store.snapshot.doc.groups.find((entry) => entry.id === 'g1').sessionIds, [])
  assert.deepEqual(store.snapshot.doc.groups.find((entry) => entry.id === 'g2').sessionIds, ['s1'])
  assert.equal(closed.length, 1)
  assert.deepEqual(notify, [{ kind: 'success', message: 'toast.moved' }])
  assert.deepEqual(failures, [])
})

test('0.4.0-beta.65 confirmDialog move-session offers the switch under the only filter', async () => {
  const { commands, notify, store } = makeCommands({
    doc: makeDoc({
      groups: [group({ id: 'g1', sessionIds: ['s1'] }), group({ id: 'g2', sessionIds: [] })],
    }),
    overrides: { groupArchiveFilter: 'only' },
  })
  await commands.confirmDialog({ kind: 'move-session', sessionId: 's1' }, { groupId: 'g2' })
  assert.deepEqual(messages(notify), ['info:toast.movedInvisible'])
  const [toast] = notify
  assert.equal(toast.action.label, 'toast.showAllGroups')
  toast.action.onClick()
  assert.deepEqual(store.calls, [{ type: 'group-archive-filter', payload: { filter: 'all' } }])
})

test('0.4.0-beta.65 confirmDialog move-session maps an unknown destination to a drop failure', async () => {
  await captureWarnings(async (warnings) => {
    const { commands, documentSync, notify, closed } = makeCommands()
    await commands.confirmDialog({ kind: 'move-session', sessionId: 's1' }, { groupId: 'missing' })
    assert.deepEqual(messages(notify), ['error:toast.dropFailed'])
    assert.deepEqual(closed, [])
    assert.deepEqual(documentSync.calls, [])
    assert.equal(warnings.length, 1)
  })
})

test('0.4.0-beta.65 confirmDialog move-group moves the group and toasts', async () => {
  const { commands, notify, store, closed, failures } = makeCommands({
    doc: makeDoc({ groups: [group({ id: 'g1', sessionIds: [] }), group({ id: 'g2', sessionIds: [] })] }),
  })
  await commands.confirmDialog({ kind: 'move-group', groupId: 'g2' }, { groupId: null })
  assert.deepEqual(store.snapshot.doc.groups.map((entry) => entry.id), ['g2', 'g1'])
  assert.equal(closed.length, 1)
  assert.deepEqual(notify, [{ kind: 'success', message: 'toast.saved' }])
  assert.deepEqual(failures, [])
})

test('0.4.0-beta.65 confirmDialog move-group explains an append-only move', async () => {
  const { commands, documentSync, notify, closed, failures } = makeCommands({
    doc: makeDoc({
      groups: [
        group({ id: 'g1', sessionIds: [], archived: true }),
        group({ id: 'g2', sessionIds: [] }),
      ],
    }),
  })
  // Index 0 would shift the frozen sibling; the group is already last, so the
  // resolved plan is a no-op with the explanatory toast.
  await commands.confirmDialog({ kind: 'move-group', groupId: 'g2' }, { groupId: null })
  assert.deepEqual(notify, [{ kind: 'info', message: 'toast.moveGroupAppended' }])
  assert.equal(closed.length, 1)
  assert.deepEqual(documentSync.calls, [])
  assert.deepEqual(failures, [])
})

test('0.4.0-beta.65 confirmDialog move-group appends when index zero would shift a frozen anchor', async () => {
  const { commands, notify, store, closed, failures } = makeCommands({
    doc: makeDoc({
      groups: [
        group({ id: 'p', sessionIds: [] }),
        group({ id: 'g3', sessionIds: [] }),
        group({ id: 'g2', parentId: 'p', sessionIds: [] }),
        group({ id: 'g1', parentId: 'p', sessionIds: [], archived: true }),
      ],
    }),
  })
  await commands.confirmDialog({ kind: 'move-group', groupId: 'g3' }, { groupId: 'p' })
  const moved = store.snapshot.doc.groups.find((entry) => entry.id === 'g3')
  assert.equal(moved.parentId, 'p')
  assert.deepEqual(
    store.snapshot.doc.groups.filter((entry) => entry.parentId === 'p').map((entry) => entry.id),
    ['g2', 'g1', 'g3']
  )
  assert.deepEqual(notify, [{ kind: 'info', message: 'toast.moveGroupAppended' }])
  assert.equal(closed.length, 1)
  assert.deepEqual(failures, [])
})

test('0.4.0-beta.65 confirmDialog move-group offers the switch when the moved group is invisible', async () => {
  const { commands, notify, store } = makeCommands({
    doc: makeDoc({
      groups: [group({ id: 'p', sessionIds: [] }), group({ id: 'g3', sessionIds: [] })],
    }),
    overrides: { groupArchiveFilter: 'only' },
  })
  await commands.confirmDialog({ kind: 'move-group', groupId: 'g3' }, { groupId: 'p' })
  assert.deepEqual(messages(notify), ['info:toast.movedInvisible'])
  const [toast] = notify
  assert.equal(toast.action.label, 'toast.showAllGroups')
  toast.action.onClick()
  assert.deepEqual(store.calls, [{ type: 'group-archive-filter', payload: { filter: 'all' } }])
})

test('0.4.0-beta.65 confirmDialog move-group rejects an archived destination inline', async () => {
  const { commands, documentSync, notify, closed, failures } = makeCommands({
    doc: makeDoc({
      groups: [group({ id: 'g1', sessionIds: [] }), group({ id: 'g2', sessionIds: [], archived: true })],
    }),
  })
  await commands.confirmDialog({ kind: 'move-group', groupId: 'g1' }, { groupId: 'g2' })
  assert.deepEqual(failures, ['dialog.destinationArchived'])
  assert.deepEqual(documentSync.calls, [])
  assert.deepEqual(closed, [])
  assert.deepEqual(notify, [])
})

test('0.4.0-beta.65 confirmDialog move-group revalidates against the committed document', async () => {
  await captureWarnings(async (warnings) => {
    const stale = makeDoc({
      groups: [group({ id: 'p', sessionIds: [], archived: true }), group({ id: 'g1', sessionIds: [] })],
    })
    const { commands, documentSync, closed, failures } = makeCommands({
      doc: makeDoc({ groups: [group({ id: 'p', sessionIds: [] }), group({ id: 'g1', sessionIds: [] })] }),
      // The preview was legal, but the destination got frozen before the commit:
      // the strict updater re-runs the guard and rejects inline.
      sync: { commitDoc: async (updater) => updater(stale) },
    })
    await commands.confirmDialog({ kind: 'move-group', groupId: 'g1' }, { groupId: 'p' })
    assert.deepEqual(failures, ['dialog.destinationArchived'])
    assert.deepEqual(closed, [])
    assert.deepEqual(documentSync.calls, [['commitDoc']])
    assert.equal(warnings.length, 1)
  })
})

test('0.4.0-beta.65 confirmDialog archive-group commits, closes and persists the opt-out', async () => {
  await withLocalStorage({}, async (storage) => {
    const { commands, documentSync, notify, store, closed, failures } = makeCommands({
      doc: makeDoc({
        groups: [group({ id: 'g1', sessionIds: ['s1'] }), group({ id: 'g2', sessionIds: ['s2'] })],
      }),
    })
    await commands.confirmDialog({ kind: 'archive-group', groupId: 'g1' }, { dontAskAgain: true })
    await commands.confirmDialog({ kind: 'archive-group', groupId: 'g2' }, {})
    assert.equal(store.snapshot.doc.groups[0].archived, true)
    assert.equal(store.snapshot.doc.groups[1].archived, true)
    assert.deepEqual(storage.writes, [
      [ARCHIVE_CONFIRM_SKIP_KEY, 'true'],
      [ARCHIVE_CONFIRM_SKIP_KEY, 'false'],
    ])
    assert.equal(closed.length, 2)
    assert.deepEqual(failures, [])
    assert.deepEqual(documentSync.calls, [['commitDoc'], ['commitDoc']])
    assert.equal(notify.length, 2)
    for (const toast of notify) {
      assert.equal(toast.message, 'toast.groupArchivedHidden')
      assert.equal(toast.action.label, 'toast.showArchivedGroups')
    }
  })
})

test('0.4.0-beta.65 confirmDialog archive-group keeps the dialog open on a structured failure', async () => {
  await withLocalStorage({}, async (storage) => {
    const { commands, documentSync, notify, closed, failures } = makeCommands({
      doc: makeDoc({ groups: [group({ sessionIds: ['s1'] })] }),
      sync: {
        commitDoc: async () => {
          throw structuredError('group-archived')
        },
      },
    })
    await commands.confirmDialog({ kind: 'archive-group', groupId: 'g1' }, {})
    assert.deepEqual(failures, ['dialog.groupArchived'])
    assert.deepEqual(closed, [])
    assert.deepEqual(documentSync.calls, [['commitDoc']])
    assert.deepEqual(storage.writes, [])
    assert.deepEqual(notify, [])
  })
})

test('0.4.0-beta.65 confirmDialog archive-group reports a post-commit conflict inline', async () => {
  await withLocalStorage({}, async (storage) => {
    const { commands, documentSync, notify, closed, failures } = makeCommands({
      doc: makeDoc({ groups: [group({ sessionIds: ['s1'] })] }),
      sync: { commitDoc: async (updater, store) => store.getSnapshot().doc },
    })
    await commands.confirmDialog({ kind: 'archive-group', groupId: 'g1' }, {})
    assert.deepEqual(failures, ['dialog.archiveFrozen'])
    assert.deepEqual(closed, [])
    assert.deepEqual(documentSync.calls, [['commitDoc'], ['refresh', { force: true }]])
    assert.deepEqual(storage.writes, [])
    assert.deepEqual(notify, [{ kind: 'error', message: 'toast.archiveFailed' }])
  })
})

test('0.4.0-beta.65 archiveGroup restores focus to the next visible group row', async () => {
  await withLocalStorage({ [ARCHIVE_CONFIRM_SKIP_KEY]: 'true' }, async () => {
    const focused = []
    const rows = ['g1', 'g2'].map((id) => ({
      getAttribute: (name) => (name === 'data-group-id' ? id : null),
      focus: (options) => focused.push({ id, options }),
    }))
    const rowFor = (selector) => {
      const match = /data-group-id="([^"]+)"/.exec(selector)
      return match ? rows.find((row) => row.getAttribute('data-group-id') === match[1]) ?? null : null
    }
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const rafDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: {
        querySelectorAll: (selector) => (selector === '[data-testid="session-groups-group"]' ? rows : []),
        querySelector: (selector) =>
          selector.startsWith('[data-testid="session-groups-group"][data-group-id=')
            ? rowFor(selector)
            : rows[0] ?? null,
      },
    })
    // Run the deferred focus synchronously inside the assertion window.
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: (run) => {
        run()
        return 1
      },
    })
    try {
      const { commands, notify } = makeCommands({
        doc: makeDoc({
          groups: [group({ id: 'g1', sessionIds: [] }), group({ id: 'g2', sessionIds: [] })],
        }),
      })
      await commands.archiveGroup('g1')
      // The archived row is hidden under `hidden`; its next sibling gets focus.
      assert.deepEqual(focused, [{ id: 'g2', options: { preventScroll: true } }])
      assert.equal(notify.length, 1)
      assert.equal(notify[0].message, 'toast.groupArchivedHidden')

      // A last-row archive has no successor: focus falls back to the first row.
      focused.length = 0
      await commands.archiveGroup('g2')
      assert.deepEqual(focused, [{ id: 'g1', options: { preventScroll: true } }])
    } finally {
      if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
      else delete globalThis.document
      if (rafDescriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', rafDescriptor)
      else delete globalThis.requestAnimationFrame
    }
  })
})

test('0.4.0-beta.65 confirmDialog archive-running stops the activity and reports the result', async () => {
  const archives = []
  const success = makeCommands({
    services: () => ({
      uiWorkspace: {
        archiveSession: async (id, options) => {
          archives.push({ id, options })
        },
      },
    }),
  })
  await success.commands.confirmDialog({ kind: 'archive-running', sessionId: 's1' })
  assert.deepEqual(archives, [{ id: 's1', options: { stopActivity: true } }])
  assert.equal(success.closed.length, 1)
  assert.deepEqual(success.notify, [{ kind: 'success', message: 'toast.saved' }])

  const failing = makeCommands({
    services: () => ({
      uiWorkspace: {
        archiveSession: async () => {
          throw new Error('busy')
        },
      },
    }),
  })
  await failing.commands.confirmDialog({ kind: 'archive-running', sessionId: 's1' })
  assert.equal(failing.closed.length, 1)
  assert.deepEqual(failing.notify, [{ kind: 'error', message: 'toast.archiveFailed' }])
})

test('0.4.0-beta.65 confirmDialog unknown kind only closes the dialog', async () => {
  const { commands, documentSync, notify, closed, failures } = makeCommands()
  await commands.confirmDialog({ kind: 'mystery' })
  assert.equal(closed.length, 1)
  assert.deepEqual(documentSync.calls, [])
  assert.deepEqual(notify, [])
  assert.deepEqual(failures, [])
})

// --- session commands -----------------------------------------------------

test('0.4.0-beta.65 archiveSession maps success, running-refusal and failure', async () => {
  const success = makeCommands({
    services: () => ({ uiWorkspace: { archiveSession: async () => {} } }),
  })
  await success.commands.archiveSession('s1')
  assert.deepEqual(success.notify, [{ kind: 'success', message: 'toast.saved' }])
  assert.deepEqual(success.dialogs, [])

  const refusal = Object.assign(new Error('session-active'), {
    name: 'WorkspaceArchiveError',
    rpcError: { code: 'workspace/session-active', details: { activity: ['turn', 'job'] } },
  })
  const running = makeCommands({
    services: () => ({ uiWorkspace: { archiveSession: async () => Promise.reject(refusal) } }),
  })
  await running.commands.archiveSession('s1')
  assert.deepEqual(running.dialogs, [
    {
      kind: 'archive-running',
      titleKey: 'dialog.archiveRunning',
      sessionId: 's1',
      activity: ['turn', 'job'],
    },
  ])
  assert.deepEqual(running.notify, [])

  const failing = makeCommands({
    services: () => ({
      uiWorkspace: {
        archiveSession: async () => {
          throw new Error('archive-failed')
        },
      },
    }),
  })
  await failing.commands.archiveSession('s1')
  assert.deepEqual(failing.dialogs, [])
  assert.deepEqual(failing.notify, [{ kind: 'error', message: 'toast.archiveFailed' }])
})

test('0.4.0-beta.65 unarchiveSession delegates and surfaces failures through the action bridge', async () => {
  const unarchived = []
  const success = makeCommands({
    services: () => ({
      uiWorkspace: {
        unarchiveSession: async (id) => unarchived.push(id),
      },
    }),
  })
  await success.commands.unarchiveSession('s1')
  assert.deepEqual(unarchived, ['s1'])
  assert.deepEqual(success.notify, [])

  await captureWarnings(async (warnings) => {
    const failing = makeCommands({ services: () => ({}) })
    await failing.commands.unarchiveSession('s1')
    assert.deepEqual(failing.notify, [{ kind: 'error', message: 'toast.unarchiveFailed' }])
    assert.equal(warnings.length, 1)
  })
})

test('0.4.0-beta.65 forkSession places the child at the source group head', async () => {
  const forked = []
  const { commands, documentSync, notify, store, failures } = makeCommands({
    services: () => ({
      uiWorkspace: {
        forkSession: async (id, onCreated) => {
          forked.push(id)
          onCreated('child-1')
        },
      },
    }),
  })
  await commands.forkSession('s1')
  assert.deepEqual(forked, ['s1'])
  assert.deepEqual(store.snapshot.doc.groups[0].sessionIds, ['child-1', 's1'])
  assert.deepEqual(documentSync.calls, [['commitDoc']])
  assert.deepEqual(notify, [{ kind: 'success', message: 'toast.forked' }])
  assert.deepEqual(failures, [])
})

test('0.4.0-beta.65 forkSession leaves an ungrouped child ungrouped', async () => {
  const { commands, documentSync, notify, store } = makeCommands({
    doc: makeDoc({ groups: [group({ sessionIds: [] })], ungrouped: ['s1'] }),
    services: () => ({
      uiWorkspace: {
        forkSession: async (id, onCreated) => onCreated('child-1'),
      },
    }),
  })
  await commands.forkSession('s1')
  // The render tree derives ungrouped sessions by recency; the fork policy must
  // not append the child to the explicit ungrouped list.
  assert.deepEqual(store.snapshot.doc.groups[0].sessionIds, [])
  assert.deepEqual(store.snapshot.doc.ungrouped, ['s1'])
  assert.deepEqual(documentSync.calls, [['commitDoc']])
  assert.deepEqual(notify, [{ kind: 'success', message: 'toast.forked' }])
})

test('0.4.0-beta.65 forkSession refuses a session in an archived group', async () => {
  const forked = []
  const { commands, documentSync, notify } = makeCommands({
    doc: makeDoc({ groups: [group({ archived: true, sessionIds: ['s1'] })] }),
    services: () => ({
      uiWorkspace: {
        forkSession: async (id) => forked.push(id),
      },
    }),
  })
  await commands.forkSession('s1')
  assert.deepEqual(forked, [])
  assert.deepEqual(documentSync.calls, [])
  assert.deepEqual(notify, [{ kind: 'info', message: 'menu.groupArchivedLocked' }])
})

test('0.4.0-beta.65 forkSession maps host errors to user-facing copy', async () => {
  const migration = makeCommands({
    services: () => ({
      uiWorkspace: {
        forkSession: async () => {
          throw Object.assign(new Error('migration-required'), {
            rpcError: { code: 'session/migration-required' },
          })
        },
      },
    }),
  })
  await migration.commands.forkSession('s1')
  assert.deepEqual(migration.notify, [{ kind: 'error', message: 'toast.forkRequiresOpen' }])

  // No host fork capability at all: the action bridge reports the generic copy.
  const unavailable = makeCommands({ services: () => ({}) })
  await unavailable.commands.forkSession('s1')
  assert.deepEqual(unavailable.notify, [{ kind: 'error', message: 'toast.forkFailed' }])

  // The host returned without creating a child id.
  const empty = makeCommands({
    services: () => ({ uiWorkspace: { forkSession: async () => {} } }),
  })
  await empty.commands.forkSession('s1')
  assert.deepEqual(empty.notify, [{ kind: 'error', message: 'toast.forkFailed' }])

  // A structured archive rejection keeps the freeze copy instead of "fork failed".
  const frozen = makeCommands({
    services: () => ({
      uiWorkspace: {
        forkSession: async () => {
          throw structuredError('group-archived')
        },
      },
    }),
  })
  await frozen.commands.forkSession('s1')
  assert.deepEqual(frozen.notify, [{ kind: 'info', message: 'menu.groupArchivedLocked' }])
})

test('0.4.0-beta.65 forkSession reports a placement failure without retrying', async () => {
  const { commands, notify } = makeCommands({
    services: () => ({
      uiWorkspace: {
        forkSession: async (id, onCreated) => onCreated('child-1'),
      },
    }),
    sync: {
      commitDoc: async () => {
        throw new Error('placement-failed')
      },
    },
  })
  await commands.forkSession('s1')
  assert.deepEqual(notify, [{ kind: 'error', message: 'toast.forkPlacementFailed' }])
})

test('0.4.0-beta.65 copySessionId reports the clipboard result', async () => {
  const copied = makeCommands()
  await copied.commands.copySessionId('s1')
  assert.deepEqual(copied.notify, [{ kind: 'success', message: 'toast.sessionIdCopied' }])

  const failed = makeCommands({ clipboard: async () => false })
  await failed.commands.copySessionId('s1')
  assert.deepEqual(failed.notify, [{ kind: 'error', message: 'toast.sessionIdCopyFailed' }])
})

test('0.4.0-beta.65 the command layer imports no DSH package', () => {
  const source = readFileSync(new URL('../../src/client/plugin-host-commands.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /@deepseek-ai\//)
})
