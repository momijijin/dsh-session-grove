/**
 * Candidate hold + name cache for the session/group drag target
 * (0.4.0-beta.66 v8 frame coalescing, spec §14.2.3; v9 hold timer, spec §15.2).
 *
 * `dragover` fires continuously while the pointer rests on a row (110–243
 * events/s measured), and every event used to re-run the group-name lookup and
 * possibly call setState with an equivalent target. Two seams fix that:
 *
 * - `createDropTargetCommit`: a new target must survive `TARGET_HOLD_MS` (70 ms)
 *   before it is committed. In the run8 trace every target change inserted or
 *   removed the placeholder, and each of those layout pushes cost a 22–25 ms
 *   style+layout long task; crossing a row during a fast drag produced 21–46 of
 *   them per gesture. The newest target wins, an unchanged target never
 *   restarts its hold, and drop/end paths flush the current candidate
 *   synchronously so a drop never acts on the previous target.
 * - `createDragLabelCache`: build the groupId → name map once when the drag
 *   starts; a mid-drag document identity change rebuilds it (N3) and a miss
 *   falls back to the live lookup (freshness backstop).
 *
 * Both are DOM-free and take the clock/sinks as parameters, so `npm test`
 * drives the hold with a fake clock (`tests/client/drag-frame.test.js`). They
 * live outside `components.js` because `npm test` never imports a component
 * module; pulling that graph into the coverage run would collapse the coverage
 * gate.
 */
import { findGroup } from '../shared/model.js'
import { perfCount } from './perf.js'

/** How long a new drop target must survive before it is committed (spec §15.2). */
export const TARGET_HOLD_MS = 70

/** `performance.now()` when available, `Date.now()` otherwise. */
const defaultNow = () =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now()

/**
 * Hold-timer drop-target setter (spec §15.2, superseding the v8 one-frame
 * batch).
 *
 * `set(next)` only records the target as a *candidate*; the hold timer commits
 * it after `TARGET_HOLD_MS`, which is what keeps a pointer that merely crosses
 * a row from publishing (and re-laying-out) that row. Re-setting the current
 * candidate is a no-op, so a pointer resting on one row does not postpone the
 * commit forever. A different candidate restarts the hold from the newest
 * target, and a target that returns to the published value cancels the
 * candidate without a commit. `flush()` commits the candidate immediately
 * (drop / dragend / dragleave), so the six drop handlers always act on the
 * freshest target.
 *
 * `null` is a settle sentinel rather than a hover target: it always gets an
 * applied commit, which releases the resting-pointer lock even when the
 * published target is already null (dragend/dragleave stay idempotent). The
 * commit still dedupes with `sameDropTarget`, so an already-null target causes
 * no React update.
 *
 * @param {{
 *   same: (left: object | null, right: object | null) => boolean,
 *   read: () => object | null,
 *   publish: (next: object | null) => void,
 *   clearLock?: () => void,
 *   onChange?: (previous: object | null, next: object | null) => void,
 *   onSkip?: () => void,
 *   count?: () => void,
 *   pendingCount?: () => void,
 *   now?: () => number,
 *   setTimer?: (callback: () => void, ms: number) => number,
 *   clearTimer?: (id: number) => void
 * }} options
 */
export const createDropTargetCommit = ({
  same,
  read,
  publish,
  clearLock = () => {},
  onChange = () => {},
  onSkip = () => {},
  // `drag:frame` counts applied target commits (hold expiry or synchronous flush), not rAF frames.
  count = () => perfCount('drag:frame'),
  // `drag:targetPending` counts hold periods started for a new target, the
  // run9 A/B comparison against `drag:frame` (46 target changes per drag-group
  // gesture in run8; A targets fewer than 10 committed changes).
  pendingCount = () => perfCount('drag:targetPending'),
  now = defaultNow,
  setTimer = (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimer = (id) => globalThis.clearTimeout?.(id),
} = {}) => {
  /** Target the drag currently resolves to; `null` is the no-target state. */
  let candidate = null
  /** True while `candidate` still waits for its hold or a flush. */
  let active = false
  /** Hold timer handle; `null` when no timer is armed. */
  let timer = null
  /** `now()` of the latest candidate change (exposed for tests/diagnostics). */
  let candidateAt = 0

  const disarm = () => {
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  /**
   * Commit the candidate. `false` when nothing was pending, so a second flush
   * (or a flush after a timer commit) is a no-op.
   */
  const commit = () => {
    disarm()
    if (!active) return false
    active = false
    count()
    const next = candidate
    // A null settle releases the resting-pointer lock even when the published
    // target is already null (dragend/dragleave are idempotent).
    if (next === null) clearLock()
    const previous = read()
    if (same(previous, next)) {
      onSkip()
      return true
    }
    onChange(previous, next)
    publish(next)
    return true
  }

  /** Start the hold for the current candidate. */
  const arm = () => {
    active = true
    timer = setTimer(commit, TARGET_HOLD_MS)
  }

  return {
    /**
     * Record the newest target as the candidate. The same target never
     * restarts the hold; a different one restarts it from this event.
     */
    set(next) {
      if (next === null) {
        // A settle that is already pending keeps its timer: invalid dragovers
        // repeat while the pointer sits still, and restarting the hold would
        // postpone the lock release forever.
        if (candidate === null && active) return
        disarm()
        candidate = null
        candidateAt = now()
        arm()
        return
      }
      if (same(candidate, next)) return
      disarm()
      candidate = next
      candidateAt = now()
      // Back on the already-published target: drop the candidate, publish nothing.
      if (same(read(), next)) {
        active = false
        return
      }
      pendingCount()
      arm()
    },
    /**
     * Commit the current candidate now, even before its hold expires (the six
     * drop handlers and the dragend/dragleave settle path call this first).
     * @returns {boolean} whether a candidate was committed
     */
    flush: commit,
    /** Drop the candidate and its timer without committing it (view unmount). */
    cancel() {
      disarm()
      active = false
      candidate = null
    },
    /** True while a candidate waits for its hold period. */
    pending: () => active,
    /** `now()` of the current candidate (the timer anchor), for tests. */
    candidateAt: () => candidateAt,
  }
}

/**
 * One-drag group-name cache (spec §14.2.3).
 *
 * A drag start builds the map once instead of running `findGroup`'s O(G) scan
 * on every dragover. The cache is keyed by document identity: a host or
 * optimistic update replaces `store.doc`, so a stale map can never outlive the
 * document it was built from (N3). A miss inside the same document falls back
 * to the live lookup instead of returning an empty name (freshness backstop).
 */
export const createDragLabelCache = () => {
  /** `{ doc, names }` of the last build, `null` before the first one/after clear. */
  let cache = null

  const build = (doc) => {
    const names = new Map()
    for (const group of doc?.groups ?? []) names.set(group.id, group.name)
    cache = { doc, names }
    return cache
  }

  return {
    /** Build the map when a drag starts. */
    build,
    /**
     * Name for a target group during a drag: the cached map first, then a live
     * lookup. Rebuilds when the document identity changed (N3).
     */
    nameOf(doc, groupId) {
      if (cache === null || cache.doc !== doc) build(doc)
      const cached = cache.names.get(groupId)
      if (cached !== undefined) return cached
      return findGroup(doc, groupId)?.name ?? ''
    },
    /** Forget the map after a drop/dragend. */
    clear() {
      cache = null
    },
    /** Number of cached groups (`0` before the first build); exposed for tests. */
    size: () => cache?.names.size ?? 0,
  }
}
