import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createControlTool, TOOL_NAME } from '../../src/host/tool.js'
import { DEFAULT_PROFILE_ID, PROFILES_DIR_NAME, RECORD_FILE_NAME } from '../../src/host/constants.js'
import { controlPlanHash } from '../../src/host/route-contract.js'
import {
  FIXED_TIMESTAMP,
  PROFILE_ID,
  createTestProfileManager,
  makeTempProfileHome,
  sampleDefaultProfile,
  sampleDoc,
  sampleNamedProfile,
  sampleRegistry,
  writeJsonFile,
  writeProfileDoc,
} from './helpers.js'

const connectionlessServices = () => ({ get: () => null })

const namedGroups = () => sampleDoc().groups.map((group) => ({ ...group, name: `${group.name}-工作` }))

const mountProfileTool = async (t, options = {}) => {
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
  const notifications = []
  const tool = createControlTool({
    store: manager.storeFor(DEFAULT_PROFILE_ID),
    profileManager: manager,
    getService: connectionlessServices(),
    controlApiEnabled: () => options.controlApiEnabled?.() ?? true,
    controlSessionsEnabled: () => false,
    controlDestructiveEnabled: () => false,
    onCommit: (...args) => notifications.push(args),
    doctorReport: options.doctorReport,
  })
  return { home, manager, tool, notifications }
}


const setup = (overrides = {}) => {
  let doc = { ...sampleDoc(), revision: 2 }
  let revision = 2
  const notifications = []
  const session = { id: 's-current', title: 'old title' }
  const registry = {
    archivedSessionIds: [],
    async archiveSession(id, options) {
      assert.equal(id, 's-current')
      registry.lastOptions = options
      registry.archivedSessionIds = [id]
    },
    async unarchiveSession(id) {
      registry.archivedSessionIds = registry.archivedSessionIds.filter((value) => value !== id)
    },
  }
  const services = {
    sessions: { get: (id) => (id === 's-current' ? session : undefined) },
    sessionTitle: {
      get: (value) => ({ title: value.title }),
      rename: (value, title) => {
        value.title = title
        return { title }
      },
    },
    workspaceRegistry: registry,
  }
  const tool = createControlTool({
    store: {
      async load() {
        return { kind: 'ok', doc, revision }
      },
      async commit(baseRevision, next) {
        if (baseRevision !== revision) return { kind: 'conflict', doc, revision }
        revision += 1
        doc = next
        return { kind: 'ok', doc, revision }
      },
    },
    getService: (name) => services[name] ?? null,
    controlApiEnabled: () => true,
    controlSessionsEnabled: () => true,
    controlDestructiveEnabled: () => false,
    onCommit: (nextRevision, source) => notifications.push([nextRevision, source]),
    ...overrides,
  })
  return { tool, session, registry, notifications, getDoc: () => doc, getRevision: () => revision }
}

test('native tool exposes a raw registry-ready definition without HTTP', () => {
  const { tool } = setup()
  assert.equal(tool.name, TOOL_NAME)
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.required.includes('action'), true)
  assert.equal(tool.parameters.properties.action.enum.includes('doctor'), true)
  assert.equal(tool.parameters.properties.action.enum.includes('catalog'), true)
  assert.equal(typeof tool.execute, 'function')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(tool.output.render({}, { ok: true }).at(0).type, 'text')
})

test('native tool doctor returns the injected live compatibility report and can diagnose a closed control API', async () => {
  const report = {
    ok: true,
    protocol: 1,
    plugin: { version: 'test' },
    host: { compatibility: { supported: true, missing: [] } },
    gates: { controlApi: false, controlDestructive: false, controlSessions: false },
  }
  const { tool } = setup({ controlApiEnabled: () => false, doctorReport: async () => report })
  assert.deepEqual(await tool.execute({ action: 'doctor' }), report)

  const unavailable = setup()
  const missing = await unavailable.tool.execute({ action: 'doctor' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'doctor-unavailable')
})

test('native tool reads state and resolves full paths', async () => {
  const { tool } = setup()
  const state = await tool.execute({ action: 'state' })
  assert.equal(state.ok, true)
  assert.equal(state.revision, 2)
  assert.equal(state.groups.length, 2)

  const resolved = await tool.execute({ action: 'resolve', path: ['施工中', '子组'] })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.groupId, 'g-bbbbbbbbbbbb')
  assert.equal(resolved.revision, 2)
})

test('native tool catalog is read-only and includes icons, colors and operations', async () => {
  const { tool } = setup()
  const catalog = await tool.execute({ action: 'catalog' })
  assert.equal(catalog.ok, true)
  assert.equal(catalog.revision, undefined)
  assert.ok(catalog.icons.items.length > 70)
  assert.ok(catalog.colors.items.length >= 12)
  assert.equal(catalog.colors.formats.custom.canonical, '#rrggbb')
  assert.ok(catalog.operations.includes('session.assign'))
})

test('native tool plans and applies with CAS and stale-plan protection', async (t) => {
  const state = setup()
  const operations = [{ op: 'group.rename', groupId: 'g-aaaaaaaaaaaa', name: '改名' }]
  const plan = await state.tool.execute({ action: 'plan', baseRevision: 2, operations })
  assert.equal(plan.ok, true)
  assert.equal(typeof plan.planHash, 'string')

  const stale = await state.tool.execute({
    action: 'apply',
    baseRevision: 2,
    operations,
    planHash: 'not-the-plan',
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'stale-plan')

  const applied = await state.tool.execute({
    action: 'apply',
    baseRevision: 2,
    operations,
    planHash: plan.planHash,
  })
  assert.equal(applied.ok, true)
  assert.equal(applied.revision, 3)
  assert.equal(state.getDoc().groups[0].name, '改名')
  assert.deepEqual(state.notifications, [[3, 'native-tool']])

  const conflict = await state.tool.execute({
    action: 'apply',
    baseRevision: 2,
    operations,
    planHash: plan.planHash,
  })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'conflict')
})

test('native tool session actions require explicit sessionId', async () => {
  const state = setup()
  const inspected = await state.tool.execute({ action: 'session_inspect', sessionId: 's-current' })
  assert.equal(inspected.ok, true)
  assert.equal(inspected.title, 'old title')

  const missing = await state.tool.execute({ action: 'session_inspect' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'invalid-session-id')

  const renamed = await state.tool.execute({
    action: 'session_rename',
    sessionId: 's-current',
    title: 'new title',
    expectedTitle: 'old title',
  })
  assert.equal(renamed.ok, true)
  assert.equal(state.session.title, 'new title')

  const archived = await state.tool.execute({
    action: 'session_archive',
    sessionId: 's-current',
    archived: true,
    expectedArchived: false,
  })
  assert.equal(archived.ok, true)
  assert.deepEqual(state.registry.archivedSessionIds, ['s-current'])
})

test('native tool honors control switches', async () => {
  const disabled = setup({ controlApiEnabled: () => false })
  const state = await disabled.tool.execute({ action: 'state' })
  assert.equal(state.ok, false)
  assert.equal(state.code, 'control-disabled')

  const sessionsOff = setup({ controlSessionsEnabled: () => false })
  const session = await sessionsOff.tool.execute({ action: 'session_inspect', sessionId: 's-current' })
  assert.equal(session.ok, false)
  assert.equal(session.code, 'session-controls-disabled')
})

test('native tool rejects malformed actions and plan inputs without touching the store', async () => {
  const { tool } = setup()
  assert.equal((await tool.execute({ action: 'unknown' })).code, 'invalid-action')
  assert.equal((await tool.execute({ action: 'resolve' })).code, 'invalid-path')
  assert.equal((await tool.execute({ action: 'plan', baseRevision: -1, operations: [{ op: 'group.rename' }] })).code, 'invalid-revision')
  assert.equal((await tool.execute({ action: 'plan', baseRevision: 2, operations: [] })).code, 'operations-required')
  assert.equal((await tool.execute({ action: 'apply', baseRevision: 2, operations: [{ op: 'group.rename' }] })).code, 'stale-plan')
})

test('native tool returns unsupported-version and internal failures as structured errors', async () => {
  const unsupported = setup({
    store: { async load() { return { kind: 'unsupported-version', version: 9 } } },
  })
  const version = await unsupported.tool.execute({ action: 'state' })
  assert.equal(version.ok, false)
  assert.equal(version.code, 'unsupported-version')
  assert.equal(version.version, 9)

  const thrown = setup({
    store: { async load() { throw new Error('store exploded') } },
  })
  const internal = await thrown.tool.execute({ action: 'state' })
  assert.equal(internal.ok, false)
  assert.equal(internal.code, 'internal')
  assert.match(internal.message, /store exploded/)
})

test('native tool exposes archived, missing and title-failure inspect states', async () => {
  const state = setup()
  state.registry.archivedSessionIds = ['s-archived']
  const archived = await state.tool.execute({ action: 'session_inspect', sessionId: 's-archived' })
  assert.equal(archived.ok, true)
  assert.equal(archived.live, false)
  assert.equal(archived.archived, true)
  assert.equal(archived.title, null)

  const missing = await state.tool.execute({ action: 'session_inspect', sessionId: 'missing' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'session-not-found')

  const noServices = setup({ getService: (name) => (name === 'sessions' ? { get: () => null } : null) })
  const unavailable = await noServices.tool.execute({ action: 'session_inspect', sessionId: 's-current' })
  assert.equal(unavailable.code, 'service-unavailable')

  const titleFailure = setup({
    getService: (name) => (name === 'sessions' ? { get: () => ({ id: 's-current' }) } : name === 'sessionTitle' ? { get() { throw new Error('nope') } } : null),
  })
  const title = await titleFailure.tool.execute({ action: 'session_inspect', sessionId: 's-current' })
  assert.equal(title.ok, true)
  assert.equal(title.title, null)
})

test('native tool validates rename inputs, conflicts, no-op and failures', async () => {
  const state = setup()
  assert.equal((await state.tool.execute({ action: 'session_rename', sessionId: 's-current', title: '' })).code, 'invalid-title')
  assert.equal((await state.tool.execute({ action: 'session_rename', sessionId: 's-current', title: 'x', expectedTitle: 1 })).code, 'invalid-title')
  const mismatch = await state.tool.execute({ action: 'session_rename', sessionId: 's-current', title: 'x', expectedTitle: 'other' })
  assert.equal(mismatch.code, 'title-changed')
  assert.equal(mismatch.title, 'old title')
  const same = await state.tool.execute({ action: 'session_rename', sessionId: 's-current', title: 'old title' })
  assert.equal(same.ok, true)
  const failed = setup({
    getService: (name) => (name === 'sessions' ? { get: () => ({ id: 's-current', title: 'old' }) } : name === 'sessionTitle' ? { get: () => ({ title: 'old' }), rename() { throw new Error('rename failed') } } : null),
  })
  const failure = await failed.tool.execute({ action: 'session_rename', sessionId: 's-current', title: 'new' })
  assert.equal(failure.code, 'session-operation-failed')
  assert.match(failure.message, /rename failed/)
})

test('native tool validates archive inputs, conflicts, no-op and forwards stopActivity', async () => {
  const state = setup()
  assert.equal((await state.tool.execute({ action: 'session_archive', sessionId: 's-current', archived: 'yes' })).code, 'invalid-archived')
  assert.equal((await state.tool.execute({ action: 'session_archive', sessionId: 's-current', archived: true, expectedArchived: 'yes' })).code, 'invalid-archived')
  assert.equal((await state.tool.execute({ action: 'session_archive', sessionId: 's-current', archived: true, stopActivity: 'yes' })).code, 'invalid-stop-activity')
  assert.equal((await state.tool.execute({ action: 'session_archive', sessionId: 's-current', archived: true, expectedArchived: true })).code, 'archive-changed')
  assert.equal((await state.tool.execute({ action: 'session_archive', sessionId: 's-current', archived: false })).ok, true)
  state.registry.archivedSessionIds = ['s-current']
  assert.equal((await state.tool.execute({ action: 'session_archive', sessionId: 's-current', archived: false })).ok, true)
  assert.deepEqual(state.registry.archiveCalls, undefined)
  const archived = await state.tool.execute({ action: 'session_archive', sessionId: 's-current', archived: true, stopActivity: true })
  assert.equal(archived.ok, true)
  assert.deepEqual(state.registry.lastOptions, { stopActivity: true })
  const failed = setup({
    getService: (name) => (name === 'workspaceRegistry' ? {
      archivedSessionIds: [],
      archiveSession: async () => { throw new Error('archive failed') },
      unarchiveSession: async () => {},
    } : null),
  })
  const failure = await failed.tool.execute({ action: 'session_archive', sessionId: 's-current', archived: true })
  assert.equal(failure.code, 'session-operation-failed')
  assert.match(failure.message, /archive failed/)
})

test('native tool state and resolve default to the active profile and echo profileId/activeProfile', async (t) => {
  const { tool } = await mountProfileTool(t)
  const state = await tool.execute({ action: 'state' })
  assert.equal(state.ok, true)
  assert.equal(state.profileId, DEFAULT_PROFILE_ID)
  assert.deepEqual(state.activeProfile, { id: DEFAULT_PROFILE_ID, name: null })
  assert.equal(state.groups[0].name, '施工中')

  const named = await tool.execute({ action: 'state', profileId: PROFILE_ID })
  assert.equal(named.profileId, PROFILE_ID)
  assert.deepEqual(named.activeProfile, { id: DEFAULT_PROFILE_ID, name: null })
  assert.equal(named.groups[0].name, '施工中-工作')

  const resolved = await tool.execute({
    action: 'resolve',
    profileId: PROFILE_ID,
    path: ['施工中-工作', '子组-工作'],
  })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.profileId, PROFILE_ID)
  assert.deepEqual(resolved.activeProfile, { id: DEFAULT_PROFILE_ID, name: null })
  assert.equal(resolved.groupId, named.groups[1].id)
})

test('native tool requires profileId for plan/apply with multiple profiles and scopes planHash', async (t) => {
  const { tool, notifications } = await mountProfileTool(t)
  const operations = [{ op: 'group.create', name: 'AI', parentId: null, index: 0 }]

  const missing = await tool.execute({ action: 'plan', baseRevision: 2, operations })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'profile-required')
  const missingApply = await tool.execute({
    action: 'apply',
    baseRevision: 2,
    operations,
    planHash: 'x'.repeat(64),
  })
  assert.equal(missingApply.code, 'profile-required')

  const defaultPlan = await tool.execute({
    action: 'plan',
    profileId: DEFAULT_PROFILE_ID,
    baseRevision: 2,
    operations,
  })
  const namedPlan = await tool.execute({ action: 'plan', profileId: PROFILE_ID, baseRevision: 2, operations })
  assert.equal(defaultPlan.ok, true)
  assert.equal(namedPlan.ok, true)
  assert.equal(defaultPlan.profileId, DEFAULT_PROFILE_ID)
  assert.equal(namedPlan.profileId, PROFILE_ID)
  assert.equal(defaultPlan.planHash, controlPlanHash(DEFAULT_PROFILE_ID, 2, operations))
  assert.equal(namedPlan.planHash, controlPlanHash(PROFILE_ID, 2, operations))
  assert.notEqual(defaultPlan.planHash, namedPlan.planHash)

  const crossProfile = await tool.execute({
    action: 'apply',
    profileId: PROFILE_ID,
    baseRevision: 2,
    operations,
    planHash: defaultPlan.planHash,
  })
  assert.equal(crossProfile.code, 'stale-plan')

  // The named profile is not active; apply still targets it explicitly and
  // returns no document (unlike the HTTP control apply response).
  const applied = await tool.execute({
    action: 'apply',
    profileId: PROFILE_ID,
    baseRevision: 2,
    operations,
    planHash: namedPlan.planHash,
  })
  assert.equal(applied.ok, true)
  assert.equal(applied.profileId, PROFILE_ID)
  assert.equal(applied.revision, 3)
  assert.equal('doc' in applied, false)
  assert.deepEqual(notifications, [[3, 'native-tool', PROFILE_ID]])

  const namedState = await tool.execute({ action: 'state', profileId: PROFILE_ID })
  assert.equal(namedState.revision, 3)
  const activeState = await tool.execute({ action: 'state' })
  assert.equal(activeState.revision, 2)

  // No apply replay cache: the same apply is a normal CAS conflict.
  const replay = await tool.execute({
    action: 'apply',
    profileId: PROFILE_ID,
    baseRevision: 2,
    operations,
    planHash: namedPlan.planHash,
  })
  assert.equal(replay.ok, false)
  assert.equal(replay.code, 'conflict')
})

test('native tool has no activate/switch action', async (t) => {
  const { tool } = await mountProfileTool(t)
  assert.deepEqual(tool.parameters.properties.action.enum.includes('activate'), false)
  assert.deepEqual(tool.parameters.properties.action.enum.includes('switch'), false)
  assert.equal(tool.parameters.properties.profileId.type, 'string')
  const activate = await tool.execute({ action: 'activate', profileId: PROFILE_ID })
  assert.equal(activate.code, 'invalid-action')
})

test('native tool reports invalid, missing, archived, unhealthy and degraded profile targets', async (t) => {
  const { tool, home } = await mountProfileTool(t)
  const invalid = await tool.execute({ action: 'state', profileId: 'Bad_ID' })
  assert.equal(invalid.code, 'invalid-profile-id')
  const missing = await tool.execute({ action: 'state', profileId: 'p-unknown-123' })
  assert.equal(missing.code, 'profile-missing')
  assert.equal(missing.profileId, 'p-unknown-123')

  const archivedHome = await makeTempProfileHome()
  t.after(archivedHome.cleanup)
  await writeJsonFile(
    archivedHome.registryFilePath,
    sampleRegistry({
      revision: 1,
      profiles: [sampleDefaultProfile(), sampleNamedProfile({ archivedAt: FIXED_TIMESTAMP })],
    }),
  )
  await writeProfileDoc(archivedHome, DEFAULT_PROFILE_ID, { revision: 1 })
  const archivedManager = createTestProfileManager(archivedHome)
  const archived = createControlTool({
    store: archivedManager.storeFor(DEFAULT_PROFILE_ID),
    profileManager: archivedManager,
    getService: connectionlessServices(),
    controlApiEnabled: () => true,
    controlSessionsEnabled: () => false,
    controlDestructiveEnabled: () => false,
  })
  const archivedState = await archived.execute({ action: 'state', profileId: PROFILE_ID })
  assert.equal(archivedState.code, 'profile-archived')

  await writeJsonFile(join(home.storageDir, PROFILES_DIR_NAME, PROFILE_ID, RECORD_FILE_NAME), {
    version: 1,
    revision: 2,
    groups: 'not-an-array',
    ungrouped: [],
  })
  const unhealthy = await tool.execute({ action: 'state', profileId: PROFILE_ID })
  assert.equal(unhealthy.code, 'profile-unhealthy')
  assert.equal(unhealthy.profileId, PROFILE_ID)
  assert.equal(unhealthy.health.kind, 'invalid')

  const degradedHome = await makeTempProfileHome()
  t.after(degradedHome.cleanup)
  await writeProfileDoc(degradedHome, DEFAULT_PROFILE_ID, { revision: 1 })
  await writeFile(degradedHome.registryFilePath, '{ not-a-registry', 'utf8')
  const degradedManager = createTestProfileManager(degradedHome)
  const degraded = createControlTool({
    store: degradedManager.storeFor(DEFAULT_PROFILE_ID),
    profileManager: degradedManager,
    getService: connectionlessServices(),
    controlApiEnabled: () => true,
    controlSessionsEnabled: () => false,
    controlDestructiveEnabled: () => false,
  })
  const degradedState = await degraded.execute({ action: 'state' })
  assert.equal(degradedState.code, 'registry-unhealthy')
})

test('native tool keeps profileId optional with only the default profile', async (t) => {
  const { tool } = await mountProfileTool(t, {
    profiles: [sampleDefaultProfile()],
    defaultRevision: 1,
    writeNamed: false,
  })
  const operations = [{ op: 'group.create', name: 'Solo', parentId: null, index: 0 }]
  const plan = await tool.execute({ action: 'plan', baseRevision: 1, operations })
  assert.equal(plan.ok, true)
  assert.equal(plan.profileId, DEFAULT_PROFILE_ID)
  assert.equal(plan.planHash, controlPlanHash(DEFAULT_PROFILE_ID, 1, operations))
  const applied = await tool.execute({
    action: 'apply',
    baseRevision: 1,
    operations,
    planHash: plan.planHash,
  })
  assert.equal(applied.ok, true)
  assert.equal(applied.revision, 2)
})

test('native tool doctor reports the profile registry and document rows', async (t) => {
  const { home, tool } = await mountProfileTool(t, {
    controlApiEnabled: () => false,
    doctorReport: async () => ({ ok: true, protocol: 1, storage: { health: { status: 'ok' } } }),
  })
  const profileDir = join(home.storageDir, PROFILES_DIR_NAME, PROFILE_ID)
  await writeJsonFile(join(profileDir, `${RECORD_FILE_NAME.slice(0, -5)}.corrupt-2026-01-01.json`), { old: true })
  await writeJsonFile(join(profileDir, RECORD_FILE_NAME), {
    version: 1,
    revision: 2,
    groups: 'not-an-array',
    ungrouped: [],
  })

  const report = await tool.execute({ action: 'doctor' })
  assert.equal(report.ok, true)
  assert.equal(report.storage.health.status, 'ok')
  assert.equal(report.storage.registry.status, 'ok')
  assert.equal(report.storage.registry.activeId, DEFAULT_PROFILE_ID)
  assert.equal(report.storage.registry.profileCount, 2)
  const rows = new Map(report.storage.profiles.map((profile) => [profile.id, profile]))
  assert.equal(rows.get(DEFAULT_PROFILE_ID).healthy, true)
  assert.equal(rows.get(DEFAULT_PROFILE_ID).revision, 2)
  assert.equal(rows.get(DEFAULT_PROFILE_ID).backupStatus, 'missing')
  assert.equal(rows.get(PROFILE_ID).healthy, false)
  assert.equal(rows.get(PROFILE_ID).quarantined, 1)
  assert.match(rows.get(PROFILE_ID).quarantinedTo, /dsh-session-grove\.corrupt-\*\.json$/)
})
