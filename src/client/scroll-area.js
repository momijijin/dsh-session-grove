/**
 * Dialog scroll region with a persistent 5px custom thumb. Native scrollbars
 * are hidden; the thumb is above the list in the stacking order and can be
 * dragged to scroll.
 *
 * The thumb math and the frame batching live in `dialog-frame.js` (spec §14.2.2):
 * scroll/resize/ResizeObserver notifications collapse into one recomputation
 * per frame, while the mount measurement and the thumb's own drag stay
 * synchronous. This component only wires the seams to React state.
 */
import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { computeScrollBar, createScrollUpdateScheduler, mountScrollTracking } from './dialog-frame.js'
import { createFrameBatch } from './frame-batch.js'
import { perfRender } from './perf.js'

const h = createElement

export const ScrollArea = ({ className, children, ...rest }) => {
  perfRender('ScrollArea')
  const scrollerRef = useRef(null)
  const dragCleanupRef = useRef(null)
  const [bar, setBar] = useState(null)
  const computeNow = useCallback(() => computeScrollBar({ element: scrollerRef.current, setBar }), [])
  // One batch + scheduler per mounted scroll area; the scheduler coalesces the
  // scroll/resize/ResizeObserver paths into one recomputation per frame.
  const schedulerRef = useRef(null)
  if (schedulerRef.current === null) {
    schedulerRef.current = createScrollUpdateScheduler({ batch: createFrameBatch(), compute: computeNow })
  }
  const startDrag = (event) => {
    const element = scrollerRef.current
    if (!element || !bar || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const max = element.scrollHeight - element.clientHeight
    const railHeight = Math.max(1, element.clientHeight - 12)
    const track = Math.max(1, railHeight - bar.height)
    const startY = event.clientY
    const startTop = element.scrollTop
    const doc = event.currentTarget?.ownerDocument ?? globalThis.document
    const onMove = (moveEvent) => {
      element.scrollTop = Math.max(0, Math.min(max, startTop + ((moveEvent.clientY - startY) * max) / track))
      // The thumb's own drag stays synchronous: the pointer position is the
      // input, so the thumb has to follow the pointer, not the next frame.
      computeNow()
    }
    const onEnd = () => {
      doc?.removeEventListener?.('pointermove', onMove)
      doc?.removeEventListener?.('pointerup', onEnd)
      doc?.removeEventListener?.('pointercancel', onEnd)
      dragCleanupRef.current = null
    }
    doc?.addEventListener?.('pointermove', onMove)
    doc?.addEventListener?.('pointerup', onEnd)
    doc?.addEventListener?.('pointercancel', onEnd)
    dragCleanupRef.current = onEnd
  }
  useLayoutEffect(() => {
    const element = scrollerRef.current
    if (!element) return undefined
    return mountScrollTracking({ element, scheduler: schedulerRef.current, computeNow })
  }, [computeNow])
  useEffect(() => () => dragCleanupRef.current?.(), [])
  return h(
    'div',
    { class: 'dsg-scroll-area' },
    h('div', { ref: scrollerRef, class: className, ...rest }, children),
    bar
      ? h(
          'div',
          { class: 'dsg-scroll-rail', 'aria-hidden': 'true' },
          h('div', {
            class: 'dsg-scroll-thumb',
            style: { height: `${bar.height}px`, top: `${bar.top}px` },
            onPointerDown: startDrag,
          })
        )
      : null
  )
}
