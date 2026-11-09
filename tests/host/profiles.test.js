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

test('the first create writes registry revision 1 with a generated profile id', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const registry = makeRegistry(home)

  const result = await registry.createProfile({ baseRevision: 0, name: '  工作项目  ' })
  assert.equal(result.kind, 'ok')
  assert.equal(result.revision, 1)
  assert.equal(result.registry.profiles.length, 2)
  const created = result.registry.profiles[1]
  assert.match(created.id, /^p-[0-9a-z]+-[0-9a-f]{4}$/)
  assert.equal(isProfileId(created.id), true)
  assert.equal(created.name, '工作项目')
  assert.equal(created.dir, `${PROFILES_DIR_NAME}/${created.id}`)
  assert.equal(created.archivedAt, null)
  assert.equal(result.registry.activeId, created.id)
  assert.equal(result.registry.profiles[0].id, DEFAULT_PROFILE_ID)

  const onDisk = JSON.parse(await readFile(home.registryFilePath, 'utf8'))
  assert.deepEqual(onDisk, result.registry)
  assert.deepEqual(await list(home.storageDir), [REGISTRY_FILE_NAME])
})

test('a stale baseRevision returns conflict and never overwrites the registry', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const registry = makeRegistry(home)
  const first = await registry.createProfile({ baseRevision: 0, name: 'Work' })
  assert.equal(first.kind, 'ok')
  const before = await sha256(home.registryFilePath)

  const stale = await registry.createProfile({ baseRevision: 0, name: 'Other' })
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

  const first = await registry.createProfile({ baseRevision: 0, name: 'Work' })
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

  const result = await registry.createProfile({ baseRevision: 0, name: 'Locked' })
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
    () => registry.createProfile({ baseRevision: 0, name: 'Blocked' }),
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

  const blocked = await registry.createProfile({ baseRevision: 3, name: 'One more' })
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

  const created = await registry.createProfile({ baseRevision: 4, name: 'Profile 18' })
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
    const rejected = await registry.createProfile({ baseRevision: 5, name })
    assert.equal(rejected.kind, 'profile-name-invalid', `name ${JSON.stringify(name)}`)
  }
  const duplicate = await registry.createProfile({ baseRevision: 5, name: 'work' })
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
