/**
 * Profile-domain policy for the control surface and the profile routes
 * (SPEC 7.1).
 *
 * Owns the profile-scoped plan hash, the explicit-target resolution used by
 * both the native tool and the HTTP control routes, the read-only storage
 * report attached to doctor responses, the preview TOCTOU token and the
 * client-first display-name checks. Response shapes come from
 * './http/respond.js' and the JSON-object check from './http/wire.js'.
 */
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { hasControlChars } from '../shared/model.js'
import { DEFAULT_PROFILE_ID, MAX_PROFILE_NAME, PROFILES_DIR_NAME, RECORD_FILE_NAME } from './constants.js'
import { isProfileId } from './profile-registry.js'
import { inspectProfileStorage } from './storage-health.js'
import { isObject } from './http/wire.js'
import {
  invalidProfileIdResponse,
  profileHealth,
  profileRequiredResponse,
  profileTargetFailure,
  registryUnhealthyResponse,
} from './http/respond.js'

/**
 * SPEC 6.1: the plan token is scoped to the profile it was built for, so a
 * plan cannot be replayed against another profile. Tool and HTTP share this
 * exact function.
 */
export const controlPlanHash = (profileId, baseRevision, operations) =>
  createHash('sha256').update(JSON.stringify({ profileId, baseRevision, operations })).digest('hex')

/**
 * Resolve the profile a control action targets (SPEC 6.1).
 *
 * Shared by the native tool and the HTTP control routes so the policy cannot
 * drift:
 * - `state`/`resolve` may omit `profileId` (the active profile is used);
 * - `plan`/`apply` must pass it unless exactly one profile is unarchived;
 * - an explicit target does not have to be the active one (AI reads/writes a
 *   named profile explicitly; no action ever switches the active profile);
 * - registry health, membership and archived state come from one registry
 *   snapshot; the store is only chosen after those checks pass;
 * - named profiles are health-checked read-only (`peek`), never via `load`,
 *   so a control read cannot quarantine a document.
 *
 * @param {object} profileManager manager (or the legacy single-store view)
 * @param {string|undefined} requestedProfileId
 * @param {{ requireExplicitWhenMultiple?: boolean }} [options]
 * @returns {Promise<
 *   | { ok: true, profileId: string, activeId: string, activeProfile: { id: string, name: string|null }, entry: object, registryRevision: number, store: object }
 *   | { ok: false, status: number, body: object }
 * >}
 */
export const resolveControlProfile = async (profileManager, requestedProfileId, options = {}) => {
  if (requestedProfileId !== undefined && (typeof requestedProfileId !== 'string' || !isProfileId(requestedProfileId))) {
    return { ok: false, ...invalidProfileIdResponse() }
  }
  const registryState = await profileManager.loadRegistry()
  if (registryState?.degraded === true) return { ok: false, ...registryUnhealthyResponse() }
  if (registryState?.kind !== 'ok') {
    return {
      ok: false,
      status: 503,
      body: { ok: false, code: 'io', message: 'profile registry is unavailable' },
    }
  }
  const registry = registryState.registry
  const unarchived = registry.profiles.filter((profile) => profile.archivedAt === null)
  if (requestedProfileId === undefined && options.requireExplicitWhenMultiple === true && unarchived.length > 1) {
    return { ok: false, ...profileRequiredResponse(unarchived.length) }
  }
  const profileId = requestedProfileId ?? registry.activeId
  const entry = registry.profiles.find((profile) => profile.id === profileId) ?? null
  if (entry === null) return { ok: false, ...profileTargetFailure('profile-missing', profileId) }
  if (entry.archivedAt !== null) return { ok: false, ...profileTargetFailure('profile-archived', profileId) }
  if (profileId !== DEFAULT_PROFILE_ID) {
    const peek = await profileManager.peekFor(profileId)
    if (peek.kind !== 'ok') {
      const code = peek.kind === 'missing' ? 'profile-missing' : 'profile-unhealthy'
      return { ok: false, ...profileTargetFailure(code, profileId, profileHealth(peek)) }
    }
  }
  const activeEntry = registry.profiles.find((profile) => profile.id === registry.activeId) ?? null
  return {
    ok: true,
    profileId,
    activeId: registry.activeId,
    activeProfile: { id: registry.activeId, name: activeEntry?.name ?? null },
    entry,
    registryRevision: registryState.revision,
    store: profileManager.storeFor(profileId),
  }
}

/** Public doctor row for one profile document (SPEC 6.1). */
const profileDoctorRow = (profile, storageDir) => {
  const directory = profile.id === DEFAULT_PROFILE_ID ? storageDir : join(storageDir, PROFILES_DIR_NAME, profile.id)
  const quarantined = Number.isInteger(profile.quarantined) ? profile.quarantined : 0
  return {
    id: profile.id,
    name: profile.name ?? null,
    archived: profile.archived === true,
    healthy: profile.healthy === true,
    status: profile.status,
    revision: Number.isInteger(profile.revision) ? profile.revision : null,
    backupStatus: profile.backupStatus,
    // `storage-health` only counts the quarantine family; the row carries the
    // directory + name pattern plus a human note instead of inventing a path.
    quarantinedTo:
      quarantined > 0
        ? join(directory, `${basename(RECORD_FILE_NAME, '.json')}.corrupt-*.json`)
        : null,
    quarantined,
    quarantineNote:
      quarantined > 0 ? `${quarantined} quarantined document(s) preserved in ${directory}` : null,
    orphan: profile.orphan === true,
    error: profile.error ?? null,
  }
}

/**
 * Add the read-only profile registry/document report to a doctor response
 * (SPEC 6.1). Uses the storage-health inspector, so nothing is healed,
 * quarantined or written while diagnosing.
 *
 * A legacy single-store manager has no `registryFilePath`; in that case the
 * report is returned unchanged (the frozen direct-route tests keep their shape).
 */
export const withProfileStorage = async (report, profileManager) => {
  if (!isObject(report)) return report
  if (
    !isObject(profileManager) ||
    typeof profileManager.storageDir !== 'string' ||
    typeof profileManager.registryFilePath !== 'string'
  ) {
    return report
  }
  let registry
  let profiles
  try {
    const inspected = await inspectProfileStorage({
      storageDir: profileManager.storageDir,
      registryFilePath: profileManager.registryFilePath,
      defaultRecordPath:
        typeof profileManager.defaultFilePath === 'string' ? profileManager.defaultFilePath : undefined,
    })
    registry = inspected.registry
    profiles = inspected.profiles.map((profile) => profileDoctorRow(profile, profileManager.storageDir))
  } catch (error) {
    return {
      ...report,
      storage: {
        ...(isObject(report.storage) ? report.storage : {}),
        registry: { status: 'unreadable', error: error instanceof Error ? error.message : String(error) },
        profiles: [],
      },
    }
  }
  return {
    ...report,
    storage: {
      ...(isObject(report.storage) ? report.storage : {}),
      registry,
      profiles,
    },
  }
}

/**
 * SPEC 5.4: non-secret TOCTOU token over the active/target/registry revisions.
 * `activeRevision` is `null` when the active document is unhealthy.
 */
export const previewTokenFor = ({ activeId, activeRevision, targetId, targetRevision, registryRevision }) =>
  createHash('sha256')
    .update(JSON.stringify({ activeId, activeRevision, targetId, targetRevision, registryRevision }))
    .digest('hex')

/**
 * Validate a profile display name before a doc-first create writes an orphan.
 * The registry re-validates under its CAS lock, so this is a pre-check only.
 *
 * @returns {{ ok: true, name: string } | { ok: false, reason: string }}
 */
export const normalizeProfileNameInput = (name) => {
  if (typeof name !== 'string') return { ok: false, reason: 'name-required' }
  const text = name.trim()
  if (text.length === 0) return { ok: false, reason: 'name-required' }
  if (text.length > MAX_PROFILE_NAME) return { ok: false, reason: 'name-too-long' }
  if (hasControlChars(text)) return { ok: false, reason: 'name-control-chars' }
  return { ok: true, name: text }
}

/** Case-insensitive duplicate check over the unarchived profiles (SPEC 4.3). */
export const profileNameTaken = (registry, name, exceptId = null) => {
  const key = name.trim().toLowerCase()
  return registry.profiles.some(
    (profile) =>
      profile.archivedAt === null &&
      profile.id !== exceptId &&
      typeof profile.name === 'string' &&
      profile.name.trim().toLowerCase() === key,
  )
}
