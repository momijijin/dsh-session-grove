/**
 * Client host integration (SPEC §7.2-§7.5/§9.4/§9.5).
 *
 * Owns the host-facing half of the plugin: the sidebar slot takeover, the
 * workspace-mode chrome, the host action facade (new session, archive/fork/copy,
 * dialog orchestration) and the mount/unmount event wiring (styles, settings
 * slot, store subscriptions, window/document listeners, Cordis lifecycle).
 *
 * The document and profile controllers are injected by the composition root;
 * this module never creates them and never wires the SSE change stream.
 */
import { assignSession, createGroup, deleteGroup, deleteGroupTo, detachSession, findGroup, moveGroup, renameGroup, setGroupColor, setGroupColorHex, setGroupIcon, workspaceOfSession } from '../shared/model.js'
import { placeForkedSession } from '../core/fork.js'
import { newSessionFollow, pendingFollowStillValid } from '../core/new-session-follow.js'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { createActions } from './actions.js'
import { installSettingsSlot } from './plugin-settings.js'
import { SkillRepairCard } from './skill-repair.js'
import { createWorkspaceChrome } from './plugin-workspace-chrome.js'
import { installStyles } from './css.js'
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

/** Default dialog anchor (host dialogs open near the top-left content corner). */
export const CENTER = { x: 24, y: 120 }

/**
 * Create the host integration.
 *
 * @param {object} options
 * @param {object} options.ctx Cordis context (slots/services/lifecycle)
 * @param {object} options.store view store (getSnapshot/dispatch/subscribe)
 * @param {Function} options.t active translator
 * @param {object} options.documentSync document controller
 * @param {object} options.profiles profile controller
 * @param {Function} options.notify toast bridge owned by the composition root
 * @param {() => object} options.services host services accessor
 * @param {Function} options.failDialog attach an inline dialog error
 * @param {{ context: Function, enabled: Function, trace: Function }} options.diag
 * @param {() => void} options.onDispose composition-root teardown callback
 */
export const createHostIntegration = ({ ctx, store, t, documentSync, profiles, notify, services, failDialog, diag, onDispose }) => {
  let mounted = false
  let occupantDisposer = null
  let styleDisposer = null
  let workspaceChrome = null
  let configSlotDisposer = null
  let storeSubscriptionDisposer = null
  let pendingFollowGuardDisposer = null
  // A host workspace switch may replace the freshly created blank with that
  // workspace's reusable blank. Keep the originating group intent for the whole
  // pre-prompt blank lifetime; every active switch follows immediately.
  let pendingNewSessionPlacement = null
  let dispose = () => {}

  // --- slot lifecycle -------------------------------------------------------
  const reportRegistrationFailure = (error) => {
    if (globalThis.console?.warn) globalThis.console.warn('[dsh-session-grove] sidebar registration failed', error)
    notify({ kind: 'error', message: t('error.title') })
    store.dispatch('banner', { banner: { kind: 'error', code: 'registration-failed' } })
  }

  const registerOccupant = () => {
    if (occupantDisposer !== null) return
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
    if (diag.enabled()) {
      diag.context({ mode: next })
      diag.trace('mode.change', { mode: next })
    }
    if (next === 'groups') {
      registerOccupant()
      // Re-read the Host document every time the groups view becomes active.
      // requestRefresh defers while an optimistic write is still unsettled.
      documentSync.refresh({ force: true })
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
  const actions = createActions({ getServices: services, getDoc, commitDoc: documentSync.commitDoc, notify, t, clipboard: writeClipboard })

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
      const write = documentSync.commitOptimistic((latest) => {
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
      await documentSync.commitDoc((latest) => placeForkedSession(latest, sessionId, childId))
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

  const commitDocFromAction = async (nextDoc, successKey = 'toast.saved') => {
    const committed = await documentSync.commitDoc(nextDoc)
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

  /**
   * SPEC §7.3: an active-profile change drops the pending new-session placement
   * (the workspace switch that owned it belongs to the previous profile).
   */
  const applyEpoch = () => {
    pendingNewSessionPlacement = null
  }

  // --- mounting -------------------------------------------------------------
  const mount = () => {
    if (mounted) return
    mounted = true
    styleDisposer = installStyles(globalThis.document)
    configSlotDisposer = installSettingsSlot(ctx, SkillRepairCard)
    if (storeSubscriptionDisposer === null) {
      storeSubscriptionDisposer = store.subscribe(() => documentSync.onStorePublish())
    }
    // Any manual group change that moves the tracked blank closes the pending
    // follow intent; otherwise a later workspace switch could undo the user's move.
    pendingFollowGuardDisposer = store.subscribe(() => {
      const pending = pendingNewSessionPlacement
      if (!pending) return
      if (!pendingFollowStillValid(store.getSnapshot().doc, pending)) pendingNewSessionPlacement = null
    })

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

    dispose = () => {
      mounted = false
      disposeOccupant()
      workspaceChrome?.dispose()
      workspaceChrome = null
      globalThis.removeEventListener?.('resize', onWindowResize)
      globalThis.removeEventListener?.('resize', closeMenuOnViewportChange)
      clearManagedWidth()
      if (typeof configSlotDisposer === 'function') configSlotDisposer()
      configSlotDisposer = null
      if (typeof storeSubscriptionDisposer === 'function') storeSubscriptionDisposer()
      storeSubscriptionDisposer = null
      if (typeof pendingFollowGuardDisposer === 'function') pendingFollowGuardDisposer()
      pendingFollowGuardDisposer = null
      if (typeof styleDisposer === 'function') styleDisposer()
      styleDisposer = null
      doc?.removeEventListener?.('pointerdown', onPointerDown, true)
      doc?.removeEventListener?.('keydown', onKeyDown, true)
      doc?.removeEventListener?.('scroll', closeMenuOnViewportChange, true)
      pendingNewSessionPlacement = null
    }

    // Mode controller + unload cleanup are one effect: the disposer is owned by
    // the plugin fiber (Gate 0 verified slot lifecycle).
    ctx.effect(() => {
      if (store.getSnapshot().viewMode === 'groups') {
        registerOccupant()
        documentSync.load()
      }
      return () => {
        dispose()
        documentSync.dispose()
        profiles.dispose()
        onDispose()
      }
    }, 'dsh-session-grove: lifecycle')
  }

  return {
    mount,
    dispose: () => dispose(),
    actions,
    capabilities,
    archiveSession,
    unarchiveSession,
    forkSession,
    copySessionId,
    openDialog,
    newSessionInGroup,
    reconcileNewSessionGroup,
    confirmDialog,
    deleteGroupDirect,
    setArchiveFilter,
    resetLayout,
    setMode,
    toggleMode,
    applyEpoch,
  }
}
