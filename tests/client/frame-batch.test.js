/**
 * Frame coalescer behavior (0.4.0-beta.66 v8, spec §14).
 *
 * The three real consumers (dialog gesture, scrollbar, drag target) are wired in
 * their own tests; this file pins the shared contract: last-wins per frame, one
 * armed frame, immediate `flush()`, dropping `cancel()`, and the injected rAF
 * pair that keeps the helper DOM-free.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createFrameBatch } from '../../src/client/frame-batch.js'

/** Manual rAF queue: `run()` executes exactly the frames armed so far. */
const makeFrames = () => {
  const queue = new Map()
  const cancelled = []
  let nextId = 0
  return {
    requestFrame(callback) {
      nextId += 1
      queue.set(nextId, callback)
      return nextId
    },
    cancelFrame(id) {
      cancelled.push(id)
      queue.delete(id)
    },
    run() {
      const callbacks = [...queue.values()]
      queue.clear()
      for (const callback of callbacks) callback()
    },
    armed: () => queue.size,
    cancelled,
  }
}

test('schedule keeps only the last callback of a frame', () => {
  const frames = makeFrames()
  const batch = createFrameBatch(frames)
  const calls = []
  batch.schedule(() => calls.push('first'))
  batch.schedule(() => calls.push('second'))
  batch.schedule(() => calls.push('last'))
  assert.equal(frames.armed(), 1, 'three schedules share one armed frame')
  assert.equal(batch.pending(), true)
  assert.deepEqual(calls, [], 'nothing runs before the frame')
  frames.run()
  assert.deepEqual(calls, ['last'])
  assert.equal(batch.pending(), false)
})

test('a frame leaves the batch empty and a later schedule arms a fresh one', () => {
  const frames = makeFrames()
  const batch = createFrameBatch(frames)
  let count = 0
  batch.schedule(() => { count += 1 })
  frames.run()
  assert.equal(batch.pending(), false)
  batch.schedule(() => { count += 1 })
  assert.equal(frames.armed(), 1, 'a second frame is armed after the first ran')
  frames.run()
  assert.equal(count, 2)
})

test('flush runs the queued callback immediately and cancels its frame', () => {
  const frames = makeFrames()
  const batch = createFrameBatch(frames)
  const calls = []
  batch.schedule(() => calls.push('queued'))
  batch.flush()
  assert.deepEqual(calls, ['queued'])
  assert.equal(frames.armed(), 0)
  assert.deepEqual(frames.cancelled, [1], 'the armed frame was cancelled, not leaked')
  frames.run()
  assert.deepEqual(calls, ['queued'], 'the cancelled frame never re-runs the callback')
  assert.equal(batch.pending(), false)
})

test('flush without a pending callback is a no-op', () => {
  const frames = makeFrames()
  const batch = createFrameBatch(frames)
  batch.flush()
  assert.deepEqual(frames.cancelled, [], 'no idle frame is cancelled')
  assert.equal(batch.pending(), false)
})

test('cancel drops the pending callback and its frame', () => {
  const frames = makeFrames()
  const batch = createFrameBatch(frames)
  const calls = []
  batch.schedule(() => calls.push('dropped'))
  batch.cancel()
  assert.equal(batch.pending(), false)
  assert.equal(frames.armed(), 0)
  frames.run()
  assert.deepEqual(calls, [])
})

test('cancel after the frame ran only clears the empty queue', () => {
  const frames = makeFrames()
  const batch = createFrameBatch(frames)
  let count = 0
  batch.schedule(() => { count += 1 })
  frames.run()
  batch.cancel()
  assert.equal(count, 1)
  assert.equal(batch.pending(), false)
  assert.deepEqual(frames.cancelled, [])
})

test('a callback that schedules during flush arms a new frame instead of looping', () => {
  const frames = makeFrames()
  const batch = createFrameBatch(frames)
  const calls = []
  batch.schedule(() => {
    calls.push('first')
    batch.schedule(() => calls.push('second'))
  })
  batch.flush()
  assert.deepEqual(calls, ['first'])
  assert.equal(frames.armed(), 1, 'the re-entrant schedule survives the flush')
  frames.run()
  assert.deepEqual(calls, ['first', 'second'])
})

test('a non-function callback never arms a frame', () => {
  const frames = makeFrames()
  const batch = createFrameBatch(frames)
  batch.schedule(null)
  batch.schedule(undefined)
  assert.equal(frames.armed(), 0)
  assert.equal(batch.pending(), false)
})

test('a callback that schedules during the frame run arms exactly one new frame', () => {
  const frames = makeFrames()
  const batch = createFrameBatch(frames)
  const calls = []
  batch.schedule(() => {
    calls.push('first')
    batch.schedule(() => calls.push('second'))
  })
  frames.run()
  assert.deepEqual(calls, ['first'])
  assert.equal(batch.pending(), true, 'the re-entrant schedule is queued')
  assert.equal(frames.armed(), 1, 'the run clears its slot first, so a new frame is armed')
  frames.run()
  assert.deepEqual(calls, ['first', 'second'])
  assert.equal(batch.pending(), false)
  assert.equal(frames.armed(), 0)
})

test('a throwing flush callback leaves the batch empty and reusable', () => {
  const frames = makeFrames()
  const batch = createFrameBatch(frames)
  batch.schedule(() => {
    throw new Error('flush boom')
  })
  assert.throws(() => batch.flush(), /flush boom/)
  assert.equal(batch.pending(), false, 'the throwing callback is not left pending')
  assert.equal(frames.armed(), 0, 'its frame was cancelled before the throw')
  const calls = []
  batch.schedule(() => calls.push('after-throw'))
  assert.equal(frames.armed(), 1, 'a later schedule still arms a frame')
  frames.run()
  assert.deepEqual(calls, ['after-throw'])
})

test('the default frame pair is resolved from the environment at creation time', () => {
  const saved = {
    requestAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame'),
    cancelAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame'),
  }
  const frames = makeFrames()
  const calls = []
  try {
    globalThis.requestAnimationFrame = frames.requestFrame
    globalThis.cancelAnimationFrame = frames.cancelFrame
    const batch = createFrameBatch()
    batch.schedule(() => calls.push('env-frame'))
    assert.equal(frames.armed(), 1, 'the injected environment rAF armed the frame')
    frames.run()
    assert.deepEqual(calls, ['env-frame'])
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
})

test('without rAF the default pair degrades to a timer instead of never running', () => {
  const saved = {
    requestAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame'),
    cancelAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame'),
  }
  try {
    // Node has no rAF, but pin the absence so a future runner cannot mask it.
    delete globalThis.requestAnimationFrame
    delete globalThis.cancelAnimationFrame
    const calls = []
    const batch = createFrameBatch()
    batch.schedule(() => calls.push('timer-frame'))
    assert.equal(batch.pending(), true)
    assert.deepEqual(calls, [], 'the fallback is still asynchronous')
    // flush clears the timer before it can fire, so the test never waits.
    batch.flush()
    assert.deepEqual(calls, ['timer-frame'])
    assert.equal(batch.pending(), false)
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
})

test('without rAF the fallback timer really runs the callback asynchronously once', async () => {
  const saved = {
    requestAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame'),
    cancelAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame'),
  }
  try {
    delete globalThis.requestAnimationFrame
    delete globalThis.cancelAnimationFrame
    const calls = []
    const batch = createFrameBatch()
    batch.schedule(() => calls.push('timer-frame'))
    assert.deepEqual(calls, [], 'the 16 ms fallback never runs synchronously')
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.deepEqual(calls, ['timer-frame'], 'the timer fired the queued callback')
    assert.equal(batch.pending(), false, 'the fired frame left the queue empty')
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.deepEqual(calls, ['timer-frame'], 'the fired timer does not run the callback again')
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
})
