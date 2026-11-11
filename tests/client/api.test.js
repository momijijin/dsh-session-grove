import test from 'node:test'
import assert from 'node:assert/strict'
import {
  API_ERRORS,
  COMMIT_PATH,
  LOAD_PATH,
  PROFILES_ACTIVATE_PATH,
  PROFILES_ARCHIVE_PATH,
  PROFILES_CREATE_PATH,
  PROFILES_PATH,
  PROFILES_PREVIEW_PATH,
  PROFILES_RENAME_PATH,
  createApi,
} from '../../src/client/api.js'

const response = (status, body, contentType = 'application/json') => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
  json: async () => {
    if (body === undefined) throw new Error('no body')
    return body
  },
})

const fakeFetch = (handler) => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

const doc = { version: 1, revision: 3, groups: [], ungrouped: [] }

test('load resolves the relative route against document.baseURI', async () => {
  const fetchImpl = fakeFetch(() => response(200, { ok: true, revision: 3, doc }))
  const api = createApi({ fetchImpl, baseURI: 'http://127.0.0.1:4401/' })
  const result = await api.load()
  assert.equal(result.ok, true)
  assert.equal(result.revision, 3)
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:4401/dsh-session-grove/load')
  assert.match(fetchImpl.calls[0].url, new RegExp(LOAD_PATH))
})

test('load surfaces corrupt-file warnings and upgraded docs', async () => {
  const fetchImpl = fakeFetch(() => response(200, { ok: true, revision: 0, doc, warning: 'corrupt-file' }))
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).load()
  assert.equal(result.ok, true)
  assert.equal(result.warning, 'corrupt-file')
})

test('non-JSON 404 is a route-unavailable fallback (not a crash)', async () => {
  const fetchImpl = fakeFetch(() => response(404, undefined, 'text/html'))
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).load()
  assert.equal(result.ok, false)
  assert.equal(result.code, API_ERRORS.NOT_JSON)
  assert.equal(result.routeUnavailable, true)
})

test('network failure is classified without throwing', async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error('ECONNREFUSED')
  })
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).load()
  assert.equal(result.ok, false)
  assert.equal(result.code, API_ERRORS.NETWORK)
})

test('commit success returns the new revision and doc', async () => {
  const next = { ...doc, revision: 4 }
  const fetchImpl = fakeFetch((url, init) => {
    const payload = JSON.parse(init.body)
    assert.equal(payload.baseRevision, 3)
    assert.equal(url, 'http://x/dsh-session-grove/commit')
    assert.match(init.headers['content-type'], /json/)
    return response(200, { ok: true, revision: 4, doc: next })
  })
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).commit({ ...doc, revision: 999 }, 3)
  assert.equal(result.ok, true)
  assert.equal(result.revision, 4)
  assert.equal(result.doc, next)
  assert.match(fetchImpl.calls[0].url, new RegExp(COMMIT_PATH))
})

test('commit conflict adopts the server doc (409)', async () => {
  const serverDoc = { ...doc, revision: 9 }
  const fetchImpl = fakeFetch(() => response(409, { ok: false, code: 'conflict', revision: 9, doc: serverDoc }))
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).commit(doc, 3)
  assert.equal(result.ok, false)
  assert.equal(result.code, API_ERRORS.CONFLICT)
  assert.equal(result.conflict, true)
  assert.equal(result.revision, 9)
  assert.equal(result.doc, serverDoc)
})

test('commit 422/503 classify to stable codes', async () => {
  const invalid = fakeFetch(() => response(422, { ok: false, code: 'invalid', message: 'duplicate session id: s1' }))
  const invalidResult = await createApi({ fetchImpl: invalid, baseURI: 'http://x/' }).commit(doc, 0)
  assert.equal(invalidResult.code, API_ERRORS.INVALID)
  assert.equal(invalidResult.message, 'duplicate session id: s1')

  const fence = fakeFetch(() => response(503, { ok: false, code: 'fence-unavailable' }))
  const fenceResult = await createApi({ fetchImpl: fence, baseURI: 'http://x/' }).commit(doc, 0)
  assert.equal(fenceResult.code, API_ERRORS.FENCE)
})

test('unsupported-version 409 does not look like a doc conflict', async () => {
  const fetchImpl = fakeFetch(() => response(409, { ok: false, code: 'unsupported-version' }))
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).commit(doc, 0)
  assert.equal(result.code, API_ERRORS.UNSUPPORTED_VERSION)
  assert.equal(result.conflict, undefined)
})

test('load returns the active profileId (SPEC 5.1 additive field)', async () => {
  const fetchImpl = fakeFetch(() => response(200, { ok: true, profileId: 'work', revision: 3, doc }))
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).load()
  assert.equal(result.ok, true)
  assert.equal(result.profileId, 'work')
})

test('load from a legacy host leaves profileId undefined', async () => {
  const fetchImpl = fakeFetch(() => response(200, { ok: true, revision: 3, doc }))
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).load()
  assert.equal(result.ok, true)
  assert.equal(result.profileId, undefined)
})

test('commit sends profileId and echoes the confirmed profile', async () => {
  const next = { ...doc, revision: 4 }
  const fetchImpl = fakeFetch((url, init) => {
    const payload = JSON.parse(init.body)
    assert.equal(payload.baseRevision, 3)
    assert.equal(payload.profileId, 'work')
    assert.equal(url, 'http://x/dsh-session-grove/commit')
    return response(200, { ok: true, profileId: 'work', revision: 4, doc: next })
  })
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).commit(doc, 3, 'work')
  assert.equal(result.ok, true)
  assert.equal(result.profileId, 'work')
  assert.match(fetchImpl.calls[0].url, new RegExp(COMMIT_PATH))
})

test('commit without a known profile omits profileId (legacy body compatibility)', async () => {
  const fetchImpl = fakeFetch((url, init) => {
    const payload = JSON.parse(init.body)
    assert.equal('profileId' in payload, false)
    return response(200, { ok: true, revision: 4, doc })
  })
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).commit(doc, 3)
  assert.equal(result.ok, true)
})

test('commit 409 profile-changed is a recognizable non-conflict error', async () => {
  const fetchImpl = fakeFetch(() =>
    response(409, { ok: false, code: 'profile-changed', activeId: 'home', revision: 7, registryRevision: 4 }),
  )
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).commit(doc, 3, 'work')
  assert.equal(result.ok, false)
  assert.equal(result.code, API_ERRORS.PROFILE_CHANGED)
  assert.equal(result.conflict, undefined)
  assert.equal(result.activeId, 'home')
  assert.equal(result.revision, 7)
  assert.equal(result.registryRevision, 4)
})

test('commit 409 archive-frozen keeps the structured reason/groupId/field (0.4.0-beta.62 §6.4)', async () => {
  const fetchImpl = fakeFetch(() =>
    response(409, {
      ok: false,
      code: 'archive-frozen',
      reason: 'group-archived',
      groupId: 'g-1',
      field: 'name',
      message: 'group-archived',
    }),
  )
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).commit(doc, 3, 'default')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'archive-frozen')
  assert.equal(result.conflict, undefined, 'an archive freeze is not a revision conflict')
  assert.equal(result.reason, 'group-archived')
  assert.equal(result.groupId, 'g-1')
  assert.equal(result.field, 'name')
  assert.equal(result.message, 'group-archived')
})

test('listProfiles gets the registry summary and forwards archived opt-in', async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.endsWith('?includeArchived=1')) {
      return response(200, {
        ok: true,
        registryRevision: 5,
        activeId: 'work',
        degraded: false,
        limits: { max: 20 },
        profiles: [{ id: 'work', name: 'Work', archived: true, healthy: true }],
      })
    }
    return response(200, {
      ok: true,
      registryRevision: 4,
      activeId: 'default',
      degraded: true,
      limits: { max: 20 },
      profiles: [{ id: 'default', name: null, archived: false, healthy: true, groupCount: 2, sessionCount: 3 }],
    })
  })
  const api = createApi({ fetchImpl, baseURI: 'http://x/' })
  const plain = await api.listProfiles()
  assert.equal(plain.ok, true)
  assert.equal(plain.registryRevision, 4)
  assert.equal(plain.activeId, 'default')
  assert.equal(plain.degraded, true)
  assert.equal(plain.profiles[0].groupCount, 2)
  assert.deepEqual(plain.limits, { max: 20 })
  assert.equal(fetchImpl.calls[0].url, 'http://x/dsh-session-grove/profiles')
  assert.match(fetchImpl.calls[0].url, new RegExp(PROFILES_PATH))

  const archived = await api.listProfiles({ includeArchived: true })
  assert.equal(archived.ok, true)
  assert.equal(archived.profiles[0].archived, true)
  assert.deepEqual(archived.limits, { max: 20 })
  assert.equal(fetchImpl.calls[1].url, 'http://x/dsh-session-grove/profiles?includeArchived=1')
})

test('listProfiles non-JSON 404 marks the profile surface unavailable (old host)', async () => {
  const fetchImpl = fakeFetch(() => response(404, undefined, 'text/html'))
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).listProfiles()
  assert.equal(result.ok, false)
  assert.equal(result.code, API_ERRORS.NOT_JSON)
  assert.equal(result.routeUnavailable, true)
  assert.equal(result.profilesAvailable, false)
})

test('previewProfile requests the id query and returns doc + token', async () => {
  const targetDoc = { ...doc, revision: 9 }
  const fetchImpl = fakeFetch((url) => {
    assert.equal(url, 'http://x/dsh-session-grove/profiles/preview?id=work-1')
    return response(200, {
      ok: true,
      profile: { id: 'work-1', name: 'Work', archived: false, healthy: true },
      revision: 9,
      doc: targetDoc,
      activeId: 'default',
      activeRevision: 3,
      registryRevision: 4,
      previewToken: 'token-abc',
    })
  })
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).previewProfile('work-1')
  assert.equal(result.ok, true)
  assert.equal(result.doc, targetDoc)
  assert.equal(result.revision, 9)
  assert.equal(result.activeRevision, 3)
  assert.equal(result.previewToken, 'token-abc')
  assert.match(fetchImpl.calls[0].url, new RegExp(PROFILES_PREVIEW_PATH))
})

test('profile write helpers POST the documented bodies', async () => {
  const seen = []
  const fetchImpl = fakeFetch((url, init) => {
    seen.push({ url, body: JSON.parse(init.body), method: init.method })
    return response(200, { ok: true, registryRevision: 6, activeId: 'work', profile: { id: 'work' }, doc })
  })
  const api = createApi({ fetchImpl, baseURI: 'http://x/' })
  await api.createProfile({ name: 'Work', baseRevision: 4 })
  await api.renameProfile({ id: 'work', name: 'Renamed', baseRevision: 6 })
  await api.archiveProfile({ id: 'work', baseRevision: 7 })
  await api.activateProfile({ id: 'work', previewToken: 'token-abc' })

  assert.match(seen[0].url, new RegExp(PROFILES_CREATE_PATH))
  assert.deepEqual(seen[0].body, { baseRevision: 4, name: 'Work' })
  assert.match(seen[1].url, new RegExp(PROFILES_RENAME_PATH))
  assert.deepEqual(seen[1].body, { id: 'work', name: 'Renamed', baseRevision: 6 })
  assert.match(seen[2].url, new RegExp(PROFILES_ARCHIVE_PATH))
  assert.deepEqual(seen[2].body, { id: 'work', baseRevision: 7 })
  assert.match(seen[3].url, new RegExp(PROFILES_ACTIVATE_PATH))
  assert.deepEqual(seen[3].body, { id: 'work', previewToken: 'token-abc' })
  for (const call of seen) assert.equal(call.method, 'POST')
})

test('profile errors keep their host codes and recovery context', async () => {
  const duplicate = fakeFetch(() => response(422, { ok: false, code: 'profile-name-duplicate', message: 'taken' }))
  const dup = await createApi({ fetchImpl: duplicate, baseURI: 'http://x/' }).createProfile({ name: 'Work', baseRevision: 1 })
  assert.equal(dup.ok, false)
  assert.equal(dup.code, API_ERRORS.PROFILE_NAME_DUPLICATE)
  assert.equal(dup.message, 'taken')

  const degraded = fakeFetch(() => response(409, { ok: false, code: 'registry-unhealthy' }))
  const reg = await createApi({ fetchImpl: degraded, baseURI: 'http://x/' }).renameProfile({ id: 'work', name: 'x', baseRevision: 1 })
  assert.equal(reg.code, API_ERRORS.REGISTRY_UNHEALTHY)

  const stale = fakeFetch(() =>
    response(409, { ok: false, code: 'preview-stale', activeId: 'default', activeRevision: 3, registryRevision: 8 }),
  )
  const preview = await createApi({ fetchImpl: stale, baseURI: 'http://x/' }).activateProfile({ id: 'work', previewToken: 'old' })
  assert.equal(preview.code, API_ERRORS.PREVIEW_STALE)
  assert.equal(preview.activeId, 'default')
  assert.equal(preview.activeRevision, 3)
  assert.equal(preview.registryRevision, 8)
})

test('profile network failure classifies without throwing', async () => {
  const fetchImpl = fakeFetch(() => {
    throw new Error('ECONNREFUSED')
  })
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).listProfiles()
  assert.equal(result.ok, false)
  assert.equal(result.code, API_ERRORS.NETWORK)
  assert.equal(result.profilesAvailable, undefined)
})
