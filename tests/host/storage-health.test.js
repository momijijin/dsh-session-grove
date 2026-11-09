import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PROFILE_ID, PROFILES_DIR_NAME, REGISTRY_FILE_NAME } from '../../src/host/constants.js'
import { inspectProfileRegistry, inspectProfileStorage, inspectStorageHealth } from '../../src/host/storage-health.js'
import {
  FIXED_TIMESTAMP,
  PROFILE_ID,
  makeTempProfileHome,
  sampleDefaultProfile,
  sampleDoc,
  sampleNamedProfile,
  sampleRegistry,
  writeJsonFile,
  writeProfileDoc,
} from './helpers.js'

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

/** Content snapshot of the whole temp home; proves the health checks are read-only. */
const snapshot = async (home) => {
  const entries = {}
  const walk = async (dir, prefix = '') => {
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const item of items) {
      const relativePath = prefix === '' ? item.name : `${prefix}/${item.name}`
      if (item.isDirectory()) {
        entries[relativePath] = 'dir'
        await walk(join(dir, item.name), relativePath)
      } else {
        entries[relativePath] = await sha256(join(dir, item.name))
      }
    }
  }
  await walk(home.dir)
  return entries
}

const makePath = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsg-health-'))
  await mkdir(join(dir, 'storages'), { recursive: true })
  return join(dir, 'storages', 'dsh-session-grove.json')
}

test('storage health reports missing, valid, backup and quarantine state read-only', async () => {
  const filePath = await makePath()
  const missing = await inspectStorageHealth(filePath)
  assert.deepEqual(missing, {
    status: 'missing',
    revision: null,
    error: null,
    backup: false,
    backupStatus: 'missing',
    backupRevision: null,
    backupError: null,
    quarantined: 0,
  })

  await writeFile(filePath, JSON.stringify({ ...sampleDoc(), revision: 4 }), 'utf8')
  await writeFile(`${filePath}.bak`, JSON.stringify({ ...sampleDoc(), revision: 3 }), 'utf8')
  await writeFile(join(filePath, '..', 'dsh-session-grove.corrupt-2026.json'), '{}', 'utf8')
  const healthy = await inspectStorageHealth(filePath)
  assert.equal(healthy.status, 'ok')
  assert.equal(healthy.revision, 4)
  assert.equal(healthy.backup, true)
  assert.equal(healthy.backupStatus, 'ok')
  assert.equal(healthy.backupRevision, 3)
  assert.equal(healthy.quarantined, 1)
})

test('storage health distinguishes a corrupt backup from a usable one', async () => {
  const filePath = await makePath()
  await writeFile(filePath, JSON.stringify({ ...sampleDoc(), revision: 4 }), 'utf8')
  await writeFile(`${filePath}.bak`, '{broken', 'utf8')
  const corruptBackup = await inspectStorageHealth(filePath)
  assert.equal(corruptBackup.status, 'ok')
  assert.equal(corruptBackup.backup, true)
  assert.equal(corruptBackup.backupStatus, 'corrupt')
  assert.match(corruptBackup.backupError, /JSON/)

  await writeFile(`${filePath}.bak`, JSON.stringify({ ...sampleDoc(), version: 9 }), 'utf8')
  const unsupportedBackup = await inspectStorageHealth(filePath)
  assert.equal(unsupportedBackup.backupStatus, 'unsupported-version')

  await writeFile(`${filePath}.bak`, JSON.stringify({ version: 0, revision: 1, groups: [], ungrouped: [] }), 'utf8')
  const invalidBackup = await inspectStorageHealth(filePath)
  assert.equal(invalidBackup.backupStatus, 'invalid')
})

test('storage health classifies corrupt, unsupported, invalid and unreadable records without repairing them', async () => {
  const corruptPath = await makePath()
  await writeFile(corruptPath, '{broken', 'utf8')
  const corrupt = await inspectStorageHealth(corruptPath)
  assert.equal(corrupt.status, 'corrupt')
  assert.match(corrupt.error, /JSON/)

  const unsupportedPath = await makePath()
  await writeFile(unsupportedPath, JSON.stringify({ ...sampleDoc(), version: 9, revision: 1 }), 'utf8')
  assert.equal((await inspectStorageHealth(unsupportedPath)).status, 'unsupported-version')

  const invalidPath = await makePath()
  await writeFile(invalidPath, JSON.stringify({ version: 0, revision: 1, groups: [], ungrouped: [] }), 'utf8')
  const invalidVersion = await inspectStorageHealth(invalidPath)
  assert.equal(invalidVersion.status, 'invalid')
  assert.match(invalidVersion.error, /version must be 1/)

  const duplicatePath = await makePath()
  await writeFile(duplicatePath, JSON.stringify({
    version: 1,
    revision: 1,
    groups: [{ id: 'g', name: 'G', icon: 'folder', parentId: null, sessionIds: ['same'] }],
    ungrouped: ['same'],
  }), 'utf8')
  const invalid = await inspectStorageHealth(duplicatePath)
  assert.equal(invalid.status, 'invalid')
  assert.match(invalid.error, /duplicate-session/)

  const unreadablePath = await makePath()
  await mkdir(unreadablePath)
  const unreadable = await inspectStorageHealth(unreadablePath)
  assert.equal(unreadable.status, 'unreadable')
})

test('profile storage health reports the registry and every profile read-only', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  const archivedId = 'p-archive-0001'
  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({
      revision: 4,
      profiles: [
        sampleDefaultProfile({ name: 'Personal' }),
        sampleNamedProfile(),
        sampleNamedProfile({
          id: archivedId,
          name: 'Old',
          dir: `${PROFILES_DIR_NAME}/${archivedId}`,
          archivedAt: FIXED_TIMESTAMP,
        }),
      ],
    }),
  )
  await writeProfileDoc(home, DEFAULT_PROFILE_ID, { revision: 8 })
  await writeProfileDoc(home, PROFILE_ID, { revision: 3 })
  await writeProfileDoc(home, 'p-orphan-0001', { revision: 2 })
  const before = await snapshot(home)

  const health = await inspectProfileStorage({ storageDir: home.storageDir })
  assert.equal(health.registry.status, 'ok')
  assert.equal(health.registry.revision, 4)
  assert.equal(health.registry.activeId, DEFAULT_PROFILE_ID)
  assert.equal(health.registry.profileCount, 3)
  assert.equal(health.registry.degraded, false)
  assert.equal(health.registry.backup, false)
  assert.equal(health.registry.quarantined, 0)
  assert.equal(health.profiles.length, 4)

  const [defaultProfile, work, archived, orphan] = health.profiles
  assert.deepEqual(
    [defaultProfile.id, work.id, archived.id, orphan.id],
    [DEFAULT_PROFILE_ID, PROFILE_ID, archivedId, 'p-orphan-0001'],
  )
  assert.equal(defaultProfile.name, 'Personal')
  assert.equal(defaultProfile.healthy, true)
  assert.equal(defaultProfile.revision, 8)
  assert.equal(work.name, '工作项目')
  assert.equal(work.healthy, true)
  assert.equal(work.revision, 3)
  assert.equal(archived.archived, true)
  assert.equal(archived.healthy, false, 'the archived fixture has no document')
  assert.equal(archived.status, 'missing')
  assert.equal(orphan.orphan, true)
  assert.equal(orphan.healthy, true)
  assert.equal(orphan.revision, 2)

  assert.deepEqual(await snapshot(home), before)
})

test('a corrupt registry still reports default plus on-disk profiles without healing', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeFile(home.registryFilePath, '{broken', 'utf8')
  await writeProfileDoc(home, PROFILE_ID, { revision: 2 })
  const before = await snapshot(home)

  const health = await inspectProfileStorage({ storageDir: home.storageDir })
  assert.equal(health.registry.status, 'corrupt')
  assert.equal(health.registry.degraded, true)
  assert.match(health.registry.error, /JSON/)
  assert.equal(health.registry.quarantined, 0)
  assert.deepEqual(
    health.profiles.map((profile) => profile.id),
    [DEFAULT_PROFILE_ID, PROFILE_ID],
  )
  const named = health.profiles[1]
  assert.equal(named.orphan, true)
  assert.equal(named.healthy, true)
  assert.equal(named.revision, 2)
  assert.deepEqual(await snapshot(home), before)
})

test('a corrupt profile document is reported without creating a quarantine copy', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({ revision: 2, profiles: [sampleDefaultProfile(), sampleNamedProfile()] }),
  )
  await writeJsonFile(join(home.profilesDir, PROFILE_ID, 'dsh-session-grove.json'), '{broken')
  const before = await snapshot(home)

  const health = await inspectProfileStorage({ storageDir: home.storageDir })
  const named = health.profiles.find((profile) => profile.id === PROFILE_ID)
  assert.equal(named.healthy, false)
  assert.equal(named.status, 'corrupt')
  assert.match(named.error, /JSON/)
  assert.equal(named.quarantined, 0)
  assert.deepEqual(await snapshot(home), before)
})

test('registry inspector classifies missing, unsupported, backup, and quarantine families', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)

  const missing = await inspectProfileRegistry(home.registryFilePath)
  assert.equal(missing.status, 'missing')
  assert.equal(missing.degraded, false)
  assert.equal(missing.revision, null)
  assert.equal(missing.activeId, null)
  assert.equal(missing.profileCount, 0)

  await writeFile(home.registryFilePath, JSON.stringify({ version: 9, revision: 2 }), 'utf8')
  await writeJsonFile(`${home.registryFilePath}.bak`, sampleRegistry({ revision: 1 }))
  await writeFile(join(home.storageDir, 'dsh-session-grove.profiles.corrupt-2026.json'), '{}', 'utf8')
  const unsupported = await inspectProfileRegistry(home.registryFilePath)
  assert.equal(unsupported.status, 'unsupported-version')
  assert.equal(unsupported.degraded, true)
  assert.equal(unsupported.revision, 2)
  assert.equal(unsupported.backup, true)
  assert.equal(unsupported.backupStatus, 'ok')
  assert.equal(unsupported.backupRevision, 1)
  assert.equal(unsupported.quarantined, 1)
})
