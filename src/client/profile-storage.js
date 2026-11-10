/**
 * Profile preview preference storage (SPEC §7.6/§9.3).
 *
 * Owns the localStorage flag that lets the preview dialog footer and the manage
 * dialog share the "switch directly next time" preference. Both callers pass an
 * optional storage override (tests do); the default is the client-safe
 * `safeStorage()` adapter from the state module.
 */
import { safeStorage } from './state.js'

/** localStorage flag: `'0'` means "switch directly next time" (SPEC §7.6). */
const PROFILE_PREVIEW_KEY = 'dsh-session-grove.profilePreview.v1'

const readProfilePreviewDisabled = (storage = safeStorage()) => {
  try {
    return storage?.getItem(PROFILE_PREVIEW_KEY) === '0'
  } catch {
    return false
  }
}

const writeProfilePreviewDisabled = (disabled, storage = safeStorage()) => {
  try {
    if (disabled) storage?.setItem(PROFILE_PREVIEW_KEY, '0')
    else storage?.removeItem(PROFILE_PREVIEW_KEY)
  } catch {
    /* blocked storage keeps the in-memory preference only */
  }
}

export { PROFILE_PREVIEW_KEY, readProfilePreviewDisabled, writeProfilePreviewDisabled }
