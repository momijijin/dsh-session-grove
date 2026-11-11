/**
 * Dialog/command handlers for the groups view.
 *
 * These are user commands that open dialogs or start optimistic moves. They are
 * deliberately separate from menu anchoring and drag mechanics.
 */
import { clientRuntime as rt } from '../adapters/client-runtime.js'
import { childrenOf, findGroup, moveGroup } from '../shared/model.js'
import { assignSession } from '../shared/model.js'
import { archivedInfo, effectiveArchived, hasArchivedDescendant } from '../shared/archive.js'
import {
  currentColorHexOf,
  currentColorOf,
  currentGroupIdOf,
  currentIconOf,
  currentParentOf,
  deleteGroupDestinationVerdict,
  deleteGroupNeedsDialog,
  isArchiveErrorCode,
  moveGroupStepPrecheck,
} from '../core/dialog-selection.js'
import { sessionContainer } from '../core/tree.js'
import { GROUP_ICONS } from '../shared/constants.js'
import { workspaceChoices } from './actions.js'
import { GROUP_DROP_NOOP } from '../core/group-drag.js'

/**
 * Copy keys for archive-freeze entry guards and move-step reasons (resources
 * ship in P10). Computed maps keep the i18n literal-key guard green.
 */
const GROUP_ARCHIVE_KEYS = Object.freeze({
  archived: 'menu.groupArchivedLocked',
  containsArchived: 'menu.groupContainsArchivedLocked',
})

const MOVE_STEP_REASON_KEYS = Object.freeze({
  'group-archived': 'menu.groupArchivedLocked',
  'group-contains-archived': 'menu.groupContainsArchivedLocked',
  'group-position-locked': 'menu.groupPositionLocked',
  'group-destination-archived': 'menu.groupArchivedLocked',
  invalid: 'menu.groupPositionLocked',
})

const DEFAULT_MOVE_STEP_REASON_KEY = 'menu.groupPositionLocked'

/**
 * Derived archive state for one group menu (own flag decides the archive toggle
 * label; effective state locks the other entries, §5.3).
 *
 * @returns {{ ownArchived: boolean, effectiveArchived: boolean }}
 */
export const groupArchiveMenuState = (doc, groupId) => {
  const info = archivedInfo(doc, groupId)
  return { ownArchived: info.own, effectiveArchived: info.effective }
}

/**
 * Reason key for a blocked move-up/move-down step, or `null` when the step is
 * available (boundary no-ops also answer `null`: the menu keeps its existing
 * native-disabled presentation for them).
 */
export const groupMoveStepReasonKey = (doc, groupId, delta) => {
  const verdict = moveGroupStepPrecheck(doc, groupId, delta)
  if (verdict.ok || verdict.reason === null) return null
  return MOVE_STEP_REASON_KEYS[verdict.reason] ?? DEFAULT_MOVE_STEP_REASON_KEY
}

/** Reason key for a rejected move/delete operation, or `null` for non-archive errors. */
export const archiveErrorReasonKey = (error) => {
  if (error?.code === 'archive-frozen') {
    return MOVE_STEP_REASON_KEYS[error.reason] ?? DEFAULT_MOVE_STEP_REASON_KEY
  }
  if (isArchiveErrorCode(error?.code)) return MOVE_STEP_REASON_KEYS[error.code] ?? DEFAULT_MOVE_STEP_REASON_KEY
  return null
}

/**
 * Entry-guard reason key for the delete action (N5): a frozen group, a group
 * containing a frozen descendant, or a deletion whose source removal shifts a
 * frozen sibling anchor is blocked with its localized reason. `null` when the
 * delete dialog/action may open.
 */
export const deleteGroupActionReasonKey = (doc, groupId) => {
  if (effectiveArchived(doc, groupId)) return GROUP_ARCHIVE_KEYS.archived
  if (hasArchivedDescendant(doc, groupId)) return GROUP_ARCHIVE_KEYS.containsArchived
  const verdict = deleteGroupDestinationVerdict(doc, groupId, null)
  if (!verdict.ok && isArchiveErrorCode(verdict.reason)) {
    return MOVE_STEP_REASON_KEYS[verdict.reason] ?? DEFAULT_MOVE_STEP_REASON_KEY
  }
  return null
}

export const createDialogHandlers = ({ store, t, byId, workspaceItems, currentId }) => {
  const liveDoc = () => rt()?.store?.getSnapshot?.().doc ?? store.doc
  const moveGroupStep = (groupId, delta) => {
    // N5: precheck against the latest doc (complete children order) so a step
    // that would shift a frozen sibling anchor reports its reason and never
    // queues a write.
    const verdict = moveGroupStepPrecheck(liveDoc(), groupId, delta)
    if (!verdict.ok) {
      if (verdict.reason !== null) {
        rt()?.showToast?.('info', t(MOVE_STEP_REASON_KEYS[verdict.reason] ?? DEFAULT_MOVE_STEP_REASON_KEY))
      }
      return
    }
    const task = rt()?.commitOptimistic((latest) => {
      const group = findGroup(latest, groupId)
      if (!group) throw GROUP_DROP_NOOP
      const siblings = childrenOf(latest, group.parentId)
      const currentIndex = siblings.findIndex((item) => item.id === groupId)
      const nextIndex = currentIndex + delta
      if (currentIndex === -1 || nextIndex < 0 || nextIndex >= siblings.length) throw GROUP_DROP_NOOP
      return moveGroup(latest, groupId, group.parentId, nextIndex)
    })
    task?.catch((error) => {
      if (error === GROUP_DROP_NOOP || error?.reported === true) return
      const archiveKey = archiveErrorReasonKey(error)
      if (archiveKey !== null) {
        rt()?.showToast?.('info', t(archiveKey))
        return
      }
      if (globalThis.console?.warn) globalThis.console.warn('[dsh-session-grove] group move failed', error)
    })
  }

  const moveSessionStep = (sessionId, delta) => {
    const task = rt()?.commitOptimistic((latest) => {
      const container = sessionContainer(latest, sessionId)
      if (!container.ids) throw GROUP_DROP_NOOP
      const currentIndex = container.ids.indexOf(sessionId)
      const nextIndex = currentIndex + delta
      if (currentIndex === -1 || nextIndex < 0 || nextIndex >= container.ids.length) throw GROUP_DROP_NOOP
      return assignSession(latest, sessionId, container.groupId, nextIndex)
    })
    task?.catch((error) => {
      if (error === GROUP_DROP_NOOP || error?.reported === true) return
      if (globalThis.console?.warn) globalThis.console.warn('[dsh-session-grove] session move failed', error)
    })
  }

  return {
    moveGroupStep,
    moveSessionStep,
    openNewGroup: (event, parentId) => rt()?.openDialog({ kind: 'new-group', parentId, titleKey: parentId ? 'dialog.newSubgroup' : 'dialog.newGroup' }),
    openRenameGroup: (groupId) => rt()?.openDialog({ kind: 'rename-group', groupId, titleKey: 'dialog.renameGroup', value: findGroup(store.doc, groupId)?.name ?? '' }),
    openIconGroup: (groupId) =>
      rt()?.openDialog({ kind: 'icon', groupId, titleKey: 'group.icon', icons: [...GROUP_ICONS], current: currentIconOf(store.doc, groupId) }),
    openGroupColor: (groupId) =>
      rt()?.openDialog({
        kind: 'group-color',
        groupId,
        titleKey: 'dialog.groupColor',
        current: currentColorOf(store.doc, groupId),
        currentHex: currentColorHexOf(store.doc, groupId),
      }),
    openMoveGroup: (groupId) =>
      rt()?.openDialog({ kind: 'move-group', groupId, titleKey: 'dialog.moveGroup', currentId: currentParentOf(store.doc, groupId) }),
    openDeleteGroup: (groupId) => {
      const group = findGroup(store.doc, groupId)
      if (!group) return undefined
      // §5.3/§6.2/N5 entry guard: a frozen or frozen-containing group can never
      // be deleted; a source whose removal shifts a frozen sibling anchor is
      // blocked with the structured reason too instead of opening a dead dialog.
      const lockKey = deleteGroupActionReasonKey(store.doc, groupId)
      if (lockKey !== null) {
        rt()?.showToast?.('info', t(lockKey))
        return undefined
      }
      if (!deleteGroupNeedsDialog(store.doc, groupId)) return rt()?.deleteGroupDirect?.(groupId)
      rt()?.openDialog({
        kind: 'delete-group',
        groupId,
        titleKey: 'dialog.deleteGroup',
        sessionCount: group.sessionIds.length,
        childCount: childrenOf(store.doc, groupId).length,
      })
      return undefined
    },
    openNewSession: (event, groupId) => {
      const choices = workspaceChoices(store.doc, groupId, byId, workspaceItems, currentId)
      const workspaceId = choices.inferred ?? choices.choices[0]?.workspaceId
      if (!workspaceId) {
        rt()?.showToast('error', t('dialog.noWorkspace'))
        return
      }
      rt()?.newSessionInGroup?.(groupId, workspaceId)?.catch?.(() => {})
    },
    openRenameSession: (sessionId, title) => rt()?.openDialog({ kind: 'rename-session', sessionId, titleKey: 'dialog.renameSession', value: title ?? '' }),
    openMoveSession: (sessionId) =>
      rt()?.openDialog({ kind: 'move-session', sessionId, titleKey: 'dialog.moveSession', currentId: currentGroupIdOf(store.doc, sessionId) }),
    archiveSession: (sessionId) => rt()?.archiveSession(sessionId),
    unarchiveSession: (sessionId) => rt()?.unarchiveSession(sessionId),
    archiveGroup: (groupId) => rt()?.archiveGroup?.(groupId),
    unarchiveGroup: (groupId) => rt()?.unarchiveGroup?.(groupId),
    forkSession: (sessionId) => rt()?.forkSession(sessionId),
    copySessionId: (sessionId) => rt()?.copySessionId(sessionId),
  }
}
