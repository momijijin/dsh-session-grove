import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CONTROL_APPLY_PATH,
  CONTROL_CATALOG_PATH,
  CONTROL_DOCTOR_PATH,
  CONTROL_PLAN_PATH,
  CONTROL_RESOLVE_PATH,
  CONTROL_STATE_PATH,
  DEFAULT_PROFILE_ID,
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
