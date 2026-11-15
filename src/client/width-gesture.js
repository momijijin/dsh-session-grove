/**
 * Sidebar width gesture flag (0.4.0-beta.66 P2).
 *
 * The resize handle owns the drag, but another module needs to know about it:
 * the ungrouped section otherwise re-measures its layout twice per drag frame
 * (4-5 ms each, spec §11.3). Keeping the flag in a tiny DOM-free module avoids a
 * dependency from the layout components onto the resize handle and keeps the
 * state testable in Node.
 *
 * `beginWidthGesture()` is idempotent; `endWidthGesture()` closes the gesture at
 * most once and then notifies every subscriber. Subscribers stay registered
 * across gestures (the returned unsubscribe function is the only way out), so a
 * second drag re-runs the same deferred-measure callback instead of measuring
 * only once per page.
 */

/** Registered gesture-end callbacks. @type {Set<() => void>} */
const listeners = new Set()

let active = false

/** Mark the start of a sidebar width drag (repeated calls are no-ops). */
export const beginWidthGesture = () => {
  active = true
}

/**
 * Mark the end of a sidebar width drag.
 *
 * The flag flips first so a listener that checks `isWidthGestureActive()` sees
 * the settled state, then every listener runs once. Ending a gesture that is
 * already over does nothing (the pointerup/pointercancel/cleanup paths can all
 * reach here). A throwing listener is swallowed: it must never break the
 * pointer handler that ended the drag, nor starve the remaining listeners.
 */
export const endWidthGesture = () => {
  if (!active) return
  active = false
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* a listener failure must not abort the drag teardown */
    }
  }
}

/** True while the resize handle owns a sidebar width drag. */
export const isWidthGestureActive = () => active

/**
 * Subscribe to gesture end. Returns the unsubscribe function; listeners persist
 * across gestures until they are removed.
 *
 * @param {() => void} listener
 * @returns {() => void} unsubscribe
 */
export const onWidthGestureEnd = (listener) => {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
