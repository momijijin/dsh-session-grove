/**
 * Profile management routes (SPEC 4.7 / 5.3-5.10).
 *
 * These tests drive the real registry + per-profile stores through the exact
 * routes mounted by `registerRoutes`; the wire assertions cover the success
 * shape, every documented 409/422/503 branch, the read-only preview guarantee,
 * the preview token/TOCTOU rules and the doc-first create ordering.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_PROFILE_ID,
  MAX_PROFILES,
  PROFILES_ACTIVATE_PATH,
  PROFILES_ARCHIVE_PATH,
  PROFILES_CREATE_PATH,
  PROFILES_PATH,
  PROFILES_PREVIEW_PATH,
  PROFILES_RENAME_PATH,
  RECORD_FILE_NAME,
} from '../../src/host/constants.js'
import { createChangeHub } from '../../src/host/change-hub.js'
import {
  FIXED_TIMESTAMP,
  PROFILE_ID,
  createTestProfileManager,
  makeRequest,
  makeTempProfileHome,
  mountRoutes,
  sampleDefaultProfile,
  sampleDoc,
  sampleNamedProfile,
  sampleRegistry,
  writeJsonFile,
  writeProfileDoc,
} from './helpers.js'

const connection = () => ({ requestRejection: () => undefined })
const silentConnection = { requestRejection: () => undefined }
const jsonHeaders = { 'content-type': 'application/json' }

const tokenFor = (input) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex')

/**
 * `store.save` persists the additive group `archived` flag explicitly
 * (SPEC §3.3), so a document written through the routes carries
 * `archived: false` on every group even though the fixture omits it.
 */
const savedGroups = () => sampleDoc().groups.map((group) => ({ ...group, archived: false }))

const makeCaller = (mounted) => async (path, { method = 'GET', body, headers = {} } = {}) => {
  const request = makeRequest({
    method,
    url: path,
    headers: body === undefined ? headers : { ...jsonHeaders, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return await mounted.call(path.split('?')[0], request)
}

/** Temp home with a registry and optional documents. */
const makeHome = async (t, { activeId = DEFAULT_PROFILE_ID, revision = 3, profiles, docs = {} } = {}) => {
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
  for (const [id, overrides] of Object.entries(docs)) {
    await writeProfileDoc(home, id, overrides)
  }
  return home
}

const mountHome = async (home, options = {}) => {
  const manager = createTestProfileManager(home, options.managerOptions)
  const mounted = await mountRoutes({
    profileManager: manager,
    connection: options.connection ?? connection(),
    changeHub: options.changeHub,
  })
  return { manager, mounted, call: makeCaller(mounted) }
}

const readRegistry = async (home) => JSON.parse(await readFile(home.registryFilePath, 'utf8'))

const profileDocPath = (home, id) => join(home.profilesDir, id, RECORD_FILE_NAME)

// ---------------------------------------------------------------------------
// GET /profiles
// ---------------------------------------------------------------------------

test('GET /profiles lists unarchived profiles with peek counts and hides archived by default', async (t) => {
  const archived = sampleNamedProfile({
    id: 'p-archived-0001',
    name: '归档配置',
    archivedAt: '2026-11-09T01:00:00.000Z',
  })
  const corrupt = sampleNamedProfile({ id: 'p-corrupt-0001', name: '损坏配置' })
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({
      revision: 5,
      activeId: DEFAULT_PROFILE_ID,
      profiles: [sampleDefaultProfile(), sampleNamedProfile(), archived, corrupt],
    }),
  )
  await writeProfileDoc(home, PROFILE_ID, { revision: 2 })
  await writeProfileDoc(home, archived.id, { revision: 1 })
  await writeProfileDoc(home, corrupt.id)
  await writeFile(profileDocPath(home, corrupt.id), '{ not json', 'utf8')

  const registryBefore = await readFile(home.registryFilePath, 'utf8')
  const { call } = await mountHome(home)

  const listed = await call(PROFILES_PATH)
  assert.equal(listed.res.statusCode, 200)
  assert.equal(listed.res.headers['cache-control'], 'no-store')
  assert.equal(listed.json.ok, true)
  assert.equal(listed.json.registryRevision, 5)
  assert.equal(listed.json.activeId, DEFAULT_PROFILE_ID)
  assert.equal(listed.json.degraded, false)
  assert.deepEqual(listed.json.limits, { max: 20 })
  assert.deepEqual(
    listed.json.profiles.map((profile) => profile.id),
    [DEFAULT_PROFILE_ID, PROFILE_ID, corrupt.id],
    'archived profiles stay out of the switch-menu list',
  )
  const [defaultEntry, namedEntry, corruptEntry] = listed.json.profiles
  assert.deepEqual(
    { id: defaultEntry.id, name: defaultEntry.name, archived: defaultEntry.archived, healthy: defaultEntry.healthy },
    { id: DEFAULT_PROFILE_ID, name: null, archived: false, healthy: true },
    'a missing default document is a healthy empty document',
  )
  assert.equal(defaultEntry.groupCount, 0)
  assert.equal(defaultEntry.sessionCount, 0)
  assert.equal(namedEntry.healthy, true)
  assert.equal(namedEntry.groupCount, 2)
  assert.equal(namedEntry.sessionCount, 4)
  assert.equal(namedEntry.createdAt, FIXED_TIMESTAMP)
  assert.equal(namedEntry.updatedAt, FIXED_TIMESTAMP)
  assert.equal(corruptEntry.healthy, false)
  assert.equal(corruptEntry.groupCount, 0)
  assert.equal(corruptEntry.sessionCount, 0)

  const withArchived = await call(`${PROFILES_PATH}?includeArchived=1`)
  assert.equal(withArchived.res.statusCode, 200)
  assert.deepEqual(
    withArchived.json.profiles.map((profile) => profile.id),
    [DEFAULT_PROFILE_ID, PROFILE_ID, archived.id, corrupt.id],
  )
  assert.equal(
    withArchived.json.profiles.find((profile) => profile.id === archived.id).archived,
    true,
  )

  assert.deepEqual(
    (await readdir(join(home.profilesDir, PROFILE_ID))).sort(),
    [RECORD_FILE_NAME],
    'listing a profile never quarantines, locks or writes its document',
  )
  assert.deepEqual(
    (await readdir(join(home.profilesDir, corrupt.id))).sort(),
    [RECORD_FILE_NAME],
    'an unhealthy profile is reported, not healed, by the list',
  )
  assert.equal(await readFile(home.registryFilePath, 'utf8'), registryBefore)
})

test('GET /profiles returns the synthesized default with degraded:true for a bad registry', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeFile(home.registryFilePath, 'not json', 'utf8')
  await writeProfileDoc(home, DEFAULT_PROFILE_ID, { revision: 4 })
  const { call } = await mountHome(home)

  const { res, json } = await call(PROFILES_PATH)
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.degraded, true)
  assert.equal(json.registryRevision, 0)
  assert.equal(json.activeId, DEFAULT_PROFILE_ID)
  assert.equal(json.profiles.length, 1)
  assert.equal(json.profiles[0].id, DEFAULT_PROFILE_ID)
  assert.equal(json.profiles[0].healthy, true)
  assert.equal(json.profiles[0].groupCount, 2)
  assert.equal(json.profiles[0].sessionCount, 4)
})

test('GET /profiles tolerates an invalid includeArchived value', async (t) => {
  const home = await makeHome(t)
  const { call } = await mountHome(home)
  const listed = await call(`${PROFILES_PATH}?includeArchived=yes`)
  assert.equal(listed.res.statusCode, 200)
  assert.equal(listed.json.profiles.length, 2)
})

// ---------------------------------------------------------------------------
// GET /profiles/preview
// ---------------------------------------------------------------------------

test('GET /profiles/preview returns the target doc and the SPEC 5.4 token without writing', async (t) => {
  const home = await makeHome(t, { docs: { [DEFAULT_PROFILE_ID]: { revision: 2 }, [PROFILE_ID]: { revision: 5 } } })
  const namedDirBefore = (await readdir(join(home.profilesDir, PROFILE_ID))).sort()
  const registryBefore = await readFile(home.registryFilePath, 'utf8')
  const defaultBefore = await readFile(home.defaultFilePath, 'utf8')
  const namedBefore = await readFile(profileDocPath(home, PROFILE_ID), 'utf8')
  const { call } = await mountHome(home)

  const { res, json } = await call(`${PROFILES_PREVIEW_PATH}?id=${PROFILE_ID}`)
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.deepEqual(json.profile, {
    id: PROFILE_ID,
    name: '工作项目',
    archived: false,
    healthy: true,
    updatedAt: FIXED_TIMESTAMP,
  })
  assert.equal(json.revision, 5)
  assert.equal(json.doc.revision, 5)
  assert.equal(json.activeId, DEFAULT_PROFILE_ID)
  assert.equal(json.activeRevision, 2)
  assert.equal(json.registryRevision, 3)
  assert.equal(
    json.previewToken,
    tokenFor({
      activeId: DEFAULT_PROFILE_ID,
      activeRevision: 2,
      targetId: PROFILE_ID,
      targetRevision: 5,
      registryRevision: 3,
    }),
  )

  // Read-only guarantee: no document writes, no registry write, no .lock/.bak
  // family and no quarantine file in the target directory.
  assert.deepEqual((await readdir(join(home.profilesDir, PROFILE_ID))).sort(), namedDirBefore)
  assert.deepEqual(namedDirBefore, [RECORD_FILE_NAME])
  assert.equal(await readFile(home.registryFilePath, 'utf8'), registryBefore)
  assert.equal(await readFile(home.defaultFilePath, 'utf8'), defaultBefore)
  assert.equal(await readFile(profileDocPath(home, PROFILE_ID), 'utf8'), namedBefore)
})

test('GET /profiles/preview rejects missing/archived/corrupt targets and invalid ids', async (t) => {
  const archived = sampleNamedProfile({
    id: 'p-archived-0001',
    name: '归档配置',
    archivedAt: '2026-11-09T01:00:00.000Z',
  })
  const corrupt = sampleNamedProfile({ id: 'p-corrupt-0001', name: '损坏配置' })
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({
      revision: 3,
      activeId: DEFAULT_PROFILE_ID,
      profiles: [sampleDefaultProfile(), sampleNamedProfile(), archived, corrupt],
    }),
  )
  await writeProfileDoc(home, corrupt.id)
  await writeFile(profileDocPath(home, corrupt.id), '{ not json', 'utf8')
  const { call } = await mountHome(home)

  const missing = await call(`${PROFILES_PREVIEW_PATH}?id=p-missing-0001`)
  assert.equal(missing.res.statusCode, 409)
  assert.equal(missing.json.ok, false)
  assert.equal(missing.json.code, 'profile-missing')
  assert.equal(missing.json.profileId, 'p-missing-0001')
  assert.equal(missing.json.health.kind, 'missing')

  const archivedResult = await call(`${PROFILES_PREVIEW_PATH}?id=${archived.id}`)
  assert.equal(archivedResult.res.statusCode, 409)
  assert.equal(archivedResult.json.code, 'profile-archived')
  assert.equal(archivedResult.json.health.kind, 'archived')

  const corruptResult = await call(`${PROFILES_PREVIEW_PATH}?id=${corrupt.id}`)
  assert.equal(corruptResult.res.statusCode, 409)
  assert.equal(corruptResult.json.code, 'profile-unhealthy')
  assert.equal(corruptResult.json.health.kind, 'corrupt')
  assert.deepEqual(await readdir(join(home.profilesDir, corrupt.id)), [RECORD_FILE_NAME], 'peek never quarantines')

  for (const id of ['BAD!', '', 'x'.repeat(65)]) {
    const invalid = await call(`${PROFILES_PREVIEW_PATH}?id=${encodeURIComponent(id)}`)
    assert.equal(invalid.res.statusCode, 422, `id ${JSON.stringify(id)}`)
    assert.equal(invalid.json.code, 'invalid-profile-id')
  }
  const noId = await call(PROFILES_PREVIEW_PATH)
  assert.equal(noId.res.statusCode, 422)
  assert.equal(noId.json.code, 'invalid-profile-id')

  const wrongMethod = await call(PROFILES_PREVIEW_PATH, { method: 'POST' })
  assert.equal(wrongMethod.res.statusCode, 405)
  assert.equal(wrongMethod.res.headers.allow, 'GET')
})

test('GET /profiles/preview reports registry-unhealthy and fails closed without a connection', async (t) => {
  const degradedHome = await makeTempProfileHome()
  t.after(degradedHome.cleanup)
  await writeFile(degradedHome.registryFilePath, 'not json', 'utf8')
  const degraded = await mountHome(degradedHome)
  const degradedResult = await degraded.call(`${PROFILES_PREVIEW_PATH}?id=${DEFAULT_PROFILE_ID}`)
  assert.equal(degradedResult.res.statusCode, 409)
  assert.equal(degradedResult.json.code, 'registry-unhealthy')

  const home = await makeHome(t)
  const fenced = await mountRoutes({ profileManager: createTestProfileManager(home) })
  const call = makeCaller(fenced)
  const fencedResult = await call(PROFILES_PATH)
  assert.equal(fencedResult.res.statusCode, 503)
  assert.equal(fencedResult.json.code, 'fence-unavailable')
})

test('GET /profiles/preview reports a broken registry without healing it', async (t) => {
  const cases = [
    ['corrupt JSON', () => '{ not json'],
    [
      'invalid shape',
      () =>
        JSON.stringify(
          sampleRegistry({
            revision: 3,
            profiles: [{ ...sampleDefaultProfile(), dir: 'not-the-default-dir' }],
          }),
        ),
    ],
    ['unsupported version', () => JSON.stringify({ ...sampleRegistry({ revision: 3 }), version: 2 })],
  ]
  for (const [label, text] of cases) {
    const home = await makeTempProfileHome()
    t.after(home.cleanup)
    await writeProfileDoc(home, DEFAULT_PROFILE_ID, { revision: 4 })
    await writeFile(home.registryFilePath, text(), 'utf8')
    const registryHash = createHash('sha256').update(await readFile(home.registryFilePath)).digest('hex')
    const docHash = createHash('sha256').update(await readFile(home.defaultFilePath)).digest('hex')
    const storageBefore = (await readdir(home.storageDir)).sort()
    const { call } = await mountHome(home)

    const { res, json } = await call(`${PROFILES_PREVIEW_PATH}?id=${DEFAULT_PROFILE_ID}`)
    assert.equal(res.statusCode, 409, label)
    assert.equal(json.ok, false, label)
    assert.equal(json.code, 'registry-unhealthy', label)

    // SPEC 5.4 read-only: no lock, no quarantine, no `.bak` restore, no write.
    const storageAfter = (await readdir(home.storageDir)).sort()
    assert.deepEqual(
      storageAfter.filter((name) => name.includes('.corrupt-')),
      [],
      `${label}: preview never quarantines the registry`,
    )
    assert.deepEqual(
      storageAfter.filter((name) => name.endsWith('.lock')),
      [],
      `${label}: preview never takes the registry lock`,
    )
    assert.deepEqual(storageAfter, storageBefore, `${label}: preview writes no files at all`)
    assert.equal(
      createHash('sha256').update(await readFile(home.registryFilePath)).digest('hex'),
      registryHash,
      `${label}: the registry bytes are unchanged`,
    )
    assert.equal(
      createHash('sha256').update(await readFile(home.defaultFilePath)).digest('hex'),
      docHash,
      `${label}: the target document is untouched`,
    )
  }
})

test('GET /profiles/preview fails closed on a missing registry without bootstrapping it', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeProfileDoc(home, DEFAULT_PROFILE_ID, { revision: 4 })
  const storageBefore = (await readdir(home.storageDir)).sort()
  const { call } = await mountHome(home)

  const { res, json } = await call(`${PROFILES_PREVIEW_PATH}?id=${DEFAULT_PROFILE_ID}`)
  assert.equal(res.statusCode, 409)
  assert.equal(json.ok, false)
  assert.equal(json.code, 'registry-unhealthy')
  await assert.rejects(access(home.registryFilePath), /ENOENT/, 'preview must not bootstrap a registry')
  assert.deepEqual((await readdir(home.storageDir)).sort(), storageBefore, 'preview writes no files')
})

test('GET /profiles/preview computes activeRevision=null while the active profile is unhealthy', async (t) => {
  const home = await makeHome(t, {
    activeId: PROFILE_ID,
    docs: { [DEFAULT_PROFILE_ID]: { revision: 2 } },
  })
  const namedPath = profileDocPath(home, PROFILE_ID)
  await writeProfileDoc(home, PROFILE_ID)
  await writeFile(namedPath, '{ not json', 'utf8')
  const { call } = await mountHome(home)

  const { res, json } = await call(`${PROFILES_PREVIEW_PATH}?id=${DEFAULT_PROFILE_ID}`)
  assert.equal(res.statusCode, 200)
  assert.equal(json.activeId, PROFILE_ID)
  assert.equal(json.activeRevision, null)
  assert.equal(
    json.previewToken,
    tokenFor({
      activeId: PROFILE_ID,
      activeRevision: null,
      targetId: DEFAULT_PROFILE_ID,
      targetRevision: 2,
      registryRevision: 3,
    }),
  )
  assert.equal(await readFile(namedPath, 'utf8'), '{ not json', 'previewing another profile never heals the active one')
})

// ---------------------------------------------------------------------------
// POST /profiles/create
// ---------------------------------------------------------------------------

test('POST /profiles/create writes the clone doc first, then adds + activates in one CAS', async (t) => {
  const home = await makeHome(t, {
    revision: 3,
    profiles: [sampleDefaultProfile()],
    docs: { [DEFAULT_PROFILE_ID]: { revision: 7 } },
  })
  const defaultBefore = await readFile(home.defaultFilePath, 'utf8')
  const hub = createChangeHub()
  t.after(() => hub.close())
  const writes = []
  hub.subscribe({ write: (value) => writes.push(value), end() {} })
  const { manager, call } = await mountHome(home, {
    changeHub: hub,
    managerOptions: { profileIdFactory: () => PROFILE_ID },
  })
  assert.equal(await manager.activeId(), DEFAULT_PROFILE_ID)

  const { res, json } = await call(PROFILES_CREATE_PATH, {
    method: 'POST',
    body: { baseRevision: 3, name: '  新配置  ' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(json.ok, true)
  assert.equal(json.registryRevision, 4)
  assert.equal(json.activeId, PROFILE_ID)
  assert.equal(json.profile.id, PROFILE_ID)
  assert.equal(json.profile.name, '新配置', 'the stored name is trimmed')
  assert.equal(json.profile.archived, false)
  assert.equal(typeof json.profile.createdAt, 'string')
  assert.equal(typeof json.profile.updatedAt, 'string')
  assert.equal(json.doc.revision, 1)
  assert.deepEqual(json.doc.groups, savedGroups(), 'groups are copied verbatim')
  assert.deepEqual(json.doc.ungrouped, sampleDoc().ungrouped)

  const created = JSON.parse(await readFile(profileDocPath(home, PROFILE_ID), 'utf8'))
  assert.equal(created.revision, 1)
  assert.deepEqual(created.groups, savedGroups())

  const registry = await readRegistry(home)
  assert.equal(registry.revision, 4)
  assert.equal(registry.activeId, PROFILE_ID)
  const entry = registry.profiles.find((profile) => profile.id === PROFILE_ID)
  assert.equal(entry.name, '新配置')
  assert.equal(entry.dir, `profiles/${PROFILE_ID}`)
  assert.equal(entry.archivedAt, null)

  assert.equal(await readFile(home.defaultFilePath, 'utf8'), defaultBefore, 'the source document is untouched')
  assert.equal(writes.length, 1, 'create publishes one SSE event')
  assert.match(writes[0], /event: active/)
  assert.match(writes[0], new RegExp(`"activeId":"${PROFILE_ID}"`))
  assert.match(writes[0], /"registryRevision":4/)
})

test('POST /profiles/create bootstraps the registry at revision 1 when none exists', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const { call } = await mountHome(home, { managerOptions: { profileIdFactory: () => PROFILE_ID } })

  const created = await call(PROFILES_CREATE_PATH, {
    method: 'POST',
    body: { baseRevision: 0, name: '第一份配置' },
  })
  assert.equal(created.res.statusCode, 200)
  assert.equal(created.json.registryRevision, 1)
  assert.equal(created.json.activeId, PROFILE_ID)
  assert.equal(created.json.doc.revision, 1)
  assert.deepEqual(created.json.doc.groups, [])
  assert.deepEqual(created.json.doc.ungrouped, [])

  const registry = await readRegistry(home)
  assert.equal(registry.version, 1)
  assert.equal(registry.revision, 1)
  assert.equal(registry.activeId, PROFILE_ID)
  assert.deepEqual(
    registry.profiles.map((profile) => profile.id).sort(),
    [DEFAULT_PROFILE_ID, PROFILE_ID].sort(),
  )

  // The very next load serves the new active profile without a restart.
  const loaded = await call('/dsh-session-grove/load')
  assert.equal(loaded.res.statusCode, 200)
  assert.equal(loaded.json.profileId, PROFILE_ID)
  assert.equal(loaded.json.revision, 1)
})

test('POST /profiles/create rejects invalid bodies, names and stale revisions without writing', async (t) => {
  const home = await makeHome(t, { docs: { [DEFAULT_PROFILE_ID]: { revision: 2 } } })
  const registryBefore = await readFile(home.registryFilePath, 'utf8')
  const defaultBefore = await readFile(home.defaultFilePath, 'utf8')
  const { call } = await mountHome(home)

  const bad = await call(PROFILES_CREATE_PATH, {
    method: 'POST',
    body: { baseRevision: -1, name: 'x' },
  })
  assert.equal(bad.res.statusCode, 422)
  assert.equal(bad.json.code, 'invalid')

  const missingRevision = await call(PROFILES_CREATE_PATH, { method: 'POST', body: { name: 'x' } })
  assert.equal(missingRevision.res.statusCode, 422)
  assert.equal(missingRevision.json.code, 'invalid')

  for (const name of ['', '   ', 'x'.repeat(41), 'bad\nname']) {
    const invalidName = await call(PROFILES_CREATE_PATH, {
      method: 'POST',
      body: { baseRevision: 3, name },
    })
    assert.equal(invalidName.res.statusCode, 422, JSON.stringify(name))
    assert.equal(invalidName.json.code, 'profile-name-invalid')
  }

  // The fixture named profile is `工作项目`; duplicates are case-insensitive.
  const duplicate = await call(PROFILES_CREATE_PATH, {
    method: 'POST',
    body: { baseRevision: 3, name: '工作项目' },
  })
  assert.equal(duplicate.res.statusCode, 422)
  assert.equal(duplicate.json.code, 'profile-name-duplicate')

  const stale = await call(PROFILES_CREATE_PATH, {
    method: 'POST',
    body: { baseRevision: 99, name: '新配置' },
  })
  assert.equal(stale.res.statusCode, 409)
  assert.equal(stale.json.code, 'conflict')
  assert.equal(stale.json.revision, 3)

  const wrongType = await call(PROFILES_CREATE_PATH, {
    method: 'POST',
    body: 'nope',
    headers: { 'content-type': 'text/plain' },
  })
  assert.equal(wrongType.res.statusCode, 415)
  assert.equal(wrongType.json.code, 'unsupported-media-type')

  const malformed = await call(PROFILES_CREATE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: undefined,
  })
  // An empty body is not valid JSON.
  assert.equal(malformed.res.statusCode, 422)
  assert.equal(malformed.json.code, 'invalid')

  const wrongMethod = await call(PROFILES_CREATE_PATH)
  assert.equal(wrongMethod.res.statusCode, 405)
  assert.equal(wrongMethod.res.headers.allow, 'POST')

  assert.equal(await readFile(home.registryFilePath, 'utf8'), registryBefore)
  assert.equal(await readFile(home.defaultFilePath, 'utf8'), defaultBefore)
  await assert.rejects(access(home.profilesDir), /ENOENT/, 'no profile directory is created by rejected creates')
})

test('POST /profiles/create enforces the 20-profile limit, active health and a healthy registry', async (t) => {
  const limitProfiles = [
    sampleDefaultProfile(),
    ...Array.from({ length: MAX_PROFILES - 1 }, (_, index) =>
      sampleNamedProfile({
        id: `p-limit-${String(index).padStart(2, '0')}`,
        name: `Limit ${String(index)}`,
      }),
    ),
  ]
  const limitHome = await makeHome(t, { revision: 3, profiles: limitProfiles })
  const limit = await mountHome(limitHome)
  const atLimit = await limit.call(PROFILES_CREATE_PATH, {
    method: 'POST',
    body: { baseRevision: 3, name: '多出来的配置' },
  })
  assert.equal(atLimit.res.statusCode, 409)
  assert.equal(atLimit.json.code, 'profile-limit')

  const unhealthyHome = await makeHome(t, {
    activeId: PROFILE_ID,
    profiles: [sampleDefaultProfile(), sampleNamedProfile()],
  })
  await writeProfileDoc(unhealthyHome, PROFILE_ID)
  await writeFile(profileDocPath(unhealthyHome, PROFILE_ID), '{ not json', 'utf8')
  const unhealthy = await mountHome(unhealthyHome)
  const unhealthyActive = await unhealthy.call(PROFILES_CREATE_PATH, {
    method: 'POST',
    body: { baseRevision: 3, name: '新配置' },
  })
  assert.equal(unhealthyActive.res.statusCode, 409)
  assert.equal(unhealthyActive.json.code, 'profile-unhealthy')
  assert.equal(unhealthyActive.json.activeId, PROFILE_ID)
  assert.deepEqual(await readdir(join(unhealthyHome.profilesDir, PROFILE_ID)), [RECORD_FILE_NAME])

  const degradedHome = await makeTempProfileHome()
  t.after(degradedHome.cleanup)
  await writeFile(degradedHome.registryFilePath, 'not json', 'utf8')
  const degraded = await mountHome(degradedHome)
  const degradedCreate = await degraded.call(PROFILES_CREATE_PATH, {
    method: 'POST',
    body: { baseRevision: 0, name: '新配置' },
  })
  assert.equal(degradedCreate.res.statusCode, 409)
  assert.equal(degradedCreate.json.code, 'registry-unhealthy')
})

test('POST /profiles/create keeps the orphan and the old active when the registry CAS fails', async (t) => {
  const home = await makeHome(t, {
    revision: 3,
    profiles: [sampleDefaultProfile()],
    docs: { [DEFAULT_PROFILE_ID]: { revision: 2 } },
  })
  const defaultBefore = await readFile(home.defaultFilePath, 'utf8')
  const winnerId = 'p-winner-0001'
  const orphanId = 'p-orphan-0001'

  // Freeze one manager's registry snapshot at revision 3, then let a second
  // manager win the CAS (revision 4). The frozen manager still passes the
  // route's baseRevision pre-check, writes its document first, and must then
  // fail the real CAS — the doc-first orphan contract (SPEC 4.4).
  const winner = createTestProfileManager(home, { profileIdFactory: () => winnerId })
  const winnerMount = await mountRoutes({ profileManager: winner, connection: connection() })
  const winnerCall = makeCaller(winnerMount)

  const orphanManagerBase = createTestProfileManager(home, { profileIdFactory: () => orphanId })
  const staleSnapshot = await orphanManagerBase.loadRegistry()
  assert.equal(staleSnapshot.revision, 3)
  const staleManager = { ...orphanManagerBase, loadRegistry: async () => staleSnapshot }
  const staleMount = await mountRoutes({ profileManager: staleManager, connection: connection() })
  const staleCall = makeCaller(staleMount)

  const won = await winnerCall(PROFILES_CREATE_PATH, {
    method: 'POST',
    body: { baseRevision: 3, name: 'Win' },
  })
  assert.equal(won.res.statusCode, 200)
  assert.equal(won.json.activeId, winnerId)

  const lost = await staleCall(PROFILES_CREATE_PATH, {
    method: 'POST',
    body: { baseRevision: 3, name: 'Orphan' },
  })
  assert.equal(lost.res.statusCode, 409)
  assert.equal(lost.json.ok, false)
  assert.equal(lost.json.code, 'conflict')
  assert.equal(lost.json.revision, 4)

  // The winner's registry entry/active survive; the loser's document remains
  // as a deliberate orphan and the source document is untouched.
  const registry = await readRegistry(home)
  assert.equal(registry.revision, 4)
  assert.equal(registry.activeId, winnerId)
  assert.equal(registry.profiles.some((profile) => profile.id === orphanId), false)
  const orphanDoc = JSON.parse(await readFile(profileDocPath(home, orphanId), 'utf8'))
  assert.equal(orphanDoc.revision, 1)
  assert.deepEqual(orphanDoc.groups, savedGroups())
  assert.equal(await readFile(home.defaultFilePath, 'utf8'), defaultBefore)
})

// ---------------------------------------------------------------------------
// POST /profiles/rename
// ---------------------------------------------------------------------------

test('POST /profiles/rename renames named and default profiles through the registry CAS', async (t) => {
  const archived = sampleNamedProfile({
    id: 'p-archived-0001',
    name: '归档配置',
    archivedAt: '2026-11-09T01:00:00.000Z',
  })
  const home = await makeHome(t, { profiles: [sampleDefaultProfile(), sampleNamedProfile(), archived] })
  const { call } = await mountHome(home)

  const renamed = await call(PROFILES_RENAME_PATH, {
    method: 'POST',
    body: { baseRevision: 3, id: PROFILE_ID, name: '  新名字  ' },
  })
  assert.equal(renamed.res.statusCode, 200)
  assert.equal(renamed.json.ok, true)
  assert.equal(renamed.json.registryRevision, 4)
  assert.equal(renamed.json.profile.id, PROFILE_ID)
  assert.equal(renamed.json.profile.name, '新名字')
  assert.equal(renamed.json.profile.archived, false)

  const renamedDefault = await call(PROFILES_RENAME_PATH, {
    method: 'POST',
    body: { baseRevision: 4, id: DEFAULT_PROFILE_ID, name: '默认配置' },
  })
  assert.equal(renamedDefault.res.statusCode, 200)
  assert.equal(renamedDefault.json.registryRevision, 5)
  assert.equal(renamedDefault.json.profile.name, '默认配置')

  const stale = await call(PROFILES_RENAME_PATH, {
    method: 'POST',
    body: { baseRevision: 3, id: PROFILE_ID, name: '过期' },
  })
  assert.equal(stale.res.statusCode, 409)
  assert.equal(stale.json.code, 'conflict')
  assert.equal(stale.json.revision, 5)

  const duplicate = await call(PROFILES_RENAME_PATH, {
    method: 'POST',
    body: { baseRevision: 5, id: PROFILE_ID, name: '默认配置' },
  })
  assert.equal(duplicate.res.statusCode, 422)
  assert.equal(duplicate.json.code, 'profile-name-duplicate')

  const invalidName = await call(PROFILES_RENAME_PATH, {
    method: 'POST',
    body: { baseRevision: 5, id: PROFILE_ID, name: '' },
  })
  assert.equal(invalidName.res.statusCode, 422)
  assert.equal(invalidName.json.code, 'profile-name-invalid')

  const missing = await call(PROFILES_RENAME_PATH, {
    method: 'POST',
    body: { baseRevision: 5, id: 'p-missing-0001', name: '不存在' },
  })
  assert.equal(missing.res.statusCode, 409)
  assert.equal(missing.json.code, 'profile-missing')

  const archivedRename = await call(PROFILES_RENAME_PATH, {
    method: 'POST',
    body: { baseRevision: 5, id: archived.id, name: '不许改' },
  })
  assert.equal(archivedRename.res.statusCode, 409)
  assert.equal(archivedRename.json.code, 'profile-archived')

  const registryBefore = await readFile(home.registryFilePath, 'utf8')
  const invalidId = await call(PROFILES_RENAME_PATH, {
    method: 'POST',
    body: { baseRevision: 5, id: 'BAD!', name: '非法' },
  })
  assert.equal(invalidId.res.statusCode, 422)
  assert.equal(invalidId.json.code, 'invalid-profile-id')
  assert.equal(await readFile(home.registryFilePath, 'utf8'), registryBefore, 'an invalid id performs zero writes')
})

test('POST /profiles/rename rejects a degraded registry up front', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeFile(home.registryFilePath, 'not json', 'utf8')
  const { call } = await mountHome(home)
  const { res, json } = await call(PROFILES_RENAME_PATH, {
    method: 'POST',
    body: { baseRevision: 0, id: DEFAULT_PROFILE_ID, name: '默认配置' },
  })
  assert.equal(res.statusCode, 409)
  assert.equal(json.code, 'registry-unhealthy')
})

// ---------------------------------------------------------------------------
// POST /profiles/archive
// ---------------------------------------------------------------------------

test('POST /profiles/archive sets archivedAt only and keeps the document', async (t) => {
  const target = sampleNamedProfile({ id: 'p-archive-0001', name: '待归档' })
  const home = await makeHome(t, { profiles: [sampleDefaultProfile(), sampleNamedProfile(), target] })
  await writeProfileDoc(home, target.id, { revision: 2 })
  const docBefore = await readFile(profileDocPath(home, target.id), 'utf8')
  const { call } = await mountHome(home)

  const archived = await call(PROFILES_ARCHIVE_PATH, {
    method: 'POST',
    body: { baseRevision: 3, id: target.id },
  })
  assert.equal(archived.res.statusCode, 200)
  assert.equal(archived.json.ok, true)
  assert.equal(archived.json.registryRevision, 4)
  assert.equal(archived.json.activeId, DEFAULT_PROFILE_ID)

  const registry = await readRegistry(home)
  const entry = registry.profiles.find((profile) => profile.id === target.id)
  assert.equal(typeof entry.archivedAt, 'string')
  assert.equal(registry.revision, 4)
  assert.equal(await readFile(profileDocPath(home, target.id), 'utf8'), docBefore, 'archiving never touches the document')

  const again = await call(PROFILES_ARCHIVE_PATH, {
    method: 'POST',
    body: { baseRevision: 4, id: target.id },
  })
  assert.equal(again.res.statusCode, 409)
  assert.equal(again.json.code, 'profile-archived')

  const missing = await call(PROFILES_ARCHIVE_PATH, {
    method: 'POST',
    body: { baseRevision: 4, id: 'p-missing-0001' },
  })
  assert.equal(missing.res.statusCode, 409)
  assert.equal(missing.json.code, 'profile-missing')

  const registryBefore = await readFile(home.registryFilePath, 'utf8')
  const invalidId = await call(PROFILES_ARCHIVE_PATH, {
    method: 'POST',
    body: { baseRevision: 4, id: 'BAD!' },
  })
  assert.equal(invalidId.res.statusCode, 422)
  assert.equal(invalidId.json.code, 'invalid-profile-id')
  assert.equal(await readFile(home.registryFilePath, 'utf8'), registryBefore)
})

test('POST /profiles/archive refuses active/default/last profiles with profile-in-use', async (t) => {
  const home = await makeHome(t, {
    activeId: PROFILE_ID,
    profiles: [sampleDefaultProfile(), sampleNamedProfile()],
  })
  const { call } = await mountHome(home)

  const active = await call(PROFILES_ARCHIVE_PATH, {
    method: 'POST',
    body: { baseRevision: 3, id: PROFILE_ID },
  })
  assert.equal(active.res.statusCode, 409)
  assert.equal(active.json.code, 'profile-in-use')

  const defaultProfile = await call(PROFILES_ARCHIVE_PATH, {
    method: 'POST',
    body: { baseRevision: 3, id: DEFAULT_PROFILE_ID },
  })
  assert.equal(defaultProfile.res.statusCode, 409)
  assert.equal(defaultProfile.json.code, 'profile-in-use')

  // Only the default is left: archiving it is the "last unarchived" rejection.
  const lastHome = await makeHome(t, { profiles: [sampleDefaultProfile()] })
  const last = await mountHome(lastHome)
  const lastResult = await last.call(PROFILES_ARCHIVE_PATH, {
    method: 'POST',
    body: { baseRevision: 3, id: DEFAULT_PROFILE_ID },
  })
  assert.equal(lastResult.res.statusCode, 409)
  assert.equal(lastResult.json.code, 'profile-in-use')
})

test('POST /profiles/archive rejects a degraded registry up front', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeFile(home.registryFilePath, 'not json', 'utf8')
  const { call } = await mountHome(home)
  const { res, json } = await call(PROFILES_ARCHIVE_PATH, {
    method: 'POST',
    body: { baseRevision: 0, id: DEFAULT_PROFILE_ID },
  })
  assert.equal(res.statusCode, 409)
  assert.equal(json.code, 'registry-unhealthy')
})

// ---------------------------------------------------------------------------
// POST /profiles/activate
// ---------------------------------------------------------------------------

test('POST /profiles/activate switches activeId without writing either document', async (t) => {
  const home = await makeHome(t, {
    docs: { [DEFAULT_PROFILE_ID]: { revision: 2 }, [PROFILE_ID]: { revision: 5 } },
  })
  const hub = createChangeHub()
  t.after(() => hub.close())
  const writes = []
  hub.subscribe({ write: (value) => writes.push(value), end() {} })
  const { call } = await mountHome(home, { changeHub: hub })

  const preview = await call(`${PROFILES_PREVIEW_PATH}?id=${PROFILE_ID}`)
  assert.equal(preview.res.statusCode, 200)
  const namedBefore = await readFile(profileDocPath(home, PROFILE_ID), 'utf8')
  const defaultBefore = await readFile(home.defaultFilePath, 'utf8')
  const namedDirBefore = (await readdir(join(home.profilesDir, PROFILE_ID))).sort()

  const activated = await call(PROFILES_ACTIVATE_PATH, {
    method: 'POST',
    body: { id: PROFILE_ID, previewToken: preview.json.previewToken },
  })
  assert.equal(activated.res.statusCode, 200)
  assert.equal(activated.json.ok, true)
  assert.equal(activated.json.registryRevision, 4)
  assert.equal(activated.json.activeId, PROFILE_ID)
  assert.equal(activated.json.profile.id, PROFILE_ID)
  assert.equal(activated.json.profile.name, '工作项目')
  assert.equal(activated.json.profile.archived, false)
  assert.equal(activated.json.doc.revision, 5)

  assert.equal((await readRegistry(home)).activeId, PROFILE_ID)
  assert.equal(await readFile(profileDocPath(home, PROFILE_ID), 'utf8'), namedBefore, 'activation never writes the target doc')
  assert.equal(await readFile(home.defaultFilePath, 'utf8'), defaultBefore, 'activation never writes the default doc')
  assert.deepEqual((await readdir(join(home.profilesDir, PROFILE_ID))).sort(), namedDirBefore)
  assert.equal(writes.length, 1)
  assert.match(writes[0], /event: active/)
  assert.match(writes[0], new RegExp(`"activeId":"${PROFILE_ID}"`))
  assert.match(writes[0], /"registryRevision":4/)

  const loaded = await call('/dsh-session-grove/load')
  assert.equal(loaded.res.statusCode, 200)
  assert.equal(loaded.json.profileId, PROFILE_ID)
  assert.equal(loaded.json.revision, 5)
})

test('POST /profiles/activate rejects stale tokens, unhealthy targets and invalid bodies', async (t) => {
  const archived = sampleNamedProfile({
    id: 'p-archived-0001',
    name: '归档配置',
    archivedAt: '2026-11-09T01:00:00.000Z',
  })
  const corrupt = sampleNamedProfile({ id: 'p-corrupt-0001', name: '损坏配置' })
  const home = await makeHome(t, {
    profiles: [sampleDefaultProfile(), sampleNamedProfile(), archived, corrupt],
    docs: { [DEFAULT_PROFILE_ID]: { revision: 2 }, [PROFILE_ID]: { revision: 5 } },
  })
  await writeProfileDoc(home, corrupt.id)
  await writeFile(profileDocPath(home, corrupt.id), '{ not json', 'utf8')
  const { call } = await mountHome(home)

  const preview = await call(`${PROFILES_PREVIEW_PATH}?id=${PROFILE_ID}`)
  const staleToken = preview.json.previewToken

  // Any change to the active document invalidates the token (activeRevision).
  const commit = await call('/dsh-session-grove/commit', {
    method: 'POST',
    body: { baseRevision: 2, doc: sampleDoc() },
  })
  assert.equal(commit.res.statusCode, 200)
  const stale = await call(PROFILES_ACTIVATE_PATH, {
    method: 'POST',
    body: { id: PROFILE_ID, previewToken: staleToken },
  })
  assert.equal(stale.res.statusCode, 409)
  assert.equal(stale.json.ok, false)
  assert.equal(stale.json.code, 'preview-stale')
  assert.equal(stale.json.activeRevision, 3)
  assert.equal(stale.json.registryRevision, 3)

  const tampered = await call(PROFILES_ACTIVATE_PATH, {
    method: 'POST',
    body: { id: PROFILE_ID, previewToken: 'not-the-token' },
  })
  assert.equal(tampered.res.statusCode, 409)
  assert.equal(tampered.json.code, 'preview-stale')

  // Registry-revision changes (rename) also invalidate the token.
  const freshPreview = await call(`${PROFILES_PREVIEW_PATH}?id=${PROFILE_ID}`)
  const rename = await call(PROFILES_RENAME_PATH, {
    method: 'POST',
    body: { baseRevision: 3, id: PROFILE_ID, name: '改名' },
  })
  assert.equal(rename.res.statusCode, 200)
  const registryStale = await call(PROFILES_ACTIVATE_PATH, {
    method: 'POST',
    body: { id: PROFILE_ID, previewToken: freshPreview.json.previewToken },
  })
  assert.equal(registryStale.res.statusCode, 409)
  assert.equal(registryStale.json.code, 'preview-stale')

  const current = await call(`${PROFILES_PREVIEW_PATH}?id=${PROFILE_ID}`)
  const badTarget = await call(PROFILES_ACTIVATE_PATH, {
    method: 'POST',
    body: { id: 'p-missing-0001', previewToken: current.json.previewToken },
  })
  assert.equal(badTarget.res.statusCode, 409)
  assert.equal(badTarget.json.code, 'profile-missing')

  const archivedTarget = await call(PROFILES_ACTIVATE_PATH, {
    method: 'POST',
    body: { id: archived.id, previewToken: current.json.previewToken },
  })
  assert.equal(archivedTarget.res.statusCode, 409)
  assert.equal(archivedTarget.json.code, 'profile-archived')

  const unhealthyTarget = await call(PROFILES_ACTIVATE_PATH, {
    method: 'POST',
    body: { id: corrupt.id, previewToken: current.json.previewToken },
  })
  assert.equal(unhealthyTarget.res.statusCode, 409)
  assert.equal(unhealthyTarget.json.code, 'profile-unhealthy')
  assert.deepEqual(await readdir(join(home.profilesDir, corrupt.id)), [RECORD_FILE_NAME])

  const badId = await call(PROFILES_ACTIVATE_PATH, {
    method: 'POST',
    body: { id: 'BAD!', previewToken: current.json.previewToken },
  })
  assert.equal(badId.res.statusCode, 422)
  assert.equal(badId.json.code, 'invalid-profile-id')

  const badToken = await call(PROFILES_ACTIVATE_PATH, {
    method: 'POST',
    body: { id: PROFILE_ID, previewToken: 42 },
  })
  assert.equal(badToken.res.statusCode, 422)
  assert.equal(badToken.json.code, 'invalid')

  const missingToken = await call(PROFILES_ACTIVATE_PATH, {
    method: 'POST',
    body: { id: PROFILE_ID },
  })
  assert.equal(missingToken.res.statusCode, 422)
  assert.equal(missingToken.json.code, 'invalid')

  assert.equal((await readRegistry(home)).activeId, DEFAULT_PROFILE_ID, 'failed activations never switch activeId')
})

test('POST /profiles/activate can recover from an unhealthy active back to default', async (t) => {
  const home = await makeHome(t, {
    activeId: PROFILE_ID,
    docs: { [DEFAULT_PROFILE_ID]: { revision: 2 } },
  })
  const namedPath = profileDocPath(home, PROFILE_ID)
  await writeProfileDoc(home, PROFILE_ID)
  await writeFile(namedPath, '{ not json', 'utf8')
  const { call } = await mountHome(home)

  const preview = await call(`${PROFILES_PREVIEW_PATH}?id=${DEFAULT_PROFILE_ID}`)
  assert.equal(preview.res.statusCode, 200)
  assert.equal(preview.json.activeRevision, null)

  const activated = await call(PROFILES_ACTIVATE_PATH, {
    method: 'POST',
    body: { id: DEFAULT_PROFILE_ID, previewToken: preview.json.previewToken },
  })
  assert.equal(activated.res.statusCode, 200)
  assert.equal(activated.json.activeId, DEFAULT_PROFILE_ID)
  assert.equal(activated.json.registryRevision, 4)
  assert.equal(activated.json.doc.revision, 2)
  assert.equal((await readRegistry(home)).activeId, DEFAULT_PROFILE_ID)
  assert.equal(await readFile(namedPath, 'utf8'), '{ not json', 'the unhealthy active document is never rewritten')
})

test('POST /profiles/activate rejects a degraded registry up front', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeFile(home.registryFilePath, 'not json', 'utf8')
  const { call } = await mountHome(home)
  const { res, json } = await call(PROFILES_ACTIVATE_PATH, {
    method: 'POST',
    body: { id: DEFAULT_PROFILE_ID, previewToken: 'x' },
  })
  assert.equal(res.statusCode, 409)
  assert.equal(json.code, 'registry-unhealthy')
})

// ---------------------------------------------------------------------------
// Cross-cutting: fence/method, io errors and invalid-id zero writes
// ---------------------------------------------------------------------------

test('all profile routes run the fence before method handling', async (t) => {
  const home = await makeHome(t)
  const mounted = await mountRoutes({ profileManager: createTestProfileManager(home) })
  const call = makeCaller(mounted)

  const list = await call(PROFILES_PATH)
  assert.equal(list.res.statusCode, 503)
  assert.equal(list.json.code, 'fence-unavailable')

  const create = await call(PROFILES_CREATE_PATH, {
    method: 'POST',
    body: { baseRevision: 3, name: '新配置' },
  })
  assert.equal(create.res.statusCode, 503)
  assert.equal(create.json.code, 'fence-unavailable')

  assert.equal((await readRegistry(home)).revision, 3, 'a fenced request performs no writes')
})

test('profile route IO failures surface as 503 io', async (t) => {
  const home = await makeHome(t)
  const manager = createTestProfileManager(home)
  const failing = {
    ...manager,
    loadRegistry: async () => {
      throw new Error('registry exploded')
    },
    peekRegistry: async () => {
      throw new Error('registry exploded')
    },
  }
  const mounted = await mountRoutes({ profileManager: failing, connection: silentConnection })
  const call = makeCaller(mounted)

  for (const [path, options] of [
    [PROFILES_PATH, {}],
    [`${PROFILES_PREVIEW_PATH}?id=${PROFILE_ID}`, {}],
    [PROFILES_CREATE_PATH, { method: 'POST', body: { baseRevision: 3, name: '新配置' } }],
    [PROFILES_RENAME_PATH, { method: 'POST', body: { baseRevision: 3, id: PROFILE_ID, name: '新' } }],
    [PROFILES_ARCHIVE_PATH, { method: 'POST', body: { baseRevision: 3, id: PROFILE_ID } }],
    [
      PROFILES_ACTIVATE_PATH,
      { method: 'POST', body: { id: PROFILE_ID, previewToken: 'x' } },
    ],
  ]) {
    const { res, json } = await call(path, options)
    assert.equal(res.statusCode, 503, path)
    assert.equal(json.ok, false, path)
    assert.equal(json.code, 'io', path)
  }
})

test('invalid profile ids are rejected with 422 before any write on every mutating route', async (t) => {
  const home = await makeHome(t)
  const registryBefore = await readFile(home.registryFilePath, 'utf8')
  const rmdirBefore = (await readdir(home.storageDir)).sort()
  const { call } = await mountHome(home)

  const rename = await call(PROFILES_RENAME_PATH, {
    method: 'POST',
    body: { baseRevision: 3, id: 'BAD!', name: '非法' },
  })
  assert.equal(rename.res.statusCode, 422)
  assert.equal(rename.json.code, 'invalid-profile-id')

  const archive = await call(PROFILES_ARCHIVE_PATH, {
    method: 'POST',
    body: { baseRevision: 3, id: 'BAD!' },
  })
  assert.equal(archive.res.statusCode, 422)
  assert.equal(archive.json.code, 'invalid-profile-id')

  const activate = await call(PROFILES_ACTIVATE_PATH, {
    method: 'POST',
    body: { id: 'BAD!', previewToken: 'x' },
  })
  assert.equal(activate.res.statusCode, 422)
  assert.equal(activate.json.code, 'invalid-profile-id')

  assert.equal(await readFile(home.registryFilePath, 'utf8'), registryBefore)
  assert.deepEqual((await readdir(home.storageDir)).sort(), rmdirBefore, 'no lock/temp/quarantine files appear')
})
