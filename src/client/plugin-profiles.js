/**
 * Client profile controller (SPEC §7.1-§7.7/§9.4/§9.5).
 *
 * Owns the profile domain: registry list refreshes (incl. the manage dialog's
 * archived opt-in read), the read-only preview fetch, activation, create /
 * rename / archive writes, the passive switch notice and the local view resets
 * registered for a switch. Nothing here renders or touches the host directly;
 * every HTTP call goes through the injected `api` adapter.
 *
 * State ownership (SPEC §6.1): the list in-flight slots and their request
 * sequence counters, the local switch target (suppresses our own SSE `active`
 * echo), the save-as create flag and the reset-listener set live here.
 */
import { diffDocs } from '../core/profile-diff.js'

/**
 * Create the profile controller.
 *
 * @param {object} options
 * @param {object} options.store view store (getSnapshot/dispatch)
 * @param {object} options.api HTTP adapter (list/preview/activate/create/…)
 * @param {Function} options.notify toast bridge owned by the composition root
 * @param {Function} options.t active translator
 * @param {object} options.documentSync document controller (`isPending`)
 * @param {{ trace: Function }} options.diag diagnostics trace bridge
 * @param {() => string[]} options.liveSessionIds live session ids for the diff
 * @param {Function} options.failDialog attach an inline dialog error
 */
export const createProfileController = ({ store, api, notify, t, documentSync, diag, liveSessionIds, failDialog }) => {
  let profilesPromise = null
  /** Separate in-flight slot for the manage dialog's archived opt-in read. */
  let profilesArchivedPromise = null
  /** Sequence per slot: a forced read must not let its older response win. */
  let profilesRequestId = 0
  let profilesArchivedRequestId = 0
  /** Target of the local activate request (suppresses our own SSE `active`). */
  let profileSwitchTarget = null
  /**
   * A save-as create activates its copy host-side before the HTTP response
   * lands (SPEC §5.5/§9.4). While the request runs, its `active` echo is a local
   * switch, not "another window switched": suppressing it avoids a bogus
   * `switchedElsewhere` toast and a redundant `/load`; the create response's
   * own `profile-switch-success` does the read instead.
   */
  let createInFlight = false
  /** SPEC §7.3 local resets (search/drag/scroll/selection/…) registered by S6. */
  const profileResetListeners = new Set()

  // --- profile data (SPEC §7.1-§7.7) ----------------------------------------
  /**
   * Load the registry-backed profile list. A non-JSON 404 means the host has no
   * profile surface at all (SPEC §7.7): flip `profiles.available` and keep the
   * single-profile behaviour without touching the main view.
   *
   * `includeArchived` (SPEC §5.3/§9.5) is the manage dialog's opt-in read; it
   * uses its own in-flight slot so it can never be deduped behind a background
   * switcher refresh and silently lose the archived rows.
   *
   * `force` starts a new read even when one is in flight and drops that older
   * response when it lands (`requestId`): after an archive (SPEC §5.7) the
   * pre-write read would otherwise repopulate the row this write just removed.
   */
  const refreshProfiles = ({ background = false, includeArchived = false, force = false } = {}) => {
    const inFlight = includeArchived ? profilesArchivedPromise : profilesPromise
    if (!force && inFlight !== null) return inFlight
    if (includeArchived) profilesArchivedRequestId += 1
    else profilesRequestId += 1
    const requestId = includeArchived ? profilesArchivedRequestId : profilesRequestId
    if (!background) store.dispatch('profiles-loading')
    const promise = (async () => {
      const result = await api.listProfiles({ includeArchived })
      // A forced read superseded this one; its rows are older than the write
      // that triggered the force, so publishing them would resurrect stale rows.
      if (requestId !== (includeArchived ? profilesArchivedRequestId : profilesRequestId)) {
        diag.trace('profiles.list.stale', { includeArchived, requestId })
        return result
      }
      if (result.ok === true) {
        store.dispatch('profiles-success', {
          registryRevision: result.registryRevision,
          activeId: result.activeId,
          degraded: result.degraded === true,
          list: result.profiles,
          limits: result.limits,
          includeArchived,
        })
      } else if (result.profilesAvailable === false) {
        store.dispatch('profiles-unavailable')
      } else {
        store.dispatch('profiles-error', { code: result.code, message: result.message })
      }
      return result
    })().finally(() => {
      if (includeArchived) {
        if (profilesArchivedPromise === promise) profilesArchivedPromise = null
      } else if (profilesPromise === promise) {
        profilesPromise = null
      }
    })
    if (includeArchived) profilesArchivedPromise = promise
    else profilesPromise = promise
    return promise
  }

  /**
   * SPEC §7.5: another window switched the active profile. The change router
   * suppresses this for a local switch (`isLocalSwitch`); here the refreshed
   * list resolves the human name for the passive toast.
   */
  const announcePassiveSwitch = (activeId) => {
    refreshProfiles({ background: true }).then((result) => {
      const profiles = Array.isArray(result?.profiles) ? result.profiles : []
      const profile = profiles.find((entry) => entry?.id === activeId)
      const name = typeof profile?.name === 'string' && profile.name !== '' ? profile.name : activeId
      notify({ kind: 'info', message: t('profiles.switchedElsewhere', { name }) })
    })
  }

  /**
   * Fetch one profile preview and store the doc/diff/token the switch dialog
   * needs. Confirmation (`activateProfile`) consumes the same token, so the
   * host's TOCTOU check covers the whole user think-time.
   */
  const previewProfile = async (id) => {
    if (typeof id !== 'string' || id === '') return { ok: false, code: 'invalid-profile-id' }
    const epochAtStart = store.getSnapshot().profileEpoch
    store.dispatch('profile-preview-start', { targetId: id })
    const result = await api.previewProfile(id)
    if (store.getSnapshot().profileEpoch !== epochAtStart) {
      diag.trace('profile.preview.stale', { targetId: id, reason: 'profile-epoch' })
      return { ...result, ok: false, code: 'profile-changed' }
    }
    if (result.ok !== true) {
      store.dispatch('profile-preview-error', { code: result.code, message: result.message })
      return result
    }
    const current = store.getSnapshot()
    const diff = diffDocs(current.doc, result.doc, liveSessionIds())
    store.dispatch('profile-preview-success', {
      targetId: result.profile?.id ?? id,
      targetName: result.profile?.name ?? null,
      targetRevision: result.revision,
      previewToken: result.previewToken,
      doc: result.doc,
      diff,
      baseActiveId: result.activeId ?? null,
      baseActiveRevision: result.activeRevision ?? null,
    })
    return result
  }

  /**
   * Activate a previewed profile (SPEC §7.4 step 6/7). The local target
   * suppresses our own SSE `active` echo; the response supplies the doc and its
   * revision becomes the next commit base. Failure keeps the current profile.
   */
  const activateProfile = async ({ id, previewToken } = {}) => {
    if (typeof id !== 'string' || id === '') return { ok: false, code: 'invalid-profile-id' }
    const epochAtStart = store.getSnapshot().profileEpoch
    profileSwitchTarget = id
    store.dispatch('profile-switch-start', { targetId: id })
    let result
    try {
      result = await api.activateProfile({ id, previewToken })
    } catch (error) {
      result = { ok: false, code: 'network', message: String(error?.message ?? error) }
    } finally {
      if (profileSwitchTarget === id) profileSwitchTarget = null
    }
    const snapshot = store.getSnapshot()
    // Another window switched while this activate was in flight: the router
    // already reset/reloaded the view, so applying this stale response would
    // stomp newer state. Report it as superseded instead.
    const superseded =
      snapshot.profileEpoch !== epochAtStart &&
      snapshot.profileId !== id &&
      snapshot.profiles.activeId !== id
    if (superseded) {
      diag.trace('profile.activate.superseded', { targetId: id, activeId: snapshot.profiles.activeId })
      return { ...result, superseded: true }
    }
    if (result?.ok === true) {
      store.dispatch('profile-switch-success', {
        profileId: result.activeId ?? id,
        doc: result.doc,
        revision: result.doc?.revision,
        registryRevision: result.registryRevision,
      })
      refreshProfiles({ background: true })
      return result
    }
    store.dispatch('profile-switch-failure', { code: result?.code, message: result?.message })
    return result
  }

  /**
   * SPEC §9.4/§9.5: profile-write errors become inline dialog copy. Codes the
   * host emits for these routes map onto the existing translated keys; there is
   * no dedicated locale string for `profile-in-use`/`conflict`/io, so they fall
   * back to the generic "could not complete" copy.
   */
  const profileDialogError = (code) => {
    if (code === 'profile-name-invalid') return 'profiles.nameInvalid'
    if (code === 'profile-name-duplicate') return 'profiles.nameDuplicate'
    if (code === 'profile-limit') return 'profiles.limit'
    if (code === 'registry-unhealthy' || code === 'profile-unhealthy') return 'profiles.degraded'
    return 'profiles.saveFailed'
  }

  const profileDialogErrorParams = (code) =>
    code === 'profile-limit' ? { max: store.getSnapshot().profiles.limits?.max ?? 20 } : null

  /** Close the rename/archive dialog but keep the manage list (SPEC §9.5). */
  const reopenProfileManage = () => {
    store.dispatch('dialog', { dialog: { kind: 'profile-manage', titleKey: 'profiles.title' } })
  }

  /**
   * SPEC §7.4 step 9/10 + §9.2: profile writes are refused while a switch runs
   * or a document write is unsettled. Returns a result instead of throwing so
   * the dialog can keep its inline error surface.
   */
  const profileWriteGuard = () => {
    const snapshot = store.getSnapshot()
    if (snapshot.profileSwitching === true) return { ok: false, code: 'profile-switching' }
    if (documentSync.isPending() === true) {
      notify({ kind: 'info', message: t('profiles.switching') })
      return { ok: false, code: 'pending' }
    }
    return null
  }

  /**
   * SPEC §5.5/§9.4: save-as clones the active document and activates the copy.
   * Success reuses the switch reset (`profile-switch-success`) because the new
   * profile becomes active; failure keeps the dialog open for inline copy.
   */
  const createProfile = async ({ name } = {}) => {
    const text = typeof name === 'string' ? name.trim() : ''
    if (text === '') {
      failDialog('profiles.nameInvalid')
      return { ok: false, code: 'profile-name-invalid' }
    }
    const guard = profileWriteGuard()
    if (guard !== null) return guard
    const snapshot = store.getSnapshot()
    let result
    createInFlight = true
    try {
      result = await api.createProfile({ name: text, baseRevision: snapshot.profiles.registryRevision })
    } catch (error) {
      result = { ok: false, code: 'network', message: String(error?.message ?? error) }
    } finally {
      // Clear on both paths: a failed create must not keep suppressing later
      // `active` events from other windows (SPEC §7.5).
      createInFlight = false
    }
    if (result?.ok !== true) {
      // A registry CAS loss leaves the local revision stale: refresh so the next
      // confirm attempt uses the current base (SPEC §5.5/§10).
      if (result?.code === 'conflict') refreshProfiles({ background: true })
      failDialog(profileDialogError(result?.code), profileDialogErrorParams(result?.code))
      return result
    }
    const profileName = result.profile?.name ?? text
    store.dispatch('profile-switch-success', {
      profileId: result.activeId ?? result.profile?.id ?? null,
      doc: result.doc,
      revision: result.doc?.revision,
      registryRevision: result.registryRevision,
    })
    // The create response is the only owner of the local switch now that the
    // SSE echo was suppressed: force the list so a read started before the
    // write cannot hide the brand-new profile row.
    refreshProfiles({ background: true, force: true })
    notify({ kind: 'success', message: t('profiles.switched', { name: profileName }) })
    return result
  }

  /** SPEC §5.6/§9.5: rename keeps the manage dialog in view afterwards. */
  const renameProfile = async ({ id, name } = {}) => {
    const text = typeof name === 'string' ? name.trim() : ''
    if (text === '') {
      failDialog('profiles.nameInvalid')
      return { ok: false, code: 'profile-name-invalid' }
    }
    const guard = profileWriteGuard()
    if (guard !== null) return guard
    const snapshot = store.getSnapshot()
    let result
    try {
      result = await api.renameProfile({ id, name: text, baseRevision: snapshot.profiles.registryRevision })
    } catch (error) {
      result = { ok: false, code: 'network', message: String(error?.message ?? error) }
    }
    if (result?.ok !== true) {
      if (result?.code === 'conflict') refreshProfiles({ background: true })
      failDialog(profileDialogError(result?.code), profileDialogErrorParams(result?.code))
      return result
    }
    refreshProfiles({ background: true })
    refreshProfiles({ background: true, includeArchived: true })
    reopenProfileManage()
    notify({ kind: 'success', message: t('toast.saved') })
    return result
  }

  /** SPEC §5.7/§9.5: archive only hides the profile; its file and sessions stay. */
  const archiveProfile = async ({ id } = {}) => {
    const guard = profileWriteGuard()
    if (guard !== null) return guard
    const snapshot = store.getSnapshot()
    let result
    try {
      result = await api.archiveProfile({ id, baseRevision: snapshot.profiles.registryRevision })
    } catch (error) {
      result = { ok: false, code: 'network', message: String(error?.message ?? error) }
    }
    if (result?.ok !== true) {
      if (result?.code === 'conflict') refreshProfiles({ background: true })
      failDialog(profileDialogError(result?.code), profileDialogErrorParams(result?.code))
      return result
    }
    // SPEC §5.7: the archive just changed the registry. A read that started
    // before the write must not win the race and re-show the archived row in
    // the manage list, so both slots are forced; the archived read also moves
    // the row into the read-only section immediately.
    refreshProfiles({ background: true, force: true })
    refreshProfiles({ background: true, includeArchived: true, force: true })
    reopenProfileManage()
    notify({ kind: 'success', message: t('toast.saved') })
    return result
  }

  /** SPEC §7.3 reset hook: S6 registers drag/search/selection/scroll resets. */
  const onProfileSwitchReset = (listener) => {
    if (typeof listener !== 'function') return () => {}
    profileResetListeners.add(listener)
    return () => {
      profileResetListeners.delete(listener)
    }
  }

  /**
   * SPEC §7.3: an active-profile change invalidates every local view reset
   * registered above (the host/root reset the floating label and the pending
   * new-session placement themselves).
   */
  const applyEpoch = () => {
    for (const listener of [...profileResetListeners]) {
      try {
        listener()
      } catch {
        /* one local reset must not block the others */
      }
    }
  }

  /**
   * Local-switch marker for the change router: our own request's SSE `active`
   * echo must not be announced as a passive switch (SPEC §7.5).
   */
  const isLocalSwitch = (activeId) =>
    createInFlight || (profileSwitchTarget !== null && profileSwitchTarget === activeId)

  const dispose = () => {
    profileResetListeners.clear()
    profileSwitchTarget = null
    createInFlight = false
    profilesPromise = null
    profilesArchivedPromise = null
  }

  return {
    refreshProfiles,
    announcePassiveSwitch,
    previewProfile,
    activateProfile,
    createProfile,
    renameProfile,
    archiveProfile,
    onProfileSwitchReset,
    applyEpoch,
    isLocalSwitch,
    dispose,
  }
}
