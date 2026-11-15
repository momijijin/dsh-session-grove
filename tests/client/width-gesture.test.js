import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'

import {
  beginWidthGesture,
  endWidthGesture,
  isWidthGestureActive,
  onWidthGestureEnd,
} from '../../src/client/width-gesture.js'
import { perfReset } from '../../src/client/perf.js'
import { clearManagedWidth, SIDEBAR_WIDTH_KEY } from '../../src/client/sidebar-width.js'
import { installMutationObserver, makeLayoutDom } from '../support/fake-layout-dom.mjs'

// Map the host React peer to the test stub so the resize-handle component can be
// imported (the same loader the UI runtime spec uses; test-only, never in lib/).
register(new URL('../support/react-loader.mjs', import.meta.url))

const PERF_STORAGE_KEY = 'dsh-session-grove.perf'

/**
 * Run `body` with the window-level pointer/rAF surface the resize-handle tests
 * need: a listener registry, a manual rAF queue, a fixed viewport and a
 * localStorage stub that keeps perf capture off (so `perfBeginGesture` never
 * tries a real `fetch`). Everything is restored afterwards.
 */
const withHandleGlobals = async (body) => {
  const listeners = new Map()
  const frames = new Map()
  const storageWrites = []
  let nextFrameId = 0
  const previous = {
    addEventListener: Object.getOwnPropertyDescriptor(globalThis, 'addEventListener'),
    removeEventListener: Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener'),
    innerWidth: Object.getOwnPropertyDescriptor(globalThis, 'innerWidth'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    requestAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame'),
    cancelAnimationFrame: Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame'),
  }
  const restore = (name) => {
    const descriptor = previous[name]
    if (descriptor === undefined) delete globalThis[name]
    else Object.defineProperty(globalThis, name, descriptor)
  }
  globalThis.addEventListener = (type, listener) => {
    const list = listeners.get(type) ?? []
    list.push(listener)
    listeners.set(type, list)
  }
  globalThis.removeEventListener = (type, listener) => {
    const list = listeners.get(type) ?? []
    const index = list.indexOf(listener)
    if (index !== -1) list.splice(index, 1)
  }
  globalThis.requestAnimationFrame = (callback) => {
    nextFrameId += 1
    frames.set(nextFrameId, callback)
    return nextFrameId
  }
  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id)
  }
  globalThis.innerWidth = 1440
  globalThis.localStorage = {
    getItem: (key) => (key === PERF_STORAGE_KEY ? '0' : null),
    setItem: (key, value) => storageWrites.push({ key, value }),
  }
  perfReset()
  const dispatch = (type, event) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
  }
  const flushFrames = () => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback()
  }
  try {
    // Both modules import the React peer, so the loader above must be active
    // before they are loaded (dynamic import, never a hoisted static import).
    const [{ ResizeHandle }, { useGroupsSidebarWidth }] = await Promise.all([
      import('../../src/client/components-resize-handle.js'),
      import('../../src/client/groups-view-width.js'),
    ])
    return await body({
      ResizeHandle,
      useGroupsSidebarWidth,
      listeners,
      frames,
      dispatch,
      flushFrames,
      storageWrites,
    })
  } finally {
    for (const name of Object.keys(previous)) restore(name)
    perfReset()
  }
}

/** Fake handle element: enough for transform, pointer capture and ARIA writes. */
const makeHandleElement = () => ({
  style: {},
  attributes: new Map(),
  setAttribute(name, value) { this.attributes.set(name, String(value)) },
  setPointerCapture() {},
  releasePointerCapture() {},
  hasPointerCapture: () => false,
})

const pointerDown = (element, { pointerId = 7, clientX = 600 } = {}) => ({
  button: 0,
  pointerId,
  clientX,
  currentTarget: element,
  preventDefault() {},
})

test('begin/end are idempotent and each end notifies once', () => {
  const calls = []
  const unsubscribe = onWidthGestureEnd(() => calls.push('a'))
  assert.equal(isWidthGestureActive(), false)
  beginWidthGesture()
  beginWidthGesture()
  assert.equal(isWidthGestureActive(), true)
  assert.deepEqual(calls, [], 'begin never notifies')
  endWidthGesture()
  assert.equal(isWidthGestureActive(), false)
  assert.deepEqual(calls, ['a'])
  endWidthGesture()
  assert.deepEqual(calls, ['a'], 'ending an idle gesture is a no-op')
  unsubscribe()
})

test('listeners persist across gestures and the returned function unsubscribes', () => {
  const calls = []
  const unsubscribeFirst = onWidthGestureEnd(() => calls.push('first'))
  const unsubscribeSecond = onWidthGestureEnd(() => calls.push('second'))
  beginWidthGesture()
  endWidthGesture()
  assert.deepEqual(calls, ['first', 'second'])
  beginWidthGesture()
  endWidthGesture()
  assert.deepEqual(calls, ['first', 'second', 'first', 'second'], 'a second drag re-runs the subscribers')
  unsubscribeSecond()
  beginWidthGesture()
  endWidthGesture()
  assert.deepEqual(calls, ['first', 'second', 'first', 'second', 'first'])
  unsubscribeFirst()
  beginWidthGesture()
  endWidthGesture()
  assert.equal(calls.length, 5)
})

test('a throwing listener cannot starve the remaining listeners', () => {
  const calls = []
  const unsubscribeBad = onWidthGestureEnd(() => { throw new Error('boom') })
  const unsubscribeGood = onWidthGestureEnd(() => calls.push('good'))
  beginWidthGesture()
  assert.doesNotThrow(() => endWidthGesture())
  assert.equal(isWidthGestureActive(), false)
  assert.deepEqual(calls, ['good'])
  unsubscribeBad()
  unsubscribeGood()
})

test('the resize handle previews through transform, writes ARIA per frame, commits once before ending the gesture, and cancels cleanly', async () => {
  await withHandleGlobals(async ({ ResizeHandle, dispatch, flushFrames, listeners }) => {
    endWidthGesture()
    const previews = []
    const commits = []
    const cancels = []
    const tree = ResizeHandle({
      width: 420,
      min: 264,
      max: 1152,
      onPreview: (next) => previews.push({ width: next, active: isWidthGestureActive() }),
      onCommit: (next) => commits.push({ width: next, active: isWidthGestureActive() }),
      onCancel: () => cancels.push({ active: isWidthGestureActive() }),
      onReset: () => {},
    })
    const element = makeHandleElement()
    const down = pointerDown(element)

    tree.props.onPointerDown(down)
    assert.equal(isWidthGestureActive(), true)
    assert.deepEqual(previews, [])
    assert.equal(element.style.transform, '', 'a new drag starts from an untranslated base')

    // The pointermove only records the latest width; the transform, the ARIA
    // value and the preview are applied once per frame.
    dispatch('pointermove', { pointerId: 7, clientX: 620 })
    assert.equal(element.style.transform, '', 'pointermove defers the transform to rAF')
    assert.deepEqual(previews, [], 'pointermove defers the preview to rAF')
    flushFrames()
    assert.deepEqual(previews, [{ width: 440, active: true }])
    assert.equal(element.style.transform, 'translate3d(20px,0,0)')
    assert.equal(element.attributes.get('aria-valuenow'), '440', 'the drag frame writes the ARIA value without React')

    // Pointerup: the final width is committed first; only then does the gesture
    // end, so the deferred ungrouped measure sees the new width instead of the
    // previous one. The transform is cleared before the next paint.
    dispatch('pointerup', { pointerId: 7 })
    assert.deepEqual(commits, [{ width: 440, active: true }])
    assert.equal(isWidthGestureActive(), false)
    assert.equal(element.style.transform, '')
    assert.equal(element.attributes.get('aria-valuenow'), '440', 'a commit leaves the ARIA value on the committed width')
    assert.equal((listeners.get('pointerup') ?? []).length, 0, 'the drag listeners are released')

    // Pointercancel is the second end path: it never commits, but it must roll
    // the previewed CSS variable back to the committed width (the hook's
    // `cancelWidth`), clear the transform, restore the ARIA value and still close
    // the gesture or the ungrouped measure stays gated forever.
    tree.props.onPointerDown(down)
    assert.equal(isWidthGestureActive(), true)
    dispatch('pointermove', { pointerId: 7, clientX: 610 })
    flushFrames()
    assert.equal(element.style.transform, 'translate3d(10px,0,0)')
    assert.equal(element.attributes.get('aria-valuenow'), '430')
    assert.equal(previews.length, 2)
    dispatch('pointercancel', { pointerId: 7 })
    assert.deepEqual(cancels, [{ active: true }], 'cancel runs before the gesture closes')
    assert.equal(isWidthGestureActive(), false)
    assert.equal(element.style.transform, '', 'cancel clears the transform without committing')
    assert.equal(element.attributes.get('aria-valuenow'), '420', 'cancel restores the committed ARIA value')
    assert.equal(previews.length, 2, 'cancel never applies a width after the handle stopped')
    assert.deepEqual(commits, [{ width: 440, active: true }])
  })
})

test('a second drag measures its transform from the committed width prop, not the first drag base', async () => {
  await withHandleGlobals(async ({ ResizeHandle, dispatch, flushFrames }) => {
    endWidthGesture()
    const first = ResizeHandle({ width: 420, min: 264, max: 1152, onPreview: () => {}, onCommit: () => {} })
    const firstElement = makeHandleElement()
    first.props.onPointerDown(pointerDown(firstElement))
    dispatch('pointermove', { pointerId: 7, clientX: 620 })
    flushFrames()
    assert.equal(firstElement.style.transform, 'translate3d(20px,0,0)')
    dispatch('pointerup', { pointerId: 7 })
    assert.equal(isWidthGestureActive(), false)

    // The first drag committed 440. A second handle rendered with that committed
    // width must measure the drag offset from 440; a stale/hard-coded base (420)
    // would double the offset and put the line 20px ahead of the pointer.
    const second = ResizeHandle({ width: 440, min: 264, max: 1152, onPreview: () => {}, onCommit: () => {} })
    const secondElement = makeHandleElement()
    second.props.onPointerDown(pointerDown(secondElement))
    dispatch('pointermove', { pointerId: 7, clientX: 620 })
    flushFrames()
    assert.equal(secondElement.style.transform, 'translate3d(20px,0,0)', 'the base is the committed width at drag start')
    dispatch('pointerup', { pointerId: 7 })
  })
})

test('a drag released before the first preview still commits the committed width', async () => {
  await withHandleGlobals(async ({ ResizeHandle, dispatch }) => {
    endWidthGesture()
    const commits = []
    const tree = ResizeHandle({ width: 470, min: 264, max: 1152, onPreview: () => {}, onCommit: (next) => commits.push(next) })
    const element = makeHandleElement()
    tree.props.onPointerDown(pointerDown(element))
    dispatch('pointerup', { pointerId: 7 })
    assert.deepEqual(commits, [470], 'a press/release without a pointermove commits the drag-start width')
    assert.equal(isWidthGestureActive(), false)
    assert.equal(element.style.transform, '')
  })
})

test('pointercancel and unmount roll the previewed CSS variable back to the committed width', async () => {
  await withHandleGlobals(async ({ ResizeHandle, useGroupsSidebarWidth, dispatch, flushFrames, storageWrites }) => {
    endWidthGesture()
    const dom = makeLayoutDom()
    const mutationObserver = installMutationObserver()
    const effectRuntime = []
    globalThis.__DSG_REACT_TEST_EFFECTS__ = effectRuntime
    let hookCleanups = []
    let handleCleanups = []
    try {
      const hook = useGroupsSidebarWidth({ wide: true, docState: 'ready', rootRef: { current: dom.root } })
      hookCleanups = effectRuntime.splice(0)
      assert.equal(dom.frame.style.getPropertyValue('--dsg-sidebar-col'), '420px', 'the hook sync installs the committed width')
      assert.equal(hook.getLiveWidth(), 420)

      const tree = ResizeHandle({
        width: hook.appliedWidth,
        min: 264,
        max: hook.maxAppliedWidth,
        onPreview: hook.previewWidth,
        onCommit: hook.commitWidth,
        onCancel: hook.cancelWidth,
      })
      handleCleanups = effectRuntime.splice(0)
      const element = makeHandleElement()

      // Drag preview writes the CSS variable, then pointercancel must write the
      // committed width back through the same controller (the reported bug: the
      // variable stayed on the preview while `preferredWidth` stayed committed).
      tree.props.onPointerDown(pointerDown(element, { pointerId: 11 }))
      dispatch('pointermove', { pointerId: 11, clientX: 700 })
      flushFrames()
      assert.equal(dom.frame.style.getPropertyValue('--dsg-sidebar-col'), '520px', 'the preview writes the dragged width')
      assert.equal(hook.getLiveWidth(), 520)
      dispatch('pointercancel', { pointerId: 11 })
      assert.equal(
        dom.frame.style.getPropertyValue('--dsg-sidebar-col'),
        '420px',
        'cancel writes the committed width back to the controller'
      )
      assert.equal(hook.getLiveWidth(), 420, 'the live width equals the committed/applied width again')
      assert.equal(element.style.transform, '')
      assert.deepEqual(storageWrites.filter(({ key }) => key === SIDEBAR_WIDTH_KEY), [], 'cancel never persists')

      // The same rollback runs when the handle unmounts mid-drag. Drain the
      // pending write-frame measure and let the adaptive interval elapse so the
      // next preview is not throttled.
      flushFrames()
      await new Promise((resolve) => setTimeout(resolve, 45))
      tree.props.onPointerDown(pointerDown(element, { pointerId: 11 }))
      dispatch('pointermove', { pointerId: 11, clientX: 740 })
      flushFrames()
      assert.equal(dom.frame.style.getPropertyValue('--dsg-sidebar-col'), '560px')
      assert.equal(hook.getLiveWidth(), 560)
      // The unmount effect is registered after the transform layout effect, so
      // it is the last cleanup the component pushed.
      handleCleanups.at(-1)()
      assert.equal(
        dom.frame.style.getPropertyValue('--dsg-sidebar-col'),
        '420px',
        'an unmount mid-drag rolls the variable back too'
      )
      assert.equal(hook.getLiveWidth(), 420)
      assert.equal(element.style.transform, '')
      assert.deepEqual(storageWrites.filter(({ key }) => key === SIDEBAR_WIDTH_KEY), [], 'unmount never persists')
    } finally {
      delete globalThis.__DSG_REACT_TEST_EFFECTS__
      for (const cleanup of handleCleanups) cleanup?.()
      for (const cleanup of hookCleanups) cleanup?.()
      clearManagedWidth()
      mutationObserver.restore()
    }
  })
})

test('the resize-handle unmount cleanup also rolls back the preview and closes the width gesture', () => {
  const source = readFileSync(new URL('../../src/client/components-resize-handle.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ beginWidthGesture, endWidthGesture \} from '\.\/width-gesture\.js'/)
  // Both end paths funnel into `endDrag`: the cancel path rolls the preview back
  // before the gesture closes, and the final width is committed before the
  // gesture ends (measuring after `endWidthGesture` must see the new width).
  assert.match(source, /onCancel = \(cancelEvent\) => \{[\s\S]*?endDrag\(false\)/)
  const endDragAt = source.indexOf('const endDrag = useCallback')
  const endDragBody = source.slice(endDragAt, source.indexOf('// Unmount mid-drag', endDragAt))
  const applyAt = endDragBody.indexOf('commitRef.current?.(clamped)')
  const endAt = endDragBody.indexOf('endWidthGesture()')
  assert.ok(applyAt !== -1 && endAt > applyAt, 'the final width must be committed before the gesture ends')
  assert.match(endDragBody, /clearHandleTransform\(drag\.element\)/)
  assert.match(endDragBody, /setHandleAriaValue\(drag\.element, finalWidth \?\? drag\.startWidth\)/)
  assert.match(source, /setHandleAriaValue\(active\.element, active\.width\)/)
  // The cancel call must sit before the gesture closes, on the cancel branch.
  const cancelAt = endDragBody.indexOf('cancelRef.current?.()')
  assert.ok(cancelAt !== -1 && cancelAt < endAt, 'the preview rollback runs before `endWidthGesture`')
  // P3: the gesture record must close after the final commit, not before it.
  const perfAt = endDragBody.indexOf("perfEndGesture('width-resize')")
  assert.ok(perfAt > applyAt && perfAt < endAt, 'perfEndGesture runs after the commit and before endWidthGesture')
  // Unmount mid-drag rolls back and closes the gesture it opened, too.
  const cleanupAt = source.indexOf('if (drag) {')
  assert.ok(cleanupAt !== -1)
  const cleanupBody = source.slice(cleanupAt, cleanupAt + 600)
  assert.match(cleanupBody, /cancelRef\.current\?\.\(\)[\s\S]*?perfEndGesture\('width-resize'\)[\s\S]*?endWidthGesture\(\)/)
})

test('the resize handle exposes preview, commit and cancel and clears transform on a width commit', () => {
  const source = readFileSync(new URL('../../src/client/components-resize-handle.js', import.meta.url), 'utf8')
  assert.match(source, /const previewRef = useRef\(onPreview \?\? onChange\)/)
  assert.match(source, /const cancelRef = useRef\(onCancel\)/)
  assert.match(source, /cancelRef\.current = onCancel/)
  assert.match(source, /perfSample\('width:pointerLagMs', now - active\.lastPointerAt\)/)
  assert.match(source, /translate3d\(\$\{[^}]+\}px,0,0\)/)
  const layoutAt = source.indexOf('useLayoutEffect(')
  assert.ok(layoutAt !== -1, 'the committed width must clear the transform in a layout effect')
  const layoutBody = source.slice(layoutAt, source.indexOf('const onPointerDown', layoutAt))
  assert.match(layoutBody, /\[width\]/)
  assert.match(layoutBody, /clearHandleTransform\(element\)/)
  assert.match(layoutBody, /return \(\) => clearHandleTransform\(element\)/)
})

test('the ungrouped section defers layout measure during a width gesture and unsubscribes', () => {
  const source = readFileSync(new URL('../../src/client/components-ungrouped.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ isWidthGestureActive, onWidthGestureEnd \} from '\.\/width-gesture\.js'/)
  // The ResizeObserver / window-resize path only marks the layout dirty while
  // the sidebar is dragged; it must not schedule a layout read.
  assert.match(source, /if \(isWidthGestureActive\(\)\) \{\s*layoutDirty = true\s*return\s*\}/)
  // One rAF after the drag ends measures the settled layout.
  assert.match(source, /const unsubscribeWidthGesture = onWidthGestureEnd\(flushWidthGestureLayout\)/)
  const flushAt = source.indexOf('const flushWidthGestureLayout')
  assert.ok(flushAt !== -1)
  const flushBody = source.slice(flushAt, source.indexOf('const unsubscribeWidthGesture', flushAt))
  assert.match(flushBody, /requestAnimationFrame\(measureLayout\)/)
  // The mount-time measure is direct, never gesture-gated (spec §11.6).
  assert.match(source, /^\s{4}measureLayout\(\)\r?$/m)
  // The effect must unsubscribe on unmount; a leaked listener would fire into a
  // disposed closure after every later drag.
  const cleanupAt = source.indexOf('return () => {', source.indexOf('const unsubscribeWidthGesture'))
  assert.ok(cleanupAt !== -1)
  assert.match(source.slice(cleanupAt, cleanupAt + 600), /unsubscribeWidthGesture\(\)/)
})
