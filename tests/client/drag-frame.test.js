/**
 * Drag target frame coalescing + name cache (0.4.0-beta.66 v8, spec §14.2.3).
 *
 * `dragover` fires continuously; the seam keeps only the newest target of a
 * frame, commits it once, and still dedupes against the published target so a
 * stationary pointer causes no React update. Drop handlers flush first, so a
 * drop that follows a dragover in the same tick sees the fresh target. The
 * label cache replaces the per-event `findGroup` scan and is rebuilt when the
 * document identity changes (N3).
 *
 * `components.js` is a React component module (`check:ui` territory, not
 * importable by `npm test` without collapsing the coverage gate), so its wiring
 * is pinned with source locks at the end.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { sameDropTarget } from '../../src/core/drag.js'
import { createDragLabelCache, createDropTargetCommit } from '../../src/client/drag-frame.js'
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

const targetBefore = (sessionId) => ({ kind: 'session-before', groupId: 'g1', sessionId })
const targetAfter = (sessionId) => ({ kind: 'session-after', groupId: 'g1', sessionId })

/**
 * The production wiring in miniature: `publish` is the only place that writes
 * the React mirror (`read()`), `clearLock` releases the resting-pointer lock.
 */
const makeCommit = () => {
  const frames = makeFrames()
  const batch = createFrameBatch(frames)
  let committed = null
  let lock = null
  const published = []
  const changes = []
  const skips = []
  const commit = createDropTargetCommit({
    batch,
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
  })
  return {
    frames,
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

test('every dragover of a frame commits once, with the last target', () => {
  const harness = makeCommit()
  const first = targetBefore('s1')
  const second = targetBefore('s2')
  const last = targetAfter('s3')
  harness.commit.set(first)
  harness.commit.set(second)
  harness.commit.set(last)
  assert.equal(harness.published.length, 0, 'nothing commits before the frame')
  assert.equal(harness.frames.armed(), 1, 'three dragovers share one frame')
  assert.equal(harness.commit.pending(), true)
  harness.frames.run()
  assert.equal(harness.published.length, 1)
  assert.equal(harness.published[0], last, 'the newest target wins')
  assert.equal(harness.read(), last)
  assert.equal(harness.commit.pending(), false)
})

test('the newest target wins, not the first one of the frame', () => {
  const harness = makeCommit()
  const first = targetBefore('s1')
  const last = targetAfter('s2')
  harness.commit.set(first)
  harness.commit.set(last)
  harness.frames.run()
  assert.equal(harness.published[0], last, 'first-wins would publish the stale target')
})

test('a same-frame X → Y → X ends on X exactly once (last-wins + dedupe)', () => {
  const harness = makeCommit()
  const x = targetBefore('s1')
  const y = targetAfter('s2')
  harness.commit.set(x)
  harness.commit.set(y)
  harness.commit.set(x)
  harness.frames.run()
  assert.equal(harness.published.length, 1)
  assert.equal(harness.published[0], x)
})

test('an equivalent target in a later frame publishes nothing', () => {
  const harness = makeCommit()
  const target = { kind: 'group-head', groupId: 'g1' }
  harness.commit.set(target)
  harness.frames.run()
  assert.equal(harness.published.length, 1)
  assert.equal(harness.changes.length, 1)
  harness.commit.set({ kind: 'group-head', groupId: 'g1' })
  harness.frames.run()
  assert.equal(harness.published.length, 1, 'the stable equality kept React out')
  assert.equal(harness.skips.length, 1)
  assert.equal(harness.changes.length, 1)
})

test('flush commits the queued target before a drop reads the mirror', () => {
  const harness = makeCommit()
  const oldTarget = targetBefore('s1')
  const newTarget = targetAfter('s2')
  harness.commit.set(oldTarget)
  harness.frames.run()
  assert.equal(harness.read(), oldTarget)
  harness.commit.set(newTarget)
  assert.equal(harness.read(), oldTarget, 'the mirror still shows the previous frame')
  const flushed = harness.commit.flush()
  assert.equal(flushed, true)
  assert.equal(harness.read(), newTarget, 'a drop reads the freshly committed target')
  assert.deepEqual(harness.published, [oldTarget, newTarget])
  assert.equal(harness.frames.armed(), 0)
  harness.frames.run()
  assert.deepEqual(harness.published, [oldTarget, newTarget], 'the cancelled frame never re-commits')
})

test('flush with nothing queued is a no-op', () => {
  const harness = makeCommit()
  assert.equal(harness.commit.flush(), false)
  assert.deepEqual(harness.published, [])
})

test('a null settle releases the resting-pointer lock at commit time', () => {
  const harness = makeCommit()
  harness.setLock({ x: 4, y: 4, target: targetBefore('s1') })
  harness.commit.set(null)
  assert.notEqual(harness.lock(), null, 'the queued null has not settled yet')
  harness.commit.flush()
  assert.equal(harness.lock(), null)
  assert.equal(harness.read(), null)
})

test('an already-null target still clears the lock without re-publishing', () => {
  const harness = makeCommit()
  harness.commit.set(null)
  harness.commit.flush()
  assert.equal(harness.published.length, 0, 'a null settle onto null publishes nothing')
  assert.equal(harness.skips.length, 1)
  harness.setLock({ x: 9, y: 9, target: targetBefore('s2') })
  harness.commit.set(null)
  harness.commit.flush()
  assert.equal(harness.lock(), null, 'dragend/dragleave stay idempotent')
  assert.equal(harness.published.length, 0)
  assert.equal(harness.skips.length, 2)
})

test('cancel drops the queued target without committing it', () => {
  const harness = makeCommit()
  harness.commit.set(targetBefore('s1'))
  harness.commit.cancel()
  assert.equal(harness.commit.pending(), false)
  harness.frames.run()
  assert.deepEqual(harness.published, [])
  assert.equal(harness.read(), null)
})

test('each applied frame increments the drag:frame counter', () => {
  perfReset()
  try {
    const harness = makeCommit()
    harness.commit.set(targetBefore('s1'))
    assert.equal(perfSnapshot().counters['drag:frame'] ?? 0, 0, 'dragovers alone are not frames')
    harness.frames.run()
    assert.equal(perfSnapshot().counters['drag:frame'], 1)
    harness.commit.set(null)
    harness.commit.flush()
    assert.equal(perfSnapshot().counters['drag:frame'], 2, 'the synchronous settle is one more frame')
  } finally {
    perfReset()
  }
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

test('components wiring: the published target is frame-coalesced', () => {
  assert.match(components, /import \{ createDragLabelCache, createDropTargetCommit \} from '\.\/drag-frame\.js'/)
  assert.match(components, /import \{ createFrameBatch \} from '\.\/frame-batch\.js'/)
  assert.match(components, /createDropTargetCommit\(\{\s+batch: createFrameBatch\(\),/)
  assert.match(components, /count: \(\) => perfCount\('drag:frame'\)/)
})

test('components wiring: every drop handler flushes before it reads the drag state', () => {
  for (const name of ON_DROP_HANDLERS) {
    const body = handlerBody(name)
    assert.ok(body.length > 0, `${name} exists`)
    const flushAt = body.indexOf('flushDropTarget()')
    assert.ok(flushAt > -1, `${name} flushes the queued dragover target`)
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
  // Settle = queue null + flush in the same tick.
  assert.match(components, /const settleDropTarget = \(\) => \{\s+setDropTargetTracked\(null\)\s+flushDropTarget\(\)\s+\}/)
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
