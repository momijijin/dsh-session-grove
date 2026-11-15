import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyManagedWidth,
  applyWidthOverride,
  clearManagedWidth,
  findLayoutNodes,
  updateManagedWidth,
} from '../../src/client/sidebar-width.js'
import { PERF_STORAGE_KEY, perfEnabled, perfReset, perfSnapshot } from '../../src/client/perf.js'

/** The subset of `CSSStyleDeclaration` the width adapter touches. */
const makeStyle = () => {
  const properties = new Map()
  const style = {
    setProperty(name, value) { properties.set(name, String(value)) },
    getPropertyValue(name) { return properties.has(name) ? properties.get(name) : '' },
    removeProperty(name) { properties.delete(name) },
  }
  // The host can drop its inline style wholesale (`frame.style.cssText = ''`),
  // which clears *every* declaration: the custom property held in `properties`
  // and the plain `grid-template-columns` / `width` fields this fake stores
  // directly. Without this setter the test could only swap the whole style
  // object, which lost the property but kept the template — the exact state
  // where the `latestRest &&` guard is unobservable.
  Object.defineProperty(style, 'cssText', {
    get: () => [
      ...[...properties].map(([name, value]) => `${name}:${value}`),
      ...['gridTemplateColumns', 'width']
        .filter((name) => typeof style[name] === 'string' && style[name] !== '')
        .map((name) => `${name}:${style[name]}`),
    ].join(';'),
    set: (value) => {
      if (String(value) !== '') throw new Error('the fake style only supports clearing via cssText')
      properties.clear()
      delete style.gridTemplateColumns
      delete style.width
    },
  })
  return style
}

class FakeElement {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase()
    this.ownerDocument = doc
    this.children = []
    this.parentElement = null
    this.attributes = new Map()
    this.style = makeStyle()
    this.isConnected = true
    this.textContent = ''
  }

  setAttribute(name, value = '') { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  removeAttribute(name) { this.attributes.delete(name) }
  appendChild(child) {
    child.parentElement = this
    child.ownerDocument = this.ownerDocument
    this.children.push(child)
    return child
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this)
    this.parentElement = null
    this.isConnected = false
  }
  contains(node) {
    for (let current = node; current; current = current.parentElement) if (current === this) return true
    return false
  }
  querySelector(selector) {
    const matches = (element) => {
      if (selector === '[data-side="sidebar"]') return element.getAttribute('data-side') === 'sidebar'
      if (selector === 'style[data-dsg-width]') return element.tagName === 'STYLE' && element.getAttribute('data-dsg-width') !== null
      return false
    }
    const walk = (element) => {
      if (matches(element)) return element
      for (const child of element.children) {
        const found = walk(child)
        if (found) return found
      }
      return null
    }
    return walk(this)
  }
}

const makeDom = () => {
  const doc = {
    head: null,
    documentElement: null,
    createElement(tag) { return new FakeElement(tag, doc) },
    querySelector(selector) { return doc.head?.querySelector(selector) ?? null },
  }
  doc.head = new FakeElement('head', doc)
  doc.documentElement = new FakeElement('html', doc)
  const frame = new FakeElement('div', doc)
  frame.style.gridTemplateColumns = '420px minmax(0, 1fr) 320px'
  const sidebarRoot = new FakeElement('aside', doc)
  sidebarRoot.style.width = '420px'
  const handle = new FakeElement('button', doc)
  handle.setAttribute('data-side', 'sidebar')
  frame.appendChild(handle)
  frame.appendChild(sidebarRoot)
  doc.documentElement.appendChild(frame)
  const root = new FakeElement('div', doc)
  sidebarRoot.appendChild(root)
  return { doc, frame, sidebarRoot, root, handle }
}

const withMutationObserver = (body) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
  let observer = null
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; observer = this }
    observe(target) { this.target = target }
    disconnect() { this.disconnected = true }
    trigger() { this.callback() }
  }
  try {
    return body(() => observer)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'MutationObserver', descriptor)
    else delete globalThis.MutationObserver
    clearManagedWidth()
  }
}

/**
 * Run `body` with the perf capture flag forced through localStorage and a fresh
 * perf state. `'0'` is the emergency opt-out and always wins over the
 * `PERF_MEASURE_BUILD` constant, so it is the only way to assert the disabled
 * path from this build.
 */
const withPerfMode = (value, body) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  globalThis.localStorage = { getItem: (key) => (key === PERF_STORAGE_KEY ? value : null) }
  perfReset()
  try {
    return body()
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
    perfReset()
  }
}

/** The two width counters as cumulative values (`0` when never incremented). */
const widthCounters = () => {
  const { counters } = perfSnapshot()
  return {
    styleWrite: counters['width:styleWrite'] ?? 0,
    cssVar: counters['width:cssVar'] ?? 0,
  }
}

test('findLayoutNodes locates the frame, sidebar track and rest template', () => {
  const { root, frame, sidebarRoot, handle } = makeDom()
  const nodes = findLayoutNodes(root)
  assert.equal(nodes.supported, true)
  assert.equal(nodes.frame, frame)
  assert.equal(nodes.sidebarRoot, sidebarRoot)
  assert.equal(nodes.officialHandle, handle)
  assert.equal(nodes.rest, 'minmax(0, 1fr) 320px')
  assert.equal(findLayoutNodes(null).supported, false)
  assert.equal(findLayoutNodes({ ownerDocument: null }).supported, false)
})

test('applyWidthOverride installs the variable-backed sheet and writes the property at install (B1)', () => {
  withMutationObserver((getObserver) => {
    const { doc, root, frame, sidebarRoot } = makeDom()
    const nodes = findLayoutNodes(root)
    const controller = applyWidthOverride(nodes, 900, 700)
    assert.ok(controller)
    const style = doc.querySelector('style[data-dsg-width]')
    assert.ok(style)

    // The sheet is static: it references the inherited custom property and the
    // host's remaining tracks; no px width may be baked into the text anymore.
    assert.match(
      style.textContent,
      /\[data-dsg-sidebar-frame\]\{grid-template-columns:var\(--dsg-sidebar-col\) minmax\(0, 1fr\) 320px !important\}/,
    )
    assert.match(
      style.textContent,
      /\[data-dsg-sidebar-root\]\{width:var\(--dsg-sidebar-col\) !important;max-width:none !important;min-width:0 !important\}/,
    )
    assert.match(style.textContent, /\[data-dsg-sidebar-frame\] \[data-side="sidebar"\]\{display:none !important\}/)
    assert.equal(style.textContent.includes('560px'), false)

    // B1: installing the rules without the property would leave `var()` invalid
    // at computed-value time and collapse the shell into one column.
    assert.equal(frame.style.getPropertyValue('--dsg-sidebar-col'), '560px')
    const sheet = style.textContent
    assert.equal(frame.getAttribute('data-dsg-sidebar-frame'), '')
    assert.equal(sidebarRoot.getAttribute('data-dsg-sidebar-root'), '')

    // A drag frame only moves the custom property; the sheet text is untouched.
    assert.equal(controller.update(400, 700), 400)
    assert.equal(frame.style.getPropertyValue('--dsg-sidebar-col'), '400px')
    assert.equal(style.textContent, sheet)
    assert.equal(controller.update(100, 500), 264)
    assert.equal(frame.style.getPropertyValue('--dsg-sidebar-col'), '264px')
    assert.equal(style.textContent, sheet)

    assert.equal(controller.update(100, 300), null)
    assert.equal(doc.querySelector('style[data-dsg-width]'), null)
    assert.equal(frame.getAttribute('data-dsg-sidebar-frame'), null)
    assert.equal(frame.style.getPropertyValue('--dsg-sidebar-col'), '')

    const observer = getObserver()
    assert.equal(observer.target, frame)
  })
})

test('refresh restores a host-cleared property without rewriting the sheet, and rewrites once when the rest changes (P2)', () => {
  withPerfMode('1', () =>
    withMutationObserver((getObserver) => {
      const { doc, root, frame } = makeDom()
      const nodes = findLayoutNodes(root)
      const controller = applyWidthOverride(nodes, 600, 1200)
      assert.ok(controller)
      const style = doc.querySelector('style[data-dsg-width]')
      const sheet = style.textContent
      assert.deepEqual(widthCounters(), { styleWrite: 1, cssVar: 1 })

      // One drag frame moves the width away from the install value: the restored
      // property has to be the *current* width, not the one captured at install.
      assert.equal(controller.update(640, 1200), 640)
      assert.deepEqual(widthCounters(), { styleWrite: 1, cssVar: 2 })

      // The host rebuilds its inline style wholesale (`cssText = ''`, a React
      // style reset or a node swap): the template and the property are both gone
      // while the frame node stays put. The shipped `<style>` must keep the last
      // known rest (the host owns the template), so this refresh may only
      // restore the property.
      frame.style.cssText = ''
      const cleared = perfSnapshot().counters
      getObserver().trigger()
      const restored = perfSnapshot().counters
      assert.equal(frame.style.getPropertyValue('--dsg-sidebar-col'), '640px', 'the missing property is restored to the current width')
      assert.equal(
        (restored['width:cssVar'] ?? 0) - (cleared['width:cssVar'] ?? 0),
        1,
        'restoring the property is the one write this refresh performs'
      )
      assert.equal((restored['width:styleWrite'] ?? 0) - (cleared['width:styleWrite'] ?? 0), 0, 'a cleared template must not rewrite the sheet')
      assert.equal(style.textContent, sheet, 'the sheet keeps the last known host rest')
      assert.match(style.textContent, /var\(--dsg-sidebar-col\) minmax\(0, 1fr\) 320px !important/)

      // A later refresh with the property already back is a pure no-op.
      getObserver().trigger()
      assert.equal(style.textContent, sheet)
      assert.deepEqual(widthCounters(), { styleWrite: 1, cssVar: 3 })

      // A changed host template rewrites the static sheet with the new remaining
      // tracks and keeps the same custom property value. Exactly one rewrite.
      frame.style.gridTemplateColumns = '420px 1fr 200px'
      getObserver().trigger()
      assert.match(style.textContent, /var\(--dsg-sidebar-col\) 1fr 200px !important/)
      assert.equal(frame.style.getPropertyValue('--dsg-sidebar-col'), '640px')
      assert.deepEqual(widthCounters(), { styleWrite: 2, cssVar: 3 }, 'one rest change rewrites the sheet exactly once')
      getObserver().trigger()
      assert.deepEqual(widthCounters(), { styleWrite: 2, cssVar: 3 }, 'later refreshes reuse the rewritten sheet')

      controller.clear()
      assert.equal(doc.querySelector('style[data-dsg-width]'), null)
      assert.equal(frame.style.getPropertyValue('--dsg-sidebar-col'), '')
    })
  )
})

test('applyWidthOverride reports a lost host only once and clears its DOM state', () => {
  withMutationObserver((getObserver) => {
    const { root, frame, sidebarRoot } = makeDom()
    const nodes = findLayoutNodes(root)
    let lost = 0
    const controller = applyWidthOverride(nodes, 600, 1200, { onLost: () => { lost += 1 } })
    assert.ok(controller)
    frame.isConnected = false
    getObserver().trigger()
    assert.equal(lost, 1)
    assert.equal(frame.getAttribute('data-dsg-sidebar-frame'), null)
    assert.equal(sidebarRoot.getAttribute('data-dsg-sidebar-root'), null)
    assert.equal(frame.style.getPropertyValue('--dsg-sidebar-col'), '')
    controller.clear()
    assert.equal(lost, 1)
  })
})

test('managed width is a singleton and handles collapse and host replacement', () => {
  withMutationObserver((getObserver) => {
    const first = makeDom()
    const firstNodes = findLayoutNodes(first.root)
    const firstController = applyManagedWidth(firstNodes, 600, 1200)
    assert.ok(firstController)
    assert.equal(applyManagedWidth(firstNodes, 620, 1200), firstController)
    assert.equal(updateManagedWidth(640, 1200), 640)

    first.frame.setAttribute('data-sidebar-collapsed', 'true')
    assert.equal(applyManagedWidth(firstNodes, 700, 1200), null)
    assert.equal(updateManagedWidth(700, 1200), null)
    assert.equal(first.frame.style.getPropertyValue('--dsg-sidebar-col'), '')

    const second = makeDom()
    const secondNodes = findLayoutNodes(second.root)
    const secondController = applyManagedWidth(secondNodes, 700, 1200)
    assert.ok(secondController)
    assert.notEqual(secondController, firstController)
    clearManagedWidth()
    assert.equal(second.doc.querySelector('style[data-dsg-width]'), null)
    assert.equal(second.frame.style.getPropertyValue('--dsg-sidebar-col'), '')
    assert.equal(getObserver().disconnected, true)
  })
})

test('drag frames count width:cssVar, never rewrite the sheet, and their observer refresh is a no-op (P2)', () => {
  withPerfMode('1', () =>
    withMutationObserver((getObserver) => {
      const { doc, root, frame } = makeDom()
      const nodes = findLayoutNodes(root)
      const controller = applyWidthOverride(nodes, 600, 1200)
      assert.ok(controller)
      assert.deepEqual(widthCounters(), { styleWrite: 1, cssVar: 1 }, 'install writes the sheet once and the property once (B1)')
      const sheet = doc.querySelector('style[data-dsg-width]').textContent

      for (const width of [620, 640, 660]) {
        const before = perfSnapshot().counters
        controller.update(width, 1200)
        // In the browser the inline `setProperty` call is what the mutation
        // observer reports; the fake has to deliver that callback so this covers
        // the real per-frame path (setProperty -> observer -> refresh), not just
        // `update()` in isolation.
        getObserver().trigger()
        const after = perfSnapshot().counters
        assert.equal(frame.style.getPropertyValue('--dsg-sidebar-col'), `${width}px`)
        assert.equal(doc.querySelector('style[data-dsg-width]').textContent, sheet)
        assert.equal(
          (after['width:styleWrite'] ?? 0) - (before['width:styleWrite'] ?? 0),
          0,
          'a drag frame must not rewrite the sheet, even through the observer refresh'
        )
        assert.equal((after['width:cssVar'] ?? 0) - (before['width:cssVar'] ?? 0), 1, 'exactly one property write per frame')
      }

      assert.deepEqual(widthCounters(), { styleWrite: 1, cssVar: 4 }, 'only the install wrote the sheet')
      assert.equal(perfSnapshot().samples.widthCssVarMs.count, 4)
      controller.clear()
    })
  )
})

test('install and update still write the property and rules when perf capture is off (P2 PASS gate)', () => {
  withPerfMode('0', () =>
    withMutationObserver(() => {
      assert.equal(perfEnabled(), false)
      const { doc, root, frame, sidebarRoot } = makeDom()
      const nodes = findLayoutNodes(root)
      const controller = applyWidthOverride(nodes, 560, 1000)
      assert.ok(controller)

      const style = doc.querySelector('style[data-dsg-width]')
      assert.ok(style, 'the width sheet is installed even with capture off')
      assert.match(
        style.textContent,
        /\[data-dsg-sidebar-frame\]\{grid-template-columns:var\(--dsg-sidebar-col\) minmax\(0, 1fr\) 320px !important\}/
      )
      assert.equal(frame.getAttribute('data-dsg-sidebar-frame'), '')
      assert.equal(sidebarRoot.getAttribute('data-dsg-sidebar-root'), '')
      assert.equal(frame.style.getPropertyValue('--dsg-sidebar-col'), '560px')

      assert.equal(controller.update(600, 1000), 600)
      assert.equal(frame.style.getPropertyValue('--dsg-sidebar-col'), '600px')
      assert.match(style.textContent, /var\(--dsg-sidebar-col\) minmax\(0, 1fr\) 320px !important/)

      assert.deepEqual(perfSnapshot().counters, {}, 'capture is off, so nothing is counted')
      assert.equal(perfSnapshot().samples.widthCssVarMs.count, 0)
      assert.equal(perfSnapshot().samples.widthStyleWriteMs.count, 0)
      controller.clear()
    })
  )
})
