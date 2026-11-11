import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONTROL_APPLY_PATH,
  CONTROL_CATALOG_PATH,
  CONTROL_DOCTOR_PATH,
  CONTROL_PLAN_PATH,
  CONTROL_RESOLVE_PATH,
  CONTROL_STATE_PATH,
  DEFAULT_PROFILE_ID,
  EVENTS_PATH,
  LOAD_PATH,
  MAX_CONTROL_BODY_BYTES,
  PROFILES_DIR_NAME,
  RECORD_FILE_NAME,
} from '../../src/host/constants.js'
import { controlPlanHash } from '../../src/host/profile-policy.js'
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

const connection = () => ({
  requestRejection(request) {
    const host = request.headers.host
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host ?? '')) return 403
    if (request.headers['sec-fetch-site'] === 'cross-site') return 403
    return request.headers.cookie === 'token=ok' ? undefined : 401
  },
})

const headers = { cookie: 'token=ok', 'content-type': 'application/json' }
const post = (body) => makeRequest({ method: 'POST', headers, body: JSON.stringify(body) })

const namedGroups = () => sampleDoc().groups.map((group) => ({ ...group, name: `${group.name}-工作` }))

/** Mount the control routes over a real profile manager (two profiles by default). */
const mountProfileControl = async (t, options = {}) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({
      revision: options.registryRevision ?? 2,
      activeId: options.activeId ?? DEFAULT_PROFILE_ID,
      profiles: options.profiles ?? [sampleDefaultProfile(), sampleNamedProfile()],
    }),
  )
  await writeProfileDoc(home, DEFAULT_PROFILE_ID, { revision: options.defaultRevision ?? 2 })
  if (options.writeNamed !== false) {
    await writeProfileDoc(home, PROFILE_ID, {
      revision: options.namedRevision ?? 2,
      groups: options.namedGroups ?? namedGroups(),
    })
  }
  const manager = createTestProfileManager(home)
  const mounted = await mountRoutes({
    profileManager: manager,
    connection: connection(),
    controlApiEnabled: true,
    doctorReport: options.doctorReport,
    changeHub: options.changeHub,
  })
  t.after(mounted.cleanup)
  return { home, manager, mounted }
}


test('control routes stay behind the API switch without changing their paths', async (t) => {
  const off = await mountRoutes({ connection: connection() })
  t.after(() => off.cleanup())
  assert.equal(off.routes.some((route) => route.path === CONTROL_STATE_PATH), true)
  const hidden = await off.call(CONTROL_STATE_PATH, makeRequest({ method: 'GET', headers }))
  assert.equal(hidden.res.statusCode, 404)
  assert.equal(hidden.json.code, 'control-disabled')

  const on = await mountRoutes({ connection: connection(), controlApiEnabled: true })
  t.after(() => on.cleanup())
  assert.deepEqual(
    on.mounted.routes.filter((path) => path.startsWith('/dsh-session-grove/control/') && !path.includes('/session/')),
    [CONTROL_DOCTOR_PATH, CONTROL_STATE_PATH, CONTROL_CATALOG_PATH, CONTROL_RESOLVE_PATH, CONTROL_PLAN_PATH, CONTROL_APPLY_PATH],
  )
})

test('control routes follow the live API switch without remounting', async (t) => {
  let enabled = false
  const mounted = await mountRoutes({
    connection: connection(),
    controlApiEnabled: () => enabled,
  })
  t.after(() => mounted.cleanup())

  const hidden = await mounted.call(CONTROL_STATE_PATH, makeRequest({ method: 'GET', headers }))
  assert.equal(hidden.res.statusCode, 404)
  assert.equal(hidden.json.code, 'control-disabled')

  enabled = true
  const visible = await mounted.call(CONTROL_STATE_PATH, makeRequest({ method: 'GET', headers }))
  assert.equal(visible.res.statusCode, 200)
})

test('control catalog is read-only and exposes the shared vocabulary', async (t) => {
  const mounted = await mountRoutes({ connection: connection(), controlApiEnabled: true })
  t.after(() => mounted.cleanup())
  const catalog = await mounted.call(CONTROL_CATALOG_PATH, makeRequest({ method: 'GET', headers }))
  assert.equal(catalog.res.statusCode, 200)
  assert.equal(catalog.json.ok, true)
  assert.equal(catalog.json.protocol, 1)
  assert.ok(catalog.json.icons.items.length > 70)
  assert.ok(catalog.json.icons.categories.length > 0)
  assert.ok(catalog.json.colors.items.length >= 12)
  assert.equal(catalog.json.colors.formats.custom.canonical, '#rrggbb')
  assert.ok(catalog.json.operations.includes('group.update'))
  assert.equal(catalog.json.revision, undefined, 'catalog must not read or leak group state')
})

test('control state, plan and apply use revision CAS and idempotency', async (t) => {
  const mounted = await mountRoutes({ connection: connection(), controlApiEnabled: true })
  t.after(() => mounted.cleanup())
  await mounted.store.save(sampleDoc())

  const state = await mounted.call(CONTROL_STATE_PATH, makeRequest({ headers }))
  assert.equal(state.res.statusCode, 200)
  assert.equal(state.json.revision, 1)
  assert.equal(state.json.groups[0].name, '施工中')
  assert.deepEqual(state.json.ungrouped, ['s-4'])

  const operations = [{ op: 'group.create', name: 'AI group', parentId: null, index: 0 }]
  const plan = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 1, operations }))
  assert.equal(plan.res.statusCode, 200)
  assert.equal(plan.json.ok, true)
  assert.equal(plan.json.changes.length, 1)
  assert.match(plan.json.planHash, /^[0-9a-f]{64}$/)

  const apply = await mounted.call(
    CONTROL_APPLY_PATH,
    post({ baseRevision: 1, operations, planHash: plan.json.planHash, idempotencyKey: 'test-1' }),
  )
  assert.equal(apply.res.statusCode, 200)
  assert.equal(apply.json.revision, 2)
  assert.equal(apply.json.doc.groups.some((group) => group.name === 'AI group'), true)

  const replay = await mounted.call(
    CONTROL_APPLY_PATH,
    post({ baseRevision: 1, operations, planHash: plan.json.planHash, idempotencyKey: 'test-1' }),
  )
  assert.equal(replay.res.statusCode, 200)
  assert.equal(replay.json.revision, 2)

  const stale = await mounted.call(
    CONTROL_APPLY_PATH,
    post({ baseRevision: 1, operations, planHash: plan.json.planHash, idempotencyKey: 'test-2' }),
  )
  assert.equal(stale.res.statusCode, 409)
  assert.equal(stale.json.code, 'conflict')

  const loaded = await mounted.call(LOAD_PATH, makeRequest({ headers }))
  assert.equal(loaded.json.revision, 2)
})

test('control bearer token bypasses the browser cookie fence only for control routes', async (t) => {
  const mounted = await mountRoutes({
    connection: connection(),
    controlApiEnabled: true,
    controlToken: 'secret-token',
  })
  t.after(() => mounted.cleanup())
  await mounted.store.save(sampleDoc())

  const state = await mounted.call(
    CONTROL_STATE_PATH,
    makeRequest({ headers: { authorization: 'Bearer secret-token' } }),
  )
  assert.equal(state.res.statusCode, 200)
  assert.equal(state.json.revision, 1)

  const bad = await mounted.call(
    CONTROL_STATE_PATH,
    makeRequest({ headers: { authorization: 'Bearer wrong-token' } }),
  )
  assert.equal(bad.res.statusCode, 401)
})

test('control rejects extra top-level fields and malformed idempotency keys', async (t) => {
  const mounted = await mountRoutes({ connection: connection(), controlApiEnabled: true })
  t.after(() => mounted.cleanup())
  await mounted.store.save(sampleDoc())
  const operations = [{ op: 'group.create', name: 'X', parentId: null, index: 0 }]

  const extra = await mounted.call(
    CONTROL_PLAN_PATH,
    post({ baseRevision: 1, operations, surprise: true }),
  )
  assert.equal(extra.res.statusCode, 422)
  assert.equal(extra.json.code, 'unexpected-field')
  assert.equal(extra.json.field, 'surprise')

  const badKey = await mounted.call(
    CONTROL_APPLY_PATH,
    post({ baseRevision: 1, operations, planHash: 'x'.repeat(64), idempotencyKey: 42 }),
  )
  assert.equal(badKey.res.statusCode, 422)
  assert.equal(badKey.json.code, 'invalid-idempotency-key')

  const badOperation = await mounted.call(
    CONTROL_PLAN_PATH,
    post({ baseRevision: 1, operations: [{ ...operations[0], surprise: true }] }),
  )
  assert.equal(badOperation.res.statusCode, 422)
  assert.equal(badOperation.json.code, 'invalid-operation')
  assert.equal(badOperation.json.operationIndex, 0)

  const loaded = await mounted.call(LOAD_PATH, makeRequest({ headers }))
  assert.equal(loaded.json.revision, 1)
})

test('control resolves full paths, reports missing/ambiguous paths and rejects control characters', async (t) => {
  const mounted = await mountRoutes({ connection: connection(), controlApiEnabled: true })
  t.after(() => mounted.cleanup())
  await mounted.store.save(sampleDoc())

  const state = await mounted.call(CONTROL_STATE_PATH, makeRequest({ headers }))
  assert.deepEqual(state.json.groups[0].path, ['施工中'])
  assert.deepEqual(state.json.groups[1].path, ['施工中', '子组'])
  assert.equal(state.json.groups[0].icon, 'folder-open')
  assert.equal(typeof state.json.groups[0].color, 'string')

  const resolved = await mounted.call(
    CONTROL_RESOLVE_PATH,
    post({ path: ['施工中', '子组'], baseRevision: 1 }),
  )
  assert.equal(resolved.res.statusCode, 200)
  assert.equal(resolved.json.groupId, state.json.groups[1].id)
  assert.equal(resolved.json.revision, 1)

  const missing = await mounted.call(CONTROL_RESOLVE_PATH, post({ path: ['不存在'] }))
  assert.equal(missing.res.statusCode, 404)
  assert.equal(missing.json.code, 'group-not-found')

  const invalid = await mounted.call(CONTROL_RESOLVE_PATH, post({ path: ['施工\n中'] }))
  assert.equal(invalid.res.statusCode, 422)
  assert.equal(invalid.json.code, 'invalid-path')

  const stale = await mounted.call(
    CONTROL_RESOLVE_PATH,
    post({ path: ['施工中'], baseRevision: 0 }),
  )
  assert.equal(stale.res.statusCode, 409)
  assert.equal(stale.json.code, 'revision-mismatch')

  const duplicate = {
    ...sampleDoc(),
    groups: [...sampleDoc().groups, { ...sampleDoc().groups[0], id: 'g-duplicate', sessionIds: [] }],
  }
  await mounted.store.save(duplicate)
  const ambiguous = await mounted.call(CONTROL_RESOLVE_PATH, post({ path: ['施工中'] }))
  assert.equal(ambiguous.res.statusCode, 409)
  assert.equal(ambiguous.json.code, 'ambiguous-path')
  assert.equal(ambiguous.json.candidates.length, 2)
  assert.deepEqual(Object.keys(ambiguous.json.candidates[0]).sort(), ['id', 'parentId', 'path'])
})

test('destructive control operations require the separate switch', async (t) => {
  const guarded = await mountRoutes({ connection: connection(), controlApiEnabled: true })
  t.after(() => guarded.cleanup())
  await guarded.store.save(sampleDoc())
  const groupId = sampleDoc().groups[0].id
  const operations = [{ op: 'group.delete', groupId, destinationId: null }]
  const denied = await guarded.call(CONTROL_PLAN_PATH, post({ baseRevision: 1, operations }))
  assert.equal(denied.res.statusCode, 422)
  assert.equal(denied.json.message, 'destructive-disabled')

  const allowed = await mountRoutes({
    connection: connection(),
    controlApiEnabled: true,
    controlDestructiveEnabled: true,
  })
  t.after(() => allowed.cleanup())
  await allowed.store.save(sampleDoc())
  const plan = await allowed.call(CONTROL_PLAN_PATH, post({ baseRevision: 1, operations }))
  assert.equal(plan.res.statusCode, 200)
  const applied = await allowed.call(
    CONTROL_APPLY_PATH,
    post({ baseRevision: 1, operations, planHash: plan.json.planHash }),
  )
  assert.equal(applied.res.statusCode, 200)
  assert.equal(applied.json.doc.groups.some((group) => group.id === groupId), false)
})

test('control routes reject unsupported media, oversized bodies, invalid JSON and invalid revisions', async (t) => {
  const mounted = await mountRoutes({ connection: connection(), controlApiEnabled: true })
  t.after(() => mounted.cleanup())
  await mounted.store.save(sampleDoc())

  const wrongType = await mounted.call(CONTROL_PLAN_PATH, makeRequest({ method: 'POST', headers: { cookie: 'token=ok' }, body: '{}' }))
  assert.equal(wrongType.res.statusCode, 415)
  assert.equal(wrongType.json.code, 'unsupported-media-type')

  const oversized = await mounted.call(CONTROL_PLAN_PATH, makeRequest({
    method: 'POST',
    headers: { cookie: 'token=ok', 'content-type': 'application/json' },
    body: `"${'x'.repeat(MAX_CONTROL_BODY_BYTES)}"`,
  }))
  assert.equal(oversized.res.statusCode, 413)
  assert.equal(oversized.json.code, 'payload-too-large')

  for (const [body, code] of [['{', 'invalid'], ['null', 'invalid-body'], ['[]', 'invalid-body']]) {
    const invalid = await mounted.call(CONTROL_PLAN_PATH, makeRequest({
      method: 'POST',
      headers: { cookie: 'token=ok', 'content-type': 'application/json' },
      body,
    }))
    assert.equal(invalid.res.statusCode, 422)
    assert.equal(invalid.json.code, code)
  }

  const badRevision = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: -1, operations: [] }))
  assert.equal(badRevision.res.statusCode, 422)
  assert.equal(badRevision.json.code, 'invalid-revision')

  const badApplyRevision = await mounted.call(CONTROL_APPLY_PATH, post({ baseRevision: '1', operations: [], planHash: 'x' }))
  assert.equal(badApplyRevision.res.statusCode, 422)
  assert.equal(badApplyRevision.json.code, 'invalid-revision')

  const noPlan = await mounted.call(CONTROL_APPLY_PATH, post({ baseRevision: 1, operations: [] }))
  assert.equal(noPlan.res.statusCode, 422)
  assert.equal(noPlan.json.code, 'invalid-plan')

  const stalePlan = await mounted.call(CONTROL_APPLY_PATH, post({ baseRevision: 1, operations: [], planHash: 'x'.repeat(64) }))
  assert.equal(stalePlan.res.statusCode, 409)
  assert.equal(stalePlan.json.code, 'stale-plan')
})

test('control apply rejects idempotency-key reuse for another plan', async (t) => {
  const mounted = await mountRoutes({ connection: connection(), controlApiEnabled: true })
  t.after(() => mounted.cleanup())
  await mounted.store.save(sampleDoc())
  const firstOperations = [{ op: 'group.create', name: 'First', parentId: null, index: 0 }]
  const firstPlan = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 1, operations: firstOperations }))
  const firstApply = await mounted.call(CONTROL_APPLY_PATH, post({
    baseRevision: 1,
    operations: firstOperations,
    planHash: firstPlan.json.planHash,
    idempotencyKey: 'same-key',
  }))
  assert.equal(firstApply.res.statusCode, 200)

  const secondOperations = [{ op: 'group.create', name: 'Second', parentId: null, index: 0 }]
  const secondPlan = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 2, operations: secondOperations }))
  const conflict = await mounted.call(CONTROL_APPLY_PATH, post({
    baseRevision: 2,
    operations: secondOperations,
    planHash: secondPlan.json.planHash,
    idempotencyKey: 'same-key',
  }))
  assert.equal(conflict.res.statusCode, 409)
  assert.equal(conflict.json.code, 'idempotency-conflict')
})

test('control routes fail closed on unsupported document versions and storage IO errors', async (t) => {
  const unsupportedStore = {
    async load() { return { kind: 'unsupported-version', version: 9 } },
    async commit() { throw new Error('unreachable') },
  }
  const unsupported = await mountRoutes({
    store: unsupportedStore,
    connection: connection(),
    controlApiEnabled: true,
  })
  t.after(() => unsupported.cleanup())
  const unsupportedState = await unsupported.call(CONTROL_STATE_PATH, makeRequest({ headers }))
  assert.equal(unsupportedState.res.statusCode, 409)
  assert.equal(unsupportedState.json.code, 'unsupported-version')
  assert.equal(unsupportedState.json.version, 9)

  const ioStore = {
    async load() { throw new Error('disk io') },
    async commit() { throw new Error('unreachable') },
  }
  const io = await mountRoutes({ store: ioStore, connection: connection(), controlApiEnabled: true })
  t.after(() => io.cleanup())
  const ioState = await io.call(CONTROL_STATE_PATH, makeRequest({ headers }))
  assert.equal(ioState.res.statusCode, 503)
  assert.equal(ioState.json.code, 'io')
  assert.match(ioState.json.message, /disk io/)
})

test('control doctor is a read-only GET available while controlApi is closed', async (t) => {
  const report = { ok: true, protocol: 1, plugin: { version: 'test' }, gates: { controlApi: false } }
  const mounted = await mountRoutes({
    connection: connection(),
    controlApiEnabled: false,
    doctorReport: async () => report,
  })
  t.after(() => mounted.cleanup())
  const doctor = await mounted.call(CONTROL_DOCTOR_PATH, makeRequest({ headers }))
  assert.equal(doctor.res.statusCode, 200)
  assert.deepEqual(doctor.json, report)

  const post = await mounted.call(CONTROL_DOCTOR_PATH, makeRequest({ method: 'POST', headers }))
  assert.equal(post.res.statusCode, 405)

  const missing = await mountRoutes({ connection: connection(), controlApiEnabled: false })
  t.after(() => missing.cleanup())
  const unavailable = await missing.call(CONTROL_DOCTOR_PATH, makeRequest({ headers }))
  assert.equal(unavailable.res.statusCode, 503)
  assert.equal(unavailable.json.code, 'doctor-unavailable')
})

test('control state and resolve default to the active profile and echo profileId/activeProfile', async (t) => {
  const { mounted } = await mountProfileControl(t)

  const active = await mounted.call(CONTROL_STATE_PATH, makeRequest({ headers }))
  assert.equal(active.res.statusCode, 200)
  assert.equal(active.json.profileId, DEFAULT_PROFILE_ID)
  assert.deepEqual(active.json.activeProfile, { id: DEFAULT_PROFILE_ID, name: null })
  assert.equal(active.json.revision, 2)
  assert.equal(active.json.groups[0].name, '施工中')

  const named = await mounted.call(
    CONTROL_STATE_PATH,
    makeRequest({ headers, url: `${CONTROL_STATE_PATH}?profileId=${PROFILE_ID}` }),
  )
  assert.equal(named.res.statusCode, 200)
  assert.equal(named.json.profileId, PROFILE_ID)
  assert.deepEqual(named.json.activeProfile, { id: DEFAULT_PROFILE_ID, name: null })
  assert.equal(named.json.revision, 2)
  assert.equal(named.json.groups[0].name, '施工中-工作')

  const resolvedNamed = await mounted.call(
    CONTROL_RESOLVE_PATH,
    post({ profileId: PROFILE_ID, path: ['施工中-工作', '子组-工作'] }),
  )
  assert.equal(resolvedNamed.res.statusCode, 200)
  assert.equal(resolvedNamed.json.profileId, PROFILE_ID)
  assert.deepEqual(resolvedNamed.json.activeProfile, { id: DEFAULT_PROFILE_ID, name: null })
  assert.equal(resolvedNamed.json.groupId, named.json.groups[1].id)

  const resolvedActive = await mounted.call(CONTROL_RESOLVE_PATH, post({ path: ['施工中'] }))
  assert.equal(resolvedActive.res.statusCode, 200)
  assert.equal(resolvedActive.json.profileId, DEFAULT_PROFILE_ID)
  assert.equal(resolvedActive.json.groupId, active.json.groups[0].id)
})

test('control plan/apply require profileId with multiple profiles and bind planHash to the profile', async (t) => {
  const changeCalls = []
  const changeHub = {
    publish: (...args) => changeCalls.push(args),
    publishActive: () => {},
    subscribe: () => () => {},
  }
  const { mounted } = await mountProfileControl(t, { changeHub })
  const operations = [{ op: 'group.create', name: 'AI', parentId: null, index: 0 }]

  const missingPlan = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 2, operations }))
  assert.equal(missingPlan.res.statusCode, 422)
  assert.equal(missingPlan.json.code, 'profile-required')
  assert.equal(missingPlan.json.field, 'profileId')

  const missingApply = await mounted.call(
    CONTROL_APPLY_PATH,
    post({ baseRevision: 2, operations, planHash: 'x'.repeat(64) }),
  )
  assert.equal(missingApply.res.statusCode, 422)
  assert.equal(missingApply.json.code, 'profile-required')

  const defaultPlan = await mounted.call(
    CONTROL_PLAN_PATH,
    post({ baseRevision: 2, operations, profileId: DEFAULT_PROFILE_ID }),
  )
  const namedPlan = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 2, operations, profileId: PROFILE_ID }))
  assert.equal(defaultPlan.res.statusCode, 200)
  assert.equal(namedPlan.res.statusCode, 200)
  assert.equal(defaultPlan.json.profileId, DEFAULT_PROFILE_ID)
  assert.equal(namedPlan.json.profileId, PROFILE_ID)
  assert.equal(defaultPlan.json.planHash, controlPlanHash(DEFAULT_PROFILE_ID, 2, operations))
  assert.equal(namedPlan.json.planHash, controlPlanHash(PROFILE_ID, 2, operations))
  assert.notEqual(defaultPlan.json.planHash, namedPlan.json.planHash)

  const crossProfile = await mounted.call(
    CONTROL_APPLY_PATH,
    post({ baseRevision: 2, operations, profileId: PROFILE_ID, planHash: defaultPlan.json.planHash }),
  )
  assert.equal(crossProfile.res.statusCode, 409)
  assert.equal(crossProfile.json.code, 'stale-plan')

  // The named profile is not active; an explicit write to it is still allowed.
  const applied = await mounted.call(
    CONTROL_APPLY_PATH,
    post({ baseRevision: 2, operations, profileId: PROFILE_ID, planHash: namedPlan.json.planHash }),
  )
  assert.equal(applied.res.statusCode, 200)
  assert.equal(applied.json.profileId, PROFILE_ID)
  assert.equal(applied.json.revision, 3)
  assert.equal(typeof applied.json.doc, 'object')
  assert.deepEqual(changeCalls, [[3, 'control-apply', PROFILE_ID]])

  const namedState = await mounted.call(
    CONTROL_STATE_PATH,
    makeRequest({ headers, url: `${CONTROL_STATE_PATH}?profileId=${PROFILE_ID}` }),
  )
  assert.equal(namedState.json.revision, 3)
  const activeState = await mounted.call(CONTROL_STATE_PATH, makeRequest({ headers }))
  assert.equal(activeState.json.revision, 2, 'writing a named profile must not touch the active document')
})

test('control keeps profileId optional when only the default profile exists', async (t) => {
  const { mounted } = await mountProfileControl(t, {
    profiles: [sampleDefaultProfile()],
    registryRevision: 1,
    defaultRevision: 1,
    writeNamed: false,
  })
  const operations = [{ op: 'group.create', name: 'Solo', parentId: null, index: 0 }]
  const plan = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 1, operations }))
  assert.equal(plan.res.statusCode, 200)
  assert.equal(plan.json.profileId, DEFAULT_PROFILE_ID)
  assert.equal(plan.json.planHash, controlPlanHash(DEFAULT_PROFILE_ID, 1, operations))

  const applied = await mounted.call(
    CONTROL_APPLY_PATH,
    post({ baseRevision: 1, operations, planHash: plan.json.planHash }),
  )
  assert.equal(applied.res.statusCode, 200)
  assert.equal(applied.json.profileId, DEFAULT_PROFILE_ID)
  assert.equal(applied.json.revision, 2)
})

test('control rejects invalid, missing and archived profile targets', async (t) => {
  const { mounted } = await mountProfileControl(t, {
    profiles: [sampleDefaultProfile(), sampleNamedProfile({ archivedAt: FIXED_TIMESTAMP })],
  })

  const invalid = await mounted.call(
    CONTROL_STATE_PATH,
    makeRequest({ headers, url: `${CONTROL_STATE_PATH}?profileId=Bad_ID` }),
  )
  assert.equal(invalid.res.statusCode, 422)
  assert.equal(invalid.json.code, 'invalid-profile-id')

  const missing = await mounted.call(
    CONTROL_STATE_PATH,
    makeRequest({ headers, url: `${CONTROL_STATE_PATH}?profileId=p-unknown-123` }),
  )
  assert.equal(missing.res.statusCode, 409)
  assert.equal(missing.json.code, 'profile-missing')
  assert.equal(missing.json.profileId, 'p-unknown-123')

  const archived = await mounted.call(
    CONTROL_PLAN_PATH,
    post({ baseRevision: 2, operations: [{ op: 'group.create', name: 'X', parentId: null }], profileId: PROFILE_ID }),
  )
  assert.equal(archived.res.statusCode, 409)
  assert.equal(archived.json.code, 'profile-archived')
  assert.equal(archived.json.profileId, PROFILE_ID)
})

test('control reports missing and unhealthy named profile documents', async (t) => {
  const missingHome = await makeTempProfileHome()
  t.after(missingHome.cleanup)
  const missingId = 'p-missing-0001'
  await writeJsonFile(
    missingHome.registryFilePath,
    sampleRegistry({
      revision: 1,
      profiles: [sampleDefaultProfile(), sampleNamedProfile({ id: missingId })],
    }),
  )
  await writeProfileDoc(missingHome, DEFAULT_PROFILE_ID, { revision: 1 })
  const missingManager = createTestProfileManager(missingHome)
  const missingMounted = await mountRoutes({
    profileManager: missingManager,
    connection: connection(),
    controlApiEnabled: true,
  })
  t.after(missingMounted.cleanup)
  const missing = await missingMounted.call(
    CONTROL_STATE_PATH,
    makeRequest({ headers, url: `${CONTROL_STATE_PATH}?profileId=${missingId}` }),
  )
  assert.equal(missing.res.statusCode, 409)
  assert.equal(missing.json.code, 'profile-missing')

  const { home, mounted } = await mountProfileControl(t)
  await writeJsonFile(join(home.storageDir, PROFILES_DIR_NAME, PROFILE_ID, RECORD_FILE_NAME), {
    version: 1,
    revision: 2,
    groups: 'not-an-array',
    ungrouped: [],
  })
  const unhealthy = await mounted.call(
    CONTROL_STATE_PATH,
    makeRequest({ headers, url: `${CONTROL_STATE_PATH}?profileId=${PROFILE_ID}` }),
  )
  assert.equal(unhealthy.res.statusCode, 409)
  assert.equal(unhealthy.json.code, 'profile-unhealthy')
  assert.equal(unhealthy.json.profileId, PROFILE_ID)
  assert.equal(unhealthy.json.health.kind, 'invalid')
})

test('control refuses profile actions on a degraded registry while catalog and doctor stay read-only', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeProfileDoc(home, DEFAULT_PROFILE_ID, { revision: 1 })
  await writeFile(home.registryFilePath, '{ not-a-registry', 'utf8')
  const manager = createTestProfileManager(home)
  const report = { ok: true, protocol: 1, storage: { health: { status: 'ok' } } }
  const mounted = await mountRoutes({
    profileManager: manager,
    connection: connection(),
    controlApiEnabled: true,
    doctorReport: async () => report,
  })
  t.after(mounted.cleanup)

  const state = await mounted.call(CONTROL_STATE_PATH, makeRequest({ headers }))
  assert.equal(state.res.statusCode, 409)
  assert.equal(state.json.code, 'registry-unhealthy')

  const catalog = await mounted.call(CONTROL_CATALOG_PATH, makeRequest({ headers }))
  assert.equal(catalog.res.statusCode, 200)
  assert.equal(catalog.json.ok, true)

  const doctor = await mounted.call(CONTROL_DOCTOR_PATH, makeRequest({ headers }))
  assert.equal(doctor.res.statusCode, 200)
  assert.deepEqual(doctor.json.storage.health, { status: 'ok' })
  assert.equal(doctor.json.storage.profiles.length, 1)
  assert.equal(doctor.json.storage.profiles[0].id, DEFAULT_PROFILE_ID)
  assert.equal(typeof doctor.json.storage.registry.status, 'string')
})

test('control doctor adds registry and per-profile storage rows', async (t) => {
  const { home, mounted } = await mountProfileControl(t, {
    doctorReport: async () => ({ ok: true, protocol: 1, storage: { health: { status: 'ok' }, filePath: 'x' } }),
  })
  const profileDir = join(home.storageDir, PROFILES_DIR_NAME, PROFILE_ID)
  await writeJsonFile(join(profileDir, `${RECORD_FILE_NAME.slice(0, -5)}.corrupt-2026-01-01.json`), { old: true })
  await writeJsonFile(join(profileDir, RECORD_FILE_NAME), {
    version: 1,
    revision: 2,
    groups: 'not-an-array',
    ungrouped: [],
  })

  const doctor = await mounted.call(CONTROL_DOCTOR_PATH, makeRequest({ headers }))
  assert.equal(doctor.res.statusCode, 200)
  assert.equal(doctor.json.storage.filePath, 'x')
  assert.equal(doctor.json.storage.registry.status, 'ok')
  assert.equal(doctor.json.storage.registry.revision, 2)
  assert.equal(doctor.json.storage.registry.activeId, DEFAULT_PROFILE_ID)
  assert.equal(doctor.json.storage.registry.profileCount, 2)
  assert.equal(doctor.json.storage.registry.degraded, false)

  assert.equal(doctor.json.storage.profiles.length, 2)
  const byId = new Map(doctor.json.storage.profiles.map((profile) => [profile.id, profile]))
  const defaultRow = byId.get(DEFAULT_PROFILE_ID)
  assert.deepEqual(
    {
      id: defaultRow.id,
      name: defaultRow.name,
      archived: defaultRow.archived,
      healthy: defaultRow.healthy,
      revision: defaultRow.revision,
      backupStatus: defaultRow.backupStatus,
      quarantinedTo: defaultRow.quarantinedTo,
    },
    {
      id: DEFAULT_PROFILE_ID,
      name: null,
      archived: false,
      healthy: true,
      revision: 2,
      backupStatus: 'missing',
      quarantinedTo: null,
    },
  )
  const namedRow = byId.get(PROFILE_ID)
  assert.equal(namedRow.name, '工作项目')
  assert.equal(namedRow.archived, false)
  assert.equal(namedRow.healthy, false)
  assert.equal(namedRow.status, 'invalid')
  assert.equal(namedRow.quarantined, 1)
  assert.match(namedRow.quarantinedTo, /dsh-session-grove\.corrupt-\*\.json$/)
  assert.match(namedRow.quarantineNote, /1 quarantined document/)
})

test('control apply idempotency is scoped per profile', async (t) => {
  const { mounted } = await mountProfileControl(t)
  const operations = [{ op: 'group.create', name: 'Idem', parentId: null, index: 0 }]
  const defaultPlan = await mounted.call(
    CONTROL_PLAN_PATH,
    post({ baseRevision: 2, operations, profileId: DEFAULT_PROFILE_ID }),
  )
  const namedPlan = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 2, operations, profileId: PROFILE_ID }))
  const applyBody = (profileId, planHash) => ({
    baseRevision: 2,
    operations,
    profileId,
    planHash,
    idempotencyKey: 'shared-key',
  })

  const defaultApply = await mounted.call(CONTROL_APPLY_PATH, post(applyBody(DEFAULT_PROFILE_ID, defaultPlan.json.planHash)))
  assert.equal(defaultApply.res.statusCode, 200)
  assert.equal(defaultApply.json.revision, 3)

  // Same key on another profile must not replay the default response.
  const namedApply = await mounted.call(CONTROL_APPLY_PATH, post(applyBody(PROFILE_ID, namedPlan.json.planHash)))
  assert.equal(namedApply.res.statusCode, 200)
  assert.equal(namedApply.json.profileId, PROFILE_ID)
  assert.equal(namedApply.json.revision, 3)

  const replay = await mounted.call(CONTROL_APPLY_PATH, post(applyBody(DEFAULT_PROFILE_ID, defaultPlan.json.planHash)))
  assert.equal(replay.res.statusCode, 200)
  assert.equal(replay.json.profileId, DEFAULT_PROFILE_ID)
  assert.equal(replay.json.revision, 3)

  const other = [{ op: 'group.create', name: 'Other', parentId: null, index: 0 }]
  const conflict = await mounted.call(
    CONTROL_APPLY_PATH,
    post({
      baseRevision: 3,
      operations: other,
      profileId: DEFAULT_PROFILE_ID,
      planHash: controlPlanHash(DEFAULT_PROFILE_ID, 3, other),
      idempotencyKey: 'shared-key',
    }),
  )
  assert.equal(conflict.res.statusCode, 409)
  assert.equal(conflict.json.code, 'idempotency-conflict')

  // No key means no replay: the second attempt sees the moved revision.
  const noKeyOperations = [{ op: 'group.create', name: 'NoKey', parentId: null, index: 0 }]
  const noKeyPlan = await mounted.call(
    CONTROL_PLAN_PATH,
    post({ baseRevision: 3, operations: noKeyOperations, profileId: DEFAULT_PROFILE_ID }),
  )
  assert.equal(noKeyPlan.res.statusCode, 200)
  const noKeyBody = {
    baseRevision: 3,
    operations: noKeyOperations,
    profileId: DEFAULT_PROFILE_ID,
    planHash: noKeyPlan.json.planHash,
  }
  const noKeyFirst = await mounted.call(CONTROL_APPLY_PATH, post(noKeyBody))
  assert.equal(noKeyFirst.res.statusCode, 200)
  assert.equal(noKeyFirst.json.revision, 4)
  const noKeySecond = await mounted.call(CONTROL_APPLY_PATH, post(noKeyBody))
  assert.equal(noKeySecond.res.statusCode, 409)
  assert.equal(noKeySecond.json.code, 'conflict')
})

// ---------------------------------------------------------------------------
// T3.3 boundary tests (SPEC §8.2): idempotency eviction, degraded zero-write
// and the per-route fence/method/body status matrix.
// ---------------------------------------------------------------------------

test('T3.3: the apply idempotency cache keeps 128 entries and evicts oldest first', async (t) => {
  const state = { doc: { ...sampleDoc(), revision: 1 }, revision: 1 }
  const store = {
    async load() {
      return { kind: 'ok', doc: state.doc, revision: state.revision, exists: true }
    },
    async peek() {
      return { kind: 'ok', doc: state.doc, revision: state.revision, exists: true }
    },
    async commit(baseRevision, nextDoc) {
      if (baseRevision !== state.revision) return { kind: 'conflict', doc: state.doc, revision: state.revision }
      state.revision += 1
      state.doc = { ...nextDoc, revision: state.revision }
      return { kind: 'ok', doc: state.doc, revision: state.revision }
    },
  }
  const mounted = await mountRoutes({ store, connection: connection(), controlApiEnabled: true })
  t.after(() => mounted.cleanup())

  const operationsFor = (index) => [{ op: 'group.create', name: `Evict ${index}`, parentId: null, index: 0 }]
  const bodyFor = (index, baseRevision) => ({
    baseRevision,
    operations: operationsFor(index),
    planHash: controlPlanHash(DEFAULT_PROFILE_ID, baseRevision, operationsFor(index)),
    idempotencyKey: `evict-${index}`,
  })
  const apply = async (index, baseRevision) => {
    const response = await mounted.call(CONTROL_APPLY_PATH, post(bodyFor(index, baseRevision)))
    assert.equal(response.res.statusCode, 200, `apply ${index}`)
    return response.json
  }

  // 129 entries: the first insert is evicted as soon as the 129th arrives.
  let baseRevision = 1
  for (let index = 0; index < 129; index += 1) {
    baseRevision = (await apply(index, baseRevision)).revision
  }
  const evicted = await mounted.call(CONTROL_APPLY_PATH, post(bodyFor(0, 1)))
  assert.equal(evicted.res.statusCode, 409, 'evict-0 must have been evicted')
  assert.equal(evicted.json.code, 'conflict')
  // The oldest surviving entry is still served from the cache with its original
  // (now stale) revision, proving it did not run the stale-revision path.
  const retained = await mounted.call(CONTROL_APPLY_PATH, post(bodyFor(1, 2)))
  assert.equal(retained.res.statusCode, 200)
  assert.equal(retained.json.revision, 3)

  // The 130th entry evicts evict-1, not evict-128: FIFO order, not LRU.
  const overflow = await apply(129, baseRevision)
  assert.equal(overflow.revision, 131)
  const evictedSecond = await mounted.call(CONTROL_APPLY_PATH, post(bodyFor(1, 2)))
  assert.equal(evictedSecond.res.statusCode, 409)
  assert.equal(evictedSecond.json.code, 'conflict')
  const newest = await mounted.call(CONTROL_APPLY_PATH, post(bodyFor(128, 129)))
  assert.equal(newest.res.statusCode, 200)
  assert.equal(newest.json.revision, 130)
  const last = await mounted.call(CONTROL_APPLY_PATH, post(bodyFor(129, 130)))
  assert.equal(last.res.statusCode, 200)
  assert.equal(last.json.revision, 131)
})

test('T3.3: a degraded registry refuses plan and apply without writing anything', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeProfileDoc(home, DEFAULT_PROFILE_ID, { revision: 1 })
  await writeFile(home.registryFilePath, '{ not-a-registry', 'utf8')
  const manager = createTestProfileManager(home)
  const mounted = await mountRoutes({ profileManager: manager, connection: connection(), controlApiEnabled: true })
  t.after(mounted.cleanup)

  // Heal/quarantine once before the snapshot so the assertion below covers only
  // what plan/apply themselves might write.
  await manager.loadRegistry()
  const filesBefore = (await readdir(home.storageDir)).sort()
  const recordBefore = await readFile(home.defaultFilePath, 'utf8')

  const operations = [{ op: 'group.create', name: 'Degraded', parentId: null, index: 0 }]
  const plan = await mounted.call(
    CONTROL_PLAN_PATH,
    post({ baseRevision: 1, operations, profileId: DEFAULT_PROFILE_ID }),
  )
  assert.equal(plan.res.statusCode, 409)
  assert.equal(plan.json.code, 'registry-unhealthy')

  const apply = await mounted.call(
    CONTROL_APPLY_PATH,
    post({
      baseRevision: 1,
      operations,
      profileId: DEFAULT_PROFILE_ID,
      planHash: controlPlanHash(DEFAULT_PROFILE_ID, 1, operations),
      idempotencyKey: 'degraded-write',
    }),
  )
  assert.equal(apply.res.statusCode, 409)
  assert.equal(apply.json.code, 'registry-unhealthy')

  assert.deepEqual((await readdir(home.storageDir)).sort(), filesBefore, 'degraded plan/apply must not write')
  assert.equal(await readFile(home.defaultFilePath, 'utf8'), recordBefore)
})

test('T3.3: every control route enforces the fence, the method and the body ceiling', async (t) => {
  const changeHub = { publish() {}, publishActive() {}, subscribe() { return () => {} } }
  const mounted = await mountRoutes({ connection: connection(), controlApiEnabled: true, changeHub })
  t.after(mounted.cleanup)
  const getRoutes = [CONTROL_STATE_PATH, CONTROL_CATALOG_PATH, CONTROL_DOCTOR_PATH, EVENTS_PATH]
  const postRoutes = [CONTROL_RESOLVE_PATH, CONTROL_PLAN_PATH, CONTROL_APPLY_PATH]

  for (const path of [...getRoutes, ...postRoutes]) {
    const unauthorized = await mounted.call(
      path,
      makeRequest({
        method: getRoutes.includes(path) ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
      }),
    )
    assert.equal(unauthorized.res.statusCode, 401, `${path} must require the fence cookie`)
    const crossSite = await mounted.call(
      path,
      makeRequest({ method: 'GET', headers: { cookie: 'token=ok', 'sec-fetch-site': 'cross-site' } }),
    )
    assert.equal(crossSite.res.statusCode, 403, `${path} must reject cross-site requests`)
  }

  for (const path of getRoutes) {
    const wrongMethod = await mounted.call(path, makeRequest({ method: 'POST', headers }))
    assert.equal(wrongMethod.res.statusCode, 405, `${path} must reject POST`)
  }
  for (const path of postRoutes) {
    const wrongMethod = await mounted.call(path, makeRequest({ method: 'GET', headers }))
    assert.equal(wrongMethod.res.statusCode, 405, `${path} must reject GET`)
    const oversized = await mounted.call(
      path,
      makeRequest({
        method: 'POST',
        headers,
        body: `"${'x'.repeat(MAX_CONTROL_BODY_BYTES)}"`,
      }),
    )
    assert.equal(oversized.res.statusCode, 413, `${path} must reject an oversized body`)
    assert.equal(oversized.json.code, 'payload-too-large')
  }

  // Apply is the one route with an extra allow-list (planHash/idempotencyKey);
  // an unexpected field must still be rejected before any profile work.
  const unexpectedApply = await mounted.call(
    CONTROL_APPLY_PATH,
    post({ baseRevision: 1, operations: [], planHash: 'x', idempotencyKey: 'y', surprise: true }),
  )
  assert.equal(unexpectedApply.res.statusCode, 422)
  assert.equal(unexpectedApply.json.code, 'unexpected-field')
})

test('T3.3: resolve/plan/apply fail closed on an unsupported document version', async (t) => {
  const unsupportedStore = {
    async load() {
      return { kind: 'unsupported-version', version: 9 }
    },
    async commit() {
      throw new Error('unreachable')
    },
    async peek() {
      return { kind: 'unsupported-version', version: 9 }
    },
  }
  const mounted = await mountRoutes({ store: unsupportedStore, connection: connection(), controlApiEnabled: true })
  t.after(mounted.cleanup)

  const resolve = await mounted.call(CONTROL_RESOLVE_PATH, post({ path: [] }))
  assert.equal(resolve.res.statusCode, 409)
  assert.equal(resolve.json.code, 'unsupported-version')
  assert.equal(resolve.json.version, 9)

  const operations = []
  const plan = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 1, operations }))
  assert.equal(plan.res.statusCode, 409)
  assert.equal(plan.json.code, 'unsupported-version')

  const apply = await mounted.call(
    CONTROL_APPLY_PATH,
    post({ baseRevision: 1, operations, planHash: controlPlanHash(DEFAULT_PROFILE_ID, 1, operations) }),
  )
  assert.equal(apply.res.statusCode, 409)
  assert.equal(apply.json.code, 'unsupported-version')
})

test('T3.3: resolve validates its revision, plan reports conflicts and apply rejects bad operations', async (t) => {
  const mounted = await mountRoutes({ connection: connection(), controlApiEnabled: true })
  t.after(mounted.cleanup)
  await mounted.store.save(sampleDoc())

  const badRevision = await mounted.call(CONTROL_RESOLVE_PATH, post({ path: [], baseRevision: -2 }))
  assert.equal(badRevision.res.statusCode, 422)
  assert.equal(badRevision.json.code, 'invalid-revision')

  const revisionMismatch = await mounted.call(CONTROL_RESOLVE_PATH, post({ path: [], baseRevision: 99 }))
  assert.equal(revisionMismatch.res.statusCode, 409)
  assert.equal(revisionMismatch.json.code, 'revision-mismatch')

  const conflict = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 99, operations: [] }))
  assert.equal(conflict.res.statusCode, 409)
  assert.equal(conflict.json.code, 'conflict')

  const invalidOperations = [{ op: 'group.rename', groupId: 'g-missing', name: 'x' }]
  const invalidPlan = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 1, operations: invalidOperations }))
  assert.equal(invalidPlan.res.statusCode, 422)
  assert.equal(typeof invalidPlan.json.code, 'string')
  const invalidApply = await mounted.call(
    CONTROL_APPLY_PATH,
    post({
      baseRevision: 1,
      operations: invalidOperations,
      planHash: controlPlanHash(DEFAULT_PROFILE_ID, 1, invalidOperations),
    }),
  )
  assert.equal(invalidApply.res.statusCode, 422)
  assert.equal(typeof invalidApply.json.code, 'string')
})

test('T3.3: control routes report registry, document and doctor failures as 503 io', async (t) => {
  const throwingManager = {
    storageDir: join(tmpdir(), 'dsg-control-io'),
    loadRegistry: async () => {
      throw new Error('registry io')
    },
    storeFor: () => ({
      async load() {
        return { kind: 'ok', doc: sampleDoc(), revision: 1, exists: true }
      },
    }),
    peekFor: async () => ({ kind: 'ok' }),
    entryFor: async () => null,
  }
  const registryIo = await mountRoutes({
    profileManager: throwingManager,
    connection: connection(),
    controlApiEnabled: true,
  })
  t.after(registryIo.cleanup)
  const resolve = await registryIo.call(CONTROL_RESOLVE_PATH, post({ path: [] }))
  assert.equal(resolve.res.statusCode, 503)
  assert.equal(resolve.json.code, 'io')
  const plan = await registryIo.call(CONTROL_PLAN_PATH, post({ baseRevision: 1, operations: [] }))
  assert.equal(plan.res.statusCode, 503)
  assert.equal(plan.json.code, 'io')

  const throwingStore = {
    async load() {
      throw new Error('document io')
    },
    async peek() {
      throw new Error('document io')
    },
    async commit() {
      throw new Error('unreachable')
    },
  }
  const storeIo = await mountRoutes({ store: throwingStore, connection: connection(), controlApiEnabled: true })
  t.after(storeIo.cleanup)
  const apply = await storeIo.call(
    CONTROL_APPLY_PATH,
    post({ baseRevision: 1, operations: [], planHash: controlPlanHash(DEFAULT_PROFILE_ID, 1, []) }),
  )
  assert.equal(apply.res.statusCode, 503)
  assert.equal(apply.json.code, 'io')

  const rejectedStore = {
    async load() {
      return { kind: 'ok', doc: { ...sampleDoc(), revision: 1 }, revision: 1, exists: true }
    },
    async peek() {
      return { kind: 'ok', doc: { ...sampleDoc(), revision: 1 }, revision: 1, exists: true }
    },
    async commit() {
      return { kind: 'invalid', errors: ['commit-rejected'] }
    },
  }
  const rejected = await mountRoutes({ store: rejectedStore, connection: connection(), controlApiEnabled: true })
  t.after(rejected.cleanup)
  const rejectedOperations = [{ op: 'group.create', name: 'Rejected', parentId: null, index: 0 }]
  const rejectedApply = await rejected.call(
    CONTROL_APPLY_PATH,
    post({
      baseRevision: 1,
      operations: rejectedOperations,
      planHash: controlPlanHash(DEFAULT_PROFILE_ID, 1, rejectedOperations),
    }),
  )
  assert.equal(rejectedApply.res.statusCode, 422)
  assert.equal(rejectedApply.json.code, 'invalid')
  assert.match(rejectedApply.json.message, /commit-rejected/)

  const doctorFailure = await mountRoutes({
    connection: connection(),
    controlApiEnabled: true,
    doctorReport: async () => {
      throw new Error('doctor io')
    },
  })
  t.after(doctorFailure.cleanup)
  const doctor = await doctorFailure.call(CONTROL_DOCTOR_PATH, makeRequest({ headers }))
  assert.equal(doctor.res.statusCode, 503)
  assert.equal(doctor.json.code, 'doctor-failed')
  assert.match(doctor.json.message, /doctor io/)
})

// ---------------------------------------------------------------------------
// P7 (0.4.0-beta.62): group.archive, archive state and the 409/422 split (N6).
// ---------------------------------------------------------------------------

/** Root archived group plus a live root and a child inside the archived subtree. */
const archiveGuardDoc = () => ({
  version: 1,
  groups: [
    { id: 'g-arch', name: 'Archived', icon: 'folder', parentId: null, sessionIds: ['s-a'], archived: true },
    { id: 'g-live', name: 'Live', icon: 'folder', parentId: null, sessionIds: ['s-l'], archived: false },
    { id: 'g-child', name: 'Child', icon: 'folder', parentId: 'g-arch', sessionIds: [] },
  ],
  ungrouped: [],
})

test('control applies group.archive and state exposes own/inherited archive flags', async (t) => {
  const mounted = await mountRoutes({ connection: connection(), controlApiEnabled: true })
  t.after(() => mounted.cleanup())
  await mounted.store.save(sampleDoc())

  const operations = [{ op: 'group.archive', groupId: 'g-bbbbbbbbbbbb', archived: true }]
  const plan = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 1, operations }))
  assert.equal(plan.res.statusCode, 200)
  assert.deepEqual(plan.json.changes, [{ op: 'group.archive', groupId: 'g-bbbbbbbbbbbb', archived: true }])

  const applied = await mounted.call(
    CONTROL_APPLY_PATH,
    post({ baseRevision: 1, operations, planHash: plan.json.planHash }),
  )
  assert.equal(applied.res.statusCode, 200)
  assert.equal(applied.json.revision, 2)
  const appliedChild = applied.json.doc.groups.find((group) => group.id === 'g-bbbbbbbbbbbb')
  assert.equal(appliedChild.archived, true)
  assert.equal(applied.json.doc.groups.find((group) => group.id === 'g-aaaaaaaaaaaa').archived, false)

  const state = await mounted.call(CONTROL_STATE_PATH, makeRequest({ headers }))
  const byId = new Map(state.json.groups.map((group) => [group.id, group]))
  assert.deepEqual(
    {
      archived: byId.get('g-aaaaaaaaaaaa').archived,
      effectiveArchived: byId.get('g-aaaaaaaaaaaa').effectiveArchived,
      archivedBy: byId.get('g-aaaaaaaaaaaa').archivedBy,
    },
    { archived: false, effectiveArchived: false, archivedBy: null },
  )
  assert.deepEqual(
    {
      archived: byId.get('g-bbbbbbbbbbbb').archived,
      effectiveArchived: byId.get('g-bbbbbbbbbbbb').effectiveArchived,
      archivedBy: byId.get('g-bbbbbbbbbbbb').archivedBy,
    },
    { archived: true, effectiveArchived: true, archivedBy: 'g-bbbbbbbbbbbb' },
  )
  for (const group of state.json.groups) assert.equal('pathOnly' in group, false)

  const unarchive = [{ op: 'group.archive', groupId: 'g-bbbbbbbbbbbb', archived: false }]
  const unarchivePlan = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 2, operations: unarchive }))
  assert.equal(unarchivePlan.res.statusCode, 200)
  const unarchived = await mounted.call(
    CONTROL_APPLY_PATH,
    post({ baseRevision: 2, operations: unarchive, planHash: unarchivePlan.json.planHash }),
  )
  assert.equal(unarchived.res.statusCode, 200)
  assert.equal(unarchived.json.doc.groups.find((group) => group.id === 'g-bbbbbbbbbbbb').archived, false)
})

test('control plan/apply return 409 for archive conflicts and 422 for schema/invalid input', async (t) => {
  const mounted = await mountRoutes({
    connection: connection(),
    controlApiEnabled: true,
    controlDestructiveEnabled: true,
  })
  t.after(() => mounted.cleanup())
  await mounted.store.save(archiveGuardDoc())
  const planHashOf = (operations) => controlPlanHash(DEFAULT_PROFILE_ID, 1, operations)

  const conflicts = [
    [{ op: 'group.rename', groupId: 'g-arch', name: 'X' }, 'g-arch', 'groupId'],
    [{ op: 'group.rename', groupId: 'g-child', name: 'X' }, 'g-child', 'groupId'],
    [{ op: 'group.update', groupId: 'g-arch', icon: 'star' }, 'g-arch', 'groupId'],
    [{ op: 'group.create', name: 'New', parentId: 'g-arch' }, 'g-arch', 'parentId'],
    [{ op: 'group.move', groupId: 'g-live', parentId: 'g-arch' }, 'g-arch', 'parentId'],
    [{ op: 'group.delete', groupId: 'g-live', destinationId: 'g-arch' }, 'g-arch', 'destinationId'],
    [{ op: 'session.assign', sessionId: 's-a', groupId: 'g-live' }, 'g-arch', 'sessionId'],
  ]
  for (const [operation, groupId, field] of conflicts) {
    const planned = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 1, operations: [operation] }))
    assert.equal(planned.res.statusCode, 409, JSON.stringify(operation))
    assert.equal(planned.json.ok, false)
    assert.equal(planned.json.operationIndex, 0)
    if (groupId !== undefined) assert.equal(planned.json.groupId, groupId, JSON.stringify(operation))
    if (field !== undefined) assert.equal(planned.json.field, field, JSON.stringify(operation))
  }

  // A same-value archive is a semantically valid no-op, so it is 422 `no-change`
  // rather than an archive conflict (N12: doc-idempotent, not response-idempotent).
  const noChange = await mounted.call(
    CONTROL_PLAN_PATH,
    post({ baseRevision: 1, operations: [{ op: 'group.archive', groupId: 'g-arch', archived: true }] }),
  )
  assert.equal(noChange.res.statusCode, 422)
  assert.equal(noChange.json.code, 'no-change')

  // Apply follows the same split.
  const conflictOps = [{ op: 'group.rename', groupId: 'g-arch', name: 'X' }]
  const applyConflict = await mounted.call(
    CONTROL_APPLY_PATH,
    post({ baseRevision: 1, operations: conflictOps, planHash: planHashOf(conflictOps) }),
  )
  assert.equal(applyConflict.res.statusCode, 409)
  assert.equal(applyConflict.json.code, 'group-archived')
  assert.equal(applyConflict.json.groupId, 'g-arch')
  assert.equal(applyConflict.json.field, 'groupId')
  assert.equal(applyConflict.json.operationIndex, 0)

  const schemaFailures = [
    [[{ op: 'group.archive', groupId: 'g-live' }], 'invalid-operation', 'archived'],
    [[{ op: 'group.archive', groupId: 'g-live', archived: 'yes' }], 'invalid-operation', 'archived'],
    [[{ op: 'group.archive', groupId: 'g-live', archived: true, cascade: true }], 'invalid-operation', 'cascade'],
    [[{ op: 'group.update', groupId: 'g-live', archived: true }], 'invalid-operation', 'archived'],
    [[{ op: 'group.move', groupId: 'g-live', parentId: null, index: -1 }], 'invalid-operation', 'index'],
    [[{ op: 'raw.commit' }], 'unknown-operation', undefined],
    [[{ op: 'group.archive', groupId: 'g-missing', archived: true }], 'group-not-found', 'groupId'],
  ]
  for (const [operations, code, field] of schemaFailures) {
    const planned = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 1, operations }))
    assert.equal(planned.res.statusCode, 422, JSON.stringify(operations))
    assert.equal(planned.json.code, code)
    assert.equal(planned.json.operationIndex, 0)
    if (field !== undefined) assert.equal(planned.json.field, field, JSON.stringify(operations))
  }

  const applySchema = await mounted.call(
    CONTROL_APPLY_PATH,
    post({
      baseRevision: 1,
      operations: [{ op: 'group.update', groupId: 'g-live', archived: true }],
      planHash: planHashOf([{ op: 'group.update', groupId: 'g-live', archived: true }]),
    }),
  )
  assert.equal(applySchema.res.statusCode, 422)
  assert.equal(applySchema.json.code, 'invalid-operation')
  assert.equal(applySchema.json.field, 'archived')

  const loaded = await mounted.call(LOAD_PATH, makeRequest({ headers }))
  assert.equal(loaded.json.revision, 1, 'rejected plan/apply must not bump the revision')
})

test('control maps group-position-locked and group-contains-archived mutator errors to 409', async (t) => {
  const mounted = await mountRoutes({ connection: connection(), controlApiEnabled: true })
  t.after(() => mounted.cleanup())

  // A frozen root anchor: inserting before it shifts its sibling index.
  await mounted.store.save({
    version: 1,
    groups: [
      { id: 'g-anchor', name: 'Anchor', icon: 'folder', parentId: null, sessionIds: [], archived: true },
      { id: 'g-live', name: 'Live', icon: 'folder', parentId: null, sessionIds: [], archived: false },
    ],
    ungrouped: [],
  })
  const shiftOperations = [{ op: 'group.create', name: 'Front', parentId: null, index: 0 }]
  const shifted = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 1, operations: shiftOperations }))
  assert.equal(shifted.res.statusCode, 409)
  assert.equal(shifted.json.code, 'group-position-locked')
  assert.equal(shifted.json.groupId, 'g-anchor')
  assert.equal(shifted.json.field, 'index')
  assert.equal(shifted.json.operationIndex, 0)

  // An unarchived ancestor of a frozen child cannot be moved/removed.
  await mounted.store.save({
    version: 1,
    groups: [
      { id: 'g-wrap', name: 'Wrap', icon: 'folder', parentId: null, sessionIds: [], archived: false },
      { id: 'g-frozen-child', name: 'Frozen', icon: 'folder', parentId: 'g-wrap', sessionIds: [], archived: true },
      { id: 'g-target', name: 'Target', icon: 'folder', parentId: null, sessionIds: [], archived: false },
    ],
    ungrouped: [],
  })
  const containsOperations = [{ op: 'group.move', groupId: 'g-wrap', parentId: 'g-target' }]
  const contains = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 2, operations: containsOperations }))
  assert.equal(contains.res.statusCode, 409)
  assert.equal(contains.json.code, 'group-contains-archived')
  assert.equal(contains.json.groupId, 'g-wrap')
  assert.equal(contains.json.field, 'groupId')
  assert.equal(contains.json.operationIndex, 0)

  const loaded = await mounted.call(LOAD_PATH, makeRequest({ headers }))
  assert.equal(loaded.json.revision, 2, '409 conflicts must not bump the revision')
})

test('control apply maps an archive-frozen commit to 409 without wrapping changes', async (t) => {
  const published = []
  const changeHub = {
    publish: (...args) => published.push(args),
    publishActive: () => {},
    subscribe: () => () => {},
  }
  const doc = { ...sampleDoc(), revision: 1 }
  let commits = 0
  const store = {
    async load() {
      return { kind: 'ok', doc, revision: 1, exists: true }
    },
    async peek() {
      return { kind: 'ok', doc, revision: 1, exists: true }
    },
    async commit() {
      commits += 1
      return {
        kind: 'archive-frozen',
        code: 'group-archived',
        groupId: 'g-aaaaaaaaaaaa',
        field: 'name',
        message: 'group-archived',
      }
    },
  }
  const mounted = await mountRoutes({ store, connection: connection(), controlApiEnabled: true, changeHub })
  t.after(() => mounted.cleanup())

  // The plan passes: the race is detected only inside the host commit lock.
  const operations = [{ op: 'group.rename', groupId: 'g-bbbbbbbbbbbb', name: 'Renamed' }]
  const plan = await mounted.call(CONTROL_PLAN_PATH, post({ baseRevision: 1, operations }))
  assert.equal(plan.res.statusCode, 200)

  const body = {
    baseRevision: 1,
    operations,
    planHash: plan.json.planHash,
    idempotencyKey: 'archive-frozen-key',
  }
  const applied = await mounted.call(CONTROL_APPLY_PATH, post(body))
  assert.equal(applied.res.statusCode, 409)
  assert.deepEqual(
    {
      ok: applied.json.ok,
      code: applied.json.code,
      reason: applied.json.reason,
      groupId: applied.json.groupId,
      field: applied.json.field,
      message: applied.json.message,
    },
    {
      ok: false,
      code: 'archive-frozen',
      reason: 'group-archived',
      groupId: 'g-aaaaaaaaaaaa',
      field: 'name',
      message: 'group-archived',
    },
  )
  assert.equal('changes' in applied.json, false, 'archive-frozen must not be wrapped as a successful change set')
  assert.equal('revision' in applied.json, false)
  assert.equal('doc' in applied.json, false)
  assert.deepEqual(published, [], 'a rejected commit must not publish a revision change')

  // The failure is not cached as an idempotent success: the retry commits again.
  const retried = await mounted.call(CONTROL_APPLY_PATH, post(body))
  assert.equal(retried.res.statusCode, 409)
  assert.equal(commits, 2)
})

