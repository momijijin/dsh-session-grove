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
 * `position: fixed` escapes the host's `overflow: hidden` clip only while no
 * ancestor has a transform or filter (either turns that ancestor into the
 * containing block), which a rect can never report. The layout effect therefore
 * probes the four inset corners once per open and folds the panel into the
 * nearest clipping ancestor (`data-fallback="clip"`) when the host does contain
 * it (spec §8 / I2). The writing direction comes from the panel's nearest
 * `[dir]` ancestor, so the logical edge resolves to a physical one without a
 * direction provider (spec §6.5 / I6).
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
 * Resolve the writing direction from the panel's nearest `[dir]` ancestor.
 *
 * `align` is a logical edge (`inline-end` / `inline-start`), so the resolver
 * needs to know which physical side that is. Reading `dir` off the ancestor
 * chain keeps RTL mirroring without a direction provider in every popover.
 * `undefined` keeps the resolver's LTR default when nothing declares a
 * direction (spec §6.5 / I6).
 *
 * @param {Element|null|undefined} panel
 * @returns {boolean|undefined}
 */
const panelDirection = (panel) => {
  const dir = panel?.closest?.('[dir]')?.getAttribute?.('dir')
  if (typeof dir !== 'string') return undefined
  return dir.toLowerCase() === 'rtl'
}

/** Inset of the four I2 corner probes inside the placed panel (spec §8). */
const CLIP_PROBE_INSET = 3

/**
 * Nearest ancestor that actually clips its descendants.
 *
 * The first ancestor whose computed `overflow` (or one axis) is not `visible`
 * is the box a contained `position: fixed` panel has to fit into. Browsers
 * expose the shorthand on `overflow` and the longhands on `overflow-x` /
 * `overflow-y`; either signal counts (spec §8).
 *
 * @param {Window|Object|null|undefined} win
 * @param {Element|null|undefined} panel
 * @returns {DOMRect|Object|null} the clipping box, or null when nothing clips
 */
const clippingBox = (win, panel) => {
  if (typeof win?.getComputedStyle !== 'function') return null
  let node = panel?.parentElement ?? null
  while (node) {
    const computed = win.getComputedStyle(node)
    const clipX = computed?.overflowX ?? computed?.overflow
    const clipY = computed?.overflowY ?? computed?.overflow
    if ((clipX && clipX !== 'visible') || (clipY && clipY !== 'visible')) {
      const rect = node.getBoundingClientRect?.()
      if (rect) return rect
    }
    node = node.parentElement ?? null
  }
  return null
}

/**
 * I2 self-check plus the clip fallback (spec §8).
 *
 * A clipped panel still reports its full `getBoundingClientRect`, so the only
 * reliable signal is hit-testing: probe the four corners 3px inside the placed
 * panel and require each hit to land inside the panel itself. When a probe
 * misses, an `overflow: hidden` ancestor of the host is containing the fixed
 * box; fold the panel into that ancestor instead — width shrinks into the clip
 * rect and the left edge is clamped inside it — write that once and record
 * `data-fallback="clip"` so the degradation is observable. A clean probe
 * removes the attribute again.
 *
 * The write intentionally leaves the caller's applied values untouched: a later
 * relayout that resolves to the same rect stays inside the 1px convergent-write
 * band and therefore keeps the fallback instead of undoing it.
 *
 * @param {Window|Object|null|undefined} win
 * @param {Element|null|undefined} panel
 * @param {{ fixedWidth?: boolean }} [options]
 * @returns {boolean} true when a clip fallback was recorded
 */
const verifyPanelClip = (win, panel, { fixedWidth = true } = {}) => {
  const doc = panel?.ownerDocument ?? win?.document
  if (!panel || typeof panel.getBoundingClientRect !== 'function' || typeof doc?.elementFromPoint !== 'function') {
    return false
  }
  const rect = panel.getBoundingClientRect()
  if (!rect) return false
  const clear = () => {
    if (typeof panel.getAttribute === 'function' && panel.getAttribute('data-fallback') !== null) {
      panel.removeAttribute?.('data-fallback')
    }
    return false
  }
  // A zero-area panel cannot be probed and cannot be folded; leave it alone
  // rather than reporting a fallback nobody asked for.
  if (!(rect.width > 0) || !(rect.height > 0)) return clear()
  const hitsSelf = (x, y) => {
    const node = doc.elementFromPoint(x, y)
    return node !== null && node !== undefined && (node === panel || panel.contains?.(node) === true)
  }
  const left = rect.left + CLIP_PROBE_INSET
  const right = rect.right - CLIP_PROBE_INSET
  const top = rect.top + CLIP_PROBE_INSET
  const bottom = rect.bottom - CLIP_PROBE_INSET
  if (hitsSelf(left, top) && hitsSelf(right, top) && hitsSelf(left, bottom) && hitsSelf(right, bottom)) {
    return clear()
  }

  const clip = clippingBox(win, panel)
  if (clip && panel.style) {
    const available = Math.max(0, clip.right - clip.left)
    const width = Math.max(0, Math.min(rect.width, available))
    const folded = Math.max(clip.left, Math.min(rect.left, clip.right - width))
    panel.style.left = toPx(folded)
    if (fixedWidth) panel.style.width = toPx(width)
    else panel.style.maxWidth = toPx(width)
  }
  panel.setAttribute?.('data-fallback', 'clip')
  return true
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
 * }} options (leaving `rtl` undefined reads the panel's nearest `[dir]`
 * ancestor, spec §6.5; an explicit boolean always wins)
 * @returns {{ ref: { current: Element|null }, style: Object, placement: 'inline-end'|'inline-start' }}
 */
const useFloatingPanel = ({
  open,
  triggerRef,
  align = 'inline-end',
  rtl,
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
      // An explicit `rtl` wins; otherwise the panel's nearest `[dir]` ancestor
      // decides the physical side of the logical `align` edge (§6.5 / I6).
      const direction = typeof rtl === 'boolean' ? rtl : panelDirection(ref.current)
      return resolvePopoverRect({
        anchor: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        size,
        viewport,
        maxHeight: cap,
        align,
        rtl: direction,
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

    // I2 (spec §8): once per open, after the first placement, hit-test the four
    // inset corners. A host transform/filter would put the fixed box back under
    // an ancestor clip, which no rect reports; the probe catches it and folds
    // the panel into the clip (`data-fallback="clip"`). Resizes keep the plain
    // relayout path, so the fallback is an open-time degradation, not a mode.
    verifyPanelClip(win, ref.current, { fixedWidth })

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
