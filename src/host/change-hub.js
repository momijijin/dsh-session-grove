/**
 * Host-side revision/active fan-out for browser clients.
 *
 * Native-tool and HTTP commits both update the Host store. Without a push
 * channel the sidebar's client-side snapshot stays stale until a reload. This
 * hub is intentionally small: one SSE response per connected browser and a
 * revision/active payload; the client refetches through its normal load route.
 *
 * Multi-profile (SPEC 5.9):
 * - `revision` carries the profile it belongs to: `{ profileId, revision, source }`;
 * - `active` announces a global switch: `{ activeId, registryRevision }`.
 * Older clients ignore the added field/event; the hub never replays the active
 * profile on connect (the client loads it explicitly).
 */
import { DEFAULT_PROFILE_ID } from './constants.js'

const normalizedProfileId = (value) =>
  typeof value === 'string' && value.length > 0 ? value : DEFAULT_PROFILE_ID

export const createChangeHub = () => {
  const clients = new Set()
  let closed = false

  const broadcast = (payload) => {
    for (const client of [...clients]) {
      try {
        client.write(payload)
      } catch {
        clients.delete(client)
      }
    }
  }

  const publish = (revision, source = 'host', profileId = DEFAULT_PROFILE_ID) => {
    if (closed || !Number.isInteger(revision) || revision < 0) return
    const payload = `event: revision\ndata: ${JSON.stringify({
      profileId: normalizedProfileId(profileId),
      revision,
      source,
    })}\n\n`
    broadcast(payload)
  }

  /** Announce a global active-profile switch (SPEC 5.8/5.9). */
  const publishActive = (activeId, registryRevision) => {
    if (closed || typeof activeId !== 'string' || activeId.length === 0) return
    if (!Number.isInteger(registryRevision) || registryRevision < 0) return
    broadcast(
      `event: active\ndata: ${JSON.stringify({ activeId, registryRevision })}\n\n`,
    )
  }

  const subscribe = (client) => {
    if (closed) return () => {}
    clients.add(client)
    return () => {
      clients.delete(client)
    }
  }

  const close = () => {
    if (closed) return
    closed = true
    for (const client of [...clients]) {
      try {
        client.end()
      } catch {
        /* detached response */
      }
    }
    clients.clear()
  }

  return { publish, publishActive, subscribe, close, get size() { return clients.size } }
}
