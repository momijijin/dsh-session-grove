// tests/client/menu-scroll.test.js
//
// 0.4.0-beta.65 S7: the row menu only closes when the scroll actually moves
// its anchor. These cases pin the O(1) decision helper (it must never read
// layout or query the DOM) and the shared source-row lookup moved into
// groups-view-menu-handlers.js.

import test from 'node:test'
import assert from 'node:assert/strict'

import { menuSourceRow, scrollAffectsMenu } from '../../src/client/groups-view-menu-handlers.js'

/** A throw-on-read sentinel: any layout read in the scroll path fails loudly. */
const layoutTrap = (base, label) => {
  const trapped = { ...base }
  for (const name of [
    'getBoundingClientRect',
    'getClientRects',
    'getComputedStyle',
    'offsetWidth',
    'offsetHeight',
    'offsetTop',
    'offsetLeft',
    'scrollTop',
    'scrollLeft',
  ]) {
    Object.defineProperty(trapped, name, {
      configurable: true,
      get() {
        throw new Error(`${label} touched layout: ${name}`)
      },
    })
  }
  Object.defineProperty(trapped, 'querySelectorAll', {
    configurable: true,
    get() {
      throw new Error(`${label} queried the DOM: querySelectorAll`)
    },
  })
  return trapped
}

test('scrollAffectsMenu closes for the source-row ancestor and unrelated scrolls keep the menu', () => {
  const row = { isConnected: true }
  const tree = { contains: (candidate) => candidate === row }
  const conversation = { contains: () => false }
  assert.equal(scrollAffectsMenu(tree, row), true, 'scrolling the row ancestor must close the menu')
  assert.equal(scrollAffectsMenu(conversation, row), false, 'an unrelated scroller must keep the menu open')
  // A row without the DOM flag is still treated as attached.
  assert.equal(scrollAffectsMenu(conversation, {}), false)
})

test('scrollAffectsMenu falls back to closing on a lost anchor or page-level scroll', () => {
  const row = { isConnected: true }
  const tree = { contains: () => true }
  assert.equal(scrollAffectsMenu(tree, null), true, 'a missing source row must close')
  assert.equal(scrollAffectsMenu(tree, { isConnected: false }), true, 'a detached source row must close')
  assert.equal(scrollAffectsMenu(null, row), true, 'a missing event target must close')
  assert.equal(scrollAffectsMenu({}, row), true, 'a target without contains must close')

  // document/window keep the old page-scroll semantics: their `contains` would
  // return false, so this only passes through the explicit page-level branch.
  const documentRef = { contains: () => false }
  const windowRef = { contains: () => false }
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  try {
    globalThis.document = documentRef
    globalThis.window = windowRef
    assert.equal(scrollAffectsMenu(documentRef, row), true, 'document scroll must close')
    assert.equal(scrollAffectsMenu(windowRef, row), true, 'window scroll must close')
  } finally {
    globalThis.document = previousDocument
    globalThis.window = previousWindow
  }
})

test('scrollAffectsMenu never reads layout or queries the DOM', () => {
  const row = layoutTrap({ isConnected: true }, 'row')
  const target = layoutTrap({ contains: (candidate) => candidate === row }, 'target')
  assert.equal(scrollAffectsMenu(target, row), true)
  assert.equal(scrollAffectsMenu({ contains: () => false }, row), false)
  assert.equal(scrollAffectsMenu(target, { isConnected: false }), true)
})

test('menuSourceRow resolves the group/session row that opened the menu', () => {
  const row = (id, attr) => ({ getAttribute: (name) => (name === attr ? id : null) })
  const groupRow = row('group-1', 'data-group-id')
  const sessionRow = row('session-1', 'data-session-id')
  // A row without `getAttribute` must be skipped, not throw.
  const anonymousRow = {}
  const rows = {
    '[data-testid="session-groups-group"]': [row('group-2', 'data-group-id'), anonymousRow, groupRow],
    '[data-testid="session-groups-session"]': [sessionRow],
  }
  const documentRef = {
    querySelectorAll: (selector) => rows[selector],
  }
  assert.equal(menuSourceRow({ kind: 'group', groupId: 'group-1' }, documentRef), groupRow)
  assert.equal(menuSourceRow({ kind: 'session', sessionId: 'session-1' }, documentRef), sessionRow)
  assert.equal(menuSourceRow({ kind: 'group', groupId: 'group-2' }, documentRef), rows['[data-testid="session-groups-group"]'][0])
  // Unknown ids and missing menu/document return null (no throw).
  assert.equal(menuSourceRow({ kind: 'group', groupId: 'missing' }, documentRef), null)
  assert.equal(menuSourceRow({ kind: 'session', sessionId: 'missing' }, documentRef), null)
  assert.equal(menuSourceRow(null, documentRef), null)
  assert.equal(menuSourceRow({ kind: 'group', groupId: 'group-1' }, null), null)
  // A document stub without rows yields no matches.
  assert.equal(menuSourceRow({ kind: 'group', groupId: 'group-1' }, { querySelectorAll: () => undefined }), null)
})
