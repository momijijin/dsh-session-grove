/**
 * One-frame coalescer for the 0.4.0-beta.66 v8 micro-optimizations (spec §14).
 *
 * Three hot paths produced several React updates per animation frame: the
 * dialog move/resize pointermoves, the dialog scrollbar's own scroll/resize/
 * ResizeObserver notifications, and the drag-over target commit. Every event
 * used to solve its value and call setState immediately, so one frame that
 * carried three pointermoves paid for three renders (and often three layout
 * reads). This helper keeps only the newest callback of a frame: the first
 * `schedule` arms one animation frame and every later call replaces the
 * callback, so the work runs once per frame with the latest input ("last wins").
 *
 * The rAF pair is injected so this is pure DOM-free logic that `npm test` can
 * drive (`tests/client/frame-batch.test.js`); production callers pass nothing
 * and the pair is resolved from the environment when the batch is created (a
 * browser without rAF falls back to a 16 ms timer instead of never running).
 */

/**
 * Resolve the request/cancel pair for this environment at creation time.
 * @returns {{ requestFrame: (callback: () => void) => number, cancelFrame: (id: number) => void }}
 */
const defaultFrames = () => {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return {
      requestFrame: (callback) => globalThis.requestAnimationFrame(callback),
      cancelFrame: (id) => globalThis.cancelAnimationFrame?.(id),
    }
  }
  return {
    requestFrame: (callback) => globalThis.setTimeout(callback, 16),
    cancelFrame: (id) => globalThis.clearTimeout?.(id),
  }
}

/**
 * @param {{
 *   requestFrame?: (callback: () => void) => number,
 *   cancelFrame?: (id: number) => void
 * }} [frames] injected pair; both functions are required to override the default
 * @returns {{
 *   schedule: (fn: () => void) => void,
 *   flush: () => void,
 *   cancel: () => void,
 *   pending: () => boolean
 * }}
 */
export const createFrameBatch = ({ requestFrame, cancelFrame } = {}) => {
  const pair =
    typeof requestFrame === 'function' && typeof cancelFrame === 'function'
      ? { requestFrame, cancelFrame }
      : defaultFrames()
  /** Newest callback of the frame; `null` when nothing is queued. */
  let pending = null
  /** rAF id of the armed frame; `null` when no frame is armed. */
  let frameId = null

  const run = () => {
    frameId = null
    const callback = pending
    pending = null
    if (callback) callback()
  }

  return {
    /**
     * Keep `fn` as the frame's only callback. A later call before the frame
     * runs replaces the earlier one (the newest input wins); a call after the
     * frame ran arms a new one.
     */
    schedule(fn) {
      if (typeof fn !== 'function') return
      pending = fn
      if (frameId === null) frameId = pair.requestFrame(run)
    },
    /** Run the queued callback now and drop its frame (synchronous settle paths). */
    flush() {
      if (frameId !== null) pair.cancelFrame(frameId)
      frameId = null
      const callback = pending
      pending = null
      if (callback) callback()
    },
    /** Discard the queued callback and its frame (gesture end / unmount). */
    cancel() {
      if (frameId !== null) pair.cancelFrame(frameId)
      frameId = null
      pending = null
    },
    /** True while a callback waits for its frame. */
    pending: () => pending !== null,
  }
}
