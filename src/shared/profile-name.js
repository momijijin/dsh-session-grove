/**
 * Profile display-name policy shared by the host registry and the HTTP/tool
 * profile policy (issue #5, SPEC §7.5#2).
 *
 * Pure functions only: trim + length/control-char validation and the
 * case-insensitive duplicate check over the unarchived profiles. The registry
 * re-validates under its CAS lock; this module exists so callers cannot drift
 * from one another.
 */
import { hasControlChars } from './model.js'
import { MAX_PROFILE_NAME } from './profile-limits.js'

/**
 * Validate a profile display name. The stored form is the trimmed string.
 * @param {unknown} name
 * @returns {{ ok: true, name: string } | { ok: false, reason: string }}
 */
const normalizeProfileName = (name) => {
  if (typeof name !== 'string') return { ok: false, reason: 'name-required' }
  const text = name.trim()
  if (text.length === 0) return { ok: false, reason: 'name-required' }
  if (text.length > MAX_PROFILE_NAME) return { ok: false, reason: 'name-too-long' }
  if (hasControlChars(text)) return { ok: false, reason: 'name-control-chars' }
  return { ok: true, name: text }
}

/** Case-insensitive duplicate check over the unarchived profiles (SPEC 4.3). */
const profileNameTaken = (registry, name, exceptId = null) => {
  const key = name.trim().toLowerCase()
  return registry.profiles.some(
    (profile) =>
      profile.archivedAt === null &&
      profile.id !== exceptId &&
      typeof profile.name === 'string' &&
      profile.name.trim().toLowerCase() === key,
  )
}

export { normalizeProfileName, profileNameTaken }
