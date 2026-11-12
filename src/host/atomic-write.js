/**
 * Shared atomic-write helpers for the host JSON files.
 *
 * 0.4.0-beta.65 (SPEC §7.1): the document store and the profile registry each
 * carried a byte-for-byte copy of this retry/temp/fsync family. Both now import
 * this module so the write path can only drift in one place.
 *
 * Contract (unchanged from the two local copies):
 * - a transient Windows sharing/lock failure (EACCES/EPERM/EBUSY/EMFILE/ENFILE)
 *   is retried up to `WRITE_ATTEMPTS` times with `WRITE_RETRY_DELAY_MS`
 *   backoff; anything else is rethrown untouched;
 * - the temp file name is `<filePath>.<pid>.<8 hex>.tmp` (same file, same stem);
 * - the directory fsync is best-effort: Windows cannot open a directory as a
 *   file, so a failure there must never fail the write.
 */

import { randomBytes } from 'node:crypto'
import { open, stat } from 'node:fs/promises'

export const RETRYABLE_CODES = new Set(['EACCES', 'EPERM', 'EBUSY', 'EMFILE', 'ENFILE'])
export const WRITE_ATTEMPTS = 4
export const WRITE_RETRY_DELAY_MS = 20

export const sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

/** Retry the transient Windows sharing/lock failures an atomic replace can hit. */
export const withRetries = async (operation) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const code = error?.code ?? ''
      if (attempt >= WRITE_ATTEMPTS || !RETRYABLE_CODES.has(code)) throw error
      await sleep(WRITE_RETRY_DELAY_MS)
    }
  }
}

export const pathExists = async (path) => {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/** Best-effort directory fsync (Windows cannot open a directory as a file). */
export const syncDirectory = async (directory) => {
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch {
    // Durability point unavailable on this platform; file fsync already ran.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export const quarantineTimestamp = (now) =>
  new Date(now()).toISOString().replaceAll(':', '-').replaceAll('.', '-')

export const temporaryPathForWrite = (filePath) =>
  `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
