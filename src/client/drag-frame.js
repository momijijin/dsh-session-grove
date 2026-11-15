/**
 * Candidate hold + speed gate + name cache for the session/group drag target
 * (0.4.0-beta.66 v8 frame coalescing, spec §14.2.3; v9 hold timer, spec §15.2;
 * v10 speed gate, spec §16.2).
 *
 * `dragover` fires continuously while the pointer rests on a row (110–243
 * events/s measured), and every event used to re-run the group-name lookup and
 * possibly call setState with an equivalent target. Two seams fix that:
 *
 * - `createDropTargetCommit`: a new target must survive `TARGET_HOLD_MS` (70 ms)
 *   before it is committed, because in the run8 trace every target change
 *   inserted or removed the placeholder and each of those layout pushes cost a
 *   22–25 ms style+layout long task; crossing a row during a fast drag produced
 *   21–46 of them per gesture. A pointer that is aiming rather than sweeping
 *   does not need that stabilization: when the net speed over the last
 *   `SPEED_WINDOW_MS` is below `SPEED_GATE_PX_PER_MS`, or the pointer paused for
 *   more than `PAUSE_MS`, the target is committed immediately; a hold that is
 *   still pending is upgraded to an immediate commit when the last
 *   `UPGRADE_WINDOW_MS` of samples slowed down. The newest target wins, an
 *   unchanged target never restarts its hold, and drop/end paths flush the
 *   current candidate synchronously so a drop never acts on the previous target.
 * - `createDragLabelCache`: build the groupId → name map once when the drag
 *   starts; a mid-drag document identity change rebuilds it (N3) and a miss
 *   falls back to the live lookup (freshness backstop).
 *
 * Both are DOM-free and take the clock/sinks as parameters, so `npm test`
 * drives the hold and the fake pointer with a fake clock
 * (`tests/client/drag-frame.test.js`). They live outside `components.js`
 * because `npm test` never imports a component module; pulling that graph into
 * the coverage run would collapse the coverage gate.
 */
import { findGroup } from '../shared/model.js'
import { perfCount } from './perf.js'

/** How long a new drop target must survive before it is committed (spec §15.2). */
export const TARGET_HOLD_MS = 70

/**
 * Speed gate (spec §16.2): at or above this the pointer is sweeping and a new
 * target keeps the 70 ms hold; below it the pointer is aiming, so the target is
 * committed immediately. 0.5 px/ms ≈ 8.35 px/frame at 60 fps.
 */
export const SPEED_GATE_PX_PER_MS = 0.5

/** Entry window: net `|Δy|` over this many milliseconds of pointer samples. */
export const SPEED_WINDOW_MS = 100

/** Upgrade window: checked while a hold is pending, needs at least two samples. */
export const UPGRADE_WINDOW_MS = 40

/** Samples this close to the previous one belong to the same native event. */
export const SAMPLE_DEDUPE_MS = 2

/** A gap above this restarts the sample window instead of averaging across it. */
export const PAUSE_MS = 100

/**
 * Hard bound for the sample ring: the widest window plus one 20 ms sample step,
 * so the window never grows with the length of the drag.
 */
const SAMPLE_WINDOW_MS = 120

/** `performance.now()` when available, `Date.now()` otherwise. */
const defaultNow = () =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now()

/**
 * Hold-timer drop-target setter with the v10 speed gate (spec §15.2, §16.2).
 *
 * `set(next, pointer)` only records the target as a *candidate*; the hold timer
 * commits it after `TARGET_HOLD_MS`, which is what keeps a pointer that merely
 * crosses a row from publishing (and re-laying-out) that row. The optional
 * `pointer` is a `{ x, y, t }` sample from the dragover dispatch boundary: when
 * the net speed over the last `SPEED_WINDOW_MS` is below the gate (or the
 * pointer paused above `PAUSE_MS`), the target is committed immediately instead
 * of being held, so a slow aim is not delayed by the stabilization window.
 * Re-setting the current candidate is a no-op, so a pointer resting on one row
 * does not postpone the commit forever — except that a pending hold is upgraded
 * to an immediate commit when the last `UPGRADE_WINDOW_MS` of samples shows the
 * pointer slowed down. A different candidate restarts the hold from the newest
 * target, and a target that returns to the published value cancels the
 * candidate without a commit. `flush()` commits the candidate immediately
 * (drop / dragend / dragleave), so the six drop handlers always act on the
 * freshest target.
 *
 * `null` is a settle sentinel rather than a hover target: it always gets an
 * applied commit, which releases the resting-pointer lock even when the
 * published target is already null (dragend/dragleave stay idempotent), and it
 * never takes part in the speed gate. The commit still dedupes with
 * `sameDropTarget`, so an already-null target causes no React update.
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
 *   immediateCount?: () => void,
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
  // `drag:targetImmediate` counts the targets the gate committed without a hold
  // (including an attempt that `sameDropTarget` then deduped), the run10
  // comparison against the hold path.
  immediateCount = () => perfCount('drag:targetImmediate'),
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
  /** Bounded `{ x, y, t }` pointer window, oldest first (spec §16.2). */
  let samples = []

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

  /**
   * Push one pointer sample into the bounded speed window.
   *
   * Returns `null` when there is no usable pointer at all (the caller keeps the
   * fixed hold), otherwise `{ paused, added }`:
   *
   * - a gap above `PAUSE_MS` restarts the window, because motion from before a
   *   pause cannot describe the current approach;
   * - a sample within `SAMPLE_DEDUPE_MS` of the previous accepted one is
   *   dropped, because dragover can reach several surfaces for one native event.
   */
  const recordSample = (pointer) => {
    if (pointer === null || typeof pointer !== 'object') return null
    const y = pointer.y
    const t = pointer.t
    if (!Number.isFinite(y) || !Number.isFinite(t)) return null
    const x = Number.isFinite(pointer.x) ? pointer.x : 0
    const last = samples.length > 0 ? samples[samples.length - 1] : null
    if (last !== null && t - last.t > PAUSE_MS) {
      samples = [{ x, y, t }]
      return { paused: true, added: true }
    }
    if (last !== null && t - last.t <= SAMPLE_DEDUPE_MS) return { paused: false, added: false }
    samples.push({ x, y, t })
    // Keep the window bounded by time, not by gesture length.
    while (samples.length > 2 && t - samples[0].t > SAMPLE_WINDOW_MS) samples.shift()
    return { paused: false, added: true }
  }

  /**
   * Net `|Δy| / Δt` over the newest `windowMs` of accepted samples. `null` when
   * the window holds fewer than two samples, i.e. there is no measurable motion
   * yet; the caller then keeps the fixed hold instead of guessing.
   */
  const windowSpeed = (windowMs) => {
    if (samples.length < 2) return null
    const last = samples[samples.length - 1]
    let index = samples.length - 1
    while (index > 0 && last.t - samples[index - 1].t <= windowMs) index -= 1
    const first = samples[index]
    const duration = last.t - first.t
    if (duration <= 0) return null
    return Math.abs(last.y - first.y) / duration
  }

  /**
   * The gate chose "commit now" (slow entry, pause, or a slowed pending hold).
   * No hold period exists, so only `drag:targetImmediate` counts;
   * `pendingCount()` is never called here and `commit()` disarms.
   */
  const commitNow = () => {
    active = true
    immediateCount()
    commit()
  }

  return {
    /**
     * Record the newest target as the candidate. The same target never
     * restarts the hold (but a slowed 40 ms sub-window can end it); a different
     * one restarts it from this event.
     *
     * @param {object | null} next
     * @param {{ x?: number, y: number, t: number } | null} [pointer]
     */
    set(next, pointer) {
      const sample = recordSample(pointer)
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
      // The upgrade check must run before the same-candidate early return: a
      // pointer that came to rest keeps resolving to the same target, and only
      // a later slow sample can end that candidate's hold early (spec §16.2).
      if (active && same(candidate, next)) {
        if (sample !== null && sample.added && !sample.paused) {
          const upgradeSpeed = windowSpeed(UPGRADE_WINDOW_MS)
          if (upgradeSpeed !== null && upgradeSpeed < SPEED_GATE_PX_PER_MS) commitNow()
        }
        return
      }
      if (same(candidate, next)) return
      disarm()
      candidate = next
      candidateAt = now()
      // A missing sample (no pointer, or one dropped as a duplicate) is not a
      // measurement: it keeps the fixed hold rather than guessing a speed.
      if (sample !== null) {
        const speed = windowSpeed(SPEED_WINDOW_MS)
        if (sample.paused || (speed !== null && speed < SPEED_GATE_PX_PER_MS)) {
          commitNow()
          return
        }
      }
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
    /** Drop the candidate, its timer and the pointer window (view unmount). */
    cancel() {
      disarm()
      active = false
      candidate = null
      samples = []
    },
    /**
     * Forget the speed window without touching the timer, candidate or the
     * committed target. The two drag starts call this so the first candidate of
     * a drag is never decided by motion from the previous drag.
     */
    resetSamples() {
      samples = []
    },
    /** True while a candidate waits for its hold period. */
    pending: () => active,
    /** `now()` of the current candidate (the timer anchor), for tests. */
    candidateAt: () => candidateAt,
    /** Number of samples in the bounded speed window (for tests). */
    sampleCount: () => samples.length,
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
