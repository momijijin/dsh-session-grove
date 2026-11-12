/**
 * Viewport clamping for row context menus (0.2.7).
 *
 * A right-click or Shift+F10/ContextMenu anchors the same menu used by the
 * three-dot button. The first pass clamps against a conservative estimate; the
 * mounted menu measures itself and clamps again with its real rect, so a menu
 * that is ~275px tall never leaves the viewport. All functions are pure.
 *
 * 0.4.0-beta.64 adds `menuBoxLimits`: the width cap and the height left below
 * the menu's y, so the box scrolls instead of overflowing a narrow or short
 * viewport. The x/y shift clamp stays local (the menu is anchored at a pointer,
 * not at an element edge); only the box math delegates to the shared popover
 * resolver.
 */

import { POPOVER_VIEWPORT_PADDING, resolvePopoverRect } from './popover-position.js'

export const MENU_VIEWPORT_PADDING = 8
/** Conservative pre-measure estimates (the mounted menu refines them). */
export const MENU_ESTIMATED_WIDTH = 220
export const MENU_ESTIMATED_HEIGHT = 320

const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback)

/** Clamp a menu rect's top-left corner inside the viewport with 8px breathing room. */
export const clampMenuPosition = ({ x, y, width, height, viewportWidth, viewportHeight, padding = MENU_VIEWPORT_PADDING }) => {
  const vw = Math.max(0, finite(viewportWidth, 0))
  const vh = Math.max(0, finite(viewportHeight, 0))
  const boxW = Math.max(0, finite(width, 0))
  const boxH = Math.max(0, finite(height, 0))
  const maxX = Math.max(padding, vw - boxW - padding)
  const maxY = Math.max(padding, vh - boxH - padding)
  return {
    x: Math.min(Math.max(padding, finite(x, padding)), maxX),
    y: Math.min(Math.max(padding, finite(y, padding)), maxY),
  }
}

/**
 * Outer-box limits for the mounted menu: the widest border-box it may take
 * (`min(maxWidth, vw - 2*pad)`) and the height left below `top`.
 *
 * Width is the one piece of menu geometry that matches the popover policy, so
 * it reuses `resolvePopoverRect` with a zero-sized point anchor and
 * `flip: false`; the caller still owns the x/y shift clamp above. `top` is the
 * menu's final viewport y, so a menu opened low scrolls instead of running off
 * the bottom edge. Non-finite viewport values fall back to 0 the same way the
 * rest of this module does.
 *
 * Both geometry knobs are optional: `top` defaults to
 * `POPOVER_VIEWPORT_PADDING` (the shared 8px breathing room) and `maxWidth` to
 * `360` for callers that only need the default menu width cap.
 */
export const menuBoxLimits = ({ viewport = {}, top = POPOVER_VIEWPORT_PADDING, maxWidth = 360 } = {}) => {
  const vh = Math.max(0, finite(viewport?.height, 0))
  const limit = Math.max(0, finite(maxWidth, 360))
  const { width } = resolvePopoverRect({
    anchor: { left: 0, right: 0, top: 0, bottom: 0 },
    size: { width: limit, height: 0 },
    viewport,
    align: 'inline-start',
    flip: false,
    maxWidth: limit,
  })
  return {
    width,
    maxHeight: Math.max(0, vh - POPOVER_VIEWPORT_PADDING - finite(top, POPOVER_VIEWPORT_PADDING)),
  }
}

/** Anchor a context menu at the pointer, offset by +2px on both axes. */
export const menuAnchorFromEvent = (event, viewport = {}) => {
  const anchorX = finite(event?.clientX, 0) + 2
  const anchorY = finite(event?.clientY, 0) + 2
  return {
    ...clampMenuPosition({
      x: anchorX,
      y: anchorY,
      width: MENU_ESTIMATED_WIDTH,
      height: MENU_ESTIMATED_HEIGHT,
      viewportWidth: viewport.width ?? 0,
      viewportHeight: viewport.height ?? 0,
    }),
    // Keep the unclamped pointer anchor so the mounted menu can re-clamp with
    // its real height without being stuck at the conservative estimate.
    anchorX,
    anchorY,
  }
}

/** Keyboard anchor: row left edge, row bottom + 8px. */
export const menuAnchorFromRow = (row, viewport = {}) => {
  const rect = row?.getBoundingClientRect?.()
  const anchorX = rect ? rect.left : 0
  const anchorY = rect ? rect.bottom + 8 : 0
  return {
    ...clampMenuPosition({
      x: anchorX,
      y: anchorY,
      width: MENU_ESTIMATED_WIDTH,
      height: MENU_ESTIMATED_HEIGHT,
      viewportWidth: viewport.width ?? 0,
      viewportHeight: viewport.height ?? 0,
    }),
    anchorX,
    anchorY,
  }
}

/** Shift+F10 and the dedicated ContextMenu key both open the row menu. */
export const isMenuKey = (event) =>
  event?.key === 'ContextMenu' || (event?.key === 'F10' && event?.shiftKey === true)

