/**
 * Control/event/doctor route registration.
 * Extracted from routes.js; route order and wire behavior are unchanged.
 *
 * Multi-profile (SPEC 6.1/6.2): every document action names a target profile.
 * `state`/`resolve` may omit it (active profile); `plan`/`apply` must name it
 * when more than one profile is unarchived; session actions and catalog/doctor
 * never read a group document. The selected store comes from the manager per
 * request, so no profile is captured at registration time. No route switches
 * the active profile.
 */
import {
  CONTROL_APPLY_PATH,
  CONTROL_CATALOG_PATH,
  CONTROL_DOCTOR_PATH,
  CONTROL_PLAN_PATH,
  CONTROL_RESOLVE_PATH,
  CONTROL_STATE_PATH,
  EVENTS_PATH,
  MAX_CONTROL_BODY_BYTES,
} from './constants.js'
import { buildControlCatalog } from '../core/catalog.js'
import {
  applyControlOperations,
  buildControlState,
  CONTROL_PROTOCOL,
  isArchiveConflictCode,
  resolveGroupPath,
} from '../core/control.js'
import { controlPlanHash, resolveControlProfile, withProfileStorage } from './profile-policy.js'

export const registerControlRoutes = (deps) => {
  const {
    register,
    profileManager,
    ctx,
    options,
    changeHub,
    fenceDenied,
    controlDenied,
    controlUnavailable,
    controlDestructiveEnabled,
    sendJson,
    sendMethodNotAllowed,
    contentTypeOf,
    readBoundedBody,
    unexpectedControlField,
    loadResponse,
    commitResponse,
    publishChange,
    logInfo,
  } = deps

  let controlStatePath = null
  let controlCatalogPath = null
  let controlDoctorPath = null
  let controlResolvePath = null
  let controlPlanPath = null
  let controlApplyPath = null
  let eventsPath = null

  /** Read one JSON control body; sends the frozen 4xx response on failure. */
  const readControlBody = async (req, res) => {
    if (contentTypeOf(req) !== 'application/json') {
      sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/json' })
      return null
    }
    try {
      const read = await readBoundedBody(req, MAX_CONTROL_BODY_BYTES)
      if (read.tooLarge === true) {
        sendJson(res, 413, { ok: false, code: 'payload-too-large', message: 'request body is too large' })
        return null
      }
      const body = JSON.parse(read.text)
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 422, { ok: false, code: 'invalid-body', message: 'body must be a JSON object' })
        return null
      }
      return body
    } catch {
      sendJson(res, 422, { ok: false, code: 'invalid', message: 'body is not valid JSON' })
      return null
    }
  }

  const rejectUnexpected = (res, body, allowed) => {
    const unexpected = unexpectedControlField(body, allowed)
    if (unexpected === null) return false
    sendJson(res, 422, {
      ok: false,
      code: 'unexpected-field',
      message: `unexpected top-level field "${unexpected}"`,
      field: unexpected,
    })
    return true
  }

  const sendProfileFailure = (res, resolved) => {
    if (resolved.ok !== false) return false
    sendJson(res, resolved.status, resolved.body)
    return true
  }

  /** `state` is a GET: the target rides in the query string. */
  const profileQueryOf = (req) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    return url.searchParams.has('profileId') ? url.searchParams.get('profileId') : undefined
  }

  if (changeHub !== null) {
    eventsPath = register(
      EVENTS_PATH,
      async (req, res) => {
        if (fenceDenied(req, res)) return
        if (req.method !== 'GET') {
          sendMethodNotAllowed(res, 'GET')
          return
        }
        res.statusCode = 200
        res.setHeader('cache-control', 'no-store')
        res.setHeader('content-type', 'text/event-stream; charset=utf-8')
        res.setHeader('connection', 'keep-alive')
        res.writeHead?.(200, {
          'cache-control': 'no-store',
          'content-type': 'text/event-stream; charset=utf-8',
          connection: 'keep-alive',
        })
        res.write?.('retry: 10000\n\n')
        res.write?.('event: ready\ndata: {}\n\n')
        const unsubscribe = changeHub.subscribe(res)
        let cleaned = false
        const cleanup = () => {
          if (cleaned) return
          cleaned = true
          clearInterval(keepalive)
          unsubscribe?.()
        }
        const keepalive = setInterval(() => {
          try {
            res.write?.(': keepalive\n\n')
          } catch {
            cleanup()
          }
        }, 15000)
        keepalive.unref?.()
        req.on?.('close', cleanup)
        res.on?.('close', cleanup)
      },
      `dsh-session-grove: GET ${EVENTS_PATH}`,
    )
  }
  {
    // SPEC 6.1: HTTP idempotency is scoped to the resolved profile. A plan for
    // profile A can never replay against profile B, even with the same key.
    const idempotency = new Map()
    const remember = (key, value) => {
      if (!key) return
      idempotency.set(key, value)
      if (idempotency.size > 128) idempotency.delete(idempotency.keys().next().value)
    }

    controlDoctorPath = register(
      CONTROL_DOCTOR_PATH,
      async (req, res) => {
        if (controlDenied(req, res)) return
        if (req.method !== 'GET') {
          sendMethodNotAllowed(res, 'GET')
          return
        }
        if (typeof options.doctorReport !== 'function') {
          sendJson(res, 503, {
            ok: false,
            code: 'doctor-unavailable',
            message: 'compatibility doctor is not configured',
          })
          return
        }
        try {
          const report = await options.doctorReport()
          // Doctor stays read-only and available while controlApi is closed;
          // the registry/profile rows are added from a side-effect-free peek.
          sendJson(res, 200, await withProfileStorage(report, profileManager))
        } catch (error) {
          sendJson(res, 503, {
            ok: false,
            code: 'doctor-failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
      `dsh-session-grove: GET ${CONTROL_DOCTOR_PATH}`,
    )

    controlStatePath = register(
      CONTROL_STATE_PATH,
      async (req, res) => {
        if (controlUnavailable(res)) return
        if (controlDenied(req, res)) return
        if (req.method !== 'GET') {
          sendMethodNotAllowed(res, 'GET')
          return
        }
        try {
          const resolvedProfile = await resolveControlProfile(profileManager, profileQueryOf(req))
          if (sendProfileFailure(res, resolvedProfile)) return
          const result = await resolvedProfile.store.load()
          if (result.kind === 'unsupported-version') {
            sendJson(res, 409, loadResponse(result).body)
            return
          }
          sendJson(res, 200, {
            ok: true,
            profileId: resolvedProfile.profileId,
            activeProfile: resolvedProfile.activeProfile,
            ...buildControlState(result.doc, result.revision),
          })
        } catch (error) {
          sendJson(res, 503, { ok: false, code: 'io', message: error instanceof Error ? error.message : String(error) })
        }
      },
      `dsh-session-grove: GET ${CONTROL_STATE_PATH}`,
    )

    controlCatalogPath = register(
      CONTROL_CATALOG_PATH,
      async (req, res) => {
        if (controlUnavailable(res)) return
        if (controlDenied(req, res)) return
        if (req.method !== 'GET') {
          sendMethodNotAllowed(res, 'GET')
          return
        }
        // Catalog describes vocabulary, not a profile: it reads no document and
        // needs no profileId even when the registry is degraded.
        sendJson(res, 200, { ok: true, ...buildControlCatalog() })
      },
      `dsh-session-grove: GET ${CONTROL_CATALOG_PATH}`,
    )

    controlResolvePath = register(
      CONTROL_RESOLVE_PATH,
      async (req, res) => {
        if (controlUnavailable(res)) return
        if (controlDenied(req, res)) return
        if (req.method !== 'POST') {
          sendMethodNotAllowed(res, 'POST')
          return
        }
        const body = await readControlBody(req, res)
        if (body === null) return
        if (rejectUnexpected(res, body, new Set(['path', 'baseRevision', 'profileId']))) return
        if (body.baseRevision !== undefined && (!Number.isInteger(body.baseRevision) || body.baseRevision < 0)) {
          sendJson(res, 422, {
            ok: false,
            code: 'invalid-revision',
            message: 'baseRevision must be a non-negative integer',
            field: 'baseRevision',
          })
          return
        }
        try {
          const resolvedProfile = await resolveControlProfile(profileManager, body.profileId)
          if (sendProfileFailure(res, resolvedProfile)) return
          const result = await resolvedProfile.store.load()
          if (result.kind === 'unsupported-version') {
            sendJson(res, 409, loadResponse(result).body)
            return
          }
          if (body.baseRevision !== undefined && result.revision !== body.baseRevision) {
            sendJson(res, 409, {
              ok: false,
              code: 'revision-mismatch',
              message: 'revision changed before path resolution',
              revision: result.revision,
            })
            return
          }
          const resolved = resolveGroupPath(result.doc, body.path)
          if (!resolved.ok) {
            const status = resolved.code === 'ambiguous-path' ? 409 : resolved.code === 'invalid-path' ? 422 : 404
            sendJson(res, status, resolved)
            return
          }
          sendJson(res, 200, {
            ...resolved,
            protocol: CONTROL_PROTOCOL,
            revision: result.revision,
            profileId: resolvedProfile.profileId,
            activeProfile: resolvedProfile.activeProfile,
          })
        } catch (error) {
          sendJson(res, 503, { ok: false, code: 'io', message: error instanceof Error ? error.message : String(error) })
        }
      },
      `dsh-session-grove: POST ${CONTROL_RESOLVE_PATH}`,
    )

    controlPlanPath = register(
      CONTROL_PLAN_PATH,
      async (req, res) => {
        if (controlUnavailable(res)) return
        if (controlDenied(req, res)) return
        if (req.method !== 'POST') {
          sendMethodNotAllowed(res, 'POST')
          return
        }
        const body = await readControlBody(req, res)
        if (body === null) return
        if (rejectUnexpected(res, body, new Set(['baseRevision', 'operations', 'profileId']))) return
        const baseRevision = body.baseRevision
        const operations = body.operations
        if (!Number.isInteger(baseRevision) || baseRevision < 0) {
          sendJson(res, 422, { ok: false, code: 'invalid-revision', message: 'baseRevision must be a non-negative integer' })
          return
        }
        try {
          const resolvedProfile = await resolveControlProfile(profileManager, body.profileId, {
            requireExplicitWhenMultiple: true,
          })
          if (sendProfileFailure(res, resolvedProfile)) return
          const result = await resolvedProfile.store.load()
          if (result.kind === 'unsupported-version') {
            sendJson(res, 409, loadResponse(result).body)
            return
          }
          if (result.revision !== baseRevision) {
            sendJson(res, 409, { ok: false, code: 'conflict', message: 'revision mismatch', revision: result.revision })
            return
          }
          const planned = applyControlOperations(result.doc, operations, {
            allowDestructive: controlDestructiveEnabled(),
          })
          if (!planned.ok) {
            // N6: archive-state conflicts (`group-archived` and friends, plus a
            // whole-batch invariant rejection) are 409; schema/unknown-field/
            // type/negative-index mistakes stay 422. The body keeps
            // code/groupId/field/operationIndex either way.
            sendJson(res, isArchiveConflictCode(planned.code) ? 409 : 422, planned)
            return
          }
          sendJson(res, 200, {
            ok: true,
            protocol: CONTROL_PROTOCOL,
            profileId: resolvedProfile.profileId,
            baseRevision,
            planHash: controlPlanHash(resolvedProfile.profileId, baseRevision, operations),
            changes: planned.changes,
          })
        } catch (error) {
          sendJson(res, 503, { ok: false, code: 'io', message: error instanceof Error ? error.message : String(error) })
        }
      },
      `dsh-session-grove: POST ${CONTROL_PLAN_PATH}`,
    )

    controlApplyPath = register(
      CONTROL_APPLY_PATH,
      async (req, res) => {
        if (controlUnavailable(res)) return
        if (controlDenied(req, res)) return
        if (req.method !== 'POST') {
          sendMethodNotAllowed(res, 'POST')
          return
        }
        const body = await readControlBody(req, res)
        if (body === null) return
        if (
          rejectUnexpected(res, body, new Set(['baseRevision', 'operations', 'planHash', 'idempotencyKey', 'profileId']))
        ) {
          return
        }
        if (
          body.idempotencyKey !== undefined &&
          (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length === 0 || body.idempotencyKey.length > 128)
        ) {
          sendJson(res, 422, {
            ok: false,
            code: 'invalid-idempotency-key',
            message: 'idempotencyKey must be a non-empty string of at most 128 characters',
            field: 'idempotencyKey',
          })
          return
        }
        const baseRevision = body.baseRevision
        const operations = body.operations
        const planHash = body.planHash
        const idempotencyKey = body.idempotencyKey ?? null
        if (!Number.isInteger(baseRevision) || baseRevision < 0) {
          sendJson(res, 422, { ok: false, code: 'invalid-revision', message: 'baseRevision must be a non-negative integer' })
          return
        }
        if (typeof planHash !== 'string' || planHash.length === 0) {
          sendJson(res, 422, { ok: false, code: 'invalid-plan', message: 'planHash is required' })
          return
        }
        try {
          const resolvedProfile = await resolveControlProfile(profileManager, body.profileId, {
            requireExplicitWhenMultiple: true,
          })
          if (sendProfileFailure(res, resolvedProfile)) return
          const expectedHash = controlPlanHash(resolvedProfile.profileId, baseRevision, operations)
          if (expectedHash !== planHash) {
            sendJson(res, 409, { ok: false, code: 'stale-plan', message: 'planHash does not match profileId + baseRevision + operations' })
            return
          }
          const cacheKey = idempotencyKey === null ? null : `${resolvedProfile.profileId}:${idempotencyKey}`
          if (cacheKey !== null) {
            const cached = idempotency.get(cacheKey)
            if (cached !== undefined) {
              if (cached.planHash !== planHash) {
                sendJson(res, 409, { ok: false, code: 'idempotency-conflict', message: 'idempotencyKey was used for another plan' })
                return
              }
              sendJson(res, 200, cached.body)
              return
            }
          }
          const result = await resolvedProfile.store.load()
          if (result.kind === 'unsupported-version') {
            sendJson(res, 409, loadResponse(result).body)
            return
          }
          if (result.revision !== baseRevision) {
            sendJson(res, 409, { ok: false, code: 'conflict', message: 'revision mismatch', revision: result.revision })
            return
          }
          const planned = applyControlOperations(result.doc, operations, {
            allowDestructive: controlDestructiveEnabled(),
          })
          if (!planned.ok) {
            sendJson(res, isArchiveConflictCode(planned.code) ? 409 : 422, planned)
            return
          }
          const committed = await resolvedProfile.store.commit(baseRevision, planned.doc)
          // `commitResponse` already maps `archive-frozen` to a 409 body with
          // code:'archive-frozen', reason:<op code>, groupId/field. It must not
          // be wrapped as a 200 change set, and it never bumps the revision.
          const { status, body: committedBody } = commitResponse(committed)
          if (status === 200) {
            const responseBody = {
              ...committedBody,
              protocol: CONTROL_PROTOCOL,
              profileId: resolvedProfile.profileId,
              planHash,
              changes: planned.changes,
            }
            publishChange(committed.revision, 'control-apply', resolvedProfile.profileId)
            if (cacheKey !== null) remember(cacheKey, { planHash, body: responseBody })
            logInfo(
              ctx,
              `[dsh-session-grove] control apply profile=${resolvedProfile.profileId} revision=${String(
                committed.revision,
              )} plan=${planHash.slice(0, 12)} operations=${String(planned.changes.length)}`,
            )
            sendJson(res, 200, responseBody)
            return
          }
          sendJson(res, status, committedBody)
        } catch (error) {
          sendJson(res, 503, { ok: false, code: 'io', message: error instanceof Error ? error.message : String(error) })
        }
      },
      `dsh-session-grove: POST ${CONTROL_APPLY_PATH}`,
    )
  }

  return { eventsPath, controlStatePath, controlCatalogPath, controlDoctorPath, controlResolvePath, controlPlanPath, controlApplyPath }
}
