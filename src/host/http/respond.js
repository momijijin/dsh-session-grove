/**
 * HTTP response shapes for the group-store routes (SPEC 7.1).
 *
 * Every route funnels its store/registry result through one of these pure
 * builders so status codes and frozen body shapes cannot drift between the
 * native tool, the HTTP control routes and the profile routes.
 */
import { basename } from 'node:path'
import { MAX_PROFILES } from '../constants.js'

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

/** 422 for a malformed `profileId` on the control surface (SPEC 6.1/4.8). */
export const invalidProfileIdResponse = () => ({
  status: 422,
  body: {
    ok: false,
    code: 'invalid-profile-id',
    message: 'profileId must match ^[a-z0-9][a-z0-9-]{2,63}$',
    field: 'profileId',
  },
})

/** 422 when a multi-profile host needs an explicit target (SPEC 6.1/6.2). */
export const profileRequiredResponse = (unarchivedCount) => ({
  status: 422,
  body: {
    ok: false,
    code: 'profile-required',
    message: 'multiple profiles exist; pass profileId explicitly',
    field: 'profileId',
    unarchivedCount,
  },
})

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
