/**
 * Client plugin shell: view-mode controller, slot lifecycle, HTTP document
 * state, host action wiring and modal orchestration.
 *
 * One instance per page (the plugin is mounted once). `apply` must return void —
 * Cordis validates plugin return values as effects (Gate 0: returning an object
 * raises `TypeError: Invalid effect`).
 */
import { assignSession, createGroup, deleteGroup, deleteGroupTo, detachSession, findGroup, moveGroup, renameGroup, setGroupColor, setGroupColorHex, setGroupIcon, workspaceOfSession } from '../shared/model.js'
import { placeForkedSession } from '../core/fork.js'
import { newSessionFollow, pendingFollowStillValid } from '../core/new-session-follow.js'
import { diffDocs } from '../core/profile-diff.js'
import { createApi } from './api.js'
import { createExternalChangeRouter, createStore, safeStorage } from './state.js'
import { createActions } from './actions.js'
import { createLocaleRuntime } from './plugin-locale.js'
import { installSettingsSlot } from './plugin-settings.js'
import { SkillRepairCard } from './skill-repair.js'
import { createWorkspaceChrome } from './plugin-workspace-chrome.js'
import { createFloatingLabel } from './floating-label.js'
import { installStyles } from './css.js'
import { createOptimisticQueue } from './optimistic.js'
import { shouldShowLoading } from './load-mode.js'
import {
  diagContext,
  diagEnabled,
  diagLabel,
  diagTrace,
  diagnosticsEnabled,
  getDiagnostics,
  initDiagnostics,
  stopDiagnostics,
} from './diagnostics.js'
import { perfCount, perfEnabled, perfMark, perfNow, perfSample } from './perf.js'
import { installClientRuntime } from '../adapters/client-runtime.js'
import { createChangeStream } from '../adapters/change-stream.js'
import { CLIENT_REQUIRED, compatibilityReport, detectClientCapabilities } from '../adapters/dsh-capabilities.js'
import { resolveDshVersion, selectDshAdapter } from '../adapters/dsh-selector.js'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { GroupsViewBoundary } from './components.js'
import {
  applyManagedWidth,
  clearManagedWidth,
  findLayoutNodes,
  isSidebarCollapsed,
  readSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  updateManagedWidth,
  writeSidebarWidth,
} from './sidebar-width.js'
import { clearDialogGeometries } from './dialog-geometry.js'

/** Single sidebar slot taken over while the groups view is active. */
export const VIEW_SLOT = 'sidebar.workspaces'
/** Takeover priority: the shipped browser registers at 0, lowest renders. */
export const VIEW_PRIORITY = -1

const CENTER = { x: 24, y: 120 }

/** Safe `ctx.get` (services may not exist yet during apply; feature-detect). */
const safeGet = (ctx, name) => {
  try {
    return ctx.get(name) ?? null
  } catch {
    return null
  }
}

/**
 * Create the client plugin instance.
 */
export const createPlugin = () => {
  let mounted = false
  let ctxRef = null
  let store = null
  let api = null
  let t = (key) => key
  let toastTimer = null
  let floatingLabel = null
  let occupantDisposer = null
  let styleDisposer = null
  let workspaceChrome = null
  let localeRuntime = null
  let configSlotDisposer = null
  let perfDisposer = null
  let loadPromise = null
  /** Monotonic token that invalidates an in-flight read on an active switch. */
  let loadGeneration = 0
  let commitTail = Promise.resolve()
  let queue = null
  let bridge = null
  let debugProbe = false
  let changeSource = null
  let changeRouter = null
  let profileActiveListener = null
  let refreshPending = false
  let refreshForced = false
  let storeSubscriptionDisposer = null
  let profileEpochDisposer = null
  let lastProfileEpoch = 0
  let profilesPromise = null
  /** Separate in-flight slot for the manage dialog's archived opt-in read. */
  let profilesArchivedPromise = null
  /** Target of the local activate request (suppresses our own SSE `active`). */
  let profileSwitchTarget = null
  /** SPEC §7.3 local resets (search/drag/scroll/selection/…) registered by S6. */
  const profileResetListeners = new Set()

  const services = () => {
    const ctx = ctxRef
    if (!ctx) return { sessions: null, workspaces: null, uiWorkspace: null, layout: null, remoteAccess: null }
    return {
      sessions: safeGet(ctx, 'sessions'),
      workspaces: safeGet(ctx, 'workspaces'),
      uiWorkspace: safeGet(ctx, 'uiWorkspace'),
      layout: safeGet(ctx, 'layout'),
      remoteAccess: safeGet(ctx, 'remoteAccess'),
    }
  }

  /**
   * Show a transient toast (SPEC §7.8).
   *
   * A toast without an action keeps the original 2600ms path so every existing
   * call is unchanged. An action (switch undo) keeps the toast for 5000ms,
   * clears the timer when the action runs, and lets the action raise its own
   * follow-up toast.
   */
  const notify = ({ kind = 'info', message = '', action = null } = {}) => {
    if (!store || !message) return
    const actionTimerStop = () => {
      if (toastTimer !== null) clearTimeout(toastTimer)
      toastTimer = null
    }
    const storedAction = action
      ? {
          label: action.label,
          duration: Number.isFinite(action.duration) ? action.duration : 5000,
          onClick: (...args) => {
            actionTimerStop()
            action.onClick?.(...args)
          },
        }
      : null
    store.dispatch('toast', { toast: { kind, message, action: storedAction } })
    if (toastTimer !== null) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toastTimer = null
      store?.dispatch('toast', { toast: null })
    }, storedAction ? storedAction.duration : 2600)
  }

  // --- floating drag label (V1 drag affordance; document-level overlay) ----
  // One controller owns the single overlay node: it reuses a label left in the
  // DOM by an earlier instance, hides duplicates, caches text/visibility and
  // coalesces per-frame dragover writes. Diagnostics hear only real changes.
  const floatingLabelController = () => {
    if (floatingLabel === null) {
      floatingLabel = createFloatingLabel({
        document: globalThis.document,
        position: CENTER,
        onTextChange: (text) => {
          if (diagEnabled()) diagLabel(text)
        },
        perfEnabled,
        perfNow,
        perfSample,
      })
    }
    return floatingLabel
  }
  const setFloatingLabel = (text) => {
    if (!globalThis.document) return
    floatingLabelController().setText(text)
  }

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
          diagTrace('load.stale', { reason: 'profile-epoch' })
          return
        }
        if (result.ok === true) {
          debugProbe = result.debugProbe === true
          if (result.diagnostics === true) {
            if (!diagEnabled()) initDiagnostics({ enabled: true })
          } else if (diagEnabled()) {
            stopDiagnostics()
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
          refreshProfiles({ background: true })
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
            queueMicrotask(() => requestRefresh({ force: pendingForce }))
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

  const requestRefresh = ({ force = false } = {}) => {
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

  // --- profile data (SPEC §7.1-§7.7) ----------------------------------------
  /**
   * Load the registry-backed profile list. A non-JSON 404 means the host has no
   * profile surface at all (SPEC §7.7): flip `profiles.available` and keep the
   * single-profile behaviour without touching the main view.
   *
   * `includeArchived` (SPEC §5.3/§9.5) is the manage dialog's opt-in read; it
   * uses its own in-flight slot so it can never be deduped behind a background
   * switcher refresh and silently lose the archived rows.
   */
  const refreshProfiles = ({ background = false, includeArchived = false } = {}) => {
    if (includeArchived ? profilesArchivedPromise !== null : profilesPromise !== null) {
      return includeArchived ? profilesArchivedPromise : profilesPromise
    }
    if (!background) store.dispatch('profiles-loading')
    const promise = (async () => {
      const result = await api.listProfiles({ includeArchived })
      if (result.ok === true) {
        store.dispatch('profiles-success', {
          registryRevision: result.registryRevision,
          activeId: result.activeId,
          degraded: result.degraded === true,
          list: result.profiles,
          limits: result.limits,
          includeArchived,
        })
      } else if (result.profilesAvailable === false) {
        store.dispatch('profiles-unavailable')
      } else {
        store.dispatch('profiles-error', { code: result.code, message: result.message })
      }
      return result
    })().finally(() => {
      if (includeArchived) profilesArchivedPromise = null
      else profilesPromise = null
    })
    if (includeArchived) profilesArchivedPromise = promise
    else profilesPromise = promise
    return promise
  }

  /**
   * SPEC §7.5: another window switched the active profile. The change router
   * suppresses this for a local switch (`isLocalSwitch`); here the refreshed
   * list resolves the human name for the passive toast.
   */
  const announcePassiveSwitch = (activeId) => {
    refreshProfiles({ background: true }).then((result) => {
      const profiles = Array.isArray(result?.profiles) ? result.profiles : []
      const profile = profiles.find((entry) => entry?.id === activeId)
      const name = typeof profile?.name === 'string' && profile.name !== '' ? profile.name : activeId
      notify({ kind: 'info', message: t('profiles.switchedElsewhere', { name }) })
    })
  }

  /** Live session ids for the switch preview classification (SPEC §8.4). */
  const liveSessionIds = () => {
    const sessions = services().sessions
    const snapshot = sessions?.list?.getSnapshot?.() ?? null
    if (!snapshot) return []
    if (Array.isArray(snapshot.ids)) return snapshot.ids
    return Object.keys(snapshot.byId ?? {})
  }

  /**
   * Fetch one profile preview and store the doc/diff/token the switch dialog
   * needs. Confirmation (`activateProfile`) consumes the same token, so the
   * host's TOCTOU check covers the whole user think-time.
   */
  const previewProfile = async (id) => {
    if (typeof id !== 'string' || id === '') return { ok: false, code: 'invalid-profile-id' }
    const epochAtStart = store.getSnapshot().profileEpoch
    store.dispatch('profile-preview-start', { targetId: id })
    const result = await api.previewProfile(id)
    if (store.getSnapshot().profileEpoch !== epochAtStart) {
      diagTrace('profile.preview.stale', { targetId: id, reason: 'profile-epoch' })
      return { ...result, ok: false, code: 'profile-changed' }
    }
    if (result.ok !== true) {
      store.dispatch('profile-preview-error', { code: result.code, message: result.message })
      return result
    }
    const current = store.getSnapshot()
    const diff = diffDocs(current.doc, result.doc, liveSessionIds())
    store.dispatch('profile-preview-success', {
      targetId: result.profile?.id ?? id,
      targetName: result.profile?.name ?? null,
      targetRevision: result.revision,
      previewToken: result.previewToken,
      doc: result.doc,
      diff,
      baseActiveId: result.activeId ?? null,
      baseActiveRevision: result.activeRevision ?? null,
    })
    return result
  }

  /**
   * Activate a previewed profile (SPEC §7.4 step 6/7). The local target
   * suppresses our own SSE `active` echo; the response supplies the doc and its
   * revision becomes the next commit base. Failure keeps the current profile.
   */
  const activateProfile = async ({ id, previewToken } = {}) => {
    if (typeof id !== 'string' || id === '') return { ok: false, code: 'invalid-profile-id' }
    const epochAtStart = store.getSnapshot().profileEpoch
    profileSwitchTarget = id
    store.dispatch('profile-switch-start', { targetId: id })
    let result
    try {
      result = await api.activateProfile({ id, previewToken })
    } catch (error) {
      result = { ok: false, code: 'network', message: String(error?.message ?? error) }
    } finally {
      if (profileSwitchTarget === id) profileSwitchTarget = null
    }
    const snapshot = store.getSnapshot()
    // Another window switched while this activate was in flight: the router
    // already reset/reloaded the view, so applying this stale response would
    // stomp newer state. Report it as superseded instead.
    const superseded =
      snapshot.profileEpoch !== epochAtStart &&
      snapshot.profileId !== id &&
      snapshot.profiles.activeId !== id
    if (superseded) {
      diagTrace('profile.activate.superseded', { targetId: id, activeId: snapshot.profiles.activeId })
      return { ...result, superseded: true }
    }
    if (result?.ok === true) {
      store.dispatch('profile-switch-success', {
        profileId: result.activeId ?? id,
        doc: result.doc,
        revision: result.doc?.revision,
        registryRevision: result.registryRevision,
      })
      refreshProfiles({ background: true })
      return result
    }
    store.dispatch('profile-switch-failure', { code: result?.code, message: result?.message })
    return result
  }

  /**
   * SPEC §9.4/§9.5: profile-write errors become inline dialog copy. Codes the
   * host emits for these routes map onto the existing translated keys; there is
   * no dedicated locale string for `profile-in-use`/`conflict`/io, so they fall
   * back to the generic "could not complete" copy.
   */
  const profileDialogError = (code) => {
    if (code === 'profile-name-invalid') return 'profiles.nameInvalid'
    if (code === 'profile-name-duplicate') return 'profiles.nameDuplicate'
    if (code === 'profile-limit') return 'profiles.limit'
    if (code === 'registry-unhealthy' || code === 'profile-unhealthy') return 'profiles.degraded'
    return 'profiles.saveFailed'
  }

  const profileDialogErrorParams = (code) =>
    code === 'profile-limit' ? { max: store.getSnapshot().profiles.limits?.max ?? 20 } : null

  /** Close the rename/archive dialog but keep the manage list (SPEC §9.5). */
  const reopenProfileManage = () => {
    store.dispatch('dialog', { dialog: { kind: 'profile-manage', titleKey: 'profiles.title' } })
  }

  /**
   * SPEC §7.4 step 9/10 + §9.2: profile writes are refused while a switch runs
   * or a document write is unsettled. Returns a result instead of throwing so
   * the dialog can keep its inline error surface.
   */
  const profileWriteGuard = () => {
    const snapshot = store.getSnapshot()
    if (snapshot.profileSwitching === true) return { ok: false, code: 'profile-switching' }
    if (queue?.isPending() === true) {
      notify({ kind: 'info', message: t('profiles.switching') })
      return { ok: false, code: 'pending' }
    }
    return null
  }

  /**
   * SPEC §5.5/§9.4: save-as clones the active document and activates the copy.
   * Success reuses the switch reset (`profile-switch-success`) because the new
   * profile becomes active; failure keeps the dialog open for inline copy.
   */
  const createProfile = async ({ name } = {}) => {
    const text = typeof name === 'string' ? name.trim() : ''
    if (text === '') {
      failDialog('profiles.nameInvalid')
      return { ok: false, code: 'profile-name-invalid' }
    }
    const guard = profileWriteGuard()
    if (guard !== null) return guard
    const snapshot = store.getSnapshot()
    let result
    try {
      result = await api.createProfile({ name: text, baseRevision: snapshot.profiles.registryRevision })
    } catch (error) {
      result = { ok: false, code: 'network', message: String(error?.message ?? error) }
    }
    if (result?.ok !== true) {
      // A registry CAS loss leaves the local revision stale: refresh so the next
      // confirm attempt uses the current base (SPEC §5.5/§10).
      if (result?.code === 'conflict') refreshProfiles({ background: true })
      failDialog(profileDialogError(result?.code), profileDialogErrorParams(result?.code))
      return result
    }
    const profileName = result.profile?.name ?? text
    store.dispatch('profile-switch-success', {
      profileId: result.activeId ?? result.profile?.id ?? null,
      doc: result.doc,
      revision: result.doc?.revision,
      registryRevision: result.registryRevision,
    })
    refreshProfiles({ background: true })
    notify({ kind: 'success', message: t('profiles.switched', { name: profileName }) })
    return result
  }

  /** SPEC §5.6/§9.5: rename keeps the manage dialog in view afterwards. */
  const renameProfile = async ({ id, name } = {}) => {
    const text = typeof name === 'string' ? name.trim() : ''
    if (text === '') {
      failDialog('profiles.nameInvalid')
      return { ok: false, code: 'profile-name-invalid' }
    }
    const guard = profileWriteGuard()
    if (guard !== null) return guard
    const snapshot = store.getSnapshot()
    let result
    try {
      result = await api.renameProfile({ id, name: text, baseRevision: snapshot.profiles.registryRevision })
    } catch (error) {
      result = { ok: false, code: 'network', message: String(error?.message ?? error) }
    }
    if (result?.ok !== true) {
      if (result?.code === 'conflict') refreshProfiles({ background: true })
      failDialog(profileDialogError(result?.code), profileDialogErrorParams(result?.code))
      return result
    }
    refreshProfiles({ background: true })
    refreshProfiles({ background: true, includeArchived: true })
    reopenProfileManage()
    notify({ kind: 'success', message: t('toast.saved') })
    return result
  }

  /** SPEC §5.7/§9.5: archive only hides the profile; its file and sessions stay. */
  const archiveProfile = async ({ id } = {}) => {
    const guard = profileWriteGuard()
    if (guard !== null) return guard
    const snapshot = store.getSnapshot()
    let result
    try {
      result = await api.archiveProfile({ id, baseRevision: snapshot.profiles.registryRevision })
    } catch (error) {
      result = { ok: false, code: 'network', message: String(error?.message ?? error) }
    }
    if (result?.ok !== true) {
      if (result?.code === 'conflict') refreshProfiles({ background: true })
      failDialog(profileDialogError(result?.code), profileDialogErrorParams(result?.code))
      return result
    }
    refreshProfiles({ background: true })
    refreshProfiles({ background: true, includeArchived: true })
    reopenProfileManage()
    notify({ kind: 'success', message: t('toast.saved') })
    return result
  }

  /** SPEC §7.3 reset hook: S6 registers drag/search/selection/scroll resets. */
  const onProfileSwitchReset = (listener) => {
    if (typeof listener !== 'function') return () => {}
    profileResetListeners.add(listener)
    return () => {
      profileResetListeners.delete(listener)
    }
  }

  const runProfileResets = () => {
    pendingNewSessionPlacement = null
    setFloatingLabel(null)
    for (const listener of [...profileResetListeners]) {
      try {
        listener()
      } catch {
        /* one local reset must not block the others */
      }
    }
  }

  const startChangeStream = () => {
    if (storeSubscriptionDisposer === null) {
      storeSubscriptionDisposer = store.subscribe(() => {
        if (!refreshPending) return
        const snapshot = store.getSnapshot()
        if (snapshot.optimistic) return
        requestRefresh({ force: refreshForced })
      })
    }
    const EventSourceImpl = globalThis.EventSource
    if (typeof EventSourceImpl !== 'function' || changeSource !== null) return
    const stream = createChangeStream({
      EventSourceImpl,
      url: '/dsh-session-grove/events',
      onRevision: (event) => {
        try {
          const payload = JSON.parse(event.data)
          // SPEC §7.5 / WORKLOG S4 carry #1: revisions are scoped to the
          // profile that accepted the write. A non-active profile's control or
          // tool write must never advance the visible revision (that used to
          // cause a self-sustaining background reload).
          changeRouter?.revision(payload)
        } catch {
          /* ignore malformed invalidation */
        }
      },
      onOpen: () => {
        // Reconnect recovery: catch revisions and profile changes made while
        // the stream was down (SPEC §7.5: /load + /profiles on open).
        refreshProfiles({ background: true })
        requestRefresh({ force: true })
      },
    })
    if (stream !== null) {
      changeSource = stream
      // The shared adapter only exposes the `revision` listener; subscribe to
      // the additive `active` event on the same EventSource instance.
      profileActiveListener = (event) => {
        try {
          changeRouter?.active(JSON.parse(event.data))
        } catch {
          /* ignore malformed switch notification */
        }
      }
      stream.source?.addEventListener?.('active', profileActiveListener)
    }
  }

  // --- slot lifecycle -------------------------------------------------------
  const reportRegistrationFailure = (error) => {
    if (globalThis.console?.warn) globalThis.console.warn('[dsh-session-grove] sidebar registration failed', error)
    notify({ kind: 'error', message: t('error.title') })
    store.dispatch('banner', { banner: { kind: 'error', code: 'registration-failed' } })
  }

  const registerOccupant = () => {
    if (occupantDisposer !== null) return
    const ctx = ctxRef
    occupantDisposer = ctx.slots.inject(VIEW_SLOT, () => {
      try {
        return ctx.slots.register({ name: VIEW_SLOT, priority: VIEW_PRIORITY }, GroupsViewBoundary)
      } catch (error) {
        // Another priority -1 occupant exists: report the takeover failure.
        reportRegistrationFailure(error)
        return () => {}
      }
    })
  }

  const disposeOccupant = () => {
    if (occupantDisposer === null) return
    try {
      occupantDisposer()
    } finally {
      occupantDisposer = null
    }
  }

  /** Locate the host layout from whichever view currently owns the sidebar. */
  const findLiveLayoutNodes = () => {
    const doc = globalThis.document
    const groupsRoot = doc?.querySelector?.('.dsg-root')
    if (groupsRoot) return findLayoutNodes(groupsRoot)
    const officialHandle = doc?.querySelector?.('[data-side="sidebar"]')
    return officialHandle ? findLayoutNodes(officialHandle) : null
  }

  const syncSidebarWidth = () => {
    const nodes = findLiveLayoutNodes()
    if (!nodes?.supported) return false
    // Host rail mode owns the 56px width; report success so the retry timer
    // stops instead of reapplying our 264..420px override.
    if (isSidebarCollapsed(nodes)) return true
    return applyManagedWidth(nodes, readSidebarWidth(), globalThis.innerWidth || 1440) !== null
  }

  /** Restore the plugin-owned layout preferences without touching group data. */
  const resetLayout = () => {
    writeSidebarWidth(SIDEBAR_WIDTH_DEFAULT)
    store?.dispatch('reset-collapsed')
    clearDialogGeometries()
    syncSidebarWidth()
    notify({ kind: 'success', message: t('toast.layoutReset') })
    return true
  }

  const syncWorkspaceChrome = () => workspaceChrome?.sync()

  const setMode = (mode) => {
    if (!store) return
    const next = mode === 'groups' ? 'groups' : 'workspace'
    store.dispatch('view-mode', { mode: next })
    syncWorkspaceChrome()
    if (diagEnabled()) {
      diagContext({ mode: next })
      diagTrace('mode.change', { mode: next })
    }
    if (next === 'groups') {
      registerOccupant()
      // Re-read the Host document every time the groups view becomes active.
      // requestRefresh defers while an optimistic write is still unsettled.
      requestRefresh({ force: true })
    } else {
      disposeOccupant()
    }
  }

  const toggleMode = () => setMode(store.getSnapshot().viewMode === 'groups' ? 'workspace' : 'groups')

  workspaceChrome = createWorkspaceChrome({
    getMode: () => store?.getSnapshot().viewMode,
    getLabel: () => t('footer.toGroups'),
    onToggle: () => toggleMode(),
    syncSidebarWidth,
    isMounted: () => mounted,
  })

  // --- host actions ---------------------------------------------------------
  const getDoc = () => store.getSnapshot().doc
  const actions = createActions({ getServices: services, getDoc, commitDoc, notify, t, clipboard: writeClipboard })

  // A host workspace switch may replace the freshly created blank with that
  // workspace's reusable blank. Keep the originating group intent for the whole
  // pre-prompt blank lifetime; every active switch follows immediately.
  let pendingNewSessionPlacement = null
  let pendingFollowGuardDisposer = null

  /** Direct group-head "+" / context-menu action: use the inferred workspace. */
  const newSessionInGroup = async (groupId, workspaceId) => {
    try {
      const result = await actions.createSessionInGroup({ groupId, workspaceId })
      pendingNewSessionPlacement = {
        groupId,
        trackedSessionId: result.sessionId,
        workspaceId,
      }
      if (store.getSnapshot().archiveFilter === 'only') {
        setArchiveFilter('all')
        notify({ kind: 'info', message: t('toast.archivedFilterChanged') })
      }
      notify({ kind: 'success', message: t('toast.saved') })
      return result
    } catch (error) {
      notify({ kind: 'error', message: t('dialog.createFailed') })
      throw error
    }
  }

  /**
   * If the host replaced the current blank after a group-head create, move the
   * replacement into the originating group and drop the abandoned blank. Every
   * pre-prompt workspace switch follows; a nonblank active session ends it.
   */
  const reconcileNewSessionGroup = async (activeSessionId) => {
    const pending = pendingNewSessionPlacement
    if (!pending || typeof activeSessionId !== 'string' || activeSessionId === '') return
    const snapshot = services().sessions?.list?.getSnapshot?.()
    const activeRow = snapshot?.byId?.[activeSessionId]
    if (activeSessionId === pending.trackedSessionId) {
      if (!activeRow || activeRow.blank !== true) pendingNewSessionPlacement = null
      return
    }
    const workspaceItems = services().workspaces?.list?.getSnapshot?.()?.items ?? []
    const activeWorkspaceId = workspaceOfSession(workspaceItems, activeSessionId)?.workspaceId ?? null
    const workspaceChanged =
      typeof pending.workspaceId === 'string' && pending.workspaceId !== '' &&
      typeof activeWorkspaceId === 'string' && activeWorkspaceId !== '' &&
      activeWorkspaceId !== pending.workspaceId
    const decision = newSessionFollow(
      pending,
      activeSessionId,
      snapshot?.byId ?? {},
      findGroup(getDoc(), pending.groupId) !== null,
      workspaceChanged,
    )
    if (!decision) {
      if (!activeRow || activeRow.blank !== true || !findGroup(getDoc(), pending.groupId)) {
        pendingNewSessionPlacement = null
      }
      return
    }
    // Update the tracked blank before the optimistic doc dispatch so the
    // manual-edit guard sees the target group for this new active id.
    pending.trackedSessionId = activeSessionId
    if (activeWorkspaceId !== null) pending.workspaceId = activeWorkspaceId
    try {
      const write = commitOptimistic((latest) => {
        let next = assignSession(latest, activeSessionId, decision.targetGroupId, 0)
        if (decision.removePrevious) next = detachSession(next, decision.previousSessionId)
        return next
      })
      await write
    } catch (error) {
      pendingNewSessionPlacement = null
      if (globalThis.console?.warn) globalThis.console.warn('[dsh-session-grove] active session follow failed', error)
    }
  }

  const capabilities = () => {
    const { uiWorkspace, remoteAccess } = services()
    return {
      fork: (sessionId) => {
        if (typeof uiWorkspace?.forkSession !== 'function') return false
        try {
          return Boolean(remoteAccess?.source?.('session', sessionId, 'session/fork'))
        } catch {
          return false
        }
      },
      archive: typeof uiWorkspace?.archiveSession === 'function',
      unarchive: typeof uiWorkspace?.unarchiveSession === 'function',
      connect: typeof uiWorkspace?.connectWorkspace === 'function',
    }
  }

  const archiveSession = async (sessionId) => {
    const result = await actions.archiveSession(sessionId)
    if (result.ok) {
      notify({ kind: 'success', message: t('toast.saved') })
      return
    }
    if (result.refusal) {
      openDialog({
        kind: 'archive-running',
        titleKey: 'dialog.archiveRunning',
        sessionId,
        activity: result.refusal.activity,
      })
      return
    }
    notify({ kind: 'error', message: t('toast.archiveFailed') })
  }

  const unarchiveSession = async (sessionId) => {
    try {
      await actions.unarchiveSession(sessionId)
    } catch {
      /* createActions already notified */
    }
  }

  const forkSession = async (sessionId) => {
    let childId = null
    try {
      childId = await actions.forkSession(sessionId, (id) => {
        childId = id
      })
    } catch (error) {
      const code = error?.rpcError?.code
      const messageKey =
        code === 'session/migration-required'
          ? 'toast.forkRequiresOpen'
          : code === 'session/fork-unavailable'
            ? 'toast.forkUnavailable'
            : 'toast.forkFailed'
      notify({ kind: 'error', message: t(messageKey) })
      return
    }
    if (typeof childId !== 'string' || childId === '') {
      notify({ kind: 'error', message: t('toast.forkFailed') })
      return
    }
    try {
      await commitDoc((latest) => placeForkedSession(latest, sessionId, childId))
      notify({ kind: 'success', message: t('toast.forked') })
    } catch {
      notify({ kind: 'error', message: t('toast.forkPlacementFailed') })
    }
  }

  const copySessionId = async (sessionId) => {
    const copied = await actions.copySessionId(sessionId)
    notify({
      kind: copied ? 'success' : 'error',
      message: t(copied ? 'toast.sessionIdCopied' : 'toast.sessionIdCopyFailed'),
    })
  }

  // --- dialogs --------------------------------------------------------------
  const openDialog = (dialog) => {
    if (!store) return
    store.dispatch('dialog', { dialog: { x: CENTER.x, y: CENTER.y, ...dialog } })
  }

  const closeDialog = () => store.dispatch('dialog', { dialog: null })

  const failDialog = (messageKey, params = null) => {
    const dialog = store.getSnapshot().dialog
    if (dialog) store.dispatch('dialog', { dialog: { ...dialog, error: messageKey, errorParams: params } })
  }

  const commitDocFromAction = async (nextDoc, successKey = 'toast.saved') => {
    const committed = await commitDoc(nextDoc)
    closeDialog()
    notify({ kind: 'success', message: t(successKey) })
    return committed
  }

  /** Empty-leaf delete (0.2.9): no dialog, one commit, group-deleted toast. */
  const deleteGroupDirect = async (groupId) => {
    try {
      return await commitDocFromAction((latest) => deleteGroup(latest, groupId), 'toast.groupDeleted')
    } catch (error) {
      notify({ kind: 'error', message: t('toast.deleteFailed') })
      if (globalThis.console?.warn) globalThis.console.warn('[dsh-session-grove] direct delete failed', error)
      return null
    }
  }

  const confirmDialog = async (dialog, payload = {}) => {
    try {
      switch (dialog.kind) {
        case 'new-group': {
          const name = typeof payload.value === 'string' ? payload.value.trim() : ''
          if (name === '') return failDialog('name-required')
          const next = (latest) => createGroup(latest, { name, parentId: dialog.parentId ?? null })
          await commitDocFromAction(next)
          return
        }
        case 'rename-group': {
          const name = typeof payload.value === 'string' ? payload.value.trim() : ''
          if (name === '') return failDialog('name-required')
          await commitDocFromAction((latest) => renameGroup(latest, dialog.groupId, name))
          return
        }
        case 'rename-session': {
          const value = typeof payload.value === 'string' ? payload.value.trim() : ''
          if (value === '') return failDialog('name-required')
          await actions.renameSession(dialog.sessionId, value)
          closeDialog()
          notify({ kind: 'success', message: t('toast.saved') })
          return
        }
        case 'delete-group': {
          await commitDocFromAction(
            (latest) => deleteGroupTo(latest, dialog.groupId, payload.destinationId ?? null),
            'toast.groupDeleted'
          )
          return
        }
        case 'icon': {
          await commitDocFromAction((latest) => setGroupIcon(latest, dialog.groupId, payload.icon))
          return
        }
        case 'group-color': {
          if (typeof payload.colorHex === 'string') {
            await commitDocFromAction((latest) => setGroupColorHex(latest, dialog.groupId, payload.colorHex))
          } else {
            await commitDocFromAction((latest) => setGroupColor(latest, dialog.groupId, payload.color))
          }
          return
        }
        case 'move-session': {
          // Dialog moves are discoverability actions: put the session at the
          // target group's session head so the watermark cannot hide it.
          await actions.moveSession(dialog.sessionId, payload.groupId ?? null, 0)
          closeDialog()
          notify({ kind: 'success', message: t('toast.moved') })
          return
        }
        case 'move-group': {
          // Same rule for groups: the moved group becomes the first child.
          await commitDocFromAction((latest) => moveGroup(latest, dialog.groupId, payload.groupId ?? null, 0))
          return
        }
        case 'archive-running': {
          const result = await actions.archiveSession(dialog.sessionId, { stopActivity: true })
          closeDialog()
          if (result.ok) notify({ kind: 'success', message: t('toast.saved') })
          else notify({ kind: 'error', message: t('toast.archiveFailed') })
          return
        }
        default:
          closeDialog()
      }
    } catch (error) {
      if (dialog.kind === 'rename-session') notify({ kind: 'error', message: t('toast.renameFailed') })
      else if (
        dialog.kind === 'delete-group' ||
        dialog.kind === 'new-group' ||
        dialog.kind === 'rename-group' ||
        dialog.kind === 'icon' ||
        dialog.kind === 'group-color' ||
        dialog.kind === 'move-group'
      ) {
        failDialog('commit-failed')
      } else notify({ kind: 'error', message: t('toast.dropFailed') })
      if (globalThis.console?.warn) globalThis.console.warn('[dsh-session-grove] dialog action failed', error)
    }
  }

  const setArchiveFilter = (filter) => store.dispatch('archive-filter', { filter })

  // --- mounting -------------------------------------------------------------
  const mount = (ctx) => {
    if (mounted) return
    mounted = true
    ctxRef = ctx
    const declaredVersion = resolveDshVersion(ctx)
    const selectedAdapter = selectDshAdapter(declaredVersion)
    if (declaredVersion !== null && selectedAdapter === null) {
      globalThis.console?.warn?.(`[dsh-session-grove] unsupported DSH runtime version ${declaredVersion}`)
      return
    }
    const clientCapabilities = selectedAdapter === null
      ? detectClientCapabilities(ctx, services())
      : selectedAdapter.detectClient(ctx, services())
    const clientCompatibility = compatibilityReport(
      clientCapabilities,
      selectedAdapter?.requiredClient ?? CLIENT_REQUIRED,
    )
    if (!clientCompatibility.supported) {
      globalThis.console?.warn?.(
        `[dsh-session-grove] missing client capabilities: ${clientCompatibility.missing.join(', ')}`,
      )
    }
    store = createStore({ storage: safeStorage() })
    if (perfEnabled()) perfDisposer = store.subscribe(() => perfCount('store:publish'))
    // Any manual group change that moves the tracked blank closes the pending
    // follow intent; otherwise a later workspace switch could undo the user's move.
    pendingFollowGuardDisposer = store.subscribe(() => {
      const pending = pendingNewSessionPlacement
      if (!pending) return
      if (!pendingFollowStillValid(store.getSnapshot().doc, pending)) pendingNewSessionPlacement = null
    })
    // Diagnostics are opt-in (0.2.18): either the generic plugin-config switch
    // arrives in the load response, or a developer/localStorage override is set.
    if (diagnosticsEnabled()) initDiagnostics()
    api = createApi({ documentRef: globalThis.document, trace: (type, detail) => diagTrace(type, detail) })
    if (diagEnabled()) diagContext({ mode: store.getSnapshot().viewMode })
    localeRuntime = createLocaleRuntime({ ctx, store })
    t = localeRuntime.t

    queue = createOptimisticQueue({
      store,
      commit: (doc, revision, profileId) => api.commit(doc, revision, profileId),
      notify,
      t: (key, params) => t(key, params),
      trace: (type, detail) => diagTrace(type, detail),
    })
    changeRouter = createExternalChangeRouter({
      store,
      requestRefresh,
      onActiveChange: (activeId, info) => {
        if (info.local) return
        const snapshot = store.getSnapshot()
        // Our own successful switch echo (or a registry-only bump) when the
        // document is already settled: the list refresh is enough.
        if (!info.changed && snapshot.profileId === activeId && snapshot.docState === 'ready') {
          refreshProfiles({ background: true })
          return
        }
        // Any `active` event may have raced an in-flight read (the read can
        // still return the previous profile), so invalidate it even when the
        // registry id already matches the freshly loaded list.
        loadGeneration += 1
        refreshPending = false
        refreshForced = true
        if (info.changed) {
          // The router already dispatched the reset (epoch/latest revision/doc
          // state); read the new active document and registry list now, then
          // announce the passive switch with the resolved profile name.
          load()
          announcePassiveSwitch(activeId)
        } else {
          load({ background: true })
          refreshProfiles({ background: true })
        }
      },
      isLocalSwitch: (activeId) => profileSwitchTarget !== null && profileSwitchTarget === activeId,
      trace: (type, detail) => diagTrace(type, detail),
    })
    lastProfileEpoch = store.getSnapshot().profileEpoch
    profileEpochDisposer = store.subscribe(() => {
      const epoch = store.getSnapshot().profileEpoch
      if (epoch === lastProfileEpoch) return
      lastProfileEpoch = epoch
      // SPEC §7.3: the switch invalidates in-flight writes and every local
      // GroupsView interaction; the next render reads the new profile's doc.
      refreshPending = false
      refreshForced = false
      queue?.discardPending('profile-changed')
      runProfileResets()
    })

    styleDisposer = installStyles(globalThis.document)
    configSlotDisposer = installSettingsSlot(ctx, SkillRepairCard)
    bridge = {
      store,
      t,
      get direction() {
        return localeRuntime?.direction() ?? 'ltr'
      },
      formatAbsoluteTime: (value) => localeRuntime?.formatAbsoluteTime(value) ?? null,
      api,
      actions,
      get debugProbe() {
        return debugProbe
      },
      refreshRuntimeConfig: () => requestRefresh({ force: true }),
      notify,
      archiveSession,
      unarchiveSession,
      forkSession,
      copySessionId,
      commitDoc,
      commitOptimistic,
      /** SPEC §7.4 step 2: a switch must be refused while a write is pending. */
      isPending: () => queue?.isPending() === true,
      load,
      retryLoad,
      refreshProfiles,
      previewProfile,
      activateProfile,
      createProfile,
      renameProfile,
      archiveProfile,
      onProfileSwitchReset,
      setMode,
      toggleMode,
      openDialog,
      newSessionInGroup,
      reconcileNewSessionGroup,
      confirmDialog,
      deleteGroupDirect,
      setArchiveFilter,
      resetLayout,
      setFloatingLabel,
      startDragLabel: () => {},
      showToast: (kind, message) => notify({ kind, message }),
      get capabilities() {
        return capabilities()
      },
      compatibility: clientCompatibility,
      dshVersion: declaredVersion,
      dshAdapter: selectedAdapter?.id ?? null,
    }
    installClientRuntime(bridge)
    startChangeStream()
    // SPEC §7.2/§7.7: probe the profile surface at mount. Old hosts answer a
    // non-JSON 404 and the store silently switches to single-profile mode.
    refreshProfiles()

    const onWindowResize = () => {
      if (updateManagedWidth(readSidebarWidth(), globalThis.innerWidth || 1440) === null) syncSidebarWidth()
      workspaceChrome?.update()
    }
    globalThis.addEventListener?.('resize', onWindowResize)
    syncWorkspaceChrome()

    // Outside click / Escape close transient UI.
    const doc = globalThis.document
    const onPointerDown = (event) => {
      if (!store.getSnapshot().menu) return
      // Clicks inside a popover/dialog belong to it; the capture listener must not
      // remove the element before the click lands.
      if (typeof event?.target?.closest === 'function' && event.target.closest('.dsg-menu, .dsg-dialog')) return
      store.dispatch('menu', { menu: null })
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      if (store.getSnapshot().dialog) closeDialog()
      else if (store.getSnapshot().menu) store.dispatch('menu', { menu: null })
    }
    // A row menu is anchored to a viewport point: any document scroll or window
    // resize makes that anchor stale, so close it (scrolls inside the menu itself
    // stay usable). Focus restoration happens in MenuPopover's unmount cleanup.
    const closeMenuOnViewportChange = (event) => {
      if (!store.getSnapshot().menu) return
      const target = event?.target
      if (target && typeof target.closest === 'function' && target.closest('.dsg-menu, .dsg-dialog')) return
      store.dispatch('menu', { menu: null })
    }
    doc?.addEventListener?.('pointerdown', onPointerDown, true)
    doc?.addEventListener?.('keydown', onKeyDown, true)
    doc?.addEventListener?.('scroll', closeMenuOnViewportChange, true)
    globalThis.addEventListener?.('resize', closeMenuOnViewportChange)

    // Mode controller + unload cleanup are one effect: the disposer is owned by
    // the plugin fiber (Gate 0 verified slot lifecycle).
    ctx.effect(() => {
      if (store.getSnapshot().viewMode === 'groups') {
        registerOccupant()
        load()
      }
      return () => {
        disposeOccupant()
        workspaceChrome?.dispose()
        workspaceChrome = null
        globalThis.removeEventListener?.('resize', onWindowResize)
        clearManagedWidth()
        localeRuntime?.dispose()
        localeRuntime = null
        if (typeof configSlotDisposer === 'function') configSlotDisposer()
        configSlotDisposer = null
        if (typeof storeSubscriptionDisposer === 'function') storeSubscriptionDisposer()
        storeSubscriptionDisposer = null
        if (typeof profileEpochDisposer === 'function') profileEpochDisposer()
        profileEpochDisposer = null
        if (typeof pendingFollowGuardDisposer === 'function') pendingFollowGuardDisposer()
        pendingFollowGuardDisposer = null
        if (changeSource !== null && typeof profileActiveListener === 'function') {
          changeSource.source?.removeEventListener?.('active', profileActiveListener)
        }
        profileActiveListener = null
        changeSource?.close?.()
        changeSource = null
        changeRouter = null
        profileResetListeners.clear()
        profileSwitchTarget = null
        profilesPromise = null
        profilesArchivedPromise = null
        refreshPending = false
        refreshForced = false
        if (typeof perfDisposer === 'function') perfDisposer()
        perfDisposer = null
        if (typeof styleDisposer === 'function') styleDisposer()
        styleDisposer = null
        doc?.removeEventListener?.('pointerdown', onPointerDown, true)
        doc?.removeEventListener?.('keydown', onKeyDown, true)
        doc?.removeEventListener?.('scroll', closeMenuOnViewportChange, true)
        globalThis.removeEventListener?.('resize', closeMenuOnViewportChange)
        floatingLabel?.dispose()
        floatingLabel = null
        queue?.dispose()
        queue = null
        getDiagnostics()?.dispose()
        if (toastTimer !== null) clearTimeout(toastTimer)
        toastTimer = null
      }
    }, 'dsh-session-grove: lifecycle')
  }

  return { mount }
}
