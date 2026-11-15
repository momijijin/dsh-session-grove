import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PERF_STORAGE_KEY,
  buildRecord,
  flushRecords,
  installPerfApi,
  perfBeginGesture,
  perfCount,
  perfDragOver,
  perfDropTarget,
  perfEnabled,
  perfEndGesture,
  perfMark,
  perfMs,
  perfNow,
  perfRender,
  perfReset,
  perfSample,
  perfSidebarWidth,
  perfSnapshot,
  perfSpan,
  perfTreeCounts,
  startPerfReporter,
  stopPerfReporter,
} from '../../src/client/perf.js'
import { PERF_MEASURE_BUILD, PLUGIN_VERSION } from '../../src/shared/constants.js'

const clearFlag = () => {
  try { delete globalThis.__DSG_PERF__ } catch { globalThis.__DSG_PERF__ = undefined }
}

/** Fake `localStorage` that answers the perf key with `value`. */
const stubStorage = (value) => {
  const previous = globalThis.localStorage
  globalThis.localStorage = { getItem: (key) => (key === PERF_STORAGE_KEY ? value : null) }
  return () => {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
}

/** Capture every POST the reporter/flush would send. */
const capturePosts = () => {
  const previous = globalThis.fetch
  const posts = []
  globalThis.fetch = async (url, init) => {
    posts.push({ url: String(url), payload: JSON.parse(init.body) })
    return { ok: true, status: 200 }
  }
  return {
    posts,
    restore: () => {
      if (previous === undefined) delete globalThis.fetch
      else globalThis.fetch = previous
    },
  }
}

/**
 * Install the browser-ish surface `startPerfReporter` needs and return handles
 * to its fakes. Nothing real is scheduled: intervals and animation frames only
 * land in arrays, and the `PerformanceObserver` records what it was asked to
 * observe so the LoAF/long-task paths can be told apart.
 *
 * `supportedEntryTypes` is what the fake observes as statically supported (omit
 * it to exercise the fallback path). `loafObserverThrows` makes the first
 * construction fail, which covers a browser that advertises LoAF but refuses to
 * observe it; `loafObserveThrows` makes the first `observe()` call fail instead
 * (the constructor succeeds, the registration is refused).
 */
const stubReporterEnv = ({ supportedEntryTypes = null, loafObserverThrows = false, loafObserveThrows = false } = {}) => {
  const real = {
    document: globalThis.document,
    performance: globalThis.performance,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    PerformanceObserver: globalThis.PerformanceObserver,
  }
  let clock = 0
  const doc = {
    baseURI: 'http://127.0.0.1:4400/',
    visibilityState: 'visible',
    createElement: () => ({}),
    addEventListener(type, fn) {
      if (type === 'visibilitychange') doc.onVisibility = fn
    },
    removeEventListener(type, fn) {
      if (type === 'visibilitychange' && doc.onVisibility === fn) doc.onVisibility = null
    },
    onVisibility: null,
  }
  const intervals = []
  const frames = []
  const pageHide = []
  const observers = []
  let throwOnce = loafObserverThrows
  let observeThrowOnce = loafObserveThrows
  class FakePerformanceObserver {
    constructor(callback) {
      this.callback = callback
      this.observed = null
      this.disconnected = false
      if (throwOnce) {
        throwOnce = false
        throw new Error('long animation frames unavailable')
      }
      observers.push(this)
    }
    observe(options) {
      if (observeThrowOnce) {
        observeThrowOnce = false
        throw new Error('long animation frames refused')
      }
      this.observed = options
    }
    disconnect() {
      this.disconnected = true
    }
  }
  if (supportedEntryTypes !== null) FakePerformanceObserver.supportedEntryTypes = supportedEntryTypes
  globalThis.document = doc
  globalThis.performance = { now: () => clock }
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms, cleared: false }
    intervals.push(handle)
    return handle
  }
  globalThis.clearInterval = (handle) => {
    if (handle) handle.cleared = true
  }
  globalThis.requestAnimationFrame = (fn) => {
    frames.push(fn)
    return frames.length
  }
  globalThis.cancelAnimationFrame = (handle) => {
    frames[handle - 1] = null
  }
  globalThis.addEventListener = (type, fn) => {
    if (type === 'pagehide') pageHide.push(fn)
  }
  globalThis.removeEventListener = (type, fn) => {
    if (type !== 'pagehide') return
    const index = pageHide.indexOf(fn)
    if (index !== -1) pageHide.splice(index, 1)
  }
  globalThis.PerformanceObserver = FakePerformanceObserver
  return {
    doc,
    intervals,
    frames,
    pageHide,
    observers,
    observerFor: (entryType) =>
      observers.find((observer) => observer.observed?.entryTypes?.includes(entryType)) ?? null,
    setClock: (value) => {
      clock = value
    },
    runFrames: () => {
      const pending = frames.splice(0)
      for (const frame of pending) frame?.()
    },
    restore: () => {
      if (real.document === undefined) delete globalThis.document
      else globalThis.document = real.document
      globalThis.performance = real.performance
      globalThis.setInterval = real.setInterval
      globalThis.clearInterval = real.clearInterval
      if (real.requestAnimationFrame === undefined) delete globalThis.requestAnimationFrame
      else globalThis.requestAnimationFrame = real.requestAnimationFrame
      if (real.cancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame
      else globalThis.cancelAnimationFrame = real.cancelAnimationFrame
      globalThis.addEventListener = real.addEventListener
      globalThis.removeEventListener = real.removeEventListener
      globalThis.PerformanceObserver = real.PerformanceObserver
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('the .66 perf batch captures by default and the localStorage 0 opt-out wins', () => {
  clearFlag()
  const restore = stubStorage('0')
  try {
    const disabled = perfReset()
    assert.equal(disabled.enabled, false)
    assert.equal(perfEnabled(), false)
    perfCount('ignored')
    perfRender('ignored')
    perfSample('dragOverMs', 10)
    perfMark('ignored')
    perfDragOver('ignored', 10)
    perfDropTarget(true, 10)
    assert.deepEqual(perfSnapshot().counters, {})
    assert.deepEqual(perfSnapshot().renders, {})
    assert.equal(perfSnapshot().marks.length, 0)
    assert.equal(perfSnapshot().samples.dragOverMs.count, 0)
    assert.equal(buildRecord('window'), null, 'a disabled capture never queues a record')
    assert.equal(perfSnapshot().outboxSize, 0)
  } finally {
    restore()
    perfReset()
  }

  // The build constant alone enables capture.
  assert.equal(perfReset().enabled, true)
  assert.equal(perfEnabled(), true)

  // The historical global opt-in still works, but this batch ships with
  // `PERF_MEASURE_BUILD === true`, so capture is already on and a plain
  // `assert.equal(perfEnabled(), true)` here would be a vacuous assertion.
  // The opt-in cannot be observed separately while the constant is `true`; what
  // is observable in this batch is `'0'` overriding the constant *and* the flag.
  globalThis.__DSG_PERF__ = true
  if (PERF_MEASURE_BUILD !== true) {
    assert.equal(perfReset().enabled, true, 'the historical global opt-in still enables capture')
  }
  const restoreOptOut = stubStorage('0')
  try {
    assert.equal(perfReset().enabled, false)
  } finally {
    restoreOptOut()
    clearFlag()
    perfReset()
  }
})

test('perf aggregates counters, samples, marks and drag/drop durations', () => {
  globalThis.__DSG_PERF__ = true
  perfReset()
  try {
    perfCount('commits', 2)
    perfCount('commits')
    perfRender('SessionRow')
    perfRender('SessionRow')
    perfSample('dragOverMs', 1.234)
    perfSample('dragOverMs', Number.NaN)
    perfSample('unknownSample', 1)
    perfMark('drop', { target: 's1' })
    perfDragOver('onDragOverSession', 4.5, { invalid: true })
    perfDragOver('onDragOverSession', 2)
    perfDropTarget(true, 3)
    perfDropTarget(false)

    const snapshot = perfSnapshot()
    assert.equal(snapshot.enabled, true)
    assert.equal(snapshot.counters.commits, 3)
    assert.equal(snapshot.renders.SessionRow, 2)
    assert.equal(snapshot.marks.length, 1)
    assert.deepEqual(snapshot.marks[0].detail, { target: 's1' })
    assert.equal(snapshot.dragOver.events, 2)
    assert.equal(snapshot.dragOver.invalid, 1)
    assert.equal(snapshot.dragOver.maxMs, 4.5)
    assert.equal(snapshot.dragOver.avgMs, 3.25)
    assert.equal(snapshot.dropTarget.calls, 2)
    assert.equal(snapshot.dropTarget.changes, 1)
    assert.deepEqual(snapshot.samples.dragOverMs, { count: 3, min: 1.23, avg: 2.58, p50: 2, p95: 4.5, max: 4.5 })
    assert.equal(typeof perfNow(), 'number')
  } finally {
    clearFlag()
    perfReset()
  }
})

test('perf bounds samples and marks and exposes the probe API', () => {
  globalThis.__DSG_PERF__ = true
  perfReset()
  try {
    for (let index = 0; index < 401; index += 1) perfSample('dragOverMs', index)
    for (let index = 0; index < 4001; index += 1) perfMark('mark', index)
    const snapshot = perfSnapshot()
    assert.equal(snapshot.samples.dragOverMs.count, 400)
    assert.equal(snapshot.samples.dragOverMs.min, 1)
    assert.equal(snapshot.samples.dragOverMs.max, 400)
    assert.equal(snapshot.marks.length, 4000)
    assert.equal(snapshot.marks[0].detail, 1)

    installPerfApi()
    assert.equal(typeof globalThis.__dsgPerfApi.snapshot, 'function')
    assert.equal(typeof globalThis.__dsgPerfApi.reset, 'function')
    assert.equal(typeof globalThis.__dsgPerfApi.beginGesture, 'function')
    assert.equal(typeof globalThis.__dsgPerfApi.endGesture, 'function')
    assert.equal(typeof globalThis.__dsgPerfApi.flush, 'function')
    assert.equal(typeof globalThis.__dsgPerfApi.start, 'function')
    assert.equal(typeof globalThis.__dsgPerfApi.stop, 'function')
    assert.equal(globalThis.__dsgPerfApi.enabled(), true)
  } finally {
    clearFlag()
    perfReset()
    delete globalThis.__dsgPerfApi
  }
})

test('the per-record sample window keeps the newest samples past 400', async () => {
  perfReset()
  const capture = capturePosts()
  try {
    // The reporter samples `frameGapMs` on every frame, so 400 frames (~6.7 s)
    // fill the per-record window long before the next record. The window must
    // roll forward like `state.samples`: keeping the oldest values would make a
    // gesture record summarize the idle frames from *before* the gesture.
    for (let index = 1; index <= 500; index += 1) perfSample('frameGapMs', index)

    // The session window keeps the newest 400 too (101..500, not 1..400).
    assert.equal(perfSnapshot().samples.frameGapMs.count, 400)
    assert.equal(perfSnapshot().samples.frameGapMs.min, 101)

    assert.notEqual(buildRecord('window', null, 15000), null)
    assert.equal(await flushRecords(), 1)
    const summarized = capture.posts[0].payload.record.deltas.samples.frameGapMs
    assert.equal(summarized.count, 400, 'the per-record window is bounded by MAX_SAMPLES')
    assert.equal(summarized.min, 101, 'the oldest 100 samples were dropped, never the newest 400')
    assert.equal(summarized.max, 500)
  } finally {
    capture.restore()
    perfReset()
  }
})

test('a record summarizes the window samples and resets the deltas', async () => {
  perfReset()
  const capture = capturePosts()
  try {
    for (const value of [10, 20, 30, 40, 50]) perfSample('widthFrameMs', value)
    perfCount('width:frame', 3)
    assert.notEqual(buildRecord('window', null, 15000), null)
    assert.equal(await flushRecords(), 1)
    const record = capture.posts[0].payload.record
    assert.equal(record.kind, 'window')
    assert.equal(record.gesture, null)
    assert.equal(record.durationMs, 15000)
    assert.deepEqual(record.deltas.samples.widthFrameMs, { count: 5, min: 10, avg: 30, p50: 30, p95: 50, max: 50 })
    assert.equal(record.deltas.counters['width:frame'], 3)

    // Deltas are per record: the next one starts empty, and the render block is
    // always present with the seven documented names.
    buildRecord('window', null, 5000)
    assert.equal(await flushRecords(), 1)
    const empty = capture.posts[1].payload.record
    assert.deepEqual(empty.deltas.samples, {})
    assert.deepEqual(empty.deltas.counters, {})
    assert.deepEqual(Object.keys(empty.deltas.renders).sort(), [
      'DialogHost',
      'GroupNode',
      'GroupsView',
      'Header',
      'ScrollArea',
      'SessionRow',
      'UngroupedSection',
    ])
    for (const name of Object.keys(empty.deltas.renders)) assert.equal(empty.deltas.renders[name], 0)
    assert.deepEqual(empty.deltas.dragOver, { events: 0, totalMs: 0, maxMs: 0, invalid: 0, byHandler: {} })
    assert.deepEqual(empty.deltas.dropTarget, { calls: 0, changes: 0 })
  } finally {
    capture.restore()
    perfReset()
  }
})

test('the width CSS-variable and pointer-lag samples land in a record (P2/N5)', async () => {
  perfReset()
  const capture = capturePosts()
  try {
    // `widthCssVarMs` must be a known sample name; an unlisted name is silently
    // dropped by `perfSample`, which would hide the new per-frame write.
    perfSample('widthCssVarMs', 0.12)
    perfSample('widthCssVarMs', 0.18)
    // N5: the handle's rAF records how far the pointer moved ahead of the line.
    perfSample('width:pointerLagMs', 18)
    perfCount('width:cssVar', 2)
    perfCount('width:frame', 2)
    assert.equal(perfSnapshot().samples.widthCssVarMs.count, 2)
    assert.equal(perfSnapshot().samples['width:pointerLagMs'].count, 1)

    assert.notEqual(buildRecord('window', 'width-resize', 1000), null)
    assert.equal(await flushRecords(), 1)
    const record = capture.posts[0].payload.record
    assert.equal(record.gesture, 'width-resize')
    assert.deepEqual(record.deltas.samples.widthCssVarMs, { count: 2, min: 0.12, avg: 0.15, p50: 0.18, p95: 0.18, max: 0.18 })
    assert.deepEqual(record.deltas.samples['width:pointerLagMs'], { count: 1, min: 18, avg: 18, p50: 18, p95: 18, max: 18 })
    assert.equal(record.deltas.counters['width:cssVar'], 2)
    assert.equal(record.deltas.counters['width:frame'], 2)
  } finally {
    capture.restore()
    perfReset()
  }
})

test('the gesture lifecycle builds one privacy-safe record from the window deltas', async () => {
  perfReset()
  const capture = capturePosts()
  try {
    perfTreeCounts(32, 142)
    perfSidebarWidth(560)
    perfBeginGesture('drag-session')
    perfRender('GroupsView')
    perfRender('SessionRow')
    perfRender('SessionRow')
    perfCount('drag:check', 2)
    perfCount('drag:rect')
    perfDragOver('onDragOverSession', 1.5)
    perfMark('drop:event', { handler: 'onDragOverSession' })
    perfEndGesture('drag-session')
    assert.equal(perfSnapshot().gesture, null)
    assert.equal(perfSnapshot().outboxSize, 1)

    assert.equal(await flushRecords(), 1)
    const { url, payload } = capture.posts[0]
    assert.equal(url.endsWith('/dsh-session-grove/perf'), true, `unexpected perf url ${url}`)
    assert.equal(payload.runId, perfSnapshot().runId)
    assert.equal(payload.schemaVersion, 1)
    const record = payload.record
    assert.deepEqual(Object.keys(record).sort(), ['deltas', 'durationMs', 'env', 'gesture', 'kind', 'state'])
    assert.equal(record.kind, 'gesture')
    assert.equal(record.gesture, 'drag-session')
    assert.equal(typeof record.durationMs, 'number')
    assert.equal(record.deltas.renders.GroupsView, 1)
    assert.equal(record.deltas.renders.SessionRow, 2)
    assert.equal(record.deltas.counters['drag:check'], 2)
    assert.equal(record.deltas.dragOver.events, 1)
    assert.equal(record.deltas.dragOver.byHandler.onDragOverSession, 1)
    assert.equal(record.deltas.marks, undefined, 'marks are final-only')
    assert.deepEqual(record.state, {
      groups: 32,
      sessions: 142,
      treeRows: 0,
      scrollHeight: 0,
      clientHeight: 0,
      viewportWidth: 0,
      viewportHeight: 0,
      dpr: 1,
      sidebarWidth: 560,
    })
    assert.equal(record.env.version, PLUGIN_VERSION)
    assert.deepEqual(Object.keys(record.env).sort(), ['deviceMemory', 'hardwareConcurrency', 'ua', 'version'])
    // Privacy: no session id, title, group name or path field anywhere.
    const text = JSON.stringify(record)
    for (const forbidden of ['sessionId', 'groupId', 'title', 'groupName']) {
      assert.equal(text.includes(forbidden), false, `record must not carry ${forbidden}`)
    }
  } finally {
    capture.restore()
    perfReset()
  }
})

test('gesture pairing builds exactly one record per opened gesture', async () => {
  perfReset()
  const previousFetch = globalThis.fetch
  // A rejected POST never drains the outbox, so the synchronous assertions below
  // can count records without waiting on the retry flushes that `perfBeginGesture`
  // kicks off.
  globalThis.fetch = async () => ({ ok: false, status: 503 })
  try {
    // Re-beginning the same gesture keeps the window open: a scroll burst must
    // not build one record per event.
    perfBeginGesture('scroll')
    perfBeginGesture('scroll')
    perfEndGesture('scroll')
    assert.equal(perfSnapshot().gesture, null)
    assert.equal(perfSnapshot().outboxSize, 1, 'a same-name re-begin stays one record')

    // A different name closes the open gesture before the new one starts.
    perfBeginGesture('drag-session')
    perfBeginGesture('drag-group')
    assert.equal(perfSnapshot().gesture, 'drag-group')
    assert.equal(perfSnapshot().outboxSize, 2, 'the previous gesture was closed by the new begin')

    // A mismatched (or garbage) name never closes the open gesture.
    perfEndGesture('drag-session')
    assert.equal(perfSnapshot().gesture, 'drag-group')
    assert.equal(perfSnapshot().outboxSize, 2, 'a mismatched end is a no-op')

    perfEndGesture('drag-group')
    assert.equal(perfSnapshot().gesture, null)
    assert.equal(perfSnapshot().outboxSize, 3)

    // `drop` and `dragend` both end the same drag: only the first one builds.
    perfBeginGesture('drag-session')
    perfEndGesture('drag-session')
    perfEndGesture('drag-session')
    assert.equal(perfSnapshot().outboxSize, 4, 'the second end of a closed gesture is a no-op')

    // An end without a begin is a no-op too.
    perfEndGesture('scroll')
    assert.equal(perfSnapshot().gesture, null)
    assert.equal(perfSnapshot().outboxSize, 4)
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }

  // Deliver the queued records (in order) and check the paired names.
  const capture = capturePosts()
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(await flushRecords(), 4)
    assert.deepEqual(
      capture.posts.map((post) => post.payload.record.gesture),
      ['scroll', 'drag-session', 'drag-group', 'drag-session']
    )
    for (const post of capture.posts) assert.equal(post.payload.record.kind, 'gesture')
  } finally {
    capture.restore()
    perfReset()
  }
})

test('only the final record carries the last 200 marks', async () => {
  perfReset()
  const capture = capturePosts()
  try {
    for (let index = 0; index < 250; index += 1) perfMark('tick', index)
    buildRecord('final', 'idle')
    assert.equal(await flushRecords(), 1)
    const record = capture.posts[0].payload.record
    assert.equal(record.kind, 'final')
    assert.equal(record.gesture, 'idle')
    assert.equal(record.deltas.marks.length, 200)
    assert.equal(record.deltas.marks[199].detail, 249)
  } finally {
    capture.restore()
    perfReset()
  }
})

test('a failed flush keeps the queued records and the outbox stays bounded', async () => {
  perfReset()
  const previousFetch = globalThis.fetch
  let online = false
  globalThis.fetch = async () => {
    if (!online) throw new Error('offline')
    return { ok: true, status: 200 }
  }
  try {
    buildRecord('window', null, 1000)
    buildRecord('window', null, 1000)
    assert.equal(perfSnapshot().outboxSize, 2)
    assert.equal(await flushRecords(), 0)
    assert.equal(perfSnapshot().outboxSize, 2, 'a failed POST stays queued for the next flush')

    online = true
    assert.equal(await flushRecords(), 2)
    assert.equal(perfSnapshot().outboxSize, 0)

    // Cap 20: the oldest record is dropped and counted.
    for (let index = 0; index < 21; index += 1) buildRecord('window', null, 100)
    assert.equal(perfSnapshot().outboxSize, 20)
    assert.equal(perfSnapshot().counters['perf:dropped'], 1)
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
    perfReset()
  }
})

test('a cap drop while a POST is in flight loses only the record it counts', async () => {
  const previousFetch = globalThis.fetch
  const expectedDurations = []
  for (let index = 1; index <= 21; index += 1) {
    if (index !== 2) expectedDurations.push(index)
  }

  // Successful POST: the cap drops one queued record, the in-flight record is
  // still delivered and the success path removes exactly it.
  perfReset()
  const delivered = []
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let firstPost = true
  globalThis.fetch = async (url, init) => {
    if (!firstPost) throw new Error('offline')
    firstPost = false
    delivered.push(JSON.parse(init.body))
    await gate
    return { ok: true, status: 200 }
  }
  try {
    for (let index = 1; index <= 20; index += 1) buildRecord('window', null, index)
    const pending = flushRecords()
    // The first record is on the wire and its POST is waiting on the gate.
    buildRecord('window', null, 21)
    assert.equal(perfSnapshot().outboxSize, 20, 'the cap still bounds the outbox at 20')
    assert.equal(perfSnapshot().counters['perf:dropped'], 1, 'the cap drop is counted exactly once')
    release()
    assert.equal(await pending, 1, 'only the in-flight record was delivered')
    assert.equal(perfSnapshot().outboxSize, 19, 'the success path removed no unsent record')
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
  const successCapture = capturePosts()
  try {
    assert.equal(await flushRecords(), 19)
    const durations = [...delivered, ...successCapture.posts.map((post) => post.payload)]
      .map((payload) => payload.record.durationMs)
      .sort((left, right) => left - right)
    assert.deepEqual(durations, expectedDurations, 'only the counted cap drop is missing')
  } finally {
    successCapture.restore()
    perfReset()
  }

  // Failed POST: the cap must not remove the record that is on the wire. A
  // positional shift on the failed response would discard it without a retry
  // and silently deliver the record that should have been the cap victim.
  let failRelease
  const failGate = new Promise((resolve) => {
    failRelease = resolve
  })
  let failCalls = 0
  globalThis.fetch = async () => {
    failCalls += 1
    if (failCalls > 1) throw new Error('offline')
    await failGate
    throw new Error('offline')
  }
  try {
    for (let index = 1; index <= 20; index += 1) buildRecord('window', null, index)
    const pending = flushRecords()
    buildRecord('window', null, 21)
    assert.equal(perfSnapshot().counters['perf:dropped'], 1)
    failRelease()
    assert.equal(await pending, 0, 'the in-flight POST failed')
    assert.equal(perfSnapshot().outboxSize, 20, 'the failed in-flight record stays queued for the retry')
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = previousFetch
  }
  const retryCapture = capturePosts()
  try {
    assert.equal(await flushRecords(), 20)
    const durations = retryCapture.posts
      .map((post) => post.payload.record.durationMs)
      .sort((left, right) => left - right)
    assert.deepEqual(durations, expectedDurations, 'the failed record was retried; only the cap drop is missing')
  } finally {
    retryCapture.restore()
    perfReset()
  }
})

test('perfSpan and perfMs measure without swallowing exceptions', () => {
  perfReset()
  try {
    assert.equal(perfMs('toggleUpdateMs', () => 42), 42)
    assert.throws(
      () => perfMs('toggleUpdateMs', () => {
        throw new Error('boom')
      }),
      /boom/
    )
    const stop = perfSpan('treeScrollFrameMs')
    stop()
    stop()
    buildRecord('window', null, 1)
    assert.equal(perfSnapshot().samples.toggleUpdateMs.count, 2, 'the throwing call is still sampled')
    assert.equal(perfSnapshot().samples.treeScrollFrameMs.count, 1, 'stop() is idempotent')
  } finally {
    perfReset()
  }
})

test('the reporter never starts outside a browser', () => {
  perfReset()
  try {
    assert.equal(typeof globalThis.document, 'undefined', 'this suite runs in plain Node')
    assert.equal(startPerfReporter(), false)
    assert.equal(stopPerfReporter(), false)
    assert.equal(perfSnapshot().outboxSize, 0)
  } finally {
    perfReset()
  }
})

test('the final flush prefers navigator.sendBeacon and falls back to fetch keepalive', async () => {
  perfReset()
  const capture = capturePosts()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const beacons = []
  const setNavigator = (value) => Object.defineProperty(globalThis, 'navigator', { configurable: true, value })
  setNavigator({
    sendBeacon: (url, blob) => {
      beacons.push({ url, blob })
      return true
    },
  })
  try {
    buildRecord('window', null, 1000)
    buildRecord('final', 'idle')
    assert.equal(await flushRecords({ beacon: true }), 2)
    assert.equal(beacons.length, 2, 'each queued record goes through sendBeacon first')
    assert.equal(capture.posts.length, 0)
    assert.equal(beacons[0].url, 'http://localhost/dsh-session-grove/perf')
    assert.equal(await beacons[0].blob.text().then((text) => JSON.parse(text).record.kind), 'window')

    // A refused beacon is retried through fetch keepalive in the same flush.
    setNavigator({ sendBeacon: () => false })
    buildRecord('final', 'idle')
    assert.equal(await flushRecords({ beacon: true }), 1)
    assert.equal(capture.posts.length, 1, 'a refused beacon falls back to fetch')
  } finally {
    if (descriptor === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', descriptor)
    capture.restore()
    perfReset()
  }
})

test('a tick without increments still retries a failed outbox', async () => {
  // Only the pieces `startPerfReporter` touches are faked. There is no rAF, so
  // no frame ticker is installed and the 15 s tick stays deterministic.
  const real = {
    document: globalThis.document,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    fetch: globalThis.fetch,
  }
  const doc = {
    baseURI: 'http://127.0.0.1:4401/',
    visibilityState: 'visible',
    createElement: () => ({}),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const intervals = []
  globalThis.document = doc
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms, cleared: false }
    intervals.push(handle)
    return handle
  }
  globalThis.clearInterval = (handle) => {
    if (handle) handle.cleared = true
  }
  globalThis.addEventListener = () => {}
  globalThis.removeEventListener = () => {}
  let online = false
  const delivered = []
  globalThis.fetch = async (url, init) => {
    if (!online) throw new Error('offline')
    delivered.push(JSON.parse(init.body))
    return { ok: true, status: 200 }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  perfReset()
  try {
    assert.equal(startPerfReporter(), true)
    assert.equal(intervals.length, 1)
    assert.equal(intervals[0].ms, 15000)

    buildRecord('window', null, 1000)
    assert.equal(await flushRecords(), 0, 'offline: the record is not delivered')
    assert.equal(perfSnapshot().outboxSize, 1)

    // No increments since the record was built: the tick builds nothing but
    // must still retry the queued POST.
    intervals[0].fn()
    await settle()
    assert.equal(perfSnapshot().outboxSize, 1, 'still offline: the record stays queued')

    online = true
    intervals[0].fn()
    await settle()
    assert.equal(perfSnapshot().outboxSize, 0, 'the increment-free tick retried the failed POST')
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].record.kind, 'window')
  } finally {
    // Stop the reporter through the fakes before restoring them.
    perfReset()
    if (real.document === undefined) delete globalThis.document
    else globalThis.document = real.document
    globalThis.setInterval = real.setInterval
    globalThis.clearInterval = real.clearInterval
    globalThis.addEventListener = real.addEventListener
    globalThis.removeEventListener = real.removeEventListener
    if (real.fetch === undefined) delete globalThis.fetch
    else globalThis.fetch = real.fetch
  }
})

test('the reporter flushes idle windows, finals, long tasks and frame gaps in a browser-like environment', async () => {
  // Everything the reporter touches is faked so the whole browser path runs in
  // plain Node: a clock, a document with listeners, interval/rAF queues and a
  // PerformanceObserver stub. No real timer is installed.
  const env = stubReporterEnv()
  const capture = capturePosts()

  perfReset()
  try {
    assert.equal(startPerfReporter(), true)
    assert.equal(startPerfReporter(), false, 'the reporter starts once per page')
    assert.equal(env.intervals.length, 1)
    assert.equal(env.intervals[0].ms, 15000)
    // No LoAF support in this fake: the long-task observer is the fallback and
    // no LoAF observer may be attached alongside it.
    const longTaskObserver = env.observerFor('longtask')
    assert.notEqual(longTaskObserver, null, 'the long-task observer is the fallback')
    assert.deepEqual(longTaskObserver.observed, { entryTypes: ['longtask'] })
    assert.equal(env.observerFor('long-animation-frame'), null)

    // Gesture record: begins/ends in the browser path exactly like a drag.
    perfBeginGesture('width-resize')
    env.setClock(500)
    perfEndGesture('width-resize')
    assert.equal(perfSnapshot().outboxSize, 1)
    await flushRecords()
    assert.equal(capture.posts.length, 1)
    assert.equal(capture.posts[0].payload.record.kind, 'gesture')
    assert.deepEqual(capture.posts[0].payload.record.deltas.loaf, [], 'a gesture record always carries the loaf block')

    // Frame-gap ticker: the first tick only sets the baseline.
    env.setClock(500)
    env.runFrames()
    env.setClock(516)
    env.runFrames()
    env.setClock(550)
    env.runFrames()
    // Long-task observer feeds the same window.
    longTaskObserver.callback({ getEntries: () => [{ duration: 120 }] })

    // Idle window: the last gesture was 19.5 s ago and a render landed.
    env.setClock(20000)
    perfRender('GroupsView')
    env.intervals[0].fn()
    await settle()
    assert.equal(capture.posts.length, 2)
    const idleWindow = capture.posts[1].payload.record
    assert.equal(idleWindow.kind, 'window')
    assert.equal(idleWindow.gesture, 'idle')
    assert.equal(idleWindow.deltas.renders.GroupsView, 1)
    assert.equal(idleWindow.deltas.samples.longTaskMs.count, 1)
    assert.equal(idleWindow.deltas.samples.frameGapMs.count, 2)
    assert.deepEqual(idleWindow.deltas.loaf, [])

    // A window with no increments is skipped.
    env.intervals[0].fn()
    await settle()
    assert.equal(capture.posts.length, 2, 'no increment means no window record')

    // Visibility hidden final, then the pagehide final (after a visible reset).
    perfMark('tick', 1)
    env.doc.visibilityState = 'hidden'
    env.doc.onVisibility()
    await settle()
    assert.equal(capture.posts.length, 3)
    assert.equal(capture.posts[2].payload.record.kind, 'final')
    assert.equal(capture.posts[2].payload.record.deltas.marks.length, 1)

    env.doc.visibilityState = 'visible'
    env.doc.onVisibility()
    perfMark('tick', 2)
    env.pageHide[0]()
    await settle()
    assert.equal(capture.posts.length, 4)
    assert.equal(capture.posts[3].payload.record.kind, 'final')
    assert.equal(capture.posts[3].payload.record.deltas.marks.length, 2)

    assert.equal(capture.posts[3].url, 'http://127.0.0.1:4400/dsh-session-grove/perf')

    // Teardown releases the interval, observer, frame and listeners.
    assert.equal(stopPerfReporter(), true)
    assert.equal(env.intervals[0].cleared, true)
    assert.equal(longTaskObserver.disconnected, true)
    assert.equal(env.pageHide.length, 0)
    assert.equal(env.doc.onVisibility, null)
    assert.equal(stopPerfReporter(), false)
  } finally {
    capture.restore()
    env.restore()
    perfReset()
  }
})

// ---------------------------------------------------------------------------
// Long Animation Frame (LoAF) attribution (spec §8.2)
// ---------------------------------------------------------------------------

test('without LoAF support the reporter keeps the longtask observer as the fallback', async () => {
  const env = stubReporterEnv({ supportedEntryTypes: ['longtask', 'paint'] })
  const capture = capturePosts()
  perfReset()
  try {
    assert.equal(startPerfReporter(), true)
    assert.equal(env.observerFor('long-animation-frame'), null, 'no LoAF observer when the entry type is unsupported')
    const longTask = env.observerFor('longtask')
    assert.notEqual(longTask, null)
    assert.deepEqual(longTask.observed, { entryTypes: ['longtask'] })
    longTask.callback({ getEntries: () => [{ duration: 120 }] })
    assert.equal(perfSnapshot().counters['loaf:entry'], undefined)
    assert.equal(perfSnapshot().samples.loafDurationMs.count, 0)
    buildRecord('window', null, 15000)
    await flushRecords()
    assert.equal(capture.posts.length, 1)
    assert.deepEqual(capture.posts[0].payload.record.deltas.loaf, [])
    assert.equal(capture.posts[0].payload.record.deltas.samples.longTaskMs.count, 1)
  } finally {
    stopPerfReporter()
    capture.restore()
    env.restore()
    perfReset()
  }

  // A browser that advertises LoAF but refuses to observe it must still keep the
  // long-task duration: losing both attribution sources would be worse.
  const throwing = stubReporterEnv({ supportedEntryTypes: ['long-animation-frame'], loafObserverThrows: true })
  perfReset()
  try {
    assert.equal(startPerfReporter(), true)
    assert.equal(throwing.observerFor('long-animation-frame'), null)
    const fallback = throwing.observerFor('longtask')
    assert.notEqual(fallback, null, 'the refused LoAF observer falls back to longtask')
    assert.deepEqual(fallback.observed, { entryTypes: ['longtask'] })
    assert.equal(stopPerfReporter(), true)
    assert.equal(fallback.disconnected, true)
  } finally {
    stopPerfReporter()
    throwing.restore()
    perfReset()
  }
})

test('a refused LoAF observe() falls back to the longtask observer', () => {
  const env = stubReporterEnv({ supportedEntryTypes: ['long-animation-frame'], loafObserveThrows: true })
  perfReset()
  try {
    assert.equal(startPerfReporter(), true)
    assert.equal(env.observerFor('long-animation-frame'), null, 'the rejected observer is not registered')
    const fallback = env.observerFor('longtask')
    assert.notEqual(fallback, null, 'loaf observe() throwing falls back to longtask')
    assert.deepEqual(fallback.observed, { entryTypes: ['longtask'] })
    fallback.callback({ getEntries: () => [{ duration: 120 }] })
    assert.equal(perfSnapshot().samples.longTaskMs.count, 1)
  } finally {
    stopPerfReporter()
    env.restore()
    perfReset()
  }
})

test('a LoAF entry lands in deltas.loaf with its raw fields and at most three scripts', async () => {
  const env = stubReporterEnv({ supportedEntryTypes: ['long-animation-frame'] })
  const capture = capturePosts()
  perfReset()
  try {
    assert.equal(startPerfReporter(), true)
    const loafObserver = env.observerFor('long-animation-frame')
    assert.notEqual(loafObserver, null)
    assert.deepEqual(loafObserver.observed, { entryTypes: ['long-animation-frame'] })
    assert.equal(env.observerFor('longtask'), null, 'LoAF replaces the longtask observer')
    loafObserver.callback({
      getEntries: () => [
        {
          startTime: 100,
          duration: 80,
          blockingDuration: 25,
          renderStart: 120,
          styleAndLayoutStart: 130,
          scripts: [
            { duration: 10, invoker: 'click', sourceURL: 'https://cdn.example.com/assets/app.js?v=1' },
            { duration: 20, invoker: 'timer', sourceURL: '/opt/site/chunk.js' },
            { duration: 5, invoker: 'raf', sourceURL: 'inline.js' },
            { duration: 7, invoker: 'promise', sourceURL: 'https://cdn.example.com/ignored.js' },
          ],
        },
      ],
    })
    assert.equal(perfSnapshot().counters['loaf:entry'], 1)
    buildRecord('window', null, 15000)
    assert.equal(await flushRecords(), 1)
    const raw = capture.posts[0].payload.record.deltas.loaf
    assert.deepEqual(raw, [
      {
        startTime: 100,
        duration: 80,
        blockingDuration: 25,
        renderStart: 120,
        styleAndLayoutStart: 130,
        scripts: [
          { duration: 10, invoker: 'click', sourceURL: 'app.js' },
          { duration: 20, invoker: 'timer', sourceURL: 'chunk.js' },
          { duration: 5, invoker: 'raf', sourceURL: 'inline.js' },
        ],
      },
    ])

    // The raw list is part of the per-record deltas: the next record starts over.
    buildRecord('window', null, 5000)
    assert.equal(await flushRecords(), 1)
    assert.deepEqual(capture.posts[1].payload.record.deltas.loaf, [])
  } finally {
    stopPerfReporter()
    capture.restore()
    env.restore()
    perfReset()
  }
})

test('a LoAF sourceURL keeps only its base file name', async () => {
  const env = stubReporterEnv({ supportedEntryTypes: ['long-animation-frame'] })
  const capture = capturePosts()
  perfReset()
  try {
    assert.equal(startPerfReporter(), true)
    const longName = `${'a'.repeat(120)}.js`
    env.observerFor('long-animation-frame').callback({
      getEntries: () => [
        {
          startTime: 1,
          duration: 60,
          scripts: [
            { duration: 1, invoker: 'click', sourceURL: 'https://user:secret@cdn.example.com:8443/deep/path/app.js?token=abc#frag' },
            { duration: 2, invoker: 'timer', sourceURL: 'C:\\Users\\Momiji\\AppData\\Local\\Temp\\perf.js' },
            { duration: 3, invoker: 'raf', sourceURL: 'https://cdn.example.com/' },
          ],
        },
        {
          startTime: 2,
          duration: 60,
          scripts: [
            { duration: 4, invoker: 'i'.repeat(100), sourceURL: longName },
            { duration: 5, invoker: 'promise' },
          ],
        },
      ],
    })
    buildRecord('window', null, 15000)
    await flushRecords()
    const loaf = capture.posts[0].payload.record.deltas.loaf
    assert.deepEqual(loaf[0].scripts.map((script) => script.sourceURL), ['app.js', 'perf.js', null])
    assert.equal(loaf[1].scripts[0].sourceURL, 'a'.repeat(80), 'a long file name is cut at 80 characters')
    assert.equal(loaf[1].scripts[0].invoker.length, 80, 'a long invoker is cut at 80 characters')
    assert.equal(loaf[1].scripts[1].sourceURL, null, 'a missing sourceURL stays null')
    assert.equal(loaf[1].scripts[1].invoker, 'promise')

    // Privacy: only base names, never directories, credentials, query strings or
    // the Windows profile path.
    const text = JSON.stringify(loaf)
    for (const forbidden of ['Users', 'Momiji', 'AppData', 'example.com', 'secret', 'token', '?', '#']) {
      assert.equal(text.includes(forbidden), false, `the loaf block must not carry ${forbidden}`)
    }
  } finally {
    stopPerfReporter()
    capture.restore()
    env.restore()
    perfReset()
  }
})

test('only http(s), file, blob and relative LoAF sourceURLs keep a base name', async () => {
  const env = stubReporterEnv({ supportedEntryTypes: ['long-animation-frame'] })
  const capture = capturePosts()
  perfReset()
  try {
    assert.equal(startPerfReporter(), true)
    env.observerFor('long-animation-frame').callback({
      getEntries: () => [
        {
          startTime: 10,
          duration: 40,
          scripts: [
            { duration: 1, sourceURL: 'data:text/javascript;base64,Y29uc29sZS5sb2coMSk=' },
            { duration: 1, sourceURL: 'blob:https://cdn.example.com/550e8400-e29b-41d4-a716-446655440000' },
            { duration: 1, sourceURL: 'file:///C:/Users/Momiji/AppData/Local/app.js' },
          ],
        },
        {
          startTime: 20,
          duration: 40,
          scripts: [
            { duration: 1, sourceURL: 'about:blank' },
            { duration: 1, sourceURL: 'chrome-extension://abcdefg/inject.js' },
            { duration: 1, sourceURL: 'packages/client/perf.js' },
          ],
        },
        {
          startTime: 30,
          duration: 40,
          scripts: [{ duration: 1, sourceURL: 'https://cdn.example.com/assets/app.js?v=1#frag' }],
        },
      ],
    })
    buildRecord('window', null, 15000)
    await flushRecords()
    const loaf = capture.posts[0].payload.record.deltas.loaf
    const sourceURLs = loaf.flatMap((entry) => entry.scripts.map((script) => script.sourceURL))
    assert.deepEqual(sourceURLs, [
      null,
      '550e8400-e29b-41d4-a716-446655440000',
      'app.js',
      null,
      null,
      'perf.js',
      'app.js',
    ])
    // The opaque URL payload itself must never reach the record.
    const text = JSON.stringify(loaf)
    for (const forbidden of ['base64', 'javascript', 'about', 'chrome-extension']) {
      assert.equal(text.includes(forbidden), false, `the loaf block must not carry ${forbidden}`)
    }
  } finally {
    stopPerfReporter()
    capture.restore()
    env.restore()
    perfReset()
  }
})

test('LoAF derived samples are non-negative and loafScriptMs sums every script', () => {
  const env = stubReporterEnv({ supportedEntryTypes: ['long-animation-frame'] })
  perfReset()
  try {
    assert.equal(startPerfReporter(), true)
    const observer = env.observerFor('long-animation-frame')
    observer.callback({
      getEntries: () => [
        {
          startTime: 1000,
          duration: 80,
          styleAndLayoutStart: 1050,
          renderStart: 1020,
          scripts: [{ duration: 10 }, { duration: 20 }, { duration: 5 }, { duration: 7 }],
        },
      ],
    })
    const samples = perfSnapshot().samples
    assert.equal(samples.loafDurationMs.count, 1)
    assert.equal(samples.loafDurationMs.max, 80)
    assert.equal(samples.loafStyleLayoutMs.count, 1)
    assert.equal(samples.loafStyleLayoutMs.max, 30)
    assert.equal(samples.loafScriptMs.count, 1)
    assert.equal(samples.loafScriptMs.max, 42, 'the sum uses all four scripts, not just the three raw ones')
    assert.equal(samples.loafRenderMs.count, 1)
    assert.equal(samples.loafRenderMs.max, 60)

    // Negative derivations are dropped, never clamped to zero.
    observer.callback({
      getEntries: () => [
        { startTime: 2000, duration: 50, styleAndLayoutStart: 2100, renderStart: 2200, scripts: [] },
        { startTime: 3000, duration: 10, renderStart: 2990, scripts: [{ duration: -5 }] },
      ],
    })
    const after = perfSnapshot().samples
    assert.equal(after.loafDurationMs.count, 3)
    assert.equal(after.loafStyleLayoutMs.count, 1, 'a negative style+layout duration is dropped')
    assert.equal(after.loafRenderMs.count, 1, 'a render start before the frame start is dropped')
    assert.equal(after.loafScriptMs.count, 2, 'the empty-scripts frame sampled zero and the negative total was dropped')
    for (const name of ['loafDurationMs', 'loafStyleLayoutMs', 'loafScriptMs', 'loafRenderMs']) {
      assert.ok(after[name].min >= 0, `${name} must stay non-negative`)
    }
  } finally {
    stopPerfReporter()
    env.restore()
    perfReset()
  }
})

test('LoAF timestamps outside the frame, including finite zero, produce no attribution samples', () => {
  const env = stubReporterEnv({ supportedEntryTypes: ['long-animation-frame'] })
  perfReset()
  try {
    assert.equal(startPerfReporter(), true)
    env.observerFor('long-animation-frame').callback({
      getEntries: () => [
        {
          startTime: 1000,
          duration: 80,
          styleAndLayoutStart: 0,
          renderStart: 0,
          scripts: [{ duration: 10 }],
        },
        {
          startTime: 2000,
          duration: 80,
          styleAndLayoutStart: 1500,
          renderStart: 2500,
          scripts: [{ duration: 10 }],
        },
      ],
    })
    const samples = perfSnapshot().samples
    assert.equal(samples.loafDurationMs.count, 2)
    assert.equal(samples.loafStyleLayoutMs.count, 0, 'a layout start outside the frame is not an offset')
    assert.equal(samples.loafRenderMs.count, 0, 'a render start outside the frame is not an offset')
  } finally {
    stopPerfReporter()
    env.restore()
    perfReset()
  }
})

test('a LoAF entry with an invalid duration is counted but never derived', () => {
  const env = stubReporterEnv({ supportedEntryTypes: ['long-animation-frame'] })
  perfReset()
  try {
    assert.equal(startPerfReporter(), true)
    env.observerFor('long-animation-frame').callback({
      getEntries: () => [
        { startTime: 100, duration: Number.NaN, styleAndLayoutStart: 110, renderStart: 120, scripts: [{ duration: 10 }] },
        { startTime: 100, duration: Number.POSITIVE_INFINITY, styleAndLayoutStart: 110, renderStart: 120, scripts: [{ duration: 10 }] },
        { startTime: 100, duration: -5, styleAndLayoutStart: 110, renderStart: 105, scripts: [{ duration: 10 }] },
      ],
    })
    const snapshot = perfSnapshot()
    assert.equal(snapshot.counters['loaf:entry'], 3, 'every non-null entry is observed')
    for (const name of ['loafDurationMs', 'loafStyleLayoutMs', 'loafScriptMs', 'loafRenderMs']) {
      assert.equal(snapshot.samples[name].count, 0, `${name} is not derived from an invalid duration`)
    }
  } finally {
    stopPerfReporter()
    env.restore()
    perfReset()
  }
})

test('one record carries at most the 20 newest raw LoAF entries', async () => {
  const env = stubReporterEnv({ supportedEntryTypes: ['long-animation-frame'] })
  const capture = capturePosts()
  perfReset()
  try {
    assert.equal(startPerfReporter(), true)
    const observer = env.observerFor('long-animation-frame')
    for (let index = 0; index < 25; index += 1) {
      observer.callback({ getEntries: () => [{ startTime: index, duration: 10, scripts: [] }] })
    }
    assert.equal(perfSnapshot().counters['loaf:entry'], 25)
    buildRecord('window', null, 15000)
    await flushRecords()
    const loaf = capture.posts[0].payload.record.deltas.loaf
    assert.equal(loaf.length, 20)
    assert.equal(loaf[0].startTime, 5, 'the oldest entries are dropped first')
    assert.equal(loaf[19].startTime, 24)

    // The window is drained by the record, not shared with the next one.
    buildRecord('window', null, 1000)
    await flushRecords()
    assert.deepEqual(capture.posts[1].payload.record.deltas.loaf, [])
  } finally {
    stopPerfReporter()
    capture.restore()
    env.restore()
    perfReset()
  }
})

test('stopPerfReporter disconnects the observer on both capture paths and never double-attaches', () => {
  // LoAF path.
  const loafEnv = stubReporterEnv({ supportedEntryTypes: ['long-animation-frame'] })
  perfReset()
  try {
    assert.equal(startPerfReporter(), true)
    assert.equal(startPerfReporter(), false, 'a repeated start must not attach a second observer')
    assert.equal(loafEnv.observers.length, 1)
    const loafObserver = loafEnv.observerFor('long-animation-frame')
    assert.notEqual(loafObserver, null)
    assert.equal(stopPerfReporter(), true)
    assert.equal(loafObserver.disconnected, true)
    assert.equal(loafEnv.intervals[0].cleared, true)
  } finally {
    stopPerfReporter()
    loafEnv.restore()
    perfReset()
  }

  // long-task fallback path.
  const fallbackEnv = stubReporterEnv({ supportedEntryTypes: ['longtask'] })
  try {
    assert.equal(startPerfReporter(), true)
    const longTask = fallbackEnv.observerFor('longtask')
    assert.notEqual(longTask, null)
    assert.equal(stopPerfReporter(), true)
    assert.equal(longTask.disconnected, true, 'the fallback observer is disconnected too')
  } finally {
    stopPerfReporter()
    fallbackEnv.restore()
    perfReset()
  }
})

test('a final record carries the LoAF window as well as the marks', async () => {
  const env = stubReporterEnv({ supportedEntryTypes: ['long-animation-frame'] })
  const capture = capturePosts()
  perfReset()
  try {
    assert.equal(startPerfReporter(), true)
    env.observerFor('long-animation-frame').callback({
      getEntries: () => [{ startTime: 10, duration: 70, scripts: [{ duration: 30 }] }],
    })
    perfMark('tick', 1)
    buildRecord('final', 'idle')
    await flushRecords()
    const record = capture.posts[0].payload.record
    assert.equal(record.kind, 'final')
    assert.equal(record.deltas.loaf.length, 1)
    assert.equal(record.deltas.loaf[0].duration, 70)
    assert.equal(record.deltas.samples.loafScriptMs.max, 30)
    assert.equal(record.deltas.marks.length, 1)
  } finally {
    stopPerfReporter()
    capture.restore()
    env.restore()
    perfReset()
  }
})

test('LoAF entries without scripts still sample loafScriptMs as zero', async () => {
  const env = stubReporterEnv({ supportedEntryTypes: ['long-animation-frame'] })
  const capture = capturePosts()
  perfReset()
  try {
    assert.equal(startPerfReporter(), true)
    env.observerFor('long-animation-frame').callback({
      getEntries: () => [
        null,
        { duration: 10 },
        { startTime: 100, duration: 20, scripts: [] },
        { startTime: 200, duration: 30 },
      ],
    })
    assert.equal(perfSnapshot().counters['loaf:entry'], 3, 'every non-null entry is counted')
    assert.equal(perfSnapshot().samples.loafDurationMs.count, 2)
    assert.equal(perfSnapshot().samples.loafScriptMs.count, 2, 'a frame without scripts samples zero')
    assert.equal(perfSnapshot().samples.loafScriptMs.max, 0)
    assert.equal(
      perfSnapshot().samples.loafScriptMs.count,
      perfSnapshot().samples.loafDurationMs.count,
      'the script and duration sample counts stay aligned'
    )
    buildRecord('window', null, 15000)
    await flushRecords()
    const loaf = capture.posts[0].payload.record.deltas.loaf
    assert.equal(loaf.length, 2)
    for (const entry of loaf) assert.deepEqual(entry.scripts, [])
    assert.equal(loaf[0].renderStart, null)
    assert.equal(loaf[0].styleAndLayoutStart, null)
    assert.equal(loaf[0].blockingDuration, 0)
  } finally {
    stopPerfReporter()
    capture.restore()
    env.restore()
    perfReset()
  }
})
