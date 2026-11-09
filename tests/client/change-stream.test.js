import test from 'node:test'
import assert from 'node:assert/strict'

import { createChangeStream } from '../../src/adapters/change-stream.js'
import { createApi } from '../../src/client/api.js'
import {
  createExternalChangeRouter,
  createStore,
  revisionAppliesToDocument,
  revisionEventPlan,
} from '../../src/client/state.js'

const fakeStorage = () => {
  const map = new Map()
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)) }
}

const docAt = (revision) => ({ version: 1, revision, groups: [], ungrouped: [] })

const makeStore = ({ profileId = 'default', revision = 3 } = {}) => {
  const store = createStore({ storage: fakeStorage() })
  store.dispatch('load-success', { doc: docAt(revision), revision, profileId })
  return store
}

const makeEventSource = () => {
  class FakeEventSource {
    static instances = []
    constructor(url, options) {
      this.url = url
      this.options = options
      this.listeners = new Map()
      this.closed = false
      FakeEventSource.instances.push(this)
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener)
    }
    removeEventListener(type, listener) {
      if (this.listeners.get(type) === listener) this.listeners.delete(type)
    }
    emit(type, event) {
      this.listeners.get(type)?.(event)
    }
    close() {
      this.closed = true
    }
  }
  return FakeEventSource
}

test('change stream wires revision and reconnect callbacks', () => {
  const Fake = makeEventSource()
  const revisions = []
  const opens = []
  const errors = []
  const stream = createChangeStream({
    EventSourceImpl: Fake,
    url: '/dsh-session-grove/events',
    onRevision: (event) => revisions.push(event.data),
    onOpen: () => opens.push(true),
    onError: (error) => errors.push(error),
  })
  const source = Fake.instances[0]
  assert.equal(source.url, '/dsh-session-grove/events')
  assert.deepEqual(source.options, { withCredentials: true })

  source.emit('revision', { data: '{"revision":3}' })
  source.onopen()
  source.onerror(new Error('offline'))
  assert.deepEqual(revisions, ['{"revision":3}'])
  assert.deepEqual(opens, [true])
  assert.equal(errors.length, 1)

  stream.close()
  assert.equal(source.closed, true)
  assert.equal(source.listeners.size, 0)
})

test('missing EventSource yields a null stream without throwing', () => {
  assert.equal(createChangeStream({ EventSourceImpl: null, url: '/x' }), null)
  assert.equal(createChangeStream({ EventSourceImpl: function Broken() { throw new Error('no') }, url: '/x' }), null)
})

test('revision scoping accepts the active profile and rejects every other one', () => {
  assert.equal(revisionAppliesToDocument('work-1', 'work-1'), true)
  assert.equal(revisionAppliesToDocument('work-2', 'work-1'), false)
  assert.equal(revisionAppliesToDocument(undefined, 'work-1'), true, 'legacy host omits profileId')
  assert.equal(revisionAppliesToDocument(null, 'work-1'), true)
  assert.equal(revisionAppliesToDocument('work-1', null), false, 'unknown active cannot be matched')

  const plan = revisionEventPlan({
    profileId: 'work-2',
    revision: 9,
    activeId: 'work-1',
    currentRevision: 3,
    latestSeenRevision: 4,
  })
  assert.equal(plan.accepted, false)
  assert.equal(plan.refresh, false)
  assert.equal(plan.latestSeenRevision, 4)

  const activePlan = revisionEventPlan({
    profileId: 'work-1',
    revision: 9,
    activeId: 'work-1',
    currentRevision: 3,
    latestSeenRevision: 4,
  })
  assert.deepEqual(activePlan, { accepted: true, refresh: true, latestSeenRevision: 9 })
})

test('non-active revisions never refresh or advance latestSeenRevision', () => {
  const store = makeStore({ profileId: 'work-1', revision: 3 })
  let refreshes = 0
  const router = createExternalChangeRouter({
    store,
    requestRefresh: () => {
      refreshes += 1
    },
  })

  assert.equal(router.revision({ profileId: 'work-2', revision: 9 }), false)
  assert.equal(refreshes, 0)
  assert.equal(store.getSnapshot().latestSeenRevision, 0)
  assert.equal(store.getSnapshot().doc.revision, 3)

  assert.equal(router.revision({ profileId: 'work-1', revision: 9 }), true)
  assert.equal(refreshes, 1)
  assert.equal(store.getSnapshot().latestSeenRevision, 9)

  // A lower revision for the same profile is seen but never triggers a reload.
  assert.equal(router.revision({ profileId: 'work-1', revision: 2 }), false)
  assert.equal(refreshes, 1)
  assert.equal(store.getSnapshot().latestSeenRevision, 9)
})

test('a revision without profileId is treated as the active profile (old host)', () => {
  const store = makeStore({ profileId: 'work-1', revision: 3 })
  let refreshes = 0
  const router = createExternalChangeRouter({
    store,
    requestRefresh: () => {
      refreshes += 1
    },
  })
  assert.equal(router.revision({ revision: 5 }), true)
  assert.equal(refreshes, 1)
  assert.equal(store.getSnapshot().latestSeenRevision, 5)
})

test('an active event resets epoch and latestSeenRevision and asks for a reload', () => {
  const store = makeStore({ profileId: 'work-1', revision: 3 })
  store.dispatch('external-revision', { latestSeenRevision: 11 })
  store.dispatch('optimistic-doc', { doc: { ...docAt(3), groups: [{ id: 'x' }] } })
  const changes = []
  const router = createExternalChangeRouter({
    store,
    onActiveChange: (activeId, info) => changes.push({ activeId, ...info }),
  })

  assert.equal(router.active({ activeId: 'work-2', registryRevision: 7 }), true)
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.profileEpoch, 1)
  assert.equal(snapshot.latestSeenRevision, 0)
  assert.equal(snapshot.profiles.activeId, 'work-2')
  assert.equal(snapshot.profiles.registryRevision, 7)
  assert.equal(snapshot.optimistic, false)
  assert.equal(snapshot.docState, 'loading')
  assert.deepEqual(changes, [{ activeId: 'work-2', changed: true, local: false, registryRevision: 7 }])

  assert.equal(router.active({ activeId: 'work-2', registryRevision: 8 }), false)
  assert.equal(store.getSnapshot().profileEpoch, 1, 'a repeated active event does not bump again')
  assert.equal(changes.length, 2)
  assert.equal(changes[1].changed, false)
})

test('the local activate echo is suppressed instead of showing a passive switch', () => {
  const store = makeStore({ profileId: 'default', revision: 2 })
  store.dispatch('profile-switch-start', { targetId: 'work-1' })
  const changes = []
  const router = createExternalChangeRouter({
    store,
    requestRefresh: () => {
      throw new Error('must not reload for our own activate echo')
    },
    onActiveChange: (activeId, info) => changes.push({ activeId, ...info }),
    isLocalSwitch: (activeId) => activeId === 'work-1',
  })
  assert.equal(router.active({ activeId: 'work-1', registryRevision: 4 }), false)
  assert.equal(store.getSnapshot().profileEpoch, 0)
  assert.equal(store.getSnapshot().profiles.activeId, 'default')
  assert.equal(store.getSnapshot().profileSwitching, true)
  assert.deepEqual(changes, [{ activeId: 'work-1', changed: false, local: true, registryRevision: 4 }])
})

test('old host /profiles 404 downgrades to single-profile without touching the doc', async () => {
  const fetchImpl = async () => ({
    status: 404,
    ok: false,
    headers: { get: () => 'text/html' },
    json: async () => {
      throw new Error('no body')
    },
  })
  const result = await createApi({ fetchImpl, baseURI: 'http://x/' }).listProfiles()
  assert.equal(result.profilesAvailable, false)
  assert.equal(result.routeUnavailable, true)

  const store = makeStore({ profileId: 'default', revision: 3 })
  store.dispatch('profiles-unavailable')
  assert.equal(store.getSnapshot().profiles.available, false)
  assert.equal(store.getSnapshot().docState, 'ready')
  assert.equal(store.getSnapshot().doc.revision, 3)
})

test('EventSource revision and active events feed the profile-aware router', () => {
  const Fake = makeEventSource()
  const store = makeStore({ profileId: 'work-1', revision: 3 })
  const refreshes = []
  const router = createExternalChangeRouter({
    store,
    requestRefresh: () => refreshes.push(true),
  })
  const stream = createChangeStream({
    EventSourceImpl: Fake,
    url: '/dsh-session-grove/events',
    onRevision: (event) => router.revision(JSON.parse(event.data)),
  })
  const source = Fake.instances[0]
  source.addEventListener('active', (event) => router.active(JSON.parse(event.data)))

  source.emit('revision', { data: '{"profileId":"work-2","revision":9}' })
  assert.equal(refreshes.length, 0)
  assert.equal(store.getSnapshot().latestSeenRevision, 0)

  source.emit('revision', { data: '{"profileId":"work-1","revision":9}' })
  assert.equal(refreshes.length, 1)
  assert.equal(store.getSnapshot().latestSeenRevision, 9)

  source.emit('active', { data: '{"activeId":"work-2","registryRevision":5}' })
  assert.equal(store.getSnapshot().profileEpoch, 1)
  assert.equal(store.getSnapshot().latestSeenRevision, 0)
  assert.equal(store.getSnapshot().profiles.activeId, 'work-2')

  stream.close()
  assert.equal(source.closed, true)
})
