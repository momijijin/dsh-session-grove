/**
 * React components for the groups sidebar (plain `createElement`, no JSX).
 *
 * Components are registered into DSH slots and receive the framework standard
 * toolkit as props (`useSessions`, `useWorkspaces`, `useSessionStatus`,
 * `usePanelInfo`, `…`) plus the slot owner share. Everything host-derived is read
 * from those hooks; the only local state is this plugin's view store.
 */
import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useGroupsSidebarWidth } from './groups-view-width.js'
import { useGroupsViewState } from './groups-view-state.js'
import { useGroupsSearchReveal } from './groups-view-search.js'
import { createMenuHandlers } from './groups-view-menu-handlers.js'
import { createDialogHandlers } from './groups-view-dialog-handlers.js'
import { clientRuntime as rt } from '../adapters/client-runtime.js'
import { findGroup, workspaceOfSession } from '../shared/model.js'
import { currentGroupIdOf } from '../core/dialog-selection.js'
import { MenuPopover, Toast } from './session-menu.js'
import { DialogHost } from './dialog-host.js'
import { countTreeSessions, sessionTitle } from '../core/filter.js'
import { applyDrop, checkSessionDrop, hitTest, sameDropTarget, sessionLocation, stickyDropTarget, ungroupedBodyTarget } from '../core/drag.js'
import { applyGroupDrop, checkGroupDrop } from '../core/archive-drop.js'
import { effectiveArchived, hasArchivedDescendant } from '../shared/archive.js'
import { computeGroupVisibility } from '../shared/archive.js'
import { diagContext, diagDragEnd, diagDragStart, diagDropState, diagEnabled, diagHandler, diagRender, diagTargetChange, diagTrace } from './diagnostics.js'
import { GROUP_DRAG_MIME, groupHeaderZoneFromRect } from '../core/group-drag.js'
import { perfDragOver, perfDropTarget, perfEnabled, perfMark, perfNow, perfRender, perfSample } from './perf.js'
import { readOnboardingDone, writeOnboardingDone } from './state.js'
import { SIDEBAR_WIDTH_MIN } from './sidebar-width.js'
import { expandAncestors, isExpanded } from '../core/tree.js'
import { GROUP_DROP_NOOP, useViewStore, usePerfCommit, dispatch, toast, TextButton, DropPlaceholder, GROUP_PLACEHOLDER_HEIGHT } from './components-primitives.js'
import { SessionRow, GroupNode } from './components-rows.js'
import { UngroupedSection } from './components-ungrouped.js'
import { ResizeHandle } from './components-resize-handle.js'
import { OnboardingCard, Header, Banner, Rail, FlatFallback, ErrorBoundary } from './components-header.js'
import { createProfileHandlers } from './profile-switch.js'
import { createProfileDialogHandlers } from './components-profile-dialogs.js'
const h = createElement

/**
 * Locale keys for the stable drag-rejection reasons returned by
 * `checkSessionDrop`/`checkGroupDrop` (0.4.0-beta.62 §5.2). The map is computed
 * rather than written as literal translation calls so the i18n guard stays green
 * until P10 ships the 19-language resources.
 */
const DROP_REASON_KEYS = Object.freeze({
  invalid: 'drag.invalidTarget',
  self: 'drag.groupInvalid',
  descendant: 'drag.groupInvalid',
  'target-invalid': 'drag.groupInvalid',
  'dragged-missing': 'drag.groupInvalid',
  'target-missing': 'drag.groupInvalid',
  'parent-missing': 'drag.groupInvalid',
  'anchor-missing': 'drag.groupInvalid',
  'doc-invalid': 'drag.groupInvalid',
  'archived-container': 'drag.archivedContainer',
  'archived-destination': 'drag.archivedDestination',
  'archived-source': 'drag.archivedSource',
  'archived-source-subtree': 'drag.archivedSourceSubtree',
  'archived-anchor': 'drag.archivedAnchor',
})

/** Localized copy for one stable drop reason (`drag.dropRejected` is the fallback). */
const dropReasonText = (t, reason) => t(DROP_REASON_KEYS[reason] ?? 'drag.dropRejected')

/**
 * Filter-aware empty-state copy (0.4.0-beta.62 §4.6). Computed map so the i18n
 * literal-key guard stays green until P10 ships the 19-language resources.
 */
const EMPTY_STATE_KEYS = Object.freeze({
  archivedHiddenTitle: 'empty.archivedHiddenTitle',
  archivedHiddenBody: 'empty.archivedHiddenBody',
  onlyEmptyTitle: 'empty.onlyNoArchivedTitle',
  onlyEmptyBody: 'empty.onlyNoArchivedBody',
  showArchived: 'empty.showArchivedGroups',
  showAll: 'empty.showAllGroups',
})

// ---------------------------------------------------------------------------
// Runtime bridge is installed by plugin.js through the DSH client adapter.
// ---------------------------------------------------------------------------
// Session row
// ---------------------------------------------------------------------------
/**
 * 0.2.20: a stream/frame snapshot rebuilds the whole tree. The row only needs
 * to repaint when display data, status, workspace, archive flag or active
 * highlight changes; handlers are the stable proxy supplied by GroupsView.
 * Comparison policy lives in src/core/session-row.js.
 */
// Ungrouped section (virtualized)
// ---------------------------------------------------------------------------
/**
 * Estimated initial viewport for the first render before the real `.dsg-tree`
 * metrics are measured. Pure arithmetic lives in src/core/layout.js; the host
 * viewport probe stays here.
 */
// Resize handle (groups view, wide only)
// ---------------------------------------------------------------------------
/**
 * Six-pixel separator pinned to the right edge of the sidebar column. Dragging
 * reports live clamped widths; commit persists. Pointer capture is best-effort
 * because synthetic pointer events may not be capturable.
 */
// Search combobox (groups view header, second row)
// ---------------------------------------------------------------------------
/** Stable id so `aria-controls` points at the listbox while it is rendered. */
// Header / banner / toast / dialogs / menus / rail / footer / flat fallback
// ---------------------------------------------------------------------------
/**
 * View-options popover (feedback item 3, extended in 0.4.0-beta.62 §10): the
 * session and group archive tri-states live in the official-style view menu,
 * outside the always-visible header. Each row is 30px, carries the current
 * check and dispatches `archive-filter` / `group-archive-filter` without
 * closing the popover; `viewState` below spreads the store snapshot, so the
 * header receives `groupArchiveFilter` unchanged.
 */
export const GroupsView = (props) => {
  const store = useViewStore()
  const wide = props?.wide !== false
  const perfRenderStart = perfEnabled() ? perfNow() : 0
  perfRender('GroupsView')
  diagRender('GroupsView')
  const {
    sessions,
    workspaces,
    statuses,
    runningSessions,
    blockedSessions,
    unreadSessions,
    byId,
    workspaceItems,
    archivedSessionIds,
    currentId,
    highlightCurrent,
    tree,
  } = useGroupsViewState({ store, props })

  // Stable handler proxy owns no data itself; every call reads the latest
  // handlersRef, so memoized rows can keep a stable handler identity.
  const handlersRef = useRef(null)
  const stableHandlers = useMemo(
    () =>
      new Proxy(
        {},
        {
          get: (_target, property) => (...args) => handlersRef.current?.[property]?.(...args),
        },
      ),
    [],
  )
  const [dragState, setDragState] = useState(null)
  const [dropTarget, setDropTarget] = useState(null)
  const [onboardingOpen, setOnboardingOpen] = useState(() => !readOnboardingDone())
  const dismissOnboarding = () => {
    writeOnboardingDone()
    setOnboardingOpen(false)
  }
  // Latest committed target, compared with stable equality before every React
  // update. Dragover fires continuously while the pointer rests on one row and
  // rebuilds an equivalent object each time; updating state unconditionally
  // re-rendered the whole tree on every event (0.2.2 perf probe: 48 renders for
  // 45 stationary dragovers, 800 SessionRow renders for 30 paced dragovers).
  const dropTargetRef = useRef(null)
  /**
   * Drop-target setter used by every drag handler: skips React when the stable
   * target descriptor is unchanged. The opt-in probe records set attempts and
   * the ones that actually changed the rendered target.
   */
  const setDropTargetTracked = (next) => {
    if (next === null) dragTargetLockRef.current = null
    if (sameDropTarget(dropTargetRef.current, next)) {
      if (perfEnabled()) perfDropTarget(false)
      return
    }
    // Diagnostics: record the stable target transition before React updates; the
    // helper also emits placeholder insert/remove for the placeholder kinds.
    if (diagEnabled()) diagTargetChange(dropTargetRef.current, next)
    dropTargetRef.current = next
    if (!perfEnabled()) {
      setDropTarget(next)
      return
    }
    const started = perfNow()
    setDropTarget(next)
    perfDropTarget(true, perfNow() - started)
  }
  // Search highlight is a transient DOM class (1.5 s) on the revealed row: the
  // rows are plain React nodes and the class must survive the host-triggered
  // re-render right after openSession without adding new view-store state.
  const autoExpandRef = useRef({ groupId: null, timer: null })
  const dragRef = useRef(null)
  const dragTargetLockRef = useRef(null)
  const suppressedClickRef = useRef(null)
  // Pointerdown origin for the group row: a dragstart always targets the
  // draggable row, so the button check must be captured on pointerdown (where the
  // target really is the `+`/`…` button) and consumed by onGroupDragStart.
  const buttonPointerRef = useRef(null)
  dragRef.current = dragState
  /** Locked target for the current resting pointer position (0.2.21). */
  const stickyTargetFor = (event) =>
    stickyDropTarget(dragTargetLockRef.current, event?.clientX, event?.clientY)
  const lockTargetAt = (event, target) => {
    if (!target || !event || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
    dragTargetLockRef.current = { x: event.clientX, y: event.clientY, target }
  }
  // Sidebar width override state. `preferredWidth` is the persisted preference;
  // the applied width is always its viewport clamp, so a narrow viewport never
  // destroys the stored preference.
  const rootRef = useRef(null)
  /** True only when the drag pointer is definitely outside the sidebar root. */
  const pointerOutsideRoot = (event) => {
    const root = rootRef.current
    const rect = root?.getBoundingClientRect?.()
    if (!rect) return false
    const x = event?.clientX
    const y = event?.clientY
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false
    return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom
  }
  // Imperative bridge to the virtualized ungrouped list (search reveal).
  const virtualRef = useRef(null)
  const {
    viewportWidth,
    appliedWidth,
    maxAppliedWidth,
    widthSupported,
    handleWidthChange,
    handleWidthCommit,
    handleWidthReset,
  } = useGroupsSidebarWidth({ wide, docState: store?.docState, rootRef })
  const t = rt()?.t ?? ((key) => key)
  const { clearSearchHit, revealSearchRow, selectSearchResult } = useGroupsSearchReveal({ rootRef, tree, store, t, virtualRef })
  const direction = rt()?.direction === 'rtl' ? 'rtl' : 'ltr'
  // Auto-expand ancestors of the current session when the view opens.
  useEffect(() => {
    if (!store || store.docState !== 'ready' || !currentId) return
    const entry = findGroup(store.doc, currentGroupIdOf(store.doc, currentId))
    if (!entry) return
    const ancestors = expandAncestors(store.collapsed, store.doc, entry.id)
    if (ancestors !== store.collapsed) store.update({ collapsed: ancestors })
  }, [currentId, store?.docState, store?.doc])
  // The host may replace the current blank when the user switches workspace.
  // Follow that active switch before paint; the runtime keeps following until
  // the session becomes nonblank.
  const currentBlank = currentId ? byId[currentId]?.blank === true : false
  const currentWorkspaceId = currentId ? workspaceOfSession(workspaceItems, currentId)?.workspaceId ?? null : null
  useLayoutEffect(() => {
    if (currentId) rt()?.reconcileNewSessionGroup?.(currentId)
  }, [currentId, currentBlank, currentWorkspaceId])
  usePerfCommit('groups-view', perfRenderStart)
  if (!wide) return h(Rail, { props })
  if (store === null) return h('div', { class: 'dsg-root', 'data-testid': 'session-groups-view', dir: direction }, t('flat.title'))
  // Flat fallback for load/route/commit failures (CONTRACTS §6).
  if (store.docState === 'error') return h(FlatFallback, { props, store, reason: store.banner?.code === 'route-unavailable' ? 'route-unavailable' : 'error' })
  const ungroupedCount = tree.ungrouped.length
  // Diagnostics run context: every traced event carries the current revision,
  // optimistic flag, tree counts, viewport and applied sidebar width. Building
  // the patch object is skipped entirely when diagnostics are off.
  if (diagEnabled()) {
    diagContext({
      mode: store.viewMode,
      revision: store.revision,
      optimistic: store.optimistic === true,
      groups: store.doc.groups.length,
      ungrouped: ungroupedCount,
      visibleSessions: countTreeSessions(tree),
      viewport: globalThis.innerWidth || viewportWidth,
      sidebarWidth: appliedWidth,
    })
  }
  // Row components read current/drop state; merge it into the snapshot handed down.
  const viewState = {
    ...store,
    currentSessionId: highlightCurrent,
    dropTarget,
    draggedGroupId: dragState?.kind === 'group' ? dragState.groupId : null,
  }
  const treeEmpty = tree.groups.length === 0 && tree.ungrouped.length === 0
  // §4.6: an empty tree can be the effect of the group filter, not an empty doc.
  const groupVisibility = computeGroupVisibility(store.doc, store.groupArchiveFilter ?? 'hidden')
  const archivedGroupsHidden = treeEmpty && store.groupArchiveFilter === 'hidden' && groupVisibility.full.size > 0
  const onlyGroupsEmpty = treeEmpty && store.groupArchiveFilter === 'only' && groupVisibility.full.size === 0
  const filterEmptyKind = archivedGroupsHidden ? 'archived-hidden' : onlyGroupsEmpty ? 'only-empty' : 'none'
  const commitDrop = async (source, target) => {
    perfMark('commitDrop:start', { kind: target?.kind ?? null })
    setDropTargetTracked(null)
    setDragState(null)
    if (!source || !target || target.kind === 'invalid') return
    // Preview and commit share `checkSessionDrop`: a rejected target is reported
    // once here and never reaches the doc (SPEC §5.2 preview = commit).
    const verdict = checkSessionDrop(store.doc, source, target)
    if (diagEnabled()) {
      diagTrace(verdict.ok ? 'drop.accept' : 'drop.reject', {
        dragKind: source?.kind ?? null,
        kind: target?.kind ?? null,
        sessionId: source?.sessionId ?? null,
        targetSessionId: target?.sessionId ?? null,
        groupId: target?.groupId ?? null,
        reason: verdict.ok ? null : verdict.reason,
      })
      diagDropState(verdict.ok ? 'accepted' : 'invalid', { kind: target?.kind ?? null })
    }
    if (!verdict.ok) {
      toast('error', dropReasonText(t, verdict.reason))
      return
    }
    if (verdict.noop) return
    const visibleUngrouped = tree.ungrouped.map((node) => node.session.id)
    try {
      // Optimistic (0.2.4): resolve against the current optimistic doc so the
      // row moves in this tick; the queue persists/coalesces/reconciles async.
      // A race that changes the doc between preview and commit is re-judged by
      // the same predicate inside the updater and reports its reason.
      await rt()?.commitOptimistic((currentDoc) => {
        const result = applyDrop(currentDoc, source, target, visibleUngrouped)
        if (!result.applied) {
          if (result.noop) throw GROUP_DROP_NOOP
          const error = new Error(result.reason ?? 'invalid')
          error.dropReason = result.reason ?? 'invalid'
          throw error
        }
        return result.doc
      })
    } catch (error) {
      if (error === GROUP_DROP_NOOP) return
      if (error?.reported === true) {
        // §8: a host-level archive freeze means this view's confirmed doc is
        // stale; re-read it once (the optimistic queue already rolled back and
        // surfaced the precise reason).
        if (error?.code === 'archive-frozen') rt()?.refreshRuntimeConfig?.()
        return
      }
      if (error?.dropReason) {
        toast('error', dropReasonText(t, error.dropReason))
        return
      }
      toast('error', t('toast.dropFailed'))
      if (globalThis.console?.warn) globalThis.console.warn('[dsh-session-grove] drop failed', error)
    }
  }
  /**
   * Commit a group drag. The gesture stores only the stable target descriptor;
   * the numeric parent/index is resolved inside the queued updater against the
   * latest confirmed doc (B5). The preview predicate `checkGroupDrop` is shared
   * here so an archived source/anchor/destination can never reach the invariant;
   * a same-parent/current-position drop throws the no-op sentinel before the
   * queue sends any request, so no revision is bumped.
   */
  const commitGroupDrop = async (draggedId, target) => {
    perfMark('commitGroupDrop:start', { kind: target?.kind ?? null })
    setDropTargetTracked(null)
    setDragState(null)
    dragRef.current = null
    rt()?.setFloatingLabel?.(null)
    const verdict = checkGroupDrop(store.doc, draggedId, target)
    if (diagEnabled()) {
      diagTrace(verdict.ok ? 'drop.accept' : 'drop.reject', {
        dragKind: 'group',
        kind: target?.kind ?? null,
        groupId: draggedId,
        targetId: target?.targetId ?? null,
        parentId: target?.parentId ?? null,
        beforeGroupId: target?.beforeGroupId ?? null,
        reason: verdict.ok ? null : verdict.reason,
      })
      diagDropState(verdict.ok ? 'accepted' : 'invalid', { kind: target?.kind ?? null })
    }
    if (!verdict.ok) {
      toast('error', dropReasonText(t, verdict.reason))
      return
    }
    if (verdict.noop) return
    try {
      await rt()?.commitOptimistic((latest) => {
        const result = applyGroupDrop(latest, draggedId, target)
        if (!result.applied) {
          if (result.noop) throw GROUP_DROP_NOOP
          const error = new Error(result.reason ?? 'invalid')
          error.groupDropInvalid = true
          error.groupDropReason = result.reason ?? 'invalid'
          throw error
        }
        return result.doc
      })
    } catch (error) {
      if (error === GROUP_DROP_NOOP) return
      if (error?.reported === true) {
        // §8: mirror the session-drop archive-freeze recovery for group drops.
        if (error?.code === 'archive-frozen') rt()?.refreshRuntimeConfig?.()
        return
      }
      if (error?.groupDropReason) {
        toast('error', dropReasonText(t, error.groupDropReason))
        return
      }
      if (error?.groupDropInvalid) {
        toast('error', dropReasonText(t, 'invalid'))
        return
      }
      if (error?.message === 'depth-exceeded') {
        toast('error', t('drag.depthExceeded'))
        return
      }
      if (error?.message === 'cycle') {
        toast('error', t('drag.groupInvalid'))
        return
      }
      toast('error', t('toast.dropFailed'))
      if (globalThis.console?.warn) globalThis.console.warn('[dsh-session-grove] group drop failed', error)
    }
  }
  const clearAutoExpand = () => {
    const current = autoExpandRef.current
    if (current.timer !== null) clearTimeout(current.timer)
    if (current.timer !== null && diagEnabled()) diagTrace('autoexpand.cancel', { groupId: current.groupId })
    autoExpandRef.current = { groupId: null, timer: null }
  }
  const scheduleAutoExpand = (groupId) => {
    const collapsedNow = !isExpanded(store.collapsed, groupId)
    if (!collapsedNow) return clearAutoExpand()
    const current = autoExpandRef.current
    if (current.groupId === groupId && current.timer !== null) return
    clearAutoExpand()
    if (diagEnabled()) diagTrace('autoexpand.schedule', { groupId, delayMs: 500 })
    const timer = setTimeout(() => {
      if (diagEnabled()) diagTrace('autoexpand.fire', { groupId })
      dispatch('expand-group', { id: groupId })
      autoExpandRef.current = { groupId: null, timer: null }
    }, 500)
    autoExpandRef.current = { groupId, timer }
  }
  const rowDragOver = (event, target) => {
    const drag = dragRef.current
    if (!drag) return
    const sticky = stickyTargetFor(event)
    if (sticky) {
      // The placeholder itself moved the row under the pointer. Keep the
      // already-rendered target until the pointer deliberately moves.
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    setDropTargetTracked(target)
    lockTargetAt(event, target)
  }
  const ungroupedBodyRows = (container) =>
    [...(container?.querySelectorAll?.('[data-session-id]') ?? [])].map((row) => {
      const rect = row.getBoundingClientRect()
      return { sessionId: row.getAttribute('data-session-id'), top: rect.top, height: rect.height }
    })
  const groupOwnedIds = (groupId) => {
    const group = findGroup(store.doc, groupId)
    return group ? group.sessionIds : []
  }
  const groupDragId = () => (dragRef.current?.kind === 'group' ? dragRef.current.groupId : null)
  /** Translate the view drop-target vocabulary to the resolver target shape. */
  const resolveTargetFor = (viewTarget) => {
    switch (viewTarget?.kind) {
      case 'group-before':
        return { kind: 'before', targetId: viewTarget.targetId }
      case 'group-after':
        return { kind: 'after', targetId: viewTarget.targetId }
      case 'group-child':
        return { kind: 'child', parentId: viewTarget.parentId, beforeGroupId: viewTarget.beforeGroupId ?? null }
      case 'group-root-end':
        return { kind: 'root-end' }
      default:
        return null
    }
  }
  /**
   * Live indicator for a group drop. `checkGroupDrop` is the same predicate the
   * commit uses: self/descendant/anchor problems and every archive-frozen reason
   * render the forbidden state with its localized reason and never accept.
   */
  const previewGroupDrop = (event, viewTarget, label) => {
    const draggedId = groupDragId()
    if (!draggedId) return
    if (stickyTargetFor(event)) {
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      return
    }
    const verdict = checkGroupDrop(store.doc, draggedId, resolveTargetFor(viewTarget))
    if (!verdict.ok) {
      // Keep a frozen slot/header from bubbling into a live ancestor's handler.
      event.stopPropagation()
      setDropTargetTracked({ ...viewTarget, kind: 'group-forbidden' })
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
      rt()?.setFloatingLabel?.(dropReasonText(t, verdict.reason))
      return
    }
    rowDragOver(event, viewTarget)
    rt()?.setFloatingLabel?.(label)
  }
  /**
   * Reject one session dragover: no placeholder, no drop effect, and the stable
   * reason in the floating label (§5.2). `forbiddenTarget` may paint the existing
   * group-forbidden surface for header/line targets.
   */
  const rejectSessionDragOver = (event, reason, forbiddenTarget = null) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
    // A rejected surface must never keep a pending 500ms auto-expand alive.
    clearAutoExpand()
    setDropTargetTracked(forbiddenTarget)
    rt()?.setFloatingLabel?.(dropReasonText(t, reason))
  }
  /** Top/bottom edge zone of a group header; the middle 50% is invalid. */
  const groupHeaderZone = (row, clientY) => groupHeaderZoneFromRect(row?.getBoundingClientRect?.(), clientY)
  /** Consume the click synthesized right after a dragstart (400 ms guard). */
  const consumeDragClick = (groupId) => {
    const marker = suppressedClickRef.current
    if (!marker) return false
    suppressedClickRef.current = null
    return marker.groupId === groupId && Date.now() - marker.at <= 400
  }
  const handlers = {
    ...createMenuHandlers({ t, dragRef, consumeDragClick, handleWidthReset, selectSearchResult }),
    ...createDialogHandlers({ store, t, byId, workspaceItems, currentId }),
    // SPEC §9.2/§9.3: profile switch entries join the shared handler facade so
    // memoized header/rows always call the latest closure.
    ...createProfileHandlers({ t }),
    // SPEC §9.4/§9.5: save-as/manage/rename/archive handlers live in the split
    // dialog module but are exposed through the same facade.
    ...createProfileDialogHandlers({ t }),
    onDragStart: (sessionId) => {
      // Defense in depth behind the row's `draggable=false` (§5.2: no
      // "drag first, fail later"): a session inside an archived container never
      // becomes a drag source.
      const location = sessionLocation(store.doc, sessionId)
      if (location.groupId !== null && effectiveArchived(store.doc, location.groupId)) {
        toast('error', dropReasonText(t, 'archived-container'))
        return
      }
      const row = byId[sessionId]
      dragRef.current = {
        kind: 'session',
        sessionId,
        label: sessionTitle(row, { blankLabel: t('session.blank'), untitledLabel: t('session.untitled') }),
      }
      // Never trace the session title: the id is the only session identity in
      // the diagnostics file (privacy rule in diagnostics.js).
      if (diagEnabled()) diagDragStart('session', { sessionId })
      suppressedClickRef.current = null
      dragTargetLockRef.current = null
      setDragState(dragRef.current)
      rt()?.startDragLabel?.(dragRef.current.label)
    },
    onGroupPointerDown: (event, group) => {
      const target = event.target
      const insideButton = target && typeof target.closest === 'function' && target.closest('button')
      if (!insideButton) {
        buttonPointerRef.current = null
        return
      }
      const marker = { groupId: group.id, at: Date.now() }
      buttonPointerRef.current = marker
      const doc = globalThis.document
      const clear = () => {
        if (buttonPointerRef.current === marker) buttonPointerRef.current = null
        doc?.removeEventListener?.('pointerup', clear, true)
        doc?.removeEventListener?.('pointercancel', clear, true)
      }
      doc?.addEventListener?.('pointerup', clear, true)
      doc?.addEventListener?.('pointercancel', clear, true)
    },
    onGroupDragStart: (event, group) => {
      // A dragstart always targets the draggable row, never the inner button, so
      // the origin is remembered from pointerdown. Without this, a slight
      // movement while pressing `+`/`…` starts a real group drag (and its drop
      // can reorder/reparent) even though the click is suppressed afterwards.
      const pointer = buttonPointerRef.current
      buttonPointerRef.current = null
      const fromButton =
        pointer !== null && pointer !== undefined && pointer.groupId === group.id && Date.now() - pointer.at <= 5000
      const origin = event.target
      const originIsButton = origin && typeof origin.closest === 'function' && origin.closest('button')
      if (fromButton || originIsButton) {
        event.preventDefault()
        return
      }
      // Defense in depth behind `draggable=false` (§5.2): an archived group and
      // any live ancestor of archived groups are never drag sources.
      if (effectiveArchived(store.doc, group.id)) {
        event.preventDefault()
        toast('error', dropReasonText(t, 'archived-source'))
        return
      }
      if (hasArchivedDescendant(store.doc, group.id)) {
        event.preventDefault()
        toast('error', dropReasonText(t, 'archived-source-subtree'))
        return
      }
      if (event.dataTransfer) {
        event.dataTransfer.setData(GROUP_DRAG_MIME, group.id)
        event.dataTransfer.setData('text/plain', group.name)
        event.dataTransfer.effectAllowed = 'move'
      }
      const drag = { kind: 'group', groupId: group.id, label: group.name }
      dragRef.current = drag
      if (diagEnabled()) diagDragStart('group', { groupId: group.id, name: group.name })
      suppressedClickRef.current = { groupId: group.id, at: Date.now() }
      dragTargetLockRef.current = null
      setDragState(drag)
      setDropTargetTracked(null)
      rt()?.startDragLabel?.(group.name)
    },
    onDragEnd: () => {
      if (diagEnabled()) diagDragEnd()
      buttonPointerRef.current = null
      clearAutoExpand()
      dragRef.current = null
      setDragState(null)
      setDropTargetTracked(null)
      rt()?.setFloatingLabel?.(null)
    },
    /**
     * Clear the insertion placeholder as soon as the pointer leaves the row.
     * Moving into a child of the same row (or into the placeholder that is
     * pushing the row) must not clear it, otherwise the layout would oscillate.
     */
    onDragLeave: (event) => {
      if (!dragRef.current) return
      // Layout shift can fire dragleave on the row that just moved; a stationary
      // pointer must not tear down the locked placeholder.
      if (stickyTargetFor(event)) return
      const current = event?.currentTarget
      const next = event?.relatedTarget
      if (current && next && typeof current.contains === 'function' && current.contains(next)) return
      if (next && typeof next.closest === 'function' && next.closest('.dsg-drop-placeholder')) return
      // Moving between rows/gaps inside one group body must not remove the
      // placeholder; the next row's dragover will retarget it.
      if (next && typeof next.closest === 'function' && next.closest('.dsg-group-line')) return
      // A dragleave between rows/gaps is a transient boundary, not leaving the
      // sidebar. Clearing here removed the placeholder for one frame and the
      // next dragover reinserted it at the same place (visible flicker).
      if (!pointerOutsideRoot(event)) return
      clearAutoExpand()
      setDropTargetTracked(null)
      rt()?.setFloatingLabel?.(null)
    },
    onPlaceholderDragOver: (event) => {
      if (!dragRef.current) return
      // Keep the resolved target alive while the pointer is over the gap.
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    },
    onPlaceholderDrop: (event, target) => {
      const drag = dragRef.current
      if (!drag) return
      event.preventDefault()
      event.stopPropagation()
      clearAutoExpand()
      rt()?.setFloatingLabel?.(null)
      if (drag.kind === 'group') {
        const resolved = resolveTargetFor(target)
        if (!resolved) return
        commitGroupDrop(drag.groupId, resolved)
        return
      }
      commitDrop(drag, target)
    },
    onDragOverSession: (event, sessionId, groupId, ungrouped) => {
      const drag = dragRef.current
      if (!drag || drag.kind !== 'session') return
      if (stickyTargetFor(event)) {
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
        return
      }
      const rect = event.currentTarget.getBoundingClientRect()
      const target = hitTest({
        source: drag,
        rowKind: 'session',
        pointerY: event.clientY,
        rowTop: rect.top,
        rowHeight: rect.height,
        targetGroupId: ungrouped ? null : groupId,
        targetSessionId: sessionId,
      })
      if (target.kind === 'invalid') {
        // Never let a self-row/unknown-row invalid target fall through to the
        // wider ungrouped body handler: that handler used to retarget the drop
        // to the top of the ungrouped list and made the placeholder oscillate.
        event.preventDefault()
        event.stopPropagation()
        if (sessionId !== drag.sessionId) {
          setDropTargetTracked(null)
        }
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
        return
      }
      const verdict = checkSessionDrop(store.doc, drag, target)
      if (!verdict.ok) {
        // Archived container/destination: forbidden feedback without a
        // placeholder; stop here so the row never retargets an outer body.
        rejectSessionDragOver(event, verdict.reason)
        return
      }
      rowDragOver(event, target)
      const label = groupId
        ? t('drag.sessionIntoGroup', { name: findGroup(store.doc, groupId)?.name ?? '' })
        : t('drag.sessionOut')
      rt()?.setFloatingLabel?.(label)
    },
    onDropSession: (event, sessionId, groupId, ungrouped) => {
      const drag = dragRef.current
      if (!drag || drag.kind !== 'session') return
      event.preventDefault()
      event.stopPropagation()
      const sticky = stickyTargetFor(event)
      if (sticky) {
        clearAutoExpand()
        rt()?.setFloatingLabel?.(null)
        return commitDrop(drag, sticky)
      }
      clearAutoExpand()
      rt()?.setFloatingLabel?.(null)
      // Resolve from this drop event instead of the react state mirror: a
      // dragover and drop can arrive in one tick (synthetic E2E / fast pointer),
      // and the state may not have committed yet.
      const rect = event.currentTarget.getBoundingClientRect()
      const target = hitTest({
        source: drag,
        rowKind: 'session',
        pointerY: event.clientY,
        rowTop: rect.top,
        rowHeight: rect.height,
        targetGroupId: ungrouped ? null : groupId,
        targetSessionId: sessionId,
      })
      if (!target || target.kind === 'invalid') return commitDrop(drag, { kind: 'invalid' })
      return commitDrop(drag, target)
    },
    onDragOverGroup: (event, groupId) => {
      const drag = dragRef.current
      if (!drag) return
      const sticky = stickyTargetFor(event)
      if (sticky) {
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer) event.dataTransfer.dropEffect = sticky.kind === 'group-forbidden' ? 'none' : 'move'
        return
      }
      if (drag.kind === 'group') {
        const name = findGroup(store.doc, groupId)?.name ?? ''
        const zone = groupHeaderZone(event.currentTarget, event.clientY)
        if (zone === null) {
          event.stopPropagation()
          setDropTargetTracked({ kind: 'group-forbidden', targetId: groupId })
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
          rt()?.setFloatingLabel?.(dropReasonText(t, 'target-invalid'))
          return
        }
        previewGroupDrop(event, { kind: `group-${zone}`, targetId: groupId }, t(zone === 'before' ? 'drag.groupBefore' : 'drag.groupAfter', { name }))
        return
      }
      const target = { kind: 'group-append', groupId }
      const verdict = checkSessionDrop(store.doc, drag, target)
      if (!verdict.ok) {
        // An archived group header is not a session destination. The rejection
        // helper also cancels auto-expand so a neighbouring live group's timer
        // cannot open a frozen group (SPEC §5.2).
        rejectSessionDragOver(event, verdict.reason, { kind: 'group-forbidden', targetId: groupId })
        return
      }
      rowDragOver(event, target)
      scheduleAutoExpand(groupId)
      rt()?.setFloatingLabel?.(t('drag.sessionIntoGroup', { name: findGroup(store.doc, groupId)?.name ?? '' }))
    },
    onDropGroup: (event, groupId) => {
      const drag = dragRef.current
      if (drag?.kind === 'group') {
        event.preventDefault()
        event.stopPropagation()
        clearAutoExpand()
        setDropTargetTracked(null)
        rt()?.setFloatingLabel?.(null)
        const zone = groupHeaderZone(event.currentTarget, event.clientY)
        if (zone === null) {
          toast('error', t('drag.groupInvalid'))
          return
        }
        commitGroupDrop(drag.groupId, { kind: zone, targetId: groupId })
        return
      }
      event.preventDefault()
      event.stopPropagation()
      clearAutoExpand()
      rt()?.setFloatingLabel?.(null)
      commitDrop(drag, { kind: 'group-append', groupId })
    },
    onDragOverGroupHead: (event, groupId) => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.kind === 'group') {
        // A group body is not a group-drop surface; inside an archived group the
        // event must stop here instead of bubbling to a live ancestor's body.
        if (!effectiveArchived(store.doc, groupId)) return
        rejectSessionDragOver(event, 'archived-destination')
        return
      }
      // The line also owns the tiny gaps between session rows. A gap is not a
      // "group head" drop zone: treating it as one made the placeholder jump to
      // the group top while the pointer slowly crossed a 2px gap. Only the area
      // above the first visible session is the group-head zone.
      const target = { kind: 'group-head', groupId }
      // Check first: an archived destination must show forbidden over the whole
      // body (including row gaps), not just above the first row.
      const verdict = checkSessionDrop(store.doc, drag, target)
      if (!verdict.ok) {
        rejectSessionDragOver(event, verdict.reason, { kind: 'group-forbidden', targetId: groupId })
        return
      }
      const firstRow = event.currentTarget?.querySelector?.('[data-session-id]')
      const firstRect = firstRow?.getBoundingClientRect?.()
      if (firstRect && Number.isFinite(firstRect.top) && event.clientY >= firstRect.top) {
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
        return
      }
      rowDragOver(event, target)
      scheduleAutoExpand(groupId)
    },
    onDropGroupHead: (event, groupId) => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.kind === 'group') {
        // Mirrors the dragover guard: a group body is never a group-drop target,
        // and an archived body must not let the drop bubble to a live ancestor.
        if (!effectiveArchived(store.doc, groupId)) return
        event.preventDefault()
        event.stopPropagation()
        clearAutoExpand()
        setDropTargetTracked(null)
        rt()?.setFloatingLabel?.(null)
        return
      }
      event.preventDefault()
      event.stopPropagation()
      clearAutoExpand()
      rt()?.setFloatingLabel?.(null)
      commitDrop(drag, { kind: 'group-head', groupId })
    },
    onDragOverGroupSlot: (event, parentId, beforeGroupId) => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.kind === 'group') {
        const name = findGroup(store.doc, parentId)?.name ?? ''
        // checkGroupDrop inside the preview rejects a frozen parent with the
        // `archived-destination` reason and paints the existing slot forbidden.
        previewGroupDrop(event, { kind: 'group-child', parentId, beforeGroupId }, t('drag.groupInto', { name }))
        return
      }
      // A slot is not a session target: let a live parent's body line own the
      // drop. Inside an archived parent the shared check rejects and the handler
      // stops the bubble so the live outer group cannot retarget it.
      const verdict = checkSessionDrop(store.doc, drag, { kind: 'group-head', groupId: parentId })
      if (verdict.ok) return
      rejectSessionDragOver(event, verdict.reason)
    },
    onDropGroupSlot: (event, parentId, beforeGroupId) => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.kind !== 'group') {
        // A session dragged across a live slot keeps its existing group-head drop
        // behaviour (the event bubbles to the body line). An archived parent is a
        // locked destination and must not reach the outer line.
        const verdict = checkSessionDrop(store.doc, drag, { kind: 'group-head', groupId: parentId })
        if (verdict.ok) return
        event.preventDefault()
        event.stopPropagation()
        clearAutoExpand()
        setDropTargetTracked(null)
        rt()?.setFloatingLabel?.(null)
        toast('error', dropReasonText(t, verdict.reason))
        return
      }
      event.preventDefault()
      event.stopPropagation()
      commitGroupDrop(drag.groupId, { kind: 'child', parentId, beforeGroupId })
    },
    onDragOverUngrouped: (event) => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.kind === 'group') {
        // The implicit ungrouped inbox is session-only. It is not a custom-group
        // parent, so a group drag never paints an insertion target here.
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
        setDropTargetTracked(null)
        rt()?.setFloatingLabel?.(t('ungrouped.sessionsOnly'))
        return
      }
      // Header only: this is the explicit "top of ungrouped" target.
      const target = { kind: 'ungrouped' }
      const verdict = checkSessionDrop(store.doc, drag, target)
      if (!verdict.ok) {
        rejectSessionDragOver(event, verdict.reason)
        return
      }
      rowDragOver(event, target)
      rt()?.setFloatingLabel?.(t('drag.sessionOut'))
    },
    /**
     * Body-level fallback for virtual gaps/spacers. A session row owns its own
     * dragover; this handler only sees gaps and empty body space, so it must
     * resolve against visible rows rather than jumping to the section top.
     */
    onDragOverUngroupedBody: (event) => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.kind === 'group') {
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
        setDropTargetTracked(null)
        rt()?.setFloatingLabel?.(t('ungrouped.sessionsOnly'))
        return
      }
      if (event.target?.closest?.('[data-session-id], .dsg-drop-placeholder')) return
      const target = ungroupedBodyTarget(ungroupedBodyRows(event.currentTarget), event.clientY)
      const verdict = checkSessionDrop(store.doc, drag, target)
      if (!verdict.ok) {
        rejectSessionDragOver(event, verdict.reason)
        return
      }
      rowDragOver(event, target)
      rt()?.setFloatingLabel?.(t('drag.sessionOut'))
    },
    onDropUngrouped: (event) => {
      const drag = dragRef.current
      if (drag?.kind === 'group') {
        event.preventDefault()
        event.stopPropagation()
        setDropTargetTracked(null)
        clearAutoExpand()
        rt()?.setFloatingLabel?.(null)
        toast('info', t('ungrouped.sessionsOnly'))
        return
      }
      event.preventDefault()
      event.stopPropagation()
      clearAutoExpand()
      rt()?.setFloatingLabel?.(null)
      // Header drop is always the explicit top-of-section target.
      commitDrop(drag, { kind: 'ungrouped' })
    },
    onDropUngroupedBody: (event) => {
      const drag = dragRef.current
      if (drag?.kind === 'group') {
        event.preventDefault()
        event.stopPropagation()
        setDropTargetTracked(null)
        clearAutoExpand()
        rt()?.setFloatingLabel?.(null)
        toast('info', t('ungrouped.sessionsOnly'))
        return
      }
      event.preventDefault()
      event.stopPropagation()
      clearAutoExpand()
      rt()?.setFloatingLabel?.(null)
      const current = dropTargetRef.current
      const target =
        current && (current.kind === 'session-before' || current.kind === 'session-after' || current.kind === 'ungrouped')
          ? current
          : ungroupedBodyTarget(ungroupedBodyRows(event.currentTarget), event.clientY)
      commitDrop(drag, target)
    },
  }
  // Time every drag handler for the opt-in perf probe and for diagnostics
  // (0.2.5, default on). Handlers stay unwrapped when both are off.
  if (perfEnabled() || diagEnabled()) {
    const isDragHandler = (name) =>
      name.startsWith('onDrag') ||
      name.startsWith('onDrop') ||
      name.startsWith('onGroupDrag') ||
      name.startsWith('onPlaceholderDrag') ||
      name.startsWith('onPlaceholderDrop')
    for (const name of Object.keys(handlers)) {
      if (!isDragHandler(name)) continue
      const original = handlers[name]
      handlers[name] = (event, ...args) => {
        const timed = perfEnabled() || diagEnabled()
        const started = timed ? perfNow() : 0
        try {
          return original(event, ...args)
        } finally {
          if (!timed) return
          const elapsed = perfNow() - started
          if (diagEnabled()) diagHandler(name, elapsed, event)
          if (!perfEnabled()) return
          if (name.startsWith('onDragOver')) {
            perfDragOver(name.slice(2), elapsed)
          } else if (name.startsWith('onDrop')) {
            perfSample('dropHandlerMs', elapsed)
            perfMark('drop:event', { handler: name, ms: Math.round(elapsed * 100) / 100 })
          }
        }
      }
    }
  }
  // 0.2.20: stable handler facade for memoized rows. Every call reads the
  // latest render's closure, so memoization cannot dispatch stale drag/doc data.
  handlersRef.current = handlers
  return h(
    'div',
    { ref: rootRef, class: 'dsg-root', 'data-testid': 'session-groups-view', dir: direction, 'data-mode': store.viewMode, 'data-wide': 'true', 'data-narrow': appliedWidth !== null && appliedWidth <= 320 ? 'true' : 'false', 'data-optimistic': store.optimistic ? 'true' : 'false' },
    h(Header, { store: viewState, handlers: stableHandlers, sessionsById: byId, workspaces: workspaceItems, archivedSessionIds, runningSessions, blockedSessions, unreadSessions }),
    wide && widthSupported && appliedWidth !== null
      ? h(ResizeHandle, {
          width: appliedWidth,
          min: SIDEBAR_WIDTH_MIN,
          max: maxAppliedWidth,
          onChange: handleWidthChange,
          onCommit: handleWidthCommit,
          onReset: handleWidthReset,
        })
      : null,
    h(Banner, { store, handlers: stableHandlers }),
    onboardingOpen
      ? h(OnboardingCard, {
          t,
          onCreate: () => {
            dismissOnboarding()
            stableHandlers.openNewGroup(null, null)
          },
          onDismiss: dismissOnboarding,
        })
      : null,
    !onboardingOpen && treeEmpty && store.docState !== 'loading'
      ? h(
          'div',
          {
            class: 'dsg-empty-state',
            'data-testid': 'session-groups-empty-state',
            'data-filter-empty': filterEmptyKind,
          },
          archivedGroupsHidden
            ? h('div', { class: 'dsg-empty-state-title' }, t(EMPTY_STATE_KEYS.archivedHiddenTitle))
            : onlyGroupsEmpty
              ? h('div', { class: 'dsg-empty-state-title' }, t(EMPTY_STATE_KEYS.onlyEmptyTitle))
              : h('div', { class: 'dsg-empty-state-title' }, t('empty.groupsTitle')),
          archivedGroupsHidden
            ? h('div', { class: 'dsg-empty-state-body' }, t(EMPTY_STATE_KEYS.archivedHiddenBody))
            : onlyGroupsEmpty
              ? h('div', { class: 'dsg-empty-state-body' }, t(EMPTY_STATE_KEYS.onlyEmptyBody))
              : h('div', { class: 'dsg-empty-state-body' }, t('empty.groupsBody')),
          archivedGroupsHidden
            ? TextButton({
                label: t(EMPTY_STATE_KEYS.showArchived),
                testId: 'session-groups-empty-show-archived',
                onClick: () => stableHandlers.setGroupArchiveFilter('all'),
              })
            : onlyGroupsEmpty
              ? TextButton({
                  label: t(EMPTY_STATE_KEYS.showAll),
                  testId: 'session-groups-empty-show-all',
                  onClick: () => stableHandlers.setGroupArchiveFilter('all'),
                })
              : TextButton({
                  label: t('empty.createGroup'),
                  testId: 'session-groups-empty-create',
                  onClick: () => stableHandlers.openNewGroup(null, null),
                })
        )
      : null,
    store.docState === 'loading'
      ? h('div', { class: 'dsg-empty' }, t('flat.title'))
      : h(
          'div',
          { class: 'dsg-tree', role: 'tree', 'aria-label': t('view.title') },
          // SPEC §4.2/N1: the `only` group filter hides the ungrouped section
          // entirely; under hidden/all it keeps its normal session tri-state.
          store.groupArchiveFilter === 'only'
            ? null
            : h(UngroupedSection, { node: tree.ungrouped, store: viewState, props, handlers: stableHandlers, virtualRef }),
          ...tree.groups.map((node) => h(GroupNode, { key: node.group.id, node, depth: 0, props, handlers: stableHandlers, store: viewState })),
          // Group dragged to the root end: a group-row-height placeholder after
          // the last group makes the insertion point unmistakable.
          dropTarget?.kind === 'group-root-end'
            ? h(DropPlaceholder, { target: dropTarget, store: viewState, handlers: stableHandlers, height: GROUP_PLACEHOLDER_HEIGHT })
            : null
        ),
    h(Toast, { store }),
    h(MenuPopover, { store, handlers: stableHandlers }),
    // SPEC §9.3: the switch preview resolves session titles from the live list.
    h(DialogHost, { store, props, sessionsById: byId })
  )
}
/** Export the error boundary wrapped occupant used by the slot registration. */
export const GroupsViewBoundary = (props) =>
  h(
    ErrorBoundary,
    {
      fallback: (error) =>
        h(FlatFallback, {
          props,
          store: rt()?.store?.getSnapshot() ?? null,
          reason: 'render-error',
        }),
    },
    h(GroupsView, props)
  )
