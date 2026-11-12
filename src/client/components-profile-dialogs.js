/**
 * Profile save-as / manage dialogs (SPEC §9.4/§9.5, §5.5-§5.7, §7.4 step 9/10).
 *
 * Split out of `components-profiles.js` to keep both modules readable: this one
 * owns the four profile dialogs (save-as, manage, rename, archive) plus the
 * handlers that open them from the popover footer. The write calls themselves
 * live in the plugin bridge (`rt().createProfile`/`renameProfile`/`archiveProfile`),
 * because only the plugin owns the store, the optimistic queue and the toast.
 *
 * Every profile dialog runs inside DialogHost (Escape/Tab/geometry/focus
 * restore); this module never adds its own Escape handling. Name validation is
 * client-first for immediate inline copy, but the host stays authoritative.
 */
import { createElement } from 'react'
import { clientRuntime as rt } from '../adapters/client-runtime.js'
import { MAX_PROFILE_NAME, MAX_PROFILES } from '../shared/profile-limits.js'
import { DEFAULT_PROFILE_ID } from './state.js'
import { readProfilePreviewDisabled, writeProfilePreviewDisabled } from './profile-storage.js'

const h = createElement

/** Mirrors the shared host profile name cap (SPEC §4.4); exported alias kept. */
const PROFILE_NAME_MAX = MAX_PROFILE_NAME

const dispatch = (action, payload) => rt()?.store?.dispatch?.(action, payload)

/** User-facing profile name; the default entry has no stored name. */
const profileDisplayName = (profile, t) => {
  const name = typeof profile?.name === 'string' ? profile.name.trim() : ''
  if (name !== '') return name
  if (profile?.id === DEFAULT_PROFILE_ID) return t('profiles.defaultName')
  return typeof profile?.id === 'string' ? profile.id : ''
}

/** Unarchived switcher rows (defensive: older lists may not be split). */
const unarchivedProfiles = (profiles) =>
  (Array.isArray(profiles?.list) ? profiles.list : []).filter((profile) => profile?.archived !== true)

/** Archived rows, populated only by the manage dialog's opt-in read. */
const archivedProfiles = (profiles) => (Array.isArray(profiles?.archivedList) ? profiles.archivedList : [])

const allProfiles = (snapshot) => [...unarchivedProfiles(snapshot?.profiles), ...archivedProfiles(snapshot?.profiles)]

const activeProfileOf = (snapshot) => {
  const activeId = snapshot?.profiles?.activeId ?? snapshot?.profileId ?? null
  return allProfiles(snapshot).find((profile) => profile?.id === activeId) ?? null
}

/**
 * Client-side SPEC §9.4 validation: trim, 1-40 characters and uniqueness among
 * the unarchived profiles (the host's `nameTaken` ignores archived rows too).
 */
const validateProfileName = (name, { list = [], exceptId = null } = {}) => {
  const text = typeof name === 'string' ? name.trim() : ''
  if (text === '' || text.length > PROFILE_NAME_MAX) return 'profiles.nameInvalid'
  const key = text.toLowerCase()
  const duplicate = list.some(
    (profile) =>
      profile &&
      profile.id !== exceptId &&
      typeof profile.name === 'string' &&
      profile.name.trim() !== '' &&
      profile.name.trim().toLowerCase() === key
  )
  return duplicate ? 'profiles.nameDuplicate' : null
}

/**
 * Default save-as name: `<active name> <copy suffix>` (SPEC §9.4). DialogHost
 * validates the live value on every render, so the seeded default must itself
 * be submittable — otherwise the dialog opens on nameInvalid/nameDuplicate and
 * a disabled Create button. When the plain name is too long or already taken,
 * shorten the stem to the 40-character cap and number the suffix (`copy 2`,
 * `copy 3`, …). Returning `''` sends the rare unresolvable case to submit-time
 * validation instead of a pre-filled wrong/unsubmittable name.
 */
const cloneName = (snapshot, t) => {
  const active = activeProfileOf(snapshot)
  const base = active ? profileDisplayName(active, t) : t('profiles.defaultName')
  const suffix = t('profiles.copySuffix')
  const list = unarchivedProfiles(snapshot?.profiles)
  // At most `list.length` distinct candidates can collide with existing names,
  // so one more ordinal than there are rows is enough to find a free name.
  for (let ordinal = 1; ordinal <= list.length + 1; ordinal += 1) {
    const tail = ordinal === 1 ? suffix : `${suffix} ${ordinal}`
    const room = PROFILE_NAME_MAX - tail.length - 1
    if (room < 1) return ''
    const candidate = `${base.slice(0, room).trim()} ${tail}`
    if (validateProfileName(candidate, { list }) === null) return candidate
  }
  return ''
}

const countGroups = (nodes) =>
  Array.isArray(nodes) ? nodes.reduce((total, group) => total + 1 + countGroups(group?.groups), 0) : 0

const countDocSessions = (doc) => {
  let total = Array.isArray(doc?.ungrouped) ? doc.ungrouped.length : 0
  const walk = (nodes) => {
    for (const group of Array.isArray(nodes) ? nodes : []) {
      total += Array.isArray(group?.sessionIds) ? group.sessionIds.length : 0
      walk(group?.groups)
    }
  }
  walk(doc?.groups)
  return total
}

/** Counts for the "will copy N groups · M sessions" preview line. */
const saveAsCounts = (snapshot) => {
  const active = activeProfileOf(snapshot)
  const groups = Number.isInteger(active?.groupCount) ? active.groupCount : countGroups(snapshot?.doc?.groups)
  const sessions = Number.isInteger(active?.sessionCount)
    ? active.sessionCount
    : countDocSessions(snapshot?.doc)
  return { groups, sessions }
}

/** Set an inline dialog error without closing the dialog (host failure path). */
const setDialogError = (key, params = null) => {
  const dialog = rt()?.store?.getSnapshot?.()?.dialog
  if (dialog) dispatch('dialog', { dialog: { ...dialog, error: key, errorParams: params } })
}

// ---------------------------------------------------------------------------
// Dialog openers (SPEC §9.2 footer → §9.4/§9.5)
// ---------------------------------------------------------------------------
const openSaveAs = ({ t } = {}) => {
  const snapshot = rt()?.store?.getSnapshot?.() ?? {}
  const name = cloneName(snapshot, t)
  dispatch('dialog', { dialog: { kind: 'profile-save-as', titleKey: 'profiles.saveAs', value: name } })
  return name
}

const openManage = ({ t } = {}) => {
  dispatch('dialog', { dialog: { kind: 'profile-manage', titleKey: 'profiles.title' } })
  // SPEC §5.3: archived rows are opt-in. The plugin keeps this read in its own
  // in-flight slot so a background switcher refresh cannot dedupe it away.
  void rt()?.refreshProfiles?.({ includeArchived: true, background: true })
  return true
}

const findProfile = (profileId) =>
  allProfiles(rt()?.store?.getSnapshot?.() ?? {}).find((profile) => profile?.id === profileId) ?? null

const openRename = (profileId, { t } = {}) => {
  if (typeof profileId !== 'string' || profileId === '') return false
  const profile = findProfile(profileId)
  const value = profile ? profileDisplayName(profile, t) : ''
  // `returnTo` keeps the manage list one Escape/Cancel away (SPEC §9.5).
  dispatch('dialog', {
    dialog: {
      kind: 'profile-rename',
      titleKey: 'profiles.rename',
      profileId,
      profileName: value,
      value,
      returnTo: 'profile-manage',
    },
  })
  return true
}

const openArchive = (profileId, { t } = {}) => {
  if (typeof profileId !== 'string' || profileId === '') return false
  const profile = findProfile(profileId)
  dispatch('dialog', {
    dialog: {
      kind: 'profile-archive',
      titleKey: 'profiles.archive',
      profileId,
      profileName: profile ? profileDisplayName(profile, t) : '',
      returnTo: 'profile-manage',
    },
  })
  return true
}

// ---------------------------------------------------------------------------
// Dialog confirmation (DialogHost footer)
// ---------------------------------------------------------------------------
const confirmSaveAs = async ({ t } = {}, { name } = {}) => {
  const snapshot = rt()?.store?.getSnapshot?.() ?? {}
  const error = validateProfileName(name, { list: unarchivedProfiles(snapshot.profiles) })
  if (error !== null) {
    setDialogError(error)
    return { ok: false, code: 'profile-name-invalid' }
  }
  const create = rt()?.createProfile
  if (typeof create !== 'function') return { ok: false, code: 'unavailable' }
  return create({ name: String(name).trim() })
}

const confirmRename = async ({ t } = {}, { profileId, name } = {}) => {
  const snapshot = rt()?.store?.getSnapshot?.() ?? {}
  const error = validateProfileName(name, {
    list: unarchivedProfiles(snapshot.profiles),
    exceptId: profileId ?? null,
  })
  if (error !== null) {
    setDialogError(error)
    return { ok: false, code: 'profile-name-invalid' }
  }
  const rename = rt()?.renameProfile
  if (typeof rename !== 'function') return { ok: false, code: 'unavailable' }
  return rename({ id: profileId, name: String(name).trim() })
}

const confirmArchive = async ({ t } = {}, { profileId } = {}) => {
  const archive = rt()?.archiveProfile
  if (typeof archive !== 'function') return { ok: false, code: 'unavailable' }
  return archive({ id: profileId })
}

/** Handler-facade entries registered by GroupsView (SPEC §9.2/§9.4/§9.5). */
const createProfileDialogHandlers = ({ t }) => ({
  openSaveAs: () => openSaveAs({ t }),
  openManage: () => openManage({ t }),
  confirmSaveAs: (payload) => confirmSaveAs({ t }, payload),
  openRename: (profileId) => openRename(profileId, { t }),
  confirmRename: (payload) => confirmRename({ t }, payload),
  openArchive: (profileId) => openArchive(profileId, { t }),
  confirmArchive: (payload) => confirmArchive({ t }, payload),
})

// ---------------------------------------------------------------------------
// Dialog bodies (DialogHost owns the input value for the two name dialogs)
// ---------------------------------------------------------------------------
/** Save-as body: name input + copy preview line (SPEC §9.4). */
const ProfileSaveAsBody = ({ store, t, value, onValueChange, onKeyDown, inputRef }) => {
  const { groups, sessions } = saveAsCounts(store ?? {})
  return h(
    'div',
    { class: 'dsg-profile-dialog', 'data-testid': 'session-groups-profile-save-as-dialog' },
    h('label', { class: 'dsg-profile-dialog-label', for: 'dsg-profile-save-as-name' }, t('profiles.nameLabel')),
    h('input', {
      ref: inputRef,
      id: 'dsg-profile-save-as-name',
      type: 'text',
      class: 'dsg-dialog-input',
      'data-testid': 'session-groups-profile-save-as-name',
      value: value ?? '',
      maxlength: String(PROFILE_NAME_MAX),
      placeholder: t('profiles.namePlaceholder'),
      autocomplete: 'off',
      spellcheck: 'false',
      onChange: (event) => onValueChange?.(event.target.value),
      onKeyDown: (event) => onKeyDown?.(event),
    }),
    h(
      'div',
      {
        class: 'dsg-profile-dialog-preview',
        'data-testid': 'session-groups-profile-save-as-preview',
      },
      t('profiles.createPreview', { groups, sessions })
    )
  )
}

/** Rename body: single name input prefilled with the current name (SPEC §9.5). */
const ProfileRenameBody = ({ t, dialog, value, onValueChange, onKeyDown, inputRef }) => {
  const current = typeof dialog?.profileName === 'string' ? dialog.profileName : ''
  return h(
    'div',
    { class: 'dsg-profile-dialog', 'data-testid': 'session-groups-profile-rename-dialog' },
    current !== '' ? h('div', { class: 'dsg-profile-dialog-target' }, current) : null,
    h('label', { class: 'dsg-profile-dialog-label', for: 'dsg-profile-rename-name' }, t('profiles.nameLabel')),
    h('input', {
      ref: inputRef,
      id: 'dsg-profile-rename-name',
      type: 'text',
      class: 'dsg-dialog-input',
      'data-testid': 'session-groups-profile-rename-name',
      value: value ?? '',
      maxlength: String(PROFILE_NAME_MAX),
      placeholder: t('profiles.namePlaceholder'),
      autocomplete: 'off',
      spellcheck: 'false',
      onChange: (event) => onValueChange?.(event.target.value),
      onKeyDown: (event) => onKeyDown?.(event),
    })
  )
}

/**
 * Archive confirmation (SPEC §5.7/§9.5): copy states that the switch list hides
 * the profile, the file is kept and no session is deleted. The confirm button is
 * never the initial focus (DialogHost focuses the first focusable = Cancel).
 */
const ProfileArchiveBody = ({ t, dialog }) => {
  const name = typeof dialog?.profileName === 'string' ? dialog.profileName : ''
  return h(
    'div',
    { class: 'dsg-profile-dialog', 'data-testid': 'session-groups-profile-archive-dialog' },
    name !== '' ? h('div', { class: 'dsg-profile-dialog-target' }, name) : null,
    h('div', { class: 'dsg-dialog-body' }, t('profiles.archiveConfirm'))
  )
}

/**
 * Manage list (SPEC §9.5): unarchived rows are editable, archived rows stay
 * read-only. Archive is disabled for the active/default/last profile; the top
 * row shows `x/20` and the bottom checkbox restores the switch preview.
 */
const ProfileManageBody = ({ store, t, storage }) => {
  const profiles = store?.profiles ?? {}
  const activeId = profiles.activeId ?? store?.profileId ?? null
  const list = unarchivedProfiles(profiles)
  const archived = archivedProfiles(profiles)
  const max = Number.isInteger(profiles.limits?.max) ? profiles.limits.max : MAX_PROFILES
  const canArchiveAnother = list.length > 1
  const rows = []
  const manageRow = (profile, isArchived) => {
    const id = typeof profile?.id === 'string' ? profile.id : ''
    const active = id !== '' && id === activeId
    const archiveBlocked = isArchived ? false : !canArchiveAnother || id === DEFAULT_PROFILE_ID || active
    // The last unarchived profile cannot be archived. Use the real cap, not
    // `list.length` (which would render "Up to 1 profiles" next to the disabled
    // button); no new locale key is introduced.
    const archiveTitle = active
      ? t('profiles.current')
      : id === DEFAULT_PROFILE_ID
        ? t('profiles.defaultName')
        : !canArchiveAnother
          ? t('profiles.limit', { max })
          : t('profiles.archiveConfirm')
    const updated = rt()?.formatAbsoluteTime?.(profile?.updatedAt) ?? profile?.updatedAt ?? null
    rows.push(
      h(
        'div',
        {
          key: `manage-${id || rows.length}`,
          class: 'dsg-profile-manage-row',
          'data-testid': 'session-groups-profile-manage-row',
          'data-profile-id': id,
          'data-active': active ? 'true' : 'false',
          'data-archived': isArchived ? 'true' : 'false',
        },
        h(
          'div',
          { class: 'dsg-profile-manage-main' },
          h('span', { class: 'dsg-profile-manage-name' }, profileDisplayName(profile, t)),
          active
            ? h(
                'span',
                {
                  class: 'dsg-profile-manage-badge',
                  'data-testid': 'session-groups-profile-manage-current',
                },
                t('profiles.current')
              )
            : null,
          isArchived
            ? h(
                'span',
                {
                  class: 'dsg-profile-manage-badge',
                  'data-testid': 'session-groups-profile-manage-archived',
                },
                t('profiles.archived')
              )
            : null,
          h(
            'span',
            { class: 'dsg-profile-manage-counts' },
            t('profiles.counts', {
              groups: profile?.groupCount ?? 0,
              sessions: profile?.sessionCount ?? 0,
              n: profile?.groupCount ?? 0,
            })
          ),
          updated
            ? h(
                'span',
                { class: 'dsg-profile-manage-updated', 'data-testid': 'session-groups-profile-manage-updated' },
                updated
              )
            : null
        ),
        isArchived
          ? null
          : h(
              'div',
              { class: 'dsg-profile-manage-actions' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'dsg-text-button',
                  'data-testid': 'session-groups-profile-rename',
                  'data-profile-id': id,
                  title: t('profiles.rename'),
                  onClick: (event) => {
                    event.stopPropagation()
                    openRename(id, { t })
                  },
                },
                t('profiles.rename')
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'dsg-text-button',
                  'data-testid': 'session-groups-profile-archive',
                  'data-profile-id': id,
                  title: archiveTitle,
                  ...(archiveBlocked ? { disabled: true, 'data-disabled': 'true' } : {}),
                  onClick: (event) => {
                    event.stopPropagation()
                    if (archiveBlocked) return
                    openArchive(id, { t })
                  },
                },
                t('profiles.archive')
              )
            )
      )
    )
  }
  for (const profile of list) manageRow(profile, false)
  for (const profile of archived) manageRow(profile, true)
  return h(
    'div',
    { class: 'dsg-profile-manage', 'data-testid': 'session-groups-profile-manage-dialog' },
    h(
      'div',
      { class: 'dsg-profile-manage-header' },
      h(
        'span',
        {
          class: 'dsg-profile-manage-count',
          'data-testid': 'session-groups-profile-manage-count',
          title: t('profiles.limit', { max }),
        },
        `${list.length}/${max}`
      )
    ),
    rows.length > 0 ? h('div', { class: 'dsg-profile-manage-list' }, ...rows) : h('div', { class: 'dsg-profile-empty' }, t('profiles.empty')),
    h(
      'label',
      { class: 'dsg-profile-manage-reset' },
      h('input', {
        type: 'checkbox',
        defaultChecked: readProfilePreviewDisabled(storage),
        'data-testid': 'session-groups-profile-preview-reset',
        onChange: (event) => writeProfilePreviewDisabled(event.target.checked === true, storage),
      }),
      h('span', null, t('profiles.preview.disable'))
    )
  )
}

export {
  PROFILE_NAME_MAX,
  profileDisplayName,
  unarchivedProfiles,
  archivedProfiles,
  validateProfileName,
  cloneName,
  saveAsCounts,
  createProfileDialogHandlers,
  openSaveAs,
  openManage,
  openRename,
  openArchive,
  confirmSaveAs,
  confirmRename,
  confirmArchive,
  ProfileSaveAsBody,
  ProfileRenameBody,
  ProfileArchiveBody,
  ProfileManageBody,
}
