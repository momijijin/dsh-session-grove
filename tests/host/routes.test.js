import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  COMMIT_PATH,
  DEBUG_PATH,
  DIAGNOSTICS_PATH,
  LOAD_PATH,
  MAX_BODY_BYTES,
  MAX_DIAGNOSTICS_BODY_BYTES,
  MAX_DIAGNOSTICS_EVENTS,
  PROFILES_ACTIVATE_PATH,
  PROFILES_ARCHIVE_PATH,
  PROFILES_CREATE_PATH,
  PROFILES_PATH,
  PROFILES_PREVIEW_PATH,
  PROFILES_RENAME_PATH,
  RECORD_FILE_NAME,
  SKILL_REPAIR_PATH,
} from '../../src/host/constants.js'
import { commitResponse, loadResponse } from '../../src/host/http/respond.js'
import { parseCommitBody, parseDiagnosticsBody } from '../../src/host/http/wire.js'
import { createChangeHub } from '../../src/host/change-hub.js'
import { createStore } from '../../src/host/store.js'
import {
  PROFILE_ID,
  createTestProfileManager,
  makeRequest,
  makeResponse,
  makeTempProfileHome,
  makeTempStore,
  mountRoutes,
  sampleDoc,
  sampleDefaultProfile,
  sampleNamedProfile,
  sampleRegistry,
  writeJsonFile,
  writeProfileDoc,
} from './helpers.js'

/** Fake connection mimicking the host fence: Host/Origin + session cookie. */
const cookieConnection = () => ({
  requestRejection(request) {
    const host = request.headers.host
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host ?? '')) return 403
    if (request.headers['sec-fetch-site'] === 'cross-site') return 403
    const origin = request.headers.origin
    if (typeof origin === 'string') {
      try {
        if (new URL(origin).host !== host) return 403
      } catch {
        return 403
      }
    }
    return request.headers.cookie === 'token=ok' ? undefined : 401
  },
})

const allowedHeaders = { cookie: 'token=ok', 'content-type': 'application/json', origin: 'http://127.0.0.1:4400' }

const commitBody = (baseRevision, doc) => JSON.stringify({ baseRevision, doc })

test('route registration mounts the frozen paths and diagnostics by default', async (t) => {
  const mounted = await mountRoutes()
  t.after(() => mounted.cleanup())
  assert.equal(mounted.routes.length, 13)
  for (const path of [LOAD_PATH, COMMIT_PATH, DIAGNOSTICS_PATH, DEBUG_PATH]) {
    assert.equal(mounted.routes.some((route) => route.path === path), true)
  }
  assert.deepEqual(mounted.mounted.routes.slice(0, 3), [LOAD_PATH, COMMIT_PATH, DIAGNOSTICS_PATH])
  assert.equal(mounted.mounted.routes.includes('/dsh-session-grove/control/state'), true)
  assert.equal(mounted.mounted.routes.includes('/dsh-session-grove/control/catalog'), true)
  assert.equal(mounted.mounted.routes.includes('/dsh-session-grove/control/session/inspect'), true)
  assert.equal(
    mounted.routes.some((route) => route.path.startsWith('/dsh-session-grove/profiles')),
    false,
    'the legacy single-store adapter keeps the pre-profile route set',
  )
})

test('a legacy single-store composition with events and skill repair keeps 15 routes', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const hub = createChangeHub()
  t.after(() => hub.close())
  const mounted = await mountRoutes({
    store: temp.store,
    dir: temp.dir,
    filePath: temp.filePath,
    connection: cookieConnection(),
    changeHub: hub,
    skillDshHome: temp.dir,
  })
  assert.equal(mounted.routes.length, 15)
  assert.equal(
    mounted.routes.some((route) => route.path.startsWith('/dsh-session-grove/profiles')),
    false,
    'no profile management surface without a profile manager',
  )
})

test('diagnostics and debugProbe flags are live per request', async (t) => {
  const flags = { diagnostics: false, debugProbe: false }
  const mounted = await mountRoutes({
    connection: cookieConnection(),
    diagnosticsEnabled: () => flags.diagnostics,
    debugProbeEnabled: () => flags.debugProbe,
  })
  t.after(() => mounted.cleanup())

  const before = await mounted.call(LOAD_PATH, makeRequest({ headers: { cookie: 'token=ok' } }))
  assert.equal(before.json.diagnostics, false)
  assert.equal(before.json.debugProbe, false)
  const debugOff = await mounted.call(
    DEBUG_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: '{}' }),
  )
  assert.equal(debugOff.res.statusCode, 404)
  assert.equal(debugOff.json.code, 'debug-disabled')

  flags.diagnostics = true
  flags.debugProbe = true
  const after = await mounted.call(LOAD_PATH, makeRequest({ headers: { cookie: 'token=ok' } }))
  assert.equal(after.json.diagnostics, true)
  assert.equal(after.json.debugProbe, true)
  const debugOn = await mounted.call(
    DEBUG_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: '{"probe":true}' }),
  )
  assert.equal(debugOn.res.statusCode, 200)
  assert.equal(debugOn.json.ok, true)
})

test('the debug probe route mounts only when explicitly enabled', async (t) => {
  const mounted = await mountRoutes({ debugProbeEnabled: true })
  t.after(() => mounted.cleanup())
  assert.equal(mounted.mounted.routes.includes(DEBUG_PATH), true)
})

test('skill repair never overwrites a user-owned skill file', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const skillDir = join(temp.dir, 'skills', 'session-grove-control')
  const skillPath = join(skillDir, 'SKILL.md')
  await mkdir(skillDir, { recursive: true })
  await writeFile(skillPath, 'my own skill\n', 'utf8')
  const mounted = await mountRoutes({
    store: temp.store,
    dir: temp.dir,
    filePath: temp.filePath,
    connection: cookieConnection(),
    controlApiEnabled: true,
    skillDshHome: temp.dir,
  })
  t.after(() => mounted.cleanup())

  const repaired = await mounted.call(
    SKILL_REPAIR_PATH,
    makeRequest({ method: 'POST', headers: { cookie: 'token=ok' } }),
  )
  assert.equal(repaired.res.statusCode, 409)
  assert.equal(repaired.json.code, 'skill-user-owned')
  assert.equal(await readFile(skillPath, 'utf8'), 'my own skill\n')
})

test('the fence runs first: no connection -> 503 fence-unavailable on both routes', async (t) => {
  const mounted = await mountRoutes()
  t.after(() => mounted.cleanup())

  const load = await mounted.call(LOAD_PATH, makeRequest())
  assert.equal(load.res.statusCode, 503)
  assert.deepEqual(load.json, {
    ok: false,
    code: 'fence-unavailable',
    message: 'connection.requestRejection is unavailable; refusing to serve group routes',
  })

  const commit = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: { 'content-type': 'application/json' }, body: commitBody(0, sampleDoc()) }),
  )
  assert.equal(commit.res.statusCode, 503)
  assert.equal(commit.json.code, 'fence-unavailable')
})

test('the host fence statuses pass through (401 no cookie, 403 foreign host/cross-origin)', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection() })
  t.after(() => mounted.cleanup())

  const noCookie = await mounted.call(LOAD_PATH, makeRequest())
  assert.equal(noCookie.res.statusCode, 401)

  const foreignHost = await mounted.call(
    LOAD_PATH,
    makeRequest({ headers: { cookie: 'token=ok', host: 'evil.example:4400' } }),
  )
  assert.equal(foreignHost.res.statusCode, 403)

  const crossOrigin = await mounted.call(
    COMMIT_PATH,
    makeRequest({
      method: 'POST',
      headers: { cookie: 'token=ok', 'content-type': 'application/json', origin: 'http://evil.example' },
      body: commitBody(0, sampleDoc()),
    }),
  )
  assert.equal(crossOrigin.res.statusCode, 403)
})

test('GET load returns 200 JSON, no CORS, no-store, and the empty document', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection() })
  t.after(() => mounted.cleanup())
  const { res, json } = await mounted.call(LOAD_PATH, makeRequest({ headers: { cookie: 'token=ok' } }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['access-control-allow-origin'], undefined)
  assert.deepEqual(json, {
    ok: true,
    profileId: 'default',
    revision: 0,
    doc: { version: 1, revision: 0, groups: [], ungrouped: [] },
    diagnostics: true,
    debugProbe: false,
  })
})

test('method mismatch returns 405 with an Allow header', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection() })
  t.after(() => mounted.cleanup())

  const load = await mounted.call(LOAD_PATH, makeRequest({ method: 'POST', headers: { cookie: 'token=ok' } }))
  assert.equal(load.res.statusCode, 405)
  assert.equal(load.res.headers.allow, 'GET')

  const commit = await mounted.call(COMMIT_PATH, makeRequest({ method: 'GET', headers: { cookie: 'token=ok' } }))
  assert.equal(commit.res.statusCode, 405)
  assert.equal(commit.res.headers.allow, 'POST')
})

test('POST commit: 200 on success, then 409 conflict with the current doc on a stale base', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection() })
  t.after(() => mounted.cleanup())

  const first = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(0, { ...sampleDoc(), revision: 999 }) }),
  )
  assert.equal(first.res.statusCode, 200)
  assert.equal(first.json.ok, true)
  assert.equal(first.json.profileId, 'default')
  assert.equal(first.json.revision, 1)
  assert.equal(first.json.doc.revision, 1)

  const stale = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(0, sampleDoc()) }),
  )
  assert.equal(stale.res.statusCode, 409)
  assert.equal(stale.json.ok, false)
  assert.equal(stale.json.code, 'conflict')
  assert.equal(stale.json.revision, 1)
  assert.equal(stale.json.doc.revision, 1)
})

test('POST commit: old clients inherit archived; a frozen edit gets 409 archive-frozen', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection() })
  t.after(() => mounted.cleanup())

  const archived = sampleDoc()
  archived.groups[0].archived = true
  const first = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(0, archived) }),
  )
  assert.equal(first.res.statusCode, 200)
  assert.equal(first.json.doc.groups[0].archived, true)
  assert.equal(first.json.doc.groups[1].archived, false, 'every persisted group is an explicit boolean')

  // A pre-0.4.0-beta.62 client drops the unknown field; the edit must fail.
  const oldClient = sampleDoc()
  oldClient.groups[0].name = 'Renamed by an old client'
  delete oldClient.groups[0].archived
  const frozen = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(1, oldClient) }),
  )
  assert.equal(frozen.res.statusCode, 409)
  assert.deepEqual(frozen.json, {
    ok: false,
    code: 'archive-frozen',
    reason: 'group-archived',
    groupId: 'g-aaaaaaaaaaaa',
    field: 'name',
    message: 'group-archived',
  })

  const loaded = await mounted.call(LOAD_PATH, makeRequest({ headers: { cookie: 'token=ok' } }))
  assert.equal(loaded.res.statusCode, 200)
  assert.equal(loaded.json.revision, 1, 'the rejected commit must not bump the revision')
  assert.equal(loaded.json.doc.groups[0].archived, true)

  // The same old client resubmitting without an edit is accepted: inheritance
  // keeps the archived flag and the invariant sees no transition.
  const inherited = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(1, sampleDoc()) }),
  )
  assert.equal(inherited.res.statusCode, 200)
  assert.equal(inherited.json.revision, 2)
  assert.equal(inherited.json.doc.groups[0].archived, true)
})

test('POST commit: archive-frozen is never broadcast as a revision', async (t) => {
  const published = []
  const hub = {
    publish: (...args) => published.push(args),
    publishActive: () => undefined,
  }
  const mounted = await mountRoutes({ connection: cookieConnection(), changeHub: hub })
  t.after(() => mounted.cleanup())

  const archived = sampleDoc()
  archived.groups[0].archived = true
  const first = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(0, archived) }),
  )
  assert.equal(first.res.statusCode, 200)
  assert.equal(published.length, 1)

  const frozenDoc = sampleDoc()
  frozenDoc.groups[0].archived = true
  frozenDoc.groups[0].name = 'Renamed while archived'
  const frozen = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(1, frozenDoc) }),
  )
  assert.equal(frozen.res.statusCode, 409)
  assert.equal(frozen.json.code, 'archive-frozen')
  assert.equal(published.length, 1, 'a rejected commit must not publish a revision')

  const renamed = sampleDoc()
  renamed.ungrouped = ['s-4', 's-5']
  const accepted = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(1, renamed) }),
  )
  assert.equal(accepted.res.statusCode, 200)
  assert.equal(published.length, 2, 'the next legal commit publishes normally')
})

test('POST commit round-trips palette colors and normalizes legacy groups to blue', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection() })
  t.after(() => mounted.cleanup())

  const doc = sampleDoc()
  doc.groups[0] = { ...doc.groups[0], color: 'purple' }
  const first = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(0, doc) }),
  )
  assert.equal(first.res.statusCode, 200)
  assert.equal(first.json.ok, true)
  assert.equal(first.json.doc.groups[0].color, 'purple', 'chosen palette id persists')
  assert.equal(first.json.doc.groups[1].color, 'blue', 'missing color normalizes to the blue default on write')

  const loaded = await mounted.call(LOAD_PATH, makeRequest({ headers: { cookie: 'token=ok' } }))
  assert.equal(loaded.res.statusCode, 200)
  assert.equal(loaded.json.doc.groups[0].color, 'purple')
  assert.equal(loaded.json.doc.groups[1].color, 'blue')

  // A legacy document on disk (no color) still loads; display falls back to blue.
  const legacy = sampleDoc()
  delete legacy.groups[0].color
  const legacyWrite = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(1, legacy) }),
  )
  assert.equal(legacyWrite.res.statusCode, 200)
  assert.equal(legacyWrite.json.doc.groups[0].color, 'blue')
})

test('POST commit normalizes custom colorHex and rejects alpha/invalid values', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection() })
  t.after(() => mounted.cleanup())

  const doc = sampleDoc()
  doc.groups[0] = { ...doc.groups[0], color: 'purple', colorHex: '#A1B2C3' }
  const write = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(0, doc) }),
  )
  assert.equal(write.res.statusCode, 200)
  assert.equal(write.json.doc.groups[0].colorHex, '#a1b2c3', 'valid hex is normalized to lowercase')
  assert.equal(write.json.doc.groups[0].color, 'purple', 'palette identity is preserved alongside the custom color')

  const loaded = await mounted.call(LOAD_PATH, makeRequest({ headers: { cookie: 'token=ok' } }))
  assert.equal(loaded.json.doc.groups[0].colorHex, '#a1b2c3')

  for (const [name, colorHex, pattern] of [
    ['alpha hex', '#11223344', /group-color-hex/],
    ['alpha short', '#abcd', /group-color-hex/],
    ['named color', 'red', /group-color-hex/],
  ]) {
    const invalid = sampleDoc()
    invalid.groups[0] = { ...invalid.groups[0], colorHex }
    const { res, json } = await mounted.call(
      COMMIT_PATH,
      makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(1, invalid) }),
    )
    assert.equal(res.statusCode, 422, name)
    assert.match(json.message, pattern, name)
  }
})

test('POST commit rejects unknown palette ids with 422 group-color', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection() })
  t.after(() => mounted.cleanup())

  const doc = sampleDoc()
  doc.groups[0] = { ...doc.groups[0], color: 'chartreuse' }
  const { res, json } = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(0, doc) }),
  )
  assert.equal(res.statusCode, 422)
  assert.equal(json.code, 'invalid')
  assert.match(json.message, /group-color:g-aaaaaaaaaaaa/)
})

test('POST commit rejects malformed bodies with 422 invalid', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection() })
  t.after(() => mounted.cleanup())

  const cases = [
    { name: 'malformed JSON', body: '{', expected: /not valid JSON/ },
    { name: 'non-object body', body: '[]', expected: /must be a JSON object/ },
    { name: 'missing baseRevision', body: JSON.stringify({ doc: sampleDoc() }), expected: /baseRevision/ },
    { name: 'invalid doc', body: commitBody(0, { version: 1, groups: [{ id: 'g-a', name: 'A', parentId: null, sessionIds: ['s1'] }], ungrouped: ['s1'] }), expected: /duplicate-session:s1/ },
    { name: 'wrong version', body: commitBody(0, { ...sampleDoc(), version: 2 }), expected: /version must be 1/ },
    { name: 'unknown group color', body: commitBody(0, { ...sampleDoc(), groups: [{ ...sampleDoc().groups[0], color: 'chartreuse' }] }), expected: /group-color/ },
    { name: 'non-boolean archived', body: commitBody(0, { ...sampleDoc(), groups: [{ ...sampleDoc().groups[0], archived: 'true' }] }), expected: /group-archived-type:g-aaaaaaaaaaaa/ },
  ]
  for (const item of cases) {
    const { res, json } = await mounted.call(
      COMMIT_PATH,
      makeRequest({ method: 'POST', headers: allowedHeaders, body: item.body }),
    )
    assert.equal(res.statusCode, 422, item.name)
    assert.equal(json.code, 'invalid', item.name)
    assert.match(json.message, item.expected, item.name)
  }
})

test('POST commit rejects non-JSON content types with 415', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection() })
  t.after(() => mounted.cleanup())
  const { res, json } = await mounted.call(
    COMMIT_PATH,
    makeRequest({
      method: 'POST',
      headers: { cookie: 'token=ok', 'content-type': 'text/plain' },
      body: '{}',
    }),
  )
  assert.equal(res.statusCode, 415)
  assert.equal(json.code, 'unsupported-media-type')
})

test('POST commit rejects bodies over 256 KiB with 413 (streamed and declared)', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection() })
  t.after(() => mounted.cleanup())

  const streamed = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: 'x'.repeat(MAX_BODY_BYTES + 2) }),
  )
  assert.equal(streamed.res.statusCode, 413)
  assert.equal(streamed.json.code, 'payload-too-large')

  const declared = await mounted.call(
    COMMIT_PATH,
    makeRequest({
      method: 'POST',
      headers: { ...allowedHeaders, 'content-length': String(MAX_BODY_BYTES + 1) },
      body: '{}',
    }),
  )
  assert.equal(declared.res.statusCode, 413)
})

test('POST commit returns 400 when the request stream is unreadable', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection() })
  t.after(() => mounted.cleanup())
  const request = {
    method: 'POST',
    headers: { host: '127.0.0.1:4400', cookie: 'token=ok', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    resume() {},
    async *[Symbol.asyncIterator]() {
      throw new Error('socket reset')
    },
  }
  const res = makeResponse()
  await mounted.routes.find((route) => route.path === COMMIT_PATH).handler(request, res)
  assert.equal(res.statusCode, 400)
  assert.match(String(res.body), /bad-request/)
})

test('load maps unsupported-version to 409 and corrupt/invalid files to 200 + warning', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection() })
  t.after(() => mounted.cleanup())

  await writeFile(mounted.filePath, JSON.stringify({ version: 2, revision: 5, groups: [], ungrouped: [] }), 'utf8')
  const unsupported = await mounted.call(LOAD_PATH, makeRequest({ headers: { cookie: 'token=ok' } }))
  assert.equal(unsupported.res.statusCode, 409)
  assert.equal(unsupported.json.code, 'unsupported-version')

  await writeFile(mounted.filePath, 'not json', 'utf8')
  const corrupt = await mounted.call(LOAD_PATH, makeRequest({ headers: { cookie: 'token=ok' } }))
  assert.equal(corrupt.res.statusCode, 200)
  assert.equal(corrupt.json.warning, 'corrupt-file')
  assert.match(corrupt.json.quarantinedTo, /dsh-session-grove\.corrupt-.*\.json$/)
  assert.deepEqual(corrupt.json.doc, { version: 1, revision: 0, groups: [], ungrouped: [] })
})

test('load maps a genuine IO failure to 503 io', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await mkdir(temp.filePath, { recursive: true })
  const store = createStore({ filePath: temp.filePath })
  const mounted = await mountRoutes({
    connection: cookieConnection(),
    store,
    filePath: temp.filePath,
    dir: temp.dir,
  })
  const { res, json } = await mounted.call(LOAD_PATH, makeRequest({ headers: { cookie: 'token=ok' } }))
  assert.equal(res.statusCode, 503)
  assert.equal(json.code, 'io')
})

test('parseCommitBody ignores the client revision and validates the frozen shape', () => {
  assert.equal(parseCommitBody(null).ok, false)
  assert.equal(parseCommitBody({ baseRevision: 0 }).ok, false)
  assert.equal(parseCommitBody({ baseRevision: -1, doc: sampleDoc() }).ok, false)

  const parsed = parseCommitBody({ baseRevision: 7, doc: { ...sampleDoc(), revision: 123 } })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.baseRevision, 7)
  assert.equal(parsed.profileId, null, 'an absent profileId targets the active profile')
  assert.equal(parsed.doc.revision, 0)
  assert.equal(parsed.doc.groups[0].color, 'blue', 'the route stamps the default palette id')

  const scoped = parseCommitBody({ baseRevision: 7, doc: sampleDoc(), profileId: PROFILE_ID })
  assert.equal(scoped.ok, true)
  assert.equal(scoped.profileId, PROFILE_ID)

  // 0.4.0-beta.62 additive `archived`: missing stays missing here (the store
  // inherits it from the current doc); explicit booleans survive verbatim.
  assert.equal(Object.hasOwn(parsed.doc.groups[0], 'archived'), false)
  for (const archived of [true, false]) {
    const doc = sampleDoc()
    doc.groups[0].archived = archived
    const flagged = parseCommitBody({ baseRevision: 7, doc })
    assert.equal(flagged.ok, true)
    assert.equal(flagged.doc.groups[0].archived, archived)
  }
  for (const archived of ['true', 1, null, {}]) {
    const doc = sampleDoc()
    doc.groups[0].archived = archived
    const invalidArchived = parseCommitBody({ baseRevision: 7, doc })
    assert.equal(invalidArchived.ok, false, `archived ${JSON.stringify(archived)} must be rejected`)
    assert.match(invalidArchived.message, /group-archived-type:g-aaaaaaaaaaaa/)
  }

  for (const profileId of [null, 42, '', '   ', 'x'.repeat(65)]) {
    const invalid = parseCommitBody({ baseRevision: 7, doc: sampleDoc(), profileId })
    assert.equal(invalid.ok, false, `profileId ${String(profileId)} must be rejected`)
    assert.match(invalid.message, /profileId/)
  }
})

test('loadResponse/commitResponse map store results to the frozen wire shapes', () => {
  const loaded = loadResponse({ kind: 'ok', doc: { version: 1, revision: 4, groups: [], ungrouped: [] }, revision: 4 })
  assert.equal(loaded.status, 200)
  assert.equal(loaded.body.revision, 4)

  const named = loadResponse(
    { kind: 'ok', doc: { version: 1, revision: 4, groups: [], ungrouped: [] }, revision: 4 },
    PROFILE_ID,
  )
  assert.equal(named.body.profileId, PROFILE_ID)
  assert.equal(
    loadResponse({ kind: 'unsupported-version', version: 2 }).body.profileId,
    undefined,
    'the legacy error shape is unchanged',
  )

  const conflict = commitResponse({ kind: 'conflict', doc: { version: 1, revision: 9, groups: [], ungrouped: [] }, revision: 9 })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.code, 'conflict')
  assert.equal(conflict.body.revision, 9)

  assert.equal(commitResponse({ kind: 'invalid', errors: ['duplicate-session:s1'] }).status, 422)
  assert.equal(commitResponse({ kind: 'unsupported-version', version: 2 }).status, 409)

  const frozen = commitResponse({
    kind: 'archive-frozen',
    code: 'group-archived',
    groupId: 'g-a',
    field: 'name',
    message: 'group-archived',
  })
  assert.equal(frozen.status, 409)
  assert.deepEqual(frozen.body, {
    ok: false,
    code: 'archive-frozen',
    reason: 'group-archived',
    groupId: 'g-a',
    field: 'name',
    message: 'group-archived',
  })
})

// ---------------------------------------------------------------------------
// Multi-profile load/commit (SPEC 4.6/4.7/5.1/5.2/5.9)
// ---------------------------------------------------------------------------

const makeProfileRoutes = async (t, { activeId, revision = 3, profiles } = {}) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({
      revision,
      activeId,
      profiles: profiles ?? [sampleDefaultProfile(), sampleNamedProfile()],
    }),
  )
  const manager = createTestProfileManager(home)
  const mounted = await mountRoutes({ profileManager: manager, connection: cookieConnection() })
  return { home, manager, mounted }
}

test('a profile-manager composition mounts the six profile routes (19 total)', async (t) => {
  const { mounted } = await makeProfileRoutes(t, { activeId: 'default' })
  assert.equal(mounted.routes.length, 19)
  for (const path of [
    PROFILES_PATH,
    PROFILES_PREVIEW_PATH,
    PROFILES_CREATE_PATH,
    PROFILES_RENAME_PATH,
    PROFILES_ARCHIVE_PATH,
    PROFILES_ACTIVATE_PATH,
  ]) {
    assert.equal(mounted.routes.some((route) => route.path === path), true, `${path} must be mounted`)
    assert.equal(mounted.mounted.routes.includes(path), true, `${path} must be reported by registerRoutes`)
  }
  assert.deepEqual(
    mounted.mounted.routes.slice(-6),
    [
      PROFILES_PATH,
      PROFILES_PREVIEW_PATH,
      PROFILES_CREATE_PATH,
      PROFILES_RENAME_PATH,
      PROFILES_ARCHIVE_PATH,
      PROFILES_ACTIVATE_PATH,
    ],
    'profile routes are appended after the historical host surface',
  )
})

test('load serves the named active profile read-only and reports its profileId', async (t) => {
  const { home, mounted } = await makeProfileRoutes(t, { activeId: PROFILE_ID })
  await writeProfileDoc(home, PROFILE_ID, { revision: 2 })

  const { res, json } = await mounted.call(LOAD_PATH, makeRequest({ headers: { cookie: 'token=ok' } }))
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.profileId, PROFILE_ID)
  assert.equal(json.revision, 2)
  assert.equal(json.doc.revision, 2)
  assert.equal(json.diagnostics, true)
  await assert.rejects(access(home.defaultFilePath), /ENOENT/, 'reading a named profile never touches the default doc')
})

test('load maps a corrupt named active to 409 profile-unhealthy without quarantining', async (t) => {
  const { home, mounted } = await makeProfileRoutes(t, { activeId: PROFILE_ID })
  await writeProfileDoc(home, PROFILE_ID)
  const docPath = join(home.profilesDir, PROFILE_ID, RECORD_FILE_NAME)
  await writeFile(docPath, '{ not json', 'utf8')

  const { res, json } = await mounted.call(LOAD_PATH, makeRequest({ headers: { cookie: 'token=ok' } }))
  assert.equal(res.statusCode, 409)
  assert.equal(json.ok, false)
  assert.equal(json.code, 'profile-unhealthy')
  assert.equal(json.activeId, PROFILE_ID)
  assert.equal(json.health.kind, 'corrupt')
  assert.deepEqual(await readdir(join(home.profilesDir, PROFILE_ID)), [RECORD_FILE_NAME], 'peek must not quarantine or lock')
  assert.equal(await readFile(docPath, 'utf8'), '{ not json')
})

test('load maps a missing named active document to 409 profile-missing', async (t) => {
  const { home, mounted } = await makeProfileRoutes(t, { activeId: PROFILE_ID })

  const { res, json } = await mounted.call(LOAD_PATH, makeRequest({ headers: { cookie: 'token=ok' } }))
  assert.equal(res.statusCode, 409)
  assert.equal(json.code, 'profile-missing')
  assert.equal(json.activeId, PROFILE_ID)
  assert.equal(json.health.kind, 'missing')
  await assert.rejects(access(home.profilesDir), /ENOENT/, 'a read-only health check creates no profile directory')
})

test('a degraded registry serves the default doc with registry-degraded and rejects writes', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeFile(home.registryFilePath, 'not json', 'utf8')
  await writeProfileDoc(home, 'default', { revision: 4 })
  const manager = createTestProfileManager(home)
  const mounted = await mountRoutes({ profileManager: manager, connection: cookieConnection() })

  const loaded = await mounted.call(LOAD_PATH, makeRequest({ headers: { cookie: 'token=ok' } }))
  assert.equal(loaded.res.statusCode, 200)
  assert.equal(loaded.json.ok, true)
  assert.equal(loaded.json.profileId, 'default')
  assert.equal(loaded.json.warning, 'registry-degraded')
  assert.equal(loaded.json.revision, 4)
  assert.equal(loaded.json.doc.revision, 4)

  const before = await readFile(home.defaultFilePath, 'utf8')
  const commit = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(4, sampleDoc()) }),
  )
  assert.equal(commit.res.statusCode, 409)
  assert.equal(commit.json.ok, false)
  assert.equal(commit.json.code, 'registry-unhealthy')
  assert.equal(await readFile(home.defaultFilePath, 'utf8'), before, 'a degraded registry rejects the write up front')
})

test('commit to a named active writes that profile, not the default document', async (t) => {
  const { home, mounted } = await makeProfileRoutes(t, { activeId: PROFILE_ID })
  await writeProfileDoc(home, PROFILE_ID, { revision: 2 })
  await writeProfileDoc(home, 'default', { revision: 1 })
  const defaultBefore = await readFile(home.defaultFilePath, 'utf8')

  const commit = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(2, sampleDoc()) }),
  )
  assert.equal(commit.res.statusCode, 200)
  assert.equal(commit.json.ok, true)
  assert.equal(commit.json.profileId, PROFILE_ID)
  assert.equal(commit.json.revision, 3)
  assert.equal(JSON.parse(await readFile(join(home.profilesDir, PROFILE_ID, RECORD_FILE_NAME), 'utf8')).revision, 3)
  assert.equal(await readFile(home.defaultFilePath, 'utf8'), defaultBefore, 'the default document is untouched')
})

test('commit with a profileId other than active returns profile-changed and never rewrites active', async (t) => {
  const { home, mounted } = await makeProfileRoutes(t, { activeId: PROFILE_ID })
  await writeProfileDoc(home, PROFILE_ID, { revision: 2 })
  await writeProfileDoc(home, 'default', { revision: 1 })
  const defaultBefore = await readFile(home.defaultFilePath, 'utf8')

  const { res, json } = await mounted.call(
    COMMIT_PATH,
    makeRequest({
      method: 'POST',
      headers: allowedHeaders,
      body: JSON.stringify({ profileId: 'default', baseRevision: 1, doc: sampleDoc() }),
    }),
  )
  assert.equal(res.statusCode, 409)
  assert.equal(json.ok, false)
  assert.equal(json.code, 'profile-changed')
  assert.equal(json.activeId, PROFILE_ID)
  assert.equal(json.revision, 2)
  assert.equal(json.registryRevision, 3)
  assert.equal(await readFile(home.defaultFilePath, 'utf8'), defaultBefore, 'the target profile is not written')
  assert.equal(JSON.parse(await readFile(join(home.profilesDir, PROFILE_ID, RECORD_FILE_NAME), 'utf8')).revision, 2)
})

test('commit to a corrupt named active is rejected without quarantining it', async (t) => {
  const { home, mounted } = await makeProfileRoutes(t, { activeId: PROFILE_ID })
  await writeProfileDoc(home, PROFILE_ID)
  const docPath = join(home.profilesDir, PROFILE_ID, RECORD_FILE_NAME)
  await writeFile(docPath, '{ not json', 'utf8')

  const { res, json } = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(1, sampleDoc()) }),
  )
  assert.equal(res.statusCode, 409)
  assert.equal(json.code, 'profile-unhealthy')
  assert.equal(json.activeId, PROFILE_ID)
  assert.equal(json.health.kind, 'corrupt')
  assert.deepEqual(await readdir(join(home.profilesDir, PROFILE_ID)), [RECORD_FILE_NAME])
})

test('commit to a missing named active is rejected with profile-missing', async (t) => {
  const { mounted } = await makeProfileRoutes(t, { activeId: PROFILE_ID })
  const { res, json } = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(0, sampleDoc()) }),
  )
  assert.equal(res.statusCode, 409)
  assert.equal(json.code, 'profile-missing')
  assert.equal(json.activeId, PROFILE_ID)
})

test('commit rejects an invalid profileId field with 422 before any write', async (t) => {
  const { home, mounted } = await makeProfileRoutes(t, { activeId: PROFILE_ID })
  await writeProfileDoc(home, PROFILE_ID, { revision: 2 })
  const docPath = join(home.profilesDir, PROFILE_ID, RECORD_FILE_NAME)
  const before = await readFile(docPath, 'utf8')
  const registryBefore = await readFile(home.registryFilePath, 'utf8')

  for (const profileId of [null, 42, '', '   ', 'x'.repeat(65)]) {
    const { res, json } = await mounted.call(
      COMMIT_PATH,
      makeRequest({
        method: 'POST',
        headers: allowedHeaders,
        body: JSON.stringify({ profileId, baseRevision: 2, doc: sampleDoc() }),
      }),
    )
    assert.equal(res.statusCode, 422, `profileId ${String(profileId)}`)
    assert.equal(json.code, 'invalid')
  }
  assert.equal(await readFile(docPath, 'utf8'), before, 'a rejected profileId performs zero document writes')
  assert.equal(await readFile(home.registryFilePath, 'utf8'), registryBefore, 'no registry write either')
  assert.deepEqual(await readdir(join(home.profilesDir, PROFILE_ID)), [RECORD_FILE_NAME], 'no lock/bak leftovers')
})

test('commit profile-changed reports revision null when the named active is unhealthy', async (t) => {
  const { home, mounted } = await makeProfileRoutes(t, { activeId: PROFILE_ID })
  await writeProfileDoc(home, PROFILE_ID)
  await writeFile(join(home.profilesDir, PROFILE_ID, RECORD_FILE_NAME), '{ not json', 'utf8')

  const { res, json } = await mounted.call(
    COMMIT_PATH,
    makeRequest({
      method: 'POST',
      headers: allowedHeaders,
      body: JSON.stringify({ profileId: 'default', baseRevision: 0, doc: sampleDoc() }),
    }),
  )
  assert.equal(res.statusCode, 409)
  assert.equal(json.ok, false)
  assert.equal(json.code, 'profile-changed')
  assert.equal(json.activeId, PROFILE_ID)
  assert.equal(json.revision, null, 'an unreadable active document has no revision to report')
})

test('SSE revision events carry the committed profileId; the hub can announce active switches', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({ revision: 3, activeId: PROFILE_ID, profiles: [sampleDefaultProfile(), sampleNamedProfile()] }),
  )
  await writeProfileDoc(home, PROFILE_ID, { revision: 2 })
  const hub = createChangeHub()
  t.after(() => hub.close())
  const writes = []
  hub.subscribe({ write: (value) => writes.push(value), end() {} })
  const manager = createTestProfileManager(home)
  const mounted = await mountRoutes({ profileManager: manager, connection: cookieConnection(), changeHub: hub })

  const commit = await mounted.call(
    COMMIT_PATH,
    makeRequest({ method: 'POST', headers: allowedHeaders, body: commitBody(2, sampleDoc()) }),
  )
  assert.equal(commit.res.statusCode, 200)
  assert.equal(writes.length, 1)
  assert.match(writes[0], /event: revision/)
  assert.match(writes[0], new RegExp(`"profileId":"${PROFILE_ID}"`))
  assert.match(writes[0], /"source":"http-commit"/)

  hub.publishActive(PROFILE_ID, 3)
  assert.equal(writes.length, 2)
  assert.match(writes[1], /event: active/)
  assert.match(writes[1], new RegExp(`"activeId":"${PROFILE_ID}"`))
  assert.match(writes[1], /"registryRevision":3/)
})

// ---------------------------------------------------------------------------
// Diagnostics route (0.2.5)
// ---------------------------------------------------------------------------

const diagnosticsBatch = (events = [{ type: 'handler', handler: 'onDragOverSession', ms: 0.4 }], extra = {}) =>
  JSON.stringify({ runId: 'run-test', schemaVersion: 1, events, ...extra })

test('POST diagnostics appends NDJSON under storages and never touches the record file', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection() })
  t.after(() => mounted.cleanup())

  const first = await mounted.call(
    DIAGNOSTICS_PATH,
    makeRequest({
      method: 'POST',
      headers: { cookie: 'token=ok', 'content-type': 'application/json' },
      body: diagnosticsBatch([
        { type: 'native.dragover', phase: 'capture', x: 10, y: 20 },
        { type: 'dropTarget.change', from: null, to: { kind: 'session-before' } },
      ]),
    }),
  )
  assert.equal(first.res.statusCode, 200)
  assert.deepEqual(first.json, { ok: true, appended: 2 })

  const second = await mounted.call(
    DIAGNOSTICS_PATH,
    makeRequest({
      method: 'POST',
      headers: { cookie: 'token=ok', 'content-type': 'application/json' },
      body: diagnosticsBatch([{ type: 'run.start' }], { runId: 'run-second' }),
    }),
  )
  assert.equal(second.res.statusCode, 200)

  const text = await readFile(mounted.diagnosticsFilePath, 'utf8')
  const lines = text.trimEnd().split('\n')
  assert.equal(lines.length, 3, 'append-only: the second batch keeps the first lines')
  const records = lines.map((line) => JSON.parse(line))
  assert.equal(records[0].runId, 'run-test')
  assert.equal(records[0].schemaVersion, 1)
  assert.match(records[0].receivedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(records[0].event.type, 'native.dragover')
  assert.equal(records[2].runId, 'run-second')

  // The official record file must not exist: diagnostics only writes its file.
  await assert.rejects(access(mounted.filePath), /ENOENT/)
  assert.deepEqual((await readdir(mounted.storages)).sort(), ['dsh-session-grove.diagnostics.ndjson'])
})

test('POST diagnostics status matrix: methods, content type, JSON shape, size', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection() })
  t.after(() => mounted.cleanup())

  const get = await mounted.call(DIAGNOSTICS_PATH, makeRequest({ headers: { cookie: 'token=ok' } }))
  assert.equal(get.res.statusCode, 405)
  assert.equal(get.res.headers.allow, 'POST')

  const fenceMissing = await mountRoutes()
  t.after(() => fenceMissing.cleanup())
  const fenced = await fenceMissing.call(
    DIAGNOSTICS_PATH,
    makeRequest({ method: 'POST', headers: { 'content-type': 'application/json' }, body: diagnosticsBatch() }),
  )
  assert.equal(fenced.res.statusCode, 503)
  assert.equal(fenced.json.code, 'fence-unavailable')

  const wrongType = await mounted.call(
    DIAGNOSTICS_PATH,
    makeRequest({ method: 'POST', headers: { cookie: 'token=ok', 'content-type': 'text/plain' }, body: '{}' }),
  )
  assert.equal(wrongType.res.statusCode, 415)

  const malformed = await mounted.call(
    DIAGNOSTICS_PATH,
    makeRequest({
      method: 'POST',
      headers: { cookie: 'token=ok', 'content-type': 'application/json' },
      body: '{',
    }),
  )
  assert.equal(malformed.res.statusCode, 422)
  assert.equal(malformed.json.code, 'invalid')

  for (const body of [
    JSON.stringify({ runId: 'x', schemaVersion: 1 }),
    JSON.stringify({ runId: 'x', schemaVersion: 1, events: [] }),
    JSON.stringify({ runId: 'x', schemaVersion: 1, events: ['nope'] }),
    JSON.stringify({
      runId: 'x',
      schemaVersion: 1,
      events: Array.from({ length: MAX_DIAGNOSTICS_EVENTS + 1 }, () => ({ type: 'x' })),
    }),
  ]) {
    const invalid = await mounted.call(
      DIAGNOSTICS_PATH,
      makeRequest({ method: 'POST', headers: { cookie: 'token=ok', 'content-type': 'application/json' }, body }),
    )
    assert.equal(invalid.res.statusCode, 422, body.slice(0, 80))
    assert.equal(invalid.json.code, 'invalid')
  }

  const tooLarge = await mounted.call(
    DIAGNOSTICS_PATH,
    makeRequest({
      method: 'POST',
      headers: { cookie: 'token=ok', 'content-type': 'application/json' },
      body: 'x'.repeat(MAX_DIAGNOSTICS_BODY_BYTES + 2),
    }),
  )
  assert.equal(tooLarge.res.statusCode, 413)
})

test('parseDiagnosticsBody keeps the client runId/schemaVersion and bounds the batch', () => {
  assert.equal(parseDiagnosticsBody(null).ok, false)
  assert.equal(parseDiagnosticsBody({ events: 'nope' }).ok, false)
  assert.equal(parseDiagnosticsBody({ events: [] }).ok, false)
  assert.equal(parseDiagnosticsBody({ events: [null] }).ok, false)

  const parsed = parseDiagnosticsBody({
    runId: 'dsg-abc',
    schemaVersion: 1,
    events: [{ type: 'run.start', t: 0 }],
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.runId, 'dsg-abc')
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.events.length, 1)

  const unbounded = parseDiagnosticsBody({
    runId: 'x'.repeat(400),
    schemaVersion: 'nope',
    events: [{ type: 'x' }],
  })
  assert.equal(unbounded.ok, true)
  assert.equal(unbounded.runId.length, 128)
  assert.equal(unbounded.schemaVersion, null)
})

test('0.2.18 diagnostics disabled: load advertises off and ingest is refused', async (t) => {
  const mounted = await mountRoutes({ connection: cookieConnection(), diagnosticsEnabled: false })
  t.after(() => mounted.cleanup())
  const loaded = await mounted.call(LOAD_PATH, makeRequest({ headers: { cookie: 'token=ok' } }))
  assert.equal(loaded.res.statusCode, 200)
  assert.equal(loaded.json.diagnostics, false)
  const posted = await mounted.call(
    DIAGNOSTICS_PATH,
    makeRequest({
      method: 'POST',
      headers: allowedHeaders,
      body: JSON.stringify({ runId: 'r', schemaVersion: 1, events: [{ type: 'x' }] }),
    }),
  )
  assert.equal(posted.res.statusCode, 403)
  assert.equal(posted.json.code, 'diagnostics-disabled')
})
