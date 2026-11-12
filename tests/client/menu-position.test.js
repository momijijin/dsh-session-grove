import test from 'node:test'
import assert from 'node:assert/strict'

import { clampMenuPosition, isMenuKey, menuAnchorFromEvent, menuAnchorFromRow, menuBoxLimits } from '../../src/core/menu-position.js'

const viewport = { width: 500, height: 400 }
const row = { getBoundingClientRect: () => ({ left: 30, bottom: 90 }) }

test('clampMenuPosition keeps the menu inside an 8px viewport inset', () => {
  assert.deepEqual(clampMenuPosition({ x: 100, y: 120, width: 200, height: 250, viewportWidth: 500, viewportHeight: 400 }), { x: 100, y: 120 })
  assert.deepEqual(clampMenuPosition({ x: -20, y: -20, width: 200, height: 250, viewportWidth: 500, viewportHeight: 400 }), { x: 8, y: 8 })
  assert.deepEqual(clampMenuPosition({ x: 480, y: 380, width: 200, height: 250, viewportWidth: 500, viewportHeight: 400 }), { x: 292, y: 142 })
  // A menu taller than the viewport still pins to the padding row.
  assert.deepEqual(clampMenuPosition({ x: 100, y: 100, width: 200, height: 900, viewportWidth: 500, viewportHeight: 400 }), { x: 100, y: 8 })
})

test('context-menu pointer anchor offsets +2px and clamps at the edges', () => {
  assert.deepEqual(menuAnchorFromEvent({ clientX: 100, clientY: 50 }, viewport), { x: 102, y: 52, anchorX: 102, anchorY: 52 })
  assert.deepEqual(menuAnchorFromEvent({ clientX: 700, clientY: 390 }, viewport), { x: 272, y: 72, anchorX: 702, anchorY: 392 })
})

test('keyboard anchor uses row left and row bottom + 8px', () => {
  assert.deepEqual(menuAnchorFromRow(row, { width: 500, height: 800 }), { x: 30, y: 98, anchorX: 30, anchorY: 98 })
  assert.deepEqual(menuAnchorFromRow(null, { width: 500, height: 400 }), { x: 8, y: 8, anchorX: 0, anchorY: 0 })
})

test('menu anchors tolerate missing and non-finite viewport/client values', () => {
  assert.deepEqual(clampMenuPosition({ x: Number.NaN, y: Infinity, width: -1, height: Number.NaN, viewportWidth: Number.NaN, viewportHeight: -1 }), { x: 8, y: 8 })
  assert.deepEqual(clampMenuPosition({ x: 10, y: 10, width: 1, height: 1, viewportWidth: 50, viewportHeight: 50, padding: 2 }), { x: 10, y: 10 })
  assert.deepEqual(menuAnchorFromEvent(undefined, {}), { x: 8, y: 8, anchorX: 2, anchorY: 2 })
})

test('Shift+F10 and ContextMenu are the only keyboard menu keys', () => {
  assert.equal(isMenuKey({ key: 'F10', shiftKey: true }), true)
  assert.equal(isMenuKey({ key: 'ContextMenu' }), true)
  assert.equal(isMenuKey({ key: 'F10' }), false)
  assert.equal(isMenuKey({ key: 'Enter' }), false)
})

test('menuBoxLimits caps the menu width to the viewport and the height below top', () => {
  // 264px sidebar: 264 - 2*8 = 248 outer width (the 360px design cap does not fit).
  assert.deepEqual(menuBoxLimits({ viewport: { width: 264, height: 700 } }), { width: 248, maxHeight: 684 })
  // 480px-tall viewport with the menu at y=400 leaves 480 - 8 - 400 = 72px.
  assert.deepEqual(menuBoxLimits({ viewport: { width: 800, height: 480 }, top: 400 }), { width: 360, maxHeight: 72 })
  // A non-finite / missing top falls back to the viewport padding.
  assert.deepEqual(menuBoxLimits({ viewport: { width: 800, height: 480 }, top: Number.NaN }), { width: 360, maxHeight: 464 })
  assert.deepEqual(menuBoxLimits({ viewport: { width: 800, height: 480 } }), { width: 360, maxHeight: 464 })
  // The caller can lower the design cap (narrower menus on a wide viewport).
  assert.equal(menuBoxLimits({ viewport: { width: 800, height: 480 }, maxWidth: 180 }).width, 180)
  // Missing or non-finite viewports collapse to a zero box, like the rest of the module.
  assert.deepEqual(menuBoxLimits(), { width: 0, maxHeight: 0 })
  assert.deepEqual(menuBoxLimits({ viewport: { width: Number.NaN, height: Number.NaN } }), { width: 0, maxHeight: 0 })
})
