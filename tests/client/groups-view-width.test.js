import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'

// The hook module imports the host React peer at top level. Map it to the test
// stub before the dynamic import below (same loader the resize-handle test uses).
register(new URL('../support/react-loader.mjs', import.meta.url))

const { applyWidthWriteTo, createWidthWriteScheduler, useGroupsSidebarWidth } = await import(
  '../../src/client/groups-view-width.js'
)
const source = readFileSync(new URL('../../src/client/groups-view-width.js', import.meta.url), 'utf8')
const menuSource = readFileSync(new URL('../../src/client/groups-view-menu-handlers.js', import.meta.url), 'utf8')

/**
 * Fake clock + rAF harness for the pure scheduler. `apply` records writes and
 * returns the clock value at which the controller write started; the frame
 * callback then measures the next rAF start (the write-frame cost).
 */
const createHarness = ({ apply } = {}) => {
  const clock = { now: 0 }
  const frames = new Map()
  const writes = []
  let nextFrameId = 0
  const scheduler = createWidthWriteScheduler({
    apply:
      apply ??
      ((next, viewport) => {
        writes.push({ next, viewport })
        return clock.now
      }),
    now: () => clock.now,
    requestFrame: (callback) => {
      nextFrameId += 1
      frames.set(nextFrameId, callback)
      return nextFrameId
    },
    cancelFrame: (id) => {
      frames.delete(id)
    },
  })
  const runFrames = () => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback()
  }
  return { clock, frames, writes, scheduler, runFrames }
}

test('preview applies immediately and the interval follows the measured write-frame EMA', () => {
  const harness = createHarness()
  assert.equal(harness.scheduler.preview(400), true)
  assert.deepEqual(harness.writes, [{ next: 400, viewport: undefined }])

  harness.clock.now = 20
  assert.equal(harness.scheduler.preview(410), false, 'the first write uses the 32ms floor')
  assert.equal(harness.writes.length, 1, 'a preview inside the interval never writes the variable')

  // The next rAF start is 70ms after the controller write: one write frame is
  // 70ms, so the interval becomes max(32, 1.5 * 70) = 105ms.
  harness.clock.now = 70
  harness.runFrames()
  assert.equal(harness.scheduler.emaMs(), 70)
  assert.equal(harness.scheduler.intervalMs(), 105)

  harness.clock.now = 100
  assert.equal(harness.scheduler.preview(420), false, '100ms < the EMA-derived 105ms')
  harness.clock.now = 106
  assert.equal(harness.scheduler.preview(430), true)
  assert.deepEqual(harness.writes.map(({ next }) => next), [400, 430])

  // A second 54ms write frame moves the EMA to 70*0.7 + 54*0.3 = 65.2.
  harness.clock.now = 160
  harness.runFrames()
  assert.ok(Math.abs(harness.scheduler.emaMs() - 65.2) < 1e-9, 'EMA alpha is 0.3')
  harness.scheduler.dispose()
})

test('commit writes unconditionally and restarts the pacing window', () => {
  const harness = createHarness()
  assert.equal(harness.scheduler.preview(400), true)

  harness.clock.now = 10
  assert.equal(harness.scheduler.preview(410), false, 'the preview is inside the interval')
  harness.clock.now = 11
  assert.equal(harness.scheduler.commit(410, 1200), true, 'commit bypasses the interval')
  assert.deepEqual(harness.writes, [
    { next: 400, viewport: undefined },
    { next: 410, viewport: 1200 },
  ])

  harness.clock.now = 20
  assert.equal(harness.scheduler.preview(420), false, 'the commit restarts the interval')
  harness.clock.now = 43
  assert.equal(harness.scheduler.preview(420), true)
  harness.scheduler.dispose()
})

test('a controller write that does not happen never advances the pacing clock', () => {
  const harness = createHarness({ apply: () => null })
  assert.equal(harness.scheduler.preview(400), false)
  harness.clock.now = 1
  assert.equal(harness.scheduler.preview(400), false)
  assert.equal(harness.scheduler.emaMs(), null)
})

test('an invalid write-frame sample leaves the EMA unset', () => {
  const frames = new Map()
  let clockReads = 0
  const scheduler = createWidthWriteScheduler({
    apply: () => 0,
    now: () => {
      clockReads += 1
      return clockReads === 1 ? 0 : -5
    },
    requestFrame: (callback) => {
      frames.set(1, callback)
      return 1
    },
    cancelFrame: (id) => frames.delete(id),
  })
  assert.equal(scheduler.preview(400), true)
  const measure = frames.get(1)
  frames.delete(1)
  measure()
  assert.equal(scheduler.emaMs(), null)
  scheduler.dispose()
})

test('a stalled write-frame sample (hidden tab) does not pollute the EMA or the interval', () => {
  const harness = createHarness()
  assert.equal(harness.scheduler.preview(400), true)
  harness.clock.now = 70
  harness.runFrames()
  assert.equal(harness.scheduler.emaMs(), 70, 'one 70ms write frame sets the EMA')
  assert.equal(harness.scheduler.intervalMs(), 105)

  harness.clock.now = 106
  assert.equal(harness.scheduler.preview(410), true)

  // The tab was hidden for a minute: rAF stalled, so the "write frame" sample is
  // the whole stall. Folding it in would push the interval to ~90s and the next
  // drag would barely write the variable at all.
  harness.clock.now = 106 + 60_000
  harness.runFrames()
  assert.equal(harness.scheduler.emaMs(), 70, 'a >500ms sample is not a write frame and is ignored')
  assert.equal(harness.scheduler.intervalMs(), 105, 'the adaptive interval keeps its frame-scale value')

  // The EMA is still live for real samples after the ignored one.
  harness.clock.now = 212
  assert.equal(harness.scheduler.preview(420), true)
  harness.clock.now = 266
  harness.runFrames()
  assert.ok(Math.abs(harness.scheduler.emaMs() - 65.2) < 1e-9, '70*0.7 + 54*0.3 = 65.2')
  harness.scheduler.dispose()
})

test('applyWidthWriteTo treats controller.update() === null as a failed write', () => {
  const controller = {
    accepted: null,
    calls: 0,
    update() {
      this.calls += 1
      return this.accepted
    },
  }
  // A collapsed sidebar / detached host node makes the adapter return null.
  assert.equal(applyWidthWriteTo(controller, 500, 1440), null)
  assert.equal(controller.calls, 1, 'the controller was asked')
  assert.equal(applyWidthWriteTo(null, 500, 1440), null, 'no controller is a failed write, not a zero-cost one')
  controller.accepted = 480
  assert.ok(Number.isFinite(applyWidthWriteTo(controller, 500, 1440)), 'a successful write returns its start time')
})

test('a refused controller write does not advance the pacing clock or the EMA', () => {
  const clock = { now: 0 }
  const frames = new Map()
  let frameId = 0
  const controller = {
    accept: false,
    update() {
      return this.accept ? clock.now : null
    },
  }
  const scheduler = createWidthWriteScheduler({
    apply: (next, viewport) => applyWidthWriteTo(controller, next, viewport),
    now: () => clock.now,
    requestFrame: (callback) => {
      frameId += 1
      frames.set(frameId, callback)
      return frameId
    },
    cancelFrame: (id) => frames.delete(id),
  })
  assert.equal(scheduler.preview(400), false)
  assert.equal(scheduler.emaMs(), null, 'a refused write never schedules a write-frame measurement')
  controller.accept = true
  clock.now = 1
  assert.equal(scheduler.preview(400), true, 'the refused attempt did not arm the 32ms window')
  scheduler.dispose()
})

test('a throwing controller write leaves the pacing window open for the next preview', () => {
  const clock = { now: 0 }
  const frames = new Map()
  let frameId = 0
  let attempts = 0
  const scheduler = createWidthWriteScheduler({
    apply: () => {
      attempts += 1
      if (attempts === 1) throw new Error('boom')
      return clock.now
    },
    now: () => clock.now,
    requestFrame: (callback) => {
      frameId += 1
      frames.set(frameId, callback)
      return frameId
    },
    cancelFrame: (id) => frames.delete(id),
  })
  assert.throws(() => scheduler.preview(400), /boom/)
  clock.now = 1
  assert.equal(scheduler.preview(440), true, 'the failed attempt must not start the throttle window')
  assert.equal(attempts, 2)
  scheduler.dispose()
})

test('commit writes the variable even when no preview ever ran', () => {
  const harness = createHarness()
  assert.equal(harness.scheduler.commit(500), true)
  assert.deepEqual(harness.writes, [{ next: 500, viewport: undefined }])
  harness.clock.now = 20
  assert.equal(harness.scheduler.preview(510), false, 'the commit armed the interval')
  harness.clock.now = 33
  assert.equal(harness.scheduler.preview(510), true)
  harness.scheduler.dispose()
})
test('preview updates refs and the scheduler without touching React state', () => {
  const start = source.indexOf('const previewWidth =')
  const end = source.indexOf('const commitWidth =', start)
  assert.ok(start !== -1 && end > start, 'the hook must split preview and commit')
  const preview = source.slice(start, end)

  assert.match(preview, /preferredWidthRef\.current = next/)
  assert.match(preview, /liveWidthRef\.current = next/)
  assert.match(preview, /widthSchedulerRef\.current\.preview\(next\)/)
  assert.doesNotMatch(preview, /setPreferredWidth|setViewportWidth/, 'preview must not schedule a React render')
  assert.match(source, /const handleWidthChange = previewWidth/)
})

test('commit writes the variable and live ref before state and persistence', () => {
  const start = source.indexOf('const commitWidth =')
  const end = source.indexOf('const handleWidthReset =', start)
  assert.ok(start !== -1 && end > start)
  const commit = source.slice(start, end)

  const writeAt = commit.indexOf('widthSchedulerRef.current.commit(next, globalThis.innerWidth)')
  const liveAt = commit.indexOf('liveWidthRef.current = next')
  const stateAt = commit.indexOf('setPreferredWidth(next)')
  const persistAt = commit.indexOf('writeSidebarWidth(next)')
  const perfWidthAt = commit.indexOf('perfSidebarWidth(next)')
  assert.ok(writeAt !== -1, 'commit must call the unconditional scheduler commit')
  assert.ok(liveAt > writeAt, 'the live width follows the controller write')
  assert.ok(stateAt > liveAt, 'React state follows the live ref')
  assert.ok(persistAt > stateAt, 'persistence follows the state update')
  assert.ok(
    perfWidthAt > persistAt,
    'the committed width is published for the gesture record that closes right after this commit'
  )
})

test('handleWidthReset commits and clears the live width, and resetLayout routes through it', () => {
  const start = source.indexOf('const handleWidthReset =')
  const end = source.indexOf('return {', start)
  assert.ok(start !== -1 && end > start)
  const reset = source.slice(start, end)

  assert.match(reset, /widthSchedulerRef\.current\.commit\(next, viewport\)/)
  assert.match(reset, /liveWidthRef\.current = next/)
  assert.match(reset, /setPreferredWidth\(SIDEBAR_WIDTH_DEFAULT\)/)
  assert.match(reset, /writeSidebarWidth\(SIDEBAR_WIDTH_DEFAULT\)/)
  assert.match(
    menuSource,
    /resetLayout: \(\) => \{\r?\n\s+rt\(\)\?\.resetLayout\?\.\(\)\r?\n\s+handleWidthReset\(\)/
  )
})

test('the hook exposes a live width for the chrome gate and keeps it fed by sync', () => {
  assert.match(source, /const liveWidthRef = useRef\(null\)/)
  assert.match(source, /const getLiveWidth = \(\) =>/)
  assert.match(source, /liveWidthRef\.current = clamped/)
  const returned = source.slice(source.indexOf('return {'))
  assert.match(returned, /getLiveWidth/)
  assert.match(returned, /previewWidth/)
  assert.match(returned, /commitWidth/)
  assert.match(returned, /cancelWidth/)
})

test('the hook live width advances on preview, commit, alias and reset', () => {
  // The test React stub returns inert hooks, so the effect body is not run;
  // these calls still exercise the public preview/commit/reset contract.
  const hook = useGroupsSidebarWidth({ wide: false, docState: null, rootRef: { current: null } })
  assert.equal(hook.getLiveWidth(), null)

  hook.previewWidth(500)
  assert.equal(hook.getLiveWidth(), 500)
  hook.commitWidth(500)
  assert.equal(hook.getLiveWidth(), 500)
  hook.handleWidthChange(480)
  assert.equal(hook.getLiveWidth(), 480)
  hook.handleWidthReset()
  assert.equal(hook.getLiveWidth(), 420, 'reset returns the live width to the design default')
})

test('cancelWidth returns the live width to the committed preference without persisting or re-rendering', () => {
  const hook = useGroupsSidebarWidth({ wide: false, docState: null, rootRef: { current: null } })
  hook.previewWidth(500)
  assert.equal(hook.getLiveWidth(), 500, 'a preview advances the live ref')
  hook.cancelWidth()
  assert.equal(hook.getLiveWidth(), 420, 'cancel returns the live ref to the committed preference')
  assert.equal(hook.appliedWidth, 420, 'cancel never advances React state')
})

test('cancelWidth is a view rollback: committed state only, no persistence, no React update', () => {
  const start = source.indexOf('const cancelWidth =')
  const end = source.indexOf('const handleWidthReset =', start)
  assert.ok(start !== -1 && end > start, 'the hook must expose a cancel path')
  const cancel = source.slice(start, end)
  assert.match(
    cancel,
    /const committed = clampSidebarWidth\(preferredWidth, viewport\)/,
    'the committed state value, never the previewed `preferredWidthRef`'
  )
  assert.match(cancel, /widthSchedulerRef\.current\.commit\(committed, viewport\)/)
  assert.match(cancel, /liveWidthRef\.current = committed/)
  assert.match(cancel, /preferredWidthRef\.current = committed \?\? preferredWidth/)
  assert.doesNotMatch(cancel, /writeSidebarWidth|setPreferredWidth/, 'cancel must not persist or schedule React state')
})

test('the groups view wires the handle cancel path to the hook rollback', () => {
  const components = readFileSync(new URL('../../src/client/components.js', import.meta.url), 'utf8')
  assert.match(components, /cancelWidth,/)
  assert.match(components, /onCancel: cancelWidth/)
})
