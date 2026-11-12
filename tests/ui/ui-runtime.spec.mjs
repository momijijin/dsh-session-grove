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
const childrenOf = (node) => {
  const children = node?.props?.children
  if (children == null) return []
  return Array.isArray(children) ? children : [children]
}
const childByClass = (node, className) => childrenOf(node).find((child) => child?.props?.class === className)
const textOf = (node) => {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object') return textOf(node.props?.children)
  return ''
}
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
  'profile-switcher.js',
  'profile-preview.js',
  'profile-switch.js',
  'profile-storage.js',
  'components-profile-dialogs.js',
  'components-rows.js',
  'components-primitives.js',
  'components-ungrouped.js',
  'components-search-box.js',
  'components-resize-handle.js',
  'dialog-host.js',
  'session-menu.js',
  'docs-card.js',
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
  assert.equal(uiModules.length, 25)
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


test('OnboardingCard renders localized copy, docs link and create/dismiss', async () => {
  const { OnboardingCard } = await import(new URL('../../src/client/components-header.js', import.meta.url))
  const calls = []
  const tree = OnboardingCard({
    t: (key) => 'T:' + key,
    onCreate: () => calls.push('create'),
    onDismiss: () => calls.push('dismiss'),
    docsHref: 'https://example.test/README.zh.md',
  })
  assert.equal(tree.props.class, 'dsg-onboarding')
  assert.match(flatten(tree).map((node) => node.props?.children).filter((child) => typeof child === 'string').join(' '), /T:onboarding\.title/)
  const docs = byTestId(tree, 'session-groups-onboarding-docs')
  assert.ok(docs, 'docs link renders')
  assert.equal(docs.props.href, 'https://example.test/README.zh.md')
  assert.equal(docs.props.target, '_blank')
  assert.equal(docs.props.children, 'T:onboarding.docs')
  byTestId(tree, 'session-groups-onboarding-create').props.onClick({ stopPropagation() {} })
  byTestId(tree, 'session-groups-onboarding-dismiss').props.onClick({ stopPropagation() {} })
  assert.deepEqual(calls, ['create', 'dismiss'])
})

test('DocsCard links the settings page to the documentation site', async () => {
  installClientRuntime({ t: (key) => 'T:' + key })
  const { DocsCard } = await import(new URL('../../src/client/docs-card.js', import.meta.url))
  const { DOCS_SITE_URL } = await import(new URL('../../src/shared/constants.js', import.meta.url))
  const tree = DocsCard()
  assert.equal(tree.props.class, 'dsg-settings-docs')
  assert.equal(tree.props['data-testid'], 'session-groups-settings-docs')
  const link = byTestId(tree, 'session-groups-settings-docs-link')
  assert.ok(link, 'docs link renders')
  assert.equal(link.props.href, DOCS_SITE_URL)
  assert.equal(link.props.target, '_blank')
  assert.equal(link.props.rel, 'noreferrer noopener')
  assert.equal(link.props.children, 'T:docs.open')
  assert.match(flatten(tree).map((node) => node.props?.children).filter((child) => typeof child === 'string').join(' '), /T:docs\.title/)
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

test('GroupNode marks archived, path-only and ancestor groups structurally locked', async () => {
  installClientRuntime({ t: (key) => 'T:' + key, capabilities: { archive: false, unarchive: false } })
  const { GroupNode, SessionRow } = await import(new URL('../../src/client/components-rows.js', import.meta.url))
  const handlers = new Proxy({}, { get: () => () => {} })
  const doc = {
    groups: [
      { id: 'frozen', name: 'Frozen', icon: 'folder', color: 'blue', parentId: null, sessionIds: ['s1'], archived: true },
      { id: 'ancestor', name: 'Ancestor', icon: 'folder', color: 'blue', parentId: null, sessionIds: [] },
      { id: 'child', name: 'Child', icon: 'folder', color: 'blue', parentId: 'ancestor', sessionIds: [], archived: true },
    ],
    ungrouped: [],
  }
  const store = { doc, collapsed: {}, dropTarget: null, draggedGroupId: null, currentSessionId: null }
  const renderGroup = (node) => GroupNode({ node, depth: 0, props: {}, handlers, store })

  // Effective-archived group: full dim + lock badge, no structural drag.
  const frozenTree = renderGroup({ group: doc.groups[0], children: [], visibleCount: 0, emptyVisible: true, effectiveArchived: true })
  const frozenRow = byTestId(frozenTree, 'session-groups-group')
  assert.equal(frozenRow.props['data-archived'], 'true')
  assert.equal(frozenRow.props['data-path-only'], 'false')
  assert.equal(frozenRow.props['data-contains-archived'], 'false')
  assert.equal(frozenRow.props.draggable, 'false')
  assert.ok(byTestId(frozenTree, 'session-groups-group-archived'))
  assert.equal(byTestId(frozenTree, 'session-groups-group-contains-archived'), undefined)
  assert.equal(byTestId(frozenTree, 'session-groups-group-add').props['aria-disabled'], 'true')

  // pathOnly ancestor: header only, no dim, but a "contains archived" hint and
  // a structural drag lock because moving it would move the frozen subtree.
  const pathTree = renderGroup({ group: doc.groups[1], children: [], visibleCount: 0, emptyVisible: true, pathOnly: true, effectiveArchived: false })
  const pathRow = byTestId(pathTree, 'session-groups-group')
  assert.equal(pathRow.props['data-archived'], 'false')
  assert.equal(pathRow.props['data-path-only'], 'true')
  assert.equal(pathRow.props['data-contains-archived'], 'true')
  assert.equal(pathRow.props.draggable, 'false')
  assert.equal(byTestId(pathTree, 'session-groups-group-archived'), undefined)
  assert.ok(byTestId(pathTree, 'session-groups-group-contains-archived'))

  // A session inside a frozen group reports the container lock, not its own
  // archived flag (§5.4: data-archived means "this session is archived").
  const sessionTree = SessionRow({
    sessionNode: { session: { id: 's1', updatedAt: Date.now(), blank: false }, archived: false, status: null },
    depth: 1,
    groupId: 'frozen',
    structuralLocked: true,
    props: {},
    handlers,
    store: { currentSessionId: null },
  })
  const sessionRow = byTestId(sessionTree, 'session-groups-session')
  assert.equal(sessionRow.props['data-structural-locked'], 'true')
  assert.equal(sessionRow.props['data-archived'], 'false')
  assert.equal(sessionRow.props.draggable, 'false')
  assert.match(sessionRow.props['aria-label'], /T:session\.structuralLocked/)
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
    store: { archiveFilter: 'hidden', groupArchiveFilter: 'hidden', viewMode: 'groups' },
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
  assert.equal(byTestId(tree, 'session-groups-view-options').props['data-group-filter'], 'hidden')
  byTestId(tree, 'session-groups-new-group').props.onClick({ stopPropagation() {} })
  byTestId(tree, 'session-groups-toggle').props.onClick({ stopPropagation() {} })
  assert.equal(calls[0][0], 'openNewGroup')
  assert.equal(calls[0][2], null)
  assert.equal(calls[1], 'toggle')
})

test('ArchiveFilterPopover renders both tri-state segments with active checks', async () => {
  installClientRuntime({ t: (key) => 'T:' + key })
  const { ArchiveFilterPopover } = await import(new URL('../../src/client/components-header.js', import.meta.url))
  const picks = []
  const tree = expand(ArchiveFilterPopover({
    filter: 'all',
    groupFilter: 'only',
    t: (key) => 'T:' + key,
    onPick: (value) => picks.push(['sessions', value]),
    onPickGroup: (value) => picks.push(['groups', value]),
    onResetLayout: () => picks.push('reset'),
  }))
  const popover = byTestId(tree, 'session-groups-view-options-popover')
  assert.ok(popover)
  assert.equal(popover.props.role, 'menu')
  const radios = flatten(tree).filter((node) => node.props?.role === 'menuitemradio')
  assert.equal(radios.length, 6, 'two segments x three tri-state rows')
  const sessionRows = flatten(tree).filter((node) => node.props?.['data-testid'] === 'session-groups-archive-filter')
  const groupRows = flatten(tree).filter((node) => node.props?.['data-testid'] === 'session-groups-group-archive-filter')
  assert.equal(sessionRows.length, 3)
  assert.equal(groupRows.length, 3)
  assert.deepEqual(sessionRows.map((row) => row.props['data-filter']), ['hidden', 'all', 'only'])
  assert.deepEqual(groupRows.map((row) => row.props['data-group-filter']), ['hidden', 'all', 'only'])
  assert.deepEqual(sessionRows.map((row) => row.props['aria-checked']), ['false', 'true', 'false'])
  assert.deepEqual(groupRows.map((row) => row.props['aria-checked']), ['false', 'false', 'true'])
  assert.deepEqual(sessionRows.map((row) => row.props['data-active']), ['false', 'true', 'false'])
  assert.deepEqual(groupRows.map((row) => row.props['data-active']), ['false', 'false', 'true'])
  const sections = childrenOf(popover).filter((child) => child?.props?.role === 'group')
  assert.equal(sections.length, 2)
  assert.deepEqual(sections.map((section) => section.props['aria-label']), ['T:archive.section.sessions', 'T:archive.section.groups'])
  const filterHint = childrenOf(popover).find((child) => child?.props?.class === 'dsg-view-options-hint')
  assert.ok(filterHint, 'view options carry the archive hint line')
  assert.equal(filterHint.props.children, 'T:archive.hint')
  const checkOf = (row) => childrenOf(row).find((child) => child?.props?.class === 'dsg-view-option-check')
  assert.ok(checkOf(sessionRows[1]).props.children, 'active session row paints a check')
  assert.equal(checkOf(sessionRows[0]).props.children, null, 'inactive session row paints no check')
  assert.ok(checkOf(groupRows[2]).props.children, 'active group row paints a check')
  assert.equal(checkOf(groupRows[1]).props.children, null, 'inactive group row paints no check')
  // Picks are the only side effect; the popover has no local close state, so
  // both segments can be driven in one visit (§10).
  sessionRows[2].props.onClick({ stopPropagation() {} })
  groupRows[1].props.onClick({ stopPropagation() {} })
  byTestId(tree, 'session-groups-reset-layout').props.onClick({ stopPropagation() {} })
  assert.deepEqual(picks, [['sessions', 'only'], ['groups', 'all'], 'reset'])
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
    archivedList: [],
    limits: { max: 20 },
    error: null,
  },
  profilePreview: { open: false, loading: false, targetId: null, targetName: null, previewToken: null, doc: null, diff: null, stale: false, error: null },
  profileSwitching: false,
  ...overrides,
})

test('ProfileMenu renders the chevron trigger only with the profile surface', async () => {
  installClientRuntime({ t: (key) => 'T:' + key })
  const { ProfileMenu } = await import(new URL('../../src/client/profile-switcher.js', import.meta.url))
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
  const { ProfilePopover } = await import(new URL('../../src/client/profile-switcher.js', import.meta.url))
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
  const { ProfilePopover } = await import(new URL('../../src/client/profile-switcher.js', import.meta.url))
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
  const { ProfilePreviewBody } = await import(new URL('../../src/client/profile-preview.js', import.meta.url))
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
  // Readability structure: the summary stays one wrapping flex line of three
  // inline stats, while every change is a two-level title/detail pair (never a
  // single `title · path` sentence).
  const summaryNode = byTestId(tree, 'session-groups-profile-preview-summary')
  assert.equal(summaryNode.props.class, 'dsg-profile-preview-summary')
  const stats = flatten(summaryNode).filter((node) => node.props?.class === 'dsg-profile-preview-summary-stat')
  assert.deepEqual(
    stats.map((node) => node.props['data-stat']),
    ['groups', 'sessions', 'ungrouped']
  )
  assert.equal(
    flatten(tree).some((node) => node.props?.class === 'dsg-profile-preview-summary-row'),
    false
  )
  const changes = flatten(tree).filter((node) => node.props?.class === 'dsg-profile-preview-change')
  // The hairline divider between adjacent rows is a CSS adjacent-sibling rule,
  // so every row must stay one direct `.dsg-profile-preview-change` child of its
  // list (the first row has no divider).
  const changeLists = flatten(tree).filter((node) => node.props?.class === 'dsg-profile-preview-list')
  assert.ok(changeLists.length >= 3)
  for (const list of changeLists) {
    const items = childrenOf(list)
    assert.ok(items.length > 0)
    assert.ok(items.every((item) => item?.props?.class === 'dsg-profile-preview-change'))
  }
  const changeOf = (kind) => changes.find((node) => node.props?.['data-kind'] === kind)

  // Session moved: title on the first line, `old → new` on the indented detail.
  const moved = changeOf('moved')
  assert.ok(moved)
  const movedTitle = childByClass(moved, 'dsg-profile-preview-change-title')
  const movedDetail = childByClass(moved, 'dsg-profile-preview-change-detail')
  assert.equal(movedTitle.props.children, 'Session one')
  assert.equal(textOf(movedDetail).replace(/\s+/g, ''), 'A→B')
  assert.equal(textOf(movedTitle).includes('→'), false)
  assert.equal(childByClass(movedDetail, 'dsg-profile-preview-path-old').props.children, 'A')
  assert.equal(childByClass(movedDetail, 'dsg-profile-preview-path-new').props.children, 'B')

  // Session newly grouped / ungrouped / stale keep the same two-level shape.
  const newlyGrouped = changeOf('newlyGrouped')
  assert.ok(newlyGrouped)
  assert.equal(textOf(childByClass(newlyGrouped, 'dsg-profile-preview-change-title')), 's2')
  assert.equal(
    textOf(childByClass(newlyGrouped, 'dsg-profile-preview-change-detail')).replace(/\s+/g, ''),
    '→B'
  )
  const ungrouped = changeOf('ungrouped')
  assert.ok(ungrouped)
  assert.equal(textOf(childByClass(ungrouped, 'dsg-profile-preview-change-detail')).replace(/\s+/g, ''), 'A→T:ungrouped.title')
  const stale = changeOf('stale')
  assert.ok(stale)
  assert.equal(textOf(childByClass(stale, 'dsg-profile-preview-change-title')), 's4')
  assert.equal(
    textOf(childByClass(stale, 'dsg-profile-preview-change-detail')),
    'T:profiles.preview.stale'
  )

  // Group added/changed: inline marker + path, changed adds an old-path detail.
  const addedGroup = changeOf('added')
  assert.ok(addedGroup)
  const addedTitle = childByClass(addedGroup, 'dsg-profile-preview-change-title')
  assert.equal(childByClass(addedTitle, 'dsg-profile-preview-change-marker').props.children, '+')
  assert.equal(textOf(addedTitle), '+New group')
  const changedGroup = changeOf('changed')
  assert.ok(changedGroup)
  assert.equal(
    childByClass(childByClass(changedGroup, 'dsg-profile-preview-change-title'), 'dsg-profile-preview-change-marker').props.children,
    '~'
  )
  assert.equal(textOf(childByClass(changedGroup, 'dsg-profile-preview-change-title')), '~B')
  assert.equal(textOf(childByClass(changedGroup, 'dsg-profile-preview-change-detail')), 'A')
  const removedGroup = changeOf('removed')
  assert.ok(removedGroup)
  assert.equal(
    childByClass(childByClass(removedGroup, 'dsg-profile-preview-change-title'), 'dsg-profile-preview-change-marker').props.children,
    '−'
  )
})

test('ProfilePreviewBody keeps change titles and paths in separate wrapping lines', async () => {
  const t = (key) => 'T:' + key
  const { ProfilePreviewBody } = await import(new URL('../../src/client/profile-preview.js', import.meta.url))
  const longTitle = 'Quarterly planning session with a very long descriptive title'
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
  const tree = ProfilePreviewBody({ store, t, byId: { s1: { id: 's1', title: longTitle } } })
  const changes = flatten(tree).filter((node) => node.props?.class === 'dsg-profile-preview-change')
  assert.ok(changes.length > 0)
  assert.ok(changes.every((node) => typeof node.props['data-kind'] === 'string'))

  // The session title owns the first line; the two paths keep their own text
  // nodes on the indented detail line (no `title · old → new` sentence).
  const moved = changes.find((node) => node.props['data-kind'] === 'moved')
  assert.ok(moved)
  const titleNode = childByClass(moved, 'dsg-profile-preview-change-title')
  const detailNode = childByClass(moved, 'dsg-profile-preview-change-detail')
  assert.equal(titleNode.props.children, longTitle)
  const detailTexts = flatten(detailNode)
    .map((node) => node.props?.children)
    .filter((child) => typeof child === 'string')
  assert.deepEqual(detailTexts, ['A', '→', 'B'])

  // Group changed: new path is the title, the replaced path is the detail.
  const changed = changes.find((node) => node.props['data-kind'] === 'changed')
  assert.ok(changed)
  assert.equal(textOf(childByClass(changed, 'dsg-profile-preview-change-title')), '~B')
  assert.equal(textOf(childByClass(changed, 'dsg-profile-preview-change-detail')), 'A')
  assert.equal(
    flatten(changes)
      .map((node) => node.props?.children)
      .filter((child) => typeof child === 'string')
      .some((child) => child.includes(' · ')),
    false
  )
})

test('ProfilePreviewBody truncates oversized change lists with the remaining count', async () => {
  const t = (key) => 'T:' + key
  const { ProfilePreviewBody } = await import(new URL('../../src/client/profile-preview.js', import.meta.url))
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
  const { ProfileRecovery } = await import(new URL('../../src/client/profile-switcher.js', import.meta.url))
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
  const { ProfilePreviewActions } = await import(new URL('../../src/client/profile-preview.js', import.meta.url))
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
    new URL('../../src/client/profile-storage.js', import.meta.url)
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
  const { beginProfileSwitch } = await import(
    new URL('../../src/client/profile-switch.js', import.meta.url)
  )
  const { isPreviewDiffEmpty } = await import(
    new URL('../../src/client/profile-preview.js', import.meta.url)
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

// ---------------------------------------------------------------------------
// Save-as + manage (SPEC §9.2/§9.4/§9.5, plan S7)
// ---------------------------------------------------------------------------
test('ProfilePopover footer exposes save-as/manage and disables them while degraded or busy', async () => {
  installClientRuntime({ t: (key) => 'T:' + key })
  const { ProfilePopover } = await import(new URL('../../src/client/profile-switcher.js', import.meta.url))
  const calls = []
  const handlers = { openSaveAs: () => calls.push('saveAs'), openManage: () => calls.push('manage') }
  const onClose = (options) => calls.push(['close', options])
  const tree = ProfilePopover({ store: profileSnapshot(), handlers, onClose })
  assert.ok(byTestId(tree, 'session-groups-profile-footer'))
  const saveAs = byTestId(tree, 'session-groups-profile-save-as')
  const manage = byTestId(tree, 'session-groups-profile-manage')
  assert.equal(saveAs.props.children, 'T:profiles.saveAs')
  assert.equal(manage.props.children, 'T:profiles.manage')
  assert.equal(saveAs.props.disabled, undefined)
  saveAs.props.onClick({ stopPropagation() {} })
  manage.props.onClick({ stopPropagation() {} })
  assert.deepEqual(calls, [
    ['close', { restoreFocus: true }],
    'saveAs',
    ['close', { restoreFocus: true }],
    'manage',
  ])

  const degraded = ProfilePopover({
    store: profileSnapshot({ profiles: { ...profileSnapshot().profiles, degraded: true } }),
    handlers,
    onClose: () => {},
  })
  assert.equal(byTestId(degraded, 'session-groups-profile-save-as').props.disabled, true)
  assert.equal(byTestId(degraded, 'session-groups-profile-manage').props.disabled, true)

  const busy = ProfilePopover({ store: profileSnapshot({ profileSwitching: true }), handlers, onClose: () => {} })
  assert.equal(byTestId(busy, 'session-groups-profile-save-as').props.disabled, true)
  assert.equal(byTestId(busy, 'session-groups-profile-manage').props.disabled, true)
})

test('ProfilePopover caps save-as at the profile limit but keeps manage reachable', async () => {
  installClientRuntime({ t: (key, params) => (params ? `${key}:${params.max}` : 'T:' + key) })
  const { ProfilePopover } = await import(new URL('../../src/client/profile-switcher.js', import.meta.url))
  const list = Array.from({ length: 20 }, (_, index) => ({
    id: `p${index}`,
    name: `P${index}`,
    groupCount: 0,
    sessionCount: 0,
    healthy: true,
  }))
  const tree = ProfilePopover({
    store: profileSnapshot({ profiles: { ...profileSnapshot().profiles, activeId: 'p0', list } }),
    handlers: {},
    onClose: () => {},
  })
  const saveAs = byTestId(tree, 'session-groups-profile-save-as')
  assert.equal(saveAs.props.disabled, true)
  assert.equal(saveAs.props['data-limit'], 'true')
  assert.equal(saveAs.props.title, 'profiles.limit:20')
  assert.equal(byTestId(tree, 'session-groups-profile-manage').props.disabled, undefined)
})

test('profile dialog handlers build the copy name and request archived rows', async () => {
  const dispatched = []
  const refreshCalls = []
  const store = profileSnapshot({ profiles: { ...profileSnapshot().profiles, activeId: 'work' } })
  installClientRuntime({
    t: (key) => 'T:' + key,
    store: {
      getSnapshot: () => store,
      dispatch: (action, payload) => dispatched.push([action, payload]),
    },
    refreshProfiles: (options) => refreshCalls.push(options),
  })
  const { openSaveAs, openManage } = await import(
    new URL('../../src/client/components-profile-dialogs.js', import.meta.url)
  )
  const t = (key) => ({ 'profiles.copySuffix': 'copy', 'profiles.defaultName': 'Default' })[key] ?? 'T:' + key
  assert.equal(openSaveAs({ t }), 'Work copy')
  assert.equal(dispatched[0][0], 'dialog')
  assert.equal(dispatched[0][1].dialog.kind, 'profile-save-as')
  assert.equal(dispatched[0][1].dialog.value, 'Work copy')

  openManage({ t })
  assert.equal(dispatched[1][1].dialog.kind, 'profile-manage')
  assert.deepEqual(refreshCalls, [{ includeArchived: true, background: true }])

  // Default profile has no stored name: the localized default name is the base.
  store.profiles = { ...store.profiles, activeId: 'default', list: [{ id: 'default', name: null, groupCount: 0, sessionCount: 0 }] }
  assert.equal(openSaveAs({ t }), 'Default copy')

  // A taken default name is numbered instead of seeded as a duplicate.
  store.profiles = {
    ...store.profiles,
    activeId: 'work',
    list: [
      { id: 'work', name: 'Work', groupCount: 1, sessionCount: 0 },
      { id: 'copy-1', name: 'Work copy', groupCount: 0, sessionCount: 0 },
      { id: 'copy-2', name: 'Work copy 2', groupCount: 0, sessionCount: 0 },
    ],
  }
  assert.equal(openSaveAs({ t }), 'Work copy 3')

  // An over-long active name is shortened so the whole default stays inside
  // the host's 40-character cap and remains submittable.
  const longName = 'W'.repeat(40)
  store.profiles = {
    ...store.profiles,
    activeId: 'long',
    list: [{ id: 'long', name: longName, groupCount: 0, sessionCount: 0 }],
  }
  const trimmed = openSaveAs({ t })
  assert.equal(trimmed.length, 40)
  assert.match(trimmed, / copy$/)
  assert.equal(trimmed.startsWith('W'.repeat(35)), true, 'the stem is cut, not the suffix')
  assert.equal(store.profiles.list.some((profile) => profile.name === trimmed), false)

  // The same cut name collides too: the next ordinal keeps the same cap.
  store.profiles = {
    ...store.profiles,
    list: [
      { id: 'long', name: longName, groupCount: 0, sessionCount: 0 },
      { id: 'long-copy', name: trimmed, groupCount: 0, sessionCount: 0 },
    ],
  }
  const numbered = openSaveAs({ t })
  assert.equal(numbered.length, 40)
  assert.match(numbered, / copy 2$/)
  assert.equal(numbered, `${'W'.repeat(33)} copy 2`)
})

test('save-as opens on a submittable default even when the copy name is taken', async () => {
  installClientRuntime({ t: (key) => 'T:' + key, store: { dispatch: () => {} } })
  const { DialogHost } = await import(new URL('../../src/client/dialog-host.js', import.meta.url))
  const { cloneName } = await import(new URL('../../src/client/components-profile-dialogs.js', import.meta.url))
  const t = (key) => ({ 'profiles.copySuffix': 'copy', 'profiles.defaultName': 'Default' })[key] ?? 'T:' + key
  const store = profileSnapshot({
    profiles: {
      ...profileSnapshot().profiles,
      activeId: 'work',
      list: [
        { id: 'work', name: 'Work', groupCount: 1, sessionCount: 0, healthy: true },
        { id: 'copy-1', name: 'Work copy', groupCount: 0, sessionCount: 0, healthy: true },
      ],
    },
  })
  const value = cloneName(store, t)
  assert.equal(value, 'Work copy 2')
  const tree = expand(
    DialogHost({
      store: { ...store, dialog: { kind: 'profile-save-as', titleKey: 'profiles.saveAs', value } },
      props: {},
      sessionsById: {},
    })
  )
  assert.equal(byTestId(tree, 'session-groups-profile-save-as-name').props.value, 'Work copy 2')
  // The dialog validates its live value, so a deduped default must not open on
  // an error or with Create disabled before the user typed anything.
  assert.equal(byTestId(tree, 'session-groups-profile-dialog-error'), undefined)
  assert.equal(byTestId(tree, 'session-groups-profile-save-as-confirm').props.disabled, undefined)

  // Submit-time validation remains: typing the taken name still blocks Create.
  const duplicate = expand(
    DialogHost({
      store: { ...store, dialog: { kind: 'profile-save-as', titleKey: 'profiles.saveAs', value: 'Work' } },
      props: {},
      sessionsById: {},
    })
  )
  assert.equal(byTestId(duplicate, 'session-groups-profile-save-as-confirm').props.disabled, true)
  assert.equal(byTestId(duplicate, 'session-groups-profile-dialog-error').props.children, 'T:profiles.nameDuplicate')
})

test('manage list disables the last archive row without the "Up to 1 profiles" copy', async () => {
  installClientRuntime({
    t: (key, params) => (params ? `${key}:${params.max}` : 'T:' + key),
    store: { dispatch: () => {} },
  })
  const { DialogHost } = await import(new URL('../../src/client/dialog-host.js', import.meta.url))
  // The active profile is missing from the list (e.g. it is temporarily
  // unhealthy), so the single row reaches the last-profile branch rather than
  // the active/default branches.
  const store = {
    ...profileSnapshot({
      profiles: {
        ...profileSnapshot().profiles,
        activeId: 'work',
        list: [{ id: 'side', name: 'Side', groupCount: 0, sessionCount: 0, healthy: true }],
        limits: { max: 20 },
      },
    }),
    dialog: { kind: 'profile-manage', titleKey: 'profiles.title' },
  }
  const tree = expand(DialogHost({ store, props: {}, sessionsById: {} }))
  assert.equal(byTestId(tree, 'session-groups-profile-manage-count').props.children, '1/20')
  const row = flatten(tree).find((node) => node.props?.['data-testid'] === 'session-groups-profile-manage-row')
  const archive = byTestId(row, 'session-groups-profile-archive')
  assert.equal(archive.props.disabled, true)
  assert.equal(archive.props['data-disabled'], 'true')
  // The tooltip reports the real registry cap instead of the remaining row
  // count (which would read "Up to 1 profiles" beside a disabled button).
  assert.equal(archive.props.title, 'profiles.limit:20')
  assert.doesNotMatch(archive.props.title, /1 profile/)
})

test('DialogHost renders the save-as dialog with its copy preview and inline validation', async () => {
  installClientRuntime({
    t: (key, params) => (params ? `${key}:${params.groups}/${params.sessions}` : 'T:' + key),
    store: { dispatch: () => {} },
  })
  const { DialogHost } = await import(new URL('../../src/client/dialog-host.js', import.meta.url))
  const store = {
    ...profileSnapshot(),
    dialog: { kind: 'profile-save-as', titleKey: 'profiles.saveAs', value: 'Work copy' },
  }
  const tree = expand(DialogHost({ store, props: {}, sessionsById: {} }))
  assert.equal(byTestId(tree, 'session-groups-dialog').props['data-kind'], 'profile-save-as')
  assert.ok(byTestId(tree, 'session-groups-profile-save-as-dialog'))
  const input = byTestId(tree, 'session-groups-profile-save-as-name')
  assert.equal(input.props.value, 'Work copy')
  assert.equal(input.props.maxlength, '40')
  assert.equal(byTestId(tree, 'session-groups-profile-save-as-preview').props.children, 'profiles.createPreview:2/5')
  const confirm = byTestId(tree, 'session-groups-profile-save-as-confirm')
  assert.equal(confirm.props.disabled, undefined)
  assert.equal(confirm.props.children, 'T:profiles.create')
  assert.ok(byTestId(tree, 'session-groups-profile-save-as-cancel'))
  assert.equal(byTestId(tree, 'session-groups-profile-dialog-error'), undefined)

  const duplicate = expand(
    DialogHost({
      store: { ...store, dialog: { ...store.dialog, value: 'Work' } },
      props: {},
      sessionsById: {},
    })
  )
  assert.equal(byTestId(duplicate, 'session-groups-profile-save-as-confirm').props.disabled, true)
  assert.equal(
    byTestId(duplicate, 'session-groups-profile-dialog-error').props.children,
    'T:profiles.nameDuplicate'
  )

  const tooLong = expand(
    DialogHost({
      store: { ...store, dialog: { ...store.dialog, value: 'x'.repeat(41) } },
      props: {},
      sessionsById: {},
    })
  )
  assert.equal(
    byTestId(tooLong, 'session-groups-profile-dialog-error').props.children,
    'T:profiles.nameInvalid'
  )
  assert.equal(byTestId(tooLong, 'session-groups-profile-save-as-confirm').props.disabled, true)

  // Host-side rejection (e.g. a duplicate the stale list did not know about)
  // lands in the same inline error slot through `dialog.error`.
  const serverError = expand(
    DialogHost({
      store: {
        ...store,
        dialog: { ...store.dialog, value: 'Fresh', error: 'profiles.nameDuplicate', errorParams: null },
      },
      props: {},
      sessionsById: {},
    })
  )
  assert.equal(
    byTestId(serverError, 'session-groups-profile-dialog-error').props.children,
    'T:profiles.nameDuplicate'
  )
  assert.equal(byTestId(serverError, 'session-groups-profile-save-as-confirm').props.disabled, undefined)
})

test('save-as confirm calls the bridge createProfile with the trimmed name', async () => {
  const created = []
  const dispatched = []
  const store = {
    ...profileSnapshot(),
    dialog: { kind: 'profile-save-as', titleKey: 'profiles.saveAs', value: '  Work copy  ' },
  }
  installClientRuntime({
    t: (key) => 'T:' + key,
    store: {
      getSnapshot: () => store,
      dispatch: (action, payload) => dispatched.push([action, payload]),
    },
    createProfile: async (payload) => {
      created.push(payload)
      return { ok: true }
    },
  })
  const { DialogHost } = await import(new URL('../../src/client/dialog-host.js', import.meta.url))
  const tree = expand(DialogHost({ store, props: {}, sessionsById: {} }))
  byTestId(tree, 'session-groups-profile-save-as-confirm').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(created, [{ name: 'Work copy' }])
  assert.deepEqual(dispatched, [])
})

test('DialogHost manage list marks active/archived rows and guards archive', async () => {
  installClientRuntime({ t: (key) => 'T:' + key, store: { dispatch: () => {} } })
  const { DialogHost } = await import(new URL('../../src/client/dialog-host.js', import.meta.url))
  const store = {
    ...profileSnapshot({
      profiles: {
        ...profileSnapshot().profiles,
        activeId: 'work',
        list: [
          { id: 'default', name: 'Default', groupCount: 2, sessionCount: 5, updatedAt: '2026-11-01T00:00:00.000Z' },
          { id: 'work', name: 'Work', groupCount: 1, sessionCount: 0, updatedAt: '2026-11-02T00:00:00.000Z' },
          { id: 'side', name: 'Side', groupCount: 0, sessionCount: 3 },
        ],
        archivedList: [{ id: 'old', name: 'Old', groupCount: 0, sessionCount: 0, archived: true }],
        limits: { max: 3 },
      },
    }),
    dialog: { kind: 'profile-manage', titleKey: 'profiles.title' },
  }
  const tree = expand(DialogHost({ store, props: {}, sessionsById: {} }))
  assert.equal(byTestId(tree, 'session-groups-dialog').props['data-kind'], 'profile-manage')
  assert.ok(byTestId(tree, 'session-groups-profile-manage-dialog'))
  assert.equal(byTestId(tree, 'session-groups-profile-manage-count').props.children, '3/3')
  const rows = flatten(tree).filter((node) => node.props?.['data-testid'] === 'session-groups-profile-manage-row')
  assert.equal(rows.length, 4)
  assert.equal(rows[1].props['data-active'], 'true')
  assert.equal(rows[3].props['data-archived'], 'true')
  assert.ok(byTestId(rows[1], 'session-groups-profile-manage-current'))
  assert.ok(byTestId(rows[3], 'session-groups-profile-manage-archived'))
  assert.equal(byTestId(rows[3], 'session-groups-profile-rename'), undefined)
  const archiveButtons = flatten(rows[1])
    .concat(flatten(rows[0]))
    .filter((node) => node.props?.['data-testid'] === 'session-groups-profile-archive')
  assert.equal(archiveButtons[0].props.disabled, true)
  assert.equal(archiveButtons[0].props.title, 'T:profiles.current')
  assert.equal(archiveButtons[1].props.disabled, true)
  assert.equal(archiveButtons[1].props.title, 'T:profiles.defaultName')
  const sideRow = rows[2]
  assert.equal(byTestId(sideRow, 'session-groups-profile-archive').props.disabled, undefined)
  assert.ok(byTestId(tree, 'session-groups-profile-preview-reset'))
})

test('manage rows open the rename/archive dialogs and reset the switch preview', async () => {
  const dispatched = []
  const store = profileSnapshot({
    profiles: {
      ...profileSnapshot().profiles,
      activeId: 'work',
      list: [
        { id: 'default', name: 'Default', groupCount: 2, sessionCount: 5 },
        { id: 'work', name: 'Work', groupCount: 1, sessionCount: 0 },
        { id: 'side', name: 'Side', groupCount: 0, sessionCount: 0 },
      ],
      archivedList: [{ id: 'old', name: 'Old', groupCount: 0, sessionCount: 0, archived: true }],
    },
  })
  installClientRuntime({
    t: (key) => 'T:' + key,
    store: { getSnapshot: () => store, dispatch: (action, payload) => dispatched.push([action, payload]) },
  })
  const { ProfileManageBody } = await import(
    new URL('../../src/client/components-profile-dialogs.js', import.meta.url)
  )
  const t = (key) => 'T:' + key
  const rows = flatten(ProfileManageBody({ store, t })).filter(
    (node) => node.props?.['data-testid'] === 'session-groups-profile-manage-row'
  )
  byTestId(rows[2], 'session-groups-profile-rename').props.onClick({ stopPropagation() {} })
  assert.equal(dispatched[0][1].dialog.kind, 'profile-rename')
  assert.equal(dispatched[0][1].dialog.profileId, 'side')
  assert.equal(dispatched[0][1].dialog.value, 'Side')
  assert.equal(dispatched[0][1].dialog.returnTo, 'profile-manage')
  byTestId(rows[2], 'session-groups-profile-archive').props.onClick({ stopPropagation() {} })
  assert.equal(dispatched[1][1].dialog.kind, 'profile-archive')
  assert.equal(dispatched[1][1].dialog.profileName, 'Side')
  assert.equal(dispatched[1][1].dialog.returnTo, 'profile-manage')

  const memory = {
    value: '0',
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
  const body = ProfileManageBody({ store, t, storage: memory })
  const reset = byTestId(body, 'session-groups-profile-preview-reset')
  assert.equal(reset.props.defaultChecked, true)
  reset.props.onChange({ target: { checked: false } })
  assert.equal(memory.value, null)
})

test('rename and archive confirm dialogs reuse DialogHost chrome and return to manage', async () => {
  const dispatched = []
  installClientRuntime({
    t: (key, params) => (params ? `${key}:${params.max}` : 'T:' + key),
    store: { dispatch: (action, payload) => dispatched.push([action, payload]) },
  })
  const { DialogHost } = await import(new URL('../../src/client/dialog-host.js', import.meta.url))
  const renameStore = {
    ...profileSnapshot(),
    dialog: {
      kind: 'profile-rename',
      titleKey: 'profiles.rename',
      profileId: 'work',
      profileName: 'Work',
      value: 'Work',
      returnTo: 'profile-manage',
    },
  }
  const renameTree = expand(DialogHost({ store: renameStore, props: {}, sessionsById: {} }))
  assert.equal(byTestId(renameTree, 'session-groups-dialog').props['data-kind'], 'profile-rename')
  assert.equal(byTestId(renameTree, 'session-groups-profile-rename-name').props.value, 'Work')
  assert.equal(
    byTestId(renameTree, 'session-groups-profile-rename-confirm').props.children,
    'T:profiles.rename'
  )
  byTestId(renameTree, 'session-groups-profile-rename-cancel').props.onClick()
  assert.deepEqual(dispatched[0], ['dialog', { dialog: { kind: 'profile-manage', titleKey: 'profiles.title' } }])

  const archiveStore = {
    ...profileSnapshot(),
    dialog: {
      kind: 'profile-archive',
      titleKey: 'profiles.archive',
      profileId: 'side',
      profileName: 'Side',
      returnTo: 'profile-manage',
      error: 'profiles.limit',
      errorParams: { max: 20 },
    },
  }
  const archiveTree = expand(DialogHost({ store: archiveStore, props: {}, sessionsById: {} }))
  assert.equal(byTestId(archiveTree, 'session-groups-dialog').props['data-kind'], 'profile-archive')
  assert.equal(byTestId(archiveTree, 'session-groups-profile-archive-confirm').props.children, 'T:profiles.archive')
  const error = flatten(archiveTree).find((node) => node.props?.class === 'dsg-dialog-error')
  assert.equal(error.props.children, 'profiles.limit:20')
  const ordered = flatten(archiveTree).filter((node) =>
    ['session-groups-profile-archive-cancel', 'session-groups-profile-archive-confirm'].includes(
      node.props?.['data-testid']
    )
  )
  assert.deepEqual(
    ordered.map((node) => node.props['data-testid']),
    ['session-groups-profile-archive-cancel', 'session-groups-profile-archive-confirm'],
    'cancel must precede confirm so the confirm button is never the initial focus'
  )
})

test('rename and archive confirm call the bridge with the trimmed name / target id', async () => {
  const calls = []
  const store = profileSnapshot()
  installClientRuntime({
    t: (key) => 'T:' + key,
    store: { getSnapshot: () => store, dispatch: () => {} },
    renameProfile: async (payload) => {
      calls.push(['rename', payload])
      return { ok: true }
    },
    archiveProfile: async (payload) => {
      calls.push(['archive', payload])
      return { ok: true }
    },
  })
  const { DialogHost } = await import(new URL('../../src/client/dialog-host.js', import.meta.url))
  const renameTree = expand(
    DialogHost({
      store: {
        ...store,
        dialog: {
          kind: 'profile-rename',
          titleKey: 'profiles.rename',
          profileId: 'work',
          value: '  Work renamed  ',
          returnTo: 'profile-manage',
        },
      },
      props: {},
      sessionsById: {},
    })
  )
  byTestId(renameTree, 'session-groups-profile-rename-confirm').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls[0], ['rename', { id: 'work', name: 'Work renamed' }])

  const archiveTree = expand(
    DialogHost({
      store: {
        ...store,
        dialog: { kind: 'profile-archive', titleKey: 'profiles.archive', profileId: 'side', profileName: 'Side' },
      },
      props: {},
      sessionsById: {},
    })
  )
  byTestId(archiveTree, 'session-groups-profile-archive-confirm').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(calls[1], ['archive', { id: 'side' }])
})
