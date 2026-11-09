/**
 * Multi-profile management routes (SPEC 4.7 / 5.3-5.10).
 *
 * Six exact paths, no `:id` matcher:
 *   GET  /profiles              -> registry revision, active id, profile summary
 *   GET  /profiles/preview?id=  -> target doc + read-only preview token
 *   POST /profiles/create       -> doc-first clone of the active profile
 *   POST /profiles/rename
 *   POST /profiles/archive
 *   POST /profiles/activate     -> token-checked active switch
 *
 * Shared rules:
 * - every read path uses one registry snapshot (`loadRegistry`) to look up the
 *   entry; profile documents are only ever read through the side-effect-free
 *   `peekFor()` (no lock, no `.bak`, no quarantine);
 * - every write path rejects a degraded registry before doing anything else
 *   (SPEC 4.3), then relies on the registry's own CAS for the final word;
 * - create is doc-first (SPEC 4.4): the new document is written before the
 *   registry CAS; a registry failure deliberately leaves the orphan directory
 *   and never changes the active profile;
 * - errors funnel through `profileWriteFailure()` so codes/shapes stay uniform.
 *
 * @module host/profile-routes
 */

import { emptyDoc } from '../shared/model.js'
import { DOC_VERSION } from '../shared/constants.js'
import {
  DEFAULT_PROFILE_ID,
  MAX_PROFILES,
  PROFILES_ACTIVATE_PATH,
  PROFILES_ARCHIVE_PATH,
  PROFILES_CREATE_PATH,
  PROFILES_PATH,
  PROFILES_PREVIEW_PATH,
  PROFILES_RENAME_PATH,
} from './constants.js'
import { isProfileId } from './profile-registry.js'
import {
  contentTypeOf,
  isObject,
  normalizeProfileNameInput,
  previewStaleResponse,
  previewTokenFor,
  profileFailureResponse,
  profileHealth,
  profileListEntry,
  profileNameTaken,
  profileTargetFailure,
  profileWire,
  profileWriteFailure,
  readBoundedBody,
  registryUnhealthyResponse,
  sendJson,
  sendMethodNotAllowed,
} from './route-contract.js'

const queryParam = (url, name) => {
  try {
    return new URL(typeof url === 'string' ? url : '', 'http://127.0.0.1').searchParams.get(name)
  } catch {
    return null
  }
}

const invalidBody = (message) => ({ ok: false, code: 'invalid', message })

/**
 * Register the six profile routes.
 *
 * @param {{
 *   register: (path: string, handler: Function, label: string) => string,
 *   profileManager: {
 *     registry: { createProfile: Function, renameProfile: Function, archiveProfile: Function, activateProfile: Function },
 *     loadRegistry: () => Promise<object>,
 *     newProfileId: () => Promise<string>,
 *     storeFor: (id: string) => object,
 *     peekFor: (id: string) => Promise<object>,
 *   },
 *   fenceDenied: (req: object, res: object) => boolean,
 *   publishActive: (activeId: string, registryRevision: number) => void,
 * }} dependencies
 * @returns {{ profilesPath: string, previewPath: string, createPath: string, renamePath: string, archivePath: string, activatePath: string }}
 */
export const registerProfileRoutes = ({ register, profileManager, fenceDenied, publishActive }) => {
  const registry = profileManager.registry

  const readJsonBody = async (req, res) => {
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

  const sendWriteFailure = (res, result) => {
    const { status, body } = profileWriteFailure(result)
    sendJson(res, status, body)
  }

  const sendIo = (res, error) => {
    sendJson(res, 503, {
      ok: false,
      code: 'io',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  /**
   * Resolve read-only document health. The default profile keeps the legacy
   * semantics: a missing document is a healthy empty document (SPEC 4.2), while
   * named profiles are unhealthy when the document is missing/corrupt/invalid.
   */
  const healthFor = async (id) => {
    const peek = await profileManager.peekFor(id)
    if (peek.kind === 'ok') return { healthy: true, doc: peek.doc, revision: peek.revision, peek }
    if (id === DEFAULT_PROFILE_ID && peek.kind === 'missing') {
      return { healthy: true, doc: emptyDoc(), revision: 0, peek }
    }
    return { healthy: false, peek }
  }

  const sendActiveFailure = (res, activeId, health) => {
    const code = health.peek.kind === 'missing' ? 'profile-missing' : 'profile-unhealthy'
    sendJson(res, 409, profileFailureResponse(code, activeId, profileHealth(health.peek)).body)
  }

  const sendTargetFailure = (res, code, id, peek) => {
    sendJson(res, 409, profileTargetFailure(code, id, peek === null ? null : profileHealth(peek)).body)
  }

  /** Active revision for the preview token; `null` when the active is unhealthy. */
  const activeRevisionFor = async (state, targetId, targetRevision) => {
    const activeId = state.registry.activeId
    if (activeId === targetId) return targetRevision
    const health = await healthFor(activeId)
    return health.healthy ? health.revision : null
  }

  const profilesPath = register(
    PROFILES_PATH,
    async (req, res) => {
      if (fenceDenied(req, res)) return
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      try {
        const state = await profileManager.loadRegistry()
        const includeArchived = queryParam(req.url, 'includeArchived') === '1'
        const entries = state.registry.profiles.filter(
          (entry) => includeArchived || entry.archivedAt === null,
        )
        const profiles = []
        for (const entry of entries) {
          profiles.push(profileListEntry(entry, await healthFor(entry.id)))
        }
        sendJson(res, 200, {
          ok: true,
          registryRevision: state.revision,
          activeId: state.registry.activeId,
          degraded: state.degraded === true,
          limits: { max: MAX_PROFILES },
          profiles,
        })
      } catch (error) {
        sendIo(res, error)
      }
    },
    `dsh-session-grove: GET ${PROFILES_PATH}`,
  )

  const previewPath = register(
    PROFILES_PREVIEW_PATH,
    async (req, res) => {
      if (fenceDenied(req, res)) return
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      try {
        const id = queryParam(req.url, 'id')
        if (!isProfileId(id)) {
          sendJson(res, 422, {
            ok: false,
            code: 'invalid-profile-id',
            message: 'id must be a valid profile id',
          })
          return
        }
        const state = await profileManager.loadRegistry()
        if (state.degraded === true) {
          sendJson(res, 409, registryUnhealthyResponse().body)
          return
        }
        const entry = state.registry.profiles.find((profile) => profile.id === id) ?? null
        if (entry === null) {
          sendTargetFailure(res, 'profile-missing', id, { kind: 'missing' })
          return
        }
        if (entry.archivedAt !== null) {
          sendTargetFailure(res, 'profile-archived', id, { kind: 'archived' })
          return
        }
        const health = await healthFor(id)
        if (!health.healthy) {
          sendTargetFailure(
            res,
            health.peek.kind === 'missing' ? 'profile-missing' : 'profile-unhealthy',
            id,
            health.peek,
          )
          return
        }
        const activeId = state.registry.activeId
        const activeRevision = await activeRevisionFor(state, id, health.revision)
        const previewToken = previewTokenFor({
          activeId,
          activeRevision,
          targetId: id,
          targetRevision: health.revision,
          registryRevision: state.revision,
        })
        sendJson(res, 200, {
          ok: true,
          profile: {
            id: entry.id,
            name: entry.name ?? null,
            archived: false,
            healthy: true,
            updatedAt: entry.updatedAt,
          },
          revision: health.revision,
          doc: health.doc,
          activeId,
          activeRevision,
          registryRevision: state.revision,
          previewToken,
        })
      } catch (error) {
        sendIo(res, error)
      }
    },
    `dsh-session-grove: GET ${PROFILES_PREVIEW_PATH}`,
  )

  const createPath = register(
    PROFILES_CREATE_PATH,
    async (req, res) => {
      if (fenceDenied(req, res)) return
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const body = await readJsonBody(req, res)
      if (body === null) return
      if (!Number.isInteger(body.baseRevision) || body.baseRevision < 0) {
        sendJson(res, 422, invalidBody('baseRevision must be a non-negative integer'))
        return
      }
      // Pre-check the name before the doc-first write: a rejected name must not
      // leave a profile directory behind. The registry re-validates under CAS.
      const named = normalizeProfileNameInput(body.name)
      if (!named.ok) {
        sendWriteFailure(res, { kind: 'profile-name-invalid', reason: named.reason })
        return
      }
      try {
        const state = await profileManager.loadRegistry()
        if (state.degraded === true) {
          sendJson(res, 409, registryUnhealthyResponse().body)
          return
        }
        if (state.revision !== body.baseRevision) {
          sendWriteFailure(res, { kind: 'conflict', revision: state.revision })
          return
        }
        const activeId = state.registry.activeId
        const activeHealth = await healthFor(activeId)
        if (!activeHealth.healthy) {
          sendActiveFailure(res, activeId, activeHealth)
          return
        }
        if (state.registry.profiles.filter((profile) => profile.archivedAt === null).length >= MAX_PROFILES) {
          sendWriteFailure(res, { kind: 'profile-limit' })
          return
        }
        if (profileNameTaken(state.registry, named.name)) {
          sendWriteFailure(res, { kind: 'profile-name-duplicate' })
          return
        }

        const id = await profileManager.newProfileId()
        // SPEC 4.4 doc-first: write the clone, then add the entry + activate in
        // one registry CAS. A failure below keeps the orphan on disk on purpose.
        const sourceDoc = activeHealth.doc
        const saved = await profileManager.storeFor(id).save({
          version: DOC_VERSION,
          groups: sourceDoc.groups,
          ungrouped: sourceDoc.ungrouped,
        })
        const result = await registry.createProfile({
          baseRevision: body.baseRevision,
          id,
          name: named.name,
        })
        if (result.kind !== 'ok') {
          sendWriteFailure(res, result)
          return
        }
        const entry = result.registry.profiles.find((profile) => profile.id === id) ?? null
        publishActive(id, result.revision)
        sendJson(res, 200, {
          ok: true,
          registryRevision: result.revision,
          activeId: id,
          profile: profileWire(entry),
          doc: saved,
        })
      } catch (error) {
        sendIo(res, error)
      }
    },
    `dsh-session-grove: POST ${PROFILES_CREATE_PATH}`,
  )

  const renamePath = register(
    PROFILES_RENAME_PATH,
    async (req, res) => {
      if (fenceDenied(req, res)) return
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const body = await readJsonBody(req, res)
      if (body === null) return
      if (!Number.isInteger(body.baseRevision) || body.baseRevision < 0) {
        sendJson(res, 422, invalidBody('baseRevision must be a non-negative integer'))
        return
      }
      if (!isProfileId(body.id)) {
        sendWriteFailure(res, { kind: 'invalid-profile-id' })
        return
      }
      const named = normalizeProfileNameInput(body.name)
      if (!named.ok) {
        sendWriteFailure(res, { kind: 'profile-name-invalid', reason: named.reason })
        return
      }
      try {
        const state = await profileManager.loadRegistry()
        if (state.degraded === true) {
          sendJson(res, 409, registryUnhealthyResponse().body)
          return
        }
        const result = await registry.renameProfile({
          baseRevision: body.baseRevision,
          id: body.id,
          name: named.name,
        })
        if (result.kind !== 'ok') {
          sendWriteFailure(res, result)
          return
        }
        const entry = result.registry.profiles.find((profile) => profile.id === body.id) ?? null
        sendJson(res, 200, {
          ok: true,
          registryRevision: result.revision,
          profile: profileWire(entry),
        })
      } catch (error) {
        sendIo(res, error)
      }
    },
    `dsh-session-grove: POST ${PROFILES_RENAME_PATH}`,
  )

  const archivePath = register(
    PROFILES_ARCHIVE_PATH,
    async (req, res) => {
      if (fenceDenied(req, res)) return
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const body = await readJsonBody(req, res)
      if (body === null) return
      if (!Number.isInteger(body.baseRevision) || body.baseRevision < 0) {
        sendJson(res, 422, invalidBody('baseRevision must be a non-negative integer'))
        return
      }
      if (!isProfileId(body.id)) {
        sendWriteFailure(res, { kind: 'invalid-profile-id' })
        return
      }
      try {
        const state = await profileManager.loadRegistry()
        if (state.degraded === true) {
          sendJson(res, 409, registryUnhealthyResponse().body)
          return
        }
        const result = await registry.archiveProfile({ baseRevision: body.baseRevision, id: body.id })
        if (result.kind !== 'ok') {
          sendWriteFailure(res, result)
          return
        }
        sendJson(res, 200, {
          ok: true,
          registryRevision: result.revision,
          activeId: result.registry.activeId,
        })
      } catch (error) {
        sendIo(res, error)
      }
    },
    `dsh-session-grove: POST ${PROFILES_ARCHIVE_PATH}`,
  )

  const activatePath = register(
    PROFILES_ACTIVATE_PATH,
    async (req, res) => {
      if (fenceDenied(req, res)) return
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const body = await readJsonBody(req, res)
      if (body === null) return
      if (!isProfileId(body.id)) {
        sendWriteFailure(res, { kind: 'invalid-profile-id' })
        return
      }
      if (typeof body.previewToken !== 'string' || body.previewToken.length === 0) {
        sendJson(res, 422, invalidBody('previewToken must be a non-empty string'))
        return
      }
      try {
        const state = await profileManager.loadRegistry()
        if (state.degraded === true) {
          sendJson(res, 409, registryUnhealthyResponse().body)
          return
        }
        const entry = state.registry.profiles.find((profile) => profile.id === body.id) ?? null
        if (entry === null) {
          sendTargetFailure(res, 'profile-missing', body.id, { kind: 'missing' })
          return
        }
        if (entry.archivedAt !== null) {
          sendTargetFailure(res, 'profile-archived', body.id, { kind: 'archived' })
          return
        }
        const health = await healthFor(body.id)
        if (!health.healthy) {
          sendTargetFailure(
            res,
            health.peek.kind === 'missing' ? 'profile-missing' : 'profile-unhealthy',
            body.id,
            health.peek,
          )
          return
        }
        const activeId = state.registry.activeId
        const activeRevision = await activeRevisionFor(state, body.id, health.revision)
        const expectedToken = previewTokenFor({
          activeId,
          activeRevision,
          targetId: body.id,
          targetRevision: health.revision,
          registryRevision: state.revision,
        })
        if (body.previewToken !== expectedToken) {
          sendJson(
            res,
            409,
            previewStaleResponse({
              activeId,
              activeRevision,
              registryRevision: state.revision,
            }).body,
          )
          return
        }
        const result = await registry.activateProfile({
          id: body.id,
          expectedRegistryRevision: state.revision,
        })
        if (result.kind !== 'ok') {
          sendWriteFailure(res, result)
          return
        }
        const activated = result.registry.profiles.find((profile) => profile.id === body.id) ?? entry
        publishActive(body.id, result.revision)
        sendJson(res, 200, {
          ok: true,
          registryRevision: result.revision,
          activeId: body.id,
          profile: profileWire(activated),
          doc: health.doc,
        })
      } catch (error) {
        sendIo(res, error)
      }
    },
    `dsh-session-grove: POST ${PROFILES_ACTIVATE_PATH}`,
  )

  return { profilesPath, previewPath, createPath, renamePath, archivePath, activatePath }
}
