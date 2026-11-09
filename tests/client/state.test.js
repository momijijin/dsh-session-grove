import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ARCHIVE_FILTER_KEY,
  COLLAPSED_KEY,
  ONBOARDING_KEY,
  VIEW_MODE_KEY,
  createStore,
  readArchiveFilter,
  readOnboardingDone,
  readViewMode,
  writeArchiveFilter,
  writeOnboardingDone,
  writeViewMode,
} from '../../src/client/state.js'

const fakeStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    map,
  }
}

test('view mode defaults to workspace and persists groups', () => {
  const storage = fakeStorage()
  assert.equal(readViewMode(storage), 'workspace')
  writeViewMode('groups', storage)
  assert.equal(storage.getItem(VIEW_MODE_KEY), 'groups')
  assert.equal(readViewMode(storage), 'groups')
  writeViewMode('workspace', storage)
  assert.equal(readViewMode(storage), 'workspace')
  writeViewMode('invalid', storage)
  assert.equal(readViewMode(storage), 'workspace')
})

test('archive filter defaults to hidden and ignores unknown values', () => {
  const storage = fakeStorage({ [ARCHIVE_FILTER_KEY]: 'only' })
  assert.equal(readArchiveFilter(storage), 'only')
  writeArchiveFilter('all', storage)
  assert.equal(readArchiveFilter(storage), 'all')
  writeArchiveFilter('nope', storage)
  assert.equal(readArchiveFilter(storage), 'hidden')
})

test('onboarding dismissal persists once', () => {
  const storage = fakeStorage()
  assert.equal(readOnboardingDone(storage), false)
  writeOnboardingDone(storage)
  assert.equal(storage.getItem(ONBOARDING_KEY), '1')
  assert.equal(readOnboardingDone(storage), true)
  storage.setItem(ONBOARDING_KEY, 'broken')
  assert.equal(readOnboardingDone(storage), false)
})

test('reset-collapsed clears and persists the expansion defaults', () => {
  const storage = fakeStorage()
  const store = createStore({ storage })
  store.dispatch('collapse-group', { id: 'g1' })
  store.dispatch('collapse-group', { id: 'g2' })
  store.dispatch('reset-collapsed')
  assert.deepEqual(store.getSnapshot().collapsed, {})
  assert.deepEqual(createStore({ storage }).getSnapshot().collapsed, {})
})

test('store dispatch updates view mode and persists it', () => {
  const storage = fakeStorage()
  const store = createStore({ storage })
  assert.equal(store.getSnapshot().viewMode, 'workspace')
  store.dispatch('view-mode', { mode: 'groups' })
  assert.equal(store.getSnapshot().viewMode, 'groups')
  assert.equal(storage.getItem(VIEW_MODE_KEY), 'groups')
})

test('store dispatch toggles expansion and only updates subscribers', () => {
  const store = createStore({ storage: fakeStorage() })
  let calls = 0
  const unsubscribe = store.subscribe(() => {
    calls += 1
  })
  store.dispatch('toggle-group', { id: 'g1' })
  assert.equal(store.getSnapshot().collapsed.g1, true)
  store.dispatch('expand-group', { id: 'g1' })
  assert.equal(store.getSnapshot().collapsed.g1, undefined)
  store.dispatch('collapse-group', { id: 'g2' })
  assert.equal(store.getSnapshot().collapsed.g2, true)
  unsubscribe()
  store.dispatch('toggle-group', { id: 'g3' })
  assert.equal(calls, 3)
})

test('collapsed groups persist across store recreation (plugin updates/reloads)', () => {
  const storage = fakeStorage()
  const first = createStore({ storage })
  first.dispatch('toggle-group', { id: 'g1' })
  first.dispatch('collapse-group', { id: 'g2' })
  first.dispatch('expand-group', { id: 'g1' })

  const second = createStore({ storage })
  assert.equal(second.getSnapshot().collapsed.g1, undefined)
  assert.equal(second.getSnapshot().collapsed.g2, true)

  storage.setItem(COLLAPSED_KEY, '{broken')
  assert.deepEqual(createStore({ storage }).getSnapshot().collapsed, {})
})

test('load success/error and commit conflict transitions', () => {
  const store = createStore({ storage: fakeStorage() })
  store.dispatch('load-start')
  assert.equal(store.getSnapshot().docState, 'loading')
  const doc = { version: 1, revision: 0, groups: [], ungrouped: [] }
  store.dispatch('load-success', { doc, revision: 0, warning: 'corrupt-file' })
  assert.equal(store.getSnapshot().docState, 'ready')
  assert.equal(store.getSnapshot().lastConfirmed, doc)
  assert.deepEqual(store.getSnapshot().banner, { kind: 'warning', code: 'corrupt-file' })
  assert.equal(store.getSnapshot().warning, 'corrupt-file')

  store.dispatch('load-error', { code: 'route-unavailable' })
  assert.equal(store.getSnapshot().docState, 'error')
  assert.deepEqual(store.getSnapshot().banner, { kind: 'error', code: 'route-unavailable' })

  const serverDoc = { version: 1, revision: 4, groups: [], ungrouped: [] }
  store.dispatch('commit-conflict', { doc: serverDoc, revision: 4 })
  assert.equal(store.getSnapshot().doc, serverDoc)
  assert.equal(store.getSnapshot().revision, 4)
  assert.equal(store.getSnapshot().banner.code, 'conflict')
})

test('menu/dialog/toast are transient store state', () => {
  const store = createStore({ storage: fakeStorage() })
  store.dispatch('menu', { menu: { kind: 'group', groupId: 'g1' } })
  assert.equal(store.getSnapshot().menu.groupId, 'g1')
  store.dispatch('menu', { menu: null })
  assert.equal(store.getSnapshot().menu, null)
  store.dispatch('dialog', { dialog: { kind: 'new-group' } })
  assert.equal(store.getSnapshot().dialog.kind, 'new-group')
  store.dispatch('dialog', { dialog: null })
  assert.equal(store.getSnapshot().dialog, null)
  store.dispatch('toast', { toast: { kind: 'success', message: 'ok' } })
  assert.equal(store.getSnapshot().toast.message, 'ok')
})

test('storage failures are best-effort and malformed persisted values fall back safely', () => {
  const blocked = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
  }
  assert.equal(readViewMode(blocked), 'workspace')
  assert.equal(readArchiveFilter(blocked), 'hidden')
  assert.equal(readOnboardingDone(blocked), false)
  assert.doesNotThrow(() => writeViewMode('groups', blocked))
  assert.doesNotThrow(() => writeArchiveFilter('all', blocked))
  assert.doesNotThrow(() => writeOnboardingDone(blocked))

  const malformed = fakeStorage({
    [VIEW_MODE_KEY]: 'garbage',
    [ARCHIVE_FILTER_KEY]: 'garbage',
    [COLLAPSED_KEY]: JSON.stringify({ g1: false, g2: true, '': true }),
  })
  const store = createStore({ storage: malformed })
  assert.equal(store.getSnapshot().viewMode, 'workspace')
  assert.equal(store.getSnapshot().archiveFilter, 'hidden')
  assert.deepEqual(store.getSnapshot().collapsed, { g2: true })
})

test('no-op dispatches do not publish and invalid collapse targets are ignored', () => {
  const store = createStore({ storage: fakeStorage() })
  const seen = []
  store.subscribe(() => seen.push(store.getSnapshot()))
  store.dispatch('view-mode', { mode: 'workspace' })
  store.dispatch('archive-filter', { filter: 'hidden' })
  store.dispatch('expand-group', { id: 'missing' })
  store.dispatch('collapse-group', { id: '' })
  store.dispatch('reset-collapsed')
  store.dispatch('unknown-action')
  assert.equal(seen.length, 0)

  store.dispatch('collapse-group', { id: 'g1' })
  assert.equal(store.getSnapshot().collapsed.g1, true)
  store.dispatch('expand-group', { id: 'g1' })
  assert.equal(store.getSnapshot().collapsed.g1, undefined)
  store.dispatch('expand-group', { id: 'g1' })
  store.dispatch('toggle-group', { id: 'g2' })
  assert.equal(store.getSnapshot().collapsed.g2, true)
  store.dispatch('toggle-group', { id: 'g2' })
  assert.equal(store.getSnapshot().collapsed.g2, undefined)
  store.dispatch('reset-collapsed')
  assert.deepEqual(store.getSnapshot().collapsed, {})
})

test('a throwing subscriber cannot break other subscribers or the store', () => {
  const store = createStore({ storage: fakeStorage() })
  const seen = []
  store.subscribe(() => { throw new Error('broken subscriber') })
  store.subscribe(() => seen.push(store.getSnapshot().saving))
  assert.doesNotThrow(() => store.dispatch('saving', { saving: true }))
  assert.deepEqual(seen, [true])
  assert.equal(store.getSnapshot().saving, true)
})

test('profiles summary starts available and records load/error/unavailable', () => {
  const store = createStore({ storage: fakeStorage() })
  const initial = store.getSnapshot()
  assert.equal(initial.profileId, null)
  assert.equal(initial.profiles.available, true)
  assert.equal(initial.profiles.loading, false)
  assert.deepEqual(initial.profiles.list, [])
  assert.equal(initial.profileSwitching, false)
  assert.equal(initial.profileEpoch, 0)
  assert.equal(initial.latestSeenRevision, 0)

  store.dispatch('profiles-loading')
  assert.equal(store.getSnapshot().profiles.loading, true)
  assert.equal(store.dispatch('profiles-loading'), store.getSnapshot(), 'a second start is a no-op')

  store.dispatch('profiles-success', {
    registryRevision: 3,
    activeId: 'work-1',
    degraded: false,
    list: [{ id: 'default', name: null }, { id: 'work-1', name: 'Work' }],
  })
  const loaded = store.getSnapshot().profiles
  assert.equal(loaded.available, true)
  assert.equal(loaded.loading, false)
  assert.equal(loaded.degraded, false)
  assert.equal(loaded.registryRevision, 3)
  assert.equal(loaded.activeId, 'work-1')
  assert.equal(loaded.list.length, 2)
  assert.equal(loaded.error, null)

  store.dispatch('profiles-error', { code: 'io', message: 'disk' })
  assert.equal(store.getSnapshot().profiles.loading, false)
  assert.deepEqual(store.getSnapshot().profiles.error, { code: 'io', message: 'disk' })

  store.dispatch('profiles-unavailable')
  assert.equal(store.getSnapshot().profiles.available, false)
  assert.equal(store.getSnapshot().profiles.loading, false)
  assert.deepEqual(store.getSnapshot().profiles.list, [])
  assert.equal(store.getSnapshot().profiles.error, null)
})

test('an older profile list response cannot move activeId back', () => {
  const store = createStore({ storage: fakeStorage() })
  store.dispatch('profiles-success', {
    registryRevision: 7,
    activeId: 'work-1',
    list: [{ id: 'work-1', name: 'Work' }],
  })
  store.dispatch('profiles-success', {
    registryRevision: 6,
    activeId: 'default',
    list: [{ id: 'default', name: null }],
  })
  const profiles = store.getSnapshot().profiles
  assert.equal(profiles.activeId, 'work-1')
  assert.equal(profiles.registryRevision, 7)
  assert.deepEqual(profiles.list, [{ id: 'default', name: null }], 'rows still refresh')
})

test('profiles keep the host limit and split archived rows into their own list', () => {
  const store = createStore({ storage: fakeStorage() })
  const initial = store.getSnapshot().profiles
  assert.deepEqual(initial.limits, { max: 20 })
  assert.deepEqual(initial.archivedList, [])

  store.dispatch('profiles-success', {
    registryRevision: 2,
    activeId: 'work-1',
    list: [{ id: 'work-1', name: 'Work' }, { id: 'old', name: 'Old', archived: true }],
    limits: { max: 5 },
    includeArchived: true,
  })
  const loaded = store.getSnapshot().profiles
  assert.deepEqual(loaded.limits, { max: 5 })
  assert.deepEqual(loaded.list.map((profile) => profile.id), ['work-1'])
  assert.deepEqual(loaded.archivedList.map((profile) => profile.id), ['old'])

  // A plain switcher refresh replaces the unarchived rows but must not drop the
  // archived rows the manage dialog is showing (SPEC §9.5).
  store.dispatch('profiles-success', {
    registryRevision: 3,
    activeId: 'work-1',
    list: [{ id: 'work-1', name: 'Work' }],
  })
  const refreshed = store.getSnapshot().profiles
  assert.deepEqual(refreshed.list.map((profile) => profile.id), ['work-1'])
  assert.deepEqual(refreshed.archivedList.map((profile) => profile.id), ['old'])
  assert.deepEqual(refreshed.limits, { max: 5 }, 'a host without limits keeps the last known cap')

  store.dispatch('profiles-unavailable')
  assert.deepEqual(store.getSnapshot().profiles.archivedList, [])
})

test('profile preview state opens, turns stale and clears on confirmation', () => {
  const store = createStore({ storage: fakeStorage() })
  const targetDoc = { version: 1, revision: 2, groups: [], ungrouped: [] }
  store.dispatch('profile-preview-start', { targetId: 'work-1', targetName: 'Work' })
  assert.equal(store.getSnapshot().profilePreview.loading, true)
  assert.equal(store.getSnapshot().profilePreview.targetId, 'work-1')

  store.dispatch('profile-preview-success', {
    targetId: 'work-1',
    targetName: 'Work',
    targetRevision: 2,
    previewToken: 'tok',
    doc: targetDoc,
    diff: { summary: {} },
    baseActiveId: 'default',
    baseActiveRevision: 1,
  })
  const preview = store.getSnapshot().profilePreview
  assert.equal(preview.open, false)
  assert.equal(preview.loading, false)
  assert.equal(preview.previewToken, 'tok')
  assert.equal(preview.doc, targetDoc)
  assert.equal(preview.baseActiveId, 'default')
  assert.equal(preview.baseActiveRevision, 1)
  assert.equal(preview.error, null)

  store.dispatch('profile-preview-open')
  assert.equal(store.getSnapshot().profilePreview.open, true)
  store.dispatch('profile-preview-stale', { message: 'changed' })
  assert.equal(store.getSnapshot().profilePreview.stale, true)
  assert.equal(store.getSnapshot().profilePreview.error.code, 'preview-stale')

  store.dispatch('profile-preview-close')
  assert.deepEqual(store.getSnapshot().profilePreview, {
    open: false,
    loading: false,
    targetId: null,
    targetName: null,
    targetRevision: null,
    previewToken: null,
    doc: null,
    diff: null,
    baseActiveId: null,
    baseActiveRevision: null,
    error: null,
    stale: false,
  })
})

test('initial load records profileId without an epoch bump', () => {
  const store = createStore({ storage: fakeStorage() })
  const doc = { version: 1, revision: 4, groups: [], ungrouped: [] }
  store.dispatch('load-success', { doc, revision: 4, profileId: 'work-1' })
  assert.equal(store.getSnapshot().profileId, 'work-1')
  assert.equal(store.getSnapshot().profiles.activeId, 'work-1')
  assert.equal(store.getSnapshot().profileEpoch, 0)
  assert.equal(store.getSnapshot().latestSeenRevision, 0)
})

test('a load that reveals another profile resets epoch, revision and interactions', () => {
  const storage = fakeStorage({
    [COLLAPSED_KEY]: JSON.stringify({ 'work-1': { g1: true } }),
  })
  const store = createStore({ storage })
  const base = { version: 1, revision: 2, groups: [], ungrouped: [] }
  store.dispatch('load-success', { doc: base, revision: 2, profileId: 'default' })
  store.dispatch('external-revision', { latestSeenRevision: 9 })
  store.dispatch('menu', { menu: { kind: 'group', groupId: 'g1' } })

  const target = { version: 1, revision: 3, groups: [{ id: 'g1' }], ungrouped: [] }
  store.dispatch('load-success', { doc: target, revision: 3, profileId: 'work-1' })
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.profileId, 'work-1')
  assert.equal(snapshot.profiles.activeId, 'work-1')
  assert.equal(snapshot.profileEpoch, 1)
  assert.equal(snapshot.latestSeenRevision, 0)
  assert.equal(snapshot.doc, target)
  assert.equal(snapshot.lastConfirmed, target)
  assert.deepEqual(snapshot.collapsed, { g1: true })
  assert.equal(snapshot.menu, null)
})

test('profile switch success applies the response doc and resets switch state', () => {
  const storage = fakeStorage({
    [COLLAPSED_KEY]: JSON.stringify({ 'work-1': { g9: true } }),
  })
  const store = createStore({ storage })
  const base = { version: 1, revision: 3, groups: [], ungrouped: [] }
  store.dispatch('load-success', { doc: base, revision: 3, profileId: 'default' })
  store.dispatch('optimistic-doc', { doc: { ...base, groups: [{ id: 'optimistic' }] } })
  store.dispatch('external-revision', { latestSeenRevision: 12 })
  store.dispatch('banner', { banner: { kind: 'error', code: 'io' } })
  store.dispatch('profile-switch-start', { targetId: 'work-1' })
  assert.equal(store.getSnapshot().profileSwitching, true)

  const target = { version: 1, revision: 5, groups: [{ id: 'g1' }], ungrouped: [] }
  store.dispatch('profile-switch-success', {
    profileId: 'work-1',
    doc: target,
    revision: 5,
    registryRevision: 7,
  })
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.profileSwitching, false)
  assert.equal(snapshot.profileEpoch, 1)
  assert.equal(snapshot.latestSeenRevision, 0)
  assert.equal(snapshot.optimistic, false)
  assert.equal(snapshot.doc, target)
  assert.equal(snapshot.revision, 5)
  assert.equal(snapshot.lastConfirmed, target)
  assert.equal(snapshot.warning, null)
  assert.equal(snapshot.banner, null)
  assert.equal(snapshot.profileId, 'work-1')
  assert.equal(snapshot.profiles.activeId, 'work-1')
  assert.equal(snapshot.profiles.registryRevision, 7)
  assert.deepEqual(snapshot.collapsed, { g9: true })
  assert.equal(snapshot.profilePreview.open, false)
})

test('profile external active bumps the epoch once, clears the doc queue and keeps the old doc off-confirmed', () => {
  const store = createStore({ storage: fakeStorage() })
  const base = { version: 1, revision: 3, groups: [], ungrouped: [] }
  store.dispatch('load-success', { doc: base, revision: 3, profileId: 'default' })
  store.dispatch('optimistic-doc', { doc: { ...base, groups: [{ id: 'x' }] } })
  store.dispatch('external-revision', { latestSeenRevision: 8 })
  store.dispatch('profile-preview-start', { targetId: 'work-1' })
  store.dispatch('profile-switch-start', { targetId: 'work-1' })
  store.dispatch('dialog', { dialog: { kind: 'profile-preview' } })

  store.dispatch('profile-external-active', { activeId: 'work-1', registryRevision: 6 })
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.profileEpoch, 1)
  assert.equal(snapshot.latestSeenRevision, 0)
  assert.equal(snapshot.profileSwitching, false)
  assert.equal(snapshot.profiles.activeId, 'work-1')
  assert.equal(snapshot.profiles.registryRevision, 6)
  assert.equal(snapshot.optimistic, false)
  assert.equal(snapshot.lastConfirmed, null)
  assert.equal(snapshot.docState, 'loading')
  assert.equal(snapshot.doc, base, 'the previous doc stays until /load answers')
  assert.equal(snapshot.dialog, null)
  assert.equal(snapshot.profilePreview.targetId, null)

  const deduped = store.getSnapshot()
  store.dispatch('profile-external-active', { activeId: 'work-1' })
  assert.equal(store.getSnapshot(), deduped, 'a repeated active event is a no-op')
})

test('external revisions advance only through the store action monotonic max', () => {
  const store = createStore({ storage: fakeStorage() })
  store.dispatch('external-revision', { latestSeenRevision: 4 })
  assert.equal(store.getSnapshot().latestSeenRevision, 4)
  store.dispatch('external-revision', { latestSeenRevision: 2 })
  assert.equal(store.getSnapshot().latestSeenRevision, 4)
  store.dispatch('external-revision', { latestSeenRevision: 7 })
  assert.equal(store.getSnapshot().latestSeenRevision, 7)
})

test('a load after a passive active event does not bump the epoch a second time', () => {
  const storage = fakeStorage({
    [COLLAPSED_KEY]: JSON.stringify({ 'work-1': { g1: true } }),
  })
  const store = createStore({ storage })
  const base = { version: 1, revision: 1, groups: [], ungrouped: [] }
  store.dispatch('load-success', { doc: base, revision: 1, profileId: 'default' })
  store.dispatch('profile-external-active', { activeId: 'work-1', registryRevision: 4 })
  assert.equal(store.getSnapshot().profileEpoch, 1)

  const target = { version: 1, revision: 2, groups: [{ id: 'g1' }], ungrouped: [] }
  store.dispatch('load-success', { doc: target, revision: 2, profileId: 'work-1' })
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.profileEpoch, 1, 'one active change -> one epoch increment')
  assert.equal(snapshot.profileId, 'work-1')
  assert.deepEqual(snapshot.collapsed, { g1: true })
  assert.equal(snapshot.docState, 'ready')
})

test('collapsed expansion is scoped per profile and survives profile switches', () => {
  const storage = fakeStorage()
  const store = createStore({ storage })
  const defaultDoc = { version: 1, revision: 1, groups: [], ungrouped: [] }
  const workDoc = { version: 1, revision: 1, groups: [], ungrouped: [] }

  store.dispatch('load-success', { doc: defaultDoc, revision: 1, profileId: 'default' })
  store.dispatch('collapse-group', { id: 'default-group' })
  assert.deepEqual(store.getSnapshot().collapsed, { 'default-group': true })

  store.dispatch('profile-switch-success', { profileId: 'work-1', doc: workDoc, revision: 1 })
  assert.deepEqual(store.getSnapshot().collapsed, {}, 'another profile starts expanded')
  store.dispatch('collapse-group', { id: 'work-group' })
  store.dispatch('collapse-group', { id: 'work-group-2' })
  assert.deepEqual(store.getSnapshot().collapsed, { 'work-group': true, 'work-group-2': true })

  // Only the active profile is touched by a write; both maps coexist.
  const table = JSON.parse(storage.getItem(COLLAPSED_KEY))
  assert.deepEqual(table, {
    default: { 'default-group': true },
    'work-1': { 'work-group': true, 'work-group-2': true },
  })

  store.dispatch('reset-collapsed')
  assert.deepEqual(store.getSnapshot().collapsed, {})
  const resetTable = JSON.parse(storage.getItem(COLLAPSED_KEY))
  assert.deepEqual(resetTable, { default: { 'default-group': true } })

  store.dispatch('profile-switch-success', { profileId: 'default', doc: defaultDoc, revision: 2 })
  assert.deepEqual(store.getSnapshot().collapsed, { 'default-group': true })
})

test('legacy flat collapsed values migrate to the default profile on the next write', () => {
  const storage = fakeStorage({ [COLLAPSED_KEY]: JSON.stringify({ g1: true }) })
  const store = createStore({ storage })
  assert.deepEqual(store.getSnapshot().collapsed, { g1: true })

  store.dispatch('collapse-group', { id: 'g2' })
  const table = JSON.parse(storage.getItem(COLLAPSED_KEY))
  assert.deepEqual(table, { default: { g1: true, g2: true } })

  // A fresh store now reads the same scoped value through the default profile.
  const reopened = createStore({ storage })
  assert.deepEqual(reopened.getSnapshot().collapsed, { g1: true, g2: true })

  reopened.dispatch('load-success', {
    doc: { version: 1, revision: 0, groups: [], ungrouped: [] },
    revision: 0,
    profileId: 'work-1',
  })
  assert.deepEqual(reopened.getSnapshot().collapsed, {}, 'the work profile has no collapsed ids')
  reopened.dispatch('collapse-group', { id: 'w1' })
  assert.deepEqual(JSON.parse(storage.getItem(COLLAPSED_KEY)), {
    default: { g1: true, g2: true },
    'work-1': { w1: true },
  })
})

test('switching profiles does not rewrite another profile collapsed map', () => {
  const storage = fakeStorage({ [COLLAPSED_KEY]: JSON.stringify({ default: { g1: true } }) })
  const store = createStore({ storage })
  const before = storage.getItem(COLLAPSED_KEY)
  const target = { version: 1, revision: 1, groups: [], ungrouped: [] }
  store.dispatch('profile-switch-success', { profileId: 'work-1', doc: target, revision: 1 })
  assert.equal(storage.getItem(COLLAPSED_KEY), before)
})
