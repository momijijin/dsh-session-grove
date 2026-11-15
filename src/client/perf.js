/**
 * Performance instrumentation (0.2.2 drag/commit probe, extended in the
 * 0.4.0-beta.66 sidebar performance batch).
 *
 * The `.66` release build ships OFF (`PERF_MEASURE_BUILD === false`), so
 * nothing is captured by default. Two client-side ways in:
 *
 *   localStorage['dsh-session-grove.perf'] = '1'   // documented opt-in
 *   globalThis.__DSG_PERF__ = true                 // historical opt-in
 *
 * The host half is a second switch: the plugin's `perf` configuration key must
 * also be true, otherwise the route rejects the POST with 403 (the client keeps
 * the records queued and retries).
 *
 * and one emergency exit that always wins:
 *
 *   localStorage['dsh-session-grove.perf'] = '0'
 *
 * When capture is off every helper returns after one cached boolean check, so
 * the shipped view pays no measurable cost (the `perfSpan` early exit returns a
 * shared no-op, not a fresh closure).
 *
 * `startPerfReporter()` (called by the client plugin after mount) owns the 15 s
 * window flush, the 10 s idle marker, the `pagehide` / `visibilitychange`
 * final flush, and long-animation-frame (LoAF, when supported) or long-task
 * fallback plus frame-gap sampling. Records are serialized into a bounded
 * outbox (20 entries) and POSTed one by one to the relative
 * `dsh-session-grove/perf` route; a failed POST stays queued for the next
 * flush. Node (test) environments never start the reporter, so `npm test`
 * cannot hang on a timer.
 *
 * The data is deliberately aggregate and privacy-safe: counters, durations,
 * sizes, component names and the plugin version. No session ids, titles, group
 * names, text or paths are ever recorded; a LoAF `sourceURL` is reduced to its
 * base file name before it leaves the page.
 */
import { PERF_MEASURE_BUILD, PLUGIN_VERSION } from '../shared/constants.js'

/** localStorage opt-out/opt-in key (read once per page load). */
export const PERF_STORAGE_KEY = 'dsh-session-grove.perf'

/** Relative ingest route, resolved against `document.baseURI` (same-origin). */
const PERF_REPORT_PATH = 'dsh-session-grove/perf'

const MAX_MARKS = 4000
const MAX_SAMPLES = 400
const MAX_RECORD_MARKS = 200
const MAX_OUTBOX = 20
/** Raw LoAF entries carried per record (the newest ones). */
const MAX_LOAF_ENTRIES = 20
/** Scripts listed per raw LoAF entry (the samples still sum *all* of them). */
const MAX_LOAF_SCRIPTS = 3
const MAX_LOAF_SOURCE_NAME = 80
const MAX_LOAF_INVOKER = 80
/** URL schemes whose basename may be recorded; every other scheme is dropped. */
const RECORDABLE_SOURCE_SCHEMES = new Set(['http:', 'https:', 'file:', 'blob:'])
const SOURCE_URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i
const WINDOWS_PATH = /^[a-z]:[\\/]/i
const SCHEMA_VERSION = 1
const WINDOW_INTERVAL_MS = 15_000
const IDLE_AFTER_MS = 10_000

/** Every sample name `perfSample` accepts (unknown names are dropped). */
const SAMPLE_NAMES = [
  // 0.2.2 drag/commit probe.
  'dragOverMs',
  'dropTargetUpdateMs',
  'floatingLabelMs',
  'dropHandlerMs',
  // 0.4.0-beta.66 sidebar performance batch (spec §3.3, §8.2).
  'widthFrameMs',
  'widthStyleWriteMs',
  // P2: per-frame inline custom-property write (the replacement for the
  // sheet text rewrite, which is now counted separately as `width:styleWrite`).
  'widthCssVarMs',
  // N5: pointer-to-rAF lag inside the resize handle's drag frame.
  'width:pointerLagMs',
  'chromeMeasureMs',
  'groupsViewRenderMs',
  'dialogGestureMoveMs',
  'dialogRenderMs',
  'scrollAreaUpdateMs',
  'treeScrollFrameMs',
  'treeLayoutMeasureMs',
  'toggleUpdateMs',
  'dragoverRectMs',
  'dragoverHitTestMs',
  'dragoverCheckMs',
  'dragoverLabelMs',
  'dragLeaveRectMs',
  'longTaskMs',
  'frameGapMs',
  // Long Animation Frame attribution (spec §8.2).
  'loafDurationMs',
  'loafStyleLayoutMs',
  'loafScriptMs',
  'loafRenderMs',
]

/** Render counters the record `deltas.renders` block always reports. */
const RECORD_RENDER_NAMES = ['GroupsView', 'GroupNode', 'SessionRow', 'DialogHost', 'ScrollArea', 'UngroupedSection', 'Header']

/** Sample kinds the reporter's own tickers produce on every frame/window. */
const TICKER_SAMPLES = new Set(['frameGapMs', 'longTaskMs'])

const PERF_KINDS = new Set(['gesture', 'window', 'final'])
const GESTURES = new Set(['width-resize', 'dialog-move', 'dialog-resize', 'scroll', 'drag-session', 'drag-group', 'idle'])

const NOOP = () => {}

const round2 = (value) => Math.round(value * 100) / 100

/** Monotonic clock (falls back to Date.now outside a browser). */
export const perfNow = () =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now()

/** Fresh per-record accumulator (deltas are reset after every record). */
const createPending = () => ({
  counters: Object.create(null),
  renders: Object.create(null),
  samples: Object.fromEntries(SAMPLE_NAMES.map((name) => [name, []])),
  dragOver: { events: 0, totalMs: 0, maxMs: 0, invalid: 0, byHandler: Object.create(null) },
  dropTarget: { calls: 0, changes: 0 },
})

const createState = () => ({
  startedAt: perfNow(),
  counters: Object.create(null),
  renders: Object.create(null),
  marks: [],
  samples: Object.fromEntries(SAMPLE_NAMES.map((name) => [name, []])),
  dragOver: { events: 0, totalMs: 0, maxMs: 0, invalid: 0, byHandler: Object.create(null) },
  dropTarget: { calls: 0, changes: 0 },
  /** Raw LoAF entries for the current record (bounded ring, drained per record). */
  loaf: [],
  pending: createPending(),
  treeCounts: { groups: 0, sessions: 0 },
  sidebarWidth: null,
  gesture: null,
  lastGestureAt: perfNow(),
  lastRecordAt: perfNow(),
  outbox: [],
  /** Payload currently on the wire (`outbox[0]` while a POST is awaited). */
  inFlight: null,
  flushing: false,
  reporter: null,
})

let cachedEnabled = null
let cachedRunId = null
let state = createState()

const storageValue = () => {
  try {
    return globalThis.localStorage?.getItem?.(PERF_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

const readFlag = () => {
  // The emergency opt-out always wins, even while the build constant is on.
  if (storageValue() === '0') return false
  if (PERF_MEASURE_BUILD === true) return true
  try {
    if (globalThis.__DSG_PERF__ === true) return true
  } catch {
    /* hostile global object */
  }
  return storageValue() === '1'
}

/** Whether instrumentation is active for this page load. */
export const perfEnabled = () => {
  if (cachedEnabled === null) cachedEnabled = readFlag()
  return cachedEnabled
}

/** Stable per-page run id shared by every record (no user data). */
const currentRunId = () => {
  if (cachedRunId !== null) return cachedRunId
  cachedRunId = `dsg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return cachedRunId
}

/** Increment one named counter (no-op when disabled). */
export const perfCount = (name, by = 1) => {
  if (!perfEnabled()) return
  state.counters[name] = (state.counters[name] ?? 0) + by
  state.pending.counters[name] = (state.pending.counters[name] ?? 0) + by
}

/** Increment one component render counter (no-op when disabled). */
export const perfRender = (name) => {
  if (!perfEnabled()) return
  state.renders[name] = (state.renders[name] ?? 0) + 1
  state.pending.renders[name] = (state.pending.renders[name] ?? 0) + 1
}

/** Push one bounded numeric sample (no-op when disabled). */
export const perfSample = (name, ms) => {
  if (!perfEnabled() || !Number.isFinite(ms)) return
  const list = state.samples[name]
  if (!Array.isArray(list)) return
  const value = round2(ms)
  if (list.length >= MAX_SAMPLES) list.shift()
  list.push(value)
  const pending = state.pending.samples[name]
  if (Array.isArray(pending)) {
    // The per-record window rolls forward exactly like the session window:
    // `frameGapMs` is sampled on every frame, so 400 frames (~6.7 s) fill it
    // long before the next record. Dropping the *new* samples there would make
    // a gesture record summarize the idle frames from before the gesture
    // (frameGapMs p95 false negative); the window must keep the latest 400.
    if (pending.length >= MAX_SAMPLES) pending.shift()
    pending.push(value)
  }
}

/**
 * Start one bounded duration sample; returns the stop function.
 *
 * `stop()` is idempotent, so a `try/finally` wrapper can run it on every path.
 * When capture is off the shared no-op is returned and nothing is measured.
 */
export const perfSpan = (name) => {
  if (!perfEnabled()) return NOOP
  const startedAt = perfNow()
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    perfSample(name, perfNow() - startedAt)
  }
}

/**
 * Run `fn` and record its duration under `name`. Exceptions are rethrown
 * unchanged (the `finally` only stops the clock); when capture is off `fn`
 * runs with no bookkeeping at all.
 */
export const perfMs = (name, fn) => {
  if (!perfEnabled()) return fn()
  const startedAt = perfNow()
  try {
    return fn()
  } finally {
    perfSample(name, perfNow() - startedAt)
  }
}

/** Record one timestamped mark; `detail` must stay JSON-serializable. */
export const perfMark = (name, detail = null) => {
  if (!perfEnabled()) return
  if (state.marks.length >= MAX_MARKS) state.marks.shift()
  state.marks.push({ t: round2(perfNow()), name, detail })
}

/** Aggregate one dragover handler call. */
export const perfDragOver = (handler, durationMs, { invalid = false } = {}) => {
  if (!perfEnabled()) return
  for (const bucket of [state.dragOver, state.pending.dragOver]) {
    bucket.events += 1
    bucket.totalMs += durationMs
    if (durationMs > bucket.maxMs) bucket.maxMs = durationMs
    if (invalid) bucket.invalid += 1
    bucket.byHandler[handler] = (bucket.byHandler[handler] ?? 0) + 1
  }
  perfSample('dragOverMs', durationMs)
}

/**
 * Aggregate one drop-target state attempt. `changed` is false when the helper
 * skipped React because the target was already the current one.
 */
export const perfDropTarget = (changed, durationMs = 0) => {
  if (!perfEnabled()) return
  state.dropTarget.calls += 1
  if (changed) state.dropTarget.changes += 1
  state.pending.dropTarget.calls += 1
  if (changed) state.pending.dropTarget.changes += 1
  perfSample('dropTargetUpdateMs', durationMs)
}

/** Publish the rendered-tree counts used by the record `state` block. */
export const perfTreeCounts = (groups, sessions) => {
  if (!perfEnabled()) return
  state.treeCounts.groups = Number.isFinite(groups) ? groups : 0
  state.treeCounts.sessions = Number.isFinite(sessions) ? sessions : 0
}

/** Publish the applied/persisted sidebar width (`readSidebarWidth()` value). */
export const perfSidebarWidth = (px) => {
  if (!perfEnabled()) return
  state.sidebarWidth = Number.isFinite(px) ? px : null
}

/**
 * Reduce a script `sourceURL` to its base file name.
 *
 * Credentials, directories, query strings and fragments are dropped before the
 * name is recorded: a full URL can reveal the profile directory or the harness
 * home, and the attribution only needs the file that ran. Only `http:` /
 * `https:` / `file:` / `blob:` URLs and relative paths are reduced; every other
 * scheme (`data:`, `about:`, `chrome-extension:`, ...) and a missing value are
 * `null`, so an opaque URL payload can never leak. `null` is also returned when
 * nothing name-like is left (empty value or a bare origin).
 */
const basenameOnly = (value) => {
  if (typeof value !== 'string' || value.length === 0) return null
  let pathname = value
  // A Windows drive (`C:\...` / `C:/...`) is a path, not a `c:` scheme.
  if (!WINDOWS_PATH.test(value)) {
    const scheme = SOURCE_URL_SCHEME.exec(value)
    if (scheme !== null) {
      if (!RECORDABLE_SOURCE_SCHEMES.has(`${scheme[1].toLowerCase()}:`)) return null
      try {
        pathname = new URL(value).pathname
      } catch {
        return null
      }
    }
  }
  const name = pathname
    .split(/[?#]/, 1)[0]
    .split(/[\\/]/)
    .filter((part) => part.length > 0)
    .pop() ?? ''
  return name.length > 0 ? name.slice(0, MAX_LOAF_SOURCE_NAME) : null
}

/**
 * Collect one Long Animation Frame entry (spec §8.2): four attribution samples
 * plus the raw fields that let a reader split script / style+layout / render
 * time afterwards.
 *
 * `loafScriptMs` sums **all** scripts before the raw list is truncated to
 * `MAX_LOAF_SCRIPTS`; truncating first would systematically under-report script
 * time on frames with many scripts. A frame with no scripts samples 0, so the
 * script and duration sample counts stay aligned (comparing their averages is
 * otherwise biased). Style/layout and render are derived only when their start
 * falls inside `[startTime, startTime + duration]`: a finite zero before the
 * frame is a missing timestamp, not an offset. Every derived duration is
 * sampled only when it is non-negative, so a clock-skewed entry cannot poison
 * the summary.
 */
const recordLoafEntry = (entry) => {
  if (entry === null || typeof entry !== 'object') return
  // Counted before validation: every frame the browser classified as long is an
  // observation, even if this browser build omits a timestamp on it.
  perfCount('loaf:entry')
  if (!Number.isFinite(entry.startTime) || !Number.isFinite(entry.duration) || entry.duration < 0) return
  const start = entry.startTime
  const end = start + entry.duration
  const insideFrame = (value) => Number.isFinite(value) && value >= start && value <= end
  const scripts = Array.isArray(entry.scripts) ? entry.scripts : []
  const scriptDurations = scripts.map((script) => (Number.isFinite(script?.duration) ? script.duration : 0))
  const scriptTotal = scriptDurations.reduce((sum, value) => sum + value, 0)

  perfSample('loafDurationMs', entry.duration)
  if (insideFrame(entry.styleAndLayoutStart)) {
    const styleLayoutMs = end - entry.styleAndLayoutStart
    if (styleLayoutMs >= 0) perfSample('loafStyleLayoutMs', styleLayoutMs)
  }
  if (scriptTotal >= 0) perfSample('loafScriptMs', scriptTotal)
  if (insideFrame(entry.renderStart)) {
    const renderMs = end - entry.renderStart
    if (renderMs >= 0) perfSample('loafRenderMs', renderMs)
  }

  state.loaf.push({
    startTime: entry.startTime,
    duration: entry.duration,
    blockingDuration: Number.isFinite(entry.blockingDuration) ? entry.blockingDuration : 0,
    renderStart: Number.isFinite(entry.renderStart) ? entry.renderStart : null,
    styleAndLayoutStart: Number.isFinite(entry.styleAndLayoutStart) ? entry.styleAndLayoutStart : null,
    scripts: scripts.slice(0, MAX_LOAF_SCRIPTS).map((script) => ({
      duration: Number.isFinite(script?.duration) ? script.duration : 0,
      invoker: typeof script?.invoker === 'string' ? script.invoker.slice(0, MAX_LOAF_INVOKER) : '',
      sourceURL: basenameOnly(script?.sourceURL),
    })),
  })
  if (state.loaf.length > MAX_LOAF_ENTRIES) state.loaf.shift()
}

/**
 * Begin (or keep) one gesture window. Re-beginning the gesture that is already
 * open only refreshes the activity clock, so a scroll burst cannot flush a
 * record per event; a different gesture ends the open one first. Starting a new
 * gesture also retries the outbox, so a record whose POST failed in the previous
 * interval is not left waiting for the next gesture.
 */
export const perfBeginGesture = (name) => {
  if (!perfEnabled() || typeof name !== 'string' || name.length === 0) return
  const now = perfNow()
  if (state.gesture !== null) {
    if (state.gesture.name === name) {
      state.lastGestureAt = now
      return
    }
    perfEndGesture(state.gesture.name)
  }
  // Retry the outbox before the new baseline: a record left behind by a failed
  // POST belongs to the interval before this gesture.
  void flushRecords()
  state.gesture = { name, startedAt: now }
  state.lastGestureAt = now
}

/** End the open gesture, build its record and queue it (no-op when mismatched). */
export const perfEndGesture = (name) => {
  if (!perfEnabled()) return
  const gesture = state.gesture
  if (gesture === null) return
  if (typeof name === 'string' && name.length > 0 && name !== gesture.name) return
  state.gesture = null
  state.lastGestureAt = perfNow()
  buildRecord('gesture', gesture.name, perfNow() - gesture.startedAt)
}

const summarize = (values) => {
  if (!Array.isArray(values) || values.length === 0) return { count: 0, min: 0, avg: 0, p50: 0, p95: 0, max: 0 }
  const sorted = [...values].sort((left, right) => left - right)
  const total = sorted.reduce((sum, value) => sum + value, 0)
  return {
    count: sorted.length,
    min: sorted[0],
    avg: round2(total / sorted.length),
    p50: sorted[Math.round((sorted.length - 1) * 0.5)],
    p95: sorted[Math.round((sorted.length - 1) * 0.95)],
    max: sorted[sorted.length - 1],
  }
}

/** The `deltas` block: everything accumulated since the previous record. */
const takeDeltas = () => {
  const samples = {}
  for (const [name, values] of Object.entries(state.pending.samples)) {
    if (values.length > 0) samples[name] = summarize(values)
  }
  const renders = {}
  for (const name of RECORD_RENDER_NAMES) renders[name] = state.pending.renders[name] ?? 0
  const dragOver = state.pending.dragOver
  // The raw LoAF entries are drained per record like the deltas, but they live on
  // the session state (the bounded window is filled by the observer, including
  // between records), so a record takes what is there and starts the window over.
  const loaf = state.loaf
  state.loaf = []
  return {
    renders,
    counters: { ...state.pending.counters },
    samples,
    loaf,
    dragOver: {
      events: dragOver.events,
      totalMs: round2(dragOver.totalMs),
      maxMs: round2(dragOver.maxMs),
      invalid: dragOver.invalid,
      byHandler: { ...dragOver.byHandler },
    },
    dropTarget: { ...state.pending.dropTarget },
  }
}

/** The `state` block; DOM reads are optional so Node stays safe. */
const recordState = () => {
  const doc = globalThis.document
  let tree = null
  try {
    tree = doc?.querySelector?.('.dsg-tree') ?? null
  } catch {
    tree = null
  }
  const numberOrZero = (value) => (Number.isFinite(value) ? value : 0)
  return {
    groups: state.treeCounts.groups,
    sessions: state.treeCounts.sessions,
    treeRows: numberOrZero(tree?.childElementCount),
    scrollHeight: numberOrZero(tree?.scrollHeight),
    clientHeight: numberOrZero(tree?.clientHeight),
    viewportWidth: numberOrZero(globalThis.innerWidth),
    viewportHeight: numberOrZero(globalThis.innerHeight),
    dpr: Number.isFinite(globalThis.devicePixelRatio) ? globalThis.devicePixelRatio : 1,
    sidebarWidth: state.sidebarWidth,
  }
}

/** The `env` block; no user data, no session identity. */
const recordEnv = () => {
  const nav = globalThis.navigator ?? null
  return {
    version: PLUGIN_VERSION,
    ua: typeof nav?.userAgent === 'string' ? nav.userAgent : '',
    hardwareConcurrency: Number.isFinite(nav?.hardwareConcurrency) ? nav.hardwareConcurrency : null,
    deviceMemory: Number.isFinite(nav?.deviceMemory) ? nav.deviceMemory : null,
  }
}

/** True when a record built now would carry real increments. */
const hasIncrements = () => {
  if (Object.keys(state.pending.counters).length > 0) return true
  for (const value of Object.values(state.pending.renders)) {
    if (value > 0) return true
  }
  if (state.pending.dragOver.events > 0 || state.pending.dropTarget.calls > 0) return true
  for (const [name, values] of Object.entries(state.pending.samples)) {
    if (values.length > 0 && !TICKER_SAMPLES.has(name)) return true
  }
  return false
}

const idleGestureName = () => (perfNow() - state.lastGestureAt >= IDLE_AFTER_MS ? 'idle' : null)

/**
 * Serialize the current increments into one record, queue it, then reset the
 * per-record accumulators. Queuing (not clearing) is what makes a failed POST
 * safe to retry: the serialized payload survives, the deltas start over.
 *
 * @param {'gesture'|'window'|'final'} kind
 * @param {string|null} [gesture]
 * @param {number|null} [durationMs] omitted -> milliseconds since the last record
 * @returns {{runId: string, schemaVersion: number, record: object} | null}
 */
export const buildRecord = (kind, gesture = null, durationMs = null) => {
  if (!perfEnabled()) return null
  const now = perfNow()
  const elapsed = Number.isFinite(durationMs) ? Math.max(0, round2(durationMs)) : Math.max(0, round2(now - state.lastRecordAt))
  const deltas = takeDeltas()
  if (kind === 'final') deltas.marks = state.marks.slice(-MAX_RECORD_MARKS)
  const payload = {
    runId: currentRunId(),
    schemaVersion: SCHEMA_VERSION,
    record: {
      kind: PERF_KINDS.has(kind) ? kind : 'window',
      gesture: typeof gesture === 'string' && GESTURES.has(gesture) ? gesture : null,
      durationMs: elapsed,
      deltas,
      state: recordState(),
      env: recordEnv(),
    },
  }
  state.lastRecordAt = now
  state.pending = createPending()
  state.outbox.push(payload)
  if (state.outbox.length > MAX_OUTBOX) {
    // Never drop the record that is on the wire: `flushRecords` removes the
    // delivered record by identity, and a positional shift here would make it
    // discard the next *unsent* record after a successful POST. The cap still
    // drops exactly one record, just the oldest queued one.
    state.outbox.splice(state.inFlight !== null && state.outbox[0] === state.inFlight ? 1 : 0, 1)
    // Counted after the reset on purpose: the drop belongs to the next record.
    perfCount('perf:dropped')
  }
  return payload
}

const perfUrl = () => {
  try {
    return new URL(PERF_REPORT_PATH, globalThis.document?.baseURI ?? 'http://localhost/').toString()
  } catch {
    return null
  }
}

const beaconAvailable = () =>
  typeof globalThis.navigator?.sendBeacon === 'function' && typeof globalThis.Blob === 'function'

const postWithBeacon = (payload) => {
  const url = perfUrl()
  if (url === null || !beaconAvailable()) return false
  try {
    return globalThis.navigator.sendBeacon(url, new globalThis.Blob([JSON.stringify(payload)], { type: 'application/json' })) === true
  } catch {
    return false
  }
}

const postWithFetch = async (payload) => {
  const url = perfUrl()
  if (url === null || typeof globalThis.fetch !== 'function') return false
  try {
    const response = await globalThis.fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify(payload),
    })
    return response?.ok === true || (response?.status >= 200 && response?.status < 300)
  } catch {
    // Kept in the outbox and retried by the next flush tick.
    return false
  }
}

/**
 * POST the outbox one record at a time. A rejected record stays in place (the
 * rest of the queue waits with it); the return value is how many were sent.
 * `beacon: true` prefers `navigator.sendBeacon` (page hide/unload path) and
 * falls back to `fetch keepalive`. The delivered record is removed by identity,
 * never by position, so a record built while the POST was in flight cannot make
 * this flush discard the next unsent record.
 */
export const flushRecords = async ({ beacon = false } = {}) => {
  if (state.flushing) return 0
  state.flushing = true
  let sent = 0
  try {
    while (state.outbox.length > 0) {
      const payload = state.outbox[0]
      state.inFlight = payload
      let delivered = false
      try {
        delivered =
          beacon === true && beaconAvailable()
            ? postWithBeacon(payload) || (await postWithFetch(payload))
            : await postWithFetch(payload)
      } finally {
        state.inFlight = null
      }
      if (!delivered) break
      // Remove by identity, never by position: a record built while this POST
      // was in flight can have hit the outbox cap and rebuilt the head, so a
      // positional shift would discard a record that was never sent.
      if (state.outbox[0] !== payload) break
      state.outbox.shift()
      sent += 1
    }
  } finally {
    state.flushing = false
  }
  return sent
}

const isBrowserEnvironment = () =>
  typeof globalThis.document?.createElement === 'function' &&
  typeof globalThis.document?.addEventListener === 'function'

/**
 * Start the background reporter (browser only, once per page). Returns `true`
 * when it started; Node/test environments return `false` without leaving a
 * timer behind.
 */
export const startPerfReporter = () => {
  if (state.reporter !== null) return false
  if (!perfEnabled() || !isBrowserEnvironment()) return false
  const reporter = {
    interval: null,
    observer: null,
    loafObserver: null,
    frame: null,
    lastFrameAt: null,
    hidden: false,
    onVisibility: null,
    onPageHide: null,
  }
  state.reporter = reporter
  try {
    // Fixed-rate window flush: the outbox is retried first, so a tick with no
    // increments still drains a record whose POST failed instead of waiting for
    // the next gesture. A window without increments is not built, and a gesture
    // is never split because `perfEndGesture` already reset the deltas.
    const interval = globalThis.setInterval?.(() => {
      if (!perfEnabled() || state.reporter !== reporter) return
      void flushRecords()
      if (!hasIncrements()) return
      buildRecord('window', idleGestureName())
      // Flushes the record just built; a no-op when the first flush is still in
      // flight (that one re-checks the outbox length and drains it too).
      void flushRecords()
    }, WINDOW_INTERVAL_MS)
    interval?.unref?.()
    reporter.interval = interval ?? null

    // Attribution source: prefer Long Animation Frame entries (the only place
    // the browser splits script vs style+layout vs render time), and keep the
    // legacy long-task observer where that entry type is not supported. Both
    // observers share this reporter's lifecycle and are disconnected on stop.
    const Observer = globalThis.PerformanceObserver
    if (typeof Observer === 'function') {
      const supported = Array.isArray(Observer.supportedEntryTypes) ? Observer.supportedEntryTypes : []
      if (supported.includes('long-animation-frame')) {
        try {
          const loafObserver = new Observer((list) => {
            for (const entry of list.getEntries()) recordLoafEntry(entry)
          })
          loafObserver.observe({ entryTypes: ['long-animation-frame'] })
          reporter.loafObserver = loafObserver
        } catch {
          reporter.loafObserver = null
        }
      }
      // Fallback also covers a browser that advertises LoAF but refuses to
      // observe it: losing the long-task duration as well would be worse.
      if (reporter.loafObserver === null) {
        try {
          const observer = new Observer((list) => {
            for (const entry of list.getEntries()) perfSample('longTaskMs', entry.duration)
          })
          observer.observe({ entryTypes: ['longtask'] })
          reporter.observer = observer
        } catch {
          reporter.observer = null
        }
      }
    }

    if (typeof globalThis.requestAnimationFrame === 'function') {
      const tickFrame = () => {
        if (state.reporter !== reporter) return
        const now = perfNow()
        if (reporter.lastFrameAt !== null) perfSample('frameGapMs', now - reporter.lastFrameAt)
        reporter.lastFrameAt = now
        reporter.frame = globalThis.requestAnimationFrame(tickFrame)
      }
      reporter.frame = globalThis.requestAnimationFrame(tickFrame)
    }

    const flushFinal = () => {
      if (state.reporter !== reporter || reporter.hidden) return
      reporter.hidden = true
      buildRecord('final', idleGestureName())
      void flushRecords({ beacon: true })
    }
    reporter.onPageHide = flushFinal
    reporter.onVisibility = () => {
      if (globalThis.document?.visibilityState === 'hidden') flushFinal()
      else reporter.hidden = false
    }
    globalThis.document.addEventListener('visibilitychange', reporter.onVisibility)
    globalThis.addEventListener?.('pagehide', flushFinal)
    return true
  } catch {
    // A partially installed reporter must not leak its timers/listeners.
    stopPerfReporter()
    return false
  }
}

/** Stop the reporter and release its timers, observers and listeners. */
export const stopPerfReporter = () => {
  const reporter = state.reporter
  if (reporter === null) return false
  state.reporter = null
  if (reporter.interval !== null) globalThis.clearInterval?.(reporter.interval)
  // At most one of the two is attached (LoAF preferred, long-task fallback),
  // but disconnect both slots so a stale handle can never outlive the reporter.
  for (const observer of [reporter.loafObserver, reporter.observer]) {
    try {
      observer?.disconnect?.()
    } catch {
      /* already disconnected */
    }
  }
  if (reporter.frame !== null) globalThis.cancelAnimationFrame?.(reporter.frame)
  try {
    if (typeof reporter.onVisibility === 'function') {
      globalThis.document?.removeEventListener?.('visibilitychange', reporter.onVisibility)
    }
    if (typeof reporter.onPageHide === 'function') {
      globalThis.removeEventListener?.('pagehide', reporter.onPageHide)
    }
  } catch {
    /* non-browser environment */
  }
  return true
}

/** Read the collected probe data (never throws). */
export const perfSnapshot = () => {
  const samples = Object.fromEntries(Object.entries(state.samples).map(([name, values]) => [name, summarize(values)]))
  return {
    enabled: perfEnabled(),
    startedAt: state.startedAt,
    capturedAt: perfNow(),
    counters: { ...state.counters },
    renders: { ...state.renders },
    dragOver: {
      ...state.dragOver,
      byHandler: { ...state.dragOver.byHandler },
      avgMs: state.dragOver.events > 0 ? round2(state.dragOver.totalMs / state.dragOver.events) : 0,
    },
    dropTarget: { ...state.dropTarget },
    samples,
    marks: [...state.marks],
    runId: currentRunId(),
    gesture: state.gesture?.name ?? null,
    outboxSize: state.outbox.length,
  }
}

/** Drop all collected data, stop the reporter and re-read the opt-in flag. */
export const perfReset = () => {
  stopPerfReporter()
  state = createState()
  cachedEnabled = null
  return perfSnapshot()
}

/** Expose the probe API once per page (idempotent). */
export const installPerfApi = () => {
  try {
    globalThis.__dsgPerfApi = {
      snapshot: perfSnapshot,
      reset: perfReset,
      enabled: perfEnabled,
      beginGesture: perfBeginGesture,
      endGesture: perfEndGesture,
      flush: flushRecords,
      start: startPerfReporter,
      stop: stopPerfReporter,
    }
  } catch {
    /* non-browser environment */
  }
}

installPerfApi()
