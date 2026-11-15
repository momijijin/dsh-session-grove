/**
 * Dialog scrollbar frame coalescing (0.4.0-beta.66 v8, spec §14.2.2).
 *
 * Two contracts: the mount measurement is synchronous (the thumb must exist on
 * the first paint) and every later scroll/resize/ResizeObserver notification is
 * coalesced into one recomputation per frame; the thumb's own drag stays
 * synchronous. The same-value bail keeps a stationary thumb from re-rendering
 * the dialog.
 *
 * `scroll-area.js` itself is a React component (`check:ui` territory, not
 * importable by `npm test` without collapsing the coverage gate), so the wiring
 * is pinned with source locks at the end.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { computeScrollBar, createScrollUpdateScheduler, mountScrollTracking } from '../../src/client/dialog-frame.js'
import { createFrameBatch } from '../../src/client/frame-batch.js'
import { perfReset, perfSnapshot } from '../../src/client/perf.js'

/** Manual rAF queue: `run()` executes exactly the frames armed so far. */
const makeFrames = () => {
  const queue = new Map()
  let nextId = 0
  return {
    requestFrame(callback) {
      nextId += 1
      queue.set(nextId, callback)
      return nextId
    },
    cancelFrame(id) {
      queue.delete(id)
    },
    run() {
      const callbacks = [...queue.values()]
      queue.clear()
      for (const callback of callbacks) callback()
    },
    armed: () => queue.size,
  }
}

/** Fake `setBar` with React's functional-update bail: an identical value skips. */
const makeBarState = () => {
  let bar = null
  let renders = 0
  return {
    setBar(update) {
      const next = typeof update === 'function' ? update(bar) : update
      if (next === bar) return
      bar = next
      renders += 1
    },
    get bar() {
      return bar
    },
    renders: () => renders,
  }
}

/** Elements/windows for the mount contract: listener registries + timer queue. */
const makeMountHarness = () => {
  const elementListeners = new Map()
  const windowListeners = new Map()
  const timers = new Map()
  const clearedTimers = []
  const observers = []
  let nextTimer = 0
  const register = (registry) => (type, listener) => {
    const list = registry.get(type) ?? []
    list.push(listener)
    registry.set(type, list)
  }
  const unregister = (registry) => (type, listener) => {
    const list = registry.get(type) ?? []
    const index = list.indexOf(listener)
    if (index !== -1) list.splice(index, 1)
  }
  const element = {
    scrollHeight: 900,
    clientHeight: 300,
    scrollTop: 0,
    addEventListener: register(elementListeners),
    removeEventListener: unregister(elementListeners),
  }
  const win = {
    addEventListener: register(windowListeners),
    removeEventListener: unregister(windowListeners),
    setTimeout(callback) {
      nextTimer += 1
      timers.set(nextTimer, callback)
      return nextTimer
    },
    clearTimeout(id) {
      clearedTimers.push(id)
      timers.delete(id)
    },
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback
        this.disconnected = false
        observers.push(this)
      }
      observe(target) {
        this.target = target
      }
      disconnect() {
        this.disconnected = true
      }
    },
  }
  return {
    element,
    win,
    observers,
    clearedTimers,
    emitElement(type) {
      for (const listener of [...(elementListeners.get(type) ?? [])]) listener()
    },
    emitWindow(type) {
      for (const listener of [...(windowListeners.get(type) ?? [])]) listener()
    },
    runOnlyTimer() {
      const entries = [...timers.entries()]
      timers.clear()
      for (const [, callback] of entries) callback()
    },
    timerCount: () => timers.size,
  }
}

test('the thumb math matches the scroller box', () => {
  const state = makeBarState()
  computeScrollBar({ element: { scrollHeight: 1000, clientHeight: 400, scrollTop: 300 }, setBar: state.setBar })
  // rail = 400 - 12 = 388, thumb = round(388 * 400 / 1000) = 155,
  // travel = 233, top = round(300 / 600 * 233) = 117.
  assert.deepEqual(state.bar, { height: 155, top: 117 })
  assert.equal(state.renders(), 1)
})

test('a stationary thumb bails out of the React update', () => {
  const state = makeBarState()
  const element = { scrollHeight: 1000, clientHeight: 400, scrollTop: 300 }
  computeScrollBar({ element, setBar: state.setBar })
  assert.equal(state.renders(), 1)
  computeScrollBar({ element, setBar: state.setBar })
  assert.equal(state.renders(), 1, 'the same height/top returns the previous state object')
  element.scrollTop = 330
  computeScrollBar({ element, setBar: state.setBar })
  assert.equal(state.renders(), 2, 'a moved thumb does re-render')
})

test('a missing scroller or non-scrollable content clears the bar', () => {
  const state = makeBarState()
  const element = { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 }
  computeScrollBar({ element, setBar: state.setBar })
  assert.deepEqual(state.bar, { height: 155, top: 0 })
  computeScrollBar({ element: null, setBar: state.setBar })
  assert.equal(state.bar, null, 'unmounted scroller clears the bar')
  computeScrollBar({ element: { scrollHeight: 400, clientHeight: 400, scrollTop: 0 }, setBar: state.setBar })
  assert.equal(state.bar, null, 'content that fits keeps the bar hidden')
})

test('every recomputation is counted as scrollArea:update', () => {
  // The `.66` release build ships with capture off; this case opts in.
  globalThis.__DSG_PERF__ = true
  perfReset()
  try {
    const state = makeBarState()
    const element = { scrollHeight: 1000, clientHeight: 400, scrollTop: 300 }
    computeScrollBar({ element, setBar: state.setBar })
    computeScrollBar({ element: null, setBar: state.setBar })
    assert.equal(perfSnapshot().counters['scrollArea:update'], 2)
  } finally {
    delete globalThis.__DSG_PERF__
    perfReset()
  }
})

test('a burst of notifications recomputes once per frame', () => {
  const frames = makeFrames()
  let computes = 0
  const scheduler = createScrollUpdateScheduler({ batch: createFrameBatch(frames), compute: () => { computes += 1 } })
  scheduler.schedule()
  scheduler.schedule()
  scheduler.schedule()
  assert.equal(computes, 0, 'nothing runs before the frame')
  assert.equal(frames.armed(), 1, 'three notifications share one frame')
  frames.run()
  assert.equal(computes, 1)
  scheduler.now()
  assert.equal(computes, 2, 'now() is the synchronous path (mount, thumb drag)')
})

test('every applied frame is counted as scrollArea:frame; now() is not', () => {
  // The `.66` release build ships with capture off; this case opts in.
  globalThis.__DSG_PERF__ = true
  perfReset()
  try {
    const frames = makeFrames()
    let computes = 0
    const scheduler = createScrollUpdateScheduler({ batch: createFrameBatch(frames), compute: () => { computes += 1 } })
    scheduler.schedule()
    scheduler.schedule()
    frames.run()
    assert.equal(perfSnapshot().counters['scrollArea:frame'], 1)
    scheduler.now()
    assert.equal(perfSnapshot().counters['scrollArea:frame'], 1, 'the synchronous path is not a frame')
    assert.equal(computes, 2)
  } finally {
    delete globalThis.__DSG_PERF__
    perfReset()
  }
})

test('cancel drops the pending recomputation', () => {
  const frames = makeFrames()
  let computes = 0
  const scheduler = createScrollUpdateScheduler({ batch: createFrameBatch(frames), compute: () => { computes += 1 } })
  scheduler.schedule()
  scheduler.cancel()
  assert.equal(frames.armed(), 0)
  frames.run()
  assert.equal(computes, 0)
})

test('mount measures synchronously, then coalesces every later notification', () => {
  const frames = makeFrames()
  const harness = makeMountHarness()
  const counts = { sync: 0, framed: 0 }
  const computeNow = () => { counts.sync += 1 }
  const scheduler = createScrollUpdateScheduler({
    batch: createFrameBatch(frames),
    compute: () => { counts.framed += 1 },
  })
  const cleanup = mountScrollTracking({ element: harness.element, scheduler, computeNow, win: harness.win })
  assert.equal(counts.sync, 1, 'the mount measurement is synchronous (first paint has a thumb)')
  assert.equal(frames.armed(), 1, 'the post-layout second pass goes through the frame')

  // Scroll notifications are coalesced, never synchronous.
  harness.emitElement('scroll')
  harness.emitElement('scroll')
  harness.emitElement('scroll')
  assert.equal(counts.sync, 1, 'scroll must not run the synchronous mount path')
  assert.equal(frames.armed(), 1, 'three scroll notifications share one frame')
  frames.run()
  assert.equal(counts.framed, 1)

  // The ResizeObserver callback is the same coalesced path.
  assert.equal(harness.observers.length, 1)
  assert.equal(harness.observers[0].target, harness.element)
  harness.observers[0].callback()
  harness.observers[0].callback()
  assert.equal(frames.armed(), 1)
  frames.run()
  assert.equal(counts.framed, 2)

  // The delayed second pass is a direct measure, not a queued frame.
  assert.equal(harness.timerCount(), 1)
  assert.equal(frames.armed(), 0)
  harness.runOnlyTimer()
  assert.equal(counts.sync, 2)

  cleanup()
  assert.equal(frames.armed(), 0, 'unmount cancels the pending frame')
  assert.deepEqual(harness.clearedTimers, [1])
  assert.equal(harness.observers[0].disconnected, true)
  harness.emitElement('scroll')
  harness.emitWindow('resize')
  assert.equal(frames.armed(), 0, 'removed listeners cannot arm a frame')
})

// --- wiring locks -----------------------------------------------------------
const scrollArea = readFileSync(new URL('../../src/client/scroll-area.js', import.meta.url), 'utf8')
const dialogFrame = readFileSync(new URL('../../src/client/dialog-frame.js', import.meta.url), 'utf8')

const startDragBody = scrollArea.slice(scrollArea.indexOf('const startDrag = (event) => {'), scrollArea.indexOf('useLayoutEffect('))
const onMoveBody = startDragBody.slice(startDragBody.indexOf('const onMove = (moveEvent) => {'), startDragBody.indexOf('const onEnd = () => {'))

test('scroll-area wiring: the layout effect mounts the tracking synchronously', () => {
  assert.match(scrollArea, /import \{ computeScrollBar, createScrollUpdateScheduler, mountScrollTracking \} from '\.\/dialog-frame\.js'/)
  assert.match(scrollArea, /useLayoutEffect\(\(\) => \{\s+const element = scrollerRef\.current\s+if \(!element\) return undefined\s+return mountScrollTracking\(\{ element, scheduler: schedulerRef\.current, computeNow \}\)/)
  // The component must not schedule its own rAF/timer: the pipeline owns them.
  assert.doesNotMatch(scrollArea, /requestAnimationFrame/)
  assert.doesNotMatch(scrollArea, /setTimeout/)
})

test('scroll-area wiring: the thumb drag stays synchronous', () => {
  assert.match(onMoveBody, /computeNow\(\)/)
  assert.doesNotMatch(onMoveBody, /schedulerRef\.current\.schedule/)
})

test('the mount contract measures before it schedules anything', () => {
  const mountBody = dialogFrame.slice(dialogFrame.indexOf('export const mountScrollTracking'))
  const computeAt = mountBody.indexOf('computeNow()')
  const scheduleAt = mountBody.indexOf('scheduler.schedule()')
  assert.ok(computeAt >= 0, 'the mount path calls computeNow')
  assert.ok(scheduleAt > computeAt, 'the synchronous measurement happens before the deferred pass')
  assert.match(mountBody, /scheduler\.cancel\(\)/)
})

test('the setBar same-value bail is the functional updater, not a fresh object', () => {
  assert.match(
    dialogFrame,
    /setBar\(\(previous\) => \(previous\?\.height === height && previous\?\.top === top \? previous : \{ height, top \}\)\)/
  )
})
