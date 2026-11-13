/**
 * Read-only storage health inspection for the compatibility doctor.
 *
 * Deliberately does not use the store: `load()` quarantines a corrupt record
 * and creates a new file, which a diagnostic must never do. This module only
 * reads the record, its `.bak`, and the quarantine family.
 */
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { DOC_VERSION } from '../shared/constants.js'
import { normalizeColorHex, validateDoc } from '../shared/model.js'
import {
  DEFAULT_PROFILE_ID,
  PROFILES_DIR_NAME,
  RECORD_FILE_NAME,
  REGISTRY_FILE_NAME,
} from './constants.js'
import { classifyRegistryText, isProfileId } from './profile-registry.js'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const normalizeGroups = (groups) =>
  Array.isArray(groups)
    ? groups.map((group) => {
        if (!isObject(group) || group.colorHex === undefined) return group
        const hex = normalizeColorHex(group.colorHex)
        return hex && hex !== group.colorHex ? { ...group, colorHex: hex } : group
      })
    : groups

/**
 * Classify one record body without touching the filesystem.
 * @param {string} text
 * @returns {{status: string, revision: number|null, error: string|null}}
 */
const classifyText = (text) => {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { status: 'corrupt', revision: null, error: error instanceof Error ? error.message : String(error) }
  }
  if (!isObject(parsed)) {
    return { status: 'corrupt', revision: null, error: 'document is not a JSON object' }
  }
  const revision = Number.isInteger(parsed.revision) ? parsed.revision : null
  if (typeof parsed.version === 'number' && parsed.version > DOC_VERSION) {
    return {
      status: 'unsupported-version',
      revision,
      error: `document version ${String(parsed.version)} is newer than ${String(DOC_VERSION)}`,
    }
  }
  if (parsed.version !== DOC_VERSION) {
    return { status: 'invalid', revision, error: `version must be ${String(DOC_VERSION)}` }
  }
  const verdict = validateDoc({ ...parsed, groups: normalizeGroups(parsed.groups) })
  if (!verdict.ok) return { status: 'invalid', revision, error: verdict.errors.join('; ') }
  return { status: 'ok', revision, error: null }
}

/**
 * Inspect the optional backup without mutating it.
 * @param {string} path
 */
const inspectFile = async (path) => {
  try {
    return { exists: true, ...classifyText(await readFile(path, 'utf8')) }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, status: 'missing', revision: null, error: null }
    }
    return {
      exists: true,
      status: 'unreadable',
      revision: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Inspect one record path without mutating anything.
 *
 * `backup` is kept as a boolean for backward compatibility; `backupStatus`,
 * `backupRevision` and `backupError` describe whether that backup is usable.
 *
 * @param {string} filePath
 * @returns {Promise<{
 *   status: string,
 *   revision: number|null,
 *   error: string|null,
 *   backup: boolean,
 *   backupStatus: string,
 *   backupRevision: number|null,
 *   backupError: string|null,
 *   quarantined: number
 * }>}
 */
export const inspectStorageHealth = async (filePath) => {
  const directory = dirname(filePath)
  const result = {
    status: 'missing',
    revision: null,
    error: null,
    backup: false,
    backupStatus: 'missing',
    backupRevision: null,
    backupError: null,
    quarantined: 0,
  }

  const backup = await inspectFile(`${filePath}.bak`)
  result.backup = backup.exists
  result.backupStatus = backup.status
  result.backupRevision = backup.revision
  result.backupError = backup.error

  try {
    const prefix = `${basename(filePath, '.json')}.corrupt-`
    const entries = await readdir(directory)
    result.quarantined = entries.filter((name) => name.startsWith(prefix) && name.endsWith('.json')).length
  } catch {
    result.quarantined = 0
  }

  const primary = await inspectFile(filePath)
  result.status = primary.status
  result.revision = primary.revision
  result.error = primary.error
  return result
}

const errorText = (error) => (error instanceof Error ? error.message : String(error))

/** Registry statuses that make profile writes answer `registry-unhealthy`. */
const DEGRADED_REGISTRY_STATUSES = new Set(['corrupt', 'invalid', 'unsupported-version', 'unreadable'])

/**
 * Map the canonical registry verdict onto the doctor report shape.
 *
 * Explicit fallbacks keep the frozen report contract (`revision: number|null`,
 * `activeId: string|null`, `profileCount: number`, `error: string|null`,
 * `registry: object|null`) independent of classifier internals: the
 * classification-only fields (`kind`, `detail`, `version`) are never spread
 * into the report.
 *
 * @param {ReturnType<typeof classifyRegistryText>} verdict
 * @returns {{
 *   status: 'ok'|'corrupt'|'unsupported-version'|'invalid',
 *   revision: number|null,
 *   activeId: string|null,
 *   profileCount: number,
 *   error: string|null,
 *   registry: object|null
 * }}
 */
const registryHealthFromVerdict = (verdict) => ({
  status: verdict.kind,
  revision: verdict.revision ?? null,
  activeId: verdict.activeId ?? null,
  profileCount: verdict.profileCount ?? 0,
  error: verdict.kind === 'ok' ? null : verdict.detail,
  registry: verdict.kind === 'ok' ? verdict.registry : null,
})

/** Read one registry file (or its absence) without mutating it. */
const inspectRegistryFile = async (path) => {
  try {
    return { exists: true, ...registryHealthFromVerdict(classifyRegistryText(await readFile(path, 'utf8'))) }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        exists: false,
        status: 'missing',
        revision: null,
        activeId: null,
        profileCount: 0,
        error: null,
        registry: null,
      }
    }
    return {
      exists: true,
      status: 'unreadable',
      revision: null,
      activeId: null,
      profileCount: 0,
      error: errorText(error),
      registry: null,
    }
  }
}

/** Inspect the live registry, its `.bak`, and its quarantine family read-only. */
const inspectRegistryFamily = async (filePath) => {
  const backup = await inspectRegistryFile(`${filePath}.bak`)
  let quarantined = 0
  try {
    const prefix = `${basename(filePath, '.json')}.corrupt-`
    const entries = await readdir(dirname(filePath))
    quarantined = entries.filter((name) => name.startsWith(prefix) && name.endsWith('.json')).length
  } catch {
    quarantined = 0
  }
  const primary = await inspectRegistryFile(filePath)
  return { primary, backup, quarantined }
}

const registryHealthOf = ({ primary, backup, quarantined }) => ({
  status: primary.status,
  revision: primary.revision,
  activeId: primary.activeId,
  profileCount: primary.profileCount,
  degraded: DEGRADED_REGISTRY_STATUSES.has(primary.status),
  error: primary.error,
  backup: backup.exists,
  backupStatus: backup.status,
  backupRevision: backup.revision,
  backupError: backup.error,
  quarantined,
})

/**
 * Inspect `dsh-session-grove.profiles.json` read-only.
 * @param {string} filePath
 */
const inspectProfileRegistry = async (filePath) => registryHealthOf(await inspectRegistryFamily(filePath))

const listProfileDirs = async (profilesDir) => {
  try {
    const entries = await readdir(profilesDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && isProfileId(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

/**
 * Inspect the registry plus every profile document read-only (SPEC 4.8/6.1).
 *
 * Profiles come from the registry when it is parseable; otherwise every
 * `profiles/<id>/` directory is listed and flagged as an orphan. The default
 * profile is always reported. No file is created, moved, or quarantined.
 *
 * @param {{ storageDir: string, registryFilePath?: string, defaultRecordPath?: string }} options
 */
const inspectProfileStorage = async (options = {}) => {
  const { storageDir, registryFilePath, defaultRecordPath } = options
  if (typeof storageDir !== 'string' || storageDir.length === 0) {
    throw new Error('inspectProfileStorage: storageDir is required')
  }
  const root = resolve(storageDir)
  const registryPath = resolve(registryFilePath ?? join(root, REGISTRY_FILE_NAME))
  const defaultPath = resolve(defaultRecordPath ?? join(root, RECORD_FILE_NAME))
  const profilesDir = join(root, PROFILES_DIR_NAME)

  const family = await inspectRegistryFamily(registryPath)
  const registry = registryHealthOf(family)
  const registered =
    family.primary.status === 'ok' && family.primary.registry !== null ? family.primary.registry.profiles : []
  const known = new Map(registered.map((profile) => [profile.id, profile]))
  const onDisk = await listProfileDirs(profilesDir)

  const profiles = []
  const seen = new Set()
  const add = async (id, entry, orphan) => {
    if (seen.has(id)) return
    seen.add(id)
    const filePath = id === DEFAULT_PROFILE_ID ? defaultPath : join(profilesDir, id, RECORD_FILE_NAME)
    const health = await inspectStorageHealth(filePath)
    profiles.push({
      id,
      name: typeof entry?.name === 'string' ? entry.name : null,
      archived: entry?.archivedAt != null,
      healthy: health.status === 'ok',
      status: health.status,
      revision: health.revision,
      error: health.error,
      backupStatus: health.backupStatus,
      quarantined: health.quarantined,
      orphan,
    })
  }

  await add(
    DEFAULT_PROFILE_ID,
    known.get(DEFAULT_PROFILE_ID) ?? { id: DEFAULT_PROFILE_ID, name: null, archivedAt: null },
    false,
  )
  for (const profile of registered) {
    if (profile.id !== DEFAULT_PROFILE_ID) await add(profile.id, profile, false)
  }
  for (const id of onDisk) {
    if (id !== DEFAULT_PROFILE_ID && !known.has(id)) await add(id, { id, name: null, archivedAt: null }, true)
  }
  return { registry, profiles }
}

export { inspectProfileRegistry, inspectProfileStorage }
