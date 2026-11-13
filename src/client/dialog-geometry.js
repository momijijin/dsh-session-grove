/**
 * DSH client adapter for dialog geometry.
 *
 * Pure viewport math lives in src/core/dialog-geometry.js. This outer layer
 * owns only the localStorage persistence key and storage access.
 */
import { clampDialogRect } from '../core/dialog-geometry.js'
import { safeStorage } from './state.js'

export {
  centeredDialogRect,
  clampDialogRect,
  dragDialogRect,
  MIN_DIALOG_HEIGHT,
  MIN_DIALOG_WIDTH,
  resizeDialogRect,
} from '../core/dialog-geometry.js'

/**
 * Measure one rendered element into the plain rect the dialog state stores.
 * A missing element/method, a non-finite coordinate or a non-positive box
 * returns null so callers can fall back to the other rect source instead of
 * starting a gesture from NaN.
 */
export const dialogRectFromElement = (element) => {
  const box = element?.getBoundingClientRect?.()
  if (!box) return null
  const { left, top, width, height } = box
  if (![left, top, width, height].every((value) => Number.isFinite(value))) return null
  if (width <= 0 || height <= 0) return null
  return { x: left, y: top, width, height }
}

/**
 * Prefer the in-memory rect (the gesture source of truth) and fall back to the
 * element's live box, viewport-clamped so a CSS-centered dialog stays reachable
 * before the first measurement lands. Both missing -> null, which keeps Home
 * and reset a no-op exactly as before.
 */
export const resolveDialogRect = (refRect, measuredRect, viewportWidth, viewportHeight) => {
  if (refRect) return refRect
  return measuredRect ? clampDialogRect(measuredRect, viewportWidth, viewportHeight) : null
}

export const DIALOG_GEOMETRY_KEY = 'dsh-session-grove.dialog.geometry.v9'

export const readDialogGeometries = (storage = safeStorage()) => {
  try {
    const raw = storage?.getItem(DIALOG_GEOMETRY_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result = {}
    for (const [kind, rect] of Object.entries(parsed)) {
      if (!kind || !rect || typeof rect !== 'object') continue
      if (['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key]))) {
        result[kind] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
    }
    return result
  } catch {
    return {}
  }
}

export const saveDialogGeometry = (kind, rect, storage = safeStorage()) => {
  if (!kind || !rect) return
  try {
    const all = readDialogGeometries(storage)
    all[kind] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    storage?.setItem(DIALOG_GEOMETRY_KEY, JSON.stringify(all))
  } catch {
    /* blocked storage keeps the in-memory geometry */
  }
}

/** Clear all remembered dialog positions/sizes (used by Reset layout). */
export const clearDialogGeometries = (storage = safeStorage()) => {
  try {
    storage?.removeItem(DIALOG_GEOMETRY_KEY)
  } catch {
    /* ignore */
  }
}
