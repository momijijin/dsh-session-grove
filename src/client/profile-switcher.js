/**
 * Profile switcher UI (SPEC §9.1/§9.2, §7.3).
 *
 * Owns the header chevron trigger, the registry-backed popover and the recovery
 * strip shown when the active profile cannot be loaded. The switch sequence
 * lives in 'profile-switch.js'; this module only renders and forwards clicks.
 */
import { createElement, useEffect, useRef } from 'react'
import { clientRuntime as rt } from '../adapters/client-runtime.js'
import { renderGlyph } from './icons.js'
import { StatusSpinner, TextButton } from './components-primitives.js'
import { profileLabel, recoverProfile } from './profile-switch.js'

const h = createElement

const classNames = (...values) => values.filter(Boolean).join(' ')

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
  ProfileMenu,
  ProfilePopover,
  ProfileRecovery,
}
