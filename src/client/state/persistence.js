/**
 * View-state persistence adapter (SPEC 7.2).
 *
 * Owns the localStorage keys, the safe storage accessor, the per-key readers and
 * writers and the collapsed-table normalization. Pure and React-free: the store
 * in 'state.js' injects an optional storage override for tests and blocked
 * host documents.
 */
import { ARCHIVE_FILTERS } from '../../shared/constants.js'

/** localStorage key for the sidebar mode (`groups` | `workspace`). */
export const VIEW_MODE_KEY = 'dsh-session-grove.view.v1'
/** localStorage key for the archive tri-state filter. */
export const ARCHIVE_FILTER_KEY = 'dsh-session-grove.archive.v1'
/**
 * localStorage key for the group archive tri-state filter
 * (0.4.0-beta.62 SPEC §4.1). Independent from the session archive filter.
 */
export const GROUP_ARCHIVE_FILTER_KEY = 'dsh-session-grove.archive.groups.v1'
/**
 * localStorage key for the group-archive confirmation opt-out
 * (0.4.0-beta.62 UI patch). `'true'` skips the confirm dialog; reset-layout
 * writes it back to `'false'`.
 */
export const ARCHIVE_CONFIRM_SKIP_KEY = 'dsh-session-grove.archive.confirm-skip.v1'
/** localStorage key for persisted group expansion, scoped by profile id. */
export const COLLAPSED_KEY = 'dsh-session-grove.collapsed.v1'
/** localStorage key for the one-time groups-view onboarding card. */
export const ONBOARDING_KEY = 'dsh-session-grove.onboarded.v1'
/**
 * localStorage key for the one-time workspace-header entry hint
 * (0.4.0-beta.63). Separate from `ONBOARDING_KEY`: the hint fires before the
 * user ever sees the groups view, so entering the view cannot count as having
 * read the card.
 */
export const ENTRY_HINT_KEY = 'dsh-session-grove.entry.v1'

/** Host default profile id (mirrors `src/host/constants.js` on the wire). */
export const DEFAULT_PROFILE_ID = 'default'

/** Safe localStorage accessor (SSR / tests / disabled storage return null). */
export const safeStorage = () => {
  try {
    const storage = globalThis.localStorage
    if (storage && typeof storage.getItem === 'function') return storage
  } catch {
    /* storage may be blocked by the host document policy */
  }
  return null
}

/** Read the persisted view mode; default is the shipped workspace browser. */
export const readViewMode = (storage = safeStorage()) => {
  try {
    return storage?.getItem(VIEW_MODE_KEY) === 'groups' ? 'groups' : 'workspace'
  } catch {
    return 'workspace'
  }
}

/** Persist the view mode (best effort: blocked storage keeps session state only). */
export const writeViewMode = (mode, storage = safeStorage()) => {
  try {
    storage?.setItem(VIEW_MODE_KEY, mode === 'groups' ? 'groups' : 'workspace')
  } catch {
    /* ignore */
  }
}

/** Read the persisted archive filter; default hides archived sessions. */
export const readArchiveFilter = (storage = safeStorage()) => {
  try {
    const raw = storage?.getItem(ARCHIVE_FILTER_KEY)
    return ARCHIVE_FILTERS.includes(raw) ? raw : 'hidden'
  } catch {
    return 'hidden'
  }
}

/** Persist the archive filter. */
export const writeArchiveFilter = (filter, storage = safeStorage()) => {
  try {
    storage?.setItem(ARCHIVE_FILTER_KEY, ARCHIVE_FILTERS.includes(filter) ? filter : 'hidden')
  } catch {
    /* ignore */
  }
}

/** Read the persisted group archive filter; default hides archived groups. */
export const readGroupArchiveFilter = (storage = safeStorage()) => {
  try {
    const raw = storage?.getItem(GROUP_ARCHIVE_FILTER_KEY)
    return ARCHIVE_FILTERS.includes(raw) ? raw : 'hidden'
  } catch {
    return 'hidden'
  }
}

/** Persist the group archive filter. */
export const writeGroupArchiveFilter = (filter, storage = safeStorage()) => {
  try {
    storage?.setItem(GROUP_ARCHIVE_FILTER_KEY, ARCHIVE_FILTERS.includes(filter) ? filter : 'hidden')
  } catch {
    /* ignore */
  }
}

/**
 * Whether the user opted out of the archive-group confirmation dialog.
 * Only the exact string `'true'` counts; every other or blocked value is false.
 */
export const readArchiveConfirmSkip = (storage = safeStorage()) => {
  try {
    return storage?.getItem(ARCHIVE_CONFIRM_SKIP_KEY) === 'true'
  } catch {
    return false
  }
}

/**
 * Persist the archive confirmation opt-out as an explicit `'true'`/`'false'`.
 * Best effort: blocked storage keeps the in-memory behavior for this window.
 */
export const writeArchiveConfirmSkip = (skip, storage = safeStorage()) => {
  try {
    storage?.setItem(ARCHIVE_CONFIRM_SKIP_KEY, skip === true ? 'true' : 'false')
  } catch {
    /* ignore */
  }
}

/** Keep only the expanded-by-default contract: `id: true` entries. */
const normalizeCollapsedIds = (value) => {
  const collapsed = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return collapsed
  for (const [id, flag] of Object.entries(value)) {
    if (id && flag === true) collapsed[id] = true
  }
  return collapsed
}

/**
 * Read the whole collapsed table (`{[profileId]: {groupId: true}}`).
 *
 * Legacy values (`{groupId: true}`, every value boolean) predate profiles:
 * they belong to the default profile and are upgraded on the next write.
 */
export const readCollapsedTable = (storage = safeStorage()) => {
  try {
    const raw = storage?.getItem(COLLAPSED_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const entries = Object.entries(parsed)
    if (entries.length === 0) return {}
    if (entries.every(([, value]) => typeof value === 'boolean')) {
      const legacy = normalizeCollapsedIds(parsed)
      return Object.keys(legacy).length > 0 ? { [DEFAULT_PROFILE_ID]: legacy } : {}
    }
    const table = {}
    for (const [profileId, value] of entries) {
      if (!profileId) continue
      const collapsed = normalizeCollapsedIds(value)
      if (Object.keys(collapsed).length > 0) table[profileId] = collapsed
    }
    return table
  } catch {
    return {}
  }
}

/** Read one profile's collapsed ids; the default profile stays the fallback. */
export const readCollapsed = (storage = safeStorage(), profileId = DEFAULT_PROFILE_ID) => {
  const table = readCollapsedTable(storage)
  return table[profileId] ?? {}
}

/**
 * Persist one profile's collapsed ids, preserving every other profile's map.
 * The first write also upgrades a legacy flat value to the scoped shape.
 */
export const writeCollapsed = (collapsed, storage = safeStorage(), profileId = DEFAULT_PROFILE_ID) => {
  try {
    const table = readCollapsedTable(storage)
    const normalized = normalizeCollapsedIds(collapsed)
    if (Object.keys(normalized).length === 0) delete table[profileId]
    else table[profileId] = normalized
    storage?.setItem(COLLAPSED_KEY, JSON.stringify(table))
  } catch {
    /* ignore */
  }
}

/** Whether the user has dismissed the first-run onboarding card. */
export const readOnboardingDone = (storage = safeStorage()) => {
  try {
    return storage?.getItem(ONBOARDING_KEY) === '1'
  } catch {
    return false
  }
}

/** Persist the onboarding dismissal; best effort. */
export const writeOnboardingDone = (storage = safeStorage()) => {
  try {
    storage?.setItem(ONBOARDING_KEY, '1')
  } catch {
    /* ignore */
  }
}

/** Whether the one-time workspace-header entry hint was dismissed. */
export const readEntryHintDone = (storage = safeStorage()) => {
  try {
    return storage?.getItem(ENTRY_HINT_KEY) === '1'
  } catch {
    return false
  }
}

/** Persist the entry-hint dismissal (clicking the toggle also counts). */
export const writeEntryHintDone = (storage = safeStorage()) => {
  try {
    storage?.setItem(ENTRY_HINT_KEY, '1')
  } catch {
    /* ignore */
  }
}
