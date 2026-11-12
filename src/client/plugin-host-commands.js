/**
 * Client host command layer (SPEC §5, S2 split).
 *
 * Owns the host-facing command surface moved out of `plugin-host.js`: action
 * bridge, archive/session/follow commands, dialog confirms, archive filters,
 * epoch reset and follow guard/cleanup. Imports no DSH package — the shell
 * injects `clipboard` and the dialog dispatchers — so plain Node can import it.
 */
import { assignSession, childrenOf, createGroup, deleteGroup, deleteGroupTo, detachSession, findGroup, moveGroup, renameGroup, setGroupArchived, setGroupColor, setGroupColorHex, setGroupIcon, workspaceOfSession } from '../shared/model.js'
import { computeGroupVisibility, effectiveArchived, hasArchivedDescendant } from '../shared/archive.js'
import { archiveFailureKey, archiveFailureNeedsRefresh, archiveNeedsConfirm as archiveConfirmBoundary, archiveVisibilityAction, groupArchiveCommitMatches, moveGroupSafeIndex, pendingFollowShouldAssign, shouldConfirmGroupArchive } from '../core/dialog-selection.js'
import { placeForkedSession } from '../core/fork.js'
import { newSessionFollow, pendingFollowStillValid } from '../core/new-session-follow.js'
import { sessionContainer } from '../core/tree.js'
import { createActions } from './actions.js'
import { readArchiveConfirmSkip, writeArchiveConfirmSkip } from './state/persistence.js'

/**
 * Copy keys for the 0.4.0-beta.62 group archive actions, invisible-result toasts
 * and inline confirm errors (resources ship in P10). Computed maps keep the
 * i18n literal-key guard green.
 */
const ARCHIVE_KEYS = Object.freeze({
  archiveTitle: 'dialog.archiveGroup',
  archivedToast: 'toast.groupArchived',
  unarchivedToast: 'toast.groupUnarchived',
  archivedHidden: 'toast.groupArchivedHidden',
  unarchivedHidden: 'toast.groupUnarchivedHidden',
  showArchived: 'toast.showArchivedGroups',
  showAll: 'toast.showAllGroups',
  createdInvisible: 'toast.createdInvisible',
  movedInvisible: 'toast.movedInvisible',
  movedToEnd: 'toast.moveGroupAppended',
  archivedLocked: 'menu.groupArchivedLocked',
  containsArchived: 'menu.groupContainsArchivedLocked',
})

/** Group id plus every recursive descendant id (cycle-safe). */
const groupSubtreeIds = (doc, groupId) => {
  const ids = new Set()
  const walk = (id) => {
    if (ids.has(id)) return
    ids.add(id)
    for (const child of childrenOf(doc, id)) walk(child.id)
  }
  walk(groupId)
  return ids
}

/** Whether a group still renders under one group filter (spec §4.2 semantics). */
const groupVisibleUnderFilter = (doc, groupId, filter) => {
  if (filter === 'all') return true
  const visibility = computeGroupVisibility(doc, filter)
  if (filter === 'only') return visibility.full.has(groupId) || visibility.path.has(groupId)
  return !visibility.full.has(groupId)
}

/** Whether a session's containing group renders its own sessions under one filter. */
const sessionVisibleUnderFilter = (doc, sessionId, filter) => {
  if (filter === 'all') return true
  const visibility = computeGroupVisibility(doc, filter)
  const groupId = sessionContainer(doc, sessionId).groupId
  return groupId === null ? visibility.ungroupedVisible : visibility.sessionGroups.has(groupId)
}

export const createHostCommands = ({
  store, t, documentSync, notify, services, failDialog, clipboard,
  getCurrentSessionId = () => null, openDialog, closeDialog,
}) => {
  // A host workspace switch may replace the freshly created blank with that
  // workspace's reusable blank. Keep the originating group intent for the whole
  // pre-prompt blank lifetime; every active switch follows immediately.
  let pendingNewSessionPlacement = null

  // --- host actions ---------------------------------------------------------
  const getDoc = () => store.getSnapshot().doc
  const actions = createActions({ getServices: services, getDoc, commitDoc: documentSync.commitDoc, notify, t, clipboard })

  // --- group archive actions (0.4.0-beta.62 §5.5/§8) ------------------------
  const getGroupArchiveFilter = () => store.getSnapshot().groupArchiveFilter ?? 'hidden'
  const setGroupArchiveFilter = (filter) => store.dispatch('group-archive-filter', { filter })

  /** Inline dialog copy for a structured archive-freeze failure, or `null`. */
  const archiveErrorKey = (error) => archiveFailureKey(error?.code, error?.reason)

  /** Entry-action toast copy for the same structured failure, or `null`. */
  const archiveEntryKey = (error) => (archiveErrorKey(error) === null ? null : ARCHIVE_KEYS.archivedLocked)

  /** Build a coded error from a stable archive reason (dialog updater rejection). */
  const codedError = (reason) => {
    const error = new Error(reason ?? 'archive-frozen')
    error.code = reason ?? 'archive-frozen'
    return error
  }

  /** Schedule focus onto a row once React has painted the filter change. */
  const focusRowScheduled = (kind, id) => {
    const doc = globalThis.document
    if (!doc?.querySelector) return
    const run = () => {
      const testId = kind === 'group' ? 'session-groups-group' : 'session-groups-session'
      const attr = kind === 'group' ? 'data-group-id' : 'data-session-id'
      const selector = typeof id === 'string' && id !== '' ? `[data-testid="${testId}"][${attr}="${id}"]` : null
      const row = selector ? doc.querySelector(selector) : null
      if (row?.focus) {
        row.focus({ preventScroll: true })
        return
      }
      const groupRow = doc.querySelector('[data-testid="session-groups-group"]')
      if (groupRow?.focus) {
        groupRow.focus({ preventScroll: true })
        return
      }
      doc.querySelector('[data-testid="session-groups-search"]')?.focus?.({ preventScroll: true })
    }
    if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(run)
    else setTimeout(run, 0)
  }

  /** Next visible group header after the group's subtree (focus fallback). */
  const captureNextGroupRowId = (groupId) => {
    const doc = globalThis.document
    if (!doc?.querySelectorAll) return null
    const rows = Array.from(doc.querySelectorAll('[data-testid="session-groups-group"]'))
    const index = rows.findIndex((row) => row.getAttribute('data-group-id') === groupId)
    if (index < 0) return null
    const subtree = groupSubtreeIds(getDoc(), groupId)
    for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
      const id = rows[cursor].getAttribute('data-group-id')
      if (!subtree.has(id)) return id
    }
    return null
  }

  /**
   * Archive confirmation boundary (§5.5/N12): direct sessions, direct child
   * groups, a running session or the current session inside the subtree needs a
   * confirm; an empty leaf commits directly. Unarchive never confirms.
   */
  const archiveNeedsConfirm = (groupId) => {
    const doc = getDoc()
    const group = findGroup(doc, groupId)
    if (!group) return false
    const sessionIds = []
    for (const id of groupSubtreeIds(doc, groupId)) {
      const entry = findGroup(doc, id)
      if (entry) sessionIds.push(...(entry.sessionIds ?? []))
    }
    // An empty subtree never reads host state; the boundary itself is the pure
    // helper so every input (content, running, current session) is unit-tested.
    const byId = sessionIds.length === 0 ? {} : services().sessions?.list?.getSnapshot?.()?.byId ?? {}
    const currentId = sessionIds.length === 0 || typeof getCurrentSessionId !== 'function' ? null : getCurrentSessionId()
    return archiveConfirmBoundary({
      directSessions: group.sessionIds?.length ?? 0,
      directChildGroups: childrenOf(doc, groupId).length,
      runningSessions: sessionIds.filter((sessionId) => byId[sessionId]?.running === true).length,
      currentSessionInside: currentId !== null && sessionIds.includes(currentId),
    })
  }

  /** Strict commit of one own-archive flag; captures the structured failure. */
  const commitGroupArchive = async (groupId, archived) => {
    try {
      const doc = await documentSync.commitDoc((latest) => setGroupArchived(latest, groupId, archived))
      // §5.5 B1: the strict queue adopts a CAS conflict as `result.doc`, which
      // has the same shape as a success. Re-check the desired state before any
      // caller may report success; refresh once so the view drops the stale doc.
      if (!groupArchiveCommitMatches(doc, groupId, archived)) {
        documentSync.refresh({ force: true })
        notify({ kind: 'error', message: t(archived ? 'toast.archiveFailed' : 'toast.unarchiveFailed') })
        return { ok: false, reason: 'archive-conflict' }
      }
      return { ok: true, doc }
    } catch (error) {
      return { ok: false, error, key: archiveErrorKey(error) }
    }
  }

  /** Toast/refresh for a direct (non-dialog) archive action failure. */
  const notifyArchiveFailure = (result) => {
    // A failed post-commit state check already toasted and refreshed once.
    if (result.reason === 'archive-conflict') return
    notify({ kind: 'error', message: t(result.key ?? 'toast.archiveFailed') })
    if (archiveFailureNeedsRefresh(result.error?.code)) documentSync.refresh({ force: true })
  }

  /** Success toast; when the group vanished under the filter, offer the switch. */
  const announceGroupArchive = (groupId, archived, result) => {
    const groupFilter = getGroupArchiveFilter()
    if (groupVisibleUnderFilter(result.doc, groupId, groupFilter)) {
      notify({ kind: 'success', message: t(archived ? ARCHIVE_KEYS.archivedToast : ARCHIVE_KEYS.unarchivedToast) })
      return
    }
    const messageKey = archived ? ARCHIVE_KEYS.archivedHidden : ARCHIVE_KEYS.unarchivedHidden
    const actionKey =
      archiveVisibilityAction(groupFilter, effectiveArchived(result.doc, groupId)) === 'showArchived'
        ? ARCHIVE_KEYS.showArchived
        : ARCHIVE_KEYS.showAll
    notify({
      kind: 'success',
      message: t(messageKey),
      action: {
        label: t(actionKey),
        onClick: () => {
          setGroupArchiveFilter('all')
          focusRowScheduled('group', groupId)
        },
      },
    })
  }

  const archiveGroup = async (groupId) => {
    const doc = getDoc()
    const group = findGroup(doc, groupId)
    if (!group || group.archived === true) return false
    // The opt-out only skips the confirmation boundary; the strict commit, the
    // guards and the success/failure handling below are identical either way.
    if (shouldConfirmGroupArchive(archiveNeedsConfirm(groupId), readArchiveConfirmSkip())) {
      openDialog({ kind: 'archive-group', groupId, archived: true, titleKey: ARCHIVE_KEYS.archiveTitle })
      return false
    }
    const focusCandidate = captureNextGroupRowId(groupId)
    const result = await commitGroupArchive(groupId, true)
    if (!result.ok) {
      notifyArchiveFailure(result)
      return false
    }
    if (!groupVisibleUnderFilter(result.doc, groupId, getGroupArchiveFilter())) focusRowScheduled('group', focusCandidate)
    announceGroupArchive(groupId, true, result)
    return true
  }

  const unarchiveGroup = async (groupId) => {
    const doc = getDoc()
    const group = findGroup(doc, groupId)
    if (!group || group.archived !== true) return false
    const focusCandidate = captureNextGroupRowId(groupId)
    const result = await commitGroupArchive(groupId, false)
    if (!result.ok) {
      notifyArchiveFailure(result)
      return false
    }
    if (!groupVisibleUnderFilter(result.doc, groupId, getGroupArchiveFilter())) focusRowScheduled('group', focusCandidate)
    announceGroupArchive(groupId, false, result)
    return true
  }

  /** Legal-but-invisible result: toast + explicit switch, never auto-switch. */
  const notifyInvisibleResult = (kind, targetKind, targetId) => {
    notify({
      kind: 'info',
      message: t(kind === 'created' ? ARCHIVE_KEYS.createdInvisible : ARCHIVE_KEYS.movedInvisible),
      action: {
        label: t(ARCHIVE_KEYS.showAll),
        onClick: () => {
          setGroupArchiveFilter('all')
          focusRowScheduled(targetKind, targetId)
        },
      },
    })
  }

  /** Direct group-head "+" / context-menu action: use the inferred workspace. */
  const newSessionInGroup = async (groupId, workspaceId) => {
    const doc = getDoc()
    if (!findGroup(doc, groupId)) {
      notify({ kind: 'error', message: t('dialog.createFailed') })
      return null
    }
    if (effectiveArchived(doc, groupId)) {
      notify({ kind: 'info', message: t(ARCHIVE_KEYS.archivedLocked) })
      return null
    }
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
      if (!sessionVisibleUnderFilter(getDoc(), result.sessionId, getGroupArchiveFilter())) {
        notifyInvisibleResult('created', 'session', result.sessionId)
      } else {
        notify({ kind: 'success', message: t('toast.saved') })
      }
      return result
    } catch (error) {
      const key = archiveEntryKey(error)
      if (key !== null) notify({ kind: 'info', message: t(key) })
      else notify({ kind: 'error', message: t('dialog.createFailed') })
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
    const doc = getDoc()
    // §8: a pending follow whose target group was archived never assigns; the
    // blank stays where the host put it.
    if (!pendingFollowShouldAssign(doc, pending.groupId)) {
      pendingNewSessionPlacement = null
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
      true,
      workspaceChanged,
    )
    if (!decision) {
      if (!activeRow || activeRow.blank !== true) pendingNewSessionPlacement = null
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
      // §8: a race that archived the target after the precheck leaves the blank
      // ungrouped instead of half-moving it.
      const key = archiveEntryKey(error)
      if (key !== null) notify({ kind: 'info', message: t(key) })
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
    // 0.4.0-beta.62 §8: a fork out of an archived container is refused before
    // the host creates the child session.
    const sourceDoc = getDoc()
    const sourceGroupId = sessionContainer(sourceDoc, sessionId).groupId
    if (sourceGroupId !== null && effectiveArchived(sourceDoc, sourceGroupId)) {
      notify({ kind: 'info', message: t(ARCHIVE_KEYS.archivedLocked) })
      return
    }
    let childId = null
    try {
      childId = await actions.forkSession(sessionId, (id) => {
        childId = id
      })
    } catch (error) {
      const archiveKey = archiveEntryKey(error)
      if (archiveKey !== null) {
        notify({ kind: 'info', message: t(archiveKey) })
        return
      }
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
    } catch (error) {
      // §8: a placement failure (e.g. the source was archived while forking)
      // leaves the child ungrouped and reports the reason instead of retrying.
      const archiveKey = archiveEntryKey(error)
      notify({ kind: 'error', message: t(archiveKey ?? 'toast.forkPlacementFailed') })
    }
  }

  const copySessionId = async (sessionId) => {
    const copied = await actions.copySessionId(sessionId)
    notify({
      kind: copied ? 'success' : 'error',
      message: t(copied ? 'toast.sessionIdCopied' : 'toast.sessionIdCopyFailed'),
    })
  }

  // --- dialog commands ------------------------------------------------------
  const commitDocFromAction = async (nextDoc, successKey = 'toast.saved', { notifySuccess = true } = {}) => {
    const committed = await documentSync.commitDoc(nextDoc)
    closeDialog()
    if (notifySuccess) notify({ kind: 'success', message: t(successKey) })
    return committed
  }

  /** Empty-leaf delete (0.2.9): no dialog, one commit, group-deleted toast. */
  const deleteGroupDirect = async (groupId) => {
    const doc = getDoc()
    if (!findGroup(doc, groupId)) return null
    // §5.3/§6.2 guard before the direct path: frozen groups and groups that
    // contain a frozen descendant can never be deleted.
    if (effectiveArchived(doc, groupId)) {
      notify({ kind: 'info', message: t(ARCHIVE_KEYS.archivedLocked) })
      return null
    }
    if (hasArchivedDescendant(doc, groupId)) {
      notify({ kind: 'info', message: t(ARCHIVE_KEYS.containsArchived) })
      return null
    }
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
          let createdId = null
          const committed = await commitDocFromAction(
            (latest) => {
              const before = new Set(latest.groups.map((group) => group.id))
              const next = createGroup(latest, { name, parentId: dialog.parentId ?? null })
              createdId = next.groups.find((group) => !before.has(group.id))?.id ?? null
              return next
            },
            'toast.saved',
            { notifySuccess: false }
          )
          // §4.6: a legal but filter-invisible result (root group/pathOnly child
          // under `only`) commits, then offers the explicit switch.
          if (createdId !== null && !groupVisibleUnderFilter(committed, createdId, getGroupArchiveFilter())) {
            notifyInvisibleResult('created', 'group', createdId)
          } else {
            notify({ kind: 'success', message: t('toast.saved') })
          }
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
          const committed = await actions.moveSession(dialog.sessionId, payload.groupId ?? null, 0)
          closeDialog()
          if (!sessionVisibleUnderFilter(committed, dialog.sessionId, getGroupArchiveFilter())) {
            notifyInvisibleResult('moved', 'session', dialog.sessionId)
          } else {
            notify({ kind: 'success', message: t('toast.moved') })
          }
          return
        }
        case 'move-group': {
          // N5: index 0 stays the product default; when it would shift a frozen
          // sibling anchor the group is appended to the destination instead and
          // the toast explains the adjustment. An archived destination is a
          // disabled option and is rejected inline on a stale dialog.
          const parentId = payload.groupId ?? null
          const preview = moveGroupSafeIndex(getDoc(), dialog.groupId, parentId)
          if (preview.noop) {
            closeDialog()
            notify({ kind: 'info', message: t(ARCHIVE_KEYS.movedToEnd) })
            return
          }
          if (preview.index === null) {
            failDialog(archiveFailureKey(codedError(preview.reason).code) ?? 'commit-failed')
            return
          }
          let plan = preview
          const committed = await commitDocFromAction(
            (latest) => {
              plan = moveGroupSafeIndex(latest, dialog.groupId, parentId)
              if (plan.index === null) throw codedError(plan.reason)
              // N5: the historical index-0 insertion stays the default; only a
              // frozen-anchor conflict switches to the append fallback.
              return plan.append
                ? moveGroup(latest, dialog.groupId, parentId, plan.index)
                : moveGroup(latest, dialog.groupId, payload.groupId ?? null, 0)
            },
            'toast.saved',
            { notifySuccess: false }
          )
          if (!groupVisibleUnderFilter(committed, dialog.groupId, getGroupArchiveFilter())) {
            notifyInvisibleResult('moved', 'group', dialog.groupId)
          } else if (plan.append) {
            notify({ kind: 'info', message: t(ARCHIVE_KEYS.movedToEnd) })
          } else {
            notify({ kind: 'success', message: t('toast.saved') })
          }
          return
        }
        case 'archive-group': {
          const focusCandidate = captureNextGroupRowId(dialog.groupId)
          const result = await commitGroupArchive(dialog.groupId, true)
          if (!result.ok) {
            // A post-commit state mismatch is not a structured archive-freeze
            // error, so it has no `key`; keep the dialog open with the generic
            // frozen copy instead of closing on a stale success.
            failDialog(
              result.key ?? (result.reason === 'archive-conflict' ? archiveFailureKey('archive-frozen') : 'commit-failed')
            )
            if (archiveFailureNeedsRefresh(result.error?.code)) documentSync.refresh({ force: true })
            return
          }
          // Only a successful archive persists the checkbox choice; cancel and
          // failures leave the stored preference untouched so the dialog can be
          // retried with the checkbox still checked.
          writeArchiveConfirmSkip(payload.dontAskAgain === true)
          closeDialog()
          if (!groupVisibleUnderFilter(result.doc, dialog.groupId, getGroupArchiveFilter())) {
            focusRowScheduled('group', focusCandidate)
          }
          announceGroupArchive(dialog.groupId, true, result)
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
      // §5.3: confirm guards re-validate against the latest doc and turn the
      // structured archive failure into inline localized copy, not a generic
      // `commit-failed`. A host-level freeze happened behind our back, so the
      // stale doc is re-read once.
      const archiveKey = archiveErrorKey(error)
      if (dialog.kind === 'rename-session') notify({ kind: 'error', message: t('toast.renameFailed') })
      else if (archiveKey !== null) {
        failDialog(archiveKey)
        if (archiveFailureNeedsRefresh(error?.code)) documentSync.refresh({ force: true })
      } else if (
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

  // --- follow guard ---------------------------------------------------------
  /** Drop the pending new-session follow intent (epoch change, dispose). */
  const clearPendingFollow = () => {
    pendingNewSessionPlacement = null
  }

  /** SPEC §7.3: an active-profile change drops the pending new-session placement. */
  const applyEpoch = () => clearPendingFollow()

  /** Manual-edit guard: a group change that moves/archives the target drops the follow. */
  const installFollowGuard = () =>
    store.subscribe(() => {
      const pending = pendingNewSessionPlacement
      if (!pending) return
      const doc = store.getSnapshot().doc
      // §8: an archived target cancels the follow even with the blank still inside.
      if (!pendingFollowStillValid(doc, pending) || !pendingFollowShouldAssign(doc, pending.groupId)) {
        pendingNewSessionPlacement = null
      }
    })

  return {
    actions, capabilities, archiveSession, unarchiveSession, forkSession, copySessionId,
    archiveGroup, unarchiveGroup, newSessionInGroup, reconcileNewSessionGroup,
    confirmDialog, deleteGroupDirect, setArchiveFilter, setGroupArchiveFilter,
    applyEpoch, installFollowGuard, clearPendingFollow,
  }
}
