/**
 * Pure request/response helpers for the group-store routes.
 * Extracted from routes.js without changing the wire contract.
 */
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { DOC_VERSION } from '../shared/constants.js'
import { hasControlChars, normalizeColor, normalizeColorHex, validateDoc } from '../shared/model.js'
import { MAX_BODY_BYTES, MAX_DIAGNOSTICS_EVENTS, MAX_PROFILE_NAME, MAX_PROFILES } from './constants.js'

export const sendJson = (res, status, payload) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

export const sendEmpty = (res, status) => {
  res.statusCode = status
  res.setHeader('cache-control', 'no-store')
  res.end()
}

export const sendMethodNotAllowed = (res, allow) => {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.setHeader('cache-control', 'no-store')
  res.end()
}

export const contentTypeOf = (req) => {
  const raw = req?.headers?.['content-type']
  if (typeof raw !== 'string') return ''
  return raw.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Read a bounded request body; drains past the ceiling so the socket settles. */
export const readBoundedBody = async (req, limit = MAX_BODY_BYTES) => {
  const declaredLength = Number(req?.headers?.['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    req.resume?.()
    return { tooLarge: true }
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > limit) {
      req.resume?.()
      return { tooLarge: true }
    }
    chunks.push(chunk)
  }
  return { text: Buffer.concat(chunks, size).toString('utf8') }
}

export const controlPlanHash = (baseRevision, operations) =>
  createHash('sha256').update(JSON.stringify({ baseRevision, operations })).digest('hex')

export const unexpectedControlField = (body, allowed) => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  return Object.keys(body).find((key) => !allowed.has(key)) ?? null
}

/**
 * Map a store load result to the wire response.
 *
 * `profileId` is additive (SPEC 5.1): old clients ignore it, new clients use it
 * to scope revision tracking. Error branches keep their frozen shapes.
 */
export const loadResponse = (result, profileId) => {
  if (result.kind === 'unsupported-version') {
    return {
      status: 409,
      body: {
        ok: false,
        code: 'unsupported-version',
        message: `document version ${String(result.version)} is newer than this host supports`,
        version: result.version,
      },
    }
  }
  const body = { ok: true, revision: result.revision, doc: result.doc }
  if (typeof profileId === 'string' && profileId.length > 0) body.profileId = profileId
  if (result.warning !== undefined) {
    body.warning = result.warning
    if (result.detail !== undefined) body.detail = result.detail
    if (result.quarantinedTo !== null && result.quarantinedTo !== undefined) {
      body.quarantinedTo = basename(result.quarantinedTo)
    }
  }
  return { status: 200, body }
}

/** Map a store commit result to the wire response. */
export const commitResponse = (result, profileId) => {
  switch (result.kind) {
    case 'ok': {
      // SPEC 5.2: the success body names the profile that accepted the write so
      // a client can confirm it is still scoped to the profile it loaded.
      const body = { ok: true, revision: result.revision, doc: result.doc }
      if (typeof profileId === 'string' && profileId.length > 0) body.profileId = profileId
      return { status: 200, body }
    }
    case 'conflict':
      return {
        status: 409,
        body: {
          ok: false,
          code: 'conflict',
          message: 'revision mismatch',
          revision: result.revision,
          doc: result.doc,
        },
      }
    case 'invalid':
      return { status: 422, body: { ok: false, code: 'invalid', message: result.errors.join('; ') } }
    case 'unsupported-version':
      return {
        status: 409,
        body: {
          ok: false,
          code: 'unsupported-version',
          message: `document version ${String(result.version)} is newer than this host supports`,
          version: result.version,
        },
      }
    default:
      throw new Error(`unknown store result ${JSON.stringify(result.kind)}`)
  }
}

/**
 * 409 for an active profile that cannot serve reads/writes (SPEC 4.7/5.1/5.2).
 * @param {'profile-missing'|'profile-unhealthy'} code
 * @param {string} activeId
 * @param {{ kind: string, detail?: string }} health
 */
export const profileFailureResponse = (code, activeId, health) => ({
  status: 409,
  body: { ok: false, code, activeId, health },
})

/** 409 when a commit targets a profile other than the current active one. */
export const profileChangedResponse = (activeId, revision, registryRevision) => {
  const body = { ok: false, code: 'profile-changed', activeId, revision }
  if (Number.isInteger(registryRevision) && registryRevision >= 0) {
    body.registryRevision = registryRevision
  }
  return { status: 409, body }
}

/** 409 for every profile write while the registry is degraded (SPEC 4.3). */
export const registryUnhealthyResponse = () => ({
  status: 409,
  body: {
    ok: false,
    code: 'registry-unhealthy',
    message: 'profile registry is degraded; profile writes are disabled',
  },
})

// ---------------------------------------------------------------------------
// Multi-profile helpers (SPEC 4.8/5.3-5.8)
// ---------------------------------------------------------------------------

/** Public registry-entry shape used by create/rename/activate responses. */
export const profileWire = (entry) => ({
  id: entry.id,
  name: entry.name ?? null,
  archived: entry.archivedAt !== null,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
})

/**
 * `GET /profiles` row (SPEC 5.3): health and counts come from the read-only
 * peek; an unreadable document reports zero counts instead of failing the list.
 */
export const profileListEntry = (entry, health) => {
  const healthy = health.healthy === true
  const doc = healthy ? health.doc : null
  let groupCount = 0
  let sessionCount = 0
  if (doc !== null && typeof doc === 'object') {
    groupCount = Array.isArray(doc.groups) ? doc.groups.length : 0
    sessionCount = Array.isArray(doc.ungrouped) ? doc.ungrouped.length : 0
    if (Array.isArray(doc.groups)) {
      for (const group of doc.groups) {
        if (Array.isArray(group?.sessionIds)) sessionCount += group.sessionIds.length
      }
    }
  }
  return {
    id: entry.id,
    name: entry.name ?? null,
    archived: entry.archivedAt !== null,
    healthy,
    groupCount,
    sessionCount,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

/**
 * Wire health for one profile peek. A missing file is not echoed back as a
 * path; every other detail string is useful for recovery.
 */
export const profileHealth = (peek) => {
  const health = { kind: peek.kind }
  if (peek.kind !== 'missing' && typeof peek.detail === 'string') health.detail = peek.detail
  return health
}

/** 409 for a profile target that cannot be previewed/activated. */
export const profileTargetFailure = (code, profileId, health = null) => {
  const body = { ok: false, code, profileId }
  if (health !== null) body.health = health
  return { status: 409, body }
}

/**
 * SPEC 5.4: non-secret TOCTOU token over the active/target/registry revisions.
 * `activeRevision` is `null` when the active document is unhealthy.
 */
export const previewTokenFor = ({ activeId, activeRevision, targetId, targetRevision, registryRevision }) =>
  createHash('sha256')
    .update(JSON.stringify({ activeId, activeRevision, targetId, targetRevision, registryRevision }))
    .digest('hex')

/** 409 when an activate request was computed against older state. */
export const previewStaleResponse = ({ activeId, activeRevision, registryRevision } = {}) => {
  const body = {
    ok: false,
    code: 'preview-stale',
    message: 'preview token no longer matches the current active profile, target revision or registry revision',
  }
  if (typeof activeId === 'string') body.activeId = activeId
  if (activeRevision !== undefined) body.activeRevision = activeRevision
  if (Number.isInteger(registryRevision) && registryRevision >= 0) body.registryRevision = registryRevision
  return { status: 409, body }
}

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

/**
 * Map one registry mutation result to the wire response (SPEC 4.8). Every
 * profile route funnels failures here so status codes and shapes stay uniform.
 * Unknown kinds throw: a silent fallback would hide a contract bug.
 */
export const profileWriteFailure = (result) => {
  switch (result.kind) {
    case 'conflict':
      return {
        status: 409,
        body: { ok: false, code: 'conflict', message: 'revision mismatch', revision: result.revision },
      }
    case 'preview-stale':
      return previewStaleResponse({ registryRevision: result.revision })
    case 'registry-unhealthy':
      return registryUnhealthyResponse()
    case 'profile-limit':
      return {
        status: 409,
        body: {
          ok: false,
          code: 'profile-limit',
          message: `at most ${String(MAX_PROFILES)} unarchived profiles are allowed`,
        },
      }
    case 'profile-name-invalid':
      return {
        status: 422,
        body: {
          ok: false,
          code: 'profile-name-invalid',
          message: 'profile name is invalid',
          reason: result.reason ?? null,
        },
      }
    case 'profile-name-duplicate':
      return {
        status: 422,
        body: { ok: false, code: 'profile-name-duplicate', message: 'profile name is already in use' },
      }
    case 'profile-missing':
      return {
        status: 409,
        body: { ok: false, code: 'profile-missing', message: 'profile does not exist' },
      }
    case 'profile-archived':
      return {
        status: 409,
        body: { ok: false, code: 'profile-archived', message: 'profile is archived' },
      }
    case 'profile-in-use':
      return {
        status: 409,
        body: {
          ok: false,
          code: 'profile-in-use',
          message: 'the active, default or last unarchived profile cannot be archived',
        },
      }
    case 'invalid-profile-id':
      return {
        status: 422,
        body: {
          ok: false,
          code: 'invalid-profile-id',
          message: 'profile id is invalid',
          reason: result.reason ?? null,
        },
      }
    default:
      throw new Error(`unknown profile result ${JSON.stringify(result.kind)}`)
  }
}

/**
 * Validate one commit request body; returns
 * `{ ok, baseRevision, doc, profileId }` where `profileId` is `null` when the
 * optional field is absent (legacy clients commit to the active profile).
 */
export const parseCommitBody = (body) => {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' }
  const { baseRevision, doc, profileId } = body
  if (!Number.isInteger(baseRevision) || baseRevision < 0) {
    return { ok: false, message: 'baseRevision must be a non-negative integer' }
  }
  if (profileId !== undefined) {
    if (typeof profileId !== 'string' || profileId.trim().length === 0 || profileId.length > 64) {
      return { ok: false, message: 'profileId must be a non-empty string of at most 64 characters' }
    }
  }
  if (!isObject(doc)) return { ok: false, message: 'doc must be a JSON object' }
  // The host owns revision: ignore whatever the client sent and validate the
  // frozen shape/invariants via the shared model.
  const candidate = {
    version: doc.version,
    revision: 0,
    groups: doc.groups,
    ungrouped: doc.ungrouped,
  }
  if (candidate.version !== DOC_VERSION) {
    return { ok: false, message: `version must be ${String(DOC_VERSION)}` }
  }
  // 0.2.7: normalize a valid custom hex (short form/uppercase -> canonical
  // lowercase #rrggbb) before validation. Invalid/alpha values stay as-is so
  // validateDoc rejects them with a `group-color-hex` error.
  candidate.groups = Array.isArray(candidate.groups)
    ? candidate.groups.map((group) => {
        if (!isObject(group) || group.colorHex === undefined) return group
        const hex = normalizeColorHex(group.colorHex)
        return hex ? { ...group, colorHex: hex } : group
      })
    : candidate.groups
  const verdict = validateDoc(candidate)
  if (!verdict.ok) return { ok: false, message: verdict.errors.join('; ') }
  // 0.2.6 additive: validation accepts a missing `color` (legacy docs), while
  // the host normalizes every persisted group to an explicit palette id so new
  // writes never depend on the client-side blue fallback.
  candidate.groups = candidate.groups.map((group) => ({ ...group, color: normalizeColor(group.color) }))
  return { ok: true, baseRevision, doc: candidate, profileId: profileId ?? null }
}

/**
 * Validate one diagnostics batch. The route is append-only and never validates
 * event internals: the client owns the schema, the host only enforces a bounded
 * batch so one request cannot grow the file without limit.
 *
 * @returns {{ ok: true, runId: string|null, schemaVersion: number|null, events: object[] } | { ok: false, message: string }}
 */
export const parseDiagnosticsBody = (body) => {
  if (!isObject(body)) return { ok: false, message: 'body must be a JSON object' }
  const { events } = body
  if (!Array.isArray(events)) return { ok: false, message: 'events must be an array' }
  if (events.length === 0) return { ok: false, message: 'events must not be empty' }
  if (events.length > MAX_DIAGNOSTICS_EVENTS) {
    return { ok: false, message: `events must contain at most ${String(MAX_DIAGNOSTICS_EVENTS)} entries` }
  }
  if (!events.every((event) => isObject(event))) return { ok: false, message: 'events must be JSON objects' }
  const runId = typeof body.runId === 'string' && body.runId.length > 0 ? body.runId.slice(0, 128) : null
  const schemaVersion = Number.isInteger(body.schemaVersion) && body.schemaVersion > 0 ? body.schemaVersion : null
  return { ok: true, runId, schemaVersion, events }
}

/**
 * Register the routes on the composition's webServer. Each registration is
 * wrapped in `ctx.effect` so it disappears when the plugin is disposed.
 * Fail-soft: a composition without a webServer only logs a warning.
 *
 * @param {object} ctx Cordis context.
 * @param {object} store profile manager, or (legacy/tests) the default document store.
 * @param {{ profileManager?: object, diagnosticsFilePath?: string | null, debugFilePath?: string | null, diagnosticsEnabled?: boolean | (() => boolean), debugProbeEnabled?: boolean | (() => boolean) }} [options] host-half options
 *   (`diagnosticsFilePath` is resolved from `dshHomePath('storages')`; diagnostics default true for direct route
 *   tests, while the Cordis entry passes the plugin config flag).
 * @returns {{ registered: boolean, routes: string[] }}
 */
