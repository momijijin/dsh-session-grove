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
 */
import { ARCHIVE_FILTERS } from '../shared/constants.js'
import { emptyDoc } from '../shared/model.js'

/** localStorage key for the sidebar mode (`groups` | `workspace`). */
export const VIEW_MODE_KEY = 'dsh-session-grove.view.v1'
/** localStorage key for the archive tri-state filter. */
export const ARCHIVE_FILTER_KEY = 'dsh-session-grove.archive.v1'
/** localStorage key for persisted group expansion, scoped by profile id. */
export const COLLAPSED_KEY = 'dsh-session-grove.collapsed.v1'
/** localStorage key for the one-time groups-view onboarding card. */
export const ONBOARDING_KEY = 'dsh-session-grove.onboarded.v1'

/** Host default profile id (mirrors `src/host/constants.js` on the wire). */
export const DEFAULT_PROFILE_ID = 'default'

/** Safe localStorage accessor (SSR / tests / disabled storage return null). */
export const safeStorage = () => {
  try {
    const storage = globalThis.localStorage
    if (storage && typeof storage.getItem === 'function') return storage
  } catch {
    /* storage may be blocked by the host document policy */
  }
  return null
}

/** Read the persisted view mode; default is the shipped workspace browser. */
export const readViewMode = (storage = safeStorage()) => {
  try {
    return storage?.getItem(VIEW_MODE_KEY) === 'groups' ? 'groups' : 'workspace'
  } catch {
    return 'workspace'
  }
}

/** Persist the view mode (best effort: blocked storage keeps session state only). */
export const writeViewMode = (mode, storage = safeStorage()) => {
  try {
    storage?.setItem(VIEW_MODE_KEY, mode === 'groups' ? 'groups' : 'workspace')
  } catch {
    /* ignore */
  }
}

/** Read the persisted archive filter; default hides archived sessions. */
export const readArchiveFilter = (storage = safeStorage()) => {
  try {
    const raw = storage?.getItem(ARCHIVE_FILTER_KEY)
    return ARCHIVE_FILTERS.includes(raw) ? raw : 'hidden'
  } catch {
    return 'hidden'
  }
}

/** Persist the archive filter. */
export const writeArchiveFilter = (filter, storage = safeStorage()) => {
  try {
    storage?.setItem(ARCHIVE_FILTER_KEY, ARCHIVE_FILTERS.includes(filter) ? filter : 'hidden')
  } catch {
    /* ignore */
  }
}

/** Keep only the expanded-by-default contract: `id: true` entries. */
const normalizeCollapsedIds = (value) => {
  const collapsed = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return collapsed
  for (const [id, flag] of Object.entries(value)) {
    if (id && flag === true) collapsed[id] = true
  }
  return collapsed
}

/**
 * Read the whole collapsed table (`{[profileId]: {groupId: true}}`).
 *
 * Legacy values (`{groupId: true}`, every value boolean) predate profiles:
 * they belong to the default profile and are upgraded on the next write.
 */
export const readCollapsedTable = (storage = safeStorage()) => {
  try {
    const raw = storage?.getItem(COLLAPSED_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const entries = Object.entries(parsed)
    if (entries.length === 0) return {}
    if (entries.every(([, value]) => typeof value === 'boolean')) {
      const legacy = normalizeCollapsedIds(parsed)
      return Object.keys(legacy).length > 0 ? { [DEFAULT_PROFILE_ID]: legacy } : {}
    }
    const table = {}
    for (const [profileId, value] of entries) {
      if (!profileId) continue
      const collapsed = normalizeCollapsedIds(value)
      if (Object.keys(collapsed).length > 0) table[profileId] = collapsed
    }
    return table
  } catch {
    return {}
  }
}

/** Read one profile's collapsed ids; the default profile stays the fallback. */
export const readCollapsed = (storage = safeStorage(), profileId = DEFAULT_PROFILE_ID) => {
  const table = readCollapsedTable(storage)
  return table[profileId] ?? {}
}

/**
 * Persist one profile's collapsed ids, preserving every other profile's map.
 * The first write also upgrades a legacy flat value to the scoped shape.
 */
export const writeCollapsed = (collapsed, storage = safeStorage(), profileId = DEFAULT_PROFILE_ID) => {
  try {
    const table = readCollapsedTable(storage)
    const normalized = normalizeCollapsedIds(collapsed)
    if (Object.keys(normalized).length === 0) delete table[profileId]
    else table[profileId] = normalized
    storage?.setItem(COLLAPSED_KEY, JSON.stringify(table))
  } catch {
    /* ignore */
  }
}

/** Whether the user has dismissed the first-run onboarding card. */
export const readOnboardingDone = (storage = safeStorage()) => {
  try {
    return storage?.getItem(ONBOARDING_KEY) === '1'
  } catch {
    return false
  }
}

/** Persist the onboarding dismissal; best effort. */
export const writeOnboardingDone = (storage = safeStorage()) => {
  try {
    storage?.setItem(ONBOARDING_KEY, '1')
  } catch {
    /* ignore */
  }
}

/** Empty profile summary (SPEC §7.2); `available` flips only on a 404 probe. */
const initialProfiles = () => ({
  available: true,
  loading: false,
  degraded: false,
  registryRevision: 0,
  activeId: null,
  list: [],
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
            list: Array.isArray(payload.list) ? payload.list : [],
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
