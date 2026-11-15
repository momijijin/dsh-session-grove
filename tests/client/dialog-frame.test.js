/**
 * Dialog move/resize frame coalescing (0.4.0-beta.66 v8, spec §14.2.1).
 *
 * The gesture seam is driven directly with a fake frame queue: several moves in
 * one frame must commit once, a pointerup must land the release position even
 * when no rAF ever ran, and the committed ref must be written before React state
 * (N2 — `onEnd` persists the ref, never the state).
 *
 * `dialog-host.js` itself cannot be imported by `npm test` (the React component
 * modules are exercised by `check:ui` and would collapse the coverage gate), so
 * the wiring is pinned with source locks at the end of this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createDialogGestureFrame } from '../../src/client/dialog-frame.js'
import { createFrameBatch } from '../../src/client/frame-batch.js'
import { perfReset, perfSnapshot } from '../../src/client/perf.js'

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

/** Pointerdown at (10, 10) on a 400×300 dialog whose top-left is (100, 100). */
const GESTURE_START = { x: 100, y: 100, width: 400, height: 300 }
const POINTER_ORIGIN = { x: 10, y: 10 }

const makeGesture = () => {
  const frames = makeFrames()
  const batch = createFrameBatch(frames)
  const rectRef = { current: { ...GESTURE_START } }
  const commits = []
  const frame = createDialogGestureFrame({
    batch,
    // Same shape as the host's solve closure: pointer delta → clamped rect.
    solve: (x, y) => ({
      x: GESTURE_START.x + (x - POINTER_ORIGIN.x),
      y: GESTURE_START.y + (y - POINTER_ORIGIN.y),
      width: GESTURE_START.width,
      height: GESTURE_START.height,
    }),
    rectRef,
    setRect: (rect) => commits.push({ rect, refAtSet: rectRef.current }),
  })
  return { frames, batch, frame, rectRef, commits }
}

test('one frame commits only the newest pointer position', () => {
  const { frames, frame, commits } = makeGesture()
  frame.move(20, 10)
  frame.move(30, 30)
  frame.move(50, 40)
  assert.equal(commits.length, 0, 'no commit before the frame runs')
  assert.equal(frames.armed(), 1, 'three pointermoves share one frame')
  frames.run()
  assert.equal(commits.length, 1)
  assert.deepEqual(commits[0].rect, { x: 140, y: 130, width: 400, height: 300 })
})

test('the committed rect is written to the ref before React state (N2)', () => {
  const { frames, frame, rectRef, commits } = makeGesture()
  frame.move(50, 40)
  frames.run()
  assert.deepEqual(commits[0].refAtSet, commits[0].rect, 'setRect already sees the new ref value')
  assert.deepEqual(rectRef.current, commits[0].rect, 'the persisted ref is the committed rect')
})

test('pointerup lands the release position without ever running the frame', () => {
  const { frames, frame, rectRef, commits } = makeGesture()
  frame.move(20, 10)
  frame.move(50, 60)
  assert.equal(commits.length, 0)
  const committed = frame.end(70, 80)
  assert.equal(committed, true)
  assert.equal(commits.length, 1, 'exactly one final commit')
  assert.deepEqual(commits[0].rect, { x: 160, y: 170, width: 400, height: 300 })
  assert.deepEqual(rectRef.current, commits[0].rect)
  assert.equal(frames.armed(), 0, 'the queued frame was cancelled by the settle')
  frames.run()
  assert.equal(commits.length, 1, 'the cancelled frame never commits again')
})

test('the release event coordinates win over the newest queued move', () => {
  const { frame, commits } = makeGesture()
  frame.move(20, 10)
  frame.end(30, 20)
  assert.deepEqual(commits[0].rect, { x: 120, y: 110, width: 400, height: 300 })
})

test('a press that never moved commits nothing', () => {
  const { frames, frame, rectRef, commits } = makeGesture()
  const committed = frame.end(80, 80)
  assert.equal(committed, false)
  assert.equal(commits.length, 0)
  assert.equal(frames.armed(), 0)
  assert.deepEqual(rectRef.current, GESTURE_START, 'the stored geometry is untouched')
})

test('a release after the queued frame already ran still lands the release position', () => {
  const { frames, frame, commits } = makeGesture()
  frame.move(20, 10)
  frames.run()
  assert.equal(commits.length, 1)
  const committed = frame.end(40, 10)
  assert.equal(committed, true)
  assert.equal(commits.length, 2)
  assert.deepEqual(commits[1].rect, { x: 130, y: 100, width: 400, height: 300 })
})

test('end without event coordinates falls back to the newest queued move', () => {
  const { frame, commits } = makeGesture()
  frame.move(20, 10)
  frame.move(45, 15)
  const committed = frame.end(undefined, undefined)
  assert.equal(committed, true)
  assert.deepEqual(commits[0].rect, { x: 135, y: 105, width: 400, height: 300 })
})

test('end ignores non-finite event coordinates', () => {
  const { frame, commits } = makeGesture()
  frame.move(25, 25)
  const committed = frame.end(Number.NaN, 40)
  assert.equal(committed, true)
  assert.deepEqual(commits[0].rect, { x: 115, y: 115, width: 400, height: 300 })
})

/**
 * Mirrors the host's release-coordinate guard (pinned by the source lock at the
 * end of this file): only a real pointerup contributes its coordinates; a
 * pointercancel settles from the frame's newest pending sample.
 */
const releaseFor = (event) =>
  event?.type === 'pointerup' ? [event.clientX, event.clientY] : [undefined, undefined]

test('a pointercancel with 0/0 coordinates settles on the pending sample', () => {
  const { frames, frame, commits } = makeGesture()
  frame.move(20, 10)
  frame.move(30, 20)
  // Chromium reports the scroll-takeover cancel as clientX=0, clientY=0; those
  // coordinates would have solved to the top-left instead of the last sample.
  const [x, y] = releaseFor({ type: 'pointercancel', clientX: 0, clientY: 0 })
  frame.end(x, y)
  assert.equal(commits.length, 1)
  assert.deepEqual(commits[0].rect, { x: 120, y: 110, width: 400, height: 300 })
  assert.equal(frames.armed(), 0, 'the queued frame was settled synchronously')
})

test('pointerup still settles on the release coordinates', () => {
  const { frame, commits } = makeGesture()
  frame.move(20, 10)
  const [x, y] = releaseFor({ type: 'pointerup', clientX: 70, clientY: 80 })
  frame.end(x, y)
  assert.deepEqual(commits[0].rect, { x: 160, y: 170, width: 400, height: 300 })
})

test('a non-finite pointer sample never arms a frame', () => {
  const { frames, frame } = makeGesture()
  frame.move(Number.NaN, 10)
  frame.move(10, Number.POSITIVE_INFINITY)
  assert.equal(frames.armed(), 0)
  assert.equal(frame.pending(), false)
})

test('dispose cancels the queued frame and forgets the sample', () => {
  const { frames, frame, commits } = makeGesture()
  frame.move(20, 10)
  frame.dispose()
  assert.equal(frame.pending(), false)
  assert.equal(frames.armed(), 0)
  frames.run()
  assert.equal(commits.length, 0)
})

test('each applied frame increments the dialog:frame counter', () => {
  // The `.66` release build ships with capture off; this case opts in.
  globalThis.__DSG_PERF__ = true
  perfReset()
  try {
    const { frames, frame } = makeGesture()
    frame.move(20, 10)
    frame.move(30, 20)
    assert.equal(perfSnapshot().counters['dialog:frame'] ?? 0, 0, 'moves alone are not frames')
    frames.run()
    assert.equal(perfSnapshot().counters['dialog:frame'], 1)
    frame.end(35, 25)
    assert.equal(perfSnapshot().counters['dialog:frame'], 2, 'the synchronous settle is one more frame')
  } finally {
    delete globalThis.__DSG_PERF__
    perfReset()
  }
})

// --- wiring locks -----------------------------------------------------------
// The seam above is the shipped implementation; these locks prove dialog-host.js
// actually routes the trigger through it instead of calling setState per move.
const dialogHost = readFileSync(new URL('../../src/client/dialog-host.js', import.meta.url), 'utf8')

const gestureBlock = dialogHost.slice(
  dialogHost.indexOf('const beginDialogGesture = (event, dir = null) => {'),
  dialogHost.indexOf('// A dialog can unmount mid-gesture')
)
const onMoveBody = gestureBlock.slice(gestureBlock.indexOf('const onMove = (moveEvent) => {'), gestureBlock.indexOf('const onEnd = (endEvent) => {'))
const onEndBody = gestureBlock.slice(
  gestureBlock.indexOf('const onEnd = (endEvent) => {'),
  gestureBlock.indexOf("doc?.addEventListener?.('pointermove', onMove)")
)
const cleanupBody = gestureBlock.slice(gestureBlock.indexOf('gestureCleanupRef.current = () => {'))

test('dialog-host gesture wiring: onMove only records the newest sample', () => {
  assert.match(dialogHost, /import \{ createDialogGestureFrame \} from '\.\/dialog-frame\.js'/)
  assert.match(dialogHost, /import \{ createFrameBatch \} from '\.\/frame-batch\.js'/)
  assert.match(gestureBlock, /createDialogGestureFrame\(\{\s+batch: createFrameBatch\(\),/)
  assert.match(onMoveBody, /perfCount\('dialog:gestureMove'\)/)
  assert.match(onMoveBody, /frame\.move\(moveEvent\.clientX, moveEvent\.clientY\)/)
  // The mutant this lock kills: solving and setState inside every pointermove.
  assert.doesNotMatch(onMoveBody, /setDialogRect/)
  assert.doesNotMatch(onMoveBody, /resizeDialogRect|dragDialogRect/)
})

test('dialog-host gesture wiring: onEnd settles synchronously before persisting', () => {
  assert.match(onEndBody, /frame\.end\(release\?\.clientX, release\?\.clientY\)/)
  assert.ok(
    onEndBody.indexOf('frame.end(') < onEndBody.indexOf('saveDialogGeometry('),
    'the final rect must be committed before the geometry is persisted'
  )
  // pointercancel is registered with the same onEnd: the cancel path settles too.
  assert.match(gestureBlock, /addEventListener\?\.\('pointercancel', onEnd\)/)
})

test('dialog-host gesture wiring: only pointerup contributes release coordinates', () => {
  // Chromium's scroll-takeover pointercancel carries clientX=0, clientY=0;
  // passing those through would teleport the dialog to the top-left.
  assert.match(onEndBody, /const release = endEvent\?\.type === 'pointerup' \? endEvent : null/)
  assert.doesNotMatch(onEndBody, /frame\.end\(endEvent\?\.clientX/)
})

test('dialog-host gesture wiring: the cleanup cancels the pending frame', () => {
  assert.match(cleanupBody, /frame\.dispose\(\)/)
  assert.ok(
    cleanupBody.indexOf('frame.dispose()') > cleanupBody.indexOf("removeEventListener?.('pointercancel'"),
    'listeners are released first, then the queued frame is dropped'
  )
})
