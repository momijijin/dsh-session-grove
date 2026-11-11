/**
 * Session/group row menu and toast presentation.
 *
 * Extracted from components.js as a behavior-neutral split. The menu keeps the
 * same DOM/test ids and delegates all mutations to the shell handlers.
 */
import { createElement, useEffect, useLayoutEffect, useRef } from 'react'
import { clientRuntime as rt } from '../adapters/client-runtime.js'
import { clampMenuPosition } from '../core/menu-position.js'
import { sessionNeighbors, siblingNeighbors } from '../core/tree.js'
import { groupMenuLockReason, sessionMenuLockReason } from './groups-view-menu-handlers.js'
import { groupArchiveMenuState, groupMoveStepReasonKey, deleteGroupActionReasonKey } from './groups-view-dialog-handlers.js'
import { toast } from './command-runtime.js'

const h = createElement

/**
 * Group-menu copy for the archive toggle (0.4.0-beta.62 §5.5). The label follows
 * the group's own flag, so a group that is frozen by an archived ancestor still
 * offers "archive this group" (no cascade). The keys live in a computed map for
 * the P10 locale batch.
 */
const GROUP_ARCHIVE_MENU_KEYS = Object.freeze({
  archive: 'group.archive',
  unarchive: 'group.unarchive',
})

/** Restore focus to the row that opened a group/session menu. */
const menuSourceRow = (menu) => {
  if (!menu) return null
  const testId = menu.kind === 'group' ? 'session-groups-group' : 'session-groups-session'
  const attr = menu.kind === 'group' ? 'data-group-id' : 'data-session-id'
  const value = menu.kind === 'group' ? menu.groupId : menu.sessionId
  const rows = globalThis.document?.querySelectorAll?.(`[data-testid="${testId}"]`) ?? []
  for (const row of rows) if (row.getAttribute?.(attr) === value) return row
  return null
}

/**
 * Transient toast. SPEC §7.8/§9.6: besides the message a toast may carry one
 * text action (switch undo). The action clears the toast immediately when it
 * runs; the plugin owns the 5s vs 2.6s dismissal timers.
 */
export const Toast = ({ store }) => {
  const toastState = store.toast
  if (!toastState) return null
  const action = toastState.action ?? null
  if (!action) return h('div', { class: 'dsg-toast', 'data-testid': 'session-groups-toast' }, toastState.message ?? '')
  return h(
    'div',
    { class: 'dsg-toast', 'data-testid': 'session-groups-toast' },
    toastState.message ?? '',
    h(
      'button',
      {
        type: 'button',
        class: 'dsg-toast-action',
        'data-testid': 'session-groups-toast-action',
        onClick: (event) => {
          event.stopPropagation()
          // Clear first: the action may raise its own toast (undo success/failure).
          rt()?.store?.dispatch?.('toast', { toast: null })
          action.onClick?.()
        },
      },
      action.label ?? rt()?.t?.('profiles.undo') ?? 'Undo'
    )
  )
}

export const MenuPopover = ({ store, handlers }) => {
  const menu = store.menu
  const menuRef = useRef(null)
  // Refine the estimated anchor with the real menu rect so a ~275px group menu
  // is clamped to the viewport instead of relying on a hard-coded 200px guess.
  useLayoutEffect(() => {
    const node = menuRef.current
    if (!node || !menu) return
    const rect = node.getBoundingClientRect()
    const next = clampMenuPosition({
      x: menu.anchorX ?? menu.x,
      y: menu.anchorY ?? menu.y,
      width: rect.width,
      height: rect.height,
      viewportWidth: globalThis.innerWidth,
      viewportHeight: globalThis.innerHeight,
    })
    node.style.left = `${next.x}px`
    node.style.top = `${next.y}px`
  }, [menu])
  // Focus the first item when the menu opens; when it closes (Escape, outside,
  // scroll, resize or an action) focus returns to the originating row.
  useEffect(() => {
    if (!menu) return undefined
    const node = menuRef.current
    const first = node?.querySelector?.('button:not([disabled])')
    ;(first ?? node)?.focus?.({ preventScroll: true })
    return () => {
      menuSourceRow(menu)?.focus?.({ preventScroll: true })
    }
  }, [menu])
  if (!menu) return null
  const t = rt()?.t
  /**
   * One menu entry. `disabledReason` renders a focusable `aria-disabled` row with
   * the reason in `title`/`aria-label`; clicking it reports the reason instead of
   * running the action (§5.3: never silently hide a necessarily-illegal entry).
   */
  const item = (key, label, onClick, extra = {}) => {
    const { disabledReason = null, ...rest } = extra
    const unavailable = disabledReason !== null || rest.disabled === true
    return h(
      'button',
      {
        key,
        type: 'button',
        role: 'menuitem',
        class: 'dsg-menu-item',
        'data-disabled': unavailable ? 'true' : 'false',
        ...(disabledReason === null
          ? {}
          : { 'aria-disabled': 'true', title: disabledReason, 'aria-label': `${label} — ${disabledReason}` }),
        onClick: (event) => {
          event.stopPropagation()
          handlers.closeMenu()
          if (disabledReason !== null) {
            toast('info', disabledReason)
            return
          }
          if (rest.disabled === true) return
          onClick()
        },
        ...rest,
      },
      label
    )
  }
  const groupLockedExtra = (action) => {
    const reasonKey = groupMenuLockReason(menu, action)
    return reasonKey === null ? {} : { disabledReason: t(reasonKey) }
  }
  const sessionLockedExtra = (action) => {
    const reasonKey = sessionMenuLockReason(menu, action)
    return reasonKey === null ? {} : { disabledReason: t(reasonKey) }
  }
  const onMenuKeyDown = (event) => {
    const items = Array.from(menuRef.current?.querySelectorAll?.('[role="menuitem"]:not([disabled])') ?? [])
    if (items.length === 0) return
    const current = items.indexOf(globalThis.document?.activeElement)
    let next = -1
    if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length
    else if (event.key === 'ArrowUp') next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    if (next < 0) return
    event.preventDefault()
    items[next].focus()
  }
  const children = []
  if (menu.kind === 'group') {
    const { previous, next } = siblingNeighbors(store.doc, menu.groupId)
    // Own flag decides the archive-toggle label; the effective state locks every
    // other entry (P8 policy). A frozen group inside a frozen ancestor can still
    // archive itself (§5.3/§5.5, no cascade).
    const ownArchived = groupArchiveMenuState(store.doc, menu.groupId).ownArchived
    const moveItem = (key, label, testid, boundaryDisabled, delta) => {
      const lockKey = groupMenuLockReason(menu, key)
      const stepKey = lockKey === null ? groupMoveStepReasonKey(store.doc, menu.groupId, delta) : null
      const reasonKey = lockKey ?? stepKey
      return item(key, label, () => handlers.moveGroupStep(menu.groupId, delta), {
        'data-testid': testid,
        'data-group-id': menu.groupId,
        ...(reasonKey === null
          ? boundaryDisabled
            ? { disabled: true }
            : {}
          : { disabledReason: t(reasonKey) }),
      })
    }
    children.push(item('new-session', t('group.newSession'), () => handlers.openNewSession(null, menu.groupId), {
      'data-testid': 'session-groups-group-new-session',
      'data-group-id': menu.groupId,
      ...groupLockedExtra('new-session'),
    }))
    children.push(item('new-subgroup', t('group.newSubgroup'), () => handlers.openNewGroup(null, menu.groupId), groupLockedExtra('new-subgroup')))
    children.push(item('rename', t('group.rename'), () => handlers.openRenameGroup(menu.groupId), groupLockedExtra('rename')))
    children.push(item('icon', t('group.icon'), () => handlers.openIconGroup(menu.groupId), groupLockedExtra('icon')))
    children.push(item('color', t('group.color'), () => handlers.openGroupColor(menu.groupId), groupLockedExtra('color')))
    children.push(item('move', t('group.moveTo'), () => handlers.openMoveGroup(menu.groupId), groupLockedExtra('move')))
    children.push(moveItem('move-up', t('group.moveUp'), 'session-groups-group-move-up', previous === null, -1))
    children.push(moveItem('move-down', t('group.moveDown'), 'session-groups-group-move-down', next === null, 1))
    children.push(h('div', { key: 'sep', class: 'dsg-menu-separator' }))
    children.push(
      item(
        ownArchived ? 'unarchive' : 'archive',
        t(ownArchived ? GROUP_ARCHIVE_MENU_KEYS.unarchive : GROUP_ARCHIVE_MENU_KEYS.archive),
        () => (ownArchived ? handlers.unarchiveGroup(menu.groupId) : handlers.archiveGroup(menu.groupId)),
        {
          'data-testid': ownArchived ? 'session-groups-group-unarchive' : 'session-groups-group-archive',
          'data-group-id': menu.groupId,
          'data-own-archived': ownArchived ? 'true' : 'false',
          ...groupLockedExtra(ownArchived ? 'unarchive' : 'archive'),
        }
      )
    )
    const deleteExtra = groupLockedExtra('delete')
    const deleteStepKey =
      deleteExtra.disabledReason === undefined ? deleteGroupActionReasonKey(store.doc, menu.groupId) : null
    children.push(
      item('delete', t('group.delete'), () => handlers.openDeleteGroup(menu.groupId), {
        ...deleteExtra,
        ...(deleteStepKey === null ? {} : { disabledReason: t(deleteStepKey) }),
      })
    )
  } else if (menu.kind === 'session') {
    children.push(item('rename', t('session.rename'), () => handlers.openRenameSession(menu.sessionId, menu.title)))
    if (menu.blank !== true && rt()?.capabilities.fork?.(menu.sessionId) === true) {
      children.push(item('fork', t('session.fork'), () => handlers.forkSession(menu.sessionId), sessionLockedExtra('fork')))
    }
    children.push(
      menu.archived
        ? item('unarchive', t('session.unarchive'), () => handlers.unarchiveSession(menu.sessionId))
        : item('archive', t('session.archive'), () => handlers.archiveSession(menu.sessionId))
    )
    children.push(item('copy-id', t('session.copyId'), () => handlers.copySessionId(menu.sessionId)))
    children.push(item('move', t('session.moveTo'), () => handlers.openMoveSession(menu.sessionId), sessionLockedExtra('move')))
    const { previous, next } = sessionNeighbors(store.doc, menu.sessionId)
    const sessionMoveItem = (key, label, testid, boundaryDisabled, delta) => {
      const reasonKey = sessionMenuLockReason(menu, key)
      return item(key, label, () => handlers.moveSessionStep(menu.sessionId, delta), {
        'data-testid': testid,
        'data-session-id': menu.sessionId,
        ...(reasonKey === null
          ? boundaryDisabled
            ? { disabled: true }
            : {}
          : { disabledReason: t(reasonKey) }),
      })
    }
    children.push(sessionMoveItem('move-up', t('session.moveUp'), 'session-groups-session-move-up', previous === null, -1))
    children.push(sessionMoveItem('move-down', t('session.moveDown'), 'session-groups-session-move-down', next === null, 1))
  }
  return h(
    'div',
    {
      ref: menuRef,
      class: 'dsg-menu',
      role: 'menu',
      tabindex: '-1',
      'data-testid': 'session-groups-menu',
      'data-menu-kind': menu.kind,
      'data-source-id': menu.kind === 'group' ? menu.groupId : menu.sessionId,
      style: { left: `${menu.x}px`, top: `${menu.y}px` },
      onClick: (event) => event.stopPropagation(),
      onKeyDown: onMenuKeyDown,
    },
    ...children
  )
}
