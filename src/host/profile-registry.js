/**
 * Profile registry: the multi-profile index stored next to the default record.
 *
 * Schema/invariants: SPEC 4.3 (registry version 1). Layout: SPEC 4.1.
 *
 * - missing file -> in-memory synthesized `default` registry at revision 0;
 *   nothing is written until the first mutation (which writes revision 1);
 * - corrupt/invalid/unsupported registry -> prefer a valid `.bak`; otherwise
 *   quarantine the untrusted file as
 *   `dsh-session-grove.profiles.corrupt-<ts>.json` and enter `degraded`
 *   (profile writes answer `registry-unhealthy`). The trusted file is never
 *   overwritten in place;
 * - write path mirrors the document store: unique temp -> fsync -> previous
 *   copy to `.bak` -> rename -> directory fsync, with Windows EPERM/EBUSY
 *   retries (both halves shared via `src/host/atomic-write.js`);
 * - every mutation runs on one promise tail plus a cross-process `.lock`
 *   (same PID/mtime reclaim policy as `store.js`, shared via
 *   `src/host/file-lock.js`); non-activate mutations use the caller-owned
 *   `baseRevision` as CAS;
 * - `peek()` is read-only: no tail, no lock, no write, no quarantine. It is the
 *   path used by doctor/storage-health.
 */

import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { normalizeProfileName, profileNameTaken } from '../shared/profile-name.js'
import {
  pathExists,
  quarantineTimestamp,
  syncDirectory,
  temporaryPathForWrite,
  withRetries,
} from './atomic-write.js'
import {
  DEFAULT_PROFILE_ID,
  MAX_PROFILES,
  PROFILES_DIR_NAME,
  REGISTRY_VERSION,
} from './constants.js'
import { LOCK_RETRY_MS, LOCK_STALE_MS, LOCK_WAIT_MS, createFileLock } from './file-lock.js'

/** SPEC 4.3: lowercase id, 3-64 chars, starts alphanumeric. */
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const clone = (value) => JSON.parse(JSON.stringify(value))

const errorMessage = (error) => (error instanceof Error ? error.message : String(error))

const isIsoTimestamp = (value) =>
  typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))

/** A profile id is usable only when it matches the frozen format. */
const isProfileId = (value) => typeof value === 'string' && PROFILE_ID_RE.test(value)

/** Registry `dir` value derived from the id ('.' for default, forward slashes). */
const profileDirFor = (id) => (id === DEFAULT_PROFILE_ID ? '.' : `${PROFILES_DIR_NAME}/${id}`)

/** Registry validation wrapper: `null` is allowed only for the default profile. */
const profileNameError = (name, { allowNull = false } = {}) => {
  if (name === null && allowNull) return null
  const result = normalizeProfileName(name)
  return result.ok ? null : result.reason
}

/** In-memory default registry used when the file is absent (never written). */
const defaultRegistry = (now = () => Date.now()) => {
  const stamp = new Date(now()).toISOString()
  return {
    version: REGISTRY_VERSION,
    revision: 0,
    activeId: DEFAULT_PROFILE_ID,
    profiles: [
      {
        id: DEFAULT_PROFILE_ID,
        name: null,
        dir: '.',
        createdAt: stamp,
        updatedAt: stamp,
        archivedAt: null,
      },
    ],
  }
}

/**
 * Validate the frozen registry schema/invariants (SPEC 4.3). The same validator
 * guards reads (quarantine policy) and writes (never persist an invalid index).
 * @returns {{ ok: boolean, errors: string[] }}
 */
const validateRegistry = (registry) => {
  const errors = []
  if (!isObject(registry)) return { ok: false, errors: ['registry-not-object'] }
  if (registry.version !== REGISTRY_VERSION) errors.push('version')
  if (!Number.isInteger(registry.revision) || registry.revision < 0) errors.push('revision')
  if (typeof registry.activeId !== 'string' || registry.activeId === '') errors.push('active-id')
  if (!Array.isArray(registry.profiles)) errors.push('profiles')
  if (errors.length > 0) return { ok: false, errors }

  const ids = new Set()
  const activeNames = new Set()
  let defaultCount = 0
  let unarchivedCount = 0
  for (const profile of registry.profiles) {
    if (!isObject(profile)) {
      errors.push('profile-not-object')
      continue
    }
    const id = profile.id
    if (!isProfileId(id)) {
      errors.push(`profile-id:${String(id)}`)
    } else if (ids.has(id)) {
      errors.push(`duplicate-profile-id:${id}`)
    } else {
      ids.add(id)
    }
    if (id === DEFAULT_PROFILE_ID) {
      defaultCount += 1
      if (profile.dir !== '.') errors.push(`profile-dir:${DEFAULT_PROFILE_ID}`)
      if (profile.archivedAt !== null) errors.push(`profile-archived:${DEFAULT_PROFILE_ID}`)
    } else if (profile.dir !== profileDirFor(id)) {
      errors.push(`profile-dir:${String(id)}`)
    }
    const nameError = profileNameError(profile.name, { allowNull: id === DEFAULT_PROFILE_ID })
    if (nameError !== null) errors.push(`profile-name:${String(id)}:${nameError}`)
    if (!isIsoTimestamp(profile.createdAt)) errors.push(`profile-created-at:${String(id)}`)
    if (!isIsoTimestamp(profile.updatedAt)) errors.push(`profile-updated-at:${String(id)}`)
    if (profile.archivedAt !== null && !isIsoTimestamp(profile.archivedAt)) {
      errors.push(`profile-archived-at:${String(id)}`)
    }
    if (profile.archivedAt === null) {
      unarchivedCount += 1
      if (typeof profile.name === 'string') {
        const key = profile.name.trim().toLowerCase()
        if (activeNames.has(key)) errors.push(`duplicate-profile-name:${key}`)
        else activeNames.add(key)
      }
    }
  }
  if (defaultCount !== 1) errors.push('default-profile')
  if (unarchivedCount > MAX_PROFILES) errors.push('profile-limit')
  const active = registry.profiles.find((profile) => isObject(profile) && profile.id === registry.activeId)
  if (active === undefined) errors.push('active-profile-missing')
  else if (active.archivedAt !== null) errors.push('active-profile-archived')
  return { ok: errors.length === 0, errors }
}

/**
 * Classify one registry body without touching the filesystem.
 *
 * Canonical contract shared with `storage-health.js` (spec §7.3): every branch
 * carries `revision`/`activeId`/`profileCount` so a read-only doctor report can
 * map the verdict without re-parsing; `detail` explains every non-`ok` kind and
 * `registry` is the parsed body only for `ok`. The registry read path here
 * consumes `kind`/`detail`/`registry`/`revision` only, so the extra fields
 * change nothing for load/heal.
 *
 * @param {string} text
 * @returns {{
 *   kind: 'ok'|'corrupt'|'unsupported-version'|'invalid',
 *   detail?: string,
 *   version?: number,
 *   registry?: object,
 *   revision: number|null,
 *   activeId: string|null,
 *   profileCount: number,
 * }}
 */
export const classifyRegistryText = (text) => {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      kind: 'corrupt',
      detail: `invalid JSON: ${errorMessage(error)}`,
      revision: null,
      activeId: null,
      profileCount: 0,
    }
  }
  if (!isObject(parsed)) {
    return {
      kind: 'corrupt',
      detail: 'registry is not a JSON object',
      revision: null,
      activeId: null,
      profileCount: 0,
    }
  }
  const revision = Number.isInteger(parsed.revision) ? parsed.revision : null
  const activeId = typeof parsed.activeId === 'string' ? parsed.activeId : null
  const profileCount = Array.isArray(parsed.profiles) ? parsed.profiles.length : 0
  if (typeof parsed.version === 'number' && parsed.version > REGISTRY_VERSION) {
    return {
      kind: 'unsupported-version',
      version: parsed.version,
      detail: `registry version ${String(parsed.version)} is newer than ${String(REGISTRY_VERSION)}`,
      revision,
      activeId,
      profileCount,
    }
  }
  if (parsed.version !== REGISTRY_VERSION) {
    return {
      kind: 'invalid',
      detail: `version must be ${String(REGISTRY_VERSION)} (got ${JSON.stringify(parsed.version)})`,
      revision,
      activeId,
      profileCount,
    }
  }
  const verdict = validateRegistry(parsed)
  if (!verdict.ok) {
    return {
      kind: 'invalid',
      detail: verdict.errors.join('; '),
      revision,
      activeId,
      profileCount,
    }
  }
  return { kind: 'ok', registry: parsed, revision, activeId, profileCount }
}

/**
 * Create the registry accessor over one registry file.
 *
 * @param {{ filePath: string, now?: () => number, lockWaitMs?: number, lockStaleMs?: number, lockRetryMs?: number }} options
 */
const createProfileRegistry = (options = {}) => {
  const {
    filePath,
    now = () => Date.now(),
    lockWaitMs = LOCK_WAIT_MS,
    lockStaleMs = LOCK_STALE_MS,
    lockRetryMs = LOCK_RETRY_MS,
  } = options
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('createProfileRegistry: pass { filePath }')
  }
  const directory = dirname(filePath)
  const backupPath = `${filePath}.bak`
  const lockPath = `${filePath}.lock`

  let tail = Promise.resolve()
  const enqueue = (task) => {
    const run = tail.then(task, task)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Sticky per-process degraded state: writes stay rejected until restart. */
  let degradedState = null

  const { withLock } = createFileLock({
    filePath,
    busyMessage: 'profile registry is busy',
    lockWaitMs,
    lockStaleMs,
    lockRetryMs,
  })

  const quarantinePathFor = async () => {
    const stamp = quarantineTimestamp(now)
    let candidate = join(directory, `${basename(filePath, '.json')}.corrupt-${stamp}.json`)
    for (let suffix = 1; await pathExists(candidate); suffix += 1) {
      candidate = join(directory, `${basename(filePath, '.json')}.corrupt-${stamp}-${suffix}.json`)
    }
    return candidate
  }

  /** Move the untrusted registry aside without deleting its content. */
  const quarantineLiveFile = async () => {
    const target = await quarantinePathFor()
    try {
      await withRetries(() => rename(filePath, target))
      return target
    } catch {
      try {
        await withRetries(() => copyFile(filePath, target))
        await withRetries(() => rm(filePath, { force: true }))
        return target
      } catch {
        // Leaving the untrusted file in place is safer than deleting it; the
        // degraded state still reports the problem.
        return null
      }
    }
  }

  /** Read and classify one registry file without mutating it. */
  const inspectFile = async (path) => {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { kind: 'missing', exists: false, detail: `${path} does not exist` }
      }
      throw error
    }
    return { exists: true, ...classifyRegistryText(text) }
  }

  /** Read the optional `.bak` as a recovery candidate; never mutate it. */
  const readBackupCandidate = async () => {
    try {
      const inspected = await inspectFile(backupPath)
      if (inspected.kind === 'ok') {
        return { registry: inspected.registry, status: 'ok', error: null }
      }
      return {
        registry: null,
        status: inspected.kind,
        error: inspected.kind === 'missing' ? null : inspected.detail,
      }
    } catch (error) {
      return { registry: null, status: 'unreadable', error: errorMessage(error) }
    }
  }

  const synthesizedLoad = () => ({
    kind: 'ok',
    registry: defaultRegistry(now),
    revision: 0,
    exists: false,
    degraded: false,
  })

  const degradedLoad = (state) => ({
    kind: 'ok',
    registry: defaultRegistry(now),
    revision: 0,
    exists: false,
    degraded: true,
    warning: state.warning,
    detail: state.detail,
    quarantinedTo: state.quarantinedTo ?? null,
    backupStatus: state.backupStatus ?? 'missing',
    backupError: state.backupError ?? null,
  })

  const enterDegraded = (state) => {
    degradedState = state
    return degradedLoad(state)
  }

  const writeRegistry = async (registry) => {
    await mkdir(directory, { recursive: true })
    const text = `${JSON.stringify(registry, null, 2)}\n`
    const temporaryPath = temporaryPathForWrite(filePath)
    const handle = await open(temporaryPath, 'w')
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      if (await pathExists(filePath)) {
        await withRetries(() => copyFile(filePath, backupPath))
      }
      await withRetries(() => rename(temporaryPath, filePath))
      await syncDirectory(directory)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
    return registry
  }

  /**
   * Read the registry, healing a corrupt/invalid/unsupported file from `.bak`
   * or quarantining it and reporting `degraded`. Must run under the lock.
   */
  const readState = async () => {
    if (degradedState !== null) return degradedLoad(degradedState)
    const live = await inspectFile(filePath)
    if (live.kind === 'ok') {
      return { kind: 'ok', registry: live.registry, revision: live.revision, exists: true, degraded: false }
    }
    if (live.kind === 'missing') return synthesizedLoad()
    const warning =
      live.kind === 'corrupt'
        ? 'corrupt-file'
        : live.kind === 'unsupported-version'
          ? 'unsupported-version'
          : 'invalid-file'
    const backup = await readBackupCandidate()
    if (backup.registry !== null) {
      const quarantinedTo = await quarantineLiveFile()
      if (quarantinedTo !== null) {
        try {
          await writeRegistry(backup.registry)
          return {
            kind: 'ok',
            registry: backup.registry,
            revision: backup.registry.revision,
            exists: true,
            degraded: false,
            warning: 'recovered-backup',
            detail: `${live.detail}; restored ${backupPath} revision ${String(backup.registry.revision)}`,
            quarantinedTo,
            recoveredFrom: backupPath,
          }
        } catch (error) {
          return {
            kind: 'ok',
            registry: backup.registry,
            revision: backup.registry.revision,
            exists: true,
            degraded: false,
            warning: 'recovered-backup',
            detail: `${live.detail}; backup restore failed: ${errorMessage(error)}`,
            quarantinedTo,
            recoveredFrom: backupPath,
            recoveryFailed: true,
          }
        }
      }
      return enterDegraded({
        warning,
        detail: `${live.detail}; backup recovery skipped because the corrupt registry could not be quarantined`,
        quarantinedTo: null,
        backupStatus: backup.status,
        backupError: backup.error,
      })
    }
    return enterDegraded({
      warning,
      detail: live.detail,
      quarantinedTo: await quarantineLiveFile(),
      backupStatus: backup.status,
      backupError: backup.error,
    })
  }

  const registryUnhealthy = (current) => ({
    kind: 'registry-unhealthy',
    detail: current?.detail ?? 'registry is degraded',
    quarantinedTo: current?.quarantinedTo ?? null,
    backupError: current?.backupError ?? null,
  })

  /** Persist one mutation result, stamping host-owned version/revision. */
  const writeMutation = async (current, mutation) => {
    if (mutation?.ok !== true) {
      return { ...mutation, revision: mutation?.revision ?? current.revision }
    }
    const next = mutation.registry ?? current.registry
    next.version = REGISTRY_VERSION
    next.revision = current.revision + 1
    const verdict = validateRegistry(next)
    if (!verdict.ok) {
      throw Object.assign(
        new Error(`registry mutation produced an invalid registry: ${verdict.errors.join('; ')}`),
        { code: 'invalid-registry' },
      )
    }
    const persisted = await writeRegistry(next)
    return { kind: 'ok', revision: persisted.revision, registry: persisted }
  }

  /** CAS mutation: `baseRevision` must match the registry revision read inside the lock. */
  const commit = (baseRevision, mutate) =>
    enqueue(() =>
      withLock(async () => {
        const current = await readState()
        if (current.degraded === true) return registryUnhealthy(current)
        if (current.revision !== baseRevision) {
          return { kind: 'conflict', revision: current.revision, registry: current.registry }
        }
        const draft = clone(current.registry)
        return await writeMutation(current, mutate(draft))
      }),
    )

  /** Read the registry, healing only when the file is untrusted. */
  const load = () =>
    enqueue(async () => {
      if (degradedState !== null) return degradedLoad(degradedState)
      const live = await inspectFile(filePath)
      if (live.kind === 'ok') {
        return { kind: 'ok', registry: live.registry, revision: live.revision, exists: true, degraded: false }
      }
      if (live.kind === 'missing') return synthesizedLoad()
      return withLock(readState)
    })

  return {
    path: filePath,
    backupPath,
    lockPath,

    /** Healing read used by the host; may recover a `.bak` or quarantine. */
    load,

    /** Read-only classification for doctor/storage-health (no lock, no writes). */
    peek() {
      return inspectFile(filePath)
    },

    /** Generic CAS write used by the domain mutations below. */
    commit,

    /**
     * Create (save-as) a named profile with a caller-supplied id: add the entry
     * and make it active in one CAS. The caller writes the new document first
     * (SPEC 4.4); a registry failure leaves an orphan directory on purpose.
     */
    createProfile({ baseRevision, id, name } = {}) {
      if (!isProfileId(id)) return Promise.resolve({ kind: 'invalid-profile-id' })
      const cleaned = normalizeProfileName(name)
      if (!cleaned.ok) return Promise.resolve({ kind: 'profile-name-invalid', reason: cleaned.reason })
      return commit(baseRevision, (draft) => {
        if (draft.profiles.some((profile) => profile.id === id)) {
          return { ok: false, kind: 'invalid-profile-id', reason: 'duplicate-id' }
        }
        const unarchived = draft.profiles.filter((profile) => profile.archivedAt === null)
        if (unarchived.length >= MAX_PROFILES) return { ok: false, kind: 'profile-limit' }
        if (profileNameTaken(draft, cleaned.name, null)) return { ok: false, kind: 'profile-name-duplicate' }
        const stamp = new Date(now()).toISOString()
        draft.profiles.push({
          id,
          name: cleaned.name,
          dir: profileDirFor(id),
          createdAt: stamp,
          updatedAt: stamp,
          archivedAt: null,
        })
        draft.activeId = id
        return { ok: true, registry: draft }
      })
    },

    /** Rename a profile (default included); archived targets are rejected. */
    renameProfile({ baseRevision, id, name } = {}) {
      if (!isProfileId(id)) return Promise.resolve({ kind: 'invalid-profile-id' })
      const cleaned = normalizeProfileName(name)
      if (!cleaned.ok) return Promise.resolve({ kind: 'profile-name-invalid', reason: cleaned.reason })
      return commit(baseRevision, (draft) => {
        const profile = draft.profiles.find((candidate) => candidate.id === id)
        if (profile === undefined) return { ok: false, kind: 'profile-missing' }
        if (profile.archivedAt !== null) return { ok: false, kind: 'profile-archived' }
        if (profileNameTaken(draft, cleaned.name, id)) return { ok: false, kind: 'profile-name-duplicate' }
        profile.name = cleaned.name
        profile.updatedAt = new Date(now()).toISOString()
        return { ok: true, registry: draft }
      })
    },

    /** Archive a profile (metadata only; documents are never deleted). */
    archiveProfile({ baseRevision, id } = {}) {
      if (!isProfileId(id)) return Promise.resolve({ kind: 'invalid-profile-id' })
      return commit(baseRevision, (draft) => {
        const profile = draft.profiles.find((candidate) => candidate.id === id)
        if (profile === undefined) return { ok: false, kind: 'profile-missing' }
        if (profile.archivedAt !== null) return { ok: false, kind: 'profile-archived' }
        if (profile.id === DEFAULT_PROFILE_ID) return { ok: false, kind: 'profile-in-use' }
        if (draft.activeId === profile.id) return { ok: false, kind: 'profile-in-use' }
        if (draft.profiles.filter((candidate) => candidate.archivedAt === null).length <= 1) {
          return { ok: false, kind: 'profile-in-use' }
        }
        profile.archivedAt = new Date(now()).toISOString()
        return { ok: true, registry: draft }
      })
    },

    /**
     * Make an existing unarchived profile active. Concurrency is carried by the
     * caller's preview token; when `expectedRegistryRevision` is supplied it is
     * compared inside the lock (`preview-stale` on mismatch).
     */
    activateProfile({ id, expectedRegistryRevision } = {}) {
      if (!isProfileId(id)) return Promise.resolve({ kind: 'invalid-profile-id' })
      return enqueue(() =>
        withLock(async () => {
          const current = await readState()
          if (current.degraded === true) return registryUnhealthy(current)
          if (expectedRegistryRevision !== undefined && current.revision !== expectedRegistryRevision) {
            return { kind: 'preview-stale', revision: current.revision, registry: current.registry }
          }
          const target = current.registry.profiles.find((profile) => profile.id === id)
          if (target === undefined) return { kind: 'profile-missing', revision: current.revision }
          if (target.archivedAt !== null) return { kind: 'profile-archived', revision: current.revision }
          const draft = clone(current.registry)
          draft.activeId = id
          return await writeMutation(current, { ok: true, registry: draft })
        }),
      )
    },
  }
}

export { createProfileRegistry, isProfileId, validateRegistry }
