/**
 * Native DSH tool for session-group control.
 *
 * The Host HTTP API remains useful for the browser/settings page, but DSH's
 * browser-session fence runs before plugin HTTP routes and rejects a CLI that
 * only carries the plugin bearer token. A Host tool executes in-process and
 * therefore does not cross that fence.
 *
 * Multi-profile (SPEC 6.1): `state`/`resolve` may target the active profile by
 * default; `plan`/`apply` require an explicit `profileId` when more than one
 * profile is unarchived. The plan hash includes the profile id, so a plan can
 * never be replayed against another profile. There is deliberately no
 * activate/switch action: the AI never changes the user's active profile.
 */
import { dirname } from 'node:path'
import {
  applyControlOperations,
  buildControlState,
  CONTROL_PROTOCOL,
  resolveGroupPath,
} from '../core/control.js'
import { buildControlCatalog } from '../core/catalog.js'
import { DEFAULT_PROFILE_ID } from './constants.js'
import { controlPlanHash, resolveControlProfile, withProfileStorage } from './profile-policy.js'

export const TOOL_NAME = 'session_grove_control'

const ACTIONS = [
  'catalog',
  'state',
  'resolve',
  'plan',
  'apply',
  'doctor',
  'session_inspect',
  'session_rename',
  'session_archive',
]

const controlParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ACTIONS },
    profileId: { type: 'string' },
    path: { type: 'array', items: { type: 'string' } },
    baseRevision: { type: 'integer' },
    operations: { type: 'array', items: { type: 'object', additionalProperties: true } },
    planHash: { type: 'string' },
    sessionId: { type: 'string' },
    title: { type: 'string' },
    expectedTitle: { type: 'string' },
    archived: { type: 'boolean' },
    expectedArchived: { type: 'boolean' },
    stopActivity: { type: 'boolean' },
  },
  required: ['action'],
}

const isProfileManager = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.loadRegistry === 'function' &&
  typeof value.storeFor === 'function' &&
  typeof value.peekFor === 'function'

/**
 * Single-profile view for callers that only pass a store (direct tool tests and
 * the frozen integration harness). The active profile is always `default`; no
 * registry file is read or written.
 */
const staticProfileManager = (store) => {
  const entry = { id: DEFAULT_PROFILE_ID, name: null, dir: '.', archivedAt: null }
  const registry = { version: 1, revision: 0, activeId: DEFAULT_PROFILE_ID, profiles: [entry] }
  const invalid = (id) => {
    throw Object.assign(new Error(`unknown profile: ${String(id)}`), { code: 'invalid-profile-id' })
  }
  return {
    storageDir: typeof store?.path === 'string' && store.path.length > 0 ? dirname(store.path) : null,
    registryFilePath: null,
    defaultFilePath: null,
    loadRegistry: async () => ({ kind: 'ok', registry, revision: 0, exists: false, degraded: false }),
    storeFor: (id) => {
      if (id !== DEFAULT_PROFILE_ID) invalid(id)
      return store
    },
    peekFor: (id) => {
      if (id !== DEFAULT_PROFILE_ID) invalid(id)
      return store.peek()
    },
  }
}

const toolOutput = (value) => {
  if (value !== null && typeof value === 'object') return { ok: value.ok !== false, ...value }
  return { ok: true, value }
}

/**
 * @param {{
 *   store?: object,
 *   profileManager?: object,
 *   getService: (name: string) => unknown,
 *   controlApiEnabled: () => boolean,
 *   controlSessionsEnabled: () => boolean,
 *   controlDestructiveEnabled: () => boolean,
 * }} options
 */
export const createControlTool = (options) => {
  const { store } = options
  const profileManager = isProfileManager(options.profileManager)
    ? options.profileManager
    : staticProfileManager(store)
  const { getService } = options
  const onCommit = typeof options.onCommit === 'function' ? options.onCommit : () => {}
  const doctorReport = typeof options.doctorReport === 'function' ? options.doctorReport : null
  const enabled = () => options.controlApiEnabled() === true
  const sessionsEnabled = () => enabled() && options.controlSessionsEnabled() === true
  const destructive = () => options.controlDestructiveEnabled() === true
  const failure = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })

  const loadProfile = async (resolved) => {
    const result = await resolved.store.load()
    if (result.kind === 'unsupported-version') {
      return {
        error: failure('unsupported-version', `document version ${String(result.version)} is newer than this host supports`, {
          version: result.version,
        }),
      }
    }
    return { result }
  }

  const liveSession = (sessionId) => {
    const sessions = getService('sessions')
    if (sessions === null || typeof sessions.get !== 'function') return null
    try {
      return sessions.get(sessionId) ?? null
    } catch {
      return null
    }
  }

  const archivedIds = () => {
    const registry = getService('workspaceRegistry')
    return registry !== null && Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : null
  }

  const execute = async (args) => {
    const action = args?.action
    if (!ACTIONS.includes(action)) return failure('invalid-action', `action must be one of: ${ACTIONS.join(', ')}`)
    if (action === 'doctor') {
      if (doctorReport === null) return failure('doctor-unavailable', 'compatibility doctor is not configured')
      try {
        return await withProfileStorage(await doctorReport(), profileManager)
      } catch (error) {
        return failure('doctor-failed', error instanceof Error ? error.message : String(error))
      }
    }
    if (!enabled()) return failure('control-disabled', 'enable controlApi before using session_grove_control')

    if (action === 'catalog') {
      return { ok: true, ...buildControlCatalog() }
    }

    if (action === 'state') {
      const resolved = await resolveControlProfile(profileManager, args.profileId)
      if (!resolved.ok) return resolved.body
      const loaded = await loadProfile(resolved)
      if (loaded.error !== undefined) return loaded.error
      return {
        ok: true,
        protocol: CONTROL_PROTOCOL,
        profileId: resolved.profileId,
        activeProfile: resolved.activeProfile,
        ...buildControlState(loaded.result.doc, loaded.result.revision),
      }
    }

    if (action === 'resolve') {
      if (!Array.isArray(args.path) || args.path.length === 0) {
        return failure('invalid-path', 'path must be a non-empty array of strings', { field: 'path' })
      }
      const resolved = await resolveControlProfile(profileManager, args.profileId)
      if (!resolved.ok) return resolved.body
      const loaded = await loadProfile(resolved)
      if (loaded.error !== undefined) return loaded.error
      const group = resolveGroupPath(loaded.result.doc, args.path)
      if (!group.ok) return { ...group, revision: loaded.result.revision }
      return {
        ok: true,
        ...group,
        revision: loaded.result.revision,
        profileId: resolved.profileId,
        activeProfile: resolved.activeProfile,
      }
    }

    if (action === 'plan' || action === 'apply') {
      if (!Number.isInteger(args.baseRevision) || args.baseRevision < 0) {
        return failure('invalid-revision', 'baseRevision must be a non-negative integer', { field: 'baseRevision' })
      }
      const resolved = await resolveControlProfile(profileManager, args.profileId, {
        requireExplicitWhenMultiple: true,
      })
      if (!resolved.ok) return resolved.body
      if (!Array.isArray(args.operations) || args.operations.length === 0) {
        return failure('operations-required', 'operations must be a non-empty array', { field: 'operations' })
      }
      const hash = controlPlanHash(resolved.profileId, args.baseRevision, args.operations)
      if (action === 'apply' && (typeof args.planHash !== 'string' || args.planHash !== hash)) {
        return failure('stale-plan', 'planHash does not match profileId + baseRevision + operations', {
          planHash: hash,
        })
      }
      const loaded = await loadProfile(resolved)
      if (loaded.error !== undefined) return loaded.error
      if (loaded.result.revision !== args.baseRevision) {
        return failure('conflict', 'revision mismatch', { revision: loaded.result.revision })
      }
      const planned = applyControlOperations(loaded.result.doc, args.operations, {
        allowDestructive: destructive(),
      })
      if (!planned.ok) return planned
      if (action === 'plan') {
        return {
          ok: true,
          protocol: CONTROL_PROTOCOL,
          profileId: resolved.profileId,
          baseRevision: args.baseRevision,
          planHash: hash,
          changes: planned.changes,
        }
      }
      // Tool apply is intentionally not idempotent: there is no replay cache,
      // and a second apply with the same baseRevision is a normal CAS conflict.
      const committed = await resolved.store.commit(args.baseRevision, planned.doc)
      if (committed.kind === 'ok') {
        try {
          onCommit(committed.revision, 'native-tool', resolved.profileId)
        } catch {
          /* notification must never fail a committed write */
        }
        return {
          ok: true,
          protocol: CONTROL_PROTOCOL,
          profileId: resolved.profileId,
          revision: committed.revision,
          planHash: hash,
          changes: planned.changes,
        }
      }
      if (committed.kind === 'conflict') {
        return failure('conflict', 'revision mismatch', { revision: committed.revision })
      }
      if (committed.kind === 'unsupported-version') {
        return failure('unsupported-version', `document version ${String(committed.version)} is newer than this host supports`)
      }
      return failure('invalid', committed.errors.join('; ') || 'commit rejected')
    }

    if (!sessionsEnabled()) {
      return failure('session-controls-disabled', 'enable controlSessions before using session actions')
    }
    if (typeof args.sessionId !== 'string' || args.sessionId.length === 0) {
      return failure('invalid-session-id', 'sessionId must be a non-empty string', { field: 'sessionId' })
    }

    if (action === 'session_inspect') {
      const live = liveSession(args.sessionId)
      const archived = archivedIds()
      if (live === null && archived === null) {
        return failure('service-unavailable', 'session services are unavailable')
      }
      if (live === null && archived.includes(args.sessionId) !== true) {
        return failure('session-not-found', 'session not found', { sessionId: args.sessionId })
      }
      let title = null
      if (live !== null) {
        try {
          title = getService('sessionTitle')?.get?.(live)?.title ?? null
        } catch {
          title = null
        }
      }
      return {
        ok: true,
        sessionId: args.sessionId,
        live: live !== null,
        archived: archived?.includes(args.sessionId) === true,
        title,
      }
    }

    if (action === 'session_rename') {
      if (typeof args.title !== 'string' || args.title.length === 0) {
        return failure('invalid-title', 'title must be a non-empty string', { field: 'title' })
      }
      if (args.expectedTitle !== undefined && typeof args.expectedTitle !== 'string') {
        return failure('invalid-title', 'expectedTitle must be a string', { field: 'expectedTitle' })
      }
      const live = liveSession(args.sessionId)
      if (live === null) return failure('session-not-live', 'session title can only be changed while live')
      const titleService = getService('sessionTitle')
      if (titleService === null || typeof titleService.rename !== 'function') {
        return failure('service-unavailable', 'session title service is unavailable')
      }
      let current = null
      try {
        current = titleService.get?.(live)?.title ?? null
      } catch {
        current = null
      }
      if (args.expectedTitle !== undefined && args.expectedTitle !== current) {
        return failure('title-changed', 'session title changed', { expectedTitle: args.expectedTitle, title: current })
      }
      if (current === args.title) return { ok: true, sessionId: args.sessionId, title: args.title }
      try {
        const next = titleService.rename(live, args.title)
        return { ok: true, sessionId: args.sessionId, title: next?.title ?? args.title }
      } catch (error) {
        return failure('session-operation-failed', error instanceof Error ? error.message : String(error))
      }
    }

    if (typeof args.archived !== 'boolean') {
      return failure('invalid-archived', 'archived must be a boolean', { field: 'archived' })
    }
    if (args.expectedArchived !== undefined && typeof args.expectedArchived !== 'boolean') {
      return failure('invalid-archived', 'expectedArchived must be a boolean', { field: 'expectedArchived' })
    }
    if (args.stopActivity !== undefined && typeof args.stopActivity !== 'boolean') {
      return failure('invalid-stop-activity', 'stopActivity must be a boolean', { field: 'stopActivity' })
    }
    const registry = getService('workspaceRegistry')
    if (registry === null || typeof registry.archiveSession !== 'function' || typeof registry.unarchiveSession !== 'function') {
      return failure('service-unavailable', 'workspace registry is unavailable')
    }
    const current = Array.isArray(registry.archivedSessionIds) && registry.archivedSessionIds.includes(args.sessionId)
    if (args.expectedArchived !== undefined && args.expectedArchived !== current) {
      return failure('archive-changed', 'archived state changed', {
        expectedArchived: args.expectedArchived,
        archived: current,
      })
    }
    if (current === args.archived) return { ok: true, sessionId: args.sessionId, archived: current }
    try {
      if (args.archived) {
        await registry.archiveSession(args.sessionId, args.stopActivity === true ? { stopActivity: true } : {})
      } else {
        await registry.unarchiveSession(args.sessionId)
      }
      return { ok: true, sessionId: args.sessionId, archived: args.archived }
    } catch (error) {
      return failure('session-operation-failed', error instanceof Error ? error.message : String(error))
    }
  }

  return {
    name: TOOL_NAME,
    description:
      'Read and safely change the DSH free-groups sidebar and session title/archive state in-process. ' +
      'Use action=catalog to read the available icon/color vocabulary and operation names. ' +
      'Use action=state or resolve first (optionally with profileId; the active profile is the default). ' +
      'Use plan then apply with the returned planHash and baseRevision for group writes; when multiple profiles exist, ' +
      'plan/apply require an explicit profileId. Plans are scoped to one profile and never switch the active profile. ' +
      'Use action=doctor to inspect host compatibility, gates, storage, profile registry and services. ' +
      'Session actions require an explicit live sessionId. Destructive group deletion requires controlDestructive.',
    parameters: controlParameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      try {
        return toolOutput(await execute(args))
      } catch (error) {
        return failure('internal', error instanceof Error ? error.message : String(error))
      }
    },
  }
}
