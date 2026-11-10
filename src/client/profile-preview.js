/**
 * Profile preview dialog body and footer (SPEC §8.5/§9.3).
 *
 * Renders the read-only diff preview for `dialog.kind = 'profile-preview'`:
 * the three 'current → target' counters, the change sections, the
 * missing-reference list, the direct-switch preference checkbox and the
 * confirm/cancel actions.
 *
 * The switch sequence itself lives in 'profile-switch.js'; this module imports
 * its confirm/cancel actions plus the snapshot helpers, and re-exports the two
 * preview predicates so both modules expose the same public names.
 */
import { createElement } from 'react'
import { clientRuntime as rt } from '../adapters/client-runtime.js'
import { sessionTitle } from '../core/filter.js'
import { StatusSpinner } from './components-primitives.js'
import { readProfilePreviewDisabled, writeProfilePreviewDisabled } from './profile-storage.js'
import {
  activeProfileIdOf,
  cancelProfilePreview,
  confirmProfilePreview,
  profileNameOf,
} from './profile-switch.js'

const h = createElement

/** Display caps for the preview lists (SPEC §8.5); the diff core is uncapped. */
const MAX_GROUP_ROWS = 100
const MAX_SESSION_ROWS = 300
const MAX_STALE_ROWS = 100

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

export { ProfilePreviewBody, ProfilePreviewActions }
export { isPreviewDiffEmpty, profileFailureMessage } from './profile-switch.js'
