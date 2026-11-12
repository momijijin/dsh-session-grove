/**
 * Floating-panel placement controller (0.4.0-beta.64).
 *
 * Header popovers and the profile popover stay anchored to their trigger but
 * must remain inside the visual viewport. The shared geometry policy lives in
 * `src/core/popover-position.js` (inline edge -> flip -> clamp, height capped by
 * the space actually left around the anchor); this module owns the browser side
 * of it: one layout effect places the mounted panel from the design constants,
 * re-measures the real border box and only rewrites when a number moved by at
 * least 1px. Feeding the measured border-box width back in therefore converges
 * instead of growing the panel by its own padding (spec §6.4), and repeated
 * resize events settle after one write (spec §6.2 convergent write / I5).
 *
 * `data-narrow` is driven by the measured `.dsg-root` width, never by header-row
 * overflow: all seven probed widths show `scrollWidth === clientWidth` because
 * the flex row shrinks the title instead of overflowing (spec §3.3.3). The pure
 * decisions below are exported so node tests can cover them without a DOM.
 */

import { useLayoutEffect, useRef } from 'react'

import { POPOVER_VIEWPORT_PADDING, resolvePopoverRect } from '../core/popover-position.js'

/** Width of the profile chevron inside `.dsg-header-title` (spec §6.6). */
const TITLE_CHEVRON_WIDTH = 24
/** Inline gap inside `.dsg-header-title`: 4px normally, 2px in the compact header. */
const TITLE_INLINE_GAP = 4
const TITLE_INLINE_GAP_NARROW = 2
/** Collapse below 42px of usable title width (3 CJK glyphs at 14px) and clear from 50px (8px band). */
const TITLE_COLLAPSE_UNDER = 42
const TITLE_EXPAND_FROM = 50
/**
 * 16 (header paddings) + 271 (full actions) + 6 (header-row gap) + 56 (full
 * label) + 4 (title gap) + 24 (chevron) = 377; clearing at 385 gives an 8px
 * hysteresis band (spec §6.6).
 */
const NARROW_ROOT_MAX = 377
const NARROW_ROOT_MIN = 385

const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback)

const toPx = (value) => `${Math.round(finite(value, 0))}px`

/** Unmeasured marker: the first resolve after opening (or reopening) always writes. */
const createApplied = () => ({ left: null, top: null, width: null, maxHeight: null })

/**
 * Map a resolved popover rect to the inline style for the first paint and for
 * the imperative writes.
 *
 * Values are rounded to whole pixels so a fractional border box cannot keep
 * alternating between two strings. `fixedWidth` panels pin `width` (status,
 * view options, profile); content-sized panels only cap `maxWidth` (menus).
 *
 * @param {{ left?: number, top?: number, width?: number, maxHeight?: number }|null|undefined} rect
 * @param {{ fixedWidth?: boolean }} [options]
 * @returns {{ left: string, top: string, maxHeight: string, width?: string, maxWidth?: string }}
 */
const panelStyle = (rect, { fixedWidth = true } = {}) => {
  const style = {
    left: toPx(rect?.left),
    top: toPx(rect?.top),
    maxHeight: toPx(rect?.maxHeight),
  }
  const width = toPx(rect?.width)
  if (fixedWidth) style.width = width
  else style.maxWidth = width
  return style
}

/**
 * Decide `data-title-collapsed` from the usable width of `.dsg-header-title`.
 *
 * The measurement source must stay `.dsg-header-title`, which always takes part
 * in layout and is never hidden. Measuring the label instead would read 0 while
 * collapsed (`display:none`), freeze the flag at `true` and lock the title away
 * forever (spec §6.6). Collapse under 42px, clear from 50px, keep the previous
 * boolean in between (8px hysteresis). A non-finite measurement keeps the
 * previous value instead of collapsing on a failed read.
 *
 * @param {number} titleClientWidth measured width of `.dsg-header-title`
 * @param {boolean|unknown} previous current `data-title-collapsed` value
 * @param {boolean} [narrow] compact header: 2px inline gap instead of 4px
 * @returns {boolean}
 */
const shouldCollapseTitle = (titleClientWidth, previous, narrow = false) => {
  const collapsed = previous === true
  if (!Number.isFinite(titleClientWidth)) return collapsed
  const inlineGap = narrow ? TITLE_INLINE_GAP_NARROW : TITLE_INLINE_GAP
  const available = titleClientWidth - TITLE_CHEVRON_WIDTH - inlineGap
  if (available < TITLE_COLLAPSE_UNDER) return true
  if (available >= TITLE_EXPAND_FROM) return false
  return collapsed
}

/**
 * Resolve `data-narrow` from the measured `.dsg-root` width.
 *
 * Open at <= 377, clear at >= 385, keep the previous value in the 8px band.
 * `appliedWidth` is only the viewport-clamped preference and the header row
 * never overflows, so neither may drive this flag (spec §3.3.3 / §6.6).
 *
 * @param {number} rootWidth measured `.dsg-root` width
 * @param {boolean|null|undefined} previous current `data-narrow` value
 * @returns {boolean}
 */
const resolveNarrow = (rootWidth, previous) => {
  const kept = previous ?? false
  if (!Number.isFinite(rootWidth)) return kept
  if (rootWidth <= NARROW_ROOT_MAX) return true
  if (rootWidth >= NARROW_ROOT_MIN) return false
  return kept
}

/**
 * Read the visual viewport, falling back to the layout viewport.
 *
 * `visualViewport` is what I1/I7 measure (it shrinks under pinch-zoom) and wins
 * whenever the object exists; a missing dimension reads as 0 so a partial stub
 * can never produce NaN coordinates. The fallback is `innerWidth`/`innerHeight`.
 *
 * @param {Window|Object|null|undefined} win
 * @returns {{ width: number, height: number }}
 */
const viewportSize = (win) => {
  const visual = win?.visualViewport
  return {
    width: finite(visual ? visual.width : win?.innerWidth, 0),
    height: finite(visual ? visual.height : win?.innerHeight, 0),
  }
}

/**
 * Height cap for a panel that may not declare a design height.
 *
 * A known design height caps the panel directly (the resolver then trims it by
 * the space left around the trigger). A content-sized panel passes 0, and 0
 * must never reach the resolver as `max-height`: it would clamp every such
 * panel to zero height, because `resolvePopoverRect` falls back to
 * `size.height` for a missing `maxHeight`. Those panels instead get the whole
 * padded viewport, which the resolver still trims to the side it lands on.
 * Non-finite inputs read as 0, and a missing viewport reads as height 0.
 *
 * @param {number} designHeight design-constant height; 0 means content-sized
 * @param {{ height?: number }|null|undefined} viewport
 * @returns {number}
 */
const maxHeightCap = (designHeight, viewport) => {
  const design = Math.max(0, finite(designHeight, 0))
  if (design > 0) return design
  const vh = Math.max(0, finite(viewport?.height, 0))
  return Math.max(0, vh - 2 * POPOVER_VIEWPORT_PADDING)
}

/**
 * Anchor one floating panel to its trigger and keep it inside the viewport.
 *
 * The returned `ref` must be attached to the panel root and `triggerRef` to the
 * button. `style` is the first-render box: the design width plus the
 * `maxHeightCap` height cap. The layout effect below runs before paint, so the
 * panel never visibly jumps, and because the `left`/`top` props never change
 * React leaves the imperative position writes alone on later renders. `placement`
 * is the logical inline edge used for the initial `data-placement`; the effect
 * then records the actual resolution (`inline-end`/`inline-start`/`flipped`/
 * `clamped`) with `setAttribute`, so RTL keeps a logical, mirrored token instead
 * of a physical edge (I6).
 *
 * @param {{
 *   open: boolean,
 *   triggerRef: { current: Element|null }|null|undefined,
 *   align?: 'inline-end'|'inline-start',
 *   rtl?: boolean,
 *   designWidth: number,
 *   designHeight?: number,
 *   fixedWidth?: boolean,
 *   gap?: number,
 *   flip?: boolean,
 * }} options
 * @returns {{ ref: { current: Element|null }, style: Object, placement: 'inline-end'|'inline-start' }}
 */
const useFloatingPanel = ({
  open,
  triggerRef,
  align = 'inline-end',
  rtl = false,
  designWidth,
  designHeight = 0,
  fixedWidth = true,
  gap,
  flip = true,
}) => {
  const ref = useRef(null)
  const appliedRef = useRef(createApplied())
  const placement = align === 'inline-start' ? 'inline-start' : 'inline-end'

  // First frame only: size the panel from the design constants instead of its
  // natural content width. A content-sized panel caps at the padded viewport
  // instead of its zero design height, so the cap can never paint the panel as
  // `max-height: 0px`; `left`/`top` stay 0 here and are measured into place by
  // the effect below.
  const cap = maxHeightCap(designHeight, viewportSize(globalThis))
  const style = panelStyle({ left: 0, top: 0, width: designWidth, maxHeight: cap }, { fixedWidth })

  useLayoutEffect(() => {
    if (!open) return undefined
    const trigger = triggerRef?.current
    if (!ref.current || !trigger || typeof trigger.getBoundingClientRect !== 'function') return undefined

    const win = globalThis
    appliedRef.current = createApplied()

    const resolveAt = (size) => {
      const rect = trigger.getBoundingClientRect()
      if (!rect) return null
      // Re-read the viewport on every resolve (open plus each relayout) so a
      // resize refreshes the cap together with the space left on the side.
      const viewport = viewportSize(win)
      const cap = maxHeightCap(designHeight, viewport)
      return resolvePopoverRect({
        anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        size,
        viewport,
        maxHeight: cap,
        align,
        rtl,
        gap,
        flip,
      })
    }

    const measure = () => {
      const panel = ref.current
      return {
        width: panel && panel.offsetWidth > 0 ? panel.offsetWidth : designWidth,
        height: panel && panel.offsetHeight > 0 ? panel.offsetHeight : designHeight,
      }
    }

    const write = (resolved) => {
      const panel = ref.current
      if (!resolved || !panel || !panel.style) return
      if (panel.getAttribute?.('data-placement') !== resolved.horizontal) {
        panel.setAttribute?.('data-placement', resolved.horizontal)
      }
      const next = panelStyle(resolved, { fixedWidth })
      const values = {
        left: parseFloat(next.left),
        top: parseFloat(next.top),
        width: parseFloat(fixedWidth ? next.width : next.maxWidth),
        maxHeight: parseFloat(next.maxHeight),
      }
      const applied = appliedRef.current
      const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1
      // Convergent write: skip the DOM when width, position and height cap all
      // stayed within 1px. The height cap is compared too, otherwise a pure
      // vertical resize would never refresh `maxHeight` (I7).
      if (
        near(values.left, applied.left) &&
        near(values.top, applied.top) &&
        near(values.width, applied.width) &&
        near(values.maxHeight, applied.maxHeight)
      ) {
        return
      }
      panel.style.left = next.left
      panel.style.top = next.top
      panel.style.maxHeight = next.maxHeight
      if (fixedWidth) panel.style.width = next.width
      else panel.style.maxWidth = next.maxWidth
      appliedRef.current = values
    }

    // Pass 1 (design constants) sizes the panel; pass 2 measures the mounted
    // border box and re-resolves. Both happen in this layout effect, before the
    // first paint, so the visible box is already final (I5). The measured
    // height drives the flip decision; the height cap itself stays the resolved
    // design/viewport cap rather than dropping to a zero design height.
    write(resolveAt({ width: designWidth, height: designHeight }))
    write(resolveAt(measure()))

    const relayout = () => {
      if (!ref.current) return
      write(resolveAt(measure()))
    }

    win.addEventListener?.('resize', relayout)
    const Observer = win.ResizeObserver
    const observer = typeof Observer === 'function' ? new Observer(relayout) : null
    observer?.observe?.(trigger)

    return () => {
      win.removeEventListener?.('resize', relayout)
      observer?.disconnect?.()
      appliedRef.current = createApplied()
    }
  }, [open, align, rtl, designWidth, designHeight, gap, flip])

  return { ref, style, placement }
}

export { maxHeightCap, panelStyle, resolveNarrow, shouldCollapseTitle, useFloatingPanel, viewportSize }
