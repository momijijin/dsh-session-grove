/**
 * Profile switch UI (SPEC §9.1-§9.3/§9.6-§9.9, §7.4-§7.5).
 *
 * Owns the header chevron, the profile popover, the switch-preview dialog body
 * and the recovery strip shown when the active profile cannot be loaded. Every
 * HTTP call goes through the runtime bridge (`previewProfile`/`activateProfile`)
 * of the S5 data layer; this module never talks to the host directly.
 *
 * Switch sequence (§7.4): click a target → refuse while a write is pending →
 * fetch the read-only preview → when the documents are structurally identical
 * (or the diff has no rows at all) activate immediately, otherwise open the
 * preview dialog and activate on confirm. A successful switch toasts with a 5s
 * undo action; undo runs preview + activate again without showing the diff.
 */
import { createElement, useEffect, useRef } from 'react'
import { clientRuntime as rt } from '../adapters/client-runtime.js'
import { sessionTitle } from '../core/filter.js'
import { sameDocs } from '../core/profile-diff.js'
import { renderGlyph } from './icons.js'
import { safeStorage } from './state.js'
import { StatusSpinner, TextButton } from './components-primitives.js'

const h = createElement

/** localStorage flag: `'0'` means "switch directly next time" (SPEC §7.6). */
const PROFILE_PREVIEW_KEY = 'dsh-session-grove.profilePreview.v1'

/** Display caps for the preview lists (SPEC §8.5); the diff core is uncapped. */
const MAX_GROUP_ROWS = 100
const MAX_SESSION_ROWS = 300
const MAX_STALE_ROWS = 100

const classNames = (...values) => values.filter(Boolean).join(' ')

const readProfilePreviewDisabled = (storage = safeStorage()) => {
  try {
    return storage?.getItem(PROFILE_PREVIEW_KEY) === '0'
  } catch {
    return false
  }
}

const writeProfilePreviewDisabled = (disabled, storage = safeStorage()) => {
  try {
    if (disabled) storage?.setItem(PROFILE_PREVIEW_KEY, '0')
    else storage?.removeItem(PROFILE_PREVIEW_KEY)
  } catch {
    /* blocked storage keeps the in-memory preference only */
  }
}

// ---------------------------------------------------------------------------
// Store shape helpers
// ---------------------------------------------------------------------------
/**
 * Accept both the live store facade (getSnapshot) and a plain snapshot; when no
 * facade is supplied the runtime bridge owns the live store so guards always see
 * current state (a render snapshot passed by the dialog would go stale between
 * render and a delayed undo click).
 */
const liveStoreFor = (store) => {
  if (typeof store?.getSnapshot === 'function') return store
  if (typeof rt()?.store?.getSnapshot === 'function') return rt().store
  return store ?? rt()?.store ?? null
}

const snapshotOf = (store) => {
  const live = liveStoreFor(store)
  if (typeof live?.getSnapshot === 'function') return live.getSnapshot() ?? {}
  return live ?? {}
}

const activeProfileIdOf = (snapshot) => snapshot?.profiles?.activeId ?? snapshot?.profileId ?? null

const profileNameOf = (snapshot, profileId) => {
  if (typeof profileId !== 'string' || profileId === '') return ''
  const entry = (snapshot?.profiles?.list ?? []).find((profile) => profile?.id === profileId)
  const name = typeof entry?.name === 'string' ? entry.name : ''
  return name !== '' ? name : profileId
}

const profileLabel = (profile) => {
  const name = typeof profile?.name === 'string' ? profile.name : ''
  return name !== '' ? name : typeof profile?.id === 'string' ? profile.id : ''
}

const dispatch = (action, payload) => rt()?.store?.dispatch?.(action, payload)

const notify = (payload) => rt()?.notify?.(payload)

/** Human copy for a failed preview/activate call. */
const profileFailureMessage = (t, code) => {
  if (code === 'preview-stale') return t('profiles.preview.staleRefresh')
  if (
    code === 'profile-unhealthy' ||
    code === 'profile-missing' ||
    code === 'profile-archived' ||
    code === 'registry-unhealthy'
  ) {
    return t('profiles.degraded')
  }
  return t('profiles.saveFailed')
}

/**
 * SPEC §8.5/§7.4: `sameDocs` and the diff summary can disagree on documents that
 * only reorder the flat array while keeping the tree order (WORKLOG S1 carry
 * #1). A preview with no reportable row must switch directly instead of
 * opening an empty dialog.
 */
const isPreviewDiffEmpty = (diff) => {
  if (!diff || typeof diff !== 'object') return true
  const summary = diff.summary ?? {}
  const groups = summary.groups ?? {}
  const grouped = summary.grouped ?? {}
  const ungrouped = summary.ungrouped ?? {}
  const sessions = summary.sessions ?? {}
  if (groups.added || groups.removed || groups.changed) return false
  if (groups.reordered === true) return false
  if ((grouped.current ?? 0) !== (grouped.target ?? 0)) return false
  if ((ungrouped.current ?? 0) !== (ungrouped.target ?? 0)) return false
  if (sessions.moved || sessions.newlyGrouped || sessions.ungrouped || sessions.stale) return false
  return true
}

// ---------------------------------------------------------------------------
// Switch orchestration
// ---------------------------------------------------------------------------
/**
 * Apply the stored preview token. On success the S5 store applies the returned
 * document/revision and every reset in `profile-switch-success` runs; only the
 * user-facing toast (plus its undo action) is added here.
 */
const activatePreviewTarget = async ({ store, t }, preview, { allowUndo = true } = {}) => {
  const targetId = typeof preview?.targetId === 'string' ? preview.targetId : ''
  if (targetId === '' || typeof preview?.previewToken !== 'string' || preview.previewToken === '') {
    notify({ kind: 'error', message: t('profiles.preview.staleRefresh') })
    return { ok: false, code: 'preview-stale' }
  }
  const before = snapshotOf(store)
  const previousId = activeProfileIdOf(before)
  const previousName = profileNameOf(before, previousId)
  const liveStore = liveStoreFor(store)
  const result = await rt()?.activateProfile?.({ id: targetId, previewToken: preview.previewToken })
  if (result?.ok !== true || result?.superseded === true) {
    if (result?.superseded !== true) notify({ kind: 'error', message: profileFailureMessage(t, result?.code) })
    return result
  }
  const switchedId = typeof result.activeId === 'string' && result.activeId !== '' ? result.activeId : targetId
  const name = profileLabel(result.profile) || preview.targetName || switchedId
  const undoable = allowUndo && typeof previousId === 'string' && previousId !== '' && previousId !== switchedId
  notify({
    kind: 'success',
    message: t('profiles.switched', { name }),
    ...(undoable
      ? {
          action: {
            label: t('profiles.undo'),
            duration: 5000,
            onClick: () => {
              void undoProfileSwitch({ store: liveStore, t }, previousId, previousName)
            },
          },
        }
      : {}),
  })
  return result
}

/**
 * Undo: preview + activate the previous profile without showing the diff
 * (SPEC §7.4 step 8). A failed undo keeps the current profile and toasts.
 */
const undoProfileSwitch = async ({ store, t }, previousId, previousName) => {
  if (typeof previousId !== 'string' || previousId === '') return
  const snapshot = snapshotOf(store)
  if (snapshot.profileSwitching === true || snapshot.profilePreview?.loading === true) return
  if (previousId === activeProfileIdOf(snapshot)) return
  if (rt()?.isPending?.() === true) {
    notify({ kind: 'info', message: t('profiles.switching') })
    return
  }
  let preview
  try {
    preview = await rt()?.previewProfile?.(previousId)
  } catch {
    preview = { ok: false, code: 'network' }
  }
  if (preview?.ok !== true) {
    notify({ kind: 'error', message: profileFailureMessage(t, preview?.code) })
    return
  }
  const nextPreview = snapshotOf(store).profilePreview ?? {}
  await activatePreviewTarget(
    { store, t },
    { ...nextPreview, targetName: previousName || nextPreview.targetName },
    { allowUndo: false }
  )
}

/** Recovery entry (§7.3): preview + activate a healthy profile without a dialog. */
const recoverProfile = async ({ store, t }, targetId) => {
  if (typeof targetId !== 'string' || targetId === '') return
  const snapshot = snapshotOf(store)
  if (snapshot.profileSwitching === true || snapshot.profilePreview?.loading === true) return
  if (rt()?.isPending?.() === true) {
    notify({ kind: 'info', message: t('profiles.switching') })
    return
  }
  let preview
  try {
    preview = await rt()?.previewProfile?.(targetId)
  } catch {
    preview = { ok: false, code: 'network' }
  }
  if (preview?.ok !== true) {
    notify({ kind: 'error', message: profileFailureMessage(t, preview?.code) })
    return
  }
  const nextPreview = snapshotOf(store).profilePreview ?? {}
  await activatePreviewTarget({ store, t }, nextPreview, { allowUndo: false })
}

/**
 * SPEC §9.2/§7.4: click one profile row.
 *
 * Guards: a switch already running (`profileSwitching`), a preview already in
 * flight (S5 `previewProfile` has no request sequence), and an unsettled write
 * (`isPending`). Identical content or an empty diff activates immediately.
 */
const beginProfileSwitch = async ({ store, t }, targetId) => {
  if (typeof targetId !== 'string' || targetId === '') return
  const snapshot = snapshotOf(store)
  if (snapshot.profileSwitching === true || snapshot.profilePreview?.loading === true) return
  const activeId = activeProfileIdOf(snapshot)
  if (targetId === activeId) return
  if (rt()?.isPending?.() === true) {
    notify({ kind: 'info', message: t('profiles.switching') })
    return
  }
  const epochAtStart = snapshot.profileEpoch ?? 0
  let result
  try {
    result = await rt()?.previewProfile?.(targetId)
  } catch {
    result = { ok: false, code: 'network' }
  }
  if (result?.ok !== true) {
    notify({ kind: 'error', message: profileFailureMessage(t, result?.code) })
    return
  }
  // S6 review carry #4: the preview window is user think-time. Re-check that no
  // active-profile change (epoch) and no document write landed meanwhile; a
  // stale activation would otherwise fire without any prompt.
  const latest = snapshotOf(store)
  if ((latest.profileEpoch ?? 0) !== epochAtStart || latest.profileSwitching === true) {
    notify({ kind: 'error', message: t('profiles.preview.staleRefresh') })
    return
  }
  if (rt()?.isPending?.() === true) {
    notify({ kind: 'info', message: t('profiles.switching') })
    return
  }
  const preview = latest.profilePreview ?? {}
  const sameContent = preview.doc ? sameDocs(latest.doc, preview.doc) : false
  // §7.6 `profilePreview.v1 === '0'` means "switch directly from now on": the
  // read-only preview is still fetched for its TOCTOU token, but the diff dialog
  // is skipped.
  if (sameContent || isPreviewDiffEmpty(preview.diff) || readProfilePreviewDisabled()) {
    await activatePreviewTarget({ store, t }, preview)
    return
  }
  dispatch('profile-preview-open')
  dispatch('dialog', {
    dialog: {
      kind: 'profile-preview',
      titleKey: 'profiles.previewTitle',
      targetId: preview.targetId,
      targetName: preview.targetName,
    },
  })
}

/** Confirm the open preview (§9.3). Disabled for loading/stale previews. */
const confirmProfilePreview = async ({ store, t }) => {
  const snapshot = snapshotOf(store)
  const preview = snapshot.profilePreview
  if (!preview?.open || preview.loading === true || preview.stale === true) return
  if (snapshot.profileSwitching === true) return
  if (rt()?.isPending?.() === true) {
    notify({ kind: 'info', message: t('profiles.switching') })
    return
  }
  const sameContent = preview.doc ? sameDocs(snapshot.doc, preview.doc) : false
  if (sameContent || isPreviewDiffEmpty(preview.diff)) {
    // The document changed under the preview but the structural diff is still
    // empty: do not keep an empty dialog in front of the user.
    cancelProfilePreview({ store })
    await activatePreviewTarget({ store, t }, preview)
    return
  }
  await activatePreviewTarget({ store, t }, preview)
}

/** Close the preview dialog and clear `profilePreview` (Escape/cancel path). */
const cancelProfilePreview = () => {
  dispatch('dialog', { dialog: null })
  dispatch('profile-preview-close')
}

/** Handlers exposed to the GroupsView handler facade (SPEC plan S6). */
const createProfileHandlers = ({ t }) => ({
  switchProfile: (targetId) => beginProfileSwitch({ t }, targetId),
  confirmProfilePreview: () => confirmProfilePreview({ t }),
  cancelProfilePreview: () => cancelProfilePreview(),
  recoverProfile: (targetId) => recoverProfile({ t }, targetId),
})

// ---------------------------------------------------------------------------
// Header chevron + popover (SPEC §9.1/§9.2)
// ---------------------------------------------------------------------------
/**
 * Chevron trigger inside `span.dsg-header-title`. Opening is controlled by the
 * Header so the view-options/search popovers and this menu stay exclusive; the
 * trigger itself renders only when the host exposes the profile surface (§7.7).
 */
const ProfileMenu = ({ store, handlers, open = false, onOpenChange, onBeforeOpen }) => {
  const t = rt()?.t ?? ((key) => key)
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const available = store?.profiles?.available !== false && store?.profiles !== undefined
  useEffect(() => {
    if (!open) return undefined
    const doc = globalThis.document
    const onPointerDown = (event) => {
      if (rootRef.current?.contains?.(event?.target)) return
      onOpenChange?.(false)
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      onOpenChange?.(false)
      triggerRef.current?.focus?.({ preventScroll: true })
    }
    doc?.addEventListener?.('pointerdown', onPointerDown, true)
    doc?.addEventListener?.('keydown', onKeyDown, true)
    return () => {
      doc?.removeEventListener?.('pointerdown', onPointerDown, true)
      doc?.removeEventListener?.('keydown', onKeyDown, true)
    }
  }, [open, onOpenChange])
  // Refresh the registry list every time the popover opens (SPEC §9.2).
  useEffect(() => {
    if (!open) return
    rt()?.refreshProfiles?.({ background: true })
  }, [open])
  if (!available) return null
  const closePopover = (options = {}) => {
    onOpenChange?.(false)
    if (options.restoreFocus === true) triggerRef.current?.focus?.({ preventScroll: true })
  }
  return h(
    'span',
    { class: 'dsg-profile-menu', ref: rootRef },
    h(
      'button',
      {
        ref: triggerRef,
        type: 'button',
        class: 'dsg-profile-trigger',
        title: t('profiles.open'),
        'aria-label': t('profiles.open'),
        'aria-haspopup': 'menu',
        'aria-expanded': open ? 'true' : 'false',
        'data-testid': 'session-groups-profile-trigger',
        onClick: (event) => {
          event.stopPropagation()
          if (!open) onBeforeOpen?.()
          onOpenChange?.(!open)
        },
      },
      renderGlyph(h, 'chevronDown', 14)
    ),
    open ? h(ProfilePopover, { store, handlers, onClose: closePopover }) : null
  )
}

/** Roving focus through the profile rows (Arrow/Home/End), mirrors the menu. */
const onProfileMenuKeyDown = (event) => {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = Array.from(event.currentTarget?.querySelectorAll?.('button:not([disabled])') ?? [])
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

const profileItemCheck = (active, switchingHere) => {
  if (switchingHere) return h(StatusSpinner)
  return active ? renderGlyph(h, 'check', 14) : null
}

/**
 * Registry-backed list. Rows are `menuitemradio`; the active row gets a check
 * and bold text, every row carries the `N groups · M sessions` second line.
 * Degraded registries show a warning and keep rows visible (default is a no-op).
 */
const ProfilePopover = ({ store, handlers, onClose }) => {
  const t = rt()?.t ?? ((key) => key)
  const profiles = store?.profiles ?? {}
  // SPEC §5.3: the manage dialog's `includeArchived` read may fill the store, but
  // the switcher menu only ever lists unarchived profiles.
  const list = (Array.isArray(profiles.list) ? profiles.list : []).filter(
    (profile) => profile?.archived !== true
  )
  const activeId = profiles.activeId ?? store?.profileId ?? null
  const switching = store?.profileSwitching === true
  const previewLoading = store?.profilePreview?.loading === true
  // SPEC §9.2: rows are disabled while a switch runs or a doc write is pending.
  const pending = rt()?.isPending?.() === true
  const busy = switching || previewLoading || pending
  const switchTarget = switching ? store?.profilePreview?.targetId ?? null : null
  const degraded = profiles.degraded === true
  const error = profiles.error ?? null
  const loading = profiles.loading === true
  const limit = Number.isInteger(profiles.limits?.max) ? profiles.limits.max : 20
  const atLimit = list.length >= limit
  // A degraded registry or an explicit `registry-unhealthy` error disables every
  // profile write (SPEC §9.2/§10); reads still render.
  const registryUnhealthy = degraded || profiles.error?.code === 'registry-unhealthy'
  const footerDisabled = registryUnhealthy || busy || profiles.available === false
  const children = []
  if (degraded) {
    children.push(
      h(
        'div',
        { key: 'degraded', class: 'dsg-profile-warning', role: 'note', 'data-testid': 'session-groups-profile-degraded' },
        t('profiles.degraded')
      )
    )
  }
  if (error) {
    children.push(
      h(
        'div',
        { key: 'error', class: 'dsg-profile-error', role: 'note', 'data-testid': 'session-groups-profile-error' },
        t('profiles.saveFailed')
      )
    )
  }
  if (list.length === 0) {
    children.push(
      h(
        'div',
        {
          key: 'empty',
          class: 'dsg-profile-empty',
          'data-testid': loading ? 'session-groups-profile-loading' : 'session-groups-profile-empty',
          'data-loading': loading ? 'true' : 'false',
          'aria-live': 'polite',
        },
        loading ? h(StatusSpinner) : t('profiles.empty')
      )
    )
  } else {
    for (const profile of list) {
      const active = profile?.id === activeId
      const unhealthy = profile?.healthy === false
      const disabled = busy || unhealthy
      children.push(
        h(
          'button',
          {
            key: `profile-${profile?.id ?? children.length}`,
            type: 'button',
            role: 'menuitemradio',
            class: classNames('dsg-profile-item', active ? 'dsg-profile-item-active' : null),
            'aria-checked': active ? 'true' : 'false',
            'aria-label': active ? `${profileLabel(profile)} · ${t('profiles.current')}` : profileLabel(profile),
            title: unhealthy ? t('profiles.degraded') : profileLabel(profile),
            'data-testid': 'session-groups-profile-item',
            'data-profile-id': profile?.id ?? '',
            'data-active': active ? 'true' : 'false',
            'data-healthy': unhealthy ? 'false' : 'true',
            ...(disabled ? { disabled: true, 'data-disabled': 'true' } : {}),
            onClick: (event) => {
              event.stopPropagation()
              if (disabled) return
              // Focus returns to the chevron so the preview dialog (which opens
              // after the async preview) restores focus to it on close.
              onClose?.({ restoreFocus: true })
              if (active) return
              handlers?.switchProfile?.(profile?.id)
            },
          },
          h(
            'span',
            { class: 'dsg-profile-item-text' },
            h('span', { class: 'dsg-profile-item-label' }, profileLabel(profile)),
            h(
              'span',
              { class: 'dsg-profile-item-counts' },
              t('profiles.counts', {
                groups: profile?.groupCount ?? 0,
                sessions: profile?.sessionCount ?? 0,
                // One CLDR count drives the first noun; the session noun is part
                // of the same template (single-key constraint, SPEC §9.7).
                n: profile?.groupCount ?? 0,
              })
            )
          ),
          h(
            'span',
            { class: 'dsg-profile-item-check', 'aria-hidden': 'true' },
            profileItemCheck(active, switchTarget !== null && switchTarget === profile?.id)
          )
        )
      )
    }
  }
  if (error) {
    children.push(
      h(
        'div',
        { key: 'retry', class: 'dsg-profile-retry' },
        TextButton({
          label: t('banner.retry'),
          testId: 'session-groups-profile-retry',
          onClick: () => {
            rt()?.refreshProfiles?.()
          },
        })
      )
    )
  }
  // SPEC §9.2 footer (S7): save-as + manage sit below the divider. Both are
  // disabled for a degraded registry or while a switch/write is in flight; the
  // 20-profile cap only disables save-as (manage must stay reachable so a slot
  // can be freed by archiving).
  children.push(
    h(
      'div',
      { key: 'footer', class: 'dsg-profile-footer', 'data-testid': 'session-groups-profile-footer' },
      h(
        'button',
        {
          type: 'button',
          class: 'dsg-profile-footer-button',
          'data-testid': 'session-groups-profile-save-as',
          'data-limit': atLimit ? 'true' : 'false',
          title: atLimit ? t('profiles.limit', { max: limit }) : t('profiles.saveAs'),
          ...(footerDisabled || atLimit ? { disabled: true } : {}),
          onClick: (event) => {
            event.stopPropagation()
            if (footerDisabled || atLimit) return
            onClose?.({ restoreFocus: true })
            handlers?.openSaveAs?.()
          },
        },
        t('profiles.saveAs')
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'dsg-profile-footer-button',
          'data-testid': 'session-groups-profile-manage',
          title: t('profiles.manage'),
          ...(footerDisabled ? { disabled: true } : {}),
          onClick: (event) => {
            event.stopPropagation()
            if (footerDisabled) return
            onClose?.({ restoreFocus: true })
            handlers?.openManage?.()
          },
        },
        t('profiles.manage')
      )
    )
  )
  return h(
    'div',
    {
      class: 'dsg-view-options-popover dsg-profile-popover',
      role: 'menu',
      'aria-label': t('profiles.title'),
      'data-testid': 'session-groups-profile-popover',
      onClick: (event) => event.stopPropagation(),
      onKeyDown: onProfileMenuKeyDown,
    },
    ...children
  )
}

// ---------------------------------------------------------------------------
// Preview dialog body (SPEC §9.3)
// ---------------------------------------------------------------------------
const sessionLabel = (sessionId, byId, t) => {
  const row = byId?.[sessionId]
  if (row) {
    const title = sessionTitle(row, { blankLabel: t('session.blank'), untitledLabel: '' })
    if (typeof title === 'string' && title.trim() !== '') return title
  }
  return typeof sessionId === 'string' ? sessionId.slice(0, 8) : ''
}

/** Order-only note (the changed group set is otherwise identical). */
const previewRow = (kind, text, key) =>
  h('div', { key, class: 'dsg-profile-preview-row', 'data-kind': kind }, text)

const previewArrow = (key) =>
  h('span', { key, class: 'dsg-profile-preview-arrow', 'aria-hidden': 'true' }, '→')

const pathOld = (path, key) =>
  h('span', { key, class: 'dsg-profile-preview-path-old' }, String(path ?? ''))

const pathNew = (path, key) =>
  h('span', { key, class: 'dsg-profile-preview-path-new' }, String(path ?? ''))

const changeMarker = (marker, key) =>
  h('span', { key, class: 'dsg-profile-preview-change-marker', 'aria-hidden': 'true' }, marker)

/**
 * One diff entry as a two-level block: a wrapping title line and an indented
 * detail line (old path → new path, marker + path, or a stale tag). Keeping the
 * two lines in separate elements is what makes long titles/paths readable
 * instead of collapsing into one `title · path` sentence.
 */
const previewChange = (change, key) =>
  h(
    'div',
    { key, class: 'dsg-profile-preview-change', 'data-kind': change.kind },
    h('div', { key: 'title', class: 'dsg-profile-preview-change-title' }, change.title),
    change.detail
      ? h('div', { key: 'detail', class: 'dsg-profile-preview-change-detail' }, change.detail)
      : null
  )

/** One `label from → to` stat; the container wraps the three onto shared lines. */
const summaryStat = (t, labelKey, from, to, key) =>
  h(
    'span',
    { key, class: 'dsg-profile-preview-summary-stat', 'data-stat': key },
    h('span', { class: 'dsg-profile-preview-summary-label' }, t(labelKey)),
    h('span', { class: 'dsg-profile-preview-summary-value' }, `${from ?? 0} → ${to ?? 0}`)
  )

/** Group changes → labelled blocks: added / removed / changed (+reordered). */
const groupChangeBlocks = (diff) => {
  const groups = diff?.groups ?? {}
  const added = (Array.isArray(groups.added) ? groups.added : []).map((path) => ({
    kind: 'added',
    title: [changeMarker('+', 'marker'), pathNew(path, 'path')],
  }))
  const removed = (Array.isArray(groups.removed) ? groups.removed : []).map((path) => ({
    kind: 'removed',
    title: [changeMarker('−', 'marker'), pathOld(path, 'path')],
  }))
  const changed = (Array.isArray(groups.changed) ? groups.changed : []).map((entry) => {
    const from = typeof entry?.from === 'string' ? entry.from : ''
    const to = typeof entry?.to === 'string' ? entry.to : from
    // New path on the title line, the replaced path as the indented detail.
    return {
      kind: 'changed',
      title: [changeMarker('~', 'marker'), pathNew(to, 'path')],
      detail: [pathOld(from, 'from')],
    }
  })
  const blocks = []
  if (added.length > 0) blocks.push({ key: 'added', labelKey: 'profiles.preview.added', rows: added })
  if (removed.length > 0) blocks.push({ key: 'removed', labelKey: 'profiles.preview.removed', rows: removed })
  if (changed.length > 0) blocks.push({ key: 'changed', labelKey: 'profiles.preview.changed', rows: changed })
  return blocks
}

/** Session changes → labelled blocks: moved / newlyGrouped / ungrouped. */
const sessionChangeBlocks = (diff, byId, t) => {
  const sessions = diff?.sessions ?? {}
  const moved = (Array.isArray(sessions.moved) ? sessions.moved : []).map((entry) => ({
    kind: 'moved',
    title: sessionLabel(entry?.sessionId, byId, t),
    detail: [pathOld(entry?.from, 'from'), previewArrow('arrow'), pathNew(entry?.to, 'to')],
  }))
  const newlyGrouped = (Array.isArray(sessions.newlyGrouped) ? sessions.newlyGrouped : []).map((entry) => ({
    kind: 'newlyGrouped',
    title: sessionLabel(entry?.sessionId, byId, t),
    detail: [previewArrow('arrow'), pathNew(entry?.to, 'to')],
  }))
  const ungrouped = (Array.isArray(sessions.ungrouped) ? sessions.ungrouped : []).map((entry) => ({
    kind: 'ungrouped',
    title: sessionLabel(entry?.sessionId, byId, t),
    detail: [
      pathOld(entry?.from, 'from'),
      previewArrow('arrow'),
      h('span', { key: 'to', class: 'dsg-profile-preview-path-muted' }, t('ungrouped.title')),
    ],
  }))
  const blocks = []
  if (moved.length > 0) blocks.push({ key: 'moved', labelKey: 'profiles.preview.moved', rows: moved })
  if (newlyGrouped.length > 0) blocks.push({ key: 'newlyGrouped', labelKey: 'profiles.preview.newlyGrouped', rows: newlyGrouped })
  if (ungrouped.length > 0) blocks.push({ key: 'ungrouped', labelKey: 'profiles.preview.ungrouped', rows: ungrouped })
  return blocks
}

const staleRows = (diff, byId, t) =>
  (Array.isArray(diff?.sessions?.stale) ? diff.sessions.stale : []).map((sessionId) => ({
    kind: 'stale',
    title: sessionLabel(sessionId, byId, t),
    detail: h('span', { key: 'tag', class: 'dsg-profile-preview-change-tag' }, t('profiles.preview.stale')),
  }))

/** Truncate a section at `cap` rows and report how many rows are hidden. */
const truncateBlocks = (blocks, cap) => {
  const total = blocks.reduce((count, block) => count + block.rows.length, 0)
  let budget = cap
  const rendered = []
  for (const block of blocks) {
    const slice = block.rows.slice(0, Math.max(0, budget))
    budget -= slice.length
    if (slice.length > 0) rendered.push({ ...block, rows: slice })
  }
  return { blocks: rendered, remaining: Math.max(0, total - rendered.reduce((count, block) => count + block.rows.length, 0)) }
}

const previewBlocks = (blocks, t) =>
  blocks.map((block) =>
    h(
      'div',
      { key: block.key, class: 'dsg-profile-preview-block', 'data-change': block.key },
      h('div', { key: 'label', class: 'dsg-profile-preview-block-label' }, t(block.labelKey)),
      h(
        'div',
        { key: 'rows', class: 'dsg-profile-preview-list' },
        ...block.rows.map((row, index) => previewChange(row, `${block.key}-${index}`))
      )
    )
  )

/**
 * Body of `dialog.kind = 'profile-preview'`.
 *
 * Renders the subtitle, the three `current → target` counters, the ungrouped
 * warning (nothing is deleted), the change sections and the missing-reference
 * list. Empty sections are omitted; each section is capped at its display
 * limit with an explicit "N more" row.
 */
const ProfilePreviewBody = ({ store, t: tProp, byId }) => {
  const t = tProp ?? rt()?.t ?? ((key) => key)
  // Render from the snapshot passed by DialogHost: it is the same state the
  // dialog was opened with, so a concurrent store publish cannot swap the body
  // underneath the footer's stale/confirm decision.
  const snapshot = store ?? {}
  const preview = snapshot.profilePreview ?? {}
  if (!preview.open) return null
  const currentName = profileNameOf(snapshot, activeProfileIdOf(snapshot))
  const subtitle = t('profiles.previewSubtitle', {
    current: currentName,
    target: preview.targetName ?? preview.targetId ?? '',
  })
  const nodes = [
    h('div', { key: 'subtitle', class: 'dsg-profile-preview-subtitle' }, subtitle),
  ]
  if (preview.loading) {
    nodes.push(
      h(
        'div',
        { key: 'loading', class: 'dsg-profile-preview-loading', 'data-loading': 'true' },
        h(StatusSpinner),
        h('span', null, t('profiles.switching'))
      )
    )
  }
  const diff = preview.diff ?? null
  const summary = diff?.summary ?? null
  if (summary) {
    nodes.push(
      h(
        'div',
        { key: 'summary', class: 'dsg-profile-preview-summary', 'data-testid': 'session-groups-profile-preview-summary' },
        summaryStat(t, 'profiles.preview.groups', summary.groups?.current, summary.groups?.target, 'groups'),
        summaryStat(t, 'profiles.preview.sessions', summary.grouped?.current, summary.grouped?.target, 'sessions'),
        summaryStat(t, 'profiles.preview.ungrouped', summary.ungrouped?.current, summary.ungrouped?.target, 'ungrouped')
      )
    )
    if ((summary.sessions?.ungrouped ?? 0) > 0) {
      nodes.push(
        h(
          'div',
          {
            key: 'warning',
            class: 'dsg-profile-preview-warning',
            role: 'note',
            'data-testid': 'session-groups-profile-preview-warning',
          },
          h('div', null, t('profiles.preview.ungroupedWarning', { n: summary.sessions.ungrouped })),
          h('div', { class: 'dsg-profile-preview-warning-note' }, t('profiles.preview.noDelete'))
        )
      )
    }
    const groupBlocks = truncateBlocks(groupChangeBlocks(diff), MAX_GROUP_ROWS)
    const reordered = diff?.groups?.reordered === true
    if (groupBlocks.blocks.length > 0 || reordered) {
      nodes.push(
        h(
          'section',
          { key: 'groups', class: 'dsg-profile-preview-section', 'data-section': 'groups' },
          h('div', { class: 'dsg-profile-preview-section-title' }, t('profiles.preview.groups')),
          ...previewBlocks(groupBlocks.blocks, t),
          reordered
            ? h(
                'div',
                { class: 'dsg-profile-preview-row', 'data-kind': 'reordered' },
                t('profiles.preview.reordered')
              )
            : null,
          groupBlocks.remaining > 0
            ? h(
                'div',
                { class: 'dsg-profile-preview-truncated', 'data-testid': 'session-groups-profile-preview-truncated' },
                t('profiles.preview.truncated', { n: groupBlocks.remaining })
              )
            : null
        )
      )
    }
    const sessionBlocks = truncateBlocks(sessionChangeBlocks(diff, byId, t), MAX_SESSION_ROWS)
    if (sessionBlocks.blocks.length > 0) {
      nodes.push(
        h(
          'section',
          { key: 'sessions', class: 'dsg-profile-preview-section', 'data-section': 'sessions' },
          h('div', { class: 'dsg-profile-preview-section-title' }, t('profiles.preview.sessions')),
          ...previewBlocks(sessionBlocks.blocks, t),
          sessionBlocks.remaining > 0
            ? h(
                'div',
                { class: 'dsg-profile-preview-truncated', 'data-testid': 'session-groups-profile-preview-truncated' },
                t('profiles.preview.truncated', { n: sessionBlocks.remaining })
              )
            : null
        )
      )
    }
    const stale = staleRows(diff, byId, t)
    if (stale.length > 0) {
      const shown = stale.slice(0, MAX_STALE_ROWS)
      nodes.push(
        h(
          'section',
          { key: 'stale-section', class: 'dsg-profile-preview-section', 'data-section': 'stale' },
          h('div', { class: 'dsg-profile-preview-section-title' }, t('profiles.preview.stale')),
          h(
            'div',
            { class: 'dsg-profile-preview-list' },
            ...shown.map((row, index) => previewChange(row, `stale-${index}`))
          ),
          stale.length > MAX_STALE_ROWS
            ? h(
                'div',
                { class: 'dsg-profile-preview-truncated', 'data-testid': 'session-groups-profile-preview-truncated' },
                t('profiles.preview.truncated', { n: stale.length - MAX_STALE_ROWS })
              )
            : null
        )
      )
    }
  }
  if (preview.stale) {
    nodes.push(
      h(
        'div',
        {
          key: 'stale-notice',
          class: 'dsg-profile-preview-stale',
          role: 'status',
          'data-testid': 'session-groups-profile-preview-stale',
        },
        t('profiles.preview.staleRefresh')
      )
    )
  } else if (preview.error) {
    nodes.push(
      h(
        'div',
        { key: 'error', class: 'dsg-profile-preview-error', role: 'status' },
        t('profiles.saveFailed')
      )
    )
  }
  return h(
    'div',
    {
      class: 'dsg-profile-preview',
      'data-testid': 'session-groups-profile-preview',
      'data-loading': preview.loading ? 'true' : 'false',
      'data-stale': preview.stale ? 'true' : 'false',
    },
    ...nodes
  )
}

/**
 * Preview footer: direct-switch preference, cancel and confirm. Confirm is
 * disabled while the preview is stale (TOCTOU §8.6) and is never the initial
 * focus target (DialogHost focuses the checkbox).
 */
const ProfilePreviewActions = ({ store, t: tProp }) => {
  const t = tProp ?? rt()?.t ?? ((key) => key)
  const preview = store?.profilePreview ?? {}
  const disabled =
    preview.open !== true || preview.loading === true || preview.stale === true || store?.profileSwitching === true
  return [
    h(
      'label',
      { key: 'auto', class: 'dsg-profile-preview-auto' },
      h('input', {
        type: 'checkbox',
        defaultChecked: readProfilePreviewDisabled(),
        'data-testid': 'session-groups-profile-preview-disable',
        onChange: (event) => writeProfilePreviewDisabled(event.target.checked === true),
      }),
      h('span', null, t('profiles.preview.disable'))
    ),
    h(
      'button',
      {
        key: 'cancel',
        type: 'button',
        class: 'dsg-dialog-cancel',
        'data-testid': 'session-groups-profile-preview-cancel',
        onClick: () => cancelProfilePreview({ store }),
      },
      t('dialog.cancel')
    ),
    h(
      'button',
      {
        key: 'confirm',
        type: 'button',
        class: 'dsg-dialog-confirm',
        'data-testid': 'session-groups-profile-preview-confirm',
        'data-stale': preview.stale ? 'true' : 'false',
        ...(disabled ? { disabled: true } : {}),
        onClick: () => {
          void confirmProfilePreview({ store, t })
        },
      },
      t('profiles.preview.confirm')
    ),
  ]
}

// ---------------------------------------------------------------------------
// Recovery strip for `/load` 409 profile-unhealthy/profile-missing (§7.3)
// ---------------------------------------------------------------------------
/**
 * Shown instead of the flat fallback when the active profile cannot be read.
 * Lists the healthy, unarchived profiles and switches to one through
 * preview + activate; the popover itself is unreachable in this state.
 */
const ProfileRecovery = ({ store, t: tProp }) => {
  const t = tProp ?? rt()?.t ?? ((key) => key)
  const profiles = store?.profiles
  if (!profiles?.available) return null
  const code = store?.banner?.code
  if (code !== 'profile-unhealthy' && code !== 'profile-missing') return null
  const targets = (Array.isArray(profiles.list) ? profiles.list : []).filter(
    (profile) => profile && profile.healthy !== false && profile.archived !== true
  )
  return h(
    'div',
    { class: 'dsg-profile-recovery', 'data-testid': 'session-groups-profile-recovery', 'data-code': code, role: 'note' },
    h('div', { class: 'dsg-profile-recovery-title' }, t('error.title')),
    h('div', { class: 'dsg-profile-recovery-body' }, t('profiles.degraded')),
    h(
      'div',
      { class: 'dsg-profile-recovery-actions' },
      ...targets.map((profile) =>
        TextButton({
          label: profileLabel(profile),
          testId: 'session-groups-profile-recovery-item',
          // React pulls `key` out of the createElement config; TextButton spreads
          // `data` into that config, so the mapped row is keyed without an extra
          // DOM wrapper (S6 review carry #3).
          data: { key: profile.id, 'data-profile-id': profile.id },
          onClick: () => {
            void recoverProfile({ t }, profile.id)
          },
        })
      ),
      targets.length === 0
        ? TextButton({
            label: t('banner.retry'),
            testId: 'session-groups-profile-retry',
            onClick: () => {
              rt()?.retryLoad?.()
            },
          })
        : null
    )
  )
}

export {
  PROFILE_PREVIEW_KEY,
  readProfilePreviewDisabled,
  writeProfilePreviewDisabled,
  isPreviewDiffEmpty,
  profileFailureMessage,
  createProfileHandlers,
  beginProfileSwitch,
  confirmProfilePreview,
  cancelProfilePreview,
  undoProfileSwitch,
  recoverProfile,
  ProfileMenu,
  ProfilePopover,
  ProfilePreviewBody,
  ProfilePreviewActions,
  ProfileRecovery,
}
