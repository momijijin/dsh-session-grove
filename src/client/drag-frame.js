/**
 * Frame coalescing + name cache for the session/group drag target
 * (0.4.0-beta.66 v8, spec §14.2.3).
 *
 * `dragover` fires continuously while the pointer rests on a row (110–243
 * events/s measured), and every event used to re-run the group-name lookup and
 * possibly call setState with an equivalent target. Two seams fix that:
 *
 * - `createDropTargetCommit`: keep only the newest target of a frame, commit it
 *   once, then compare with the published target before touching React. Drop
 *   handlers flush first so they never read a previous frame's target.
 * - `createDragLabelCache`: build the groupId → name map once when the drag
 *   starts; a mid-drag document identity change rebuilds it (N3) and a miss
 *   falls back to the live lookup (freshness backstop).
 *
 * Both are DOM-free and take the batch/sinks as parameters, so `npm test`
 * drives them without React (`tests/client/drag-frame.test.js`). They live
 * outside `components.js` because `npm test` never imports a component module;
 * pulling that graph into the coverage run would collapse the coverage gate.
 */
import { findGroup } from '../shared/model.js'
import { perfCount } from './perf.js'

/**
 * Frame-coalesced drop-target setter (spec §14.2.3).
 *
 * `set(next)` queues the newest target and arms one frame; the frame always
 * runs the injected equality check first, so an unchanged target performs no
 * React update (the 0.2.2 stationary-dragover guard, kept). A `null` settle
 * releases the resting-pointer lock even when the published target is already
 * null, which keeps dragend/dragleave idempotent.
 *
 * @param {{
 *   batch: { schedule: (fn: () => void) => void, cancel: () => void },
 *   same: (left: object | null, right: object | null) => boolean,
 *   read: () => object | null,
 *   publish: (next: object | null) => void,
 *   clearLock?: () => void,
 *   onChange?: (previous: object | null, next: object | null) => void,
 *   onSkip?: () => void,
 *   count?: () => void
 * }} options
 */
export const createDropTargetCommit = ({
  batch,
  same,
  read,
  publish,
  clearLock = () => {},
  onChange = () => {},
  onSkip = () => {},
  // `drag:frame` counts applied target commits (including a synchronous flush), not rAF frames.
  count = () => perfCount('drag:frame'),
}) => {
  /** Newest queued target; `undefined` only when the queue is empty. */
  let pending
  let queued = false

  const applyPending = () => {
    if (!queued) return
    const next = pending
    queued = false
    pending = undefined
    count()
    // A null settle always releases the lock, even for an already-null target.
    if (next === null) clearLock()
    const previous = read()
    if (same(previous, next)) {
      onSkip()
      return
    }
    onChange(previous, next)
    publish(next)
  }

  return {
    /** Queue the newest target; one frame commits the last one only. */
    set(next) {
      pending = next
      queued = true
      batch.schedule(applyPending)
    },
    /**
     * Commit the queued target now and drop its frame. Drop handlers flush
     * before they read the published target (`onDropUngroupedBody`).
     * @returns {boolean} whether a queued target was committed
     */
    flush() {
      if (!queued) return false
      batch.cancel()
      applyPending()
      return true
    },
    /** Drop the queued target without committing it (view unmount). */
    cancel() {
      queued = false
      pending = undefined
      batch.cancel()
    },
    /** True while a target waits for its frame. */
    pending: () => queued,
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
