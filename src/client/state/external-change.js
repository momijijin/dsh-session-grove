/**
 * External-change routing (SPEC 7.5).
 *
 * Pure decision helpers for the SSE change stream: which revision events may
 * advance the visible document, and how one stream event maps onto store
 * actions. Kept separate from the store so the gating stays unit-testable
 * without importing the React plugin shell.
 */

/**
 * SPEC §7.5: a revision event may advance the visible document only when it is
 * scoped to the active profile. A host that predates profiles omits
 * `profileId`; those events keep the legacy (single-profile) behaviour.
 *
 * @param {unknown} profileId event profile id
 * @param {string|null} activeId profile the client currently treats as active
 */
export const revisionAppliesToDocument = (profileId, activeId) => {
  if (profileId === undefined || profileId === null || profileId === '') return true
  return typeof activeId === 'string' && activeId !== '' && profileId === activeId
}

/**
 * Decide what one SSE `revision` event may do (SPEC §7.5).
 *
 * @param {{
 *   profileId?: string|null,
 *   revision?: number,
 *   activeId?: string|null,
 *   currentRevision?: number,
 *   latestSeenRevision?: number,
 * }} event
 * @returns {{ accepted: boolean, refresh: boolean, latestSeenRevision: number }}
 */
export const revisionEventPlan = ({
  profileId = null,
  revision = null,
  activeId = null,
  currentRevision = 0,
  latestSeenRevision = 0,
} = {}) => {
  const seen = Number.isInteger(latestSeenRevision) && latestSeenRevision >= 0 ? latestSeenRevision : 0
  if (!Number.isInteger(revision) || revision < 0) {
    return { accepted: false, refresh: false, latestSeenRevision: seen }
  }
  if (!revisionAppliesToDocument(profileId, activeId)) {
    // Non-active profile writes (2026-11 control/tool scope) must never move
    // the visible revision or trigger a reload loop (WORKLOG S4 carry #1).
    return { accepted: false, refresh: false, latestSeenRevision: seen }
  }
  return {
    accepted: true,
    refresh: revision > currentRevision,
    latestSeenRevision: Math.max(seen, revision),
  }
}

/**
 * Route stream events into store actions (SPEC §7.5). Kept here — pure and
 * injectable — so the revision gating is unit-tested without importing the
 * React plugin shell (`plugin.js` cannot load under `node --test`).
 *
 * @param {{
 *   store: { getSnapshot: () => object, dispatch: (action: string, payload?: object) => object },
 *   requestRefresh?: (options?: object) => unknown,
 *   onActiveChange?: (activeId: string, info: object) => void,
 *   isLocalSwitch?: (activeId: string) => boolean,
 *   trace?: (type: string, detail?: object) => void,
 * }} deps
 */
export const createExternalChangeRouter = ({
  store,
  requestRefresh = () => {},
  onActiveChange = () => {},
  isLocalSwitch = () => false,
  trace = () => {},
} = {}) => {
  if (!store || typeof store.getSnapshot !== 'function' || typeof store.dispatch !== 'function') {
    return { revision: () => false, active: () => false }
  }

  const revision = (payload) => {
    const snapshot = store.getSnapshot()
    const activeId = snapshot.profiles?.activeId ?? snapshot.profileId ?? null
    const plan = revisionEventPlan({
      profileId: payload?.profileId,
      revision: payload?.revision,
      activeId,
      currentRevision: snapshot.revision,
      latestSeenRevision: snapshot.latestSeenRevision,
    })
    trace('stream.revision', {
      profileId: payload?.profileId ?? null,
      revision: payload?.revision ?? null,
      activeId,
      accepted: plan.accepted,
      refresh: plan.refresh,
    })
    if (!plan.accepted) return false
    if (plan.latestSeenRevision !== snapshot.latestSeenRevision) {
      store.dispatch('external-revision', { latestSeenRevision: plan.latestSeenRevision })
    }
    if (plan.refresh) requestRefresh()
    return plan.refresh
  }

  const active = (payload) => {
    const activeId = payload?.activeId
    if (typeof activeId !== 'string' || activeId === '') return false
    if (isLocalSwitch(activeId)) {
      trace('stream.active', { activeId, local: true })
      onActiveChange(activeId, { changed: false, local: true, registryRevision: payload?.registryRevision })
      return false
    }
    const snapshot = store.getSnapshot()
    const known = snapshot.profiles?.activeId ?? snapshot.profileId ?? null
    const changed = known !== null && activeId !== known
    if (changed) {
      store.dispatch('profile-external-active', {
        activeId,
        registryRevision: payload?.registryRevision,
      })
    }
    trace('stream.active', { activeId, changed, local: false })
    onActiveChange(activeId, { changed, local: false, registryRevision: payload?.registryRevision })
    return changed
  }

  return { revision, active }
}
