import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { installClientRuntime } from '../../src/adapters/client-runtime.js'

// Map the host React peer to a test-only stub before importing UI modules.
// The loader is scoped to this test file/process and never touches src or lib.
register(new URL('../support/react-loader.mjs', import.meta.url))

const flatten = (node, out = []) => {
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
  } else if (node && typeof node === 'object') {
    if (node.type) out.push(node)
    if (node.props && 'children' in node.props) flatten(node.props.children, out)
  }
  return out
}
const byTestId = (tree, id) => flatten(tree).find((node) => node.props?.['data-testid'] === id)
const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  if (!node.type) return node
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
}

const uiModules = [
  'components.js',
  'components-header.js',
  'components-profiles.js',
  'components-rows.js',
  'components-primitives.js',
  'components-ungrouped.js',
  'components-search-box.js',
  'components-resize-handle.js',
  'dialog-host.js',
  'session-menu.js',
  'scroll-area.js',
  'group-list-picker.js',
  'groups-view-width.js',
  'groups-view-search.js',
  'groups-view-state.js',
  'plugin-locale.js',
  'icons.js',
  'floating-label.js',
  'time.js',
  'state.js',
]

test('client UI modules execute under a test React peer', async () => {
  assert.equal(uiModules.length, 20)
  for (const file of uiModules) {
    const module = await import(new URL(`../../src/client/${file}`, import.meta.url))
    assert.ok(module && typeof module === 'object', `${file} did not load`)
    assert.ok(Object.keys(module).length > 0, `${file} exported nothing`)
  }
  const components = await import(new URL('../../src/client/components.js', import.meta.url))
  const dialogs = await import(new URL('../../src/client/dialog-host.js', import.meta.url))
  const menus = await import(new URL('../../src/client/session-menu.js', import.meta.url))
  assert.equal(typeof components.GroupsView, 'function')
  assert.equal(typeof dialogs.DialogHost, 'function')
  assert.equal(typeof menus.MenuPopover, 'function')
})


test('OnboardingCard renders localized copy and invokes create/dismiss', async () => {
  const { OnboardingCard } = await import(new URL('../../src/client/components-header.js', import.meta.url))
  const calls = []
  const tree = OnboardingCard({
    t: (key) => 'T:' + key,
    onCreate: () => calls.push('create'),
    onDismiss: () => calls.push('dismiss'),
  })
  assert.equal(tree.props.class, 'dsg-onboarding')
  assert.match(flatten(tree).map((node) => node.props?.children).filter((child) => typeof child === 'string').join(' '), /T:onboarding\.title/)
  byTestId(tree, 'session-groups-onboarding-create').props.onClick({ stopPropagation() {} })
  byTestId(tree, 'session-groups-onboarding-dismiss').props.onClick({ stopPropagation() {} })
  assert.deepEqual(calls, ['create', 'dismiss'])
})

test('Banner renders retry/dismiss wiring through the command runtime', async () => {
  const calls = []
  installClientRuntime({
    t: (key) => (key === 'banner.load-failed' ? 'Load failed' : key),
    store: { dispatch: (action, payload) => calls.push([action, payload]) },
  })
  const { Banner } = await import(new URL('../../src/client/components-header.js', import.meta.url))
  const tree = Banner({
    store: { banner: { kind: 'error', code: 'load-failed' } },
    handlers: { retryLoad: () => calls.push('retry') },
  })
  assert.equal(tree.props['data-testid'], 'session-groups-banner')
  byTestId(tree, 'session-groups-banner-retry').props.onClick({ stopPropagation() {} })
  byTestId(tree, 'session-groups-banner-dismiss').props.onClick({ stopPropagation() {} })
  assert.equal(calls[0], 'retry')
  assert.deepEqual(calls[1], ['banner', { banner: null }])
})

test('Rail renders the expand action and Toast renders only an active toast', async () => {
  installClientRuntime({ t: (key) => 'T:' + key })
  const { Rail } = await import(new URL('../../src/client/components-header.js', import.meta.url))
  const { Toast } = await import(new URL('../../src/client/session-menu.js', import.meta.url))
  let expanded = 0
  const rail = Rail({ props: { expandSidebar: () => { expanded += 1 } } })
  byTestId(rail, 'session-groups-rail-expand').props.onClick()
  assert.equal(expanded, 1)
  assert.equal(Toast({ store: { toast: null } }), null)
  const toast = Toast({ store: { toast: { message: 'saved' } } });
  assert.equal(toast.props['data-testid'], 'session-groups-toast')
  assert.equal(toast.props.children, 'saved')
})

test('VirtualSpacer is deterministic and null-state surfaces return null', async () => {
  const { VirtualSpacer } = await import(new URL('../../src/client/components-ungrouped.js', import.meta.url))
  const { DialogHost } = await import(new URL('../../src/client/dialog-host.js', import.meta.url))
  const { MenuPopover } = await import(new URL('../../src/client/session-menu.js', import.meta.url))
  const spacer = VirtualSpacer({ height: 37.6, position: 'top' })
  assert.equal(spacer.props.style.height, '38px')
  assert.equal(spacer.props['data-position'], 'top')
  assert.equal(MenuPopover({ store: { menu: null }, handlers: {} }), null)
  assert.equal(DialogHost({ store: { dialog: null }, props: {} }), null)
})


test('SessionRow renders title/status and wires open/archive/menu handlers', async () => {
  installClientRuntime({
    t: (key) => 'T:' + key,
    capabilities: { archive: true, unarchive: true },
    notify: (payload) => calls.push(['notify', payload]),
  })
  const calls = []
  const handlers = {
    openSession: (id) => calls.push(['open', id]),
    onSessionContextMenu: () => {},
    openSessionMenuAtRow: () => {},
    onDragStart: () => {},
    onDragEnd: () => {},
    onDragOverSession: () => {},
    onDragLeave: () => {},
    onDropSession: () => {},
    archiveSession: (id) => calls.push(['archive', id]),
    unarchiveSession: () => {},
    openSessionMenu: () => calls.push(['menu']),
  }
  const { SessionRow } = await import(new URL('../../src/client/components-rows.js', import.meta.url))
  const sessionNode = {
    session: { id: 's1', updatedAt: Date.now(), blank: false },
    archived: false,
    status: null,
    workspace: null,
    runningSubagentCount: 0,
  }
  const tree = SessionRow({ sessionNode, depth: 1, groupId: 'g1', props: {}, handlers, store: { currentSessionId: null } })
  const row = byTestId(tree, 'session-groups-session')
  assert.equal(row.props['data-session-id'], 's1')
  assert.match(row.props.title, /T:session\.untitled|Session/)
  row.props.onClick()
  byTestId(tree, 'session-groups-session-archive').props.onClick({ stopPropagation() {} })
  byTestId(tree, 'session-groups-session-menu').props.onClick({ stopPropagation() {} })
  assert.deepEqual(calls, [['open', 's1'], ['archive', 's1'], ['menu']])
})

test('SessionRow archived click reports through the command runtime instead of throwing', async () => {
  const notices = []
  installClientRuntime({ t: (key) => key, capabilities: { unarchive: false }, notify: (payload) => notices.push(payload) })
  const { SessionRow } = await import(new URL('../../src/client/components-rows.js', import.meta.url))
  const sessionNode = { session: { id: 's2', updatedAt: Date.now(), blank: false }, archived: true, status: null }
  const tree = SessionRow({ sessionNode, depth: 0, groupId: null, ungrouped: true, props: {}, handlers: {}, store: {} })
  tree.props.onClick()
  assert.equal(notices.length, 1)
  assert.equal(notices[0].kind, 'error')
})

test('GroupNode renders header metadata and wires click/menu handlers', async () => {
  const calls = []
  installClientRuntime({ t: (key) => 'T:' + key })
  const handlers = new Proxy({}, { get: (_target, prop) => (...args) => calls.push([String(prop), ...args]) })
  const { GroupNode } = await import(new URL('../../src/client/components-rows.js', import.meta.url))
  const doc = { groups: [{ id: 'g1', name: 'Group one', icon: 'folder', color: 'blue', parentId: null, sessionIds: [] }], ungrouped: [] }
  const node = { group: doc.groups[0], children: [], visibleCount: 0, emptyVisible: true }
  const tree = GroupNode({
    node,
    depth: 0,
    props: {},
    handlers,
    store: { doc, collapsed: {}, dropTarget: null, draggedGroupId: null },
  })
  const row = byTestId(tree, 'session-groups-group')
  assert.equal(row.props['data-group-id'], 'g1')
  assert.equal(byTestId(tree, 'session-groups-group-count').props.children, 0)
  row.props.onClick()
  byTestId(tree, 'session-groups-group-menu').props.onClick({ stopPropagation() {} })
  assert.deepEqual(calls.map((entry) => entry[0]), ['onGroupClick', 'openGroupMenu'])
})


test('MenuPopover renders a group menu and dispatches an item through handlers', async () => {
  const calls = []
  installClientRuntime({ t: (key) => 'T:' + key, capabilities: { fork: () => false } })
  const { MenuPopover } = await import(new URL('../../src/client/session-menu.js', import.meta.url))
  const handlers = new Proxy({}, { get: (_target, prop) => (...args) => calls.push([String(prop), ...args]) })
  const doc = { groups: [{ id: 'g1', name: 'Group one', icon: 'folder', color: 'blue', parentId: null, sessionIds: [] }], ungrouped: [] }
  const tree = MenuPopover({ store: { doc, menu: { kind: 'group', groupId: 'g1', x: 10, y: 20, anchorX: 10, anchorY: 20 } }, handlers })
  assert.equal(tree.props['data-menu-kind'], 'group')
  assert.equal(tree.props['data-source-id'], 'g1')
  const newSession = byTestId(tree, 'session-groups-group-new-session')
  newSession.props.onClick({ stopPropagation() {} })
  assert.deepEqual(calls[0], ['closeMenu'])
  assert.deepEqual(calls[1], ['openNewSession', null, 'g1'])
})

test('DialogHost renders a new-group dialog from non-null store state', async () => {
  installClientRuntime({ t: (key) => 'T:' + key })
  const { DialogHost } = await import(new URL('../../src/client/dialog-host.js', import.meta.url))
  const tree = DialogHost({ store: { dialog: { kind: 'new-group', titleKey: 'dialog.newGroup', parentId: null } }, props: {} })
  assert.ok(byTestId(tree, 'session-groups-dialog'))
  assert.ok(byTestId(tree, 'session-groups-dialog-input'))
  assert.equal(byTestId(tree, 'session-groups-dialog-confirm').props.children, 'T:dialog.confirm')
})

test('FlatFallback renders session rows and retry/return actions', async () => {
  let retried = 0
  let mode = null
  installClientRuntime({ t: (key) => 'T:' + key, retryLoad: () => { retried += 1 }, setMode: (next) => { mode = next }, actions: { openSession: () => {} } })
  const { FlatFallback } = await import(new URL('../../src/client/components-header.js', import.meta.url))
  const tree = FlatFallback({
    store: {},
    reason: 'route-unavailable',
    props: {
      useSessions: () => ({ ids: ['s1'], byId: { s1: { id: 's1', title: 'Session', origin: 'user' } } }),
      useWorkspaces: () => ({ items: [] }),
    },
  })
  assert.equal(tree.props['data-reason'], 'route-unavailable')
  assert.equal(byTestId(tree, 'session-groups-session').props['data-session-id'], 's1')
  byTestId(tree, 'session-groups-flat-retry').props.onClick({ stopPropagation() {} })
  byTestId(tree, 'session-groups-return').props.onClick({ stopPropagation() {} })
  assert.equal(retried, 1)
  assert.equal(mode, 'workspace')
})


test('Header renders title/status counts/options and wires new-group/toggle', async () => {
  const calls = []
  installClientRuntime({
    t: (key) => 'T:' + key,
    toggleMode: () => calls.push('toggle'),
  })
  const { Header } = await import(new URL('../../src/client/components-header.js', import.meta.url))
  const handlers = new Proxy({}, { get: (_target, prop) => (...args) => calls.push([String(prop), ...args]) })
  const tree = expand(Header({
    store: { archiveFilter: 'hidden', viewMode: 'groups' },
    handlers,
    sessionsById: {},
    workspaces: [],
    archivedSessionIds: [],
    runningSessions: { count: 2, sections: [] },
    blockedSessions: { count: 0, sections: [] },
    unreadSessions: { count: 1, sections: [] },
  }))
  assert.equal(tree.props['data-testid'], 'session-groups-header')
  assert.match(JSON.stringify(tree), /T:view\.title/)
  assert.equal(byTestId(tree, 'session-groups-running-button').props['data-count'], '2')
  assert.equal(byTestId(tree, 'session-groups-blocked-button').props['data-count'], '0')
  assert.equal(byTestId(tree, 'session-groups-view-options').props['data-filter'], 'hidden')
  byTestId(tree, 'session-groups-new-group').props.onClick({ stopPropagation() {} })
  byTestId(tree, 'session-groups-toggle').props.onClick({ stopPropagation() {} })
  assert.equal(calls[0][0], 'openNewGroup')
  assert.equal(calls[0][2], null)
  assert.equal(calls[1], 'toggle')
})

test('SessionRow renders current/running/archived data attributes', async () => {
  installClientRuntime({ t: (key) => 'T:' + key, capabilities: { archive: true, unarchive: true } })
  const { SessionRow } = await import(new URL('../../src/client/components-rows.js', import.meta.url))
  const handlers = new Proxy({}, { get: () => () => {} })
  const sessionNode = {
    session: { id: 's-running', updatedAt: Date.now(), blank: false },
    archived: false,
    status: { running: true },
    workspace: null,
    runningSubagentCount: 1,
  }
  const tree = SessionRow({ sessionNode, depth: 0, groupId: 'g1', props: {}, handlers, store: { currentSessionId: 's-running' } })
  assert.equal(tree.props['data-current'], 'true')
  assert.equal(tree.props['data-archived'], 'false')
  assert.equal(tree.props['data-depth'], '0')
  assert.match(tree.props.class, /dsg-session-row/)
})


test('MenuPopover renders a session menu with fork/archive/copy actions', async () => {
  const calls = []
  installClientRuntime({ t: (key) => 'T:' + key, capabilities: { fork: () => true } })
  const { MenuPopover } = await import(new URL('../../src/client/session-menu.js', import.meta.url))
  const handlers = new Proxy({}, { get: (_target, prop) => (...args) => calls.push([String(prop), ...args]) })
  const doc = { groups: [{ id: 'g1', name: 'G', icon: 'folder', color: 'blue', parentId: null, sessionIds: ['s1'] }], ungrouped: [] }
  const tree = MenuPopover({ store: { doc, menu: { kind: 'session', sessionId: 's1', title: 'Session', archived: false, blank: false, x: 10, y: 20 } }, handlers })
  assert.equal(tree.props['data-menu-kind'], 'session')
  assert.equal(tree.props['data-source-id'], 's1')
  const labels = flatten(tree).map((node) => node.props?.children).filter((child) => typeof child === 'string')
  assert.ok(labels.includes('T:session.fork'))
  assert.ok(labels.includes('T:session.copyId'))
  const rename = flatten(tree).find((node) => node.props?.children === 'T:session.rename')
  rename.props.onClick({ stopPropagation() {} })
  assert.deepEqual(calls[0], ['closeMenu'])
  assert.deepEqual(calls[1], ['openRenameSession', 's1', 'Session'])
})

test('DialogHost renders a rename-group dialog with a non-null title input', async () => {
  installClientRuntime({ t: (key) => 'T:' + key })
  const { DialogHost } = await import(new URL('../../src/client/dialog-host.js', import.meta.url))
  const doc = { groups: [{ id: 'g1', name: 'Group one', icon: 'folder', color: 'blue', parentId: null, sessionIds: [] }], ungrouped: [] }
  const tree = DialogHost({ store: { doc, dialog: { kind: 'rename-group', groupId: 'g1', titleKey: 'dialog.renameGroup', value: 'Group one' } }, props: {} })
  const dialog = byTestId(tree, 'session-groups-dialog')
  assert.ok(dialog)
  assert.equal(dialog.props['data-kind'], 'rename-group')
  assert.ok(byTestId(tree, 'session-groups-dialog-input'))
  assert.equal(byTestId(tree, 'session-groups-dialog-cancel').props.children, 'T:dialog.cancel')
})

// ---------------------------------------------------------------------------
// Profiles (SPEC §9.1-§9.3, §9.6)
// ---------------------------------------------------------------------------
const profileSnapshot = (overrides = {}) => ({
  doc: { groups: [], ungrouped: [] },
  profileId: 'default',
  profiles: {
    available: true,
    loading: false,
    degraded: false,
    activeId: 'default',
    list: [
      { id: 'default', name: 'Default', groupCount: 2, sessionCount: 5, healthy: true },
      { id: 'work', name: 'Work', groupCount: 1, sessionCount: 0, healthy: true },
    ],
    error: null,
  },
  profilePreview: { open: false, loading: false, targetId: null, targetName: null, previewToken: null, doc: null, diff: null, stale: false, error: null },
  profileSwitching: false,
  ...overrides,
})

test('ProfileMenu renders the chevron trigger only with the profile surface', async () => {
  installClientRuntime({ t: (key) => 'T:' + key })
  const { ProfileMenu } = await import(new URL('../../src/client/components-profiles.js', import.meta.url))
  assert.equal(ProfileMenu({ store: { profiles: { available: false } }, handlers: {} }), null)
  assert.equal(ProfileMenu({ store: {}, handlers: {} }), null)
  const base = profileSnapshot()
  const trigger = byTestId(ProfileMenu({ store: base, handlers: {}, open: false, onOpenChange: () => {} }), 'session-groups-profile-trigger')
  assert.ok(trigger)
  assert.equal(trigger.props['aria-haspopup'], 'menu')
  assert.equal(trigger.props['aria-expanded'], 'false')
  assert.equal(trigger.props['aria-label'], 'T:profiles.open')
  assert.equal(trigger.props.type, 'button')
  const opened = ProfileMenu({ store: base, handlers: {}, open: true, onOpenChange: () => {} })
  assert.equal(byTestId(opened, 'session-groups-profile-trigger').props['aria-expanded'], 'true')
  assert.ok(byTestId(expand(opened), 'session-groups-profile-popover'))
})

test('Header places the profile chevron after the title label', async () => {
  installClientRuntime({ t: (key) => 'T:' + key, toggleMode: () => {} })
  const { Header } = await import(new URL('../../src/client/components-header.js', import.meta.url))
  const handlers = new Proxy({}, { get: () => () => {} })
  const tree = expand(
    Header({
      store: { ...profileSnapshot(), archiveFilter: 'hidden', viewMode: 'groups' },
      handlers,
      sessionsById: {},
      workspaces: [],
      archivedSessionIds: [],
      runningSessions: { count: 0, sections: [] },
      blockedSessions: { count: 0, sections: [] },
      unreadSessions: { count: 0, sections: [] },
    })
  )
  const trigger = byTestId(tree, 'session-groups-profile-trigger')
  assert.ok(trigger)
  assert.equal(trigger.props['aria-label'], 'T:profiles.open')
  const title = byTestId(tree, 'session-groups-header').props.children[0]
  assert.equal(title.props.class, 'dsg-header-row')
  assert.equal(title.props.children[0].props.class, 'dsg-header-title')
  assert.equal(title.props.children[0].props.children[0].props.class, 'dsg-header-label')
})

test('ProfilePopover marks the active row, shows counts and disables items while switching', async () => {
  installClientRuntime({
    t: (key, params) =>
      key === 'profiles.counts' && params ? `${key}:${params.groups}/${params.sessions}` : 'T:' + key,
  })
  const { ProfilePopover } = await import(new URL('../../src/client/components-profiles.js', import.meta.url))
  const calls = []
  const store = profileSnapshot()
  const tree = ProfilePopover({
    store,
    handlers: { switchProfile: (id) => calls.push(id) },
    onClose: () => calls.push('close'),
  })
  const items = flatten(tree).filter((node) => node.props?.['data-testid'] === 'session-groups-profile-item')
  assert.equal(items.length, 2)
  assert.equal(items[0].props['aria-checked'], 'true')
  assert.equal(items[1].props['aria-checked'], 'false')
  assert.equal(items[0].props['data-active'], 'true')
  const counts = flatten(tree)
    .map((node) => node.props?.children)
    .filter((child) => typeof child === 'string')
  assert.ok(counts.includes('profiles.counts:2/5'))
  assert.ok(counts.includes('profiles.counts:1/0'))
  items[1].props.onClick({ stopPropagation() {} })
  assert.deepEqual(calls, ['close', 'work'])
  const switchingTree = ProfilePopover({
    store: profileSnapshot({ profileSwitching: true }),
    handlers: { switchProfile: () => calls.push('unexpected') },
    onClose: () => {},
  })
  const switchingItems = flatten(switchingTree).filter(
    (node) => node.props?.['data-testid'] === 'session-groups-profile-item'
  )
  assert.equal(switchingItems[0].props.disabled, true)
  assert.equal(switchingItems[0].props['data-disabled'], 'true')
  switchingItems[0].props.onClick({ stopPropagation() {} })
  assert.deepEqual(calls, ['close', 'work'])
})

test('ProfilePopover surfaces degraded/error/loading states', async () => {
  installClientRuntime({ t: (key) => 'T:' + key })
  const { ProfilePopover } = await import(new URL('../../src/client/components-profiles.js', import.meta.url))
  const degraded = ProfilePopover({
    store: profileSnapshot({
      profiles: { ...profileSnapshot().profiles, degraded: true, error: { code: 'io' }, loading: true },
    }),
    handlers: {},
    onClose: () => {},
  })
  assert.ok(byTestId(degraded, 'session-groups-profile-degraded'))
  assert.ok(byTestId(degraded, 'session-groups-profile-error'))
  const empty = ProfilePopover({
    store: profileSnapshot({ profiles: { ...profileSnapshot().profiles, list: [], loading: true } }),
    handlers: {},
    onClose: () => {},
  })
  assert.ok(byTestId(empty, 'session-groups-profile-loading'))
  assert.equal(byTestId(empty, 'session-groups-profile-loading').props['data-loading'], 'true')
})

const previewDiff = (overrides = {}) => ({
  summary: {
    groups: { current: 2, target: 3, added: 1, removed: 1, changed: 1, reordered: true },
    grouped: { current: 4, target: 5 },
    ungrouped: { current: 2, target: 1 },
    sessions: { moved: 1, newlyGrouped: 1, ungrouped: 2, stale: 1 },
  },
  groups: { added: ['New group'], removed: ['Old group'], changed: [{ id: 'g', from: 'A', to: 'B' }], reordered: true },
  sessions: {
    moved: [{ sessionId: 's1', from: 'A', to: 'B' }],
    newlyGrouped: [{ sessionId: 's2', to: 'B' }],
    ungrouped: [{ sessionId: 's3', from: 'A' }],
    stale: ['s4'],
  },
  truncated: { groups: false, sessions: false },
  ...overrides,
})

test('ProfilePreviewBody renders summary, ungrouped warning and change sections', async () => {
  const t = (key) => 'T:' + key
  const { ProfilePreviewBody } = await import(new URL('../../src/client/components-profiles.js', import.meta.url))
  const store = profileSnapshot({
    profilePreview: {
      open: true,
      loading: false,
      targetId: 'work',
      targetName: 'Work',
      previewToken: 'token',
      doc: null,
      diff: previewDiff(),
      stale: false,
      error: null,
    },
  })
  const tree = ProfilePreviewBody({ store, t, byId: { s1: { id: 's1', title: 'Session one' } } })
  assert.equal(tree.props['data-testid'], 'session-groups-profile-preview')
  assert.match(JSON.stringify(tree), /T:profiles\.previewSubtitle/)
  assert.ok(byTestId(tree, 'session-groups-profile-preview-summary'))
  assert.ok(byTestId(tree, 'session-groups-profile-preview-warning'))
  const sections = flatten(tree)
    .filter((node) => node.props?.['data-section'])
    .map((node) => node.props['data-section'])
  assert.deepEqual(sections, ['groups', 'sessions', 'stale'])
  const text = JSON.stringify(tree)
  assert.match(text, /2 → 3/)
  assert.match(text, /4 → 5/)
  assert.match(text, /Session one/)
  assert.match(text, /T:profiles\.preview\.ungroupedWarning/)
  assert.match(text, /T:profiles\.preview\.noDelete/)
})

test('ProfilePreviewBody truncates oversized change lists with the remaining count', async () => {
  const t = (key) => 'T:' + key
  const { ProfilePreviewBody } = await import(new URL('../../src/client/components-profiles.js', import.meta.url))
  const added = Array.from({ length: 130 }, (_, index) => `G${index}`)
  const diff = previewDiff({
    summary: {
      groups: { current: 0, target: 130, added: 130, removed: 0, changed: 0, reordered: false },
      grouped: { current: 0, target: 0 },
      ungrouped: { current: 0, target: 0 },
      sessions: { moved: 0, newlyGrouped: 0, ungrouped: 0, stale: 0 },
    },
    groups: { added, removed: [], changed: [], reordered: false },
    sessions: { moved: [], newlyGrouped: [], ungrouped: [], stale: [] },
  })
  const store = profileSnapshot({
    profilePreview: { open: true, loading: false, targetId: 'work', targetName: 'Work', previewToken: 'token', doc: null, diff, stale: false, error: null },
  })
  const tree = ProfilePreviewBody({ store, t, byId: {} })
  const truncated = byTestId(tree, 'session-groups-profile-preview-truncated')
  assert.ok(truncated)
  assert.equal(truncated.props.children, 'T:profiles.preview.truncated')
  const rows = flatten(tree).filter((node) => node.props?.['data-kind'] === 'added')
  assert.equal(rows.length, 100)
})

test('DialogHost renders the profile-preview dialog with its dedicated footer', async () => {
  installClientRuntime({ t: (key) => 'T:' + key, store: { dispatch: () => {} } })
  const { DialogHost } = await import(new URL('../../src/client/dialog-host.js', import.meta.url))
  const store = {
    ...profileSnapshot(),
    profilePreview: {
      open: true,
      loading: false,
      targetId: 'work',
      targetName: 'Work',
      previewToken: 'token',
      doc: null,
      diff: previewDiff(),
      stale: false,
      error: null,
    },
    dialog: { kind: 'profile-preview', targetId: 'work', targetName: 'Work', titleKey: 'profiles.previewTitle' },
  }
  const tree = expand(DialogHost({ store, props: {}, sessionsById: {} }))
  const dialog = byTestId(tree, 'session-groups-dialog')
  assert.equal(dialog.props['data-kind'], 'profile-preview')
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.ok(byTestId(tree, 'session-groups-profile-preview'))
  assert.ok(byTestId(tree, 'session-groups-profile-preview-confirm'))
  assert.ok(byTestId(tree, 'session-groups-profile-preview-cancel'))
  assert.equal(byTestId(tree, 'session-groups-dialog-confirm'), undefined)
  assert.match(JSON.stringify(tree), /T:profiles\.previewTitle/)
})

test('ProfileRecovery offers only healthy profiles when the active one is unhealthy', async () => {
  installClientRuntime({ t: (key) => 'T:' + key, retryLoad: () => {}, refreshProfiles: () => {} })
  const { ProfileRecovery } = await import(new URL('../../src/client/components-profiles.js', import.meta.url))
  const t = (key) => 'T:' + key
  assert.equal(ProfileRecovery({ store: { profiles: { available: false }, banner: { code: 'profile-unhealthy' } }, t }), null)
  assert.equal(
    ProfileRecovery({ store: { profiles: { available: true, list: [] }, banner: { code: 'load-failed' } }, t }),
    null
  )
  const tree = ProfileRecovery({
    store: {
      profiles: {
        available: true,
        list: [
          { id: 'default', name: 'Default', healthy: true },
          { id: 'broken', name: 'Broken', healthy: false },
          { id: 'old', name: 'Old', healthy: true, archived: true },
        ],
      },
      banner: { code: 'profile-unhealthy' },
    },
    t,
  })
  assert.equal(tree.props['data-code'], 'profile-unhealthy')
  const items = flatten(tree).filter((node) => node.props?.['data-testid'] === 'session-groups-profile-recovery-item')
  assert.equal(items.length, 1)
  assert.equal(items[0].props['data-profile-id'], 'default')
  assert.match(JSON.stringify(tree), /T:error\.title/)
  assert.match(JSON.stringify(tree), /T:profiles\.degraded/)
})

test('ProfilePreviewActions disables confirm while stale and cancels through the store', async () => {
  const dispatched = []
  installClientRuntime({ t: (key) => 'T:' + key, store: { dispatch: (action, payload) => dispatched.push([action, payload]) } })
  const { ProfilePreviewActions } = await import(new URL('../../src/client/components-profiles.js', import.meta.url))
  const actions = ProfilePreviewActions({
    store: profileSnapshot({ profilePreview: { ...profileSnapshot().profilePreview, open: true, stale: true } }),
    t: (key) => 'T:' + key,
  })
  const confirm = actions.find((node) => node.props['data-testid'] === 'session-groups-profile-preview-confirm')
  assert.equal(confirm.props.disabled, true)
  assert.equal(confirm.props['data-stale'], 'true')
  assert.equal(confirm.props.children, 'T:profiles.preview.confirm')
  const cancel = actions.find((node) => node.props['data-testid'] === 'session-groups-profile-preview-cancel')
  cancel.props.onClick()
  assert.deepEqual(dispatched, [
    ['dialog', { dialog: null }],
    ['profile-preview-close', undefined],
  ])
  const toggle = flatten(actions).find(
    (node) => node.props?.['data-testid'] === 'session-groups-profile-preview-disable'
  )
  assert.equal(typeof toggle.props.onChange, 'function')
})

test('profile preview preference round-trips through injected storage', async () => {
  const { readProfilePreviewDisabled, writeProfilePreviewDisabled } = await import(
    new URL('../../src/client/components-profiles.js', import.meta.url)
  )
  const memory = {
    value: null,
    getItem() {
      return this.value
    },
    setItem(key, value) {
      this.value = value
    },
    removeItem() {
      this.value = null
    },
  }
  assert.equal(readProfilePreviewDisabled(memory), false)
  writeProfilePreviewDisabled(true, memory)
  assert.equal(memory.value, '0')
  assert.equal(readProfilePreviewDisabled(memory), true)
  writeProfilePreviewDisabled(false, memory)
  assert.equal(memory.value, null)
  assert.equal(readProfilePreviewDisabled(memory), false)
})

test('an empty or identical preview activates directly without a dialog', async () => {
  const { beginProfileSwitch, isPreviewDiffEmpty } = await import(
    new URL('../../src/client/components-profiles.js', import.meta.url)
  )
  assert.equal(isPreviewDiffEmpty(null), true)
  assert.equal(isPreviewDiffEmpty(previewDiff()), false)
  assert.equal(
    isPreviewDiffEmpty({
      summary: {
        groups: { current: 1, target: 1, added: 0, removed: 0, changed: 0, reordered: false },
        grouped: { current: 1, target: 1 },
        ungrouped: { current: 0, target: 0 },
        sessions: { moved: 0, newlyGrouped: 0, ungrouped: 0, stale: 0 },
      },
    }),
    true
  )
  const dispatched = []
  const state = profileSnapshot()
  let activated = null
  installClientRuntime({
    t: (key) => 'T:' + key,
    store: { getSnapshot: () => state, dispatch: (action, payload) => dispatched.push([action, payload]) },
    isPending: () => false,
    notify: () => {},
    previewProfile: async (id) => {
      state.profilePreview = {
        ...state.profilePreview,
        targetId: id,
        targetName: 'Work',
        previewToken: 'token',
        doc: { groups: [], ungrouped: [] },
        diff: {
          summary: {
            groups: { current: 0, target: 0, added: 0, removed: 0, changed: 0, reordered: false },
            grouped: { current: 0, target: 0 },
            ungrouped: { current: 0, target: 0 },
            sessions: { moved: 0, newlyGrouped: 0, ungrouped: 0, stale: 0 },
          },
          groups: { added: [], removed: [], changed: [], reordered: false },
          sessions: { moved: [], newlyGrouped: [], ungrouped: [], stale: [] },
        },
      }
      return { ok: true }
    },
    activateProfile: async (args) => {
      activated = args
      return { ok: true, activeId: args.id, profile: { id: args.id, name: 'Work' }, doc: { revision: 3 } }
    },
  })
  await beginProfileSwitch({ t: (key) => 'T:' + key }, 'work')
  assert.deepEqual(activated, { id: 'work', previewToken: 'token' })
  assert.equal(dispatched.some(([action]) => action === 'profile-preview-open'), false)
  assert.equal(dispatched.some(([action]) => action === 'dialog'), false)
})

test('Toast renders and runs a text action, clearing the toast first', async () => {
  const dispatched = []
  installClientRuntime({
    t: (key) => 'T:' + key,
    store: { dispatch: (action, payload) => dispatched.push([action, payload]) },
  })
  const { Toast } = await import(new URL('../../src/client/session-menu.js', import.meta.url))
  let undone = 0
  const tree = Toast({
    store: {
      toast: {
        kind: 'success',
        message: 'Switched to Work',
        action: { label: 'Undo!', onClick: () => { undone += 1; dispatched.push(['undone']) } },
      },
    },
  })
  assert.equal(byTestId(tree, 'session-groups-toast').props['data-testid'], 'session-groups-toast')
  const action = byTestId(tree, 'session-groups-toast-action')
  assert.equal(action.props.children, 'Undo!')
  action.props.onClick({ stopPropagation() {} })
  assert.equal(undone, 1)
  assert.deepEqual(dispatched[0], ['toast', { toast: null }])
  assert.deepEqual(dispatched[1], ['undone'])
})

