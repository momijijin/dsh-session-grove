/**
 * Profile switch orchestration (SPEC §7.4/§9.2-§9.5).
 *
 * Owns the switch sequence: preview → activate → undo/recover, the preview
 * dialog's confirm/cancel actions and the handler facade exposed to GroupsView.
 * Every HTTP call goes through the runtime bridge ('previewProfile'/
 * 'activateProfile') of the S5 data layer; this module never talks to the host
 * directly.
 *
 * The snapshot, diff and copy helpers at the top are shared with the preview
 * dialog and switcher modules; they live here so the module graph stays acyclic
 * ('profile-preview'/'profile-switcher' → 'profile-switch').
 */
import { clientRuntime as rt } from '../adapters/client-runtime.js'
import { sameDocs } from '../core/profile-diff.js'
import { readProfilePreviewDisabled } from './profile-storage.js'

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

// Snapshot, copy and empty-diff helpers are shared with the sibling profile
// modules; they are exported here instead of being duplicated.
export {
  isPreviewDiffEmpty,
  profileFailureMessage,
  activeProfileIdOf,
  profileNameOf,
  profileLabel,
  createProfileHandlers,
  beginProfileSwitch,
  confirmProfilePreview,
  cancelProfilePreview,
  undoProfileSwitch,
  recoverProfile,
}
