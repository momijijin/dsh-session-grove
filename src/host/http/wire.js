/**
 * HTTP wire primitives and request-body parsing (SPEC 7.1).
 *
 * Pure request/response plumbing shared by every host route: JSON body writers,
 * bounded body readers, the JSON-object body reader for the profile routes and
 * the commit/diagnostics body validators. No route registration and no
 * knowledge of the profile registry lives here.
 */
import { DOC_VERSION } from '../../shared/constants.js'
import { normalizeColor, normalizeColorHex, validateDoc } from '../../shared/model.js'
import { MAX_BODY_BYTES, MAX_DIAGNOSTICS_EVENTS } from '../constants.js'

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

export const unexpectedControlField = (body, allowed) => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  return Object.keys(body).find((key) => !allowed.has(key)) ?? null
}

/** Local copy of the 422 invalid-body shape used by readJsonBody below. */
const invalidBody = (message) => ({ ok: false, code: 'invalid', message })

export const readJsonBody = async (req, res) => {
  if (contentTypeOf(req) !== 'application/json') {
    sendJson(res, 415, {
      ok: false,
      code: 'unsupported-media-type',
      message: 'content-type must be application/json',
    })
    return null
  }
  let text
  try {
    const read = await readBoundedBody(req)
    if (read.tooLarge === true) {
      sendJson(res, 413, { ok: false, code: 'payload-too-large', message: 'request body is too large' })
      return null
    }
    text = read.text
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      code: 'bad-request',
      message: `request body unreadable: ${error instanceof Error ? error.message : String(error)}`,
    })
    return null
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    sendJson(res, 422, invalidBody('body is not valid JSON'))
    return null
  }
  if (!isObject(body)) {
    sendJson(res, 422, invalidBody('body must be a JSON object'))
    return null
  }
  return body
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
