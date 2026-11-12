import test from 'node:test'
import assert from 'node:assert/strict'

import {
  POPOVER_GAP,
  POPOVER_MIN_USABLE_HEIGHT,
  POPOVER_VIEWPORT_PADDING,
  resolvePopoverRect,
} from '../../src/core/popover-position.js'

test('exports the shared popover constants', () => {
  assert.equal(POPOVER_GAP, 6)
  assert.equal(POPOVER_VIEWPORT_PADDING, 8)
  assert.equal(POPOVER_MIN_USABLE_HEIGHT, 96)
})

test('keeps the preferred inline edge when it fits (LTR and RTL, end and start)', () => {
  const viewport = { width: 800, height: 600 }
  const anchor = { left: 300, right: 340, top: 100, bottom: 120 }
  const size = { width: 200, height: 150 }

  // LTR inline-end puts the popover's right edge on anchor.right.
  assert.deepEqual(resolvePopoverRect({ anchor, size, viewport }), {
    left: 140,
    top: 126,
    width: 200,
    maxHeight: 150,
    horizontal: 'inline-end',
    vertical: 'below',
  })
  // LTR inline-start puts the popover's left edge on anchor.left.
  assert.deepEqual(resolvePopoverRect({ anchor, size, viewport, align: 'inline-start' }), {
    left: 300,
    top: 126,
    width: 200,
    maxHeight: 150,
    horizontal: 'inline-start',
    vertical: 'below',
  })
  // RTL mirrors the physical edge for the same logical alignment.
  assert.deepEqual(resolvePopoverRect({ anchor, size, viewport, rtl: true }), {
    left: 300,
    top: 126,
    width: 200,
    maxHeight: 150,
    horizontal: 'inline-end',
    vertical: 'below',
  })
  assert.deepEqual(resolvePopoverRect({ anchor, size, viewport, rtl: true, align: 'inline-start' }), {
    left: 140,
    top: 126,
    width: 200,
    maxHeight: 150,
    horizontal: 'inline-start',
    vertical: 'below',
  })
})

test('flips to the opposite edge when the preferred side overflows', () => {
  const viewport = { width: 500, height: 400 }
  const size = { width: 200, height: 100 }

  // inline-end would start at 160 - 200 = -40, so the left edge anchors instead.
  assert.deepEqual(
    resolvePopoverRect({ anchor: { left: 120, right: 160, top: 100, bottom: 120 }, size, viewport }),
    { left: 120, top: 126, width: 200, maxHeight: 100, horizontal: 'flipped', vertical: 'below' },
  )
  // RTL inline-end anchors the left edge first; that overflows at 520 > 492,
  // so the flipped pass anchors the right edge (360 - 200 = 160).
  assert.deepEqual(
    resolvePopoverRect({ anchor: { left: 320, right: 360, top: 100, bottom: 120 }, size, viewport, rtl: true }),
    { left: 160, top: 126, width: 200, maxHeight: 100, horizontal: 'flipped', vertical: 'below' },
  )
})

test('clamps and shrinks the width when both edges overflow', () => {
  const viewport = { width: 300, height: 400 }
  const anchor = { left: 100, right: 140, top: 200, bottom: 220 }
  const rect = resolvePopoverRect({ anchor, size: { width: 320, height: 120 }, viewport })

  assert.deepEqual(rect, {
    left: 8,
    top: 226,
    width: 284,
    maxHeight: 120,
    horizontal: 'clamped',
    vertical: 'below',
  })
  assert.equal(rect.width, viewport.width - 2 * POPOVER_VIEWPORT_PADDING)
  assert.equal(rect.left + rect.width, viewport.width - POPOVER_VIEWPORT_PADDING)
})

test('caps maxHeight by the design limit or the remaining space, whichever is smaller', () => {
  const viewport = { width: 800, height: 300 }
  const anchor = { left: 300, right: 340, top: 100, bottom: 120 }
  const size = { width: 200, height: 100 }

  // 300 - 8 (padding) - 126 (top) = 166px of usable space below the anchor.
  assert.deepEqual(resolvePopoverRect({ anchor, size, viewport, maxHeight: 400 }), {
    left: 140,
    top: 126,
    width: 200,
    maxHeight: 166,
    horizontal: 'inline-end',
    vertical: 'below',
  })
  // The design cap wins when it is the smaller of the two.
  assert.deepEqual(resolvePopoverRect({ anchor, size, viewport, maxHeight: 120 }), {
    left: 140,
    top: 126,
    width: 200,
    maxHeight: 120,
    horizontal: 'inline-end',
    vertical: 'below',
  })
})

test('keeps a short panel below when only the design height is small', () => {
  const viewport = { width: 800, height: 480 }
  const anchor = { left: 300, right: 340, top: 60, bottom: 80 }

  // Nothing fits above (-21 < padding), yet 480 - 8 (padding) - 86 (top) = 386px
  // remain below: far more than the 75px empty-state panel needs. The previous
  // implementation compared the 75px design cap against the minimum and pinned
  // the panel to top=8 with vertical='clamped'.
  assert.deepEqual(resolvePopoverRect({ anchor, size: { width: 200, height: 75 }, viewport }), {
    left: 140,
    top: 86,
    width: 200,
    maxHeight: 75,
    horizontal: 'inline-end',
    vertical: 'below',
  })
})

test('flips vertically above when the space below cannot hold the panel', () => {
  const viewport = { width: 800, height: 300 }
  const anchor = { left: 300, right: 340, top: 200, bottom: 220 }

  // 200 - 6 (gap) - 150 (height) = 44, with 186px of capped space above.
  assert.deepEqual(resolvePopoverRect({ anchor, size: { width: 200, height: 150 }, viewport }), {
    left: 140,
    top: 44,
    width: 200,
    maxHeight: 150,
    horizontal: 'inline-end',
    vertical: 'above',
  })
})

test('pins to the top with the full padded height when neither side fits', () => {
  const viewport = { width: 800, height: 200 }
  const anchor = { left: 300, right: 340, top: 150, bottom: 170 }
  const rect = resolvePopoverRect({ anchor, size: { width: 200, height: 150 }, viewport })

  assert.deepEqual(rect, {
    left: 140,
    top: 8,
    width: 200,
    maxHeight: 184,
    horizontal: 'inline-end',
    vertical: 'clamped',
  })
  // The cap is exactly the height left under the pinned top.
  assert.equal(rect.maxHeight, viewport.height - rect.top - POPOVER_VIEWPORT_PADDING)
  assert.equal(rect.top + rect.maxHeight, viewport.height - POPOVER_VIEWPORT_PADDING)
})

test('clamps a zero-sized point anchor without flipping when flip is off', () => {
  const viewport = { width: 640, height: 480 }
  const anchor = { left: 620, right: 620, top: 300, bottom: 300 }
  const size = { width: 200, height: 120 }

  assert.deepEqual(resolvePopoverRect({ anchor, size, viewport, align: 'inline-start', flip: false }), {
    left: 432,
    top: 306,
    width: 200,
    maxHeight: 120,
    horizontal: 'clamped',
    vertical: 'below',
  })
  // The same anchor flips to the other side when flipping is allowed.
  assert.deepEqual(resolvePopoverRect({ anchor, size, viewport, align: 'inline-start' }), {
    left: 420,
    top: 306,
    width: 200,
    maxHeight: 120,
    horizontal: 'flipped',
    vertical: 'below',
  })
})

test('falls back to the padding for non-finite, negative and zero viewports', () => {
  const fallback = {
    left: 8,
    top: 8,
    width: 0,
    maxHeight: 0,
    horizontal: 'clamped',
    vertical: 'clamped',
  }
  assert.deepEqual(
    resolvePopoverRect({
      anchor: { left: Number.NaN, right: Infinity, top: -12, bottom: Number.NaN },
      size: { width: Number.NaN, height: Infinity },
      viewport: { width: Number.NaN, height: -1 },
    }),
    fallback,
  )
  assert.deepEqual(resolvePopoverRect(), fallback)
})

test('shrinks the width to the viewport and converges across consecutive resolves', () => {
  const viewport = { width: 264, height: 700 }
  const anchor = { left: 20, right: 56, top: 40, bottom: 68 }
  const design = { width: 248, height: 320 }

  const first = resolvePopoverRect({ anchor, size: design, viewport })
  assert.deepEqual(first, {
    left: 8,
    top: 74,
    width: 248,
    maxHeight: 320,
    horizontal: 'clamped',
    vertical: 'below',
  })

  // Feeding the measured border-box width back in changes nothing.
  const second = resolvePopoverRect({ anchor, size: { width: first.width, height: design.height }, viewport })
  assert.equal(second.width, first.width)
  assert.deepEqual(second, first)

  const narrowViewport = { width: 200, height: 700 }
  const narrow = resolvePopoverRect({ anchor, size: design, viewport: narrowViewport })
  assert.equal(narrow.width, narrowViewport.width - 2 * POPOVER_VIEWPORT_PADDING)
  const narrowSecond = resolvePopoverRect({
    anchor,
    size: { width: narrow.width, height: design.height },
    viewport: narrowViewport,
  })
  assert.equal(narrowSecond.width, narrow.width)
  assert.deepEqual(narrowSecond, narrow)

  // An explicit max width wins over the design width but not over the viewport.
  assert.equal(resolvePopoverRect({ anchor, size: design, viewport: { width: 800, height: 700 }, maxWidth: 180 }).width, 180)
})
