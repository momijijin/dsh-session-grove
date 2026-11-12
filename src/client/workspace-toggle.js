/**
 * The official workspace header is rendered by the shipped browser while our
 * groups view is unmounted, so it has no plugin slot for an extra action. This
 * module renders one compact overlay button immediately to the left of the
 * official search action; a ResizeObserver keeps it aligned when the header
 * expands/collapses or the sidebar resizes. It never inserts into React's tree.
 *
 * 0.4.0-beta.63: the button also carries the one-time entry hint — a dot badge
 * plus a small anchored coach mark that explains the layer before the user has
 * opened the groups view. The hint is plain DOM (like the button) so it stays
 * testable with the fake document helpers used by the other client modules and
 * never depends on the host header's own transient overlays.
 *
 * Pure DOM, no React and no host imports so it stays testable with the fake
 * document helpers used by the other client modules.
 */

const BUTTON_TEST_ID = 'session-groups-workspace-toggle'
const HINT_TEST_ID = 'session-groups-workspace-entry-hint'
const HINT_DOT_TEST_ID = 'session-groups-workspace-entry-hint-dot'
const HINT_PRIMARY_TEST_ID = 'session-groups-workspace-entry-hint-primary'
const HINT_DISMISS_TEST_ID = 'session-groups-workspace-entry-hint-dismiss'
const HINT_DOCS_TEST_ID = 'session-groups-workspace-entry-hint-docs'
const STYLE_ATTR = 'data-dsg-workspace-toggle-style'

const GRID_PATH =
  'M2.6 2.6h4.4v4.4H2.6zM9 2.6h4.4v4.4H9zM2.6 9h4.4v4.4H2.6zM9 9h4.4v4.4H9z'

const HINT_WIDTH = 248

const STYLES = [
  `.dsg-workspace-toggle{position:fixed;z-index:70;display:none;box-sizing:border-box;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,CanvasText);cursor:pointer;align-items:center;justify-content:center}`,
  `.dsg-workspace-toggle[data-visible="true"]{display:inline-flex}`,
  `.dsg-workspace-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,CanvasText)}`,
  `.dsg-workspace-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,CanvasText);outline-offset:-2px}`,
  `.dsg-workspace-toggle-dot{position:absolute;top:4px;inset-inline-end:4px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4d6bfe);pointer-events:none}`,
  `.dsg-entry-hint{position:fixed;z-index:71;display:none;box-sizing:border-box;width:${HINT_WIDTH}px;padding:10px 12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,Canvas);color:var(--dsw-alias-label-primary,CanvasText);border:0.5px solid var(--dsw-alias-border-l3,color-mix(in srgb,CanvasText 20%,transparent));box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18))}`,
  `.dsg-entry-hint[data-visible="true"]{display:block}`,
  `.dsg-entry-hint-title{font-size:var(--dsg-font-13,13px);line-height:18px;font-weight:600}`,
  `.dsg-entry-hint-body{margin-top:3px;font-size:var(--dsg-font-12,12px);line-height:17px;color:var(--dsw-alias-label-secondary,CanvasText)}`,
  `.dsg-entry-hint-actions{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:8px}`,
  `.dsg-entry-hint-primary,.dsg-entry-hint-dismiss{appearance:none;border:0.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-secondary,CanvasText);border-radius:var(--dsw-radius-sm,6px);height:26px;padding:0 8px;font:inherit;font-size:var(--dsg-font-12,12px);line-height:18px;cursor:pointer;flex:none}`,
  `.dsg-entry-hint-primary:hover,.dsg-entry-hint-dismiss:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));color:var(--dsw-alias-label-primary,CanvasText)}`,
  `.dsg-entry-hint-primary:focus-visible,.dsg-entry-hint-dismiss:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,CanvasText);outline-offset:-2px}`,
  `.dsg-entry-hint-docs{display:inline-flex;align-items:center;height:26px;padding:0 6px;border:0;background:transparent;color:var(--dsw-alias-state-business-primary,#4d6bfe);font-size:var(--dsg-font-12,12px);line-height:18px;text-decoration:none;flex:none;border-radius:var(--dsw-radius-sm,6px)}`,
  `.dsg-entry-hint-docs:hover{text-decoration:underline}`,
  `.dsg-entry-hint-docs:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,CanvasText);outline-offset:-2px}`,
].join('\n')

/** Find the official section header without matching our `.dsg-header-*`. */
export const findOfficialHeader = (doc = globalThis.document) => {
  if (!doc?.querySelector) return null
  for (const element of doc.querySelectorAll('[class*="sectionHeader"]')) {
    if (element.classList?.contains?.('dsg-header-stacked')) continue
    if (element.querySelector?.('[class*="headerActions"]')) return element
  }
  return null
}

/** Find the left-most official header action (search, then the actions group). */
export const findOfficialHeaderAnchor = (header) => {
  if (!header?.querySelector) return null
  return (
    header.querySelector('[class*="searchButton"]') ??
    header.querySelector('[class*="search"]') ??
    header.querySelector('[class*="headerActions"]')
  )
}

/**
 * Install the workspace-header toggle.
 * @param {{ doc?: Document, label?: string, hint?: object | null, onToggle?: () => void, onHintDismiss?: () => void }} [options]
 * @returns {{ update: () => void, dispose: () => void }} controller
 */
export const installWorkspaceToggle = ({ doc = globalThis.document, label = '', hint = null, onToggle, onHintDismiss } = {}) => {
  if (!doc?.createElement || !doc?.body) return { update: () => {}, dispose: () => {} }

  if (!doc.querySelector(`style[${STYLE_ATTR}]`)) {
    const style = doc.createElement('style')
    style.setAttribute(STYLE_ATTR, '')
    style.textContent = STYLES
    doc.head?.appendChild(style)
  }

  const button = doc.createElement('button')
  button.type = 'button'
  button.className = 'dsg-workspace-toggle'
  button.setAttribute('data-testid', BUTTON_TEST_ID)
  button.setAttribute('aria-label', label)
  button.title = label
  button.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${GRID_PATH}" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  doc.body.appendChild(button)

  let disposed = false
  let frame = null
  let observer = null
  let mutation = null

  // --- one-time entry hint ---------------------------------------------------
  let hintEl = null
  let hintDot = null
  let hintShown = false
  let hintDismissed = false

  const dismissHint = () => {
    if (hintDismissed) return
    hintDismissed = true
    hintEl?.setAttribute('data-visible', 'false')
    hintDot?.remove?.()
    hintDot = null
    onHintDismiss?.()
  }

  const buildHint = () => {
    hintEl = doc.createElement('div')
    hintEl.className = 'dsg-entry-hint'
    hintEl.setAttribute('role', 'note')
    hintEl.setAttribute('data-testid', HINT_TEST_ID)

    const title = doc.createElement('div')
    title.className = 'dsg-entry-hint-title'
    title.textContent = hint.title ?? ''

    const body = doc.createElement('div')
    body.className = 'dsg-entry-hint-body'
    body.textContent = hint.body ?? ''

    const actions = doc.createElement('div')
    actions.className = 'dsg-entry-hint-actions'

    const primary = doc.createElement('button')
    primary.type = 'button'
    primary.className = 'dsg-entry-hint-primary'
    primary.setAttribute('data-testid', HINT_PRIMARY_TEST_ID)
    primary.textContent = hint.primary ?? ''
    primary.addEventListener('click', (event) => {
      event.stopPropagation()
      dismissHint()
      onToggle?.()
      schedule()
    })

    const later = doc.createElement('button')
    later.type = 'button'
    later.className = 'dsg-entry-hint-dismiss'
    later.setAttribute('data-testid', HINT_DISMISS_TEST_ID)
    later.textContent = hint.dismiss ?? ''
    later.addEventListener('click', (event) => {
      event.stopPropagation()
      dismissHint()
      schedule()
    })

    // 0.4.0-beta.63: a permanent docs entry even from the first-run hint.
    const docs = hint.docsUrl
      ? doc.createElement('a')
      : null
    if (docs) {
      docs.className = 'dsg-entry-hint-docs'
      docs.setAttribute('data-testid', HINT_DOCS_TEST_ID)
      docs.setAttribute('href', hint.docsUrl)
      docs.setAttribute('target', '_blank')
      docs.setAttribute('rel', 'noreferrer noopener')
      docs.textContent = hint.docsLabel ?? ''
      docs.addEventListener('click', (event) => event.stopPropagation())
    }

    actions.appendChild(primary)
    if (docs) actions.appendChild(docs)
    actions.appendChild(later)
    hintEl.appendChild(title)
    hintEl.appendChild(body)
    hintEl.appendChild(actions)
    doc.body.appendChild(hintEl)
  }

  const positionHint = () => {
    if (!hintEl || hintDismissed) return
    const rect = button.getBoundingClientRect?.()
    if (!rect || !(rect.width > 0)) return
    const viewportWidth = doc.defaultView?.innerWidth ?? globalThis.innerWidth ?? 0
    const viewportHeight = doc.defaultView?.innerHeight ?? globalThis.innerHeight ?? 0
    const maxLeft = viewportWidth > 0 ? Math.max(8, viewportWidth - HINT_WIDTH - 8) : rect.left
    const left = Math.min(Math.max(8, rect.left), maxLeft)
    const hintHeight = hintEl.offsetHeight > 0 ? hintEl.offsetHeight : 132
    let top = rect.bottom + 6
    if (viewportHeight > 0 && top + hintHeight > viewportHeight - 8) {
      top = Math.max(8, rect.top - hintHeight - 6)
    }
    hintEl.style.left = `${Math.round(left)}px`
    hintEl.style.top = `${Math.round(top)}px`
  }

  const showHintOnce = () => {
    if (!hint || hintDismissed || hintShown) return
    if (hintEl === null) buildHint()
    hintShown = true
    hintEl.setAttribute('data-visible', 'true')
    positionHint()
  }

  if (hint) {
    buildHint()
    hintDot = doc.createElement('span')
    hintDot.className = 'dsg-workspace-toggle-dot'
    hintDot.setAttribute('data-testid', HINT_DOT_TEST_ID)
    hintDot.setAttribute('aria-hidden', 'true')
    button.appendChild(hintDot)
  }

  const update = () => {
    if (disposed) return
    const header = findOfficialHeader(doc)
    const anchor = header ? findOfficialHeaderAnchor(header) : null
    if (!anchor?.getBoundingClientRect) {
      button.setAttribute('data-visible', 'false')
      if (hintShown) hintEl?.setAttribute('data-visible', 'false')
      return
    }
    const rect = anchor.getBoundingClientRect()
    if (!(rect.width > 0) || !(rect.height > 0)) {
      button.setAttribute('data-visible', 'false')
      if (hintShown) hintEl?.setAttribute('data-visible', 'false')
      return
    }
    const left = Math.max(4, rect.left - 4 - 28)
    const top = rect.top + (rect.height - 28) / 2
    button.style.left = `${Math.round(left)}px`
    button.style.top = `${Math.round(top)}px`
    button.setAttribute('data-visible', 'true')
    if (!hintDismissed && hintShown) {
      hintEl?.setAttribute('data-visible', 'true')
      positionHint()
    } else if (!hintDismissed) {
      showHintOnce()
    }
  }

  const schedule = () => {
    if (disposed || frame !== null) return
    const raf = doc.defaultView?.requestAnimationFrame ?? globalThis.requestAnimationFrame
    if (typeof raf !== 'function') {
      update()
      return
    }
    frame = raf(() => {
      frame = null
      update()
    })
  }

  const ResizeObserverCtor = doc.defaultView?.ResizeObserver ?? globalThis.ResizeObserver
  if (typeof ResizeObserverCtor === 'function') {
    observer = new ResizeObserverCtor(schedule)
    const header = findOfficialHeader(doc)
    if (header) observer.observe(header)
  }

  // The workspace header mounts one React commit after the mode switch; align
  // once its actions appear without polling.
  const MutationObserverCtor = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver
  if (typeof MutationObserverCtor === 'function' && doc.body) {
    mutation = new MutationObserverCtor((records) => {
      for (const record of records) {
        const target = record.target
        if (target?.closest?.('[class*="sectionHeader"], [class*="headerActions"]')) {
          schedule()
          return
        }
        for (const node of record.addedNodes ?? []) {
          if (node?.nodeType !== 1) continue
          if (node.matches?.('[class*="sectionHeader"], [class*="headerActions"]')) {
            schedule()
            return
          }
          if (node.querySelector?.('[class*="headerActions"]')) {
            schedule()
            return
          }
        }
      }
    })
    mutation.observe(doc.body, { childList: true, subtree: true })
  }

  const onClick = (event) => {
    event.stopPropagation()
    // Entering the view proves the entry was discovered; never re-show the hint.
    if (hint && !hintDismissed) dismissHint()
    onToggle?.()
    schedule()
  }
  button.addEventListener('click', onClick)
  doc.defaultView?.addEventListener?.('resize', schedule, true)
  doc.addEventListener?.('scroll', schedule, true)
  update()
  schedule()

  return {
    update: schedule,
    dispose() {
      if (disposed) return
      disposed = true
      button.removeEventListener('click', onClick)
      doc.defaultView?.removeEventListener?.('resize', schedule, true)
      doc.removeEventListener?.('scroll', schedule, true)
      observer?.disconnect?.()
      mutation?.disconnect?.()
      const raf = doc.defaultView?.cancelAnimationFrame ?? globalThis.cancelAnimationFrame
      if (frame !== null && typeof raf === 'function') raf(frame)
      hintEl?.remove?.()
      hintEl = null
      hintDot?.remove?.()
      hintDot = null
      button.remove()
    },
  }
}
