/**
 * Client HTTP for the group-doc and profile routes.
 *
 * Same-origin only: every request is resolved against `document.baseURI`
 * (never a hardcoded host/port), matching CONTRACTS §4. The module is pure
 * enough to unit-test by injecting `fetchImpl` / `baseURI`.
 *
 * Profile endpoints are additive (SPEC §5.3-5.8/§7.1): a host without them
 * answers the same non-JSON 404 the removed plugin route used to, which maps to
 * `profilesAvailable: false` instead of an error the main view has to handle.
 */

import { perfMark, perfNow } from './perf.js'

/** Relative load route (host mounts it at the origin root). */
export const LOAD_PATH = 'dsh-session-grove/load'
/** Relative commit route. */
export const COMMIT_PATH = 'dsh-session-grove/commit'
/** Profile list route (SPEC §5.3). */
export const PROFILES_PATH = 'dsh-session-grove/profiles'
/** Read-only profile preview route with `?id=` (SPEC §5.4). */
export const PROFILES_PREVIEW_PATH = 'dsh-session-grove/profiles/preview'
/** Save-as + activate route (SPEC §5.5). */
export const PROFILES_CREATE_PATH = 'dsh-session-grove/profiles/create'
/** Rename route (SPEC §5.6). */
export const PROFILES_RENAME_PATH = 'dsh-session-grove/profiles/rename'
/** Archive route (SPEC §5.7). */
export const PROFILES_ARCHIVE_PATH = 'dsh-session-grove/profiles/archive'
/** Activate route (SPEC §5.8). */
export const PROFILES_ACTIVATE_PATH = 'dsh-session-grove/profiles/activate'

/** Error codes surfaced to the shell (all non-ok outcomes). */
export const API_ERRORS = Object.freeze({
  NETWORK: 'network',
  NOT_JSON: 'not-json',
  FENCE: 'fence-unavailable',
  IO: 'io',
  INVALID: 'invalid',
  UNSUPPORTED_VERSION: 'unsupported-version',
  CONFLICT: 'conflict',
  HTTP: 'http',
  // SPEC §7.1 profile surface (host codes pass through unchanged).
  PROFILE_CHANGED: 'profile-changed',
  PREVIEW_STALE: 'preview-stale',
  PROFILE_REQUIRED: 'profile-required',
  PROFILE_MISSING: 'profile-missing',
  PROFILE_UNHEALTHY: 'profile-unhealthy',
  PROFILE_LIMIT: 'profile-limit',
  PROFILE_NAME_INVALID: 'profile-name-invalid',
  PROFILE_NAME_DUPLICATE: 'profile-name-duplicate',
  REGISTRY_UNHEALTHY: 'registry-unhealthy',
  PROFILE_IN_USE: 'profile-in-use',
})

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const resolveUrl = (path, baseURI) => {
  try {
    return new URL(path, baseURI).toString()
  } catch {
    return path
  }
}

const classifyStatus = (status) => {
  if (status === 503) return API_ERRORS.FENCE
  if (status === 409) return API_ERRORS.CONFLICT
  if (status === 422) return API_ERRORS.INVALID
  if (status === 413 || status === 415) return API_ERRORS.HTTP
  return API_ERRORS.HTTP
}

/**
 * Host error bodies carry profile/recovery context the shell needs (active id,
 * health, stale revisions). Pass the stable fields through instead of dropping
 * them with the generic `code`/`message` mapping.
 */
const ERROR_DETAIL_FIELDS = Object.freeze([
  'activeId',
  'activeRevision',
  'registryRevision',
  'revision',
  'health',
  'profileId',
  'reason',
  'unarchivedCount',
  'version',
])

const errorDetail = (body) => {
  const detail = {}
  if (!isObject(body)) return detail
  for (const key of ERROR_DETAIL_FIELDS) {
    if (body[key] !== undefined) detail[key] = body[key]
  }
  return detail
}

/**
 * Create the API facade.
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   baseURI?: string,
 *   documentRef?: { baseURI?: string },
 * }} [options]
 */
export const createApi = ({
  fetchImpl = globalThis.fetch,
  baseURI,
  documentRef = globalThis.document,
  trace = () => {},
} = {}) => {
  const base = baseURI ?? documentRef?.baseURI ?? 'http://localhost/'
  const url = (path) => resolveUrl(path, base)

  const request = async (path, init) => {
    const method = typeof init?.method === 'string' ? init.method : 'GET'
    if (typeof fetchImpl !== 'function') {
      trace('http.end', { path, method, ok: false, error: 'fetch-unavailable' })
      return { networkError: 'fetch-unavailable' }
    }
    const started = perfNow()
    trace('http.start', { path, method })
    perfMark('http:start', { path })
    try {
      const response = await fetchImpl(url(path), init)
      const contentType = typeof response.headers?.get === 'function' ? response.headers.get('content-type') : null
      let body = null
      if (typeof response.json === 'function') {
        try {
          body = await response.json()
        } catch {
          body = null
        }
      }
      perfMark('http:end', { path, status: response.status })
      trace('http.end', {
        path,
        method,
        status: response.status,
        ok: response.ok === true,
        ms: Math.round((perfNow() - started) * 100) / 100,
      })
      return { status: response.status, ok: response.ok === true, contentType, body }
    } catch (error) {
      perfMark('http:error', { path })
      trace('http.end', {
        path,
        method,
        ok: false,
        error: String(error?.message ?? error),
        ms: Math.round((perfNow() - started) * 100) / 100,
      })
      return { networkError: String(error?.message ?? error) }
    }
  }

  /** Map a raw response to a stable client outcome. */
  const classify = (raw, { committed = false } = {}) => {
    if (raw.networkError) return { ok: false, code: API_ERRORS.NETWORK, message: raw.networkError }
    const body = isObject(raw.body) ? raw.body : null
    if (committed && raw.status === 409) {
      if (body?.code === API_ERRORS.CONFLICT || body?.code === undefined) {
        return { ok: false, code: API_ERRORS.CONFLICT, conflict: true, status: raw.status, revision: body?.revision, doc: body?.doc, message: body?.message }
      }
      if (body?.code === API_ERRORS.UNSUPPORTED_VERSION) {
        return { ok: false, code: API_ERRORS.UNSUPPORTED_VERSION, status: raw.status, message: body?.message }
      }
      if (body?.code === API_ERRORS.PROFILE_CHANGED) {
        // SPEC §5.2/§10: the active profile moved while this doc was in flight.
        // Never retry silently; the queue rolls back and surfaces the code.
        return { ok: false, code: API_ERRORS.PROFILE_CHANGED, status: raw.status, message: body?.message, ...errorDetail(body) }
      }
    }
    if (body && body.ok === false) {
      return { ok: false, code: body.code ?? classifyStatus(raw.status), status: raw.status, message: body.message, ...errorDetail(body) }
    }
    if (raw.ok && body && body.ok === true) {
      return {
        ok: true,
        status: raw.status,
        revision: body.revision,
        doc: body.doc,
        profileId: body.profileId,
        warning: body.warning,
        detail: body.detail,
        quarantinedTo: body.quarantinedTo,
        diagnostics: body.diagnostics === true,
        debugProbe: body.debugProbe === true,
      }
    }
    if (body === null) {
      // Removed plugin / SPA fallback answers 404 without JSON (CONTRACTS §6).
      return { ok: false, code: API_ERRORS.NOT_JSON, status: raw.status, message: 'non-json response' }
    }
    return { ok: false, code: classifyStatus(raw.status), status: raw.status, message: body?.message ?? `http ${raw.status}`, ...errorDetail(body) }
  }

  /** Classify one profile-route response (all success shapes differ from /load). */
  const classifyProfile = (raw) => {
    if (raw.networkError) return { ok: false, code: API_ERRORS.NETWORK, message: raw.networkError }
    const body = isObject(raw.body) ? raw.body : null
    if (body === null) {
      return { ok: false, code: API_ERRORS.NOT_JSON, status: raw.status, message: 'non-json response' }
    }
    if (body.ok === false) {
      return { ok: false, code: body.code ?? classifyStatus(raw.status), status: raw.status, message: body.message, ...errorDetail(body) }
    }
    if (raw.ok !== true || body.ok !== true) {
      return { ok: false, code: classifyStatus(raw.status), status: raw.status, message: body.message ?? `http ${raw.status}`, ...errorDetail(body) }
    }
    // Success bodies keep their endpoint-specific shape (`profiles`, `doc`,
    // `previewToken`, …) so callers never re-parse the raw response.
    return { ...body, ok: true, status: raw.status }
  }

  const getJson = (path) => request(path, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } })

  const postJson = (path, payload) =>
    request(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    })

  /** GET the group document. */
  const load = async () => {
    const raw = await getJson(LOAD_PATH)
    const result = classify(raw)
    if (!result.ok && result.code === API_ERRORS.NOT_JSON && raw.status === 404) {
      return { ...result, code: API_ERRORS.NOT_JSON, routeUnavailable: true }
    }
    return result
  }

  /** POST a new doc with optimistic concurrency, scoped to `profileId`. */
  const commit = async (doc, baseRevision, profileId) => {
    const payload = { baseRevision, doc }
    if (typeof profileId === 'string' && profileId !== '') payload.profileId = profileId
    const raw = await postJson(COMMIT_PATH, payload)
    return classify(raw, { committed: true })
  }

  /** GET the profile list (SPEC §5.3); archived rows are opt-in. */
  const listProfiles = async ({ includeArchived = false } = {}) => {
    const path = includeArchived ? `${PROFILES_PATH}?includeArchived=1` : PROFILES_PATH
    const raw = await getJson(path)
    const result = classifyProfile(raw)
    if (!result.ok && result.code === API_ERRORS.NOT_JSON && raw.status === 404) {
      // Old host: the profile surface was never registered. This is a normal
      // single-profile downgrade, not an error to show in the main view.
      return { ...result, routeUnavailable: true, profilesAvailable: false }
    }
    return result
  }

  /** GET one read-only profile preview plus its TOCTOU token (SPEC §5.4). */
  const previewProfile = async (id) => {
    const path = `${PROFILES_PREVIEW_PATH}?id=${encodeURIComponent(String(id ?? ''))}`
    return classifyProfile(await getJson(path))
  }

  /** POST save-as; the host clones the active document and activates the copy. */
  const createProfile = async ({ name, baseRevision } = {}) =>
    classifyProfile(await postJson(PROFILES_CREATE_PATH, { baseRevision, name }))

  /** POST rename. */
  const renameProfile = async ({ id, name, baseRevision } = {}) =>
    classifyProfile(await postJson(PROFILES_RENAME_PATH, { id, name, baseRevision }))

  /** POST archive (the host keeps the file; only `archivedAt` changes). */
  const archiveProfile = async ({ id, baseRevision } = {}) =>
    classifyProfile(await postJson(PROFILES_ARCHIVE_PATH, { id, baseRevision }))

  /** POST activate with the preview token (SPEC §5.8). */
  const activateProfile = async ({ id, previewToken } = {}) =>
    classifyProfile(await postJson(PROFILES_ACTIVATE_PATH, { id, previewToken }))

  return { load, commit, listProfiles, previewProfile, createProfile, renameProfile, archiveProfile, activateProfile, url }
}
