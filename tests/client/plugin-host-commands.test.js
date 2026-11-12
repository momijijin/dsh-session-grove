// tests/client/plugin-host-commands.test.js
//
// 0.4.0-beta.65 S2: the host command layer is a plain module — no DSH/react
// imports — so its factory surface, capability probe and dialog dispatch can be
// exercised under node:test with fake dependencies only.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createHostCommands } from '../../src/client/plugin-host-commands.js'

/** Document with one direct-session group (enough for the archive boundary). */
const docWithGroup = (sessionIds = ['s1']) => ({
  version: 1,
  revision: 0,
  groups: [{ id: 'g1', name: 'Group', icon: 'folder', color: 'blue', parentId: null, sessionIds }],
  ungrouped: [],
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
      return () => listeners.splice(listeners.indexOf(listener), 1)
    },
  }
}

const makeDocumentSync = (doc) => {
  const calls = []
  return {
    calls,
    commitDoc: async (updater) => {
      calls.push(['commitDoc'])
      return typeof updater === 'function' ? updater(doc) : updater
    },
    commitOptimistic: async (updater) => {
      calls.push(['commitOptimistic'])
      return typeof updater === 'function' ? updater(doc) : updater
    },
    refresh: (options) => calls.push(['refresh', options]),
    onStorePublish: () => {},
    load: () => {},
    dispose: () => {},
  }
}

const makeCommands = ({ doc = docWithGroup(), overrides = {}, services = () => ({}) } = {}) => {
  const store = makeStore(doc, overrides)
  const documentSync = makeDocumentSync(doc)
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
    clipboard: async () => true,
    getCurrentSessionId: () => null,
    openDialog: (dialog) => dialogs.push(dialog),
    closeDialog: () => closed.push(true),
  })
  return { commands, store, documentSync, notify, dialogs, closed, failures }
}

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

test('0.4.0-beta.65 capabilities probe is all-false without host services', () => {
  const { commands } = makeCommands()
  const capabilities = commands.capabilities()
  // `fork` is a predicate in the host contract; the other three are booleans.
  assert.equal(capabilities.fork('s1'), false)
  assert.deepEqual(
    { ...capabilities, fork: capabilities.fork('s1') },
    { fork: false, archive: false, unarchive: false, connect: false }
  )
})

test('0.4.0-beta.65 archive filter dispatches the shared view action', () => {
  const { commands, store } = makeCommands()
  commands.setArchiveFilter('all')
  assert.deepEqual(store.calls, [{ type: 'archive-filter', payload: { filter: 'all' } }])
  commands.setGroupArchiveFilter('only')
  assert.deepEqual(store.calls.at(-1), { type: 'group-archive-filter', payload: { filter: 'only' } })
})

test('0.4.0-beta.65 archiveGroup routes the confirm to the injected openDialog', async () => {
  // One direct session needs the confirmation boundary; the default persisted
  // archive-skip is false under node (no localStorage), so the dialog opens.
  const { commands, dialogs, store, documentSync, notify } = makeCommands()
  const result = await commands.archiveGroup('g1')
  assert.equal(result, false)
  assert.deepEqual(dialogs, [
    { kind: 'archive-group', groupId: 'g1', archived: true, titleKey: 'dialog.archiveGroup' },
  ])
  // The commands never add the shell-owned x/y anchor and never commit early.
  assert.equal('x' in dialogs[0], false)
  assert.equal('y' in dialogs[0], false)
  assert.equal(store.calls.length, 0)
  assert.equal(documentSync.calls.length, 0)
  assert.equal(notify.length, 0)
})

test('0.4.0-beta.65 installFollowGuard subscribes and returns its disposer', () => {
  const { commands, store } = makeCommands()
  const dispose = commands.installFollowGuard()
  assert.equal(typeof dispose, 'function')
  assert.equal(store.listeners.length, 1)
  dispose()
  assert.equal(store.listeners.length, 0)
  // Both cleanup entry points are always safe to call.
  assert.doesNotThrow(() => commands.clearPendingFollow())
  assert.doesNotThrow(() => commands.applyEpoch())
})

test('0.4.0-beta.65 the command layer imports no DSH package', () => {
  const source = readFileSync(new URL('../../src/client/plugin-host-commands.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /@deepseek-ai\//)
})
