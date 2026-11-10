import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyDoc } from '../../src/shared/model.js'
import { createStore } from '../../src/host/store.js'
import { makeTempStore, sampleDoc } from './helpers.js'

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

const list = async (dir) => (await readdir(dir)).sort()

test('H1: first load without a file returns the empty document at revision 0', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const result = await temp.store.load()
  assert.equal(result.kind, 'ok')
  assert.equal(result.exists, false)
  assert.equal(result.revision, 0)
  assert.deepEqual(result.doc, emptyDoc())
})

test('H2/H5: commit writes revision+1, one .bak, and leaves no temp file', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)

  const first = await temp.store.commit(0, sampleDoc())
  assert.equal(first.kind, 'ok')
  assert.equal(first.revision, 1)
  assert.deepEqual(await list(temp.storages), ['dsh-session-grove.json'])
  const onDisk = JSON.parse(await readFile(temp.filePath, 'utf8'))
  assert.equal(onDisk.revision, 1)
  assert.deepEqual(onDisk, first.doc)

  const second = await temp.store.commit(1, { ...sampleDoc(), ungrouped: ['s-4', 's-5'] })
  assert.equal(second.kind, 'ok')
  assert.equal(second.revision, 2)
  assert.deepEqual(await list(temp.storages), ['dsh-session-grove.json', 'dsh-session-grove.json.bak'])
  assert.equal(JSON.parse(await readFile(temp.filePath + '.bak', 'utf8')).revision, 1)
  const tempFiles = (await list(temp.storages)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(tempFiles, [])
})

test('H3: a stale baseRevision returns conflict with the current doc and never overwrites', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await temp.store.commit(0, sampleDoc())
  await temp.store.commit(1, sampleDoc())
  const before = await sha256(temp.filePath)

  const stale = await temp.store.commit(1, { ...sampleDoc(), ungrouped: [] })
  assert.equal(stale.kind, 'conflict')
  assert.equal(stale.revision, 2)
  assert.equal(stale.doc.revision, 2)
  assert.equal(await sha256(temp.filePath), before)
})

test('H8: concurrent commits serialize; exactly one wins under the same baseRevision', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const [left, right] = await Promise.all([
    temp.store.commit(0, { ...sampleDoc(), ungrouped: ['a'] }),
    temp.store.commit(0, { ...sampleDoc(), ungrouped: ['b'] }),
  ])
  assert.deepEqual([left.kind, right.kind].sort(), ['conflict', 'ok'])
  assert.equal(JSON.parse(await readFile(temp.filePath, 'utf8')).revision, 1)
})

test('H4: invalid documents are rejected by shared validateDoc and the file is untouched', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await temp.store.commit(0, sampleDoc())
  const before = await sha256(temp.filePath)

  const duplicate = {
    version: 1,
    groups: [
      { id: 'g-a', name: 'A', parentId: null, sessionIds: ['s1'] },
      { id: 'g-b', name: 'B', parentId: null, sessionIds: ['s1'] },
    ],
    ungrouped: [],
  }
  const rejected = await temp.store.commit(1, duplicate)
  assert.equal(rejected.kind, 'invalid')
  assert.match(rejected.errors.join('\n'), /duplicate-session:s1/)
  assert.equal(await sha256(temp.filePath), before)
})

test('0.2.7: load normalizes valid custom hex and recovers a valid backup after invalid input', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const doc = {
    version: 1,
    revision: 3,
    groups: [
      { id: 'g-a', name: 'A', icon: 'hash', color: 'blue', colorHex: '#A1B2C3', parentId: null, sessionIds: [] },
    ],
    ungrouped: [],
  }
  await writeFile(temp.filePath, JSON.stringify(doc), 'utf8')
  const loaded = await temp.store.load()
  assert.equal(loaded.kind, 'ok')
  assert.equal(loaded.doc.groups[0].colorHex, '#a1b2c3')
  assert.equal(JSON.parse(await readFile(temp.filePath, 'utf8')).groups[0].colorHex, '#A1B2C3', 'load does not rewrite the file')

  const committed = await temp.store.commit(3, { ...doc, groups: [{ ...doc.groups[0], colorHex: '#A1B2C3' }] })
  assert.equal(committed.kind, 'ok')
  assert.equal(committed.doc.groups[0].colorHex, '#a1b2c3', 'direct host writes normalize too')

  const invalid = { ...doc, groups: [{ ...doc.groups[0], colorHex: '#abcd' }] }
  await writeFile(temp.filePath, JSON.stringify(invalid), 'utf8')
  const quarantined = await temp.store.load()
  assert.equal(quarantined.warning, 'recovered-backup')
  assert.match(quarantined.detail, /group-color-hex:g-a/)
  assert.equal(quarantined.doc.groups[0].colorHex, '#a1b2c3')
})

test('icon is opaque: an unknown short icon id is accepted and stored verbatim (C7)', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const doc = sampleDoc()
  doc.groups[0].icon = 'future-icon'
  const committed = await temp.store.commit(0, doc)
  assert.equal(committed.kind, 'ok')
  assert.equal(JSON.parse(await readFile(temp.filePath, 'utf8')).groups[0].icon, 'future-icon')
})

test('the client-sent doc.revision is ignored; the host stamps revision', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const result = await temp.store.commit(0, { ...sampleDoc(), revision: 999 })
  assert.equal(result.kind, 'ok')
  assert.equal(result.revision, 1)
  assert.equal(JSON.parse(await readFile(temp.filePath, 'utf8')).revision, 1)
})

test('H6: bad JSON is quarantined as .corrupt-* and degrades to empty + corrupt-file', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const garbage = '{"version":1,"revision":2,"groups":['
  await writeFile(temp.filePath, garbage, 'utf8')

  const result = await temp.store.load()
  assert.equal(result.kind, 'ok')
  assert.equal(result.revision, 0)
  assert.deepEqual(result.doc, emptyDoc())
  assert.equal(result.warning, 'corrupt-file')
  assert.match(result.quarantinedTo, /dsh-session-grove\.corrupt-.*\.json$/)
  assert.equal(await readFile(result.quarantinedTo, 'utf8'), garbage)
  assert.equal(await sha256(temp.filePath).catch(() => 'missing'), 'missing')

  const recovered = await temp.store.commit(0, sampleDoc())
  assert.equal(recovered.kind, 'ok')
  assert.equal(recovered.revision, 1)
})

test('H6a: a corrupt record recovers the previous valid .bak and preserves the corrupt file', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const first = await temp.store.commit(0, sampleDoc())
  assert.equal(first.kind, 'ok')
  assert.equal(first.revision, 1)
  const second = await temp.store.commit(1, { ...sampleDoc(), ungrouped: ['s-4', 's-5'] })
  assert.equal(second.kind, 'ok')
  assert.equal(second.revision, 2)
  const garbage = '{"version":1,"revision":2,"groups":['
  await writeFile(temp.filePath, garbage, 'utf8')

  const result = await temp.store.load()
  assert.equal(result.kind, 'ok')
  assert.equal(result.warning, 'recovered-backup')
  assert.equal(result.revision, 1)
  assert.deepEqual(result.doc.groups, sampleDoc().groups)
  assert.match(result.quarantinedTo, /dsh-session-grove\.corrupt-.*\.json$/)
  assert.equal(await readFile(result.quarantinedTo, 'utf8'), garbage)
  assert.equal(JSON.parse(await readFile(temp.filePath, 'utf8')).revision, 1)

  const next = await temp.store.commit(1, { ...result.doc, ungrouped: [] })
  assert.equal(next.kind, 'ok')
  assert.equal(next.revision, 2)
})

test('H6a2: a corrupt record with a corrupt backup still degrades to empty without deleting either copy', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await writeFile(temp.filePath, '{broken', 'utf8')
  await writeFile(`${temp.filePath}.bak`, '{also-broken', 'utf8')

  const result = await temp.store.load()
  assert.equal(result.warning, 'corrupt-file')
  assert.equal(result.revision, 0)
  assert.deepEqual(result.doc, emptyDoc())
  assert.match(result.quarantinedTo, /dsh-session-grove\.corrupt-.*\.json$/)
  assert.equal(await readFile(`${temp.filePath}.bak`, 'utf8'), '{also-broken')
})

test('H6b: parseable but invariant-breaking JSON is quarantined as invalid-file', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await writeFile(
    temp.filePath,
    JSON.stringify({
      version: 1,
      revision: 3,
      groups: [{ id: 'g-a', name: '', parentId: null, sessionIds: ['s1'] }],
      ungrouped: ['s1'],
    }),
    'utf8',
  )
  const result = await temp.store.load()
  assert.equal(result.kind, 'ok')
  assert.equal(result.warning, 'invalid-file')
  assert.equal(result.revision, 0)
  assert.match(result.detail, /duplicate-session:s1/)
})

test('H7: version > 1 is unsupported-version, never overwritten', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const future = JSON.stringify({ version: 2, revision: 5, groups: [], ungrouped: [] })
  await writeFile(temp.filePath, future, 'utf8')
  const before = await sha256(temp.filePath)

  const load = await temp.store.load()
  assert.equal(load.kind, 'unsupported-version')
  assert.equal(load.version, 2)

  const commit = await temp.store.commit(5, sampleDoc())
  assert.equal(commit.kind, 'unsupported-version')
  assert.equal(await sha256(temp.filePath), before)
})

test('S7 crash window: leftover temp files are inert and never affect the record', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await temp.store.commit(0, sampleDoc())

  const uniqueLeftover = `${temp.filePath}.${process.pid}.deadbeef.tmp`
  const legacyLeftover = `${temp.filePath}.tmp`
  await writeFile(uniqueLeftover, '{"version":1,"revision":99,"groups":["truncated')
  await writeFile(legacyLeftover, '{"truncated')

  const loaded = await temp.store.load()
  assert.equal(loaded.kind, 'ok')
  assert.equal(loaded.revision, 1)
  assert.deepEqual(loaded.doc.ungrouped, ['s-4'])

  const next = await temp.store.commit(1, sampleDoc())
  assert.equal(next.kind, 'ok')
  assert.equal(next.revision, 2)
  const files = await list(temp.storages)
  assert.equal(files.includes(`dsh-session-grove.json.${process.pid}.deadbeef.tmp`), true)
  assert.equal(files.includes('dsh-session-grove.json.tmp'), true)
  const ownTemps = files.filter((name) => /^dsh-session-grove\.json\.\d+\.[0-9a-f]{8}\.tmp$/.test(name))
  assert.deepEqual(ownTemps, [`dsh-session-grove.json.${process.pid}.deadbeef.tmp`])
})

test('H10: only the record file family is written next to unrelated host data', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const sentinel = join(temp.storages, 'workspace.json')
  await writeFile(sentinel, '{"workspaces":[]}\n', 'utf8')
  const before = await sha256(sentinel)

  await temp.store.commit(0, sampleDoc())
  await temp.store.commit(1, sampleDoc())

  assert.equal(await sha256(sentinel), before)
  assert.deepEqual(await list(temp.storages), [
    'dsh-session-grove.json',
    'dsh-session-grove.json.bak',
    'workspace.json',
  ])
})

test('save() stamps the next revision and persists a clean document', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const saved = await temp.store.save(sampleDoc())
  assert.equal(saved.revision, 1)
  const loaded = await temp.store.load()
  assert.equal(loaded.revision, 1)
  assert.deepEqual(loaded.doc, saved)
})

test('load propagates genuine IO errors (record path is a directory)', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await mkdir(temp.filePath, { recursive: true })
  const store = createStore({ filePath: temp.filePath })
  await assert.rejects(() => store.load(), /EISDIR|illegal operation on a directory/)
})

test('peek reads a valid document without locking, writing, or creating siblings', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await writeFile(temp.filePath, `${JSON.stringify({ ...sampleDoc(), revision: 4 }, null, 2)}\n`, 'utf8')
  const beforeHash = await sha256(temp.filePath)
  const beforeMtime = (await stat(temp.filePath)).mtimeMs

  const peeked = await temp.store.peek()
  assert.equal(peeked.kind, 'ok')
  assert.equal(peeked.exists, true)
  assert.equal(peeked.revision, 4)
  assert.deepEqual(peeked.doc, { ...sampleDoc(), revision: 4 })

  assert.equal(await sha256(temp.filePath), beforeHash)
  assert.equal((await stat(temp.filePath)).mtimeMs, beforeMtime)
  assert.deepEqual(await list(temp.storages), ['dsh-session-grove.json'])
})

test('peek reports a missing file without creating its directory', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const missingDir = join(temp.dir, 'missing-storages')
  const store = createStore({ filePath: join(missingDir, 'dsh-session-grove.json') })

  const peeked = await store.peek()
  assert.equal(peeked.kind, 'missing')
  assert.match(peeked.detail, /does not exist/)
  await assert.rejects(() => stat(missingDir), (error) => error?.code === 'ENOENT')
})

test('peek classifies corrupt, invalid, and unsupported documents without quarantining', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)

  const garbage = '{"version":1,"revision":2,"groups":['
  await writeFile(temp.filePath, garbage, 'utf8')
  const beforeHash = await sha256(temp.filePath)
  const corrupt = await createStore({ filePath: temp.filePath }).peek()
  assert.equal(corrupt.kind, 'corrupt')
  assert.match(corrupt.detail, /JSON/)
  assert.equal(await sha256(temp.filePath), beforeHash)
  assert.deepEqual(await list(temp.storages), ['dsh-session-grove.json'])

  await writeFile(
    temp.filePath,
    JSON.stringify({ version: 1, revision: 1, groups: [{ id: 'g-a', name: '', parentId: null, sessionIds: [] }], ungrouped: [] }),
    'utf8',
  )
  const invalid = await temp.store.peek()
  assert.equal(invalid.kind, 'invalid')
  assert.match(invalid.detail, /group-name:g-a/)

  await writeFile(temp.filePath, JSON.stringify({ version: 2, revision: 5, groups: [], ungrouped: [] }), 'utf8')
  const future = await temp.store.peek()
  assert.equal(future.kind, 'unsupported-version')
  assert.equal(future.version, 2)
  assert.match(future.detail, /newer than 1/)
  assert.equal(JSON.parse(await readFile(temp.filePath, 'utf8')).version, 2)
})

test('peek has no quarantine side effect, unlike load()', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const garbage = '{broken'
  await writeFile(temp.filePath, garbage, 'utf8')

  assert.equal((await temp.store.peek()).kind, 'corrupt')
  assert.deepEqual(await list(temp.storages), ['dsh-session-grove.json'])

  const loaded = await temp.store.load()
  assert.equal(loaded.warning, 'corrupt-file')
  assert.match(loaded.quarantinedTo, /dsh-session-grove\.corrupt-.*\.json$/)
  const files = await list(temp.storages)
  assert.equal(files.includes('dsh-session-grove.json'), false)
  assert.equal(files.some((name) => name.startsWith('dsh-session-grove.corrupt-')), true)
  assert.equal(files.some((name) => name.endsWith('.lock')), false)
})

test('peek ignores a live filesystem lock and never waits for it', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await writeFile(temp.filePath, JSON.stringify({ ...sampleDoc(), revision: 1 }), 'utf8')
  await writeFile(
    `${temp.filePath}.lock`,
    JSON.stringify({ pid: process.pid, token: 'live', createdAt: new Date().toISOString() }),
    'utf8',
  )
  const store = createStore({ filePath: temp.filePath, lockWaitMs: 30, lockRetryMs: 5 })

  const peeked = await store.peek()
  assert.equal(peeked.kind, 'ok')
  assert.equal(peeked.revision, 1)
})

// ---------------------------------------------------------------------------
// T3.2 boundary tests (SPEC §8.2): serialized writes and degraded write refusal.
// ---------------------------------------------------------------------------

test('T3.2: queued commit/save/load calls run in one serialized critical section', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  // The three calls are issued back-to-back before any settles; the promise tail
  // must run them in call order so save() observes the committed revision.
  const commitResult = temp.store.commit(0, { ...sampleDoc(), ungrouped: ['s-9'] })
  const saveResult = temp.store.save({ ...sampleDoc(), ungrouped: ['s-10'] })
  const loadResult = temp.store.load()
  const [committed, saved, loaded] = await Promise.all([commitResult, saveResult, loadResult])
  assert.equal(committed.kind, 'ok')
  assert.equal(committed.revision, 1)
  assert.equal(saved.revision, 2)
  assert.equal(loaded.revision, 2)
  assert.deepEqual(loaded.doc.ungrouped, ['s-10'])

  // A commit queued after the tail settled uses the latest revision and wins.
  const next = await temp.store.commit(2, { ...sampleDoc(), ungrouped: ['s-11'] })
  assert.equal(next.kind, 'ok')
  assert.equal(next.revision, 3)
  const final = await temp.store.load()
  assert.equal(final.revision, 3)
  assert.deepEqual(final.doc.ungrouped, ['s-11'])
})

test('T3.2: two store instances on one file serialize through the filesystem lock', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const secondStore = createStore({ filePath: temp.filePath, lockWaitMs: 5000, lockRetryMs: 5 })
  const [left, right] = await Promise.all([
    temp.store.commit(0, { ...sampleDoc(), ungrouped: ['a'] }),
    secondStore.commit(0, { ...sampleDoc(), ungrouped: ['b'] }),
  ])
  assert.deepEqual([left.kind, right.kind].sort(), ['conflict', 'ok'])
  const winner = left.kind === 'ok' ? left : right
  assert.equal(JSON.parse(await readFile(temp.filePath, 'utf8')).revision, winner.revision)
  assert.equal(await readFile(`${temp.filePath}.lock`, 'utf8').catch(() => 'missing'), 'missing')
})

test('T3.2: a live held lock refuses writes with store-busy and leaves the record untouched', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  const store = createStore({ filePath: temp.filePath, lockWaitMs: 40, lockRetryMs: 5 })
  await writeFile(
    `${temp.filePath}.lock`,
    JSON.stringify({ pid: process.pid, token: 'held', createdAt: new Date().toISOString() }),
    'utf8',
  )
  const before = await readFile(temp.filePath, 'utf8').catch(() => 'missing')
  await assert.rejects(() => store.save(sampleDoc()), (error) => error?.code === 'store-busy')
  await assert.rejects(() => store.commit(0, sampleDoc()), (error) => error?.code === 'store-busy')
  assert.equal(await readFile(temp.filePath, 'utf8').catch(() => 'missing'), before)
  assert.deepEqual(await list(temp.storages), ['dsh-session-grove.json.lock'])

  // Releasing the lock restores the write path without restarting the store.
  await rm(`${temp.filePath}.lock`, { force: true })
  const recovered = await store.commit(0, sampleDoc())
  assert.equal(recovered.kind, 'ok')
  assert.equal(recovered.revision, 1)
})

test('T3.2: a stale lock (dead PID or old mtime) is reclaimed so writes proceed', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await writeFile(
    `${temp.filePath}.lock`,
    JSON.stringify({ pid: 999_999_999, token: 'dead', createdAt: new Date().toISOString() }),
    'utf8',
  )
  const firstStore = createStore({ filePath: temp.filePath, lockWaitMs: 1000, lockRetryMs: 5 })
  const first = await firstStore.commit(0, sampleDoc())
  assert.equal(first.kind, 'ok')
  assert.equal(await readFile(`${temp.filePath}.lock`, 'utf8').catch(() => 'missing'), 'missing')

  // An old-mtime lock owned by this live process is stale too (crashed writer
  // that never released its lock file).
  await writeFile(
    `${temp.filePath}.lock`,
    JSON.stringify({ pid: process.pid, token: 'old', createdAt: new Date(0).toISOString() }),
    'utf8',
  )
  const old = new Date(Date.now() - 60_000)
  await utimes(`${temp.filePath}.lock`, old, old)
  const secondStore = createStore({ filePath: temp.filePath, lockWaitMs: 1000, lockRetryMs: 5, lockStaleMs: 50 })
  const second = await secondStore.commit(1, sampleDoc())
  assert.equal(second.kind, 'ok')
  assert.equal(second.revision, 2)
})

test('T3.2: a malformed lock file is treated as stale and reclaimed', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await writeFile(`${temp.filePath}.lock`, '{not-json', 'utf8')
  const store = createStore({ filePath: temp.filePath, lockWaitMs: 1000, lockRetryMs: 5 })
  const result = await store.commit(0, sampleDoc())
  assert.equal(result.kind, 'ok')
  assert.equal(result.revision, 1)
})

test('T3.2: a degraded (newer-schema) document refuses save() and commit()', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await writeFile(temp.filePath, JSON.stringify({ version: 2, revision: 5, groups: [], ungrouped: [] }), 'utf8')
  const before = await sha256(temp.filePath)
  await assert.rejects(
    () => temp.store.save(sampleDoc()),
    (error) => error?.code === 'unsupported-version',
  )
  const commit = await temp.store.commit(5, sampleDoc())
  assert.equal(commit.kind, 'unsupported-version')
  assert.equal(await sha256(temp.filePath), before)
})

test('T3.2: save() rejects an invalid document with the shared validation errors', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await assert.rejects(
    () =>
      temp.store.save({
        version: 1,
        groups: [{ id: 'g-a', name: '', parentId: null, sessionIds: [] }],
        ungrouped: [],
      }),
    (error) => error?.code === 'invalid' && error.errors.some((entry) => entry.startsWith('group-name:')),
  )
  assert.deepEqual(await list(temp.storages), [])
})

test('T3.2: createStore needs an explicit path and accepts the {dir,fileName} shape', () => {
  assert.throws(() => createStore(), /createStore: pass \{ filePath \} or \{ dir, fileName \}/)
  const store = createStore({ dir: join(tmpdir(), 'dsg-store-shape-check'), fileName: 'record.json' })
  assert.equal(store.path, join(tmpdir(), 'dsg-store-shape-check', 'record.json'))
})

test('T3.2: a non-object JSON payload is quarantined as corrupt-file', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await writeFile(temp.filePath, '42', 'utf8')
  const result = await temp.store.load()
  assert.equal(result.warning, 'corrupt-file')
  assert.match(result.detail, /not a JSON object/)
})

test('T3.2: a wrong-version record recovers the last valid backup', async (t) => {
  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await temp.store.commit(0, sampleDoc())
  await temp.store.commit(1, sampleDoc())
  await writeFile(temp.filePath, JSON.stringify({ ...sampleDoc(), version: 0, revision: 3 }), 'utf8')
  const loaded = await temp.store.load()
  assert.equal(loaded.warning, 'recovered-backup')
  assert.equal(loaded.revision, 1)
  assert.match(loaded.detail, /version must be 1/)
})

test('T3.2: a first quarantine-target collision gets a numeric suffix', async (t) => {
  const fixedNow = () => 1_760_000_000_000
  const temp = await makeTempStore(fixedNow)
  t.after(temp.cleanup)
  const stamp = new Date(fixedNow()).toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const firstTarget = join(temp.storages, `dsh-session-grove.corrupt-${stamp}.json`)
  await writeFile(firstTarget, 'already-there', 'utf8')
  await writeFile(temp.filePath, '{broken', 'utf8')
  const result = await temp.store.load()
  assert.equal(result.warning, 'corrupt-file')
  assert.equal(result.quarantinedTo, join(temp.storages, `dsh-session-grove.corrupt-${stamp}-1.json`))
})

test('T3.2: peek propagates IO errors and classifies wrong-version/non-object payloads', async (t) => {
  const directoryStore = await makeTempStore()
  t.after(directoryStore.cleanup)
  await mkdir(directoryStore.filePath, { recursive: true })
  await assert.rejects(
    () => createStore({ filePath: directoryStore.filePath }).peek(),
    /EISDIR|illegal operation on a directory/,
  )

  const temp = await makeTempStore()
  t.after(temp.cleanup)
  await writeFile(temp.filePath, JSON.stringify({ version: 0, revision: 1, groups: [], ungrouped: [] }), 'utf8')
  const wrongVersion = await temp.store.peek()
  assert.equal(wrongVersion.kind, 'invalid')
  assert.match(wrongVersion.detail, /version must be 1/)

  await writeFile(temp.filePath, 'null', 'utf8')
  const nonObject = await temp.store.peek()
  assert.equal(nonObject.kind, 'corrupt')
  assert.match(nonObject.detail, /not a JSON object/)
})
