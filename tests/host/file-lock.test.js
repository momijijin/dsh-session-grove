import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LOCK_RETRY_MS, LOCK_STALE_MS, LOCK_WAIT_MS, createFileLock } from '../../src/host/file-lock.js'

const makeTempDir = () => mkdtemp(join(tmpdir(), 'dsg-lock-'))

const livePayload = () =>
  JSON.stringify({ pid: process.pid, token: 'live', createdAt: new Date().toISOString() })

test('the default lock timings match the frozen host contract', () => {
  assert.equal(LOCK_WAIT_MS, 5_000)
  assert.equal(LOCK_STALE_MS, 30_000)
  assert.equal(LOCK_RETRY_MS, 20)
})

test('withLock runs the task under a written lock and removes it on release', async () => {
  const dir = await makeTempDir()
  try {
    const filePath = join(dir, 'storages', 'dsh-session-grove.json')
    const lockPath = `${filePath}.lock`
    const { withLock } = createFileLock({ filePath, busyMessage: 'group store is busy' })

    let payload = null
    const result = await withLock(async () => {
      payload = JSON.parse(await readFile(lockPath, 'utf8'))
      return 'done'
    })

    assert.equal(result, 'done')
    assert.equal(payload.pid, process.pid)
    assert.match(payload.token, /^[0-9a-f]{16}$/)
    assert.equal(Number.isNaN(Date.parse(payload.createdAt)), false)
    assert.equal(existsSync(lockPath), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('withLock releases the lock when the task throws', async () => {
  const dir = await makeTempDir()
  try {
    const filePath = join(dir, 'record.json')
    const lockPath = `${filePath}.lock`
    const { withLock } = createFileLock({ filePath, busyMessage: 'group store is busy' })

    await assert.rejects(
      () =>
        withLock(async () => {
          throw new Error('task failed')
        }),
      /task failed/,
    )
    assert.equal(existsSync(lockPath), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a second lock waits for the current holder and then enters', async () => {
  const dir = await makeTempDir()
  try {
    const filePath = join(dir, 'record.json')
    const lockPath = `${filePath}.lock`
    const first = createFileLock({ filePath, busyMessage: 'busy', lockWaitMs: 2_000, lockRetryMs: 5 })
    const second = createFileLock({ filePath, busyMessage: 'busy', lockWaitMs: 2_000, lockRetryMs: 5 })

    const order = []
    let enteredResolve
    const entered = new Promise((resolve) => {
      enteredResolve = resolve
    })
    let releaseResolve
    const gate = new Promise((resolve) => {
      releaseResolve = resolve
    })

    const firstRun = first.withLock(async () => {
      order.push('first')
      enteredResolve()
      await gate
    })
    await entered
    const secondRun = second.withLock(async () => {
      order.push('second')
    })
    releaseResolve()
    await Promise.all([firstRun, secondRun])

    assert.deepEqual(order, ['first', 'second'])
    assert.equal(existsSync(lockPath), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a live lock times out with the caller-provided busy message and store-busy code', async () => {
  const dir = await makeTempDir()
  try {
    const payload = livePayload()
    for (const [name, busyMessage] of [
      ['store', 'group store is busy'],
      ['registry', 'profile registry is busy'],
    ]) {
      const filePath = join(dir, `${name}.json`)
      const lockPath = `${filePath}.lock`
      await writeFile(lockPath, payload, 'utf8')
      const { withLock } = createFileLock({ filePath, busyMessage, lockWaitMs: 40, lockRetryMs: 5 })

      await assert.rejects(
        () => withLock(async () => 'never'),
        (error) => error?.code === 'store-busy' && error?.message === busyMessage,
      )
      assert.equal(existsSync(lockPath), true)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a lock from a dead pid with an old mtime is reclaimed', async () => {
  const dir = await makeTempDir()
  try {
    const filePath = join(dir, 'record.json')
    const lockPath = `${filePath}.lock`
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999, token: 'dead', createdAt: '2000-01-01T00:00:00.000Z' }),
      'utf8',
    )
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    const { withLock } = createFileLock({
      filePath,
      busyMessage: 'group store is busy',
      lockWaitMs: 500,
      lockStaleMs: 50,
    })
    const held = await withLock(async () => JSON.parse(await readFile(lockPath, 'utf8')))

    assert.equal(held.pid, process.pid)
    assert.equal(existsSync(lockPath), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('release never deletes a lock whose token changed under it', async () => {
  const dir = await makeTempDir()
  try {
    const filePath = join(dir, 'record.json')
    const lockPath = `${filePath}.lock`
    const foreign = JSON.stringify({
      pid: process.pid,
      token: 'foreign-token',
      createdAt: new Date().toISOString(),
    })
    const { withLock } = createFileLock({ filePath, busyMessage: 'group store is busy' })

    await withLock(async () => {
      // Another writer re-took the lock while this holder still believes it owns it.
      await writeFile(lockPath, foreign, 'utf8')
    })

    assert.equal(existsSync(lockPath), true)
    assert.equal(await readFile(lockPath, 'utf8'), foreign)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
