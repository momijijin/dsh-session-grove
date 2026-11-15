/**
 * Drag target hold timer + speed gate + name cache (0.4.0-beta.66 v10,
 * spec §15.2/§16.2).
 *
 * In the run8 trace every drop-target change inserted or removed the
 * placeholder, and each of those layout pushes cost a 22–25 ms style+layout
 * long task (drag-group: 46 changes / ~1.06 s; drag-session: 21 changes). The
 * seam keeps a target only after it survives `TARGET_HOLD_MS` (70 ms) while the
 * pointer sweeps: an unchanged target does not restart the hold, a changed
 * target restarts it from the newest one, and drop/end paths flush the current
 * candidate synchronously so a drop never reads the previous target.
 *
 * v10 adds the speed gate: a slow aim (net speed below `SPEED_GATE_PX_PER_MS`
 * over `SPEED_WINDOW_MS`) or a pause above `PAUSE_MS` commits immediately, and a
 * hold that is still pending is upgraded when the last `UPGRADE_WINDOW_MS` of
 * samples slows down. The tests drive the fake pointer and the fake clock
 * together at a 3–9 ms sampling step; `components.js` is a React component
 * module (`check:ui` territory, not importable by `npm test` without collapsing
 * the coverage gate), so its wiring is pinned with source locks at the end.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { sameDropTarget } from '../../src/core/drag.js'
import {
  createDragLabelCache,
  createDropTargetCommit,
  PAUSE_MS,
  SAMPLE_DEDUPE_MS,
  SPEED_GATE_PX_PER_MS,
  TARGET_HOLD_MS,
  UPGRADE_WINDOW_MS,
} from '../../src/client/drag-frame.js'
import { perfReset, perfSnapshot } from '../../src/client/perf.js'

/**
 * Manual clock: `advance()` runs every timer whose due time is reached, in due
 * order, and re-scans after each callback so a callback can schedule its own
 * timer. `armed()` reports how many timers are still pending.
 */
const makeClock = () => {
  let time = 0
  let nextId = 0
  const timers = new Map()
  return {
    now: () => time,
    setTimer: (callback, ms) => {
      nextId += 1
      timers.set(nextId, { at: time + ms, callback })
      return nextId
    },
    clearTimer: (id) => {
      timers.delete(id)
    },
    advance(ms) {
      const target = time + ms
      for (;;) {
        let dueId = null
        let due = null
        for (const [id, timer] of timers) {
          if (timer.at > target) continue
          if (due === null || timer.at < due.at) {
            due = timer
            dueId = id
          }
        }
        if (due === null) break
        timers.delete(dueId)
        time = due.at
        due.callback()
      }
      time = target
    },
    armed: () => timers.size,
  }
}

const targetBefore = (sessionId) => ({ kind: 'session-before', groupId: 'g1', sessionId })
const targetAfter = (sessionId) => ({ kind: 'session-after', groupId: 'g1', sessionId })

/**
 * The production wiring in miniature: `publish` is the only place that writes
 * the React mirror (`read()`), `clearLock` releases the resting-pointer lock.
 */
const makeCommit = () => {
  const clock = makeClock()
  let committed = null
  let lock = null
  const published = []
  const changes = []
  const skips = []
  const commit = createDropTargetCommit({
    same: sameDropTarget,
    read: () => committed,
    publish: (next) => {
      committed = next
      published.push(next)
    },
    clearLock: () => {
      lock = null
    },
    onChange: (previous, next) => changes.push({ previous, next }),
    onSkip: () => skips.push(true),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  return {
    clock,
    commit,
    published,
    changes,
    skips,
    read: () => committed,
    lock: () => lock,
    setLock: (value) => {
      lock = value
    },
  }
}

/** Pointer sample `{ x, y, t }` at the fake clock's current time. */
const pointerAt = (harness, y) => ({ x: 12, y, t: harness.clock.now() })

/** Advance the fake clock by `ms`, then feed one dragover sample for `target`. */
const drive = (harness, ms, target, y) => {
  harness.clock.advance(ms)
  harness.commit.set(target, pointerAt(harness, y))
}

test('a candidate is not committed before the 70 ms hold expires', () => {
  const harness = makeCommit()
  const target = targetBefore('s1')
  harness.commit.set(target)
  assert.deepEqual(harness.published, [], 'a fresh candidate stays unpublished')
  assert.equal(harness.commit.pending(), true)
  harness.clock.advance(TARGET_HOLD_MS - 1)
  assert.deepEqual(harness.published, [], 'one millisecond short of the hold publishes nothing')
  harness.clock.advance(1)
  assert.deepEqual(harness.published, [target], 'the timer drives the commit')
  assert.equal(harness.commit.pending(), false)
  assert.equal(harness.clock.armed(), 0, 'the hold timer is spent after it fires')
})

test('a repeated dragover with the same target does not restart the hold', () => {
  const harness = makeCommit()
  const target = targetBefore('s1')
  harness.commit.set(target)
  harness.clock.advance(60)
  const startedAt = harness.commit.candidateAt()
  // The pointer rests: every dragover rebuilds an equivalent target object.
  harness.commit.set(targetBefore('s1'))
  assert.equal(harness.commit.candidateAt(), startedAt, 'the candidate clock did not move')
  assert.equal(harness.clock.armed(), 1, 'the original hold timer is still the only one')
  harness.clock.advance(10)
  assert.deepEqual(harness.published, [target], 'the hold expires 70 ms after the first set, not the repeat')
})

test('a new candidate restarts the hold from the newest target', () => {
  const harness = makeCommit()
  const first = targetBefore('s1')
  const second = targetAfter('s2')
  harness.commit.set(first)
  harness.clock.advance(50)
  assert.equal(harness.commit.candidateAt(), 0, 'the first candidate started at t=0')
  harness.commit.set(second)
  assert.equal(harness.commit.candidateAt(), 50, 'the hold is anchored on the new candidate')
  harness.clock.advance(TARGET_HOLD_MS - 1)
  assert.deepEqual(harness.published, [], 'the replaced candidate never publishes')
  harness.clock.advance(1)
  assert.deepEqual(harness.published, [second], 'the hold restarted at B and expired there')
})

test('flush commits an unstable candidate before a drop reads it', () => {
  const harness = makeCommit()
  const target = targetBefore('s1')
  harness.commit.set(target)
  harness.clock.advance(30)
  assert.equal(harness.commit.flush(), true, 'a drop flushes the candidate before the hold expires')
  assert.deepEqual(harness.published, [target])
  assert.equal(harness.clock.armed(), 0, 'the flush clears the hold timer')
  assert.equal(harness.commit.flush(), false, 'the flush is idempotent')
  harness.clock.advance(200)
  assert.deepEqual(harness.published, [target], 'the cancelled hold never re-commits')
})

test('dragend/settle lands null immediately and the cancelled candidate cannot publish afterwards', () => {
  const harness = makeCommit()
  const first = targetBefore('s1')
  harness.commit.set(first)
  harness.clock.advance(TARGET_HOLD_MS)
  assert.deepEqual(harness.published, [first])
  const second = targetAfter('s2')
  harness.commit.set(second)
  harness.clock.advance(30)
  harness.setLock({ x: 4, y: 4, target: second })
  // `settleDropTarget()` = set(null) + flush(), the dragend/dragleave path.
  harness.commit.set(null)
  harness.commit.flush()
  assert.deepEqual(harness.published, [first, null], 'the settle publishes null in the same tick')
  assert.equal(harness.read(), null)
  assert.equal(harness.lock(), null, 'the resting-pointer lock is released')
  assert.equal(harness.clock.armed(), 0)
  harness.clock.advance(200)
  assert.deepEqual(harness.published, [first, null], 'the cancelled B hold cannot resurrect the target')
})

test('cancel drops the candidate and its timer for good', () => {
  const harness = makeCommit()
  harness.commit.set(targetBefore('s1'))
  harness.clock.advance(30)
  harness.commit.cancel()
  assert.equal(harness.commit.pending(), false)
  assert.equal(harness.clock.armed(), 0)
  harness.clock.advance(200)
  assert.deepEqual(harness.published, [], 'a cancelled candidate never commits')
  assert.equal(harness.commit.flush(), false, 'a flush after cancel is a no-op')
})

test('a null settle releases the lock even when the target is already null', () => {
  const harness = makeCommit()
  harness.setLock({ x: 9, y: 9, target: targetBefore('s2') })
  harness.commit.set(null)
  harness.commit.flush()
  assert.equal(harness.lock(), null, 'dragend/dragleave stay idempotent')
  assert.deepEqual(harness.published, [], 'a null settle onto null publishes nothing')
  assert.equal(harness.skips.length, 1, 'the dedupe kept React out')
})

test('a repeated null settle keeps the pending hold instead of restarting it', () => {
  const harness = makeCommit()
  harness.setLock({ x: 9, y: 9, target: targetBefore('s2') })
  harness.commit.set(null)
  harness.clock.advance(60)
  harness.commit.set(null)
  assert.equal(harness.clock.armed(), 1, 'the settle hold was not restarted')
  harness.clock.advance(10)
  assert.equal(harness.skips.length, 1, 'the original settle committed at 70 ms')
  assert.equal(harness.lock(), null)
  assert.equal(harness.clock.armed(), 0)
})

test('a target that returns to the published value cancels the candidate without publishing', () => {
  const harness = makeCommit()
  const publishedTarget = targetBefore('s1')
  harness.commit.set(publishedTarget)
  harness.clock.advance(TARGET_HOLD_MS)
  harness.commit.set(targetAfter('s2'))
  harness.clock.advance(20)
  // A → B → A: the candidate is back on the published value.
  harness.commit.set(targetBefore('s1'))
  assert.equal(harness.commit.pending(), false)
  assert.equal(harness.clock.armed(), 0)
  harness.clock.advance(200)
  assert.deepEqual(harness.published, [publishedTarget], 'the round trip publishes nothing')
})

test('a hold that changes X → Y → X ends on X exactly once', () => {
  const harness = makeCommit()
  const x = targetBefore('s1')
  const y = targetAfter('s2')
  harness.commit.set(x)
  harness.commit.set(y)
  harness.commit.set(x)
  harness.clock.advance(TARGET_HOLD_MS)
  assert.deepEqual(harness.published, [x], 'the newest candidate wins and only it publishes')
})

// --- v10 speed gate ---------------------------------------------------------
test('a fast sweep keeps the 70 ms hold and takes no immediate path', () => {
  perfReset()
  try {
    const harness = makeCommit()
    const first = targetBefore('s1')
    const second = targetAfter('s2')
    harness.commit.set(first, pointerAt(harness, 0))
    assert.equal(harness.commit.pending(), true, 'the first sample has no window, so it holds')
    drive(harness, 4, second, 3) // 3 px / 4 ms = 0.75 px/ms, above the 0.5 gate
    assert.ok(3 / 4 > SPEED_GATE_PX_PER_MS, 'the fixture really is a sweep')
    drive(harness, 4, second, 6) // still 0.75
    // The same native-step jitter the per-event B1 simulation exposed: a 1.2 px
    // step alone is 0.3 px/ms, but the 100 ms window keeps the net above the
    // gate (0.6 then 0.525). Only per-event speed would churn here.
    drive(harness, 4, second, 7.2)
    drive(harness, 4, second, 8.4)
    assert.deepEqual(harness.published, [], 'a sweeping target is not committed on entry or upgrade')
    assert.equal(harness.commit.pending(), true)
    assert.equal(harness.clock.armed(), 1, 'exactly one hold timer')
    assert.equal(perfSnapshot().counters['drag:targetImmediate'] ?? 0, 0, 'no immediate commit')
    assert.equal(perfSnapshot().counters['drag:targetPending'], 2, 'both candidates armed a hold')
    // The hold for `second` was armed at t=4, so it expires at t=74.
    harness.clock.advance(4 + TARGET_HOLD_MS - 1 - harness.clock.now())
    assert.deepEqual(harness.published, [], 'the swept target still waits for its hold')
    harness.clock.advance(1)
    assert.deepEqual(harness.published, [second], 'the hold expiry publishes the swept target')
    assert.equal(harness.clock.armed(), 0)
  } finally {
    perfReset()
  }
})

test('a slow aim commits the target immediately and disarms the hold', () => {
  perfReset()
  try {
    const harness = makeCommit()
    const first = targetBefore('s1')
    const second = targetAfter('s2')
    harness.commit.set(first, pointerAt(harness, 0))
    assert.equal(harness.commit.pending(), true)
    drive(harness, 16, second, 1) // 1 px / 16 ms = 0.0625 px/ms, below the gate
    assert.ok(1 / 16 < SPEED_GATE_PX_PER_MS, 'the fixture really is a slow aim')
    assert.deepEqual(harness.published, [second], 'the slow target publishes in the same event')
    assert.equal(harness.commit.pending(), false)
    assert.equal(harness.clock.armed(), 0, 'the immediate path left no timer behind')
    assert.equal(perfSnapshot().counters['drag:targetImmediate'], 1)
    assert.equal(perfSnapshot().counters['drag:targetPending'], 1, 'the immediate path does not count a hold')
    harness.clock.advance(300)
    assert.deepEqual(harness.published, [second], 'the disarmed first hold never fires')
  } finally {
    perfReset()
  }
})

test('a pause above PAUSE_MS restarts the window and commits immediately', () => {
  perfReset()
  try {
    const harness = makeCommit()
    const first = targetBefore('s1')
    const second = targetAfter('s2')
    harness.commit.set(first, pointerAt(harness, 0))
    harness.clock.advance(TARGET_HOLD_MS) // the hold publishes A; no timer is left
    assert.deepEqual(harness.published, [first])
    drive(harness, 10, first, 3)
    drive(harness, 4, first, 6) // samples accumulate while no hold is pending
    assert.equal(harness.commit.sampleCount(), 3)
    drive(harness, PAUSE_MS + 30, second, 6) // 130 ms gap: pause + fresh window
    assert.deepEqual(harness.published, [first, second], 'the paused pointer publishes immediately')
    assert.equal(harness.commit.sampleCount(), 1, 'the pause cleared the pre-pause samples')
    assert.equal(harness.clock.armed(), 0)
    assert.equal(perfSnapshot().counters['drag:targetImmediate'], 1)
    // The restarted window measures only the post-pause motion: a fast step holds.
    drive(harness, 4, targetAfter('s3'), 106)
    assert.equal(harness.commit.pending(), true, 'the fresh window measures the new motion')
    assert.deepEqual(harness.published, [first, second], 'the fast post-pause target stays held')
    harness.commit.cancel()
  } finally {
    perfReset()
  }
})

test('a pending hold upgrades to an immediate commit when the same target slows down', () => {
  perfReset()
  try {
    const harness = makeCommit()
    const first = targetBefore('s1')
    const second = targetAfter('s2')
    harness.commit.set(first, pointerAt(harness, 0))
    drive(harness, 4, second, 3) // 0.75 px/ms: the new target gets a hold
    assert.equal(harness.commit.pending(), true)
    assert.equal(harness.clock.armed(), 1)
    // Let the fast samples age out of the 40 ms upgrade window, then feed two
    // slow samples for the *same* candidate: only the upgrade path can publish.
    drive(harness, UPGRADE_WINDOW_MS + 10, second, 3.1)
    assert.deepEqual(harness.published, [], 'one sample in the 40 ms sub-window is not enough')
    assert.equal(harness.commit.pending(), true)
    drive(harness, 4, second, 3.2) // two samples in the sub-window, 0.1 px / 4 ms
    assert.deepEqual(harness.published, [second], 'the slowed hold publishes before its 70 ms')
    assert.equal(harness.commit.pending(), false)
    assert.equal(harness.clock.armed(), 0, 'the replaced hold timer is cleared')
    assert.equal(perfSnapshot().counters['drag:targetImmediate'], 1)
    assert.equal(perfSnapshot().counters['drag:targetPending'], 2)
    harness.clock.advance(300)
    assert.deepEqual(harness.published, [second], 'the old timer cannot commit twice')
  } finally {
    perfReset()
  }
})

test('without a pointer sample the commit keeps the fixed hold', () => {
  perfReset()
  try {
    const harness = makeCommit()
    const target = targetBefore('s1')
    harness.commit.set(target)
    assert.equal(harness.commit.pending(), true)
    harness.clock.advance(TARGET_HOLD_MS - 1)
    assert.deepEqual(harness.published, [])
    harness.clock.advance(1)
    assert.deepEqual(harness.published, [target])
    assert.equal(perfSnapshot().counters['drag:targetImmediate'] ?? 0, 0)
  } finally {
    perfReset()
  }
})

test('drag:targetImmediate counts only gated decisions and never overlaps targetPending', () => {
  perfReset()
  try {
    const harness = makeCommit()
    const a = targetBefore('s1')
    const b = targetAfter('s2')
    const c = { kind: 'group-head', groupId: 'g1' }
    harness.commit.set(a, pointerAt(harness, 0)) // no window yet -> hold
    drive(harness, 16, b, 1) // slow -> immediate
    assert.deepEqual(harness.published, [b])
    assert.equal(perfSnapshot().counters['drag:targetPending'], 1, 'only A armed a hold')
    assert.equal(perfSnapshot().counters['drag:targetImmediate'], 1, 'only B took the immediate path')
    drive(harness, 4, c, 41) // 40 px / 20 ms -> sweep -> hold
    assert.equal(harness.commit.pending(), true)
    assert.equal(perfSnapshot().counters['drag:targetPending'], 2)
    assert.equal(perfSnapshot().counters['drag:targetImmediate'], 1, 'the sweep did not count as immediate')
    drive(harness, UPGRADE_WINDOW_MS + 10, c, 41.1) // fast samples aged out: one sample
    drive(harness, 4, c, 41.2) // same candidate slows in the 40 ms sub-window
    assert.deepEqual(harness.published, [b, c])
    assert.equal(perfSnapshot().counters['drag:targetImmediate'], 2)
    assert.equal(perfSnapshot().counters['drag:targetPending'], 2, 'the upgrade is not a new hold')
    assert.equal(perfSnapshot().counters['drag:frame'], 2, 'one applied commit per path')
    assert.equal(harness.clock.armed(), 0)
  } finally {
    perfReset()
  }
})

test('the sample window is bounded and drops duplicate samples', () => {
  const harness = makeCommit()
  const target = targetBefore('s1')
  harness.commit.set(target, pointerAt(harness, 0))
  assert.equal(harness.commit.sampleCount(), 1)
  // The same native event reaching a second surface: Δt ≤ 2 ms is dropped.
  harness.commit.set(target, { x: 12, y: 40, t: SAMPLE_DEDUPE_MS - 1 })
  assert.equal(harness.commit.sampleCount(), 1, 'a duplicate sample is dropped')
  // 320 ms of a fast sweep (8 ms sampling steps) keeps only the latest ~120 ms.
  for (let step = 1; step <= 40; step += 1) {
    harness.clock.advance(8)
    harness.commit.set(target, pointerAt(harness, step * 10))
  }
  assert.ok(harness.commit.sampleCount() <= 17, 'old samples are pruned from the window')
  assert.ok(harness.commit.sampleCount() >= 2, 'the recent samples stay')
  harness.commit.cancel()
  assert.equal(harness.commit.sampleCount(), 0, 'cancel clears the window')
  assert.equal(harness.clock.armed(), 0)
})

test('an equivalent target after a commit starts no new hold', () => {
  const harness = makeCommit()
  const target = { kind: 'group-head', groupId: 'g1' }
  harness.commit.set(target)
  harness.clock.advance(TARGET_HOLD_MS)
  assert.deepEqual(harness.published, [target])
  assert.equal(harness.changes.length, 1)
  harness.commit.set({ kind: 'group-head', groupId: 'g1' })
  assert.equal(harness.commit.pending(), false)
  harness.clock.advance(200)
  assert.deepEqual(harness.published, [target], 'the stable equality kept React out')
  assert.equal(harness.changes.length, 1)
  assert.equal(harness.skips.length, 0, 'no commit ran for the equivalent target')
})

test('flush with nothing pending is a no-op', () => {
  const harness = makeCommit()
  assert.equal(harness.commit.flush(), false)
  assert.deepEqual(harness.published, [])
})

test('drag:targetPending counts hold starts and drag:frame counts applied commits', () => {
  perfReset()
  try {
    const harness = makeCommit()
    harness.commit.set(targetBefore('s1'))
    assert.equal(perfSnapshot().counters['drag:targetPending'], 1)
    assert.equal(perfSnapshot().counters['drag:frame'] ?? 0, 0, 'a pending candidate is not a commit')
    harness.commit.set(targetBefore('s1'))
    assert.equal(perfSnapshot().counters['drag:targetPending'], 1, 'the same target starts no new hold')
    harness.commit.set(targetAfter('s2'))
    assert.equal(perfSnapshot().counters['drag:targetPending'], 2)
    harness.clock.advance(TARGET_HOLD_MS)
    assert.equal(perfSnapshot().counters['drag:frame'], 1, 'the hold expiry is one applied commit')
    harness.commit.set(null)
    assert.equal(perfSnapshot().counters['drag:targetPending'], 2, 'a null settle is not a target candidate')
    harness.commit.flush()
    assert.equal(perfSnapshot().counters['drag:frame'], 2, 'the synchronous settle is one more commit')
  } finally {
    perfReset()
  }
})

test('the default clock, timers and sinks drive a commit without waiting', () => {
  // No injected clock/sinks: exercises the production defaults (`performance.now`,
  // `setTimeout`/`clearTimeout`, and the no-op lock/change/skip sinks). Every
  // timer is disarmed by a flush before it can fire, so the test never waits.
  let committed = null
  const published = []
  const commit = createDropTargetCommit({
    same: sameDropTarget,
    read: () => committed,
    publish: (next) => {
      committed = next
      published.push(next)
    },
  })
  const target = targetBefore('s1')
  commit.set(target)
  assert.equal(commit.pending(), true, 'the default timer armed the hold')
  assert.equal(commit.flush(), true, 'the default clock/timer/sinks commit on flush')
  assert.equal(commit.pending(), false)
  commit.set(null)
  commit.flush()
  commit.set(null)
  commit.flush()
  assert.deepEqual(published, [target, null], 'the default lock/skip sinks stay idempotent')
  commit.cancel()
})

test('the label cache serves the drag-time snapshot of names', () => {
  const cache = createDragLabelCache()
  const doc = {
    groups: [
      { id: 'g1', name: 'Alpha' },
      { id: 'g2', name: 'Beta' },
    ],
    ungrouped: [],
  }
  cache.build(doc)
  assert.equal(cache.size(), 2)
  assert.equal(cache.nameOf(doc, 'g1'), 'Alpha')
  assert.equal(cache.nameOf(doc, 'g2'), 'Beta')
  // An in-place rename (same document identity) must not change mid-drag labels.
  doc.groups[0].name = 'Renamed in place'
  assert.equal(cache.nameOf(doc, 'g1'), 'Alpha')
})

test('a changed document identity rebuilds the cache (N3)', () => {
  const cache = createDragLabelCache()
  const doc = { groups: [{ id: 'g1', name: 'Alpha' }], ungrouped: [] }
  cache.build(doc)
  assert.equal(cache.nameOf(doc, 'g1'), 'Alpha')
  // A host/optimistic update replaces the document object.
  const nextDoc = { groups: [{ id: 'g1', name: 'Beta' }], ungrouped: [] }
  assert.equal(cache.nameOf(nextDoc, 'g1'), 'Beta')
  assert.equal(cache.size(), 1)
})

test('a cache miss falls back to the live lookup (freshness backstop)', () => {
  const cache = createDragLabelCache()
  const doc = { groups: [{ id: 'g1', name: 'Alpha' }], ungrouped: [] }
  cache.build(doc)
  // A group that appeared in the same document object after the build.
  doc.groups.push({ id: 'g2', name: 'Gamma' })
  assert.equal(cache.nameOf(doc, 'g2'), 'Gamma')
  assert.equal(cache.size(), 1, 'the fallback does not rewrite the snapshot')
  assert.equal(cache.nameOf(doc, 'missing'), '')
})

test('clear forgets the snapshot so the next drag reads the live doc', () => {
  const cache = createDragLabelCache()
  const doc = { groups: [{ id: 'g1', name: 'Alpha' }], ungrouped: [] }
  cache.build(doc)
  doc.groups[0].name = 'Renamed'
  assert.equal(cache.nameOf(doc, 'g1'), 'Alpha')
  cache.clear()
  assert.equal(cache.size(), 0)
  assert.equal(cache.nameOf(doc, 'g1'), 'Renamed', 'after the drag the live name is used')
})

// --- wiring locks -----------------------------------------------------------
const components = readFileSync(new URL('../../src/client/components.js', import.meta.url), 'utf8')

/** Body of one handler entry (`    name: (...) => {` up to the handler close). */
const handlerBody = (name) => {
  const start = components.indexOf(`    ${name}: (`)
  if (start === -1) return ''
  const end = components.indexOf('\n    },', start)
  return components.slice(start, end === -1 ? undefined : end)
}

const ON_DROP_HANDLERS = [
  'onDropSession',
  'onDropGroup',
  'onDropGroupHead',
  'onDropGroupSlot',
  'onDropUngrouped',
  'onDropUngroupedBody',
]

test('components wiring: the published target is held by the drop-frame timer', () => {
  assert.match(components, /import \{ createDragLabelCache, createDropTargetCommit \} from '\.\/drag-frame\.js'/)
  assert.doesNotMatch(components, /import \{ createFrameBatch \} from '\.\/frame-batch\.js'/)
  assert.match(components, /createDropTargetCommit\(\{\s+same: sameDropTarget,/)
  assert.match(components, /count: \(\) => perfCount\('drag:frame'\)/)
})

test('components wiring: every drop handler flushes before it reads the drag state', () => {
  for (const name of ON_DROP_HANDLERS) {
    const body = handlerBody(name)
    assert.ok(body.length > 0, `${name} exists`)
    const flushAt = body.indexOf('flushDropTarget()')
    assert.ok(flushAt > -1, `${name} flushes the pending target`)
    const dragAt = body.indexOf('const drag = dragRef.current')
    assert.ok(dragAt > -1, `${name} reads the drag source`)
    assert.ok(flushAt < dragAt, `${name} flushes before reading the drag source`)
  }
  // The ungrouped body handler is the one that reads the published target.
  const ungroupedBody = handlerBody('onDropUngroupedBody')
  assert.ok(
    ungroupedBody.indexOf('flushDropTarget()') < ungroupedBody.indexOf('dropTargetRef.current'),
    'onDropUngroupedBody flushes before reading dropTargetRef.current'
  )
})

test('components wiring: drag end and leave settle the target synchronously', () => {
  const dragEnd = handlerBody('onDragEnd')
  assert.match(dragEnd, /settleDropTarget\(\)/)
  assert.match(dragEnd, /labelCacheRef\.current\.clear\(\)/)
  const dragLeave = handlerBody('onDragLeave')
  assert.match(dragLeave, /settleDropTarget\(\)/)
  // Settle = null candidate + flush in the same tick.
  assert.match(components, /const settleDropTarget = \(\) => \{\s+setDropTargetTracked\(null\)\s+flushDropTarget\(\)\s+\}/)
})

test('components wiring: the four non-null set points carry the dragover pointer sample', () => {
  // Dispatch boundary: one sample per native dragover event, before any surface
  // logic runs (the wrapper is unconditional, not behind perf/diag).
  assert.match(components, /const dragPointerRef = useRef\(null\)/)
  assert.match(components, /if \(!name\.startsWith\('onDragOver'\)\) continue/)
  assert.match(components, /handlers\[name\] = \(event, \.\.\.args\) => \{\s+sampleDragPointer\(event\)/)
  assert.match(components, /const dragPointer = \(\) => dragPointerRef\.current\?\.pointer \?\? null/)
  // The four non-null set points hand the sample to the gate.
  assert.match(components, /setDropTargetTracked\(target, dragPointer\(\)\)/)
  assert.match(components, /setDropTargetTracked\(\{ \.\.\.viewTarget, kind: 'group-forbidden' \}, dragPointer\(\)\)/)
  assert.match(components, /setDropTargetTracked\(forbiddenTarget, forbiddenTarget === null \? null : dragPointer\(\)\)/)
  assert.match(components, /setDropTargetTracked\(\{ kind: 'group-forbidden', targetId: groupId \}, dragPointer\(\)\)/)
  // The per-surface samples are deduped by native-event timestamp.
  assert.match(components, /previous\.stamp === stamp/)
  assert.match(components, /immediateCount: \(\) => perfCount\('drag:targetImmediate'\)/)
  // Every null settle keeps the plain path (settleDropTarget + three dragover
  // null candidates); passing a pointer to a null settle would gate it.
  assert.equal((components.match(/setDropTargetTracked\(null\)/g) ?? []).length, 4, 'null settles never carry a pointer')
})

test('components wiring: the label cache is built at drag start and cleared afterwards', () => {
  assert.match(components, /if \(labelCacheRef\.current === null\) labelCacheRef\.current = createDragLabelCache\(\)/)
  const dragStart = handlerBody('onDragStart')
  const groupDragStart = handlerBody('onGroupDragStart')
  assert.match(dragStart, /labelCacheRef\.current\.build\(store\.doc\)/)
  assert.match(groupDragStart, /labelCacheRef\.current\.build\(store\.doc\)/)
  assert.match(components, /const groupName = \(groupId\) => labelCacheRef\.current\.nameOf\(store\.doc, groupId\)/)
  assert.doesNotMatch(components, /findGroup\(store\.doc, groupId\)\?\.name/)
  assert.doesNotMatch(components, /findGroup\(store\.doc, parentId\)\?\.name/)
  // The three clear points: session drop, group drop, dragend.
  assert.equal((components.match(/labelCacheRef\.current\.clear\(\)/g) ?? []).length, 3)
})
