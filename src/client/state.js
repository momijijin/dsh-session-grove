/**
 * Client view state for the global session groups sidebar.
 *
 * Pure, React-free module: tests import it directly; the bundle wires it to
 * components. The store owns only *view* state (mode, filters, expansion, menus,
 * loaded doc snapshot). Host-owned data (titles, archive flags, workspace
 * membership) is never copied here beyond the current confirmed doc.
 *
 * Multi-profile (SPEC §7.2/§7.3): the snapshot also carries the loaded
 * `profileId`, the registry-backed `profiles` summary, the switch-preview state
 * and the `profileEpoch` that marks every active-profile change. The store
 * object itself is never rebuilt — React holds its `subscribe`/`getSnapshot`
 * identity for the whole page lifetime.
 *
 * The persistence adapter lives in './state/persistence.js' and the external
 * change routing in './state/external-change.js'; this module keeps only the
 * store and re-exports both halves for existing importers (SPEC 7.2).
 */
import { ARCHIVE_FILTERS } from '../shared/constants.js'
import { emptyDoc } from '../shared/model.js'
import { MAX_PROFILES } from '../shared/profile-limits.js'
import { DEFAULT_PROFILE_ID, readArchiveFilter, readCollapsed, readViewMode, safeStorage, writeArchiveFilter, writeCollapsed, writeViewMode } from './state/persistence.js'

/** Fallback profile cap when a legacy host omits `limits` (SPEC §5.3). */
const DEFAULT_PROFILE_LIMIT = MAX_PROFILES

/**
 * Empty profile summary (SPEC §7.2); `available` flips only on a 404 probe.
 * `archivedList` is only filled by `includeArchived` reads (manage dialog) so a
 * plain switcher refresh never drops the archived rows (SPEC §5.3/§9.5).
 */
const initialProfiles = () => ({
  available: true,
  loading: false,
  degraded: false,
  registryRevision: 0,
  activeId: null,
  list: [],
  archivedList: [],
  limits: { max: DEFAULT_PROFILE_LIMIT },
  error: null,
})

/** Empty switch-preview state (SPEC §7.2); the last confirmation clears it. */
const initialProfilePreview = () => ({
  open: false,
  loading: false,
  targetId: null,
  targetName: null,
  targetRevision: null,
  previewToken: null,
  doc: null,
  diff: null,
  baseActiveId: null,
  baseActiveRevision: null,
  error: null,
  stale: false,
})

/** Initial snapshot for {@link createStore}. */
const initialSnapshot = (storage) => ({
  viewMode: readViewMode(storage),
  archiveFilter: readArchiveFilter(storage),
  doc: emptyDoc(),
  revision: 0,
  /** idle | loading | ready | error */
  docState: 'idle',
  warning: null,
  /** last host-confirmed doc; commit failures revert to this */
  lastConfirmed: null,
  /** whether `doc` contains optimistic (not yet persisted) mutations */
  optimistic: false,
  /** profile the loaded `doc`/`revision` belong to (SPEC §7.3) */
  profileId: null,
  /** registry-backed profile summary (SPEC §7.2) */
  profiles: initialProfiles(),
  /** pending switch preview (SPEC §7.2) */
  profilePreview: initialProfilePreview(),
  /** true while a local activate request is in flight */
  profileSwitching: false,
  /** increments on every active-profile change (SPEC §7.3) */
  profileEpoch: 0,
  /** profile id the current epoch belongs to (prevents a double bump) */
  profileEpochId: null,
  /** highest revision announced by SSE while still relevant to this profile */
  latestSeenRevision: 0,
  /** group ids expanded in the tree (missing = expanded) */
  collapsed: readCollapsed(storage),
  /** profile the in-memory `collapsed` map belongs to */
  collapsedProfileId: DEFAULT_PROFILE_ID,
  /** current popover/menu descriptor, at most one at a time */
  menu: null,
  /** current modal descriptor (rename/new/delete/move/archive-running) */
  dialog: null,
  /** { kind, message } transient toast */
  toast: null,
  /** banner for load/commit/route failures */
  banner: null,
  /** in-flight doc write indicator */
  saving: false,
})

/**
 * Create the view store.
 * @param {{ storage?: Storage | null }} [options]
 * @returns {{
 *   getSnapshot: () => object,
 *   subscribe: (listener: () => void) => () => void,
 *   update: (patch: object | ((snapshot: object) => object)) => object,
 *   dispatch: (action: string, payload?: object) => object
 * }}
 */
export const createStore = ({ storage = safeStorage() } = {}) => {
  let snapshot = initialSnapshot(storage)
  const listeners = new Set()

  const getSnapshot = () => snapshot

  const subscribe = (listener) => {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const publish = (next) => {
    // Profile switches replace the whole collapsed map with the target
    // profile's stored one; persisting that back would either rewrite another
    // profile or upgrade a legacy value without a user edit. Only expansion
    // actions inside the same profile write.
    if (next.collapsed !== snapshot.collapsed && next.collapsedProfileId === snapshot.collapsedProfileId) {
      writeCollapsed(next.collapsed, storage, next.collapsedProfileId)
    }
    snapshot = next
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        /* a broken subscriber must not take down the view */
      }
    }
    return snapshot
  }

  const update = (patch) => {
    const next = typeof patch === 'function' ? patch(snapshot) : patch
    if (!next || next === snapshot) return snapshot
    return publish({ ...snapshot, ...next })
  }

  /**
   * Small action vocabulary so components never mutate the snapshot directly.
   * @param {string} action
   * @param {object} [payload]
   */
  const dispatch = (action, payload = {}) => {
    switch (action) {
      case 'view-mode': {
        const mode = payload.mode === 'groups' ? 'groups' : 'workspace'
        if (mode === snapshot.viewMode) return snapshot
        writeViewMode(mode, storage)
        return publish({ ...snapshot, viewMode: mode })
      }
      case 'archive-filter': {
        const filter = ARCHIVE_FILTERS.includes(payload.filter) ? payload.filter : 'hidden'
        if (filter === snapshot.archiveFilter) return snapshot
        writeArchiveFilter(filter, storage)
        return publish({ ...snapshot, archiveFilter: filter })
      }
      case 'load-start':
        return publish({ ...snapshot, docState: 'loading', banner: null })
      case 'load-success': {
        const profileId =
          typeof payload.profileId === 'string' && payload.profileId !== ''
            ? payload.profileId
            : snapshot.profileId ?? DEFAULT_PROFILE_ID
        // A different profile than the one currently loaded can only appear
        // after the initial load (mount leaves `profileId` null); treat it as a
        // passive switch so epoch/reset semantics stay uniform. The epoch id
        // prevents a double bump when an `active` event already reset for this
        // same target before the read answered.
        const switched =
          snapshot.profileId !== null &&
          snapshot.profileId !== profileId &&
          snapshot.profileEpochId !== profileId
        const collapsedSwitched = snapshot.collapsedProfileId !== profileId
        return publish({
          ...snapshot,
          docState: 'ready',
          doc: payload.doc,
          revision: payload.revision,
          lastConfirmed: payload.doc,
          warning: payload.warning ?? null,
          optimistic: false,
          banner: payload.warning ? { kind: 'warning', code: payload.warning } : null,
          profileId,
          profileEpochId: profileId,
          profiles: { ...snapshot.profiles, activeId: profileId },
          profileEpoch: switched ? snapshot.profileEpoch + 1 : snapshot.profileEpoch,
          latestSeenRevision: switched ? 0 : snapshot.latestSeenRevision,
          collapsed: collapsedSwitched ? readCollapsed(storage, profileId) : snapshot.collapsed,
          collapsedProfileId: collapsedSwitched ? profileId : snapshot.collapsedProfileId,
          profileSwitching: switched ? false : snapshot.profileSwitching,
          profilePreview: switched ? initialProfilePreview() : snapshot.profilePreview,
          menu: switched ? null : snapshot.menu,
          dialog: switched ? null : snapshot.dialog,
        })
      }
      case 'load-error':
        return publish({
          ...snapshot,
          docState: 'error',
          profileSwitching: false,
          banner: { kind: 'error', code: payload.code ?? 'load-failed' },
        })
      case 'doc': {
        const doc = payload.doc
        const revision = payload.revision ?? snapshot.revision
        return publish({ ...snapshot, doc, revision, lastConfirmed: doc, optimistic: false, banner: null })
      }
      case 'optimistic-doc':
        // Apply a drop to the view immediately. The revision is deliberately
        // untouched: it stays the last server-confirmed base for the async write.
        return publish({ ...snapshot, doc: payload.doc, optimistic: true })
      case 'optimistic-confirmed': {
        const keepDoc = payload.keepDoc === true
        return publish({
          ...snapshot,
          doc: keepDoc ? snapshot.doc : payload.confirmedDoc ?? snapshot.doc,
          revision: payload.revision ?? snapshot.revision,
          lastConfirmed: payload.confirmedDoc ?? snapshot.lastConfirmed,
          optimistic: keepDoc,
          banner: null,
        })
      }
      case 'optimistic-rollback': {
        const code = payload.code ?? null
        // `profile-changed` reuses the conflict banner copy (SPEC §10: roll back,
        // do not silently retry). S6 owns the dedicated profile wording.
        const bannerCode = code === 'profile-changed' ? 'conflict' : code
        return publish({
          ...snapshot,
          doc: snapshot.lastConfirmed ?? snapshot.doc,
          optimistic: false,
          banner: code
            ? { kind: code === 'conflict' || code === 'profile-changed' ? 'warning' : 'error', code: bannerCode }
            : snapshot.banner,
        })
      }
      case 'saving':
        return publish({ ...snapshot, saving: Boolean(payload.saving) })
      case 'commit-conflict':
        return publish({
          ...snapshot,
          doc: payload.doc ?? snapshot.doc,
          revision: payload.revision ?? snapshot.revision,
          lastConfirmed: payload.doc ?? snapshot.lastConfirmed,
          optimistic: false,
          banner: { kind: 'warning', code: 'conflict' },
        })
      case 'commit-error':
        return publish({ ...snapshot, banner: { kind: 'error', code: payload.code ?? 'commit-failed' } })
      case 'toggle-group': {
        const id = payload.id
        const collapsed = { ...snapshot.collapsed }
        if (collapsed[id]) delete collapsed[id]
        else collapsed[id] = true
        return publish({ ...snapshot, collapsed })
      }
      case 'expand-group': {
        if (!payload.id || !snapshot.collapsed[payload.id]) return snapshot
        const collapsed = { ...snapshot.collapsed }
        delete collapsed[payload.id]
        return publish({ ...snapshot, collapsed })
      }
      case 'collapse-group': {
        if (!payload.id) return snapshot
        return publish({ ...snapshot, collapsed: { ...snapshot.collapsed, [payload.id]: true } })
      }
      case 'reset-collapsed': {
        if (Object.keys(snapshot.collapsed).length === 0) return snapshot
        return publish({ ...snapshot, collapsed: {} })
      }
      // --- multi-profile (SPEC §7.2-7.5) ---------------------------------
      case 'profiles-loading':
        if (snapshot.profiles.loading) return snapshot
        return publish({ ...snapshot, profiles: { ...snapshot.profiles, loading: true, error: null } })
      case 'profiles-success': {
        // Registry revisions are monotonic: an older in-flight list read may
        // refresh rows, but it must not move `activeId`/revision back after a
        // switch response already advanced them.
        const stale = Number.isInteger(payload.registryRevision) &&
          payload.registryRevision < snapshot.profiles.registryRevision
        const activeId = stale
          ? snapshot.profiles.activeId
          : typeof payload.activeId === 'string' && payload.activeId !== ''
            ? payload.activeId
            : snapshot.profiles.activeId
        const rows = Array.isArray(payload.list) ? payload.list : []
        const includeArchived = payload.includeArchived === true
        const max = Number.isInteger(payload.limits?.max) && payload.limits.max > 0
          ? payload.limits.max
          : snapshot.profiles.limits?.max ?? DEFAULT_PROFILE_LIMIT
        return publish({
          ...snapshot,
          profiles: {
            available: payload.available !== false,
            loading: false,
            degraded: payload.degraded === true,
            registryRevision: stale
              ? snapshot.profiles.registryRevision
              : Number.isInteger(payload.registryRevision)
                ? payload.registryRevision
                : snapshot.profiles.registryRevision,
            activeId,
            // Default reads never contain archived rows; the manage dialog's
            // opt-in read splits them into their own list so a later switcher
            // refresh cannot wipe the rows it is showing.
            list: includeArchived ? rows.filter((profile) => profile?.archived !== true) : rows,
            archivedList: includeArchived
              ? rows.filter((profile) => profile?.archived === true)
              : snapshot.profiles.archivedList,
            limits: { max },
            error: null,
          },
        })
      }
      case 'profiles-error':
        return publish({
          ...snapshot,
          profiles: {
            ...snapshot.profiles,
            loading: false,
            error: { code: payload.code ?? 'profiles-failed', message: payload.message ?? null },
          },
        })
      case 'profiles-unavailable':
        // Old host: the route was never mounted. Keep single-profile behaviour
        // and never bubble this into the main view (SPEC §7.7).
        return publish({
          ...snapshot,
          profiles: {
            ...snapshot.profiles,
            available: false,
            loading: false,
            degraded: false,
            list: [],
            archivedList: [],
            error: null,
          },
        })
      case 'external-revision': {
        const revision = Number.isInteger(payload.latestSeenRevision)
          ? payload.latestSeenRevision
          : payload.revision
        if (!Number.isInteger(revision) || revision < 0 || revision <= snapshot.latestSeenRevision) return snapshot
        return publish({ ...snapshot, latestSeenRevision: revision })
      }
      case 'profile-switch-start': {
        if (snapshot.profileSwitching) return snapshot
        return publish({
          ...snapshot,
          profileSwitching: true,
          profilePreview: {
            ...snapshot.profilePreview,
            error: null,
            stale: false,
          },
        })
      }
      case 'profile-switch-success': {
        const profileId =
          typeof payload.profileId === 'string' && payload.profileId !== ''
            ? payload.profileId
            : snapshot.profileId ?? DEFAULT_PROFILE_ID
        const doc = payload.doc ?? snapshot.doc
        const revision = Number.isInteger(payload.revision)
          ? payload.revision
          : Number.isInteger(doc?.revision)
            ? doc.revision
            : snapshot.revision
        const switched =
          snapshot.profileId !== profileId && snapshot.profileEpochId !== profileId
        const collapsedSwitched = snapshot.collapsedProfileId !== profileId
        return publish({
          ...snapshot,
          docState: 'ready',
          doc,
          revision,
          lastConfirmed: doc,
          optimistic: false,
          warning: null,
          banner: null,
          profileId,
          profileEpochId: profileId,
          profiles: {
            ...snapshot.profiles,
            available: true,
            loading: false,
            activeId: profileId,
            registryRevision: Number.isInteger(payload.registryRevision)
              ? payload.registryRevision
              : snapshot.profiles.registryRevision,
            error: null,
          },
          profileEpoch: switched ? snapshot.profileEpoch + 1 : snapshot.profileEpoch,
          latestSeenRevision: 0,
          collapsed: collapsedSwitched ? readCollapsed(storage, profileId) : snapshot.collapsed,
          collapsedProfileId: collapsedSwitched ? profileId : snapshot.collapsedProfileId,
          profileSwitching: false,
          profilePreview: initialProfilePreview(),
          menu: null,
          dialog: null,
        })
      }
      case 'profile-switch-failure':
        return publish({
          ...snapshot,
          profileSwitching: false,
          profilePreview: {
            ...snapshot.profilePreview,
            stale: payload.code === 'preview-stale' ? true : snapshot.profilePreview.stale,
            error: payload.code ? { code: payload.code, message: payload.message ?? null } : snapshot.profilePreview.error,
          },
        })
      case 'profile-external-active': {
        const activeId = payload.activeId
        if (typeof activeId !== 'string' || activeId === '') return snapshot
        const known = snapshot.profiles.activeId ?? snapshot.profileId
        if (activeId === known) return snapshot
        const registryRevision = Number.isInteger(payload.registryRevision)
          ? payload.registryRevision
          : snapshot.profiles.registryRevision
        // Before the first load there is no document to reset; just record the
        // registry's active id and let the initial read supply the doc.
        if (known === null) {
          return publish({
            ...snapshot,
            profiles: { ...snapshot.profiles, activeId, registryRevision },
          })
        }
        return publish({
          ...snapshot,
          // Keep the last confirmed (pre-optimistic) doc off-screen until /load
          // answers, but stop treating it as confirmed: a commit during the gap
          // must not reconcile new state.
          docState: 'loading',
          doc: snapshot.lastConfirmed ?? snapshot.doc,
          optimistic: false,
          lastConfirmed: null,
          warning: null,
          banner: null,
          profileEpoch: snapshot.profileEpoch + 1,
          profileEpochId: activeId,
          latestSeenRevision: 0,
          profileSwitching: false,
          profiles: {
            ...snapshot.profiles,
            activeId,
            registryRevision,
            error: null,
          },
          profilePreview: initialProfilePreview(),
          menu: null,
          dialog: null,
        })
      }
      case 'profile-preview-start':
        return publish({
          ...snapshot,
          profilePreview: {
            ...initialProfilePreview(),
            loading: true,
            targetId: payload.targetId ?? null,
            targetName: payload.targetName ?? null,
          },
        })
      case 'profile-preview-success':
        return publish({
          ...snapshot,
          profilePreview: {
            open: snapshot.profilePreview.open,
            loading: false,
            targetId: payload.targetId ?? null,
            targetName: payload.targetName ?? null,
            targetRevision: payload.targetRevision ?? null,
            previewToken: payload.previewToken ?? null,
            doc: payload.doc ?? null,
            diff: payload.diff ?? null,
            baseActiveId: payload.baseActiveId ?? null,
            baseActiveRevision: payload.baseActiveRevision ?? null,
            error: null,
            stale: false,
          },
        })
      case 'profile-preview-error':
        return publish({
          ...snapshot,
          profilePreview: {
            ...snapshot.profilePreview,
            loading: false,
            error: { code: payload.code ?? 'preview-failed', message: payload.message ?? null },
            stale: payload.code === 'preview-stale' ? true : snapshot.profilePreview.stale,
          },
        })
      case 'profile-preview-open':
        if (snapshot.profilePreview.open) return snapshot
        return publish({
          ...snapshot,
          profilePreview: { ...snapshot.profilePreview, open: true },
        })
      case 'profile-preview-close':
        return publish({ ...snapshot, profilePreview: initialProfilePreview() })
      case 'profile-preview-stale':
        return publish({
          ...snapshot,
          profilePreview: {
            ...snapshot.profilePreview,
            stale: true,
            error: { code: 'preview-stale', message: payload.message ?? null },
          },
        })
      case 'menu':
        return publish({ ...snapshot, menu: payload.menu ?? null })
      case 'dialog':
        return publish({ ...snapshot, dialog: payload.dialog ?? null })
      case 'toast':
        return publish({ ...snapshot, toast: payload.toast ?? null })
      case 'banner':
        return publish({ ...snapshot, banner: payload.banner ?? null })
      case 'locale-changed':
        return publish({ ...snapshot, localeRevision: (snapshot.localeRevision ?? 0) + 1 })
      default:
        return snapshot
    }
  }

  return { getSnapshot, subscribe, update, dispatch }
}

export {
  ARCHIVE_FILTER_KEY,
  COLLAPSED_KEY,
  DEFAULT_PROFILE_ID,
  ONBOARDING_KEY,
  readArchiveFilter,
  readCollapsed,
  readCollapsedTable,
  readOnboardingDone,
  readViewMode,
  safeStorage,
  VIEW_MODE_KEY,
  writeArchiveFilter,
  writeCollapsed,
  writeOnboardingDone,
  writeViewMode,
} from './state/persistence.js'

export { createExternalChangeRouter, revisionAppliesToDocument, revisionEventPlan } from './state/external-change.js'
