/**
 * React components for the groups sidebar (plain `createElement`, no JSX).
 *
 * Components are registered into DSH slots and receive the framework standard
 * toolkit as props (`useSessions`, `useWorkspaces`, `useSessionStatus`,
 * `usePanelInfo`, `…`) plus the slot owner share. Everything host-derived is read
 * from those hooks; the only local state is this plugin's view store.
 */
import { Component, createElement, useEffect, useRef, useState } from 'react'
import { clientRuntime as rt } from '../adapters/client-runtime.js'
import { PLUGIN_VERSION } from '../shared/constants.js'
import { workspaceLabel } from './actions.js'
import { isArchived, sessionTitle, ARCHIVE_FILTERS, ARCHIVE_FILTER_LABEL_KEYS } from '../core/filter.js'
import { diagRender } from './diagnostics.js'
import { renderGlyph, renderIcon } from './icons.js'
import { perfRender } from './perf.js'
import { useFloatingPanel } from './floating-panel.js'

import { SearchBox } from './components-search-box.js'
import { dispatch, IconButton, SessionStatusCell, TextButton } from './components-primitives.js'
import { ProfileMenu, ProfileRecovery } from './profile-switcher.js'

const h = createElement

/**
 * View-options popover (0.4.0-beta.62 §10): two independent archive tri-states.
 * The session segment keeps the shipped `archive.*` copy/testid; the group
 * segment adds `archive.group.*` keys (resources ship in P10). Picking an option
 * keeps the popover open so both segments can be set in one visit; only the
 * explicit reset-layout action (and outside/Escape/button toggles) closes it.
 */
const GROUP_ARCHIVE_FILTER_LABEL_KEYS = Object.freeze({
  hidden: 'archive.group.hidden',
  all: 'archive.group.all',
  only: 'archive.group.only',
})

/** Section headings inside the view-options popover (resources ship in P10). */
const ARCHIVE_SECTION_LABEL_KEYS = Object.freeze({
  sessions: 'archive.section.sessions',
  groups: 'archive.section.groups',
})

/**
 * 0.4.0-beta.64: content-sized 200-360px panel mounted through the shared
 * floating-panel controller; single-line labels carry `title` (spec
 * §6.2/§6.3/§6.4).
 */
const ArchiveFilterPopover = ({ filter, groupFilter, t, onPick, onPickGroup, onResetLayout, triggerRef }) => {
  // Header only mounts this panel while the menu is open, so `open` is constant
  // here; the shared controller still owns placement, the measured content width
  // (200-360px, spec §6.4) and `data-placement`.
  const panel = useFloatingPanel({
    open: true,
    triggerRef,
    align: 'inline-end',
    designWidth: 360,
    designHeight: Math.min(420, Math.round((globalThis.innerHeight || 0) * 0.7)),
    fixedWidth: false,
  })
  return h(
    'div',
    {
      class: 'dsg-view-options-popover',
      ref: panel.ref,
      style: panel.style,
      'data-placement': panel.placement,
      role: 'menu',
      'data-testid': 'session-groups-view-options-popover',
      'aria-label': t('view.options'),
      onClick: (event) => event.stopPropagation(),
    },
    h(
      'div',
      {
        class: 'dsg-view-options-section',
        role: 'group',
        'aria-label': t(ARCHIVE_SECTION_LABEL_KEYS.sessions),
      },
      h('div', { class: 'dsg-view-options-section-title' }, t(ARCHIVE_SECTION_LABEL_KEYS.sessions)),
      ...ARCHIVE_FILTERS.map((value) => {
        const active = value === filter
        const label = t(ARCHIVE_FILTER_LABEL_KEYS[value])
        return h(
          'button',
          {
            key: value,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': active ? 'true' : 'false',
            class: 'dsg-menu-item dsg-view-option',
            'data-testid': 'session-groups-archive-filter',
            'data-filter': value,
            'data-active': active ? 'true' : 'false',
            onClick: (event) => {
              event.stopPropagation()
              onPick(value)
            },
          },
          h('span', { class: 'dsg-view-option-label', title: label }, label),
          h('span', { class: 'dsg-view-option-check', 'aria-hidden': 'true' }, active ? renderGlyph(h, 'check', 16) : null)
        )
      })
    ),
    h(
      'div',
      {
        class: 'dsg-view-options-section',
        role: 'group',
        'aria-label': t(ARCHIVE_SECTION_LABEL_KEYS.groups),
      },
      h('div', { class: 'dsg-view-options-section-title' }, t(ARCHIVE_SECTION_LABEL_KEYS.groups)),
      ...ARCHIVE_FILTERS.map((value) => {
        const active = value === groupFilter
        const label = t(GROUP_ARCHIVE_FILTER_LABEL_KEYS[value])
        return h(
          'button',
          {
            key: value,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': active ? 'true' : 'false',
            class: 'dsg-menu-item dsg-view-option',
            'data-testid': 'session-groups-group-archive-filter',
            'data-group-filter': value,
            'data-active': active ? 'true' : 'false',
            onClick: (event) => {
              event.stopPropagation()
              onPickGroup(value)
            },
          },
          h('span', { class: 'dsg-view-option-label', title: label }, label),
          h('span', { class: 'dsg-view-option-check', 'aria-hidden': 'true' }, active ? renderGlyph(h, 'check', 16) : null)
        )
      })
    ),
    // 0.4.0-beta.63: one line that says what the two tri-states do not change.
    h('div', { class: 'dsg-view-options-hint' }, t('archive.hint')),
    h('div', { class: 'dsg-view-options-divider' }),
    h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        class: 'dsg-menu-item dsg-view-option',
        'data-testid': 'session-groups-reset-layout',
        onClick: (event) => {
          event.stopPropagation()
          onResetLayout()
        },
      },
      h('span', { class: 'dsg-view-option-label', title: t('about.resetLayout') }, t('about.resetLayout')),
      // 0.4.0-beta.62 UI patch: a return arrow ("restore defaults") instead of
      // the refresh/X-like glyph, so the row does not read as "reload".
      h('span', { class: 'dsg-view-option-check', 'aria-hidden': 'true' }, renderGlyph(h, 'restore', 16))
    ),
    h(
      'div',
      { class: 'dsg-view-options-about', 'data-testid': 'session-groups-about' },
      h('span', { class: 'dsg-view-options-version' }, `dsh-session-grove ${PLUGIN_VERSION}`),
      h('span', { class: 'dsg-view-options-scope' }, t('about.scope'))
    )
  )
}

/**
 * One-time onboarding card. 0.4.0-beta.63 keeps it action-first: one sentence
 * about the non-destructive layer, then create / full guide / dismiss. The
 * long-form reference lives in the repository README, not in the bundle.
 */
const OnboardingCard = ({ t, onCreate, onDismiss, docsHref }) =>
  h(
    'div',
    { class: 'dsg-onboarding', 'data-testid': 'session-groups-onboarding', role: 'note' },
    h('div', { class: 'dsg-onboarding-title' }, t('onboarding.title')),
    h('div', { class: 'dsg-onboarding-body' }, t('onboarding.body')),
    h(
      'div',
      { class: 'dsg-onboarding-actions' },
      TextButton({ label: t('onboarding.create'), testId: 'session-groups-onboarding-create', onClick: onCreate }),
      docsHref
        ? h(
            'a',
            {
              class: 'dsg-onboarding-docs',
              'data-testid': 'session-groups-onboarding-docs',
              href: docsHref,
              target: '_blank',
              rel: 'noreferrer noopener',
            },
            t('onboarding.docs')
          )
        : null,
      TextButton({ label: t('onboarding.dismiss'), testId: 'session-groups-onboarding-dismiss', onClick: onDismiss })
    )
  )

const StatusSessionsButton = ({
  kind,
  icon,
  count,
  sections,
  label,
  ariaLabel,
  emptyLabel,
  testId,
  popoverTestId,
  sessionsById,
  onSelect,
}) => {
  const t = rt()?.t ?? ((key) => key)
  const [open, setOpen] = useState(false)
  // The wrapper still owns the outside-pointerdown boundary; the button is the
  // anchor of the shared floating panel (248px design box, spec §6.4).
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const panel = useFloatingPanel({
    open,
    triggerRef,
    align: 'inline-end',
    designWidth: 248,
    designHeight: 320,
    fixedWidth: true,
  })
  useEffect(() => {
    if (!open) return undefined
    const doc = globalThis.document
    const onPointerDown = (event) => {
      if (rootRef.current?.contains?.(event?.target)) return
      setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    doc?.addEventListener?.('pointerdown', onPointerDown, true)
    doc?.addEventListener?.('keydown', onKeyDown, true)
    return () => {
      doc?.removeEventListener?.('pointerdown', onPointerDown, true)
      doc?.removeEventListener?.('keydown', onKeyDown, true)
    }
  }, [open])

  return h(
    'div',
    { class: 'dsg-status-action-wrap', ref: rootRef },
    h(
      'button',
      {
        ref: triggerRef,
        type: 'button',
        class: 'dsg-status-action',
        'data-testid': testId,
        'data-kind': kind,
        'data-count': String(count),
        title: label,
        'aria-label': ariaLabel,
        'aria-expanded': open ? 'true' : 'false',
        onClick: (event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        },
      },
      h('span', { class: 'dsg-status-action-icon', 'aria-hidden': 'true' }, renderIcon(h, icon, 16)),
      h('span', { class: 'dsg-status-action-count' }, String(count))
    ),
    open
      ? h(
          'div',
          {
            class: 'dsg-running-popover',
            ref: panel.ref,
            style: panel.style,
            'data-placement': panel.placement,
            role: 'menu',
            'data-testid': popoverTestId,
          },
          // 0.4.0-beta.63: the three counters are exclusive and job-free.
          h('div', { class: 'dsg-status-hint' }, t('status.hint')),
          sections.length === 0
            ? h('div', { class: 'dsg-running-empty' }, emptyLabel)
            : sections.map((section, index) => {
                const groupLabel = section.groupId
                  ? section.groupName || t('session.untitled')
                  : t('running.group.ungrouped')
                return h(
                  'div',
                  {
                    class: 'dsg-running-section',
                    key: section.groupId ?? `ungrouped-${index}`,
                    'data-group-id': section.groupId ?? '',
                  },
                  h('div', { class: 'dsg-running-group-label', title: groupLabel }, groupLabel),
                  section.sessions.map((entry) => {
                    const itemTitle = sessionTitle(sessionsById?.[entry.sessionId], {
                      blankLabel: t('session.blank'),
                      untitledLabel: t('session.untitled'),
                    })
                    return h(
                      'button',
                      {
                        type: 'button',
                        class: 'dsg-running-item',
                        key: entry.sessionId,
                        title: itemTitle,
                        'data-testid': `${testId}-item`,
                        'data-session-id': entry.sessionId,
                        onClick: (event) => {
                          event.stopPropagation()
                          setOpen(false)
                          onSelect(entry.sessionId, entry.archived === true)
                        },
                      },
                      h('span', { class: 'dsg-running-item-title' }, itemTitle),
                      entry.archived
                        ? h('span', { class: 'dsg-running-item-archived' }, t('session.archived'))
                        : null
                    )
                  })
                )
              })
        )
      : null
  )
}

const Header = ({ store, handlers, sessionsById, workspaces, archivedSessionIds, runningSessions, blockedSessions, unreadSessions }) => {
  perfRender('Header')
  diagRender('Header')
  const t = rt()?.t ?? ((key) => key)
  const filter = store.archiveFilter
  // 0.4.0-beta.62 §4.1: the group tri-state is independent of the session one.
  const groupFilter = store.groupArchiveFilter ?? 'hidden'
  const [searchOpen, setSearchOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  // Profile switcher (SPEC §9.1/§9.2): the header owns the open flag so the
  // view-options/search popovers and the profile menu stay mutually exclusive.
  const [profileOpen, setProfileOpen] = useState(false)
  const optionsRef = useRef(null)
  // Anchor of the view-options panel; `optionsRef` keeps owning the outside
  // pointerdown boundary of the wrapper.
  const optionsTriggerRef = useRef(null)

  // View-options popover: Escape or an outside pointerdown closes it.
  useEffect(() => {
    if (!optionsOpen) return undefined
    const doc = globalThis.document
    const onPointerDown = (event) => {
      if (optionsRef.current?.contains?.(event?.target)) return
      setOptionsOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOptionsOpen(false)
    }
    doc?.addEventListener?.('pointerdown', onPointerDown, true)
    doc?.addEventListener?.('keydown', onKeyDown, true)
    return () => {
      doc?.removeEventListener?.('pointerdown', onPointerDown, true)
      doc?.removeEventListener?.('keydown', onKeyDown, true)
    }
  }, [optionsOpen])

  return h(
    'div',
    {
      class: 'dsg-header dsg-header-stacked',
      'data-testid': 'session-groups-header',
      'data-search-open': searchOpen ? 'true' : 'false',
      'data-options-open': optionsOpen ? 'true' : 'false',
    },
    h(
      'div',
      { class: 'dsg-header-row', 'data-testid': 'session-groups-header-row' },
      h(
        'span',
        { class: 'dsg-header-title', title: t('view.title') },
        h('span', { class: 'dsg-header-label' }, t('view.title')),
        // SPEC §9.1: profile chevron sits after the label; only hosts that
        // expose the profile surface render it (§7.7).
        h(ProfileMenu, {
          store,
          handlers,
          open: profileOpen,
          onOpenChange: setProfileOpen,
          onBeforeOpen: () => {
            setSearchOpen(false)
            setOptionsOpen(false)
          },
        })
      ),
      h(
        'div',
        { class: 'dsg-header-actions' },
        h(
          'div',
          { class: 'dsg-status-actions' },
          h(StatusSessionsButton, {
            kind: 'running',
            icon: 'activity',
            count: runningSessions?.count ?? 0,
            sections: runningSessions?.sections ?? [],
            label: t('running.open'),
            ariaLabel: t('running.aria', { n: runningSessions?.count ?? 0 }),
            emptyLabel: t('running.empty'),
            testId: 'session-groups-running-button',
            popoverTestId: 'session-groups-running-popover',
            sessionsById,
            onSelect: handlers.openRunningSession,
          }),
          h(StatusSessionsButton, {
            kind: 'blocked',
            icon: 'pause',
            count: blockedSessions?.count ?? 0,
            sections: blockedSessions?.sections ?? [],
            label: t('blocked.open'),
            ariaLabel: t('blocked.aria', { n: blockedSessions?.count ?? 0 }),
            emptyLabel: t('blocked.empty'),
            testId: 'session-groups-blocked-button',
            popoverTestId: 'session-groups-blocked-popover',
            sessionsById,
            onSelect: handlers.openRunningSession,
          }),
          h(StatusSessionsButton, {
            kind: 'unread',
            icon: 'mail',
            count: unreadSessions?.count ?? 0,
            sections: unreadSessions?.sections ?? [],
            label: t('unread.open'),
            ariaLabel: t('unread.aria', { n: unreadSessions?.count ?? 0 }),
            emptyLabel: t('unread.empty'),
            testId: 'session-groups-unread-button',
            popoverTestId: 'session-groups-unread-popover',
            sessionsById,
            onSelect: handlers.openRunningSession,
          })
        ),        // 0.2.24: view switch moved from the footer to the header's leading slot.
        // The grid glyph means "go to the workspace browser".
        IconButton({
          label: t('footer.toWorkspace'),
          glyph: 'grid',
          testId: 'session-groups-toggle',
          data: { 'data-mode': store.viewMode, 'data-target': 'workspace' },
          onClick: () => rt()?.toggleMode(),
        }),
        // Official workspace-section order: search → view options → new group.
        IconButton({
          label: t('search.label'),
          icon: 'search',
          testId: 'session-groups-search-toggle',
          expanded: searchOpen,
          onClick: () => {
            setOptionsOpen(false)
            setProfileOpen(false)
            setSearchOpen((open) => !open)
          },
        }),
        h(
          'div',
          { ref: optionsRef, class: 'dsg-view-options' },
          IconButton({
            label: t('view.options'),
            icon: 'view-options',
            testId: 'session-groups-view-options',
            expanded: optionsOpen,
            haspopup: 'menu',
            // createElement pulls `ref` out of the config object, so the trigger
            // ref rides through `data` (same trick as `key` in ProfileRecovery);
            // IconButton spreads it onto the button element.
            data: { ref: optionsTriggerRef, 'data-filter': filter, 'data-group-filter': groupFilter },
            onClick: () => {
              setProfileOpen(false)
              setOptionsOpen((open) => !open)
            },
          }),
          optionsOpen
            ? h(ArchiveFilterPopover, {
                filter,
                groupFilter,
                t,
                triggerRef: optionsTriggerRef,
                onPick: (value) => handlers.setArchiveFilter(value),
                // §10: keep the popover open so the second tri-state can be set
                // in the same visit; the menu closes on outside/Escape/re-toggle
                // or the explicit reset-layout action only.
                onPickGroup: (value) => handlers.setGroupArchiveFilter(value),
                onResetLayout: () => {
                  handlers.resetLayout()
                  setOptionsOpen(false)
                },
              })
            : null
        ),
        IconButton({
          label: t('view.newGroup'),
          icon: 'project-add',
          testId: 'session-groups-new-group',
          onClick: (event) => handlers.openNewGroup(event, null),
        })
      )
    ),
    searchOpen
      ? h(
          'div',
          { class: 'dsg-header-row dsg-header-search-row', 'data-testid': 'session-groups-header-search-row' },
          h(SearchBox, {
            store,
            handlers,
            sessionsById,
            workspaces,
            archivedSessionIds,
            autoFocus: true,
            onDismiss: () => setSearchOpen(false),
          }),
          IconButton({
            label: t('search.collapse'),
            glyph: 'chevronUp',
            testId: 'session-groups-search-close',
            onClick: () => setSearchOpen(false),
          })
        )
      : null
  )
}

const Banner = ({ store, handlers }) => {
  const banner = store.banner
  if (!banner) return null
  const t = rt()?.t
  const key = `banner.${banner.code}`
  const message = t(key)
  const retryable = banner.kind === 'error'
  return h(
    'div',
    { class: 'dsg-banner', 'data-testid': 'session-groups-banner', 'data-kind': banner.kind },
    h('span', { class: 'dsg-banner-text' }, message === key ? t('banner.loadFailed') : message),
    retryable ? TextButton({ label: t('banner.retry'), onClick: () => handlers.retryLoad(), testId: 'session-groups-banner-retry' }) : null,
    TextButton({ label: t('banner.dismiss'), onClick: () => dispatch('banner', { banner: null }), testId: 'session-groups-banner-dismiss' })
  )
}

const Rail = ({ props }) => {
  const t = rt()?.t
  const expandSidebar = typeof props?.expandSidebar === 'function' ? props.expandSidebar : () => {}
  return h(
    'div',
    { class: 'dsg-rail', 'data-testid': 'session-groups-rail' },
    h(
      'button',
      {
        type: 'button',
        class: 'dsg-rail-button',
        title: t('rail.expand'),
        'aria-label': t('rail.expand'),
        'data-testid': 'session-groups-rail-expand',
        onClick: () => expandSidebar(),
      },
      renderGlyph(h, 'folderAdjust', 18)
    ),
    h('span', { class: 'dsg-rail-label' }, t('rail.groups'))
  )
}

// ---------------------------------------------------------------------------
// Flat fallback / error boundary
// ---------------------------------------------------------------------------
const FlatFallback = ({ props, store, reason }) => {
  const t = rt()?.t
  const sessions = typeof props?.useSessions === 'function' ? props.useSessions((snapshot) => snapshot) : null
  const workspaces = typeof props?.useWorkspaces === 'function' ? props.useWorkspaces((snapshot) => snapshot) : null
  const workspaceItems = workspaces?.items ?? []
  const archived = workspaces?.archivedSessionIds ?? []
  const byId = sessions?.byId ?? {}
  const ids = (sessions?.ids ?? []).filter((id) => byId[id] && byId[id].origin !== 'subagent')
  const rows = ids.map((id) => byId[id])
  return h(
    'div',
    { class: 'dsg-root', 'data-testid': 'session-groups-flat-fallback', 'data-reason': reason ?? 'error' },
    h('div', { class: 'dsg-header', 'data-testid': 'session-groups-error' }, h('span', { class: 'dsg-header-title' }, t('error.title'))),
    h('div', { class: 'dsg-banner', 'data-kind': 'error' }, h('span', { class: 'dsg-banner-text' }, reason === 'route-unavailable' ? t('banner.routeUnavailable') : t('error.body'))),
    // SPEC §7.3 recovery: an unhealthy/missing active profile still offers the
    // healthy profiles (default first) so the view never dead-ends.
    h(ProfileRecovery, { store, t }),
    h(
      'div',
      { class: 'dsg-flat' },
      ...rows.map((row) =>
        h(
          'div',
          {
            key: row.id,
            class: 'dsg-session-row',
            'data-testid': 'session-groups-session',
            'data-session-id': row.id,
            'data-archived': isArchived(archived, row.id) ? 'true' : 'false',
            onClick: () => !isArchived(archived, row.id) && rt()?.actions.openSession(row.id),
          },
          h(SessionStatusCell, { statuses: [], hidden: true }),
          h('span', { class: 'dsg-session-title' }, sessionTitle(row, { blankLabel: t('session.blank'), untitledLabel: t('session.untitled') })),
          h('span', { class: 'dsg-workspace-badge', style: { opacity: 1 } }, (() => {
            const workspace = workspaceItems.find((item) => (item.sessionIds ?? []).includes(row.id))
            return workspace ? workspaceLabel(workspace) : t('session.noWorkspace')
          })())
        )
      ),
      rows.length === 0 ? h('div', { class: 'dsg-empty', 'data-testid': 'session-groups-empty' }, t('empty.none')) : null
    ),
    h(
      'div',
      { class: 'dsg-header' },
      TextButton({ label: t('banner.retry'), onClick: () => rt()?.retryLoad(), testId: 'session-groups-flat-retry' }),
      TextButton({ label: t('view.returnWorkspace'), onClick: () => rt()?.setMode('workspace'), testId: 'session-groups-return' })
    )
  )
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error) {
    globalThis.console?.error?.('[dsh-session-grove] render error', error)
  }
  render() {
    if (this.state.error) return this.props.fallback(this.state.error)
    return this.props.children
  }
}

// ---------------------------------------------------------------------------
// Groups view (Sidebar occupant)
// ---------------------------------------------------------------------------

export { ArchiveFilterPopover, OnboardingCard, StatusSessionsButton, Header, Banner, Rail, FlatFallback, ErrorBoundary }
