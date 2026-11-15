/**
 * React components for the groups sidebar (plain `createElement`, no JSX).
 *
 * Components are registered into DSH slots and receive the framework standard
 * toolkit as props (`useSessions`, `useWorkspaces`, `useSessionStatus`,
 * `usePanelInfo`, `…`) plus the slot owner share. Everything host-derived is read
 * from those hooks; the only local state is this plugin's view store.
 */
import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clientRuntime as rt } from '../adapters/client-runtime.js'
import { clampSidebarWidth, maxSidebarWidth } from './sidebar-width.js'
import { beginWidthGesture, endWidthGesture } from './width-gesture.js'
import { perfBeginGesture, perfEndGesture, perfNow, perfSample } from './perf.js'


const h = createElement

/** Clear the drag-only translate so the committed `left` is authoritative. */
const clearHandleTransform = (element) => {
  if (element?.style) element.style.transform = ''
}

/**
 * Mirror a width into the handle's ARIA value without React. A preview never
 * schedules a render, so without this write `aria-valuenow` would stay on the
 * committed width for the whole drag.
 */
const setHandleAriaValue = (element, width) => {
  if (!element?.setAttribute || !Number.isFinite(width)) return
  element.setAttribute('aria-valuenow', String(Math.round(width)))
}

const ResizeHandle = ({ width, min, max, onPreview, onChange, onCommit, onCancel, onReset }) => {
  const t = rt()?.t ?? ((key) => key)
  const dragRef = useRef(null)
  const elementRef = useRef(null)
  const frameRef = useRef(null)
  const trackingRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const previewRef = useRef(onPreview ?? onChange)
  const commitRef = useRef(onCommit)
  const cancelRef = useRef(onCancel)
  previewRef.current = onPreview ?? onChange
  commitRef.current = onCommit
  cancelRef.current = onCancel

  /** Remove the window-level drag listeners installed by onPointerDown. */
  const stopTracking = () => {
    const stop = trackingRef.current
    trackingRef.current = null
    if (typeof stop === 'function') stop()
  }

  const endDrag = useCallback((commit) => {
    const drag = dragRef.current
    if (!drag) {
      stopTracking()
      return
    }
    let finalWidth = null
    try {
      dragRef.current = null
      stopTracking()
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      try {
        if (drag.element.hasPointerCapture?.(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId)
      } catch {
        /* synthetic pointer */
      }
      setDragging(false)
      if (commit) {
        const clamped = clampSidebarWidth(drag.width, globalThis.innerWidth)
        if (clamped !== null) {
          // The last pointermove only scheduled a rAF that the cancel above may
          // have discarded. Commit the final width unconditionally before the
          // gesture ends, so a skipped preview cannot store a width the sidebar
          // never took (spec §13.2.4 B2).
          commitRef.current?.(clamped)
          finalWidth = clamped
        }
      } else {
        // Cancel path (pointercancel or a re-entrant pointerdown) never commits:
        // the previewed variable must go back to the committed width before the
        // gesture closes, or the host keeps a width the preference never took
        // and the next `sync` re-applies it.
        cancelRef.current?.()
      }
    } finally {
      // Both end paths funnel here. Drop the drag-only translate; a committed
      // width also clears it in its layout effect. Restore the ARIA value to the
      // width that is now really applied (`startWidth` on the cancel path).
      clearHandleTransform(drag.element)
      setHandleAriaValue(drag.element, finalWidth ?? drag.startWidth)
      // P3: the gesture record must include the final commit frame
      // (`width:frame` / `widthFrameMs`), so `perfEndGesture` runs after the
      // commit. Ending the gesture first would also let the deferred layout
      // measure run against the old width. `endWidthGesture` is idempotent, and
      // this is the outer `finally`, so a throw from any teardown step above
      // still closes it.
      perfEndGesture('width-resize')
      endWidthGesture()
    }
  }, [])

  // A committed width changes the base `left` through React. Clear the
  // drag-only translate in the same frame as that DOM update; clearing it in
  // `endDrag` alone can leave the line at the old base position for one frame
  // (spec §13.4 note 4). The cleanup also covers unmount.
  useLayoutEffect(() => {
    const element = elementRef.current
    clearHandleTransform(element)
    return () => clearHandleTransform(element)
  }, [width])

  // Unmount mid-drag: drop listeners/capture without committing, and close only
  // the gesture this handle opened (`perfEndGesture` is name-scoped, so a bare
  // call could end someone else's open gesture).
  useEffect(
    () => () => {
      const drag = dragRef.current
      dragRef.current = null
      stopTracking()
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      if (drag) {
        // A drag torn down with the component still owns the width gesture;
        // cancel the preview before closing it (same reason as `endDrag`), and
        // close only the gesture this handle opened (`perfEndGesture` is
        // name-scoped, so a bare call could end someone else's open gesture).
        cancelRef.current?.()
        perfEndGesture('width-resize')
        endWidthGesture()
      }
      clearHandleTransform(drag?.element)
      try {
        if (drag?.element.hasPointerCapture?.(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId)
      } catch {
        /* pointer already released */
      }
    },
    []
  )

  const onPointerDown = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    if (dragRef.current) endDrag(false)
    const element = event.currentTarget
    elementRef.current = element
    clearHandleTransform(element)
    try {
      element.setPointerCapture?.(event.pointerId)
    } catch {
      /* synthetic pointer events may not be capturable */
    }
    const start = clampSidebarWidth(width, globalThis.innerWidth) ?? width
    const drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: start,
      width: start,
      // The visual base is the committed width prop (`left = width - 3`), not
      // the viewport-clamped start, so the first transform lands on the line.
      baseWidthAtDragStart: width,
      lastPointerAt: perfNow(),
      element,
    }
    dragRef.current = drag
    // Not gated on `perfEnabled()`: the ungrouped layout deferral is a behavior
    // of the drag, not of the measurement build (spec §11.6).
    beginWidthGesture()
    perfBeginGesture('width-resize')

    // Attach synchronously: waiting for a React effect can miss the first
    // pointermove events while the host is still hydrating.
    const onMove = (moveEvent) => {
      const active = dragRef.current
      if (!active || active.pointerId !== moveEvent.pointerId) return
      const next = clampSidebarWidth(active.startWidth + (moveEvent.clientX - active.startX), globalThis.innerWidth)
      if (next === null) return
      active.width = next
      active.lastPointerAt = perfNow()
      if (frameRef.current !== null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        const now = perfNow()
        // N5: how far the pointer moved after the last delivered event, i.e.
        // the line's lag behind the pointer before this frame's work starts.
        perfSample('width:pointerLagMs', now - active.lastPointerAt)
        if (active.element?.style) {
          const offset = active.width - active.baseWidthAtDragStart
          active.element.style.transform = `translate3d(${offset}px,0,0)`
        }
        // Preview never schedules a React render, so the ARIA value would stay
        // frozen on the committed width for the whole drag; write it here.
        setHandleAriaValue(active.element, active.width)
        // Preview never schedules a React render; the line moves by transform
        // and the sidebar variable advances under the adaptive backpressure.
        previewRef.current?.(active.width)
      })
    }
    const onUp = (upEvent) => {
      if (dragRef.current?.pointerId !== upEvent.pointerId) return
      endDrag(true)
    }
    const onCancel = (cancelEvent) => {
      if (dragRef.current?.pointerId !== cancelEvent.pointerId) return
      endDrag(false)
    }
    globalThis.addEventListener('pointermove', onMove)
    globalThis.addEventListener('pointerup', onUp)
    globalThis.addEventListener('pointercancel', onCancel)
    trackingRef.current = () => {
      globalThis.removeEventListener('pointermove', onMove)
      globalThis.removeEventListener('pointerup', onUp)
      globalThis.removeEventListener('pointercancel', onCancel)
    }
    setDragging(true)
  }

  const onKeyDown = (event) => {
    const viewport = globalThis.innerWidth
    const maxWidth = maxSidebarWidth(viewport)
    let requested = null
    if (event.key === 'ArrowLeft') requested = width - 16
    else if (event.key === 'ArrowRight') requested = width + 16
    else if (event.key === 'Home') requested = min
    else if (event.key === 'End') requested = maxWidth
    if (requested === null) return
    event.preventDefault()
    const next = clampSidebarWidth(requested, viewport)
    if (next === null) return
    // Keyboard steps commit immediately: there is no pointer preview to flush.
    commitRef.current?.(next)
  }

  return h('div', {
    ref: elementRef,
    class: 'dsg-resize-handle',
    'data-testid': 'session-groups-resize-handle',
    'data-dragging': dragging ? 'true' : 'false',
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': t('width.handle'),
    'aria-valuemin': String(min),
    'aria-valuemax': String(max),
    'aria-valuenow': String(Math.round(width)),
    title: t('width.resetHint'),
    tabindex: '0',
    style: { left: `${width - 3}px` },
    onPointerDown,
    onDoubleClick: (event) => {
      event.preventDefault()
      onReset?.()
    },
    onKeyDown,
  })
}

// ---------------------------------------------------------------------------

export { ResizeHandle }
