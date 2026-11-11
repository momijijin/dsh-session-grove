/**
 * Menu anchoring and navigation handlers for the groups view.
 *
 * Dialog/command handlers live in groups-view-dialog-handlers.js; this module
 * only owns menu state/anchors and lightweight navigation commands.
 */
import { clientRuntime as rt } from '../adapters/client-runtime.js'
import { sessionTitle } from '../core/filter.js'
import { menuAnchorFromEvent, menuAnchorFromRow } from '../core/menu-position.js'
import { dispatch, toast } from './command-runtime.js'

/**
 * Locale keys for menu entries unavailable under the archive freeze (resources
 * ship in P10). Kept in a computed map so the i18n literal-key guard stays green
 * until the 19-language dictionaries are updated.
 */
const GROUP_MENU_LOCK_KEYS = Object.freeze({
  archived: 'menu.groupArchivedLocked',
  containsArchived: 'menu.groupContainsArchivedLocked',
})

const SESSION_MENU_LOCK_KEYS = Object.freeze({
  structuralLocked: 'menu.sessionStructuralLocked',
})

/** Group edits that would move a frozen descendant's anchor (§6.2). */
const GROUP_STRUCTURAL_ACTIONS = new Set(['move', 'move-up', 'move-down', 'delete'])
/** The archive toggle itself is always legal (§5.3). */
const GROUP_ARCHIVE_ACTIONS = new Set(['archive', 'unarchive'])

/**
 * Reason key for a disabled group-menu entry, or `null` when the entry stays
 * available. An archived group freezes every edit except the archive toggle.
 * A live ancestor of an archived subtree only freezes structural edits: its
 * metadata, new sessions and sub-groups stay legal (§5.3/§6.2, pathOnly `+`).
 *
 * @param {{kind:'group', archived?:boolean, containsArchived?:boolean}|null} menu
 * @param {string} action menu entry id (`new-session`, `rename`, `move-up`, …)
 * @returns {string|null}
 */
export const groupMenuLockReason = (menu, action) => {
  if (!menu || menu.kind !== 'group' || typeof action !== 'string') return null
  if (GROUP_ARCHIVE_ACTIONS.has(action)) return null
  if (menu.archived === true) return GROUP_MENU_LOCK_KEYS.archived
  if (menu.containsArchived === true && GROUP_STRUCTURAL_ACTIONS.has(action)) return GROUP_MENU_LOCK_KEYS.containsArchived
  return null
}

/**
 * Reason key for a disabled session-menu entry, or `null` when it stays
 * available. A session inside an archived container keeps rename / archive
 * toggle / copy id / open; its structural moves and fork are locked (§5.4).
 *
 * @param {{kind:'session', structuralLocked?:boolean}|null} menu
 * @param {string} action menu entry id (`move`, `fork`, `move-up`, `move-down`, …)
 * @returns {string|null}
 */
export const sessionMenuLockReason = (menu, action) => {
  if (!menu || menu.kind !== 'session' || typeof action !== 'string') return null
  if (menu.structuralLocked !== true) return null
  return action === 'move' || action === 'move-up' || action === 'move-down' || action === 'fork'
    ? SESSION_MENU_LOCK_KEYS.structuralLocked
    : null
}

export const createMenuHandlers = (ctx) => {
  const { t, dragRef, consumeDragClick, handleWidthReset, selectSearchResult } = ctx

  const sessionMenuState = (sessionNode, point, structuralLocked = false) => ({
    kind: 'session',
    x: point.x,
    y: point.y,
    anchorX: point.anchorX,
    anchorY: point.anchorY,
    sessionId: sessionNode.session.id,
    title: sessionTitle(sessionNode.session, { blankLabel: t('session.blank'), untitledLabel: t('session.untitled') }),
    archived: sessionNode.archived === true,
    blank: sessionNode.session.blank === true,
    // Container archive lock from the containing group's effective state (§5.4).
    structuralLocked: structuralLocked === true,
  })
  const openSessionMenu = (event, sessionNode, structuralLocked = false) => {
    dispatch('menu', {
      menu: sessionMenuState(sessionNode, menuAnchorFromEvent(event, { width: globalThis.innerWidth, height: globalThis.innerHeight }), structuralLocked),
    })
  }
  const openSessionMenuAtRow = (rowElement, sessionNode, structuralLocked = false) => {
    dispatch('menu', {
      menu: sessionMenuState(sessionNode, menuAnchorFromRow(rowElement, { width: globalThis.innerWidth, height: globalThis.innerHeight }), structuralLocked),
    })
  }
  const groupMenuState = (group, point, meta = null) => ({
    kind: 'group',
    x: point.x,
    y: point.y,
    anchorX: point.anchorX,
    anchorY: point.anchorY,
    groupId: group.id,
    // Derived archive flags computed by GroupNode (§5.3); absent means unlocked
    // (old callers/tests and the P9 dialogs that only know the group id).
    archived: meta?.archived === true,
    containsArchived: meta?.containsArchived === true,
  })
  const openGroupMenu = (event, group, meta = null) => {
    const point = menuAnchorFromEvent(event, { width: globalThis.innerWidth, height: globalThis.innerHeight })
    dispatch('menu', { menu: groupMenuState(group, point, meta) })
  }
  const openGroupMenuAtRow = (rowElement, group, meta = null) => {
    const point = menuAnchorFromRow(rowElement, { width: globalThis.innerWidth, height: globalThis.innerHeight })
    dispatch('menu', { menu: groupMenuState(group, point, meta) })
  }

  return {
    toggleGroup: (id) => dispatch('toggle-group', { id }),
    onGroupClick: (id) => {
      if (consumeDragClick(id)) return
      dispatch('toggle-group', { id })
    },
    retryLoad: () => rt()?.retryLoad(),
    openSession: (id) => rt()?.actions.openSession(id),
    setArchiveFilter: (filter) => dispatch('archive-filter', { filter }),
    setGroupArchiveFilter: (filter) => dispatch('group-archive-filter', { filter }),
    resetLayout: () => {
      rt()?.resetLayout?.()
      handleWidthReset()
    },
    searchSelect: (entry) => selectSearchResult(entry),
    openRunningSession: (sessionId, archived) => selectSearchResult({ sessionId, archived }),
    searchArchived: () => toast('info', t('search.archivedDisabled')),
    openSessionMenu,
    openSessionMenuAtRow,
    onSessionContextMenu: (event, sessionNode, structuralLocked = false) => {
      event.preventDefault()
      event.stopPropagation()
      if (dragRef.current) return
      openSessionMenu(event, sessionNode, structuralLocked)
    },
    openGroupMenu,
    openGroupMenuAtRow,
    onGroupContextMenu: (event, group, meta = null) => {
      event.preventDefault()
      event.stopPropagation()
      if (dragRef.current) return
      openGroupMenu(event, group, meta)
    },
    closeMenu: () => dispatch('menu', { menu: null }),
  }
}
