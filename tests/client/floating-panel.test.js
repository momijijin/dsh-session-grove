import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// Map the host React peer to the test-only stub before the client module is
// loaded (same pattern as tests/ui/ui-runtime.spec.mjs). The loader only
// changes module resolution in this test process; it never touches src or lib.
register(new URL('../support/react-loader.mjs', import.meta.url))

const { maxHeightCap, panelStyle, resolveNarrow, shouldCollapseTitle, viewportSize } = await import(
  '../../src/client/floating-panel.js'
)

test('panelStyle pins left/top/max-height and rounds sub-pixels to whole pixels', () => {
  assert.deepEqual(panelStyle({ left: 10.4, top: 74.6, width: 247.4, maxHeight: 319.5 }), {
    left: '10px',
    top: '75px',
    maxHeight: '320px',
    width: '247px',
  })
  // The border box must not accumulate a second pixel from fractional widths.
  assert.equal(panelStyle({ left: 0, top: 0, width: 247.6, maxHeight: 100 }).width, '248px')
  assert.equal(panelStyle({ left: 0, top: 0, width: 248.2, maxHeight: 100 }).width, '248px')
  assert.equal(panelStyle({ left: 8, top: 94, width: 248, maxHeight: 320 }).width, '248px')
})

test('panelStyle caps the width instead of pinning it when fixedWidth is off', () => {
  const style = panelStyle({ left: 8.2, top: 94.5, width: 360.4, maxHeight: 420 }, { fixedWidth: false })
  assert.deepEqual(style, { left: '8px', top: '95px', maxHeight: '420px', maxWidth: '360px' })
  assert.equal('width' in style, false, 'a content-sized panel must not pin its width')
})

test('shouldCollapseTitle collapses under 42px and expands from 50px (4px title gap)', () => {
  // available = titleClientWidth - 24 (chevron) - 4 (inline gap)
  assert.equal(shouldCollapseTitle(69, false), true) // 41px
  assert.equal(shouldCollapseTitle(70, false), false) // 42px is inside the hysteresis band
  assert.equal(shouldCollapseTitle(70, true), true) // ... and keeps a collapse
  assert.equal(shouldCollapseTitle(77, true), true) // 49px
  assert.equal(shouldCollapseTitle(78, true), false) // 50px clears it
  assert.equal(shouldCollapseTitle(70, undefined), false, 'a non-true previous counts as false')
  assert.equal(shouldCollapseTitle(70, 1), false, 'only a literal true keeps the collapse')
  assert.equal(shouldCollapseTitle(Number.NaN, true), true, 'a non-finite width keeps previous')
  assert.equal(shouldCollapseTitle(Number.POSITIVE_INFINITY, false), false)
})

test('shouldCollapseTitle uses the 2px compact gap, shifting the thresholds by 2px', () => {
  // available = titleClientWidth - 24 (chevron) - 2 (compact inline gap)
  assert.equal(shouldCollapseTitle(67, false, true), true) // 41px
  assert.equal(shouldCollapseTitle(68, false, true), false) // 42px is inside the band
  assert.equal(shouldCollapseTitle(75, true, true), true) // 49px keeps the collapse
  assert.equal(shouldCollapseTitle(76, true, true), false) // 50px clears it
  // The same 76px title is 48px usable with the normal gap (still collapsed)
  // and 50px usable in the compact header (already expanded).
  assert.equal(shouldCollapseTitle(76, true, false), true)
  assert.equal(shouldCollapseTitle(76, true, true), false)
  // 69px is 41px usable normally (collapsed) but 43px usable when compact.
  assert.equal(shouldCollapseTitle(69, false, false), true)
  assert.equal(shouldCollapseTitle(69, false, true), false)
})

test('resolveNarrow opens at 377, clears at 385 and keeps previous in the band', () => {
  assert.equal(resolveNarrow(377, false), true)
  assert.equal(resolveNarrow(385, true), false)
  for (const width of [378, 380, 384]) {
    assert.equal(resolveNarrow(width, true), true, `${width} keeps the previous true`)
    assert.equal(resolveNarrow(width, false), false, `${width} keeps the previous false`)
  }
  // 264 = plugin minimum, 252 = host does not manage the width, 420 = default.
  assert.equal(resolveNarrow(264, false), true)
  assert.equal(resolveNarrow(252, false), true)
  assert.equal(resolveNarrow(420, true), false)
})

test('resolveNarrow walks 420 -> 377 -> 385 without flicker and tolerates failed reads', () => {
  let narrow = resolveNarrow(420, false)
  assert.equal(narrow, false)
  narrow = resolveNarrow(384, narrow)
  assert.equal(narrow, false, '384 is outside the open threshold')
  narrow = resolveNarrow(378, narrow)
  assert.equal(narrow, false)
  narrow = resolveNarrow(377, narrow)
  assert.equal(narrow, true)
  narrow = resolveNarrow(384, narrow)
  assert.equal(narrow, true, '384 keeps the compact flag on')
  narrow = resolveNarrow(385, narrow)
  assert.equal(narrow, false)
  narrow = resolveNarrow(376, narrow)
  assert.equal(narrow, true)

  assert.equal(resolveNarrow(Number.NaN, true), true)
  assert.equal(resolveNarrow(Number.NaN, undefined), false)
  assert.equal(resolveNarrow(undefined, true), true)
  assert.equal(resolveNarrow(undefined, false), false)
})

test('viewportSize prefers visualViewport, falls back to innerWidth/Height, and never returns NaN', () => {
  assert.deepEqual(
    viewportSize({ visualViewport: { width: 411.5, height: 723.25 }, innerWidth: 1024, innerHeight: 768 }),
    { width: 411.5, height: 723.25 },
  )
  assert.deepEqual(viewportSize({ innerWidth: 1024, innerHeight: 768 }), { width: 1024, height: 768 })
  assert.deepEqual(viewportSize({ visualViewport: null, innerWidth: 800, innerHeight: 600 }), {
    width: 800,
    height: 600,
  })
  // A partial visualViewport is authoritative; missing dimensions read as 0.
  assert.deepEqual(viewportSize({ visualViewport: { width: 500 } }), { width: 500, height: 0 })
  assert.deepEqual(viewportSize({ visualViewport: { width: Number.NaN, height: Infinity } }), {
    width: 0,
    height: 0,
  })
  assert.deepEqual(viewportSize({}), { width: 0, height: 0 })
  assert.deepEqual(viewportSize(undefined), { width: 0, height: 0 })
})

test('maxHeightCap keeps the design height and otherwise fills the padded viewport', () => {
  // 900 - 2 * 8 (POPOVER_VIEWPORT_PADDING): a content-sized panel may use the
  // whole padded viewport; the resolver still trims it to the side it lands on.
  assert.equal(maxHeightCap(0, { height: 900 }), 884)
  assert.equal(maxHeightCap(320, { height: 900 }), 320)
  assert.equal(maxHeightCap(0, { height: 0 }), 0)
  assert.equal(maxHeightCap(Number.NaN, { height: 600 }), 584)
  assert.equal(maxHeightCap(320, { height: 0 }), 320)
  // Non-finite design heights and a missing viewport fall back instead of
  // emitting NaN; a negative design height counts as content-sized.
  assert.equal(maxHeightCap(-40, { height: 900 }), 884)
  assert.equal(maxHeightCap(undefined, { height: 600 }), 584)
  assert.equal(maxHeightCap(0, undefined), 0)
})
