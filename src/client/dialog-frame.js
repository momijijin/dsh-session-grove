/**
 * Frame coalescing for the dialog surface (0.4.0-beta.66 v8, spec §14.2.1/2).
 *
 * Two dialog hot paths are coalesced here against `frame-batch.js`:
 *
 * - the move/resize gesture: `onMove` only records the newest pointer sample and
 *   one frame solves + commits the rect (`createDialogGestureFrame`);
 * - the custom scrollbar: scroll/resize/ResizeObserver notifications collapse
 *   into one thumb recomputation per frame, while the first measurement after
 *   mount and the thumb's own drag stay synchronous (`computeScrollBar`,
 *   `createScrollUpdateScheduler`, `mountScrollTracking`).
 *
 * The rAF batching and the DOM sinks are injected, so the whole contract is
 * unit-testable in Node (`tests/client/dialog-frame.test.js`); `dialog-host.js`
 * and `scroll-area.js` only wire these seams to React. The seams deliberately
 * live outside the React modules: `npm test` only loads
 * `components-resize-handle.js` (dynamically, from the width-gesture test) and
 * never imports the `GroupsView` component graph (the component bodies are
 * exercised by `check:ui`), so a component-resident seam would be untestable
 * here and pulling that graph into the coverage run would collapse the gate.
 */
import { perfCount, perfSpan } from './perf.js'

/**
 * One gesture's frame-coalesced pointer tracking (spec §14.2.1).
 *
 * `move()` keeps only the newest position and schedules one frame; the frame
 * solves the rect and commits it. `end()` cancels a pending frame and still
 * lands the final position synchronously: the release event's coordinates win
 * when present, otherwise the newest queued move is used. A pointer that never
 * moved (a click on the dialog chrome) commits nothing.
 *
 * The commit writes `rectRef.current` *before* `setRect`: `onEnd` persists that
 * ref through `saveDialogGeometry`, so a state-only commit would store the
 * previous frame's geometry (N2).
 *
 * @param {{
 *   batch: { schedule: (fn: () => void) => void, cancel: () => void },
 *   solve: (x: number, y: number) => (object | null),
 *   rectRef: { current: object | null },
 *   setRect: (rect: object) => void,
 *   count?: () => void
 * }} options
 */
export const createDialogGestureFrame = ({
  batch,
  solve,
  rectRef,
  setRect,
  // `dialog:frame` counts applied rect commits (including the synchronous end settle), not rAF frames.
  count = () => perfCount('dialog:frame'),
}) => {
  /** Newest pointer sample waiting for its frame; `null` when the frame is clear. */
  let pending = null
  /** True once the pointer moved: an unmoved press must not commit a rect. */
  let moved = false

  const commitAt = (x, y) => {
    const next = solve(x, y)
    if (!next) return false
    count()
    // N2: the ref is what `onEnd` persists, so it must never lag React state.
    rectRef.current = next
    setRect(next)
    return true
  }

  const applyPending = () => {
    const sample = pending
    pending = null
    if (!sample) return
    commitAt(sample.x, sample.y)
  }

  return {
    /** Record the newest pointer position; the next frame applies it once. */
    move(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      moved = true
      pending = { x, y }
      batch.schedule(applyPending)
    },
    /**
     * Settle the gesture. `x`/`y` are the release event coordinates (preferred
     * when present); returns true when a rect was committed.
     */
    end(x, y) {
      batch.cancel()
      const sample = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : pending
      pending = null
      if (!moved || !sample) return false
      moved = false
      return commitAt(sample.x, sample.y)
    },
    /** Cancel the queued frame and forget the sample (unmount). */
    dispose() {
      pending = null
      moved = false
      batch.cancel()
    },
    /**
     * True while a pointer sample waits for its frame.
     * @internal Test/diagnostic seam, not part of the gesture contract.
     */
    pending: () => pending !== null,
  }
}

/**
 * Recompute the custom thumb from the scroller box and publish it.
 *
 * The element and the setter are injected so the math and the same-value bail
 * that protects the dialog from an extra render per scroll notification are
 * unit-testable. `setBar` keeps its functional-update bail: a stationary thumb
 * hands the previous object back and React skips the render.
 *
 * @param {{
 *   element: { scrollHeight: number, clientHeight: number, scrollTop: number } | null,
 *   setBar: (next: null | ((previous: { height: number, top: number } | null) => null | { height: number, top: number })) => void
 * }} options
 */
export const computeScrollBar = ({ element, setBar }) => {
  // P4: the sample covers the thumb math plus its setBar call.
  const stopUpdate = perfSpan('scrollAreaUpdateMs')
  perfCount('scrollArea:update')
  try {
    if (!element) {
      setBar(null)
      return
    }
    const max = element.scrollHeight - element.clientHeight
    if (max <= 1) {
      setBar(null)
      return
    }
    const railHeight = Math.max(0, element.clientHeight - 12)
    const height = Math.max(20, Math.round((railHeight * element.clientHeight) / element.scrollHeight))
    const top = Math.round((element.scrollTop / max) * Math.max(0, railHeight - height))
    setBar((previous) => (previous?.height === height && previous?.top === top ? previous : { height, top }))
  } finally {
    stopUpdate()
  }
}

/**
 * Frame-coalesced scrollbar updater (spec §14.2.2).
 *
 * `schedule()` collapses every scroll/resize/ResizeObserver notification of a
 * frame into one recomputation; `now()` keeps the two paths that must stay
 * synchronous: the first measurement after mount (the thumb has to exist on the
 * first paint) and the thumb's own drag (the pointer position is the input).
 *
 * @param {{
 *   batch: { schedule: (fn: () => void) => void, cancel: () => void },
 *   compute: () => void,
 *   count?: () => void
 * }} options
 */
export const createScrollUpdateScheduler = ({ batch, compute, count = () => perfCount('scrollArea:frame') }) => {
  const apply = () => {
    count()
    compute()
  }
  return {
    /** Run the recomputation now (mount measurement, thumb drag). */
    now: () => compute(),
    /** Coalesce this notification into the next frame. */
    schedule: () => batch.schedule(apply),
    /** Drop a pending frame (unmount). */
    cancel: () => batch.cancel(),
  }
}

/**
 * Subscribe one scroller to the scheduler and take the synchronous first
 * measurement (spec §14.2.2).
 *
 * Extracted from the layout effect so the mount contract — first paint measured
 * synchronously, every later notification coalesced, cleanup cancels — is
 * testable with a fake element and window. Returns the cleanup.
 *
 * @param {{
 *   element: { addEventListener: Function, removeEventListener: Function, scrollHeight: number, clientHeight: number, scrollTop: number },
 *   scheduler: { now: () => void, schedule: () => void, cancel: () => void },
 *   computeNow: () => void,
 *   win?: object
 * }} options
 * @returns {() => void}
 */
export const mountScrollTracking = ({ element, scheduler, computeNow, win = globalThis }) => {
  // The thumb must be laid out before the first paint, so the mount path is
  // synchronous; only later notifications go through the frame batch.
  computeNow()
  scheduler.schedule()
  const timer = win.setTimeout?.(computeNow, 50)
  element.addEventListener('scroll', scheduler.schedule, { passive: true })
  win.addEventListener?.('resize', scheduler.schedule)
  let observer = null
  if (typeof win.ResizeObserver === 'function') {
    observer = new win.ResizeObserver(scheduler.schedule)
    observer.observe(element)
  }
  return () => {
    win.clearTimeout?.(timer)
    scheduler.cancel()
    element.removeEventListener('scroll', scheduler.schedule)
    win.removeEventListener?.('resize', scheduler.schedule)
    observer?.disconnect()
  }
}
