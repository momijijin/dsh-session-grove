/**
 * Client document controller (SPEC §7.4/§10).
 *
 * Owns the `/load` reads, the serialized commit paths (strict dialog commits and
 * the coalescing optimistic queue) and the epoch rules: an in-flight read whose
 * profile epoch changed is discarded and re-read once the old promise settles;
 * a refresh that arrives while a write is pending is deferred until the store
 * publishes a settled document.
 *
 * State ownership (SPEC §6.1): `loadPromise`, `loadGeneration`, `commitTail`,
 * the deferred-refresh flags and the published `debugProbe` flag live here. The
 * queue itself is created by the composition root and injected.
 */
import { shouldShowLoading } from './load-mode.js'
import { perfMark } from './perf.js'

/**
 * Create the document controller.
 *
 * @param {object} options
 * @param {object} options.store view store (getSnapshot/dispatch/subscribe)
 * @param {object} options.api HTTP adapter (`load`/`commit`)
 * @param {object} options.queue optimistic commit queue
 * @param {{ trace: Function, enabled: Function, init: Function, stop: Function }} options.diag
 * @param {() => void} options.onProfileUnavailable fired when `/load` reports an
 *   unreadable active profile; the composition root wires the profile list read.
 */
export const createDocumentSync = ({ store, api, queue, diag, onProfileUnavailable }) => {
  let loadPromise = null
  /** Monotonic token that invalidates an in-flight read on an active switch. */
  let loadGeneration = 0
  let commitTail = Promise.resolve()
  let refreshPending = false
  let refreshForced = false
  let debugProbe = false

  // --- document commit queue -------------------------------------------------
  /**
   * Non-optimistic commit (dialogs: create/rename/delete/icon/move-session/
   * move-group). Serialized with the optimistic queue: pending drops flush
   * first and the mutation resolves against the latest document, so a dialog
   * action can never overwrite a newer optimistic drop with a stale snapshot.
   * `saving` stays unpublished for the same reason as 0.2.2 (no view consumer).
   */
  const commitDoc = (nextDocOrUpdater) => {
    const run = commitTail.then(async () => {
      perfMark('commitDoc:start')
      try {
        perfMark('api:commit:start')
        const committed = await queue.commitStrict(nextDocOrUpdater)
        perfMark('api:commit:end', { ok: true })
        perfMark('store:doc')
        if (typeof globalThis.requestAnimationFrame === 'function') {
          globalThis.requestAnimationFrame(() => perfMark('frame:after-doc'))
        }
        return committed
      } catch (error) {
        perfMark('api:commit:end', { ok: false, code: error?.code ?? null })
        throw error
      } finally {
        perfMark('commitDoc:end')
      }
    })
    commitTail = run.catch(() => {})
    return run
  }

  /**
   * Optimistic drop commit: the next document is dispatched immediately against
   * the current optimistic doc; persistence runs through the coalescing queue.
   * `revision` stays server-confirmed until the write settles.
   */
  const commitOptimistic = (nextDocOrUpdater) => queue.commitOptimistic(nextDocOrUpdater)

  // --- document load ---------------------------------------------------------
  const load = ({ background = false } = {}) => {
    if (loadPromise !== null) return loadPromise
    const epochAtStart = store.getSnapshot().profileEpoch
    const generationAtStart = loadGeneration
    const showLoading = shouldShowLoading({ background, docState: store.getSnapshot().docState })
    loadPromise = (async () => {
      if (showLoading) store.dispatch('load-start')
      let loadedOk = false
      let stale = false
      const fail = (code) => {
        if (showLoading) store.dispatch('load-error', { code })
        else store.dispatch('banner', { banner: { kind: 'error', code } })
      }
      try {
        const result = await api.load()
        // SPEC §10: an active switch while this read was in flight means this
        // response belongs to the previous profile — discard it and re-read.
        stale = store.getSnapshot().profileEpoch !== epochAtStart || loadGeneration !== generationAtStart
        if (stale) {
          diag.trace('load.stale', { reason: 'profile-epoch' })
          return
        }
        if (result.ok === true) {
          debugProbe = result.debugProbe === true
          if (result.diagnostics === true) {
            if (!diag.enabled()) diag.init({ enabled: true })
          } else if (diag.enabled()) {
            diag.stop()
          }
          // `profileId` is additive (SPEC §5.1); a legacy host omits it and the
          // store keeps the previously known/default profile id.
          store.dispatch('load-success', {
            doc: result.doc,
            revision: result.revision,
            warning: result.warning,
            profileId: result.profileId,
          })
          loadedOk = true
          return
        }
        fail(result.routeUnavailable ? 'route-unavailable' : result.code ?? 'load-failed')
        if (result.code === 'profile-unhealthy' || result.code === 'profile-missing') {
          // SPEC §7.3 recovery: expose the healthy profiles so the shell can
          // offer a recovery target; the main view shows the load error until
          // an explicit preview/activate succeeds.
          onProfileUnavailable()
        }
      } catch (error) {
        if (store.getSnapshot().profileEpoch !== epochAtStart || loadGeneration !== generationAtStart) {
          stale = true
          return
        }
        fail('load-failed')
        if (globalThis.console?.warn) globalThis.console.warn('[dsh-session-grove] load failed', error)
      } finally {
        loadPromise = null
        if (stale) {
          // Re-read the newly active profile once the old promise settles.
          refreshPending = true
          refreshForced = true
        }
        // A newer revision may have arrived while this read was in flight, or
        // a refresh may have been deferred behind an optimistic write. Re-check
        // against the just-loaded snapshot before declaring the view settled.
        if (loadedOk || stale) {
          const current = store.getSnapshot()
          if (refreshPending || current.latestSeenRevision > current.revision) {
            const pendingForce = refreshForced
            queueMicrotask(() => refresh({ force: pendingForce }))
          }
        }
      }
    })()
    return loadPromise
  }

  const retryLoad = () => {
    if (store.getSnapshot().docState === 'loading') return load()
    return load()
  }

  const refresh = ({ force = false } = {}) => {
    const snapshot = store.getSnapshot()
    if (loadPromise !== null || snapshot.optimistic) {
      refreshPending = true
      refreshForced = refreshForced || force
      return loadPromise
    }
    if (!force && snapshot.latestSeenRevision <= snapshot.revision) {
      refreshPending = false
      refreshForced = false
      return null
    }
    refreshPending = false
    refreshForced = false
    return load({ background: true })
  }

  /** SPEC §7.4 step 2: a profile switch must be refused while a write is pending. */
  const isPending = () => queue?.isPending() === true

  /**
   * Store-publish hook owned by the host mount wiring: an optimistic write that
   * settles may have left a deferred refresh behind.
   */
  const onStorePublish = () => {
    if (!refreshPending) return
    const snapshot = store.getSnapshot()
    if (snapshot.optimistic) return
    refresh({ force: refreshForced })
  }

  /**
   * SPEC §7.3: a profile switch invalidates the deferred refresh and any doc
   * write still queued for the previous profile.
   */
  const applyEpoch = () => {
    refreshPending = false
    refreshForced = false
    queue?.discardPending('profile-changed')
  }

  /**
   * SPEC §7.5: another window switched the active profile. The in-flight read —
   * if any — may still return the previous profile, so invalidate it and queue a
   * forced re-read (`load()` from the caller).
   */
  const invalidate = () => {
    loadGeneration += 1
    refreshPending = false
    refreshForced = true
  }

  const dispose = () => {
    loadPromise = null
    refreshPending = false
    refreshForced = false
  }

  const getDebugProbe = () => debugProbe

  return {
    load,
    retryLoad,
    refresh,
    commitDoc,
    commitOptimistic,
    isPending,
    onStorePublish,
    applyEpoch,
    invalidate,
    dispose,
    getDebugProbe,
  }
}
