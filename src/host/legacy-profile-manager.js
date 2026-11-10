/**
 * Legacy single-store profile manager adapter (SPEC 7.3).
 *
 * `registerRoutes` accepts either a full profile manager or, for direct-route
 * tests and the frozen integration harness, a bare store. This module owns the
 * detection and the minimal manager view over that single store; no registry
 * file is read or written.
 */
import { dirname } from 'node:path'
import { DEFAULT_PROFILE_ID } from './constants.js'

export const isProfileManager = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.loadRegistry === 'function' &&
  typeof value.storeFor === 'function' &&
  typeof value.peekFor === 'function' &&
  typeof value.entryFor === 'function'

/**
 * Minimal manager over a single legacy store (direct-route tests and the
 * frozen integration harness pass only a store). The active profile is always
 * `default`; no registry file is read or written.
 */
export const createLegacyProfileManager = (store) => {
  const defaultEntry = () => ({ id: DEFAULT_PROFILE_ID, name: null, dir: '.', archivedAt: null })
  const assertDefault = (id) => {
    if (id !== DEFAULT_PROFILE_ID) {
      throw Object.assign(new Error(`unknown profile: ${String(id)}`), { code: 'invalid-profile-id' })
    }
  }
  return {
    // Informational only: the legacy adapter's routes never derive artifacts
    // from a profile path, and synthetic test stores may omit `path`.
    storageDir: typeof store?.path === 'string' && store.path.length > 0 ? dirname(store.path) : null,
    activeId: async () => DEFAULT_PROFILE_ID,
    activeStore: async () => store,
    storeFor: (id) => {
      assertDefault(id)
      return store
    },
    peekFor: (id) => {
      assertDefault(id)
      return store.peek()
    },
    entryFor: async (id) => (id === DEFAULT_PROFILE_ID ? defaultEntry() : null),
    loadRegistry: async () => ({
      kind: 'ok',
      registry: { version: 1, revision: 0, activeId: DEFAULT_PROFILE_ID, profiles: [defaultEntry()] },
      revision: 0,
      exists: false,
      degraded: false,
    }),
  }
}
