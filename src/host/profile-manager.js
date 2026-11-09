/**
 * Per-profile store manager (SPEC 4.5).
 *
 * Maps profile ids to the one document store each profile owns:
 * - default -> `<storageDir>/dsh-session-grove.json` (the existing record file);
 * - named   -> `<storageDir>/profiles/<id>/dsh-session-grove.json`.
 *
 * Stores are cached by resolved absolute path so a profile keeps the same store
 * identity for the lifetime of the manager (`useSyncExternalStore` depends on
 * it). Creating the manager performs no filesystem work; nothing is written
 * until a caller commits or a profile document is created.
 */

import { readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  DEFAULT_PROFILE_ID,
  PROFILES_DIR_NAME,
  RECORD_FILE_NAME,
  REGISTRY_FILE_NAME,
} from './constants.js'
import { createProfileRegistry, isProfileId } from './profile-registry.js'
import { createStore } from './store.js'

const invalidProfileId = (id) =>
  Object.assign(new Error(`invalid profile id: ${String(id)}`), { code: 'invalid-profile-id' })

/**
 * Create the profile manager over one storages directory.
 *
 * @param {{
 *   storageDir: string,
 *   registryFilePath?: string,
 *   defaultRecordPath?: string,
 *   now?: () => number,
 *   storeOptions?: object,
 * }} options
 */
const createProfileManager = (options = {}) => {
  const { storageDir, registryFilePath, defaultRecordPath, now = () => Date.now(), storeOptions } = options
  if (typeof storageDir !== 'string' || storageDir.length === 0) {
    throw new Error('createProfileManager: storageDir is required')
  }
  const storageRoot = resolve(storageDir)
  const profilesDir = join(storageRoot, PROFILES_DIR_NAME)
  const defaultFilePath = resolve(defaultRecordPath ?? join(storageRoot, RECORD_FILE_NAME))
  const resolvedRegistryPath = resolve(registryFilePath ?? join(storageRoot, REGISTRY_FILE_NAME))
  const registry = createProfileRegistry({ filePath: resolvedRegistryPath, now })
  const stores = new Map()

  const assertProfileId = (id) => {
    if (!isProfileId(id)) throw invalidProfileId(id)
    return id
  }

  /** Absolute directory of a profile; rejects ids that escape `storageDir`. */
  const dirFor = (id) => {
    assertProfileId(id)
    const directory = id === DEFAULT_PROFILE_ID ? storageRoot : join(profilesDir, id)
    const inside = relative(storageRoot, directory)
    if (inside.startsWith('..') || isAbsolute(inside)) throw invalidProfileId(id)
    return directory
  }

  /** Absolute document path of a profile. */
  const pathFor = (id) => {
    assertProfileId(id)
    return id === DEFAULT_PROFILE_ID ? defaultFilePath : join(dirFor(id), RECORD_FILE_NAME)
  }

  /** Stable store instance per resolved document path. */
  const storeFor = (id) => {
    const filePath = resolve(pathFor(id))
    let store = stores.get(filePath)
    if (store === undefined) {
      store = createStore({ filePath, now, ...storeOptions })
      stores.set(filePath, store)
    }
    return store
  }

  const loadRegistry = () => registry.load()

  /** Active profile id; a degraded registry resolves to `default`. */
  const activeId = async () => {
    const state = await loadRegistry()
    return state.kind === 'ok' ? state.registry.activeId : DEFAULT_PROFILE_ID
  }

  const activeStore = async () => storeFor(await activeId())

  /** Registry entry for one id, or `null` when it is not registered. */
  const entryFor = async (id) => {
    assertProfileId(id)
    const state = await loadRegistry()
    if (state.kind !== 'ok') return null
    return state.registry.profiles.find((profile) => profile.id === id) ?? null
  }

  /** Read-only document health for one profile (never quarantines). */
  const peekFor = (id) => storeFor(id).peek()

  /** Read-only registry classification. */
  const peekRegistry = () => registry.peek()

  /**
   * On-disk profile directories with no registry entry (SPEC 4.4/4.8 orphan
   * reporting). Read-only: uses the registry peek, never heals or writes.
   */
  const orphans = async () => {
    const state = await registry.peek()
    const known = new Set(state.kind === 'ok' ? state.registry.profiles.map((profile) => profile.id) : [])
    let entries
    try {
      entries = await readdir(profilesDir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    return entries
      .filter((entry) => entry.isDirectory() && isProfileId(entry.name) && !known.has(entry.name))
      .map((entry) => entry.name)
      .sort()
  }

  return {
    storageDir: storageRoot,
    profilesDir,
    defaultFilePath,
    registryFilePath: resolvedRegistryPath,
    registry,
    dirFor,
    pathFor,
    storeFor,
    loadRegistry,
    activeId,
    activeStore,
    entryFor,
    peekFor,
    peekRegistry,
    orphans,
  }
}

export { createProfileManager }
