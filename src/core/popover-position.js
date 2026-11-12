/**
 * Viewport placement for anchored popovers (0.4.0-beta.64).
 *
 * Header popovers, the profile popover and future floating panels share one
 * geometry policy: anchor on an inline edge, flip to the opposite edge when the
 * preferred side overflows, clamp as a last resort, and cap the height by the
 * space that is actually left below or above the trigger. `size` is the
 * border-box footprint, so feeding measured `offsetWidth`/`offsetHeight` back
 * in never grows the panel by its own padding and border. All functions are
 * pure.
 */

export const POPOVER_GAP = 6
export const POPOVER_VIEWPORT_PADDING = 8
export const POPOVER_MIN_USABLE_HEIGHT = 96

const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback)

/**
 * Resolve one popover rectangle against the visual viewport.
 *
 * The returned `left`/`top` are viewport coordinates for `position: fixed`;
 * `width` is already capped by `maxWidth` and by `vw - 2*padding`, and
 * `maxHeight` is the smaller of the caller's design cap and the space left on
 * the chosen side. The function never rewrites `size.height`: the caller
 * measures the mounted panel and resolves a second time, which converges
 * because `size` is the outer (border-box) box.
 *
 * @param {{
 *   anchor?: { left?: number, right?: number, top?: number, bottom?: number },
 *   size?: { width?: number, height?: number },
 *   viewport?: { width?: number, height?: number },
 *   align?: 'inline-end' | 'inline-start',
 *   rtl?: boolean,
 *   gap?: number,
 *   padding?: number,
 *   maxWidth?: number,
 *   maxHeight?: number,
 *   flip?: boolean,
 * }} [input]
 * @returns {{
 *   left: number,
 *   top: number,
 *   width: number,
 *   maxHeight: number,
 *   horizontal: 'inline-end' | 'inline-start' | 'flipped' | 'clamped',
 *   vertical: 'below' | 'above' | 'clamped',
 * }}
 */
const resolvePopoverRect = ({
  anchor,
  size,
  viewport,
  align = 'inline-end',
  rtl = false,
  gap = POPOVER_GAP,
  padding = POPOVER_VIEWPORT_PADDING,
  maxWidth,
  maxHeight,
  flip = true,
} = {}) => {
  const pad = Math.max(0, finite(padding, POPOVER_VIEWPORT_PADDING))
  const space = Math.max(0, finite(gap, POPOVER_GAP))
  const vw = Math.max(0, finite(viewport?.width, 0))
  const vh = Math.max(0, finite(viewport?.height, 0))

  const available = Math.max(0, vw - 2 * pad)
  const designWidth = Math.max(0, finite(size?.width, 0))
  const designHeight = Math.max(0, finite(size?.height, 0))
  const width = Math.min(designWidth, Math.max(0, finite(maxWidth, available)), available)

  // A point anchor supplies left/top only; a missing edge collapses onto the
  // supplied one, so the box stays zero-sized instead of anchoring at 0.
  const anchorLeft = Math.max(0, finite(anchor?.left, 0))
  const anchorRight = Math.max(0, finite(anchor?.right, anchorLeft))
  const anchorTop = Math.max(0, finite(anchor?.top, 0))
  const anchorBottom = Math.max(0, finite(anchor?.bottom, anchorTop))

  const logicalAlign = align === 'inline-start' ? 'inline-start' : 'inline-end'
  const alignEnd = logicalAlign === 'inline-end' ? !rtl : rtl
  const minLeft = pad
  const maxLeft = Math.max(pad, vw - pad - width)
  const overflows = (candidate) => candidate < minLeft || candidate + width > vw - pad

  const preferredLeft = alignEnd ? anchorRight - width : anchorLeft
  let horizontal = logicalAlign
  let left = preferredLeft
  if (overflows(preferredLeft)) {
    if (flip) {
      const flippedLeft = alignEnd ? anchorLeft : anchorRight - width
      if (!overflows(flippedLeft)) {
        left = flippedLeft
        horizontal = 'flipped'
      } else {
        left = Math.min(Math.max(minLeft, flippedLeft), maxLeft)
        horizontal = 'clamped'
      }
    } else {
      left = Math.min(Math.max(minLeft, preferredLeft), maxLeft)
      horizontal = 'clamped'
    }
  }

  const heightCap = Math.max(0, finite(maxHeight, designHeight))
  const topBelow = anchorBottom + space
  const topAbove = anchorTop - space - designHeight
  const aboveFits = topAbove >= pad
  // Usability must be judged by the viewport space left below the trigger, not
  // by `maxHeightOut`: a legitimately short panel (e.g. a 75px empty state) can
  // cap `maxHeightOut` below the minimum while hundreds of pixels remain below.
  const belowSpace = vh - pad - topBelow

  let vertical
  let top
  let maxHeightOut
  if (flip && topBelow + designHeight > vh - pad && aboveFits) {
    top = topAbove
    maxHeightOut = Math.min(heightCap, Math.max(0, anchorTop - space - pad))
    vertical = 'above'
  } else {
    top = topBelow
    maxHeightOut = Math.min(heightCap, Math.max(0, vh - pad - topBelow))
    vertical = 'below'
  }

  // Below is unusable and the trigger leaves no room above either: pin the
  // panel to the top edge and give it the whole padded viewport height.
  if (belowSpace < POPOVER_MIN_USABLE_HEIGHT && !aboveFits) {
    top = pad
    maxHeightOut = Math.max(0, vh - 2 * pad)
    vertical = 'clamped'
  }

  return {
    left,
    top: Math.max(pad, top),
    width,
    maxHeight: maxHeightOut,
    horizontal,
    vertical,
  }
}

export { resolvePopoverRect }
