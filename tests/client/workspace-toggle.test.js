import test from 'node:test'
import assert from 'node:assert/strict'

import { installWorkspaceToggle } from '../../src/client/workspace-toggle.js'

/**
 * Fake DOM for the plain-DOM entry hint. The module only uses element creation,
 * attribute/style writes, click listeners, a couple of class-substring queries
 * and `getBoundingClientRect`, so the shim stays deliberately tiny.
 */
class FakeElement {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase()
    this.ownerDocument = doc
    this.children = []
    this.parentElement = null
    this.attributes = new Map()
    this.style = {}
    this.className = ''
    this.textContent = ''
    this.listeners = new Map()
    this.rect = null
    this.isConnected = true
  }

  get classList() {
    const names = this.className.split(/\s+/).filter(Boolean)
    return { contains: (name) => names.includes(name) }
  }

  setAttribute(name, value = '') {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  appendChild(child) {
    child.parentElement = this
    child.ownerDocument = this.ownerDocument
    this.children.push(child)
    return child
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this)
    }
    this.parentElement = null
    this.isConnected = false
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(
      type,
      list.filter((entry) => entry !== handler)
    )
  }

  click() {
    for (const handler of this.listeners.get('click') ?? []) handler({ stopPropagation() {} })
  }

  getBoundingClientRect() {
    return this.rect ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }

  querySelector(selector) {
    return walk(this, selector, true)
  }

  querySelectorAll(selector) {
    return walk(this, selector, false)
  }
}

const matches = (element, selector) => {
  const classMatch = /^\[class\*="([^"]+)"\]$/.exec(selector)
  if (classMatch) return element.className.includes(classMatch[1])
  const testIdMatch = /^\[data-testid="([^"]+)"\]$/.exec(selector)
  if (testIdMatch) return element.getAttribute('data-testid') === testIdMatch[1]
  const styleMatch = /^style\[([^\]]+)\]$/.exec(selector)
  if (styleMatch) return element.tagName === 'STYLE' && element.attributes.has(styleMatch[1])
  return false
}

const walk = (root, selector, firstOnly) => {
  const found = []
  const visit = (element) => {
    if (firstOnly && found.length > 0) return
    if (element !== root && matches(element, selector)) found.push(element)
    for (const child of element.children) visit(child)
  }
  visit(root)
  return firstOnly ? found[0] ?? null : found
}

const makeDocument = () => {
  const doc = {
    head: null,
    body: null,
    defaultView: {
      innerWidth: 1280,
      innerHeight: 900,
      addEventListener() {},
      removeEventListener() {},
    },
    createElement(tag) {
      return new FakeElement(tag, doc)
    },
    querySelector(selector) {
      return walk(doc.head, selector, true) ?? walk(doc.body, selector, true)
    },
    querySelectorAll(selector) {
      return [...walk(doc.head, selector, false), ...walk(doc.body, selector, false)]
    },
    addEventListener() {},
    removeEventListener() {},
  }
  doc.head = new FakeElement('head', doc)
  doc.body = new FakeElement('body', doc)
  const header = new FakeElement('div', doc)
  header.className = 'sectionHeader'
  const actions = new FakeElement('div', doc)
  actions.className = 'headerActions'
  actions.rect = { left: 400, top: 20, right: 428, bottom: 48, width: 28, height: 28 }
  header.appendChild(actions)
  doc.body.appendChild(header)
  return { doc, actions }
}

const byTestId = (doc, id) => doc.querySelector(`[data-testid="${id}"]`)

const hint = {
  title: 'Free Groups is ready',
  body: 'Drag sessions from different workspaces into one group.',
  primary: 'Take a look',
  dismiss: "Don't show again",
  docsUrl: 'https://momijijin.github.io/dsh-session-grove-docs-site/',
  docsLabel: 'Documentation',
}

test('workspace toggle renders the one-time hint and dismisses it', () => {
  const { doc } = makeDocument()
  const dismissed = []
  const controller = installWorkspaceToggle({
    doc,
    label: 'Switch to groups',
    hint,
    onToggle: () => {},
    onHintDismiss: () => dismissed.push('dismiss'),
  })

  const button = byTestId(doc, 'session-groups-workspace-toggle')
  assert.ok(button, 'toggle button renders')
  assert.equal(button.getAttribute('data-visible'), 'true')
  assert.ok(byTestId(doc, 'session-groups-workspace-entry-hint-dot'), 'unseen hint carries a dot')

  const hintEl = byTestId(doc, 'session-groups-workspace-entry-hint')
  assert.ok(hintEl, 'hint bubble renders')
  assert.equal(hintEl.getAttribute('role'), 'note')
  assert.equal(hintEl.getAttribute('data-visible'), 'true')
  assert.equal(hintEl.children[0].textContent, hint.title)
  assert.equal(hintEl.children[1].textContent, hint.body)
  const docs = byTestId(doc, 'session-groups-workspace-entry-hint-docs')
  assert.ok(docs, 'the first-run hint links the documentation site')
  assert.equal(docs.getAttribute('href'), hint.docsUrl)
  assert.equal(docs.getAttribute('target'), '_blank')
  assert.equal(docs.getAttribute('rel'), 'noreferrer noopener')
  assert.equal(docs.textContent, hint.docsLabel)

  // Once the button has a real rect the bubble anchors under it.
  button.rect = { left: 368, top: 6, right: 396, bottom: 34, width: 28, height: 28 }
  controller.update()
  assert.equal(hintEl.style.left, '368px')
  assert.equal(hintEl.style.top, '40px')

  byTestId(doc, 'session-groups-workspace-entry-hint-dismiss').click()
  assert.deepEqual(dismissed, ['dismiss'])
  assert.equal(hintEl.getAttribute('data-visible'), 'false')
  assert.equal(byTestId(doc, 'session-groups-workspace-entry-hint-dot'), null, 'dot is removed after dismissal')
  controller.dispose()
})

test('the hint primary action enters the view and persists the dismissal', () => {
  const { doc } = makeDocument()
  const events = []
  const controller = installWorkspaceToggle({
    doc,
    label: 'Switch to groups',
    hint,
    onToggle: () => events.push('toggle'),
    onHintDismiss: () => events.push('dismiss'),
  })

  byTestId(doc, 'session-groups-workspace-entry-hint-primary').click()
  assert.deepEqual(events, ['dismiss', 'toggle'])
  controller.dispose()
})

test('using the toggle itself retires the hint', () => {
  const { doc } = makeDocument()
  const events = []
  const controller = installWorkspaceToggle({
    doc,
    label: 'Switch to groups',
    hint,
    onToggle: () => events.push('toggle'),
    onHintDismiss: () => events.push('dismiss'),
  })

  byTestId(doc, 'session-groups-workspace-toggle').click()
  assert.deepEqual(events, ['dismiss', 'toggle'])
  controller.dispose()
})

test('a dismissed hint installs no dot and no bubble', () => {
  const { doc } = makeDocument()
  const controller = installWorkspaceToggle({ doc, label: 'Switch to groups', hint: null })
  assert.equal(byTestId(doc, 'session-groups-workspace-entry-hint'), null)
  assert.equal(byTestId(doc, 'session-groups-workspace-entry-hint-dot'), null)
  assert.equal(byTestId(doc, 'session-groups-workspace-entry-hint-docs'), null)
  assert.ok(byTestId(doc, 'session-groups-workspace-toggle'))
  controller.dispose()
})
