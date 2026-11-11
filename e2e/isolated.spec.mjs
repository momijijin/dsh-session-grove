#!/usr/bin/env node
/**
 * A+ isolated Playwright smoke.
 *
 * Drives a disposable DSH web instance started by
 * scripts/qa/start-isolated-web.ps1. It never attaches to the real DSH window:
 * DSH_TEST_URL must be the isolated port, and DSH_TEST_HOME must not live under
 * the real ~/.dsh.
 */
import { chromium } from 'playwright'
import { resolve } from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

const urlText = process.env.DSH_TEST_URL ?? ''
const testHome = process.env.DSH_TEST_HOME ?? ''
const realHome = resolve(process.env.USERPROFILE ?? '', '.dsh')

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}
if (!urlText) fail('DSH_TEST_URL is required')
if (!testHome) fail('DSH_TEST_HOME is required')
if (resolve(testHome).toLowerCase().startsWith(realHome.toLowerCase())) fail(`refusing real DSH home: ${testHome}`)

let url
try {
  url = new URL(urlText)
} catch {
  fail(`invalid DSH_TEST_URL: ${urlText}`)
}
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) fail(`test URL must be loopback: ${url.origin}`)
if (url.port === '43120') fail('refusing the real DSH web port 43120')
if (!existsSync(testHome)) fail(`test home does not exist: ${testHome}`)

const browser = await chromium.launch({
  headless: true,
  // The local Playwright package can be newer than the installed browser
  // build; use the on-disk Chromium when it exists instead of silently
  // downloading a browser during a test run.
  executablePath: (() => {
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    const root = resolve(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
    if (!existsSync(root)) return undefined
    const candidates = readdirSync(root)
      .filter((name) => name.startsWith('chromium-'))
      .sort()
      .reverse()
    for (const name of candidates) {
      const path = resolve(root, name, 'chrome-win64', 'chrome.exe')
      if (existsSync(path)) return path
    }
    return undefined
  })(),
})
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
page.setDefaultTimeout(12_000)
const pageErrors = []
page.on('pageerror', (error) => {
  pageErrors.push(error.message)
  console.error(`PAGE_ERROR: ${error.message}`)
})
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error(`PAGE_CONSOLE: ${msg.text()}`)
})

// ---------------------------------------------------------------------------
// Real preview-geometry thresholds (SPEC §8.1, T3.1).
//
// Hard-coded from the shipped stylesheet/runtime, not from measured output:
// - `.dsg-dialog[data-kind="profile-preview"] { width: min(560px, calc(100vw - 24px)); }`
//   in `src/client/css.js`: on the 1280px-wide test viewport the dialog must be
//   at least 560px wide.
// - DialogHost clamps the initial preview height with
//   `Math.min(560, Math.max(0, innerHeight - 24))` and floors it at 320
//   (`src/client/dialog-host.js`): no taller than 560px and never past the
//   viewport minus the 24px margin; the 320px floor keeps a compact dialog.
// - `.dsg-profile-preview-change + .dsg-profile-preview-change` only adds a 1px
//   hairline (`src/client/css.js`), so the measured box gap between adjacent
//   changes must stay within 1px.
// - The narrow-layout gate above stores the sidebar width as 264px and reloads;
//   `SIDEBAR_WIDTH_MIN = 264` (`src/client/sidebar-width.js`) is the host sidebar
//   *track* width. The plugin's `.dsg-root` box sits inside that track, so its
//   measured width is smaller (252px on the isolated host: about 12px of host
//   chrome inset). Gate 5 therefore asserts a narrow-layout band
//   (224 <= root width <= 264 + 1) instead of an exact width; the default
//   persisted width is 420px, so the band unambiguously means "narrowest layout
//   is already applied".
// - `.dsg-profile-preview-change-title/-detail { white-space: normal;
//   overflow-wrap: anywhere }` and `.dsg-dialog-content { overflow-y: auto }`
//   (`src/client/css.js`) are what the wrapping/scroll assertions verify.
// ---------------------------------------------------------------------------
const PREVIEW_DIALOG_WIDTH_PX = 560
const PREVIEW_DIALOG_MAX_HEIGHT_PX = 560
const PREVIEW_DIALOG_MIN_HEIGHT_PX = 320
const PREVIEW_VIEWPORT_MARGIN_PX = 24
const PREVIEW_ROW_GAP_TOLERANCE_PX = 1
const SIDEBAR_MIN_WIDTH_PX = 264
/** Lower bound of the narrow-layout band for the plugin root box (host inset). */
const PREVIEW_NARROW_SIDEBAR_MIN_PX = 224
/** Enough removed-group rows to overflow the 560px-capped preview body. */
const PREVIEW_DIFF_GROUP_COUNT = 60

const groupView = page.locator('[data-testid="session-groups-view"]')
const screenshot = () => page.screenshot({ path: `${testHome}/isolated-failure.png`, fullPage: false }).catch(() => {})

const dismissShippedOverlays = async () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const clicked = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
      for (const dialog of dialogs) {
        const label = dialog.getAttribute('aria-label') ?? ''
        const text = (dialog.textContent ?? '').trim()
        if (!/get started|开始使用/i.test(label) && !/Add API Key|Sign in to your DeepSeek|添加 API Key/i.test(text)) continue
        const close = dialog.querySelector('button[aria-label="Close"], button[aria-label="关闭"], button[title="Close"], button[title="关闭"]')
        if (close) {
          close.click()
          return 'onboarding-close'
        }
      }
      const textButton = Array.from(document.querySelectorAll('button')).find((el) => /^(Continue|继续|知道了|关闭)$/i.test((el.textContent ?? '').trim()))
      if (textButton) {
        textButton.click()
        return 'text'
      }
      const closeButton = Array.from(document.querySelectorAll('button,[role="button"]')).find((el) => {
        const text = (el.textContent ?? '').trim()
        const label = el.getAttribute('aria-label') ?? ''
        return /^(Close|关闭|×|✕)$/i.test(text) || /^(close|关闭)$/i.test(label)
      })
      if (closeButton) {
        closeButton.click()
        return 'close'
      }
      if (document.querySelector('[role="dialog"]')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        return 'escape'
      }
      return false
    })
    if (!clicked) return
    await page.waitForTimeout(350)
  }
}

const closeGetStarted = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const dialog = page.locator('[role="dialog"][aria-label="Get started"]')
    if ((await dialog.count()) > 0) {
      const close = dialog.locator('button[aria-label="Close"]')
      if ((await close.count()) > 0) await close.first().click()
      else await page.keyboard.press('Escape')
      await page.waitForTimeout(400)
      if ((await dialog.count()) === 0) return true
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
      if ((await dialog.count()) === 0) return true
    }
    await page.waitForTimeout(300)
  }
  return false
}

const groupRows = () => page.locator('[data-testid="session-groups-group"]')
const groupRow = (name) => groupRows().filter({ hasText: name }).first()
const groupRowById = (id) => page.locator(`[data-testid="session-groups-group"][data-group-id="${id}"]`)
const menuItem = (pattern) => page.locator('[role="menuitem"]').filter({ hasText: pattern }).first()

const createGroup = async (name) => {
  await page.locator('[data-testid="session-groups-new-group"]').click()
  await page.locator('[data-testid="session-groups-dialog-input"]').fill(name)
  await page.locator('[data-testid="session-groups-dialog-confirm"]').click()
  const row = groupRow(name)
  await row.waitFor({ state: 'visible' })
  return await row.getAttribute('data-group-id')
}

const createChildGroup = async (parentId, name) => {
  const parent = groupRowById(parentId)
  await parent.locator('[data-testid="session-groups-group-menu"]').click({ force: true })
  await page.locator('[data-testid="session-groups-menu"]').waitFor({ state: 'visible' })
  await menuItem(/新建子分组|New subgroup/).click()
  await page.locator('[data-testid="session-groups-dialog-input"]').fill(name)
  await page.locator('[data-testid="session-groups-dialog-confirm"]').click()
  await groupRow(name).waitFor({ state: 'visible' })
}

const moveGroup = async (sourceId, targetId) => {
  const source = groupRowById(sourceId)
  await source.locator('[data-testid="session-groups-group-menu"]').click({ force: true })
  await page.locator('[data-testid="session-groups-menu"]').waitFor({ state: 'visible' })
  await menuItem(/移到其他分组|Move to another group/).click()
  await page.locator(`[data-testid="session-groups-dialog-group"][data-group-id="${targetId}"]`).click()
  await page.locator('[data-testid="session-groups-dialog-confirm"]').click()
  await page.waitForTimeout(500)
}

const moveSessionToGroup = async (sessionId, targetId) => {
  const session = page.locator(`[data-testid="session-groups-session"][data-session-id="${sessionId}"]`).first()
  await session.locator('[data-testid="session-groups-session-menu"]').click({ force: true })
  await page.locator('[data-testid="session-groups-menu"]').waitFor({ state: 'visible' })
  await menuItem(/归入分组|Assign to group/).click()
  await page.locator(`[data-testid="session-groups-dialog-group"][data-group-id="${targetId}"]`).click()
  await page.locator('[data-testid="session-groups-dialog-confirm"]').click()
  await page.waitForTimeout(500)
}

const addSessionToGroup = async (groupId) => {
  const before = groupSessionIds(groupId).length
  await groupRowById(groupId).locator('[data-testid="session-groups-group-add"]').click({ force: true })
  // The group action now creates in the inferred workspace directly; there is
  // no intermediate workspace dialog. Wait for the persisted placement.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (groupSessionIds(groupId).length > before) return
    await page.waitForTimeout(250)
  }
  throw new Error(`new session did not land in group ${groupId}`)
}

const readTestDoc = () => JSON.parse(readFileSync(resolve(testHome, 'storages', 'dsh-session-grove.json'), 'utf8'))
const readTestRegistry = () =>
  JSON.parse(readFileSync(resolve(testHome, 'storages', 'dsh-session-grove.profiles.json'), 'utf8'))

const groupSessionIds = (groupId) => {
  const doc = readTestDoc()
  return doc.groups.find((group) => group.id === groupId)?.sessionIds ?? []
}

try {
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)

  // First boot on a fresh home shows the shipped preview notice and account
  // modal. Dismiss only their close/continue affordances; never sign in or add
  // credentials.
  await page.waitForTimeout(1500)
  await dismissShippedOverlays()
  await closeGetStarted()
  await page.waitForTimeout(800)

  // If the app opens on the shipped workspace view, use the plugin's overlay
  // toggle; once the groups view is active the header toggle owns switching back.
  if ((await groupView.count()) === 0) {
    const toggle = page.locator('[data-testid="session-groups-workspace-toggle"], [data-testid="session-groups-toggle"]').first()
    if ((await toggle.count()) === 0) {
      console.error(`plugin test ids: ${JSON.stringify(await page.locator('[data-testid^="session-groups"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid'))))}`)
      await screenshot()
      throw new Error('session groups view/toggle missing; check isolated profile boot')
    }
    await toggle.click()
  }
  await groupView.waitFor({ state: 'visible' })

  const onboarding = page.locator('[data-testid="session-groups-onboarding"]')
  await onboarding.waitFor({ state: 'visible' })
  const onboardingTitle = (await page.locator('.dsg-onboarding-title').innerText()).trim()
  if (onboardingTitle !== 'Welcome to Free Groups') {
    throw new Error(`English host rendered a non-English onboarding title: ${onboardingTitle}`)
  }
  const onboardingDismiss = (await page.locator('[data-testid="session-groups-onboarding-dismiss"]').innerText()).trim()
  if (onboardingDismiss !== 'Got it') {
    throw new Error(`English host rendered a non-English onboarding action: ${onboardingDismiss}`)
  }
  await page.locator('[data-testid="session-groups-onboarding-dismiss"]').click()
  await onboarding.waitFor({ state: 'detached' })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  if ((await groupView.count()) === 0) {
    const toggle = page.locator('[data-testid="session-groups-workspace-toggle"], [data-testid="session-groups-toggle"]').first()
    if (await toggle.count()) await toggle.click()
  }
  await groupView.waitFor({ state: 'visible' })
  if ((await page.locator('[data-testid="session-groups-onboarding"]').count()) !== 0) {
    throw new Error('onboarding reappeared after dismissal')
  }

  for (const id of ['session-groups-running-button', 'session-groups-blocked-button', 'session-groups-unread-button']) {
    const button = page.locator(`[data-testid="${id}"]`)
    if ((await button.count()) !== 1) throw new Error(`expected one ${id}`)
  }
  if ((await page.locator('[data-testid="session-groups-background-button"]').count()) !== 0) {
    throw new Error('background-jobs button must not exist')
  }

  // Move-to-group must land at the target parent head, above existing children.
  await closeGetStarted()
  const suffix = Date.now().toString(36).slice(-6)
  const targetName = `Target ${suffix}`
  const childName = `Child ${suffix}`
  const sourceName = `Source ${suffix}`
  const targetId = await createGroup(targetName)
  await createChildGroup(targetId, childName)
  const sourceId = await createGroup(sourceName)

  // The group menu's first action is the direct new-session entry. Close the
  // menu without running it, then use the subgroup dialog for modal a11y.
  await groupRowById(targetId).locator('[data-testid="session-groups-group-menu"]').click({ force: true })
  const firstGroupMenuItem = page.locator('[role="menuitem"]').first()
  await firstGroupMenuItem.waitFor({ state: 'visible' })
  if ((await firstGroupMenuItem.getAttribute('data-testid')) !== 'session-groups-group-new-session') {
    throw new Error('group menu first item is not the new-session action')
  }
  if (!/New session/.test((await firstGroupMenuItem.textContent()) ?? '')) {
    throw new Error(`English host rendered a non-English group menu label: ${await firstGroupMenuItem.innerText()}`)
  }
  await page.keyboard.press('Escape')
  await page.locator('[data-testid="session-groups-menu"]').waitFor({ state: 'hidden' })

  await groupRowById(targetId).locator('[data-testid="session-groups-group-menu"]').click({ force: true })
  await menuItem(/新建子分组|New subgroup/).click()
  const a11yDialog = page.locator('[data-testid="session-groups-dialog"]')
  await a11yDialog.waitFor({ state: 'visible' })
  const labelledBy = await a11yDialog.getAttribute('aria-labelledby')
  if (!labelledBy || (await page.locator(`#${labelledBy}`).count()) !== 1) {
    throw new Error('dialog has no single accessible title reference')
  }
  const dialogTitle = (await page.locator(`#${labelledBy}`).innerText()).trim()
  if (dialogTitle !== 'New subgroup') {
    throw new Error(`English host rendered a non-English dialog title: ${dialogTitle}`)
  }
  for (let index = 0; index < 8; index += 1) await page.keyboard.press('Tab')
  const tabStayedInside = await page.evaluate(() =>
    document.activeElement?.closest?.('[data-testid="session-groups-dialog"]') !== null
  )
  if (!tabStayedInside) throw new Error('Tab escaped the modal dialog')
  const keyboardTitlebar = page.locator('[data-testid="session-groups-dialog-titlebar"]')
  await keyboardTitlebar.focus()
  const beforeMove = await a11yDialog.boundingBox()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(120)
  const afterMove = await a11yDialog.boundingBox()
  if (!beforeMove || !afterMove || afterMove.x <= beforeMove.x) throw new Error('keyboard dialog move did not move right')
  const keyboardResizer = page.locator('[data-testid="session-groups-dialog-resizer"]')
  await keyboardResizer.focus()
  const beforeResize = await a11yDialog.boundingBox()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(120)
  const afterResize = await a11yDialog.boundingBox()
  if (!beforeResize || !afterResize || afterResize.width <= beforeResize.width || afterResize.height <= beforeResize.height) {
    throw new Error('keyboard dialog resize did not grow the dialog')
  }
  await page.keyboard.press('Escape')
  await a11yDialog.waitFor({ state: 'hidden' })
  const restored = await page.evaluate(() => ({
    testid: document.activeElement?.getAttribute?.('data-testid'),
    groupId: document.activeElement?.getAttribute?.('data-group-id'),
  }))
  if (restored.testid !== 'session-groups-group' || restored.groupId !== targetId) {
    throw new Error(`dialog did not restore focus to the originating group row: ${JSON.stringify(restored)}`)
  }

  await groupRowById(targetId).locator('[data-testid="session-groups-group-menu"]').click({ force: true })
  const rovingMenu = page.locator('[data-testid="session-groups-menu"]')
  await rovingMenu.waitFor({ state: 'visible' })
  await page.keyboard.press('ArrowDown')
  const rovingLabel = await page.evaluate(() => document.activeElement?.textContent ?? '')
  if (!/新建子分组|New subgroup/.test(rovingLabel)) throw new Error(`menu ArrowDown did not move focus: ${rovingLabel}`)
  await page.keyboard.press('Escape')
  await rovingMenu.waitFor({ state: 'hidden' })

  await moveGroup(sourceId, targetId)
  const ordered = await groupRows().evaluateAll((rows) => rows.map((row) => row.getAttribute('data-group-id')))
  const targetAt = ordered.indexOf(targetId)
  const sourceAt = ordered.indexOf(sourceId)
  if (targetAt < 0 || sourceAt !== targetAt + 1) {
    throw new Error(`moved group must be the first child of target, order=${JSON.stringify(ordered.slice(targetAt, targetAt + 3))}`)
  }

  // Seed one session in the target and one in the source, then move the
  // source's session through the dialog. Blank sessions are hidden from the
  // tree, so verify the persisted order for the second one.
  await addSessionToGroup(targetId)
  const seededTargetIds = groupSessionIds(targetId)
  if (seededTargetIds.length === 0) throw new Error('new session did not land in target group')
  await addSessionToGroup(sourceId)
  const sourceSessionIds = groupSessionIds(sourceId)
  if (sourceSessionIds.length === 0) throw new Error('new session did not land in source group')
  const moved = sourceSessionIds[0]
  await moveSessionToGroup(moved, targetId)
  const targetSessionIds = groupSessionIds(targetId)
  if (targetSessionIds[0] !== moved || targetSessionIds[1] !== seededTargetIds[0]) {
    throw new Error(`moved session must land at target head, got ${JSON.stringify(targetSessionIds)}`)
  }

  // Collapse and re-expand the target: the persisted head order must survive.
  const targetRow = groupRowById(targetId)
  await targetRow.click({ force: true })
  await page.waitForTimeout(300)
  if ((await targetRow.getAttribute('aria-expanded')) !== 'false') throw new Error('target group did not collapse')
  await targetRow.click({ force: true })
  await page.waitForTimeout(300)
  if ((await targetRow.getAttribute('aria-expanded')) !== 'true') throw new Error('target group did not expand')
  const afterToggle = groupSessionIds(targetId)
  if (afterToggle[0] !== moved || afterToggle[1] !== seededTargetIds[0]) {
    throw new Error(`moved session order changed after collapse/expand: ${JSON.stringify(afterToggle)}`)
  }

  // Header search must find a group by its name and close cleanly.
  await page.evaluate(() => document.querySelector('[data-testid="session-groups-search-toggle"]')?.click())
  const search = page.locator('[data-testid="session-groups-search"]')
  await search.waitFor({ state: 'visible' })
  await search.fill(targetName)
  await page.waitForTimeout(500)
  const searchText = (await page.locator('[data-testid="session-groups-search-result"]').allTextContents()).join('\n')
  if (!searchText.includes(targetName)) throw new Error(`search did not find ${targetName}: ${JSON.stringify(searchText)}`)
  await page.evaluate(() => document.querySelector('[data-testid="session-groups-search-close"]')?.click())
  await page.waitForTimeout(300)

  // View options / archive tri-state: since 0.4.0-beta.62 §10 a pick keeps the
  // popover open (both segments can be set in one visit), so click the session
  // segment several times in a row and close the popover explicitly at the end.
  // The filter persists on the header button; restore the default afterwards.
  const filterButton = page.locator('[data-testid="session-groups-view-options"]').first()
  const initialFilter = await filterButton.getAttribute('data-filter')
  await page.evaluate(() => document.querySelector('[data-testid="session-groups-view-options"]')?.click())
  const filterPopover = page.locator('[data-testid="session-groups-view-options-popover"]')
  await filterPopover.waitFor({ state: 'visible' })
  for (const filter of ['only', 'all', initialFilter ?? 'hidden']) {
    await page.evaluate((value) => {
      document.querySelector(`[data-testid="session-groups-archive-filter"][data-filter="${value}"]`)?.click()
    }, filter)
    await page.waitForTimeout(250)
    const currentFilter = await filterButton.getAttribute('data-filter')
    if (currentFilter !== filter) throw new Error(`archive filter expected ${filter}, got ${currentFilter}`)
    if (!(await filterPopover.isVisible())) throw new Error(`view-options popover closed after picking archive filter ${filter}`)
  }
  await page.keyboard.press('Escape')
  await filterPopover.waitFor({ state: 'hidden' })

  // Dragging an outside session over a collapsed target must auto-expand it.
  const dragRootId = await createGroup(`Drag ${suffix}`)
  await addSessionToGroup(dragRootId)
  const dragSessionId = groupSessionIds(dragRootId)[0]
  if (!dragSessionId) throw new Error('drag source session was not created')
  const targetRowForDrag = groupRowById(targetId)
  await targetRowForDrag.click({ force: true })
  await page.waitForTimeout(300)
  if ((await targetRowForDrag.getAttribute('aria-expanded')) !== 'false') throw new Error('target did not collapse for drag')
  await page.evaluate(({ sourceId, targetId }) => {
    const source = document.querySelector(`[data-testid="session-groups-session"][data-session-id="${sourceId}"]`)
    const target = document.querySelector(`[data-testid="session-groups-group"][data-group-id="${targetId}"]`)
    if (!source || !target) throw new Error('drag rows missing')
    const dt = new DataTransfer()
    window.__dsgTestTransfer = dt
    window.__dsgTestSource = source
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    const rect = target.getBoundingClientRect()
    for (const type of ['dragenter', 'dragover']) {
      target.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }))
    }
  }, { sourceId: dragSessionId, targetId })
  await page.waitForTimeout(850)
  if ((await targetRowForDrag.getAttribute('aria-expanded')) !== 'true') throw new Error('collapsed target did not auto-expand on drag hover')
  await page.evaluate(() => {
    window.__dsgTestSource?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dsgTestTransfer }))
    window.__dsgTestSource = null
    window.__dsgTestTransfer = null
  })

  // Group header edge zones: top and bottom must produce the before/after
  // placeholders and must not commit without a drop.
  for (const edge of [
    { ratio: 0.2, kind: 'group-before' },
    { ratio: 0.8, kind: 'group-after' },
  ]) {
    await page.evaluate(({ sourceId, targetId, ratio }) => {
      const source = document.querySelector(`[data-testid="session-groups-group"][data-group-id="${sourceId}"]`)
      const target = document.querySelector(`[data-testid="session-groups-group"][data-group-id="${targetId}"]`)
      if (!source || !target) throw new Error('edge drag rows missing')
      const dt = new DataTransfer()
      window.__dsgEdgeTransfer = dt
      window.__dsgEdgeSource = source
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
      const rect = target.getBoundingClientRect()
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + Math.max(2, rect.height * ratio),
      }))
    }, { sourceId: dragRootId, targetId, ratio: edge.ratio })
    await page.waitForTimeout(250)
    const kind = await page.locator('[data-testid="session-groups-drop-indicator"]').getAttribute('data-drop-kind')
    if (kind !== edge.kind) throw new Error(`edge ${edge.ratio} expected ${edge.kind}, got ${kind}`)
    await page.evaluate(() => {
      window.__dsgEdgeSource?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.__dsgEdgeTransfer }))
      window.__dsgEdgeSource = null
      window.__dsgEdgeTransfer = null
    })
    await page.waitForTimeout(250)
  }

  // Dialog geometry and backdrop policy: titlebar drag moves, backdrop click
  // leaves the dialog open, and the resize handle changes its size.
  await page.evaluate(() => document.querySelector('[data-testid="session-groups-new-group"]')?.click())
  const dialog = page.locator('[data-testid="session-groups-dialog"]')
  await dialog.waitFor({ state: 'visible' })
  const dialogBefore = await dialog.boundingBox()
  const titlebar = page.locator('.dsg-dialog-titlebar').first()
  const titleBox = await titlebar.boundingBox()
  if (!dialogBefore || !titleBox) throw new Error('dialog geometry missing')
  await page.mouse.move(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(titleBox.x + titleBox.width / 2 + 50, titleBox.y + titleBox.height / 2 + 25, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(250)
  const dialogMoved = await dialog.boundingBox()
  if (!dialogMoved || (Math.abs(dialogMoved.x - dialogBefore.x) < 10 && Math.abs(dialogMoved.y - dialogBefore.y) < 10)) {
    throw new Error(`dialog did not move: ${JSON.stringify({ dialogBefore, dialogMoved })}`)
  }
  await page.evaluate(() => document.querySelector('.dsg-dialog-backdrop')?.click())
  await page.waitForTimeout(250)
  if ((await dialog.count()) !== 1) throw new Error('backdrop click must not close the dialog')
  const resizer = page.locator('.dsg-dialog-resizer').first()
  const resizeBox = await resizer.boundingBox()
  if (!resizeBox) throw new Error('dialog resizer missing')
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 35, resizeBox.y + resizeBox.height / 2 + 25, { steps: 6 })
  await page.mouse.up()
  await page.waitForTimeout(250)
  const dialogResized = await dialog.boundingBox()
  if (!dialogResized || (Math.abs(dialogResized.width - dialogMoved.width) < 5 && Math.abs(dialogResized.height - dialogMoved.height) < 5)) {
    throw new Error(`dialog did not resize: ${JSON.stringify({ dialogMoved, dialogResized })}`)
  }
  await page.evaluate(() => document.querySelector('[data-testid="session-groups-dialog-cancel"]')?.click())
  await page.waitForTimeout(300)

  // Narrow sidebar visual gate: the sidebar must not create horizontal overflow.
  await page.evaluate(() => localStorage.setItem('dsh-session-grove.width.v1', '264'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await closeGetStarted()
  if ((await groupView.count()) === 0) {
    const toggle = page.locator('[data-testid="session-groups-workspace-toggle"], [data-testid="session-groups-toggle"]').first()
    if (await toggle.count()) await toggle.click()
  }
  await groupView.waitFor({ state: 'visible' })
  const narrow = await page.evaluate(() => {
    const root = document.querySelector('.dsg-root')
    const rect = root?.getBoundingClientRect()
    return {
      rootWidth: rect?.width ?? null,
      rootClientWidth: root?.clientWidth ?? null,
      rootScrollWidth: root?.scrollWidth ?? null,
      headerButtons: document.querySelectorAll('.dsg-status-actions .dsg-status-action').length,
    }
  })
  if (narrow.headerButtons !== 3) throw new Error(`narrow layout expected three status buttons, got ${narrow.headerButtons}`)
  if (narrow.rootScrollWidth > narrow.rootClientWidth + 1) {
    throw new Error(`narrow layout overflows horizontally: ${JSON.stringify(narrow)}`)
  }
  await page.screenshot({ path: `${testHome}/narrow-264.png` })

  const lightContrast = await page.evaluate(() => {
    const parse = (value) => {
      const match = value?.match(/rgba?\(([^)]+)\)/)
      if (!match) return null
      const [r, g, b, a = 1] = match[1].split(',').map(Number)
      return { r, g, b, a }
    }
    const background = (el) => {
      let node = el
      while (node) {
        const value = getComputedStyle(node).backgroundColor
        if (value && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') return parse(value)
        node = node.parentElement
      }
      return parse(getComputedStyle(document.body).backgroundColor)
    }
    const luminance = ({ r, g, b }) => {
      const channel = (v) => {
        const n = v / 255
        return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    const contrast = (el) => {
      const fg = parse(getComputedStyle(el).color)
      const bg = background(el)
      if (!fg || !bg) return null
      const a = luminance(fg), b = luminance(bg)
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    }
    return {
      header: contrast(document.querySelector('.dsg-header-label')),
      status: contrast(document.querySelector('.dsg-status-action')),
    }
  })
  if (!(lightContrast.header >= 4.5)) throw new Error(`header contrast too low: ${JSON.stringify(lightContrast)}`)
  if (!(lightContrast.status >= 3)) throw new Error(`status contrast too low: ${JSON.stringify(lightContrast)}`)

  // Runtime locale/theme gates. The test host boots in English; dark mode is
  // applied through the shipped data-ds-dark-theme attribute and must change
  // theme tokens without introducing overflow.
  const lang = await page.evaluate(() => document.documentElement.lang)
  if (!/^en/i.test(lang)) throw new Error(`isolated host expected English locale, got ${lang}`)
  const headerLabel = (await page.locator('.dsg-header-label').first().textContent()) ?? ''
  if (headerLabel !== 'Free Groups') throw new Error(`plugin did not follow the English host locale: ${headerLabel}`)
  const lightToken = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim())
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await page.waitForTimeout(300)
  const dark = await page.evaluate(() => {
    const token = getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim()
    const root = document.querySelector('.dsg-root')
    return { token, rootScrollWidth: root?.scrollWidth ?? null, rootClientWidth: root?.clientWidth ?? null }
  })
  if (!lightToken || lightToken === dark.token) throw new Error(`dark theme did not change tokens: ${lightToken} -> ${dark.token}`)
  if (dark.rootScrollWidth > dark.rootClientWidth + 1) throw new Error('dark narrow layout overflows')
  await page.screenshot({ path: `${testHome}/dark-264.png` })

  // Host sidebar collapse must switch to the rail without a React hook-order
  // crash, then restore the groups view on expand.
  const collapse = page.locator('button[aria-label="Collapse sidebar"]').first()
  if ((await collapse.count()) !== 1) throw new Error('host sidebar collapse button missing')
  await page.evaluate(() => document.querySelector('button[aria-label="Collapse sidebar"]')?.click())
  await page.waitForTimeout(800)
  const collapsedBody = await page.locator('body').innerText()
  if (/分组视图出错|The groups view failed|render error/i.test(collapsedBody)) {
    throw new Error('sidebar collapse triggered the groups render error')
  }
  if (pageErrors.some((message) => /React error #300|targetSessionId|hook/i.test(message))) {
    throw new Error(`sidebar collapse emitted a React error: ${pageErrors.join(' | ')}`)
  }
  const collapsedLayout = await page.evaluate(() => ({
    rootWidth: document.querySelector('[data-dsg-sidebar-root]')?.getBoundingClientRect().width ?? null,
    railWidth: document.querySelector('[data-testid="session-groups-rail"]')?.getBoundingClientRect().width ?? null,
    widthOverride: document.querySelector('[data-dsg-width]')?.textContent ?? null,
  }))
  if (collapsedLayout.rootWidth > 64 || collapsedLayout.railWidth > 64) {
    throw new Error(`collapsed rail kept the wide sidebar: ${JSON.stringify(collapsedLayout)}`)
  }
  if (collapsedLayout.widthOverride !== null) {
    throw new Error(`collapsed rail kept the width override: ${collapsedLayout.widthOverride}`)
  }
  const expand = page.locator('[data-testid="session-groups-rail-expand"]').first()
  if ((await expand.count()) > 0) await page.evaluate(() => document.querySelector('[data-testid="session-groups-rail-expand"]')?.click())
  await page.waitForTimeout(800)
  await groupView.waitFor({ state: 'visible' })

  // Native-tool/HTTP commits are Host-side writes. The sidebar must invalidate
  // its local snapshot through the revision SSE stream instead of waiting for
  // a page reload.
  const externalRename = (name) =>
    page.evaluate(async (nextName) => {
      const loaded = await fetch('/dsh-session-grove/load').then((response) => response.json())
      const doc = loaded.doc
      if (!Array.isArray(doc?.groups) || doc.groups.length === 0) throw new Error('no group for external commit')
      doc.groups[0].name = nextName
      const response = await fetch('/dsh-session-grove/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevision: loaded.revision, doc }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(`external commit failed: ${response.status} ${JSON.stringify(body)}`)
      return body.revision
    }, name)

  const prepareRename = (targetPage) =>
    targetPage.evaluate(async () => {
      const loaded = await fetch('/dsh-session-grove/load').then((response) => response.json())
      if (!Array.isArray(loaded.doc?.groups) || loaded.doc.groups.length === 0) {
        throw new Error('no group for concurrent commit')
      }
      return { baseRevision: loaded.revision, doc: loaded.doc }
    })

  const commitPreparedRename = (targetPage, prepared, name) =>
    targetPage.evaluate(async ({ baseRevision, doc, name: nextName }) => {
      doc.groups[0].name = nextName
      const response = await fetch('/dsh-session-grove/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevision, doc }),
      })
      return { status: response.status, body: await response.json() }
    }, { ...prepared, name })

  const liveName = `SSE 外部刷新 ${Date.now()}`
  await externalRename(liveName)
  await page.waitForFunction((name) => document.body.innerText.includes(name), liveName, { timeout: 6000 })

  // Switching to the shipped workspace and back must reload the Host snapshot,
  // even if the SSE event arrived while the groups slot was unmounted.
  const modeToggle = page.locator('[data-testid="session-groups-toggle"]').first()
  if ((await modeToggle.count()) !== 1) throw new Error('groups mode toggle missing for workspace round-trip')
  await page.evaluate(() => document.querySelector('[data-testid="session-groups-toggle"]')?.click())
  await page.waitForTimeout(600)
  const hiddenName = `切换刷新 ${Date.now()}`
  await externalRename(hiddenName)
  const backToggle = page.locator('[data-testid="session-groups-workspace-toggle"]').first()
  if ((await backToggle.count()) !== 1) throw new Error('workspace overlay toggle missing for return')
  await page.evaluate(() => document.querySelector('[data-testid="session-groups-workspace-toggle"]')?.click())
  await page.waitForTimeout(1000)
  await page.waitForFunction((name) => document.body.innerText.includes(name), hiddenName, { timeout: 6000 })

  // Rapid successive external revisions must converge on the newest snapshot.
  const rapidBase = `快速刷新 ${Date.now()}`
  await externalRename(`${rapidBase}-1`)
  await externalRename(`${rapidBase}-2`)
  await page.waitForFunction((name) => document.body.innerText.includes(name), `${rapidBase}-2`, { timeout: 6000 })

  // ---------------------------------------------------------------------------
  // Group profiles (SPEC §9/§11.3): save-as, same-content direct switch, diff
  // preview + cancel/confirm, undo, rename/archive, dual-window active +
  // profile-changed 409, per-profile collapsed state and the 20-profile limit.
  // ---------------------------------------------------------------------------
  const profileTrigger = (targetPage = page) => targetPage.locator('[data-testid="session-groups-profile-trigger"]')
  if ((await profileTrigger().count()) === 0) {
    throw new Error('profile chevron missing; the installed bundle does not expose the profile surface')
  }
  const profilePopover = (targetPage = page) => targetPage.locator('[data-testid="session-groups-profile-popover"]')
  const profileItem = (id, targetPage = page) =>
    targetPage.locator(`[data-testid="session-groups-profile-item"][data-profile-id="${id}"]`)
  const readProfiles = (targetPage = page) =>
    targetPage.evaluate(() => fetch('/dsh-session-grove/profiles').then((response) => response.json()))
  const waitActive = (targetPage, id) =>
    targetPage.waitForFunction(
      async (expected) => {
        const body = await fetch('/dsh-session-grove/profiles').then((response) => response.json())
        return body.activeId === expected
      },
      id,
      { timeout: 10000 }
    )
  const openProfileMenu = async (targetPage = page) => {
    await targetPage.evaluate(() => document.querySelector('[data-testid="session-groups-profile-trigger"]')?.click())
    await profilePopover(targetPage).waitFor({ state: 'visible' })
  }
  const switchToProfile = async (id, { preview = false, targetPage = page } = {}) => {
    await openProfileMenu(targetPage)
    await profileItem(id, targetPage).click()
    if (!preview) return null
    const body = targetPage.locator('[data-testid="session-groups-profile-preview"]')
    await body.waitFor({ state: 'visible' })
    await targetPage.locator('[data-testid="session-groups-profile-preview-summary"]').waitFor({ state: 'visible' })
    return body
  }
  const confirmPreview = async (targetPage = page) => {
    await targetPage.locator('[data-testid="session-groups-profile-preview-confirm"]').click()
    await targetPage.locator('[data-testid="session-groups-profile-preview"]').waitFor({ state: 'hidden' })
  }
  const cancelPreview = async (targetPage = page) => {
    await targetPage.locator('[data-testid="session-groups-profile-preview-cancel"]').click()
    await targetPage.locator('[data-testid="session-groups-profile-preview"]').waitFor({ state: 'hidden' })
  }

  const initialProfiles = await readProfiles()
  if (initialProfiles.activeId !== 'default') {
    throw new Error(`fresh isolated home should start on the default profile, got ${initialProfiles.activeId}`)
  }
  await openProfileMenu()
  if ((await profileItem('default').getAttribute('aria-checked')) !== 'true') {
    throw new Error('default profile row is not marked current')
  }
  const popoverText = await profilePopover().innerText()
  if (!/\d+\s*(groups?|sessions?)\s*·\s*\d+\s*(groups?|sessions?)/i.test(popoverText)) {
    throw new Error(`profile popover does not show group/session counts: ${popoverText}`)
  }
  await page.keyboard.press('Escape')
  await profilePopover().waitFor({ state: 'hidden' })

  // Save-as copies the active document, creates its directory and activates it
  // without rewriting the default document.
  const defaultDocBefore = readTestDoc()
  const workName = `Work ${suffix}`
  await openProfileMenu()
  await page.locator('[data-testid="session-groups-profile-save-as"]').click()
  const saveAsDialog = page.locator('[data-testid="session-groups-profile-save-as-dialog"]')
  await saveAsDialog.waitFor({ state: 'visible' })
  await page.locator('[data-testid="session-groups-profile-save-as-name"]').fill(workName)
  await page.locator('[data-testid="session-groups-profile-save-as-confirm"]').click()
  await saveAsDialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(
    async (name) => {
      const body = await fetch('/dsh-session-grove/profiles').then((response) => response.json())
      const profile = body.profiles.find((entry) => entry.name === name)
      return profile !== undefined && body.activeId === profile.id
    },
    workName,
    { timeout: 10000 }
  )
  const afterCreate = await readProfiles()
  const workProfile = afterCreate.profiles.find((profile) => profile.name === workName)
  if (!workProfile) throw new Error(`save-as did not create ${workName}`)
  if (readTestDoc().revision !== defaultDocBefore.revision) {
    throw new Error('save-as rewrote the default profile document')
  }
  if (!existsSync(resolve(testHome, 'storages', 'profiles', workProfile.id, 'dsh-session-grove.json'))) {
    throw new Error(`save-as did not create the profile document for ${workProfile.id}`)
  }
  const registryOnDisk = readTestRegistry()
  if (registryOnDisk.activeId !== workProfile.id || registryOnDisk.profiles.length !== 2) {
    throw new Error(`registry on disk does not reflect save-as: ${JSON.stringify(registryOnDisk)}`)
  }
  const workDoc = JSON.parse(
    readFileSync(resolve(testHome, 'storages', 'profiles', workProfile.id, 'dsh-session-grove.json'), 'utf8')
  )
  const workGroupName = workDoc.groups[0]?.name ?? ''

  // Same content: switching back to default activates directly, no preview.
  await switchToProfile('default')
  await waitActive(page, 'default')
  if ((await page.locator('[data-testid="session-groups-profile-preview"]').count()) !== 0) {
    throw new Error('identical profiles opened a switch preview')
  }

  // Create a structural difference on default, then preview, cancel and confirm.
  const profileDiffName = `Profile diff ${Date.now()}`
  await externalRename(profileDiffName)
  await page.waitForFunction((name) => document.body.innerText.includes(name), profileDiffName, { timeout: 6000 })
  await switchToProfile(workProfile.id, { preview: true })
  const summaryText = await page.locator('[data-testid="session-groups-profile-preview-summary"]').innerText()
  if (!/\d/.test(summaryText)) throw new Error(`profile preview summary has no counts: ${summaryText}`)
  if (await page.locator('[data-testid="session-groups-profile-preview-confirm"]').isDisabled()) {
    throw new Error('profile preview confirm is disabled on a fresh preview')
  }
  await cancelPreview()
  if ((await readProfiles()).activeId !== 'default') {
    throw new Error('cancelling the preview changed the active profile')
  }
  await switchToProfile(workProfile.id, { preview: true })
  await confirmPreview()
  await waitActive(page, workProfile.id)
  await page.waitForFunction((name) => document.body.innerText.includes(name), workGroupName, { timeout: 6000 })

  // The switch toast carries a 5s undo; use it to restore default.
  const toastAction = page.locator('[data-testid="session-groups-toast-action"]')
  await toastAction.waitFor({ state: 'visible', timeout: 4000 })
  await toastAction.click()
  await waitActive(page, 'default')
  await page.waitForFunction((name) => document.body.innerText.includes(name), profileDiffName, { timeout: 6000 })

  // Rename, then archive the named profile from Manage; the file stays.
  await openProfileMenu()
  await page.locator('[data-testid="session-groups-profile-manage"]').click()
  const manageDialog = page.locator('[data-testid="session-groups-profile-manage-dialog"]')
  await manageDialog.waitFor({ state: 'visible' })
  const workRow = page.locator(
    `[data-testid="session-groups-profile-manage-row"][data-profile-id="${workProfile.id}"]`
  )
  await workRow.locator('[data-testid="session-groups-profile-rename"]').click()
  const renameDialog = page.locator('[data-testid="session-groups-profile-rename-dialog"]')
  await renameDialog.waitFor({ state: 'visible' })
  const renamedWork = `${workName} renamed`
  await page.locator('[data-testid="session-groups-profile-rename-name"]').fill(renamedWork)
  await page.locator('[data-testid="session-groups-profile-rename-confirm"]').click()
  await renameDialog.waitFor({ state: 'hidden' })
  await manageDialog.waitFor({ state: 'visible' })
  await page.waitForFunction(
    ({ id, name }) => {
      const row = document.querySelector(
        `[data-testid="session-groups-profile-manage-row"][data-profile-id="${id}"]`
      )
      return row?.textContent?.includes(name) === true
    },
    { id: workProfile.id, name: renamedWork },
    { timeout: 8000 }
  )
  const renamedRow = page.locator(
    `[data-testid="session-groups-profile-manage-row"][data-profile-id="${workProfile.id}"]`
  )
  await renamedRow.locator('[data-testid="session-groups-profile-archive"]').click()
  const archiveDialog = page.locator('[data-testid="session-groups-profile-archive-dialog"]')
  await archiveDialog.waitFor({ state: 'visible' })
  await page.locator('[data-testid="session-groups-profile-archive-confirm"]').click()
  await archiveDialog.waitFor({ state: 'hidden' })
  await manageDialog.waitFor({ state: 'visible' })
  await page.waitForFunction(
    (id) => {
      const row = document.querySelector(
        `[data-testid="session-groups-profile-manage-row"][data-profile-id="${id}"]`
      )
      return row?.getAttribute('data-archived') === 'true'
    },
    workProfile.id,
    { timeout: 8000 }
  )
  if (!existsSync(resolve(testHome, 'storages', 'profiles', workProfile.id, 'dsh-session-grove.json'))) {
    throw new Error('archiving deleted the profile document')
  }
  await page.locator('[data-testid="session-groups-profile-manage-close"]').click()
  await manageDialog.waitFor({ state: 'hidden' })
  await openProfileMenu()
  await page.waitForFunction(
    (id) =>
      document.querySelector(`[data-testid="session-groups-profile-item"][data-profile-id="${id}"]`) === null,
    workProfile.id,
    { timeout: 8000 }
  )
  await page.keyboard.press('Escape')
  await profilePopover().waitFor({ state: 'hidden' })

  // Multi-window: a global active switch converges the other window, and a
  // commit prepared against the old profile returns profile-changed.
  const windowName = `Window ${suffix}`
  await page.evaluate(async (name) => {
    const list = await fetch('/dsh-session-grove/profiles').then((response) => response.json())
    const response = await fetch('/dsh-session-grove/profiles/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: list.registryRevision, name }),
    })
    if (!response.ok) throw new Error(`create failed: ${response.status} ${JSON.stringify(await response.json())}`)
  }, windowName)
  await page.waitForFunction(
    async (name) => {
      const body = await fetch('/dsh-session-grove/profiles').then((response) => response.json())
      const profile = body.profiles.find((entry) => entry.name === name)
      return profile !== undefined && body.activeId === profile.id
    },
    windowName,
    { timeout: 10000 }
  )
  const windowProfile = (await readProfiles()).profiles.find((profile) => profile.name === windowName)
  if (!windowProfile) throw new Error('window profile was not created')

  const profileWindowPage = await context.newPage()
  try {
    await profileWindowPage.goto(process.env.DSH_TEST_URL, { waitUntil: 'domcontentloaded' })
    await profileWindowPage.waitForTimeout(1800)
    await profileWindowPage.locator('[data-testid="session-groups-view"]').waitFor({ state: 'visible', timeout: 8000 })
    await profileWindowPage
      .locator('[data-testid="session-groups-profile-trigger"]')
      .waitFor({ state: 'visible', timeout: 8000 })

    // Make the window profile structurally different so both documents are
    // identifiable after the cross-window switch.
    const windowDiffName = `Window diff ${Date.now()}`
    await externalRename(windowDiffName)
    await page.waitForFunction((name) => document.body.innerText.includes(name), windowDiffName, { timeout: 6000 })

    await switchToProfile('default', { preview: true })
    await confirmPreview()
    await waitActive(page, 'default')
    await profileWindowPage.waitForFunction((name) => document.body.innerText.includes(name), profileDiffName, {
      timeout: 10000,
    })

    const prepared = await profileWindowPage.evaluate(async () => {
      const loaded = await fetch('/dsh-session-grove/load').then((response) => response.json())
      return { profileId: loaded.profileId, baseRevision: loaded.revision, doc: loaded.doc }
    })
    await switchToProfile(windowProfile.id, { preview: true })
    await confirmPreview()
    await waitActive(page, windowProfile.id)
    const conflict = await profileWindowPage.evaluate(async (payload) => {
      const response = await fetch('/dsh-session-grove/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return { status: response.status, body: await response.json() }
    }, { profileId: prepared.profileId, baseRevision: prepared.baseRevision, doc: prepared.doc })
    if (conflict.status !== 409 || conflict.body.code !== 'profile-changed') {
      throw new Error(`expected 409 profile-changed, got ${JSON.stringify(conflict)}`)
    }
    await profileWindowPage.waitForFunction((name) => document.body.innerText.includes(name), windowDiffName, {
      timeout: 10000,
    })
  } finally {
    await profileWindowPage.close().catch(() => {})
  }

  // Collapsed state is scoped per profile and survives switching.
  await switchToProfile('default', { preview: true })
  await confirmPreview()
  await waitActive(page, 'default')
  // `sourceId` may be nested under the target group that this check collapses,
  // so use another independent root group for the "not collapsed here" check.
  const otherRootId = await page.evaluate(async (excluded) => {
    const loaded = await fetch('/dsh-session-grove/load').then((response) => response.json())
    const root = (loaded.doc.groups ?? []).find((group) => !group.parentId && group.id !== excluded)
    return root?.id ?? null
  }, targetId)
  if (!otherRootId) throw new Error('no second root group for the profile collapse check')
  const defaultCollapseTarget = groupRowById(targetId)
  await defaultCollapseTarget.click({ force: true })
  await page.waitForTimeout(300)
  if ((await defaultCollapseTarget.getAttribute('aria-expanded')) !== 'false') {
    throw new Error('default profile group did not collapse')
  }
  const collapsedAfterDefault = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('dsh-session-grove.collapsed.v1') ?? '{}')
  )
  if (collapsedAfterDefault.default?.[targetId] !== true) {
    throw new Error(`default collapsed map missing ${targetId}: ${JSON.stringify(collapsedAfterDefault)}`)
  }

  await switchToProfile(windowProfile.id, { preview: true })
  await confirmPreview()
  await waitActive(page, windowProfile.id)
  if ((await groupRowById(targetId).getAttribute('aria-expanded')) !== 'true') {
    throw new Error('collapsed state leaked across profiles')
  }
  await groupRowById(otherRootId).click({ force: true })
  await page.waitForTimeout(300)
  const collapsedBoth = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('dsh-session-grove.collapsed.v1') ?? '{}')
  )
  if (collapsedBoth.default?.[targetId] !== true || collapsedBoth[windowProfile.id]?.[otherRootId] !== true) {
    throw new Error(`per-profile collapsed maps missing: ${JSON.stringify(collapsedBoth)}`)
  }

  await switchToProfile('default', { preview: true })
  await confirmPreview()
  await waitActive(page, 'default')
  if ((await groupRowById(targetId).getAttribute('aria-expanded')) !== 'false') {
    throw new Error('default profile lost its collapsed group after switching back')
  }
  if ((await groupRowById(otherRootId).getAttribute('aria-expanded')) !== 'true') {
    throw new Error('window profile collapsed state leaked into default')
  }
  await groupRowById(targetId).click({ force: true })
  await page.waitForTimeout(300)

  // Limit: exactly 20 unarchived profiles; save-as disables and the host
  // rejects a 21st create with profile-limit.
  await page.evaluate(async () => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const list = await fetch('/dsh-session-grove/profiles').then((response) => response.json())
      if (list.profiles.filter((profile) => profile.archived !== true).length >= 20) return
      const response = await fetch('/dsh-session-grove/profiles/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevision: list.registryRevision, name: `Limit ${attempt} ${Date.now()}` }),
      })
      if (!response.ok) {
        throw new Error(`limit fill create failed: ${response.status} ${JSON.stringify(await response.json())}`)
      }
    }
  })
  await page.waitForFunction(
    async () => {
      const body = await fetch('/dsh-session-grove/profiles').then((response) => response.json())
      return body.profiles.filter((profile) => profile.archived !== true).length === 20
    },
    null,
    { timeout: 15000 }
  )
  await openProfileMenu()
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="session-groups-profile-item"]').length === 20,
    null,
    { timeout: 10000 }
  )
  if (!(await page.locator('[data-testid="session-groups-profile-save-as"]').isDisabled())) {
    throw new Error('save-as stayed enabled at the 20-profile limit')
  }
  await page.locator('[data-testid="session-groups-profile-manage"]').click()
  await manageDialog.waitFor({ state: 'visible' })
  const manageCount = (await page.locator('[data-testid="session-groups-profile-manage-count"]').innerText()).trim()
  if (manageCount !== '20/20') throw new Error(`manage count ${manageCount} != 20/20`)
  await page.locator('[data-testid="session-groups-profile-manage-close"]').click()
  await manageDialog.waitFor({ state: 'hidden' })
  await page.keyboard.press('Escape')
  await profilePopover().waitFor({ state: 'hidden' })
  const limitResponse = await page.evaluate(async () => {
    const list = await fetch('/dsh-session-grove/profiles').then((response) => response.json())
    const response = await fetch('/dsh-session-grove/profiles/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: list.registryRevision, name: 'Over limit' }),
    })
    return { status: response.status, body: await response.json() }
  })
  if (limitResponse.status !== 409 || limitResponse.body.code !== 'profile-limit') {
    throw new Error(`expected 409 profile-limit, got ${JSON.stringify(limitResponse)}`)
  }

  // Leave the default profile active for the remaining checks.
  await switchToProfile('default')
  await waitActive(page, 'default')

  // -------------------------------------------------------------------------
  // SPEC §8.1 real geometry gate (T3.1, appended after the profile-preview
  // flow). The switch sequence above is proven; here the preview dialog geometry
  // is asserted on a deliberately large structural diff so the body really
  // overflows. This is the only place the preview is measured in real Chromium.
  //
  // Falsification steps (documented, NOT applied by this spec):
  // 1. In `src/client/css.js`, temporarily remove
  //    `.dsg-dialog[data-positioned="true"] .dsg-dialog-content { flex: 1 1 auto; }`
  //    or change `.dsg-dialog-content { overflow-y: auto; }` to `overflow-y: hidden;`
  //    → the body-scroll assertions below must fail;
  // 2. also try `.dsg-profile-preview-change-title { white-space: nowrap; }`
  //    → the horizontal-overflow assertions must fail;
  // 3. restore the stylesheet and rerun this spec → all five gates pass again.
  // This test never mutates the stylesheet.
  // -------------------------------------------------------------------------
  const geometryGroupPrefix = `Geometry ${suffix}`
  await page.evaluate(async ({ count, prefix }) => {
    const loaded = await fetch('/dsh-session-grove/load').then((response) => response.json())
    const doc = loaded.doc
    const longName = (index) => `${prefix} ${String(index).padStart(2, '0')} ${'W'.repeat(40)}`.slice(0, 80)
    for (let index = 0; index < count; index += 1) {
      doc.groups.push({
        id: `geometry-${index}-${prefix.replace(/\s+/g, '-').toLowerCase()}`,
        name: longName(index),
        icon: 'hash',
        parentId: null,
        sessionIds: [],
      })
    }
    const response = await fetch('/dsh-session-grove/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: loaded.revision, doc }),
    })
    if (!response.ok) {
      throw new Error(`preview geometry commit failed: ${response.status} ${JSON.stringify(await response.json())}`)
    }
  }, { count: PREVIEW_DIFF_GROUP_COUNT, prefix: geometryGroupPrefix })
  // Wait until the live client re-read the committed document: the preview diff
  // is computed from the client store, so a stale doc would direct-switch
  // instead of opening the dialog.
  await page.waitForFunction(
    (prefix) => document.body.innerText.includes(`${prefix} 00`),
    geometryGroupPrefix,
    { timeout: 10000 }
  )

  const geometryProfiles = await readProfiles()
  const geometryTarget = geometryProfiles.profiles.find(
    (profile) => profile.archived !== true && profile.id !== geometryProfiles.activeId
  )
  if (!geometryTarget) throw new Error('no target profile for the preview geometry gate')
  await switchToProfile(geometryTarget.id, { preview: true })
  await page.waitForFunction(
    () => document.querySelectorAll('.dsg-profile-preview-change').length >= 3,
    null,
    { timeout: 8000 }
  )
  await page.waitForFunction(
    () =>
      document.querySelector(
        '[data-testid="session-groups-dialog"][data-kind="profile-preview"] .dsg-scroll-rail'
      ) !== null,
    null,
    { timeout: 4000 }
  )
  const previewGeometry = await page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="session-groups-dialog"][data-kind="profile-preview"]')
    const scrollArea = dialog
      ? Array.from(dialog.children).find((child) => child.classList.contains('dsg-scroll-area'))
      : null
    const content = scrollArea?.querySelector('.dsg-dialog-content') ?? null
    if (!dialog || !content) return null
    const dialogRect = dialog.getBoundingClientRect()
    const contentStyle = getComputedStyle(content)
    // Block/flex boxes only: inline spans report a 0 clientWidth, which would
    // make the horizontal-overflow check meaningless.
    const textBoxes = Array.from(
      dialog.querySelectorAll('.dsg-profile-preview-change-title, .dsg-profile-preview-change-detail')
    ).slice(0, 40)
    const rows = Array.from(
      dialog.querySelectorAll('.dsg-profile-preview-list .dsg-profile-preview-change')
    ).slice(0, 4)
    const rowRects = rows.map((row) => row.getBoundingClientRect())
    const gaps = rowRects.slice(1).map((rect, index) => rect.top - rowRects[index].bottom)
    // Proves the container is really scrollable, not merely clipped.
    content.scrollTop = 24
    const scrolled = content.scrollTop
    content.scrollTop = 0
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dialog: {
        width: dialogRect.width,
        height: dialogRect.height,
        left: dialogRect.left,
        top: dialogRect.top,
        right: dialogRect.right,
        bottom: dialogRect.bottom,
      },
      content: {
        scrollHeight: content.scrollHeight,
        clientHeight: content.clientHeight,
        scrollWidth: content.scrollWidth,
        clientWidth: content.clientWidth,
        overflowY: contentStyle.overflowY,
        scrolled,
      },
      hasScrollRail: scrollArea?.querySelector('.dsg-scroll-rail') !== null,
      sidebarWidth: document.querySelector('.dsg-root')?.getBoundingClientRect().width ?? null,
      gaps,
      textOverflows: textBoxes
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({
          className: element.className,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        })),
      textBoxCount: textBoxes.length,
    }
  })
  if (!previewGeometry) throw new Error('profile preview dialog missing for the geometry gate')
  // 1) Width ≥ the 560px CSS expectation; height stays inside the DialogHost cap.
  if (!(previewGeometry.dialog.width >= PREVIEW_DIALOG_WIDTH_PX - 1)) {
    throw new Error(
      `preview dialog narrower than ${PREVIEW_DIALOG_WIDTH_PX}px: ${JSON.stringify(previewGeometry.dialog)}`
    )
  }
  const maxDialogHeight = Math.min(
    PREVIEW_DIALOG_MAX_HEIGHT_PX,
    previewGeometry.viewport.height - PREVIEW_VIEWPORT_MARGIN_PX
  )
  if (!(previewGeometry.dialog.height <= maxDialogHeight + 1)) {
    throw new Error(
      `preview dialog higher than its ${maxDialogHeight}px clamp: ${JSON.stringify(previewGeometry.dialog)}`
    )
  }
  if (!(previewGeometry.dialog.height >= PREVIEW_DIALOG_MIN_HEIGHT_PX - 1)) {
    throw new Error(
      `preview dialog below its ${PREVIEW_DIALOG_MIN_HEIGHT_PX}px floor: ${JSON.stringify(previewGeometry.dialog)}`
    )
  }
  // 2) The body overflows and scrolls: scrollHeight > clientHeight, overflow-y
  //    auto, a real scroll rail and a programmatic scroll that sticks.
  if (!(previewGeometry.content.scrollHeight > previewGeometry.content.clientHeight + 1)) {
    throw new Error(`preview body does not overflow: ${JSON.stringify(previewGeometry.content)}`)
  }
  if (previewGeometry.content.overflowY !== 'auto') {
    throw new Error(`preview body is not scrollable (overflow-y: ${previewGeometry.content.overflowY})`)
  }
  if (!previewGeometry.hasScrollRail) throw new Error('preview body is missing its scroll rail')
  if (!(previewGeometry.content.scrolled > 0)) throw new Error('preview body scrollTop did not move')
  // 3) Long change titles/paths wrap instead of overflowing horizontally.
  if (previewGeometry.textBoxCount === 0) throw new Error('preview rendered no change rows to measure')
  if (previewGeometry.textOverflows.length > 0) {
    throw new Error(`preview change rows overflow horizontally: ${JSON.stringify(previewGeometry.textOverflows)}`)
  }
  if (!(previewGeometry.content.scrollWidth <= previewGeometry.content.clientWidth + 1)) {
    throw new Error(`preview scroll body overflows horizontally: ${JSON.stringify(previewGeometry.content)}`)
  }
  // 4) Adjacent change rows keep one consistent box gap (hairline only).
  if (previewGeometry.gaps.length < 2) {
    throw new Error(`preview needs two adjacent changes to measure gaps: ${JSON.stringify(previewGeometry.gaps)}`)
  }
  const gapSpread = Math.max(...previewGeometry.gaps) - Math.min(...previewGeometry.gaps)
  if (!(gapSpread <= PREVIEW_ROW_GAP_TOLERANCE_PX)) {
    throw new Error(`preview row gaps are inconsistent: ${JSON.stringify(previewGeometry.gaps)}`)
  }
  // 5) Narrow layout: the plugin root box must be inside the narrow-layout band,
  //    and the dialog must still fit in the viewport. `SIDEBAR_MIN_WIDTH_PX` is
  //    the host sidebar *track* width; the plugin `.dsg-root` box is inset by
  //    the host chrome (measured 252px = 264 − 12px on the isolated host), so an
  //    exact 264 assertion is wrong. The default persisted width is 420px, so
  //    224..265 unambiguously means "the narrowest layout is applied".
  if (!(
    previewGeometry.sidebarWidth >= PREVIEW_NARROW_SIDEBAR_MIN_PX &&
    previewGeometry.sidebarWidth <= SIDEBAR_MIN_WIDTH_PX + 1
  )) {
    throw new Error(
      `expected the narrow sidebar band (${PREVIEW_NARROW_SIDEBAR_MIN_PX}..${
        SIDEBAR_MIN_WIDTH_PX + 1
      }px), got ${previewGeometry.sidebarWidth}px`
    )
  }
  const geometryRect = previewGeometry.dialog
  if (!(
    geometryRect.left >= -1 &&
    geometryRect.top >= -1 &&
    geometryRect.right <= previewGeometry.viewport.width + 1 &&
    geometryRect.bottom <= previewGeometry.viewport.height + 1
  )) {
    throw new Error(`preview dialog escapes the viewport: ${JSON.stringify(previewGeometry)}`)
  }
  // PASS diagnostics: keep the measured geometry in the `test:isolated` log so a
  // future host-side layout change is easy to diagnose.
  console.log(
    `preview geometry: dialog ${previewGeometry.dialog.width}x${previewGeometry.dialog.height}px, ` +
      `narrow sidebar ${previewGeometry.sidebarWidth}px, ` +
      `body scroll ${previewGeometry.content.scrollHeight}>${previewGeometry.content.clientHeight}px, ` +
      `row gaps ${JSON.stringify(previewGeometry.gaps)}`
  )
  await cancelPreview()

  // Session actions must preserve the official core set: no no-op pin item,
  // plus fork/copy ID and a hover archive control.
  const sessionRow = page.locator('[data-testid="session-groups-session"]').first()
  const sourceSessionId = await sessionRow.getAttribute('data-session-id')
  const sessionMenuButton = page.locator('[data-testid="session-groups-session-menu"]').first()
  if ((await sessionMenuButton.count()) === 0) throw new Error('session menu button missing')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await sessionMenuButton.click({ force: true })
  const menuText = await page.locator('[data-testid="session-groups-menu"]').innerText()
  if (!/Copy Session ID/i.test(menuText)) {
    throw new Error(`session menu missing Copy Session ID: ${menuText}`)
  }
  // Fork is access/blank gated like the official menu; its absence on a blank
  // session is correct. The action/placement path is covered by unit tests.
  if (/^(?:Pin|Unpin)$/im.test(menuText)) throw new Error(`session menu still exposes pin: ${menuText}`)
  await page.getByRole('menuitem', { name: /^Copy Session ID$/i }).click()
  await page.waitForTimeout(300)
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  if (copied !== sourceSessionId) throw new Error(`copy ID wrote ${copied}, expected ${sourceSessionId}`)
  const toastText = await page.locator('[data-testid="session-groups-toast"]').innerText()
  if (!/Session ID copied/i.test(toastText)) throw new Error(`copy ID toast missing: ${toastText}`)
  const hoverArchive = page.locator('[data-testid="session-groups-session-archive"]').first()
  if ((await hoverArchive.count()) === 0) throw new Error('session hover archive control missing')

  // Settings must be on the package detail page, use DSH switches and expose a
  // standard click-pinned tooltip with the long-form risk/usage copy.
  await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Plugins')?.click())
  await page.waitForTimeout(1500)
  const packageRow = page.locator('[data-plugin-package="dsh-session-grove"]').first()
  await packageRow.waitFor({ state: 'visible', timeout: 15000 })
  await packageRow.click()
  await page.waitForTimeout(1200)
  const settingsPanel = page.locator('[data-testid="session-groups-settings-panel"]').first()
  if ((await settingsPanel.count()) === 0) throw new Error('settings panel is not on the package detail page')
  const settingsText = await settingsPanel.innerText()
  if (!/Free-group settings/.test(settingsText) || !/AI control API/.test(settingsText)) {
    throw new Error(`English host rendered non-English settings copy: ${settingsText.slice(0, 300)}`)
  }
  const pluginHead = await page.locator('[data-plugin-detail="dsh-session-grove"]').innerText()
  if (!/Free Groups/.test(pluginHead)) throw new Error(`localized plugin title missing: ${pluginHead.slice(0, 120)}`)
  const packageIcon = page.locator('[data-plugin-detail="dsh-session-grove"] img[src^="data:image/"]').first()
  if ((await packageIcon.count()) === 0) throw new Error('plugin manager did not load the package icon metadata')
  if ((await page.locator('[role="switch"]').count()) < 5) throw new Error('settings switches are missing')
  const infoButton = page.locator('.dsg-config-info').first()
  if ((await infoButton.count()) === 0) throw new Error('configuration details button missing')
  await infoButton.click()
  await page.waitForTimeout(300)
  const detailsText = await page.locator('[role="tooltip"]').first().innerText()
  if (!/What it does:/i.test(detailsText) || !/Security:/i.test(detailsText)) {
    throw new Error(`configuration details tooltip is incomplete: ${detailsText.slice(0, 300)}`)
  }
  await page.keyboard.press('Escape')
  const configSwitch = page.locator('[data-testid="session-groups-config-diagnostics"] [role="switch"]').first()
  const switchBefore = await configSwitch.getAttribute('aria-checked')
  await configSwitch.click()
  await page.waitForTimeout(600)
  const switchAfter = await configSwitch.getAttribute('aria-checked')
  if (switchBefore === switchAfter) throw new Error('standard settings switch did not toggle')
  if ((await page.locator('[data-testid="session-groups-diagnostics-hud"]').count()) === 0) {
    await page.locator('[data-testid="session-groups-diagnostics-hud"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  }
  if ((await page.locator('[data-testid="session-groups-diagnostics-hud"]').count()) === 0) {
    throw new Error('diagnostics HUD did not start after live config enable')
  }
  await configSwitch.click()
  await page.locator('[data-testid="session-groups-diagnostics-hud"]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  if ((await page.locator('[data-testid="session-groups-diagnostics-hud"]').count()) !== 0) {
    throw new Error('diagnostics HUD did not stop after live config disable')
  }

  const destructiveRow = page.locator('[data-testid="session-groups-config-controlDestructive"]')
  const destructiveSwitch = destructiveRow.locator('[role="switch"]')
  await destructiveSwitch.click()
  await page.waitForTimeout(250)
  const destructiveConfirm = page.locator('[data-testid="session-groups-config-destructive-confirm"]')
  if ((await destructiveConfirm.count()) === 0) throw new Error('destructive confirmation did not open')
  await destructiveConfirm.getByRole('button', { name: /Cancel/i }).click()
  await page.waitForTimeout(250)
  if ((await destructiveSwitch.getAttribute('aria-checked')) === 'true') {
    throw new Error('destructive setting enabled without confirmation')
  }

  const secondPage = await context.newPage()
  try {
    await secondPage.goto(process.env.DSH_TEST_URL, { waitUntil: 'domcontentloaded' })
    await secondPage.waitForTimeout(1800)
    await secondPage.locator('[data-testid="session-groups-view"]').waitFor({ state: 'visible', timeout: 8000 })
    const multiWindowTitle = `双窗口 ${Date.now()}`
    await externalRename(multiWindowTitle)
    await Promise.all([
      page.waitForFunction((name) => document.body.innerText.includes(name), multiWindowTitle, { timeout: 8000 }),
      secondPage.waitForFunction((name) => document.body.innerText.includes(name), multiWindowTitle, { timeout: 8000 }),
    ])

    // Both windows read the same revision before committing. Exactly one CAS
    // may win; the other must receive 409, and both must converge on the winner.
    const preparedOne = await prepareRename(page)
    const preparedTwo = await prepareRename(secondPage)
    const concurrentA = `并发 A ${Date.now()}`
    const concurrentB = `并发 B ${Date.now()}`
    const [resultA, resultB] = await Promise.all([
      commitPreparedRename(page, preparedOne, concurrentA),
      commitPreparedRename(secondPage, preparedTwo, concurrentB),
    ])
    const statuses = [resultA.status, resultB.status].sort((left, right) => left - right)
    if (statuses[0] !== 200 || statuses[1] !== 409) {
      throw new Error(`concurrent CAS expected one 200 and one 409, got ${JSON.stringify({ a: resultA, b: resultB })}`)
    }
    const winner = resultA.status === 200 ? concurrentA : concurrentB
    const final = await page.evaluate(() => fetch('/dsh-session-grove/load').then((response) => response.json()))
    if (final.doc.groups[0].name !== winner) {
      throw new Error(`concurrent winner not persisted: expected ${winner}, got ${final.doc.groups[0].name}`)
    }
    await Promise.all([
      page.waitForFunction((name) => document.body.innerText.includes(name), winner, { timeout: 8000 }),
      secondPage.waitForFunction((name) => document.body.innerText.includes(name), winner, { timeout: 8000 }),
    ])
  } finally {
    await secondPage.close().catch(() => {})
  }

  // Force the EventSource route to fail, commit externally while it is down,
  // then restore the route and prove onopen recovery reloads the page.
  const reconnectPage = await context.newPage()
  let blockEvents = true
  await reconnectPage.route('**/dsh-session-grove/events', (route) =>
    blockEvents ? route.abort() : route.continue(),
  )
  try {
    await reconnectPage.goto(process.env.DSH_TEST_URL, { waitUntil: 'domcontentloaded' })
    await reconnectPage.waitForTimeout(1800)
    await reconnectPage.locator('[data-testid="session-groups-view"]').waitFor({ state: 'visible', timeout: 8000 })
    const reconnectTitle = `重连 ${Date.now()}`
    await externalRename(reconnectTitle)
    blockEvents = false
    await reconnectPage.unroute('**/dsh-session-grove/events')
    await reconnectPage.waitForFunction(
      (name) => document.body.innerText.includes(name),
      reconnectTitle,
      { timeout: 15000 },
    )
  } finally {
    await reconnectPage.close().catch(() => {})
  }

  console.log('PASS: isolated onboarding, search, archive filter, drag auto-expand, group edges, dialog geometry, status buttons, head insertion, collapse/expand, 264px, dark, host rail, external SSE refresh, workspace round-trip refresh, rapid revision convergence, multi-window SSE, concurrent CAS, forced reconnect, profiles (save-as, preview, undo, rename/archive, dual-window active/409, scoped collapse, limit 20), preview geometry (SPEC §8.1), session actions, clipboard copy, search, first-layer settings, localized title, option details, live diagnostics HUD, switch interaction and destructive confirmation')
} catch (error) {
  await screenshot()
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
}





