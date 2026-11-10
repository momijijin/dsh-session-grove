import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DEFAULT_PROFILE_ID,
  MAX_PROFILES,
  PROFILES_DIR_NAME,
  RECORD_FILE_NAME,
  REGISTRY_FILE_NAME,
} from '../../src/host/constants.js'
import { createProfileManager } from '../../src/host/profile-manager.js'
import { createProfileRegistry, isProfileId, validateRegistry } from '../../src/host/profile-registry.js'
import {
  FIXED_TIMESTAMP,
  PROFILE_ID,
  makeTempProfileHome,
  sampleDefaultProfile,
  sampleNamedProfile,
  sampleRegistry,
  writeJsonFile,
  writeProfileDoc,
} from './helpers.js'

/** Registry mutations run at a different instant than the fixtures' createdAt. */
const NOW_MS = Date.parse('2026-11-10T00:00:00.000Z')

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')
const list = async (dir) => (await readdir(dir)).sort()

const makeRegistry = (home, options = {}) =>
  createProfileRegistry({ filePath: home.registryFilePath, now: () => NOW_MS, ...options })

/** default + `count` unarchived named profiles, optionally plus archived ones. */
const limitProfiles = (count, { archived = 0, offset = 0 } = {}) => {
  const profiles = [sampleDefaultProfile()]
  for (let index = 0; index < count + archived; index += 1) {
    const id = `p-limit-${String(offset + index).padStart(4, '0')}`
    profiles.push(
      sampleNamedProfile({
        id,
        name: `Profile ${String(offset + index)}`,
        dir: `${PROFILES_DIR_NAME}/${id}`,
        ...(index >= count ? { archivedAt: FIXED_TIMESTAMP } : {}),
      }),
    )
  }
  return profiles
}

test('a missing registry synthesizes the default profile in memory without writing', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const registry = makeRegistry(home)

  const peeked = await registry.peek()
  assert.equal(peeked.kind, 'missing')
  assert.equal(peeked.exists, false)

  const state = await registry.load()
  assert.equal(state.kind, 'ok')
  assert.equal(state.degraded, false)
  assert.equal(state.exists, false)
  assert.equal(state.revision, 0)
  assert.equal(state.registry.version, 1)
  assert.equal(state.registry.activeId, DEFAULT_PROFILE_ID)
  assert.equal(state.registry.profiles.length, 1)
  const [entry] = state.registry.profiles
  assert.equal(entry.id, DEFAULT_PROFILE_ID)
  assert.equal(entry.name, null)
  assert.equal(entry.dir, '.')
  assert.equal(entry.archivedAt, null)
  assert.deepEqual(await list(home.storageDir), [])
})

test('the first create writes registry revision 1 with the caller-supplied profile id', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const registry = makeRegistry(home)
  const id = 'p-work-0001'

  const result = await registry.createProfile({ baseRevision: 0, id, name: '  工作项目  ' })
  assert.equal(result.kind, 'ok')
  assert.equal(result.revision, 1)
  assert.equal(result.registry.profiles.length, 2)
  const created = result.registry.profiles[1]
  assert.equal(created.id, id)
  assert.equal(isProfileId(created.id), true)
  assert.equal(created.name, '工作项目')
  assert.equal(created.dir, `${PROFILES_DIR_NAME}/${id}`)
  assert.equal(created.archivedAt, null)
  assert.equal(result.registry.activeId, id)
  assert.equal(result.registry.profiles[0].id, DEFAULT_PROFILE_ID)

  const onDisk = JSON.parse(await readFile(home.registryFilePath, 'utf8'))
  assert.deepEqual(onDisk, result.registry)
  assert.deepEqual(await list(home.storageDir), [REGISTRY_FILE_NAME])
  assert.equal(existsSync(home.profilesDir), false)
})

test('createProfile requires a caller-supplied id and rejects invalid or registered ids', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({
      revision: 2,
      profiles: [sampleDefaultProfile(), sampleNamedProfile({ id: PROFILE_ID, name: 'Work' })],
    }),
  )
  const registry = makeRegistry(home)
  const before = await sha256(home.registryFilePath)

  for (const id of [undefined, null, '', 'Bad-ID', '../evil', DEFAULT_PROFILE_ID, PROFILE_ID]) {
    const rejected = await registry.createProfile({ baseRevision: 2, id, name: 'Fresh' })
    assert.equal(rejected.kind, 'invalid-profile-id', `id ${String(id)}`)
  }
  assert.equal(await sha256(home.registryFilePath), before)
})

test('a stale baseRevision returns conflict and never overwrites the registry', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const registry = makeRegistry(home)
  const first = await registry.createProfile({ baseRevision: 0, id: 'p-work-0001', name: 'Work' })
  assert.equal(first.kind, 'ok')
  const before = await sha256(home.registryFilePath)

  const stale = await registry.createProfile({ baseRevision: 0, id: 'p-other-0001', name: 'Other' })
  assert.equal(stale.kind, 'conflict')
  assert.equal(stale.revision, 1)
  assert.equal(stale.registry.revision, 1)
  assert.equal(stale.registry.profiles.length, 2)
  assert.equal(await sha256(home.registryFilePath), before)
})

test('atomic writes keep the previous registry in .bak and leave no temp/lock files', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const registry = makeRegistry(home)

  const first = await registry.createProfile({ baseRevision: 0, id: 'p-work-0001', name: 'Work' })
  const id = first.registry.activeId
  const second = await registry.renameProfile({ baseRevision: 1, id, name: 'Work 2' })
  assert.equal(second.kind, 'ok')
  assert.equal(second.revision, 2)

  const backup = JSON.parse(await readFile(`${home.registryFilePath}.bak`, 'utf8'))
  assert.equal(backup.revision, 1)
  assert.equal(backup.profiles[1].name, 'Work')
  assert.equal(JSON.parse(await readFile(home.registryFilePath, 'utf8')).revision, 2)
  const files = await list(home.storageDir)
  assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), [])
  assert.deepEqual(files.filter((name) => name.endsWith('.lock')), [])
  assert.equal(files.includes('dsh-session-grove.profiles.json.bak'), true)
})

test('a stale lock is reclaimed automatically', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const lockPath = `${home.registryFilePath}.lock`
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'stale' }), 'utf8')
  const old = new Date(Date.now() - 60_000)
  await utimes(lockPath, old, old)
  const registry = makeRegistry(home, { lockStaleMs: 50, lockWaitMs: 500 })

  const result = await registry.createProfile({ baseRevision: 0, id: 'p-lock-0001', name: 'Locked' })
  assert.equal(result.kind, 'ok')
  assert.equal(result.revision, 1)
  assert.equal(existsSync(lockPath), false)
})

test('a fresh live lock times out with the stable store-busy code', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const lockPath = `${home.registryFilePath}.lock`
  await writeFile(
    lockPath,
    JSON.stringify({ pid: process.pid, token: 'live', createdAt: new Date().toISOString() }),
    'utf8',
  )
  const registry = makeRegistry(home, { lockWaitMs: 40, lockRetryMs: 5 })

  await assert.rejects(
    () => registry.createProfile({ baseRevision: 0, id: 'p-blocked-0001', name: 'Blocked' }),
    (error) => error?.code === 'store-busy',
  )
  assert.equal(existsSync(home.registryFilePath), false)
  assert.equal(existsSync(lockPath), true)
})

test('a valid live registry wins over a stale .bak (backup is recovery-only)', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(home.registryFilePath, sampleRegistry({ revision: 5 }))
  await writeJsonFile(`${home.registryFilePath}.bak`, sampleRegistry({ revision: 2 }))
  const registry = makeRegistry(home)

  const state = await registry.load()
  assert.equal(state.kind, 'ok')
  assert.equal(state.exists, true)
  assert.equal(state.revision, 5)
  assert.equal(state.warning, undefined)
})

test('a corrupt registry recovers a valid .bak and quarantines the corrupt file', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(home.registryFilePath, sampleRegistry({ revision: 2 }))
  await writeJsonFile(`${home.registryFilePath}.bak`, sampleRegistry({ revision: 1 }))
  const garbage = '{broken'
  await writeFile(home.registryFilePath, garbage, 'utf8')
  const registry = makeRegistry(home)

  const state = await registry.load()
  assert.equal(state.kind, 'ok')
  assert.equal(state.degraded, false)
  assert.equal(state.warning, 'recovered-backup')
  assert.equal(state.revision, 1)
  assert.equal(state.registry.activeId, DEFAULT_PROFILE_ID)
  assert.match(state.quarantinedTo, /dsh-session-grove\.profiles\.corrupt-.*\.json$/)
  assert.equal(await readFile(state.quarantinedTo, 'utf8'), garbage)
  assert.equal(JSON.parse(await readFile(home.registryFilePath, 'utf8')).revision, 1)
  assert.equal(JSON.parse(await readFile(`${home.registryFilePath}.bak`, 'utf8')).revision, 1)
})

test('a corrupt registry without a usable backup degrades and rejects writes', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeFile(home.registryFilePath, '{broken', 'utf8')
  const registry = makeRegistry(home)

  const state = await registry.load()
  assert.equal(state.kind, 'ok')
  assert.equal(state.degraded, true)
  assert.equal(state.warning, 'corrupt-file')
  assert.equal(state.revision, 0)
  assert.equal(state.registry.profiles[0].id, DEFAULT_PROFILE_ID)
  assert.match(state.quarantinedTo, /dsh-session-grove\.profiles\.corrupt-.*\.json$/)
  assert.equal(existsSync(home.registryFilePath), false)

  let mutated = false
  const rejected = await registry.commit(0, () => {
    mutated = true
    return { ok: true }
  })
  assert.equal(rejected.kind, 'registry-unhealthy')
  assert.equal(mutated, false)
  assert.equal(existsSync(home.registryFilePath), false)

  const again = await registry.load()
  assert.equal(again.degraded, true)
  assert.equal(again.warning, 'corrupt-file')
})

test('a corrupt registry with a corrupt backup preserves both copies and reports backupError', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeFile(home.registryFilePath, '{broken', 'utf8')
  await writeFile(`${home.registryFilePath}.bak`, '{also-broken', 'utf8')
  const registry = makeRegistry(home)

  const state = await registry.load()
  assert.equal(state.degraded, true)
  assert.equal(state.warning, 'corrupt-file')
  assert.match(state.backupError, /JSON/)
  assert.equal(await readFile(`${home.registryFilePath}.bak`, 'utf8'), '{also-broken')
  assert.equal(await readFile(state.quarantinedTo, 'utf8'), '{broken')
})

test('an unsupported registry version degrades after preserving the file', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const future = JSON.stringify({ version: 2, revision: 7, activeId: DEFAULT_PROFILE_ID, profiles: [] })
  await writeFile(home.registryFilePath, future, 'utf8')
  const registry = makeRegistry(home)

  const state = await registry.load()
  assert.equal(state.degraded, true)
  assert.equal(state.warning, 'unsupported-version')
  assert.match(state.detail, /newer than 1/)
  assert.equal(await readFile(state.quarantinedTo, 'utf8'), future)
  assert.equal(existsSync(home.registryFilePath), false)
})

test('an invalid registry (dangling or archived active) degrades instead of being trusted', async (t) => {
  const archivedActive = sampleRegistry({
    activeId: PROFILE_ID,
    profiles: [sampleDefaultProfile(), sampleNamedProfile({ archivedAt: FIXED_TIMESTAMP })],
  })
  const archivedVerdict = validateRegistry(archivedActive)
  assert.equal(archivedVerdict.ok, false)
  assert.match(archivedVerdict.errors.join('; '), /active-profile-archived/)

  const danglingActive = sampleRegistry({ activeId: 'p-000000-0000' })
  const danglingVerdict = validateRegistry(danglingActive)
  assert.equal(danglingVerdict.ok, false)
  assert.match(danglingVerdict.errors.join('; '), /active-profile-missing/)

  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(home.registryFilePath, archivedActive)
  const registry = makeRegistry(home)
  const state = await registry.load()
  assert.equal(state.degraded, true)
  assert.equal(state.warning, 'invalid-file')
  assert.match(state.detail, /active-profile-archived/)
  assert.match(state.quarantinedTo, /dsh-session-grove\.profiles\.corrupt-.*\.json$/)
})

test('registry peek() is read-only and never quarantines', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const garbage = '{broken'
  await writeFile(home.registryFilePath, garbage, 'utf8')
  const beforeHash = await sha256(home.registryFilePath)
  const beforeMtime = (await stat(home.registryFilePath)).mtimeMs
  const registry = makeRegistry(home)

  const peeked = await registry.peek()
  assert.equal(peeked.kind, 'corrupt')
  assert.match(peeked.detail, /JSON/)
  assert.equal(await sha256(home.registryFilePath), beforeHash)
  assert.equal((await stat(home.registryFilePath)).mtimeMs, beforeMtime)
  assert.deepEqual(await list(home.storageDir), [REGISTRY_FILE_NAME])

  const state = await registry.load()
  assert.equal(state.degraded, true)
  const quarantined = (await list(home.storageDir)).filter((name) => name.includes('.corrupt-'))
  assert.equal(quarantined.length, 1)
})

test('the 20-profile limit blocks create and is enforced by the validator', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(home.registryFilePath, sampleRegistry({ revision: 3, profiles: limitProfiles(19) }))
  const registry = makeRegistry(home)
  const before = await sha256(home.registryFilePath)

  const blocked = await registry.createProfile({ baseRevision: 3, id: 'p-limit-9999', name: 'One more' })
  assert.equal(blocked.kind, 'profile-limit')
  assert.equal(blocked.revision, 3)
  assert.equal(await sha256(home.registryFilePath), before)

  const overLimit = validateRegistry(sampleRegistry({ profiles: limitProfiles(MAX_PROFILES) }))
  assert.equal(overLimit.ok, false)
  assert.match(overLimit.errors.join('; '), /profile-limit/)
})

test('archived profiles do not count toward the limit and their names can be reused', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(home.registryFilePath, sampleRegistry({ revision: 4, profiles: limitProfiles(18, { archived: 1 }) }))
  const registry = makeRegistry(home)

  const created = await registry.createProfile({ baseRevision: 4, id: 'p-limit-0019', name: 'Profile 18' })
  assert.equal(created.kind, 'ok')
  assert.equal(created.revision, 5)
  assert.equal(created.registry.profiles.filter((profile) => profile.archivedAt === null).length, MAX_PROFILES)
})

test('invalid and duplicate names are rejected without a write', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({ revision: 5, profiles: [sampleDefaultProfile(), sampleNamedProfile({ name: 'Work' })] }),
  )
  const registry = makeRegistry(home)
  const before = await sha256(home.registryFilePath)

  for (const name of ['', '   ', 'x'.repeat(41), 'bad\u0001name', null, 42]) {
    const rejected = await registry.createProfile({ baseRevision: 5, id: 'p-name-0001', name })
    assert.equal(rejected.kind, 'profile-name-invalid', `name ${JSON.stringify(name)}`)
  }
  const duplicate = await registry.createProfile({ baseRevision: 5, id: 'p-name-0002', name: 'work' })
  assert.equal(duplicate.kind, 'profile-name-duplicate')
  const renamed = await registry.renameProfile({ baseRevision: 5, id: DEFAULT_PROFILE_ID, name: 'WORK' })
  assert.equal(renamed.kind, 'profile-name-duplicate')
  assert.equal(await sha256(home.registryFilePath), before)
})

test('the default profile can be renamed', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(home.registryFilePath, sampleRegistry({ revision: 1 }))
  const registry = makeRegistry(home)

  const renamed = await registry.renameProfile({ baseRevision: 1, id: DEFAULT_PROFILE_ID, name: ' Personal ' })
  assert.equal(renamed.kind, 'ok')
  assert.equal(renamed.revision, 2)
  const entry = renamed.registry.profiles.find((profile) => profile.id === DEFAULT_PROFILE_ID)
  assert.equal(entry.name, 'Personal')
  assert.notEqual(entry.updatedAt, FIXED_TIMESTAMP)
})

test('the generated id stays inside profiles/<id> and invalid dirs are rejected', () => {
  const badDir = sampleRegistry({
    profiles: [sampleDefaultProfile(), sampleNamedProfile({ dir: `${PROFILES_DIR_NAME}/other` })],
  })
  const dirVerdict = validateRegistry(badDir)
  assert.equal(dirVerdict.ok, false)
  assert.match(dirVerdict.errors.join('; '), /profile-dir:/)

  const badId = sampleRegistry({
    profiles: [sampleDefaultProfile(), sampleNamedProfile({ id: '../evil', dir: '../evil' })],
  })
  const idVerdict = validateRegistry(badId)
  assert.equal(idVerdict.ok, false)
  assert.match(idVerdict.errors.join('; '), /profile-id:/)

  const uppercase = sampleRegistry({
    profiles: [sampleDefaultProfile(), sampleNamedProfile({ id: 'P-UPPER', dir: `${PROFILES_DIR_NAME}/P-UPPER` })],
  })
  assert.equal(validateRegistry(uppercase).ok, false)

  const duplicate = sampleRegistry({
    profiles: [sampleDefaultProfile(), sampleDefaultProfile({ name: 'dup' })],
  })
  const duplicateVerdict = validateRegistry(duplicate)
  assert.equal(duplicateVerdict.ok, false)
  assert.match(duplicateVerdict.errors.join('; '), /duplicate-profile-id:default/)
})

test('archive writes only archivedAt and refuses default, active, and archived targets', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({
      revision: 2,
      profiles: [sampleDefaultProfile(), sampleNamedProfile({ id: PROFILE_ID, name: 'Work' })],
    }),
  )
  const registry = makeRegistry(home)

  const defaultTarget = await registry.archiveProfile({ baseRevision: 2, id: DEFAULT_PROFILE_ID })
  assert.equal(defaultTarget.kind, 'profile-in-use')

  const archived = await registry.archiveProfile({ baseRevision: 2, id: PROFILE_ID })
  assert.equal(archived.kind, 'ok')
  assert.equal(archived.revision, 3)
  const entry = archived.registry.profiles.find((profile) => profile.id === PROFILE_ID)
  assert.equal(entry.archivedAt, new Date(NOW_MS).toISOString())
  assert.equal(entry.updatedAt, FIXED_TIMESTAMP)
  assert.equal(entry.name, 'Work')

  const again = await registry.archiveProfile({ baseRevision: 3, id: PROFILE_ID })
  assert.equal(again.kind, 'profile-archived')
  const missing = await registry.archiveProfile({ baseRevision: 3, id: 'p-000000-0000' })
  assert.equal(missing.kind, 'profile-missing')

  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({
      revision: 4,
      activeId: PROFILE_ID,
      profiles: [sampleDefaultProfile(), sampleNamedProfile({ id: PROFILE_ID })],
    }),
  )
  const activeTarget = await makeRegistry(home).archiveProfile({ baseRevision: 4, id: PROFILE_ID })
  assert.equal(activeTarget.kind, 'profile-in-use')
})

test('activate moves the pointer, validates staleness, and rejects archived targets', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({
      revision: 2,
      profiles: [
        sampleDefaultProfile(),
        sampleNamedProfile({ id: PROFILE_ID, name: 'Work' }),
        sampleNamedProfile({
          id: 'p-archive-0001',
          name: 'Old',
          dir: `${PROFILES_DIR_NAME}/p-archive-0001`,
          archivedAt: FIXED_TIMESTAMP,
        }),
      ],
    }),
  )
  const registry = makeRegistry(home)

  const stale = await registry.activateProfile({ id: PROFILE_ID, expectedRegistryRevision: 1 })
  assert.equal(stale.kind, 'preview-stale')
  assert.equal(stale.revision, 2)

  const activated = await registry.activateProfile({ id: PROFILE_ID, expectedRegistryRevision: 2 })
  assert.equal(activated.kind, 'ok')
  assert.equal(activated.revision, 3)
  assert.equal(activated.registry.activeId, PROFILE_ID)

  const archivedTarget = await registry.activateProfile({ id: 'p-archive-0001' })
  assert.equal(archivedTarget.kind, 'profile-archived')
  const missing = await registry.activateProfile({ id: 'p-000000-0000' })
  assert.equal(missing.kind, 'profile-missing')
  const invalid = await registry.activateProfile({ id: '../evil' })
  assert.equal(invalid.kind, 'invalid-profile-id')
})

test('a degraded registry rejects activate and rename', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeFile(home.registryFilePath, '{broken', 'utf8')
  const registry = makeRegistry(home)
  assert.equal((await registry.load()).degraded, true)

  assert.equal((await registry.activateProfile({ id: DEFAULT_PROFILE_ID })).kind, 'registry-unhealthy')
  assert.equal((await registry.renameProfile({ baseRevision: 0, id: DEFAULT_PROFILE_ID, name: 'x' })).kind, 'registry-unhealthy')
  assert.equal(existsSync(home.registryFilePath), false)
})

test('the profile manager resolves default/named paths and caches store identity', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const manager = createProfileManager({ storageDir: home.storageDir, now: () => NOW_MS })

  assert.equal(manager.storageDir, home.storageDir)
  assert.equal(manager.defaultFilePath, home.defaultFilePath)
  assert.equal(manager.registryFilePath, home.registryFilePath)
  assert.equal(manager.profilesDir, home.profilesDir)
  assert.equal(manager.pathFor(DEFAULT_PROFILE_ID), home.defaultFilePath)
  assert.equal(manager.pathFor(PROFILE_ID), join(home.profilesDir, PROFILE_ID, RECORD_FILE_NAME))

  const defaultStore = manager.storeFor(DEFAULT_PROFILE_ID)
  const namedStore = manager.storeFor(PROFILE_ID)
  assert.equal(manager.storeFor(DEFAULT_PROFILE_ID), defaultStore)
  assert.equal(manager.storeFor(PROFILE_ID), namedStore)
  assert.notEqual(defaultStore, namedStore)
  assert.equal(defaultStore.path, home.defaultFilePath)
  assert.equal(namedStore.path, join(home.profilesDir, PROFILE_ID, RECORD_FILE_NAME))

  assert.deepEqual(await list(home.storageDir), [])
  assert.equal(existsSync(home.profilesDir), false)
})

test('the profile manager resolves the active profile and peeks health read-only', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const manager = createProfileManager({ storageDir: home.storageDir, now: () => NOW_MS })

  assert.equal(await manager.activeId(), DEFAULT_PROFILE_ID)
  assert.equal((await manager.activeStore()).path, home.defaultFilePath)
  assert.equal((await manager.peekFor(PROFILE_ID)).kind, 'missing')
  assert.equal((await manager.peekFor(DEFAULT_PROFILE_ID)).kind, 'missing')
  assert.equal(await manager.entryFor(PROFILE_ID), null)

  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({
      revision: 3,
      activeId: PROFILE_ID,
      profiles: [sampleDefaultProfile(), sampleNamedProfile()],
    }),
  )
  assert.equal(await manager.activeId(), PROFILE_ID)
  assert.equal((await manager.activeStore()).path, join(home.profilesDir, PROFILE_ID, RECORD_FILE_NAME))
  assert.equal((await manager.entryFor(PROFILE_ID)).name, '工作项目')
  assert.equal(await manager.entryFor('p-000000-0000'), null)

  await writeProfileDoc(home, PROFILE_ID, { revision: 7 })
  const peeked = await manager.peekFor(PROFILE_ID)
  assert.equal(peeked.kind, 'ok')
  assert.equal(peeked.revision, 7)
  assert.equal((await manager.peekRegistry()).kind, 'ok')
})

test('the profile manager rejects ids that are malformed or escape storages', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const manager = createProfileManager({ storageDir: home.storageDir })

  for (const id of ['', 'Bad-ID', 'p_1234', '../evil', 'profiles/x', 'p-', 'a'.repeat(65), undefined]) {
    assert.throws(() => manager.storeFor(id), (error) => error?.code === 'invalid-profile-id', String(id))
    assert.throws(() => manager.pathFor(id), (error) => error?.code === 'invalid-profile-id', String(id))
  }
})

test('the profile manager reports orphan profile directories read-only', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const manager = createProfileManager({ storageDir: home.storageDir })
  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({ revision: 1, profiles: [sampleDefaultProfile(), sampleNamedProfile()] }),
  )
  await writeProfileDoc(home, 'p-orphan-0001')
  await mkdir(join(home.profilesDir, 'Not-A-Profile'), { recursive: true })
  const before = await list(home.storageDir)

  assert.deepEqual(await manager.orphans(), ['p-orphan-0001'])
  assert.deepEqual(await list(home.storageDir), before)
  assert.equal(existsSync(`${home.registryFilePath}.bak`), false)
})

test('newProfileId allocates a formatted id repeatedly without writing to disk', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const manager = createProfileManager({ storageDir: home.storageDir, now: () => NOW_MS })

  const first = await manager.newProfileId()
  const second = await manager.newProfileId()
  assert.match(first, /^p-[0-9a-z]+-[0-9a-f]{4}$/)
  assert.equal(first.startsWith(`p-${NOW_MS.toString(36)}-`), true)
  assert.equal(isProfileId(first), true)
  assert.notEqual(first, second)
  assert.deepEqual(await list(home.storageDir), [])
  assert.equal(existsSync(home.profilesDir), false)
})

test('newProfileId skips invalid, registered, and on-disk ids', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({
      revision: 1,
      profiles: [sampleDefaultProfile(), sampleNamedProfile({ id: 'p-taken-0001', name: 'Taken' })],
    }),
  )
  await mkdir(join(home.profilesDir, 'p-orphan-0002'), { recursive: true })
  const candidates = ['Bad-ID', 'p-taken-0001', 'p-orphan-0002', 'p-free-0003']
  const manager = createProfileManager({
    storageDir: home.storageDir,
    now: () => NOW_MS,
    profileIdFactory: () => candidates.shift() ?? 'p-fallback-0009',
  })

  assert.equal(await manager.newProfileId(), 'p-free-0003')
  assert.deepEqual(await manager.orphans(), ['p-orphan-0002'])
})

test('newProfileId gives up with a stable error after bounded retries', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({
      revision: 1,
      profiles: [sampleDefaultProfile(), sampleNamedProfile({ id: 'p-taken-0001', name: 'Taken' })],
    }),
  )
  let calls = 0
  const manager = createProfileManager({
    storageDir: home.storageDir,
    now: () => NOW_MS,
    profileIdFactory: () => {
      calls += 1
      return 'p-taken-0001'
    },
  })

  await assert.rejects(
    () => manager.newProfileId(),
    (error) => error?.code === 'profile-id-unavailable',
  )
  assert.equal(calls > 1, true)
})

test('doc-first create writes the document before the registry CAS activates the id', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const manager = createProfileManager({ storageDir: home.storageDir, now: () => NOW_MS })
  const id = await manager.newProfileId()

  await writeProfileDoc(home, id)
  assert.equal(existsSync(manager.pathFor(id)), true)

  const created = await manager.registry.createProfile({ baseRevision: 0, id, name: 'Doc first' })
  assert.equal(created.kind, 'ok')
  assert.equal(created.registry.activeId, id)
  const entry = created.registry.profiles.find((profile) => profile.id === id)
  assert.equal(entry.dir, `${PROFILES_DIR_NAME}/${id}`)
  assert.equal(await manager.activeId(), id)
  assert.equal((await manager.peekFor(id)).kind, 'ok')
  assert.deepEqual(await manager.orphans(), [])
})

test('a registry CAS failure after the document write leaves an orphan and keeps the active profile', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(home.registryFilePath, sampleRegistry({ revision: 1 }))
  const manager = createProfileManager({ storageDir: home.storageDir, now: () => NOW_MS })
  const id = await manager.newProfileId()

  await writeProfileDoc(home, id)
  const failed = await manager.registry.createProfile({ baseRevision: 0, id, name: 'Orphan' })
  assert.equal(failed.kind, 'conflict')
  assert.equal(failed.revision, 1)
  assert.equal(await manager.activeId(), DEFAULT_PROFILE_ID)
  assert.equal(existsSync(manager.pathFor(id)), true)
  assert.deepEqual(await manager.orphans(), [id])
})

test('the profile manager accepts custom registry and default record paths', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const registryFilePath = join(home.dir, 'custom', 'registry.json')
  const defaultRecordPath = join(home.dir, 'custom', 'record.json')
  const manager = createProfileManager({ storageDir: home.storageDir, registryFilePath, defaultRecordPath })

  assert.equal(manager.registryFilePath, registryFilePath)
  assert.equal(manager.defaultFilePath, defaultRecordPath)
  assert.equal(manager.pathFor(DEFAULT_PROFILE_ID), defaultRecordPath)
  assert.equal(manager.storeFor(DEFAULT_PROFILE_ID).path, defaultRecordPath)
})

// ---------------------------------------------------------------------------
// T3.4 boundary tests (SPEC §8.2): remaining registry corruption/degradation
// branches. No implementation changes.
// ---------------------------------------------------------------------------

test('T3.4: createProfileRegistry requires an explicit registry file path', () => {
  assert.throws(() => createProfileRegistry(), /createProfileRegistry: pass \{ filePath \}/)
})

test('T3.4: validateRegistry rejects every frozen-schema invariant', () => {
  const defaultProfile = (overrides) => sampleDefaultProfile(overrides)
  const named = (overrides = {}) => sampleNamedProfile(overrides)
  const errorsOf = (registry) => validateRegistry(registry).errors.join('; ')
  const base = () => sampleRegistry({ revision: 1 })

  assert.equal(validateRegistry(42).ok, false)
  assert.match(errorsOf(42), /registry-not-object/)
  assert.match(errorsOf({ ...base(), version: 2 }), /version/)
  assert.match(errorsOf({ ...base(), revision: -1 }), /revision/)
  assert.match(errorsOf({ ...base(), activeId: '' }), /active-id/)
  assert.match(errorsOf({ ...base(), profiles: {} }), /profiles/)
  assert.match(errorsOf({ ...base(), profiles: [null] }), /profile-not-object/)
  assert.match(errorsOf({ ...base(), profiles: [defaultProfile(), named({ id: 'BAD' })] }), /profile-id:BAD/)
  assert.match(
    errorsOf({ ...base(), profiles: [defaultProfile(), named(), named()] }),
    /duplicate-profile-id/,
  )
  assert.match(errorsOf({ ...base(), profiles: [defaultProfile({ dir: 'wrong' })] }), /profile-dir:default/)
  assert.match(
    errorsOf({ ...base(), profiles: [defaultProfile({ archivedAt: FIXED_TIMESTAMP })] }),
    /profile-archived:default/,
  )
  assert.match(
    errorsOf({ ...base(), profiles: [defaultProfile(), named({ dir: 'profiles/wrong' })] }),
    /profile-dir:/,
  )
  assert.match(
    errorsOf({ ...base(), profiles: [defaultProfile({ name: 'x'.repeat(41) })] }),
    /profile-name:default:name-too-long/,
  )
  assert.match(
    errorsOf({ ...base(), profiles: [defaultProfile({ createdAt: 'not-a-date', updatedAt: 'not-a-date' })] }),
    /profile-created-at:default/,
  )
  assert.match(
    errorsOf({
      ...base(),
      profiles: [
        defaultProfile(),
        named({ id: 'p-arch-0001', name: 'Archived', dir: `${PROFILES_DIR_NAME}/p-arch-0001`, archivedAt: 'nope' }),
      ],
    }),
    /profile-archived-at:/,
  )
  assert.match(
    errorsOf({
      ...base(),
      profiles: [
        defaultProfile(),
        named({ id: 'p-dup-0001', name: 'Same name', dir: `${PROFILES_DIR_NAME}/p-dup-0001` }),
        named({ id: 'p-dup-0002', name: 'same NAME', dir: `${PROFILES_DIR_NAME}/p-dup-0002` }),
      ],
    }),
    /duplicate-profile-name:same name/,
  )
  assert.match(errorsOf({ ...base(), profiles: limitProfiles(MAX_PROFILES) }), /profile-limit/)
  assert.match(errorsOf({ ...base(), activeId: 'p-missing-0000' }), /active-profile-missing/)
  assert.match(
    errorsOf({
      ...base(),
      activeId: 'p-arch-0002',
      profiles: [
        defaultProfile(),
        named({ id: 'p-arch-0002', dir: `${PROFILES_DIR_NAME}/p-arch-0002`, archivedAt: FIXED_TIMESTAMP }),
      ],
    }),
    /active-profile-archived/,
  )
  assert.equal(validateRegistry(base()).ok, true)
})

test('T3.4: peek classifies non-object, wrong-version and newer-version registries', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const registry = makeRegistry(home)

  await writeFile(home.registryFilePath, '42', 'utf8')
  const nonObject = await registry.peek()
  assert.equal(nonObject.kind, 'corrupt')
  assert.match(nonObject.detail, /not a JSON object/)

  await writeFile(home.registryFilePath, JSON.stringify({ ...sampleRegistry(), version: 0 }), 'utf8')
  const wrongVersion = await registry.peek()
  assert.equal(wrongVersion.kind, 'invalid')
  assert.match(wrongVersion.detail, /version must be 1/)

  await writeFile(home.registryFilePath, JSON.stringify({ ...sampleRegistry(), version: 2 }), 'utf8')
  const newer = await registry.peek()
  assert.equal(newer.kind, 'unsupported-version')
  assert.equal(newer.version, 2)
  assert.match(newer.detail, /newer than 1/)
})

test('T3.4: an unreadable registry backup degrades the registry and blocks writes', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  // A directory at the `.bak` path makes the backup reader fail with an IO error
  // instead of a clean "missing"/"corrupt" classification.
  await mkdir(`${home.registryFilePath}.bak`, { recursive: true })
  await writeFile(home.registryFilePath, '{broken', 'utf8')
  const registry = makeRegistry(home)

  const loaded = await registry.load()
  assert.equal(loaded.degraded, true)
  assert.equal(loaded.warning, 'corrupt-file')
  assert.equal(loaded.backupStatus, 'unreadable')
  assert.match(loaded.backupError, /EISDIR|illegal operation on a directory/)
  assert.match(loaded.quarantinedTo, /dsh-session-grove\.profiles\.corrupt-.*\.json$/)
  assert.equal(await readFile(loaded.quarantinedTo, 'utf8'), '{broken')
  assert.equal(existsSync(home.registryFilePath), false, 'the corrupt live registry was quarantined')

  const degradedWrite = await registry.commit(0, (draft) => ({ ok: true, registry: draft }))
  assert.equal(degradedWrite.kind, 'registry-unhealthy')
  assert.match(degradedWrite.detail, /invalid JSON/)
})

test('T3.4: a first quarantine-target collision gets a numeric suffix', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const stamp = new Date(NOW_MS).toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const targetStem = REGISTRY_FILE_NAME.replace(/\.json$/, '')
  const occupied = join(home.storageDir, `${targetStem}.corrupt-${stamp}.json`)
  await writeFile(occupied, 'occupied', 'utf8')
  await writeFile(home.registryFilePath, '{broken', 'utf8')

  const loaded = await makeRegistry(home).load()
  assert.equal(loaded.degraded, true)
  assert.equal(loaded.quarantinedTo, join(home.storageDir, `${targetStem}.corrupt-${stamp}-1.json`))
  assert.equal(await readFile(occupied, 'utf8'), 'occupied')
  assert.equal(await readFile(loaded.quarantinedTo, 'utf8'), '{broken')
})

test('T3.4: archiving an unknown profile returns profile-missing without a write', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(home.registryFilePath, sampleRegistry({ revision: 1 }))
  const registry = makeRegistry(home)
  const before = await sha256(home.registryFilePath)

  const result = await registry.archiveProfile({ baseRevision: 1, id: 'p-missing-0000' })
  assert.equal(result.kind, 'profile-missing')
  const malformed = await registry.archiveProfile({ baseRevision: 1, id: 'BAD' })
  assert.equal(malformed.kind, 'invalid-profile-id')
  assert.equal(await sha256(home.registryFilePath), before)
})

test('T3.4: a mutation producing an invalid registry fails closed and writes nothing', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(home.registryFilePath, sampleRegistry({ revision: 1 }))
  const registry = makeRegistry(home)
  const before = await sha256(home.registryFilePath)

  await assert.rejects(
    () =>
      registry.commit(1, (draft) => {
        draft.activeId = 'not-a-valid-id'
        return { ok: true, registry: draft }
      }),
    (error) => error?.code === 'invalid-registry',
  )
  assert.equal(await sha256(home.registryFilePath), before)
})

test('T3.4: a malformed registry lock is reclaimed so writes proceed', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(home.registryFilePath, sampleRegistry({ revision: 1 }))
  await writeFile(`${home.registryFilePath}.lock`, '{not-json', 'utf8')
  const registry = makeRegistry(home, { lockWaitMs: 1000, lockRetryMs: 5 })

  const result = await registry.commit(1, (draft) => {
    draft.revision = 1
    return { ok: true, registry: draft }
  })
  assert.equal(result.kind, 'ok')
  assert.equal(result.revision, 2)
})

test('T3.4: a live-PID lock with an old mtime is reclaimed', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(home.registryFilePath, sampleRegistry({ revision: 1 }))
  await writeFile(
    `${home.registryFilePath}.lock`,
    JSON.stringify({ pid: process.pid, token: 'old', createdAt: new Date(0).toISOString() }),
    'utf8',
  )
  const old = new Date(Date.now() - 60_000)
  await utimes(`${home.registryFilePath}.lock`, old, old)
  const registry = makeRegistry(home, { lockWaitMs: 1000, lockRetryMs: 5, lockStaleMs: 50 })

  const result = await registry.commit(1, (draft) => ({ ok: true, registry: draft }))
  assert.equal(result.kind, 'ok')
  assert.equal(result.revision, 2)
})
