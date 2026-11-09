import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config, inject, name } from '../../src/index.js'
import {
  CONTROL_TOKEN_FILE_NAME,
  DEBUG_FILE_NAME,
  DIAGNOSTICS_FILE_NAME,
  LOAD_PATH,
  RECORD_FILE_NAME,
} from '../../src/host/constants.js'
import {
  PROFILE_ID,
  makeContext,
  makeRequest,
  makeResponse,
  makeTempProfileHome,
  makeTempStore,
  sampleDefaultProfile,
  sampleNamedProfile,
  sampleRegistry,
  writeJsonFile,
  writeProfileDoc,
} from './helpers.js'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(path)))
    else if (entry.name.endsWith('.js')) files.push(path)
  }
  return files
}

test('the entry exports the Cordis row name and injects webServer', () => {
  assert.equal(name, 'dsh-session-grove')
  assert.deepEqual(inject, ['webServer'])
})

test('0.2.18 exposes a plugin-manager Config with diagnostics and debug probe off', () => {
  assert.equal(Config?.[Symbol.for('schemastery')], true)
  assert.equal(Config.type, 'object')
  assert.equal(Config.dict.diagnostics.type, 'boolean')
  assert.equal(Config.dict.diagnostics.meta.default, false)
  assert.equal(Config.dict.debugProbe.type, 'boolean')
  assert.equal(Config.dict.debugProbe.meta.default, false)
  for (const key of ['diagnostics', 'debugProbe', 'controlApi', 'controlDestructive', 'controlSessions']) {
    assert.equal(Config.dict[key].meta.volatile, true, `${key} must be served by the host config form`)
    assert.equal(Config.dict[key].meta.default, false, `${key} must default off`)
  }
})

test('apply registers the native control tool when the tools service is present', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  let registered = null
  const tools = {
    register(tool) {
      registered = tool
      return () => {
        registered = null
      }
    },
  }
  const { ctx } = makeContext({ services: { tools } })
  apply(ctx, { filePath: temp.filePath, storageDir: temp.storages })
  assert.equal(registered?.name, 'session_grove_control')
  assert.equal(registered.parameters.required.includes('action'), true)
  assert.equal(registered.parameters.properties.action.enum.includes('doctor'), true)
  assert.equal(typeof registered.execute, 'function')
})

test('native control tool doctor reports live host compatibility, gates, storage and routes', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  let registered = null
  const tools = {
    register(tool) {
      registered = tool
      return () => {
        registered = null
      }
    },
  }
  const { ctx } = makeContext({ services: { tools } })
  apply(ctx, { filePath: temp.filePath, storageDir: temp.storages })
  const report = await registered.execute({ action: 'doctor' })
  assert.equal(report.ok, true)
  assert.equal(report.protocol, 1)
  assert.equal(typeof report.plugin.version, 'string')
  assert.equal(report.plugin.supportedRange, '>=0.2.0-rc.2 <0.3.0')
  assert.equal(report.host.compatibility.supported, true)
  assert.equal(report.host.capabilities.webServerRegister, true)
  assert.equal(report.host.startupCapabilities.webServerRegister, true)
  assert.equal(report.gates.controlApi, false)
  assert.equal(report.gates.controlDestructive, false)
  assert.equal(report.gates.controlSessions, false)
  assert.equal(report.storage.filePath, temp.filePath)
  assert.equal(typeof report.storage.source, 'string')
  assert.equal(report.storage.health.status, 'missing')
  assert.equal(report.routes.includes('/dsh-session-grove/control/doctor'), true)
  assert.equal(report.routes.includes('/dsh-session-grove/load'), true)
})

test('apply() returns void synchronously and mounts the host routes inside ctx.effect', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const { ctx, routes, logs } = makeContext()
  let ready
  const returned = apply(ctx, {
    filePath: temp.filePath,
    storageDir: temp.storages,
    onReady: (value) => {
      ready = value
    },
  })

  // Cordis 4.0.5 treats the return value as the plugin effect list.
  assert.equal(returned, undefined)
  assert.equal(routes.length, 15)
  assert.equal(routes.some((route) => route.path === '/dsh-session-grove/control/catalog'), true)
  assert.equal(ready.filePath, temp.filePath)
  assert.equal(ready.storageDir, temp.storages)
  assert.equal(ready.diagnosticsFilePath, join(temp.storages, DIAGNOSTICS_FILE_NAME))
  assert.equal(ready.debugFilePath, join(temp.storages, DEBUG_FILE_NAME))
  assert.equal(ready.mounted.registered, true)
  assert.equal(typeof ready.store.load, 'function')
  assert.equal(await ready.profileManager.activeId(), 'default')
  assert.equal(ready.store, ready.profileManager.storeFor('default'), 'the default store identity comes from the manager')
  assert.match(await readFile(join(temp.storages, CONTROL_TOKEN_FILE_NAME), 'utf8'), /^[0-9a-f]{64}$/)
  assert.equal(typeof ready.storageSource, 'string')
  assert.equal(logs.info.some((line) => line.includes('host ready') && line.includes('storageSource=')), true)
  assert.equal(logs.info.some((line) => line.includes('diagnostics=')), true)
})

test('global artifacts stay in storageDir while a named profile is active', async (t) => {
  const home = await makeTempProfileHome()
  t.after(home.cleanup)
  await writeJsonFile(
    home.registryFilePath,
    sampleRegistry({
      revision: 3,
      activeId: PROFILE_ID,
      profiles: [sampleDefaultProfile(), sampleNamedProfile()],
    }),
  )
  await writeProfileDoc(home, PROFILE_ID, { revision: 2 })

  const { ctx, routes, disposeAll } = makeContext({
    connection: { requestRejection: () => undefined },
  })
  t.after(() => disposeAll())
  let ready
  apply(ctx, {
    storageDir: home.storageDir,
    onReady: (value) => {
      ready = value
    },
  })

  // SPEC 4.6: every global artifact is derived from `record.storageDir`, never
  // from the active profile document path.
  assert.equal(ready.storageDir, home.storageDir)
  assert.equal(ready.diagnosticsFilePath, join(home.storageDir, DIAGNOSTICS_FILE_NAME))
  assert.equal(ready.debugFilePath, join(home.storageDir, DEBUG_FILE_NAME))
  assert.match(await readFile(join(home.storageDir, CONTROL_TOKEN_FILE_NAME), 'utf8'), /^[0-9a-f]{64}$/)
  assert.deepEqual(
    await readdir(join(home.profilesDir, PROFILE_ID)),
    [RECORD_FILE_NAME],
    'no diagnostics/debug/token files may leak into the profile directory',
  )

  const load = routes.find((route) => route.path === LOAD_PATH)
  const res = makeResponse()
  await load.handler(makeRequest({ headers: { host: '127.0.0.1:4400' } }), res)
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.profileId, PROFILE_ID)
  assert.equal(body.revision, 2)
  assert.equal(body.diagnostics, false)
  assert.equal(body.debugProbe, false)
})

test('apply() is fail-soft when the composition has no webServer', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const { ctx, logs } = makeContext({ webServer: null })
  let ready
  const returned = apply(ctx, {
    filePath: temp.filePath,
    storageDir: temp.storages,
    onReady: (value) => {
      ready = value
    },
  })
  assert.equal(returned, undefined)
  assert.equal(ready.mounted.registered, false)
  assert.deepEqual(ready.mounted.routes, [])
  assert.equal(logs.warn.some((line) => line.includes('webServer.register is unavailable')), true)
})

test('the host half never imports @deepseek-ai/dsh-client-runtime', async () => {
  const files = [...(await walk(join(repoRoot, 'src', 'host'))), join(repoRoot, 'src', 'index.js')]
  assert.ok(files.length > 0)
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    assert.equal(text.includes('dsh-client-runtime'), false, file)
  }
})

test('package.json declares the host peers required by the frozen contract', async () => {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  assert.equal(typeof manifest.peerDependencies?.['@deepseek-ai/dsh-home-paths'], 'string')
  assert.equal(typeof manifest.peerDependencies?.['@deepseek-ai/cordis'], 'string')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
})
