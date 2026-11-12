/**
 * Client host integration (SPEC §7.2-§7.5/§9.4/§9.5).
 *
 * Owns the mount shell: the sidebar slot takeover, the workspace-mode chrome,
 * width/layout preferences, settings/styles installation, store subscriptions,
 * window/document listeners and the mount/dispose lifecycle.
 *
 * The host command surface (action bridge, archive/session/follow commands,
 * dialog confirms, archive filters and the epoch reset) lives in
 * `plugin-host-commands.js`. The shell owns the dialog dispatchers, injects
 * them into the command factory, and forwards the unchanged 21-key surface.
 *
 * The document and profile controllers are injected by the composition root;
 * this module never creates them and never wires the SSE change stream.
 */
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
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
import { readEntryHintDone, writeEntryHintDone, writeArchiveConfirmSkip } from './state/persistence.js'
import { DOCS_SITE_URL } from '../shared/constants.js'
import { createHostCommands } from './plugin-host-commands.js'

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
 * @param {() => string|null} [options.getCurrentSessionId] main-view session id
 * @param {{ context: Function, enabled: Function, trace: Function }} options.diag
 * @param {() => void} options.onDispose composition-root teardown callback
 */
export const createHostIntegration = ({ ctx, store, t, documentSync, profiles, notify, services, failDialog, diag, onDispose, getCurrentSessionId = () => null }) => {
  let mounted = false
  let occupantDisposer = null
  let styleDisposer = null
  let workspaceChrome = null
  let configSlotDisposer = null
  let storeSubscriptionDisposer = null
  let pendingFollowGuardDisposer = null
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
    // "Restore default display" also re-arms the archive confirmation dialog.
    writeArchiveConfirmSkip(false)
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
    // 0.4.0-beta.63: one-time entry hint. The copy is resolved at install time;
    // a dismissed hint returns `null`, so the toggle renders without the dot.
    getHint: () =>
      readEntryHintDone()
        ? null
        : {
            title: t('entry.title'),
            body: t('entry.body'),
            primary: t('entry.primary'),
            dismiss: t('entry.dismiss'),
            docsUrl: DOCS_SITE_URL,
            docsLabel: t('docs.title'),
          },
    onHintDismiss: () => writeEntryHintDone(),
    onToggle: () => {
      writeEntryHintDone()
      toggleMode()
    },
    syncSidebarWidth,
    isMounted: () => mounted,
  })

  // --- dialogs --------------------------------------------------------------
  // The dialog dispatchers stay in the shell: they are injected into the host
  // command layer, and the shell remains the only place that adds the anchor.
  // They must be constructed before `createHostCommands` runs (no TDZ).
  const openDialog = (dialog) => {
    if (!store) return
    store.dispatch('dialog', { dialog: { x: CENTER.x, y: CENTER.y, ...dialog } })
  }

  const closeDialog = () => store.dispatch('dialog', { dialog: null })

  // --- host commands --------------------------------------------------------
  const commands = createHostCommands({
    store,
    t,
    documentSync,
    notify,
    services,
    failDialog,
    clipboard: writeClipboard,
    getCurrentSessionId,
    openDialog,
    closeDialog,
  })

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
    pendingFollowGuardDisposer = commands.installFollowGuard()

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
      commands.clearPendingFollow()
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
    actions: commands.actions,
    capabilities: commands.capabilities,
    archiveSession: commands.archiveSession,
    unarchiveSession: commands.unarchiveSession,
    forkSession: commands.forkSession,
    copySessionId: commands.copySessionId,
    archiveGroup: commands.archiveGroup,
    unarchiveGroup: commands.unarchiveGroup,
    openDialog,
    newSessionInGroup: commands.newSessionInGroup,
    reconcileNewSessionGroup: commands.reconcileNewSessionGroup,
    confirmDialog: commands.confirmDialog,
    deleteGroupDirect: commands.deleteGroupDirect,
    setArchiveFilter: commands.setArchiveFilter,
    setGroupArchiveFilter: commands.setGroupArchiveFilter,
    resetLayout,
    setMode,
    toggleMode,
    applyEpoch: commands.applyEpoch,
  }
}
