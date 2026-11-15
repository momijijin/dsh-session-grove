/**
 * Minimal fake host-layout DOM for the sidebar-width adapter tests.
 *
 * `sidebar-width.js` measures nothing: it walks up from the groups root to the
 * host frame (inline `grid-template-columns`) and the sidebar root (inline px
 * `width`), then installs one `<style>` element and writes the inherited
 * `--dsg-sidebar-col` custom property. This module provides exactly that
 * surface (plus the fake `MutationObserver` the adapter subscribes to), so a
 * hook/controller integration test can run in Node without a browser.
 */

/** The subset of `CSSStyleDeclaration` the width adapter touches. */
export const makeStyle = () => {
  const properties = new Map()
  const style = {
    setProperty(name, value) { properties.set(name, String(value)) },
    getPropertyValue(name) { return properties.has(name) ? properties.get(name) : '' },
    removeProperty(name) { properties.delete(name) },
  }
  Object.defineProperty(style, 'cssText', {
    get: () => [...properties].map(([name, value]) => `${name}:${value}`).join(';'),
    set: (value) => {
      if (String(value) !== '') throw new Error('the fake style only supports clearing via cssText')
      properties.clear()
      delete style.gridTemplateColumns
      delete style.width
    },
  })
  return style
}

export class FakeElement {
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

/**
 * One host shell: `html > frame > (official handle, sidebarRoot > groupsRoot)`.
 * The frame carries the inline grid template the adapter has to keep and the
 * sidebar root the inline px width it has to replace.
 */
export const makeLayoutDom = () => {
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

/**
 * Install a fake `MutationObserver` for the adapter's refresh subscription.
 * Returns the observer getter plus a restore function; the caller must restore
 * it in a `finally` (the global does not exist in Node).
 */
export const installMutationObserver = () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
  let observer = null
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; observer = this }
    observe(target) { this.target = target }
    disconnect() { this.disconnected = true }
    trigger() { this.callback() }
  }
  const restore = () => {
    if (descriptor) Object.defineProperty(globalThis, 'MutationObserver', descriptor)
    else delete globalThis.MutationObserver
  }
  return { observer: () => observer, restore }
}
