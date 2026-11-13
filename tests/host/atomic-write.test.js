import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RETRYABLE_CODES,
  WRITE_ATTEMPTS,
  WRITE_RETRY_DELAY_MS,
  pathExists,
  quarantineTimestamp,
  syncDirectory,
  temporaryPathForWrite,
  withRetries,
} from '../../src/host/atomic-write.js'

const makeTempDir = () => mkdtemp(join(tmpdir(), 'dsg-atomic-'))

const transientError = (code) => Object.assign(new Error(`transient ${code}`), { code })

test('the retry constants match the frozen host contract', () => {
  assert.deepEqual([...RETRYABLE_CODES].sort(), ['EACCES', 'EBUSY', 'EMFILE', 'ENFILE', 'EPERM'])
  assert.equal(WRITE_ATTEMPTS, 4)
  assert.equal(WRITE_RETRY_DELAY_MS, 20)
})

test('withRetries retries a transient code and returns the eventual result', async () => {
  let attempts = 0
  const result = await withRetries(async () => {
    attempts += 1
    if (attempts < 3) throw transientError('EBUSY')
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.equal(attempts, 3)
})

test('withRetries rethrows a non-retryable code immediately', async () => {
  let attempts = 0
  await assert.rejects(
    () =>
      withRetries(async () => {
        attempts += 1
        throw transientError('ENOENT')
      }),
    (error) => error?.code === 'ENOENT',
  )
  assert.equal(attempts, 1)

  let codelessAttempts = 0
  await assert.rejects(
    () =>
      withRetries(async () => {
        codelessAttempts += 1
        throw new Error('no code')
      }),
    /no code/,
  )
  assert.equal(codelessAttempts, 1)
})

test('withRetries gives up after WRITE_ATTEMPTS attempts', async () => {
  let attempts = 0
  await assert.rejects(
    () =>
      withRetries(async () => {
        attempts += 1
        throw transientError('EPERM')
      }),
    (error) => error?.code === 'EPERM',
  )
  assert.equal(attempts, WRITE_ATTEMPTS)
})

test('pathExists reports presence and ENOENT without hiding other errors', async () => {
  const dir = await makeTempDir()
  try {
    const filePath = join(dir, 'record.json')
    await writeFile(filePath, '{}\n', 'utf8')
    assert.equal(await pathExists(filePath), true)
    assert.equal(await pathExists(dir), true)
    assert.equal(await pathExists(join(dir, 'missing.json')), false)
    // Node rejects a NUL byte in a path before touching the filesystem; that is
    // not ENOENT and must surface instead of reading as "absent".
    await assert.rejects(
      () => pathExists('invalid\u0000path'),
      (error) => error?.code !== 'ENOENT',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('syncDirectory is best-effort: it resolves for a usable and an unusable path', async () => {
  const dir = await makeTempDir()
  try {
    await assert.doesNotReject(() => syncDirectory(dir))
    await assert.doesNotReject(() => syncDirectory(join(dir, 'does-not-exist')))
    const filePath = join(dir, 'record.json')
    await writeFile(filePath, '{}\n', 'utf8')
    await assert.doesNotReject(() => syncDirectory(filePath))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('quarantineTimestamp renders the ISO stamp with dashes instead of colon/dot', () => {
  const fixed = Date.UTC(2024, 0, 2, 3, 4, 5, 678)
  const stamp = quarantineTimestamp(() => fixed)
  assert.equal(stamp, '2024-01-02T03-04-05-678Z')
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/)
})

test('temporaryPathForWrite embeds the target path, the pid and 8 random hex chars', () => {
  const firstPath = join(tmpdir(), 'dsg-store', 'dsh-session-grove.json')
  const secondPath = join(tmpdir(), 'dsg-store', 'dsh-session-grove.profiles.json')
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escapeRegExp(firstPath)}\\.${process.pid}\\.[0-9a-f]{8}\\.tmp$`)

  const first = temporaryPathForWrite(firstPath)
  const second = temporaryPathForWrite(firstPath)
  assert.match(first, pattern)
  assert.match(second, pattern)
  assert.notEqual(first, second)
  assert.ok(first.startsWith(`${firstPath}.`))
  assert.ok(first.endsWith('.tmp'))
  assert.ok(temporaryPathForWrite(secondPath).startsWith(`${secondPath}.`))
})
