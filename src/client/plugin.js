/**
 * Client plugin composition root (SPEC §6.1).
 *
 * Creates the adapters (store/api/queue/locale), wires the three domain
 * controllers — `plugin-document.js` (document reads and commits),
 * `plugin-profiles.js` (profile registry and switch writes) and
 * `plugin-host.js` (slot/host actions/dialogs/mount wiring) — and keeps the
 * cross-cutting pieces: the runtime bridge, the SSE change stream, the toast
 * and the floating drag label.
 *
 * Dependency direction: `document ← profiles ← host`; the controllers never
 * import each other and only receive the narrow dependencies they use.
 *
 * One instance per page (the plugin is mounted once). `apply` must return void —
 * Cordis validates plugin return values as effects (Gate 0: returning an object
 * raises `TypeError: Invalid effect`).
 */
import { createApi } from './api.js'
import { createExternalChangeRouter, createStore, safeStorage } from './state.js'
import { createLocaleRuntime } from './plugin-locale.js'
import { createFloatingLabel } from './floating-label.js'
import { createOptimisticQueue } from './optimistic.js'
import { diagContext, diagEnabled, diagLabel, diagnosticsEnabled, diagTrace, getDiagnostics, initDiagnostics, stopDiagnostics } from './diagnostics.js'
import { perfCount, perfEnabled, perfNow, perfSample } from './perf.js'
import { installClientRuntime } from '../adapters/client-runtime.js'
import { createChangeStream } from '../adapters/change-stream.js'
import { CLIENT_REQUIRED, compatibilityReport, detectClientCapabilities } from '../adapters/dsh-capabilities.js'
import { resolveDshVersion, selectDshAdapter } from '../adapters/dsh-selector.js'
import { createDocumentSync } from './plugin-document.js'
import { createProfileController } from './plugin-profiles.js'
import { CENTER, createHostIntegration, VIEW_PRIORITY, VIEW_SLOT } from './plugin-host.js'

export { VIEW_PRIORITY, VIEW_SLOT }

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
  let localeRuntime = null
  let perfDisposer = null
  let documentSync = null
  let profiles = null
  let host = null
  let queue = null
  let bridge = null
  let changeSource = null
  let changeRouter = null
  let profileActiveListener = null
  let profileEpochDisposer = null
  let lastProfileEpoch = 0

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

  /** Live session ids for the switch preview classification (SPEC §8.4). */
  const liveSessionIds = () => {
    const sessions = services().sessions
    const snapshot = sessions?.list?.getSnapshot?.() ?? null
    if (!snapshot) return []
    if (Array.isArray(snapshot.ids)) return snapshot.ids
    return Object.keys(snapshot.byId ?? {})
  }

  /** Diagnostics bridge injected into the document/profile controllers. */
  const diag = {
    trace: diagTrace,
    enabled: diagEnabled,
    init: initDiagnostics,
    stop: stopDiagnostics,
    context: diagContext,
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

  /** Attach an inline error to the open dialog (shared by the controllers). */
  const failDialog = (messageKey, params = null) => {
    const dialog = store?.getSnapshot?.().dialog
    if (dialog) store.dispatch('dialog', { dialog: { ...dialog, error: messageKey, errorParams: params } })
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

  const startChangeStream = () => {
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
        profiles.refreshProfiles({ background: true })
        documentSync.refresh({ force: true })
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

  /** Tear down the composition-root-owned resources (host/controllers go first). */
  const teardownRoot = () => {
    if (typeof profileEpochDisposer === 'function') profileEpochDisposer()
    profileEpochDisposer = null
    if (changeSource !== null && typeof profileActiveListener === 'function') {
      changeSource.source?.removeEventListener?.('active', profileActiveListener)
    }
    profileActiveListener = null
    changeSource?.close?.()
    changeSource = null
    changeRouter = null
    localeRuntime?.dispose()
    localeRuntime = null
    if (typeof perfDisposer === 'function') perfDisposer()
    perfDisposer = null
    floatingLabel?.dispose()
    floatingLabel = null
    queue?.dispose()
    queue = null
    getDiagnostics()?.dispose()
    if (toastTimer !== null) clearTimeout(toastTimer)
    toastTimer = null
  }

  /**
   * Mount the client half. Returns void: Cordis inspects an async/plugin return
   * value as an effect list and rejects plain objects (Gate 0 finding).
   */
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
    documentSync = createDocumentSync({
      store,
      api,
      queue,
      diag,
      onProfileUnavailable: () => profiles?.refreshProfiles({ background: true }),
    })
    profiles = createProfileController({
      store,
      api,
      notify,
      t,
      documentSync,
      diag,
      liveSessionIds,
      failDialog,
    })
    host = createHostIntegration({
      ctx,
      store,
      t,
      documentSync,
      profiles,
      notify,
      services,
      failDialog,
      diag,
      onDispose: teardownRoot,
    })
    changeRouter = createExternalChangeRouter({
      store,
      requestRefresh: (options) => documentSync.refresh(options),
      onActiveChange: (activeId, info) => {
        // Local echo (activate target or save-as create): the response path owns
        // the document read and the toast, so a passive-switch reload/toast here
        // would duplicate it (SPEC §7.5).
        if (info.local) return
        const snapshot = store.getSnapshot()
        // Our own successful switch echo (or a registry-only bump) when the
        // document is already settled: the list refresh is enough.
        if (!info.changed && snapshot.profileId === activeId && snapshot.docState === 'ready') {
          profiles.refreshProfiles({ background: true })
          return
        }
        // Any `active` event may have raced an in-flight read (the read can
        // still return the previous profile), so invalidate it even when the
        // registry id already matches the freshly loaded list.
        documentSync.invalidate()
        if (info.changed) {
          // The router already dispatched the reset (epoch/latest revision/doc
          // state); read the new active document and registry list now, then
          // announce the passive switch with the resolved profile name.
          documentSync.load()
          profiles.announcePassiveSwitch(activeId)
        } else {
          documentSync.load({ background: true })
          profiles.refreshProfiles({ background: true })
        }
      },
      isLocalSwitch: (activeId) => profiles.isLocalSwitch(activeId),
      trace: (type, detail) => diagTrace(type, detail),
    })
    lastProfileEpoch = store.getSnapshot().profileEpoch
    profileEpochDisposer = store.subscribe(() => {
      const epoch = store.getSnapshot().profileEpoch
      if (epoch === lastProfileEpoch) return
      lastProfileEpoch = epoch
      // SPEC §7.3: the switch invalidates in-flight writes and every local
      // GroupsView interaction; the next render reads the new profile's doc.
      documentSync.applyEpoch()
      profiles.applyEpoch()
      host.applyEpoch()
      setFloatingLabel(null)
    })

    bridge = {
      store,
      t,
      get direction() {
        return localeRuntime?.direction() ?? 'ltr'
      },
      formatAbsoluteTime: (value) => localeRuntime?.formatAbsoluteTime(value) ?? null,
      api,
      actions: host.actions,
      get debugProbe() {
        return documentSync.getDebugProbe()
      },
      refreshRuntimeConfig: () => documentSync.refresh({ force: true }),
      notify,
      archiveSession: host.archiveSession,
      unarchiveSession: host.unarchiveSession,
      forkSession: host.forkSession,
      copySessionId: host.copySessionId,
      commitDoc: documentSync.commitDoc,
      commitOptimistic: documentSync.commitOptimistic,
      /** SPEC §7.4 step 2: a switch must be refused while a write is pending. */
      isPending: documentSync.isPending,
      load: documentSync.load,
      retryLoad: documentSync.retryLoad,
      refreshProfiles: profiles.refreshProfiles,
      previewProfile: profiles.previewProfile,
      activateProfile: profiles.activateProfile,
      createProfile: profiles.createProfile,
      renameProfile: profiles.renameProfile,
      archiveProfile: profiles.archiveProfile,
      onProfileSwitchReset: profiles.onProfileSwitchReset,
      setMode: host.setMode,
      toggleMode: host.toggleMode,
      openDialog: host.openDialog,
      newSessionInGroup: host.newSessionInGroup,
      reconcileNewSessionGroup: host.reconcileNewSessionGroup,
      confirmDialog: host.confirmDialog,
      deleteGroupDirect: host.deleteGroupDirect,
      setArchiveFilter: host.setArchiveFilter,
      resetLayout: host.resetLayout,
      setFloatingLabel,
      startDragLabel: () => {},
      showToast: (kind, message) => notify({ kind, message }),
      get capabilities() {
        return host.capabilities()
      },
      compatibility: clientCompatibility,
      dshVersion: declaredVersion,
      dshAdapter: selectedAdapter?.id ?? null,
    }
    installClientRuntime(bridge)
    startChangeStream()
    // SPEC §7.2/§7.7: probe the profile surface at mount. Old hosts answer a
    // non-JSON 404 and the store silently switches to single-profile mode.
    profiles.refreshProfiles()
    host.mount()
  }

  return { mount }
}
