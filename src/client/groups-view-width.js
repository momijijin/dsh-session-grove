/**
 * Sidebar width controller for the groups view.
 *
 * Keeps the persisted preference separate from the viewport-clamped applied
 * width; owns the host-DOM controller lifecycle and the resize event.
 */
import { useEffect, useRef, useState } from 'react'
import {
  applyManagedWidth,
  clampSidebarWidth,
  clearManagedWidth,
  findLayoutNodes,
  maxSidebarWidth,
  readSidebarWidth,
  writeSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
} from './sidebar-width.js'
import { perfCount, perfMs, perfNow, perfSidebarWidth } from './perf.js'

/** Floor between width-variable writes while a drag previews (spec §13.2.3). */
const MIN_WIDTH_WRITE_INTERVAL_MS = 32
/** Weight of the newest write-frame sample in the EMA. */
const WIDTH_WRITE_EMA_ALPHA = 0.3
/** The next write waits one and a half measured write frames. */
const WIDTH_WRITE_INTERVAL_FACTOR = 1.5
/**
 * Longest believable write-frame sample. A hidden tab stalls the rAF callback
 * for seconds; folding that interval into the EMA would push the adaptive
 * interval to tens of seconds and the next drag would barely write the variable
 * at all. Anything above this cap is a stall, not the cost of one write frame.
 */
const MAX_WRITE_FRAME_SAMPLE_MS = 500

/**
 * Adaptive width-write scheduler (spec §13.2.3 / §13.2.4 B1).
 *
 * A drag preview may arrive on every pointer frame, but every CSS-variable
 * write re-lays out the whole host shell. `preview` therefore applies at most
 * once per `max(32ms, 1.5 × EMA(write frame))`; `commit` always applies so a
 * release (or a keyboard step) can never leave the variable on a skipped
 * preview. The write-frame cost is measured from the `controller.update()`
 * call to the start of the next animation frame, which includes the host
 * layout and paint triggered by the write.
 *
 * The pure scheduler is exported for tests: it takes an injected clock and
 * rAF functions, so the adaptive behavior can be exercised without a browser.
 *
 * @param {{
 *   apply: (next: number, ...args: unknown[]) => number | null,
 *   now?: () => number,
 *   requestFrame?: (callback: () => void) => number,
 *   cancelFrame?: (id: number) => void
 * }} options
 */
export const createWidthWriteScheduler = ({
  apply,
  now = perfNow,
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (id) => globalThis.cancelAnimationFrame(id),
}) => {
  /** @type {number | null} */
  let emaMs = null
  let lastApplyAt = -Infinity
  /** @type {number | null} */
  let frameId = null
  /** @type {number | null} */
  let pendingStartAt = null

  const interval = () =>
    emaMs === null
      ? MIN_WIDTH_WRITE_INTERVAL_MS
      : Math.max(MIN_WIDTH_WRITE_INTERVAL_MS, emaMs * WIDTH_WRITE_INTERVAL_FACTOR)

  const measure = () => {
    const startedAt = pendingStartAt
    frameId = null
    pendingStartAt = null
    if (startedAt === null) return
    const sample = now() - startedAt
    // A backwards clock (or a synthetic timer) must not poison the EMA, and a
    // sample above the cap is a stalled/hidden tab, not one write frame.
    if (!(sample >= 0) || sample > MAX_WRITE_FRAME_SAMPLE_MS) return
    emaMs =
      emaMs === null
        ? sample
        : emaMs * (1 - WIDTH_WRITE_EMA_ALPHA) + sample * WIDTH_WRITE_EMA_ALPHA
  }

  const write = (next, at, args) => {
    const startedAt = apply(next, ...args)
    if (!Number.isFinite(startedAt)) return false
    lastApplyAt = at
    pendingStartAt = startedAt
    if (frameId === null) frameId = requestFrame(measure)
    return true
  }

  return {
    /** Write only when the adaptive interval has elapsed. */
    preview(next) {
      const at = now()
      if (at - lastApplyAt < interval()) return false
      return write(next, at, [])
    },
    /** Write unconditionally, bypassing the preview throttle. */
    commit(next, ...args) {
      return write(next, now(), args)
    },
    /** Cancel a pending write-frame measurement (component unmount). */
    dispose() {
      if (frameId !== null) cancelFrame(frameId)
      frameId = null
      pendingStartAt = null
    },
    /** Current adaptive interval, exposed for diagnostics/tests. */
    intervalMs: interval,
    /** Current write-frame EMA (`null` until the first measurement). */
    emaMs: () => emaMs,
  }
}

/**
 * Apply one width write through a host controller.
 *
 * Exported for the scheduler tests: the pure scheduler only sees this return
 * value, so it must report a failed write as `null`. The shipped adapter returns
 * `null` from `update()` when the sidebar is collapsed or the host node is
 * gone; counting that as a free write would arm the adaptive throttle and feed
 * the EMA for a frame the host never laid out.
 *
 * @param {{ update: (next: number, viewport?: number) => number | null } | null} controller
 * @param {number} next
 * @param {number} [viewport]
 * @returns {number | null} time the write started, or `null` when it failed
 */
export const applyWidthWriteTo = (controller, next, viewport = globalThis.innerWidth) => {
  if (!controller) return null
  let startedAt = null
  perfMs('widthFrameMs', () => {
    perfCount('width:frame')
    startedAt = perfNow()
    if (controller.update(next, viewport) === null) startedAt = null
  })
  return startedAt
}

export const useGroupsSidebarWidth = ({ wide, docState, rootRef }) => {
  const widthControllerRef = useRef(null)
  const [preferredWidth, setPreferredWidth] = useState(() => readSidebarWidth())
  // The ref, not the state, is what a preview advances. It deliberately is not
  // re-assigned from `preferredWidth` on every render: an unrelated render
  // during a drag would otherwise roll the live preference back to the last
  // committed value.
  const preferredWidthRef = useRef(preferredWidth)
  const [viewportWidth, setViewportWidth] = useState(() => globalThis.innerWidth || 1440)
  const [widthSupported, setWidthSupported] = useState(false)
  /** Width the user last saw (preview included); `null` until applied. */
  const liveWidthRef = useRef(null)
  /** True when the last attempted controller write was refused (`null`). */
  const writeRefusedRef = useRef(false)
  const appliedWidth = clampSidebarWidth(preferredWidth, viewportWidth)
  const maxAppliedWidth = maxSidebarWidth(viewportWidth)

  const getLiveWidth = () => (Number.isFinite(liveWidthRef.current) ? liveWidthRef.current : null)

  const applyWidthWrite = (next, viewport) => {
    const controller = widthControllerRef.current
    // No controller means no host layout to write (handle not mounted); the refs
    // stay the only live width there is, so this is not a refused write.
    if (!controller) return null
    writeRefusedRef.current = false
    const startedAt = applyWidthWriteTo(controller, next, viewport)
    if (startedAt === null) writeRefusedRef.current = true
    return startedAt
  }

  const widthSchedulerRef = useRef(null)
  if (widthSchedulerRef.current === null) {
    widthSchedulerRef.current = createWidthWriteScheduler({ apply: applyWidthWrite })
  }

  useEffect(() => {
    if (!wide) {
      // The host owns the 56px rail. The cross-view managed override must also
      // be released, not just this component's local controller reference.
      clearManagedWidth()
      widthControllerRef.current = null
      liveWidthRef.current = null
      setWidthSupported(false)
      return undefined
    }
    const root = rootRef.current
    if (!root) return undefined
    let disposed = false

    const clearController = () => {
      if (!widthControllerRef.current) return
      try {
        widthControllerRef.current.clear()
      } catch {
        /* fail-soft: a detached host node is already gone */
      }
      widthControllerRef.current = null
    }

    const sync = () => {
      if (disposed) return
      const viewport = globalThis.innerWidth || viewportWidth
      const nodes = findLayoutNodes(root)
      if (!nodes.supported) {
        clearController()
        liveWidthRef.current = null
        setWidthSupported(false)
        return
      }
      const clamped = clampSidebarWidth(preferredWidthRef.current, viewport)
      if (clamped === null) {
        clearController()
        liveWidthRef.current = null
        setWidthSupported(false)
        return
      }
      if (widthControllerRef.current === null) {
        const controller = applyManagedWidth(nodes, clamped, viewport)
        if (!controller) {
          liveWidthRef.current = null
          setWidthSupported(false)
          return
        }
        widthControllerRef.current = controller
      } else if (widthControllerRef.current.update(clamped, viewport) === null) {
        clearController()
        liveWidthRef.current = null
        setWidthSupported(false)
        return
      }
      liveWidthRef.current = clamped
      setWidthSupported(true)
    }

    // The host replaced the frame / sidebar root underneath us: the adapter has
    // already cleared the override, so hide the handle and re-find the nodes.
    // When the groups root itself is detached, `findLayoutNodes` reports
    // unsupported and the handle stays hidden.
    function onLost() {
      if (disposed) return
      clearController()
      setWidthSupported(false)
      sync()
    }

    const onResize = () => {
      setViewportWidth(globalThis.innerWidth)
      sync()
    }

    sync()
    globalThis.addEventListener('resize', onResize)
    return () => {
      disposed = true
      globalThis.removeEventListener('resize', onResize)
      // Keep the managed override alive across a groups -> workspace switch;
      // the plugin shell owns its final release.
      widthControllerRef.current = null
      setWidthSupported(false)
    }
  }, [wide, docState])

  useEffect(() => () => widthSchedulerRef.current?.dispose(), [])

  /**
   * Preview a drag width without scheduling a React render. Only the adaptive
   * CSS-variable write is gated; the refs advance on every frame the host can
   * take, so the line and the narrow-state arithmetic stay ahead of the host
   * layout. A preview that actually attempted a write and was refused by the
   * controller (`update() === null`) must not claim a live width.
   */
  const previewWidth = (next) => {
    preferredWidthRef.current = next
    writeRefusedRef.current = false
    widthSchedulerRef.current.preview(next)
    if (!writeRefusedRef.current) liveWidthRef.current = next
  }

  /**
   * Commit a width unconditionally: the controller write and live ref happen
   * before React state and persistence, so a skipped preview can never leave
   * the CSS variable on an older value than the state/localStorage pair.
   */
  const commitWidth = (next) => {
    writeRefusedRef.current = false
    widthSchedulerRef.current.commit(next, globalThis.innerWidth)
    if (!writeRefusedRef.current) liveWidthRef.current = next
    preferredWidthRef.current = next
    setPreferredWidth(next)
    writeSidebarWidth(next)
    // Publish the committed width for the gesture record: `endDrag` closes the
    // `width-resize` record synchronously after this commit, before the React
    // render that normally feeds `perfSidebarWidth` has run, so without this the
    // record would carry the previous render's width.
    perfSidebarWidth(next)
  }

  /**
   * Roll the CSS variable back to the committed width (pointercancel, a
   * re-entrant pointerdown, or an unmount mid-drag). The write goes through the
   * same unconditional scheduler path as a commit, but nothing is persisted and
   * no React state is scheduled: the committed preference never changed, so
   * this is a view rollback, not a new commit.
   */
  const cancelWidth = () => {
    const viewport = globalThis.innerWidth || viewportWidth
    // The committed preference (state), never the previewed `preferredWidthRef`.
    const committed = clampSidebarWidth(preferredWidth, viewport)
    if (committed !== null) widthSchedulerRef.current.commit(committed, viewport)
    liveWidthRef.current = committed
    // A viewport that cannot host a wider-than-minimum sidebar clamps to null;
    // keep the stored preference so a later `sync` can re-apply it.
    preferredWidthRef.current = committed ?? preferredWidth
  }

  const handleWidthReset = () => {
    const viewport = globalThis.innerWidth || viewportWidth
    // The preference is always the design default (420); the applied width is
    // only its viewport clamp. Persisting the clamp would permanently downgrade
    // a narrow-window reset (e.g. 320 at 800px) and widening later would stay
    // narrow instead of restoring 420.
    const next = clampSidebarWidth(SIDEBAR_WIDTH_DEFAULT, viewport)
    if (next !== null) widthSchedulerRef.current.commit(next, viewport)
    liveWidthRef.current = next
    preferredWidthRef.current = SIDEBAR_WIDTH_DEFAULT
    setPreferredWidth(SIDEBAR_WIDTH_DEFAULT)
    writeSidebarWidth(SIDEBAR_WIDTH_DEFAULT)
  }

  return {
    viewportWidth,
    appliedWidth,
    maxAppliedWidth,
    widthSupported,
    getLiveWidth,
    previewWidth,
    commitWidth,
    cancelWidth,
    handleWidthReset,
  }
}
