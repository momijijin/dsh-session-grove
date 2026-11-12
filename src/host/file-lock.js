/**
 * Cross-process advisory lock over one JSON file.
 *
 * 0.4.0-beta.65 (SPEC §7.1): the document store and the profile registry each
 * carried a byte-for-byte copy of this lock family; only the busy message
 * differed. Both now build their `withLock` here and pass their own
 * `busyMessage`, so behavior, error code and timing stay identical:
 *
 * - one `<filePath>.lock` file created with `wx` and written as pretty JSON
 *   (`pid`, `token`, `createdAt`) plus a trailing newline, fsynced before use;
 * - a lock whose PID is dead or whose mtime is older than `lockStaleMs` is
 *   reclaimed (re-read/compare before removing so a live replacement survives);
 * - contention is retried every `lockRetryMs` until `lockWaitMs` elapses, then
 *   fails with `code: 'store-busy'` and the caller-provided message;
 * - release is best-effort and token-checked: a lock owned by someone else is
 *   never deleted.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sleep } from './atomic-write.js'

export const LOCK_WAIT_MS = 5_000
export const LOCK_STALE_MS = 30_000
export const LOCK_RETRY_MS = 20

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Create the lock accessor over one file.
 *
 * @param {{ filePath: string, busyMessage: string, lockWaitMs?: number, lockStaleMs?: number, lockRetryMs?: number }} options
 * @returns {{ withLock: <T>(task: () => Promise<T>) => Promise<T> }}
 */
export const createFileLock = ({
  filePath,
  busyMessage,
  lockWaitMs = LOCK_WAIT_MS,
  lockStaleMs = LOCK_STALE_MS,
  lockRetryMs = LOCK_RETRY_MS,
}) => {
  const directory = dirname(filePath)
  const lockPath = `${filePath}.lock`

  const isProcessAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error?.code === 'EPERM'
    }
  }

  const readLock = async () => {
    let text
    try {
      text = await readFile(lockPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      // A malformed lock is treated as stale by mtime below.
    }
    let mtimeMs = 0
    try {
      mtimeMs = (await stat(lockPath)).mtimeMs
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
    return { text, data: isObject(data) ? data : null, mtimeMs }
  }

  const reclaimStaleLock = async () => {
    const current = await readLock()
    if (current === null) return true
    const age = Date.now() - current.mtimeMs
    const pid = current.data?.pid
    const ownerAlive = isProcessAlive(pid)
    if (age <= lockStaleMs && ownerAlive) return false
    try {
      // Compare before removing so a lock replaced by a live writer is not
      // accidentally deleted between the read and the remove.
      const latest = await readFile(lockPath, 'utf8')
      if (latest === current.text) await rm(lockPath, { force: true })
      return true
    } catch (error) {
      return error?.code === 'ENOENT'
    }
  }

  const acquireLock = async () => {
    await mkdir(directory, { recursive: true })
    const token = randomBytes(8).toString('hex')
    const payload = `${JSON.stringify(
      {
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`
    const deadline = Date.now() + lockWaitMs
    for (;;) {
      let handle
      try {
        handle = await open(lockPath, 'wx')
        await handle.writeFile(payload, 'utf8')
        await handle.sync()
        await handle.close()
        handle = null
        return async () => {
          try {
            const info = await readLock()
            if (info?.data?.token === token) await rm(lockPath, { force: true })
          } catch {
            // Releasing a lock is best-effort; stale recovery handles crashes.
          }
        }
      } catch (error) {
        await handle?.close().catch(() => undefined)
        if (error?.code !== 'EEXIST') throw error
        if (await reclaimStaleLock()) continue
        if (Date.now() >= deadline) {
          throw Object.assign(new Error(busyMessage), { code: 'store-busy' })
        }
        await sleep(lockRetryMs)
      }
    }
  }

  const withLock = async (task) => {
    const release = await acquireLock()
    try {
      return await task()
    } finally {
      await release()
    }
  }

  return { withLock }
}
