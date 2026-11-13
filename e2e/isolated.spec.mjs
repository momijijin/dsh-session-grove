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

const closeGetStarted = async (targetPage = page) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const dialog = targetPage.locator('[role="dialog"][aria-label="Get started"]')
    if ((await dialog.count()) > 0) {
      const close = dialog.locator('button[aria-label="Close"]')
      if ((await close.count()) > 0) await close.first().click()
      else await targetPage.keyboard.press('Escape')
      await targetPage.waitForTimeout(400)
      if ((await dialog.count()) === 0) return true
      await targetPage.keyboard.press('Escape')
      await targetPage.waitForTimeout(300)
      if ((await dialog.count()) === 0) return true
    }
    await targetPage.waitForTimeout(300)
  }
  return false
}

const groupRows = () => page.locator('[data-testid="session-groups-group"]')
const groupRow = (name) => groupRows().filter({ hasText: name }).first()
const groupRowById = (id) => page.locator(`[data-testid="session-groups-group"][data-group-id="${id}"]`)
const menuItem = (pattern) => page.locator('[role="menuitem"]').filter({ hasText: pattern }).first()

// Arrow-key move/resize reads the dialog's stored rect, so wait until the
// plugin has written one and flagged it with `data-positioned="true"`
// (`dialog-host.js` sets the attribute in the same render as the rect).
const waitForDialogPositioned = async () => {
  await page.waitForFunction(
    () => {
      const dialog = document.querySelector('[data-testid="session-groups-dialog"]')
      return dialog?.getAttribute('data-positioned') === 'true'
    },
    null,
    { timeout: 5000 }
  )
}

// The dialog can auto-focus its own control after the test focuses the titlebar
// or resizer, sending the following arrow keys elsewhere. Re-assert focus a
// bounded number of times; on failure report the element that actually kept it.
const focusAndSettle = async (locator, label) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await locator.focus()
    await page.waitForTimeout(150)
    if (await locator.evaluate((el) => document.activeElement === el)) return
  }
  const active = await page.evaluate(() => {
    const el = document.activeElement
    return el?.getAttribute?.('data-testid') ?? el?.tagName ?? 'none'
  })
  throw new Error(`${label} did not keep focus before the arrow-key check (activeElement=${active})`)
}

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

// ---------------------------------------------------------------------------
// Narrow-viewport floating-panel matrix (SPEC §4/§9.5, plan P8).
//
// Every header surface is a `position: fixed` panel placed by the shared
// floating-panel controller, so each cell proves the four geometry invariants
// against the real viewport: inside the 8px inset (I1), not clipped by a host
// ancestor (I2: four hit tests 3px inside each edge), readable without
// horizontal scrolling (I3) and above the bottom inset (I7). The tiers follow
// the spec: all five surfaces (A), the two wide-coverage surfaces plus the
// compact flags (B), focus / two-frame / box stability (C) and data-* only
// flags (D); the RTL subset and the row context menu are appended.
//
// The isolated host may collapse its own sidebar into the 56px rail at narrow
// window widths (spec §9.5). Each cell first tries to expand it; a failed
// expansion skips the cell only when its key is listed in
// HOST_RAIL_ALLOWLIST. A green matrix means 0 failures and `skipped` subset of
// the allowlist - never that a skipped geometry passed.
// ---------------------------------------------------------------------------
const HOST_RAIL_ALLOWLIST = new Set(['264x960x600', '420x960x600', '264x823x514', '420x823x514'])
const PANEL_VIEWPORT_PADDING_PX = 8
const PANEL_PROBE_INSET_PX = 3
const PANEL_PLACEMENTS = new Set(['inline-end', 'inline-start', 'flipped', 'clamped'])
const NARROW_SURFACES = {
  running: { trigger: 'session-groups-running-button', popover: 'session-groups-running-popover' },
  blocked: { trigger: 'session-groups-blocked-button', popover: 'session-groups-blocked-popover' },
  unread: { trigger: 'session-groups-unread-button', popover: 'session-groups-unread-popover' },
  'view-options': { trigger: 'session-groups-view-options', popover: 'session-groups-view-options-popover' },
  profile: { trigger: 'session-groups-profile-trigger', popover: 'session-groups-profile-popover' },
}
const ALL_NARROW_SURFACES = ['running', 'blocked', 'unread', 'view-options', 'profile']
const TIER_A_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1152, height: 720 },
  { width: 823, height: 514 },
  { width: 1440, height: 480 },
]
const narrowCellKey = (width, viewport) => `${width}x${viewport.width}x${viewport.height}`
const narrowViewportLabel = (viewport) => `${viewport.width}x${viewport.height}`
const narrowMatrix = { passed: 0, skipped: new Set(), failures: [] }

/** Wait for two animation frames so a layout-effect correction has landed. */
const nextFrame = (targetPage) =>
  targetPage.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )

/** The plugin renders either the groups view or the 56px rail entry. */
const waitForGroupsOrRail = async (targetPage) => {
  await targetPage.waitForFunction(
    () =>
      document.querySelector('[data-testid="session-groups-view"]') !== null ||
      document.querySelector('[data-testid="session-groups-rail"]') !== null,
    null,
    { timeout: 12_000 }
  )
}

/**
 * Persist a sidebar width preference and reload into the groups view.
 *
 * Mirrors the shipped narrow-layout gate: the preference is stored, the page
 * reloads and the host applies the width. A reload that lands in the host rail
 * shape returns without a groups view; the caller decides whether that cell is
 * an allowlisted SKIP. Onboarding is dismissed when it is present, but the
 * helper never waits for a dialog that is already gone.
 */
const setSidebarWidth = async (targetPage, width) => {
  await targetPage.evaluate((value) => localStorage.setItem('dsh-session-grove.width.v1', String(value)), width)
  await targetPage.reload({ waitUntil: 'domcontentloaded' })
  await targetPage.waitForTimeout(1200)
  if ((await targetPage.locator('[role="dialog"][aria-label="Get started"]').count()) > 0) {
    await closeGetStarted(targetPage)
  }
  await waitForGroupsOrRail(targetPage)
  const view = targetPage.locator('[data-testid="session-groups-view"]')
  const rail = targetPage.locator('[data-testid="session-groups-rail"]')
  if ((await view.count()) === 0 && (await rail.count()) === 0) {
    // The workspace view can be the sticky mode across reloads.
    const toggle = targetPage
      .locator('[data-testid="session-groups-workspace-toggle"], [data-testid="session-groups-toggle"]')
      .first()
    if (await toggle.count()) await toggle.click()
    await waitForGroupsOrRail(targetPage)
  }
  if ((await view.count()) === 0) return
  await view.waitFor({ state: 'visible' })
  const onboarding = targetPage.locator('[data-testid="session-groups-onboarding"]')
  if ((await onboarding.count()) !== 0) {
    await targetPage.locator('[data-testid="session-groups-onboarding-dismiss"]').click().catch(() => {})
    await onboarding.waitFor({ state: 'detached' }).catch(() => {})
  }
  await waitForChrome(targetPage)
}

/** Wait until the measured root width reached the committed layout. */
const waitForChrome = async (targetPage) => {
  await targetPage.waitForFunction(
    () => {
      const root = document.querySelector('.dsg-root')
      const width = Number(root?.getAttribute('data-width') ?? '0')
      return Number.isFinite(width) && width > 0
    },
    null,
    { timeout: 8000 }
  )
  await nextFrame(targetPage)
}

/** Wait for one of the additive flags written by the compact-state effect. */
const waitForChromeFlag = async (targetPage, attribute, expected) => {
  await targetPage.waitForFunction(
    ({ attribute, expected }) => document.querySelector('.dsg-root')?.getAttribute(attribute) === expected,
    { attribute, expected },
    { timeout: 8000 }
  )
}

/** Wait until the measured `.dsg-root` width is near the expected value. */
const waitForRootWidth = async (targetPage, expected, tolerance = 8) => {
  await targetPage.waitForFunction(
    ({ expected, tolerance }) => {
      const root = document.querySelector('.dsg-root')
      const width = Number(root?.getAttribute('data-width') ?? '0')
      return width > 0 && Math.abs(width - expected) <= tolerance
    },
    { expected, tolerance },
    { timeout: 8000 }
  )
}

const readChrome = async (targetPage) =>
  targetPage.evaluate(() => {
    const root = document.querySelector('.dsg-root')
    return root
      ? {
          width: Number(root.getAttribute('data-width') ?? '0'),
          narrow: root.getAttribute('data-narrow'),
          collapsed: root.getAttribute('data-title-collapsed'),
        }
      : null
  })

const hasHeaderSurface = async (targetPage) =>
  (await targetPage.locator(`[data-testid="${NARROW_SURFACES.blocked.trigger}"]`).count()) > 0

/** Host controls that reopen a collapsed sidebar (English isolated host). */
const HOST_OPEN_SIDEBAR_SELECTORS = [
  'button[aria-label="Open sidebar"]',
  'button[title="Open sidebar"]',
  '[data-testid="session-groups-rail-expand"]',
]

/**
 * Try to leave the host rail shape. Returns false when the header never
 * renders, which is the only case a matrix cell may SKIP.
 */
const ensureHostSidebar = async (targetPage) => {
  if (await hasHeaderSurface(targetPage)) return true
  for (const selector of HOST_OPEN_SIDEBAR_SELECTORS) {
    const opener = targetPage.locator(selector).first()
    if ((await opener.count()) === 0) continue
    await opener.click({ force: true }).catch(() => {})
    await targetPage.waitForTimeout(800)
    if (await hasHeaderSurface(targetPage)) return true
  }
  return false
}

/**
 * Rail shape contract: no groups root and no header popover trigger at all.
 * The plugin rail entry must still be there, so a boot failure is not silently
 * accepted as a rail SKIP.
 */
const assertRailShape = async (targetPage) => {
  const shape = await targetPage.evaluate(
    (triggers) => ({
      root: document.querySelector('.dsg-root') !== null,
      rail: document.querySelector('[data-testid="session-groups-rail"]') !== null,
      headerTriggers: triggers.filter((id) => document.querySelector(`[data-testid="${id}"]`) !== null),
    }),
    Object.values(NARROW_SURFACES).map((surface) => surface.trigger)
  )
  if (shape.root) throw new Error(`host rail shape kept the groups root: ${JSON.stringify(shape)}`)
  if (!shape.rail) throw new Error(`host rail shape lost the plugin rail entry: ${JSON.stringify(shape)}`)
  if (shape.headerTriggers.length > 0) {
    throw new Error(`host rail shape exposed header popover triggers: ${JSON.stringify(shape.headerTriggers)}`)
  }
}

/** Expanded host sidebar or an allowlisted rail SKIP for this cell. */
const requireExpandedGroupsView = async (key, sidebarWidth = NaN) => {
  if (!(await ensureHostSidebar(page))) {
    await assertRailShape(page)
    if (!HOST_RAIL_ALLOWLIST.has(key)) {
      throw new Error(`host sidebar stayed collapsed outside HOST_RAIL_ALLOWLIST (${key})`)
    }
    narrowMatrix.skipped.add(key)
    console.log(`SKIP(host-rail): ${key}`)
    return false
  }
  if (Number.isFinite(sidebarWidth)) {
    // Wait for the committed layout before the compact flags are trusted: the
    // isolated host insets the plugin root by 12px, so `data-width` settles
    // near `sidebarWidth - 12` after the width controller applied the track.
    await waitForRootWidth(page, sidebarWidth - 12)
    await nextFrame(page)
  }
  return true
}

const surfaceByName = (name) =>
  NARROW_SURFACES[name] ??
  Object.values(NARROW_SURFACES).find((surface) => surface.trigger === name || surface.popover === name) ??
  null

/** Click a trigger and wait for its popover. `name` may be the trigger testid. */
const openSurface = async (targetPage, name) => {
  const surface = surfaceByName(name)
  if (!surface) throw new Error(`unknown floating surface: ${name}`)
  await targetPage.locator(`[data-testid="${surface.trigger}"]`).first().click({ force: true })
  const popover = targetPage.locator(`[data-testid="${surface.popover}"]`)
  await popover.waitFor({ state: 'visible' })
  // The placement effect writes the final style before paint; one frame pair
  // after the panel is visible keeps assertions off the first-paint box.
  await nextFrame(targetPage)
  return popover
}

/** Escape closes every header surface; the panel unmounts. */
const closeSurface = async (targetPage, name) => {
  const surface = surfaceByName(name)
  if (!surface) throw new Error(`unknown floating surface: ${name}`)
  await targetPage.keyboard.press('Escape')
  await targetPage.locator(`[data-testid="${surface.popover}"]`).waitFor({ state: 'detached' })
}

/** Rect, scroll box, placement and the four I2 corner probes of one panel. */
const readPanel = async (targetPage, testid) =>
  targetPage.evaluate(
    ({ testid: panelTestId, inset }) => {
      const panel = document.querySelector(`[data-testid="${panelTestId}"]`)
      if (!panel) return null
      const rect = panel.getBoundingClientRect()
      const style = getComputedStyle(panel)
      const hitsSelf = (x, y) => {
        const node = document.elementFromPoint(x, y)
        return node !== null && (node === panel || panel.contains(node))
      }
      return {
        testid: panelTestId,
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
        viewport: {
          width: window.visualViewport?.width ?? window.innerWidth,
          height: window.visualViewport?.height ?? window.innerHeight,
        },
        corners: {
          topLeft: hitsSelf(rect.left + inset, rect.top + inset),
          topRight: hitsSelf(rect.right - inset, rect.top + inset),
          bottomLeft: hitsSelf(rect.left + inset, rect.bottom - inset),
          bottomRight: hitsSelf(rect.right - inset, rect.bottom - inset),
        },
        scrollWidth: panel.scrollWidth,
        clientWidth: panel.clientWidth,
        scrollHeight: panel.scrollHeight,
        clientHeight: panel.clientHeight,
        overflowY: style.overflowY,
        computedWidth: Number.parseFloat(style.width),
        placement: panel.getAttribute('data-placement'),
        fallback: panel.getAttribute('data-fallback'),
      }
    },
    { testid, inset: PANEL_PROBE_INSET_PX }
  )

/**
 * Assert I1/I2/I3/I7 plus the additive placement contract on one panel.
 *
 * `viewport` is the cell geometry, so a panel measured after a failed resize
 * cannot accidentally pass against a different viewport. The normal path must
 * not carry `data-fallback`; only a simulated host transform may produce it.
 */
const assertPanel = async (targetPage, testid, viewport, { requirePlacement = true } = {}) => {
  const panel = await readPanel(targetPage, testid)
  if (!panel) throw new Error(`${testid} is not mounted`)
  const expected = viewport ?? panel.viewport
  if (Math.abs(panel.viewport.width - expected.width) > 1 || Math.abs(panel.viewport.height - expected.height) > 1) {
    throw new Error(
      `${testid}: viewport ${JSON.stringify(panel.viewport)} does not match the cell ${JSON.stringify(expected)}`
    )
  }
  const rect = panel.rect
  const pad = PANEL_VIEWPORT_PADDING_PX
  if (!(rect.left >= pad && rect.top >= pad && rect.right <= expected.width - pad && rect.bottom <= expected.height - pad)) {
    throw new Error(
      `${testid}: I1 rect ${JSON.stringify(rect)} leaves the ${pad}px viewport inset (viewport ${JSON.stringify(expected)})`
    )
  }
  const missed = Object.entries(panel.corners)
    .filter(([, hit]) => hit !== true)
    .map(([corner]) => corner)
  if (missed.length > 0) {
    throw new Error(`${testid}: I2 hit test missed the panel at ${missed.join(', ')} (rect ${JSON.stringify(rect)})`)
  }
  if (!(panel.scrollWidth <= panel.clientWidth + 1)) {
    throw new Error(`${testid}: I3 horizontal overflow ${panel.scrollWidth} > ${panel.clientWidth} + 1`)
  }
  if (!(rect.bottom <= expected.height - pad)) {
    throw new Error(`${testid}: I7 bottom ${rect.bottom} > ${expected.height - pad} (viewport ${JSON.stringify(expected)})`)
  }
  if (requirePlacement && !PANEL_PLACEMENTS.has(panel.placement)) {
    throw new Error(
      `${testid}: data-placement ${JSON.stringify(panel.placement)} is not one of ${[...PANEL_PLACEMENTS].join('/')}`
    )
  }
  if (panel.fallback !== null) {
    throw new Error(`${testid}: the normal path must not record data-fallback (got ${panel.fallback})`)
  }
  return panel
}

/** Open, assert and close one surface, keeping the trigger rect for mirror checks. */
const measureSurface = async (targetPage, name, viewport) => {
  const surface = surfaceByName(name)
  if (!surface) throw new Error(`unknown floating surface: ${name}`)
  await openSurface(targetPage, name)
  const panel = await assertPanel(targetPage, surface.popover, viewport)
  const trigger = await targetPage.evaluate((testid) => {
    const element = document.querySelector(`[data-testid="${testid}"]`)
    const rect = element?.getBoundingClientRect()
    return rect
      ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
      : null
  }, surface.trigger)
  await closeSurface(targetPage, name)
  if (!trigger) throw new Error(`${surface.trigger} is not mounted`)
  return { panel, trigger }
}

const resizeHandle = (targetPage) => targetPage.locator('[data-testid="session-groups-resize-handle"]').first()

/**
 * Reset the width through the handle's real double-click handler (264 -> 420).
 *
 * A synthetic `dblclick` is dispatched because the handle calls
 * `preventDefault()` on pointerdown, which suppresses the compatibility
 * mousedown/click/dblclick sequence a real double-click would need.
 */
const resetSidebarWidth = async (targetPage) => {
  const handle = resizeHandle(targetPage)
  await handle.waitFor({ state: 'visible' })
  await handle.evaluate((element) => {
    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  })
  await targetPage.waitForFunction(
    () => document.querySelector('[data-testid="session-groups-resize-handle"]')?.getAttribute('aria-valuenow') === '420',
    null,
    { timeout: 6000 }
  )
  await waitForChrome(targetPage)
}

/** Keyboard-resize the sidebar exactly to `target` (16px per arrow press). */
const stepSidebarWidthTo = async (targetPage, target) => {
  const handle = resizeHandle(targetPage)
  await handle.focus()
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = Number(await handle.getAttribute('aria-valuenow'))
    if (current === target) {
      await waitForChrome(targetPage)
      return
    }
    const expected = current > target ? Math.max(target, current - 16) : Math.min(target, current + 16)
    await targetPage.keyboard.press(current > target ? 'ArrowLeft' : 'ArrowRight')
    await targetPage.waitForFunction(
      (value) =>
        Number(document.querySelector('[data-testid="session-groups-resize-handle"]')?.getAttribute('aria-valuenow')) ===
        value,
      expected,
      { timeout: 2000 }
    )
  }
  throw new Error(`sidebar keyboard resize did not reach ${target}px`)
}

/** Run one matrix cell; failures are collected so every cell still reports. */
const runNarrowCell = async (label, body) => {
  try {
    const outcome = await body()
    if (outcome === 'skip') return
    narrowMatrix.passed += 1
    console.log(`PASS(narrow): ${label}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    narrowMatrix.failures.push({ label, message })
    console.error(`FAIL(narrow): ${label}: ${message}`)
    await page
      .screenshot({
        path: `${testHome}/narrow-failure-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`,
      })
      .catch(() => {})
  }
}

/** Set the viewport, persist the sidebar width and re-enter the groups view. */
const prepareMatrixCell = async (targetPage, width, viewport) => {
  await targetPage.setViewportSize({ width: viewport.width, height: viewport.height })
  await setSidebarWidth(targetPage, width)
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

  // If the app opens on the shipped workspace view, the one-time entry hint (or
  // the overlay toggle as a fallback) takes it into the groups view.
  if ((await groupView.count()) === 0) {
    const entryHint = page.locator('[data-testid="session-groups-workspace-entry-hint"]')
    let hintVisible = false
    try {
      await entryHint.waitFor({ state: 'visible', timeout: 3000 })
      hintVisible = true
    } catch {
      hintVisible = false
    }
    if (hintVisible) {
      const entryTitle = (await page.locator('.dsg-entry-hint-title').innerText()).trim()
      if (entryTitle !== 'Free Groups is ready') {
        throw new Error(`English host rendered a non-English entry hint: ${entryTitle}`)
      }
      const hintDocsHref = await page.locator('[data-testid="session-groups-workspace-entry-hint-docs"]').getAttribute('href')
      if (hintDocsHref !== 'https://momijijin.github.io/dsh-session-grove-docs-site/') {
        throw new Error(`entry hint docs link unexpected: ${hintDocsHref}`)
      }
      await page.locator('[data-testid="session-groups-workspace-entry-hint-primary"]').click()
    } else {
      const toggle = page.locator('[data-testid="session-groups-workspace-toggle"], [data-testid="session-groups-toggle"]').first()
      if ((await toggle.count()) === 0) {
        console.error(`plugin test ids: ${JSON.stringify(await page.locator('[data-testid^="session-groups"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid'))))}`)
        await screenshot()
        throw new Error('session groups view/toggle missing; check isolated profile boot')
      }
      await toggle.click()
    }
  }
  await groupView.waitFor({ state: 'visible' })
  if ((await page.locator('[data-testid="session-groups-workspace-entry-hint"]').count()) !== 0) {
    throw new Error('entry hint did not retire after entering the groups view')
  }

  const onboarding = page.locator('[data-testid="session-groups-onboarding"]')
  await onboarding.waitFor({ state: 'visible' })
  const onboardingTitle = (await page.locator('.dsg-onboarding-title').innerText()).trim()
  if (onboardingTitle !== 'Free Groups') {
    throw new Error(`English host rendered a non-English onboarding title: ${onboardingTitle}`)
  }
  const docsHref = await page.locator('[data-testid="session-groups-onboarding-docs"]').getAttribute('href')
  if (docsHref !== 'https://momijijin.github.io/dsh-session-grove-docs-site/') {
    throw new Error(`onboarding docs link unexpected: ${docsHref}`)
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
  await waitForDialogPositioned()
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
  await focusAndSettle(keyboardTitlebar, 'dialog titlebar')
  const beforeMove = await a11yDialog.boundingBox()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(120)
  const afterMove = await a11yDialog.boundingBox()
  if (!beforeMove || !afterMove || afterMove.x <= beforeMove.x) throw new Error('keyboard dialog move did not move right')
  const keyboardResizer = page.locator('[data-testid="session-groups-dialog-resizer"]')
  await focusAndSettle(keyboardResizer, 'dialog resizer')
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

  // 0.4.0-beta.65 S7: a row menu must survive a scroll from an unrelated
  // scroller (the streaming conversation area), but a scroll of its own tree
  // still dismisses it. Dispatch the non-bubbling event directly: the menu
  // listens in the document capture phase, exactly like a real scroller event.
  await groupRowById(targetId).locator('[data-testid="session-groups-group-menu"]').click({ force: true })
  const scrollMenu = page.locator('[data-testid="session-groups-menu"]')
  await scrollMenu.waitFor({ state: 'visible' })
  const scrollProbeId = `dsg-scroll-probe-${Date.now().toString(36)}`
  await page.evaluate((probeId) => {
    const probe = document.createElement('div')
    probe.setAttribute('data-testid', probeId)
    probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px'
    document.body.appendChild(probe)
    probe.dispatchEvent(new Event('scroll'))
  }, scrollProbeId)
  try {
    await nextFrame(page)
    if (!(await scrollMenu.isVisible())) throw new Error('an unrelated scroll closed the group menu')
    await page.evaluate(() => {
      const tree = document.querySelector('.dsg-tree')
      if (!tree) throw new Error('groups tree is missing')
      tree.dispatchEvent(new Event('scroll'))
    })
    await scrollMenu.waitFor({ state: 'hidden' })
  } finally {
    await page.evaluate((probeId) => document.querySelector(`[data-testid="${probeId}"]`)?.remove(), scrollProbeId)
  }

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

  // -------------------------------------------------------------------------
  // Narrow-viewport floating-panel matrix (SPEC §4/§9.5, plan P8).
  //
  // Tier A: all five surfaces x sidebar {264,420} x viewport {1440x900,
  // 1152x720 (125%), 823x514 (175%), 1440x480 (short)}; I1/I2/I3/I7 + one
  // screenshot per surface. Tier B: blocked + view-options x {320,340,380} x
  // {1440x900,1152x720} and x {264,420} x {1280x800,960x600,1280x400}, with
  // the compact-state flags. Tier C: focus return, two-frame stability, exact
  // outer width at {264,420}x1440x900, plus a 1440x480 short-viewport sub-cell
  // that forces the view-options panel to overflow and scroll (A12). Tier D:
  // data-* only at {280,300,360}x1440x900 plus the two live re-expands from 264.
  // The menu cell seeds a >40-char group name before opening the row menu; the
  // fixed i18n menu labels never reach the 360px cap in English, so the long
  // user label also pins the row's single-line ellipsis + title contract.
  // -------------------------------------------------------------------------
  // Each matrix cell reloads the page, which boots the default light theme, so
  // the screenshots below document the appearance users see out of the box;
  // the theme gate's dark attribute is restored after the cleanup.
  for (const width of [264, 420]) {
    for (const viewport of TIER_A_VIEWPORTS) {
      const key = narrowCellKey(width, viewport)
      await runNarrowCell(`Tier A ${width}/${narrowViewportLabel(viewport)}`, async () => {
        await prepareMatrixCell(page, width, viewport)
        if (!(await requireExpandedGroupsView(key, width))) return 'skip'
        await waitForChromeFlag(page, 'data-narrow', width === 264 ? 'true' : 'false')
        for (const name of ALL_NARROW_SURFACES) {
          const surface = NARROW_SURFACES[name]
          await openSurface(page, name)
          const panel = await assertPanel(page, surface.popover, viewport)
          await page.screenshot({
            path: `${testHome}/narrow-${width}-${narrowViewportLabel(viewport)}-${name}.png`,
          })
          await closeSurface(page, name)
          console.log(
            `narrow panel: ${width}/${narrowViewportLabel(viewport)} ${name} ` +
              `${panel.placement} ${Math.round(panel.rect.width)}x${Math.round(panel.rect.height)}`
          )
        }
      })
    }
  }

  const tierBGrid = [
    ...[320, 340, 380].flatMap((width) => [
      { width, viewport: { width: 1440, height: 900 } },
      { width, viewport: { width: 1152, height: 720 } },
    ]),
    ...[264, 420].flatMap((width) => [
      { width, viewport: { width: 1280, height: 800 } },
      { width, viewport: { width: 960, height: 600 } },
      { width, viewport: { width: 1280, height: 400 } },
    ]),
  ]
  for (const cell of tierBGrid) {
    const key = narrowCellKey(cell.width, cell.viewport)
    await runNarrowCell(`Tier B ${cell.width}/${narrowViewportLabel(cell.viewport)}`, async () => {
      await prepareMatrixCell(page, cell.width, cell.viewport)
      if (!(await requireExpandedGroupsView(key, cell.width))) return 'skip'
      // 264 is already in the compact state; 320/340/380 are compact but keep
      // the full label; 420 leaves the compact state entirely (spec §6.6).
      await waitForChromeFlag(page, 'data-narrow', cell.width === 420 ? 'false' : 'true')
      await waitForChromeFlag(page, 'data-title-collapsed', cell.width === 264 ? 'true' : 'false')
      const chrome = await readChrome(page)
      for (const name of ['blocked', 'view-options']) {
        const surface = NARROW_SURFACES[name]
        await openSurface(page, name)
        await assertPanel(page, surface.popover, cell.viewport)
        await page.screenshot({
          path: `${testHome}/narrow-${cell.width}-${narrowViewportLabel(cell.viewport)}-${name}.png`,
        })
        await closeSurface(page, name)
      }
      console.log(`narrow chrome: ${key} ${JSON.stringify(chrome)}`)
    })
  }

  for (const width of [264, 420]) {
    const viewport = { width: 1440, height: 900 }
    const key = narrowCellKey(width, viewport)
    await runNarrowCell(`Tier C ${width}/${narrowViewportLabel(viewport)}`, async () => {
      await prepareMatrixCell(page, width, viewport)
      if (!(await requireExpandedGroupsView(key, width))) return 'skip'
      for (const name of ALL_NARROW_SURFACES) {
        const surface = NARROW_SURFACES[name]
        await openSurface(page, name)
        await assertPanel(page, surface.popover, viewport)
        // I5: the layout effect may correct once before paint; two frame pairs
        // after the panel is visible must report the same rect.
        await nextFrame(page)
        const first = await readPanel(page, surface.popover)
        await nextFrame(page)
        const second = await readPanel(page, surface.popover)
        if (!first || !second) throw new Error(`${name}: panel disappeared during the two-frame check`)
        for (const edge of ['left', 'top', 'right', 'bottom', 'width', 'height']) {
          if (Math.abs(first.rect[edge] - second.rect[edge]) > 1) {
            throw new Error(`${name}: I5 rect.${edge} moved ${first.rect[edge]} -> ${second.rect[edge]}`)
          }
        }
        // A12: the outer box equals the computed border-box width, so a
        // measured width can never grow by the panel's own padding/border.
        if (!(first.rect.width === first.computedWidth)) {
          throw new Error(`${name}: A12 outer width ${first.rect.width} != computed width ${first.computedWidth}`)
        }
        if (first.scrollHeight > first.clientHeight + 1 && !['auto', 'scroll'].includes(first.overflowY)) {
          throw new Error(`${name}: overflowing panel is not scrollable (overflow-y: ${first.overflowY})`)
        }
        await closeSurface(page, name)
        // I4/A13: Escape closes and returns focus to the trigger.
        await page.waitForFunction(
          (testid) => document.activeElement?.getAttribute?.('data-testid') === testid,
          surface.trigger,
          { timeout: 4000 }
        )
      }
    })
  }

  // Tier C short-viewport sub-cell (SPEC §4 "短视口", A12). At 1440×480 the
  // view-options trigger sits near y=225, so the panel's top lands near 242 and
  // the controller caps it to the ~230px left above the 8px inset while its
  // content is ~400px tall. That is the geometry where A12's overflow branch is
  // reachable: the 1440×900 Tier C cells above fit their content, so the old
  // conditional check there could never run. The panel must scroll internally
  // instead of clipping, and a real scrollTop write must land above 0.
  for (const width of [264, 420]) {
    const viewport = { width: 1440, height: 480 }
    const key = narrowCellKey(width, viewport)
    await runNarrowCell(`Tier C short ${width}/${narrowViewportLabel(viewport)}`, async () => {
      await prepareMatrixCell(page, width, viewport)
      if (!(await requireExpandedGroupsView(key, width))) return 'skip'
      const surface = NARROW_SURFACES['view-options']
      await openSurface(page, 'view-options')
      const panel = await assertPanel(page, surface.popover, viewport)
      const scroll = await page.evaluate(
        (testid) => {
          const element = document.querySelector(`[data-testid="${testid}"]`)
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          const before = element.scrollTop
          element.scrollTop = 9999
          return {
            rect: { top: rect.top, height: rect.height },
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
            overflowY: style.overflowY,
            before,
            after: element.scrollTop,
          }
        },
        surface.popover
      )
      if (!(panel.rect.height < scroll.scrollHeight)) {
        throw new Error(`A12: panel box ${panel.rect.height} is not shorter than its content ${scroll.scrollHeight}`)
      }
      if (!(scroll.scrollHeight > scroll.clientHeight + 1)) {
        throw new Error(`A12: view-options does not overflow at 1440x480: ${JSON.stringify(scroll)}`)
      }
      if (!['auto', 'scroll'].includes(scroll.overflowY)) {
        throw new Error(`A12: view-options is not scrollable at 1440x480: overflow-y ${scroll.overflowY}`)
      }
      if (!(scroll.after > 0)) {
        throw new Error(`A12: view-options scrollTop stayed ${scroll.after} after writing 9999: ${JSON.stringify(scroll)}`)
      }
      await page.screenshot({ path: `${testHome}/narrow-${width}-1440x480-view-options-scroll.png` })
      await closeSurface(page, 'view-options')
      console.log(
        `narrow A12 scroll: ${key} ${Math.round(scroll.scrollHeight)}>${Math.round(scroll.clientHeight)} ` +
          `top=${Math.round(scroll.rect.top)} h=${Math.round(scroll.rect.height)} scrollTop=${Math.round(scroll.after)}`
      )
    })
  }

  for (const cell of [
    { width: 280, collapsed: 'true' },
    { width: 300, collapsed: 'true' },
    { width: 360, collapsed: 'false' },
  ]) {
    const viewport = { width: 1440, height: 900 }
    const key = narrowCellKey(cell.width, viewport)
    await runNarrowCell(`Tier D ${key}`, async () => {
      await prepareMatrixCell(page, cell.width, viewport)
      if (!(await requireExpandedGroupsView(key, cell.width))) return 'skip'
      await waitForChromeFlag(page, 'data-narrow', 'true')
      await waitForChromeFlag(page, 'data-title-collapsed', cell.collapsed)
      console.log(`narrow chrome: ${key} ${JSON.stringify(await readChrome(page))}`)
    })
  }
  await runNarrowCell('Tier D re-expand 264/1440x900', async () => {
    const viewport = { width: 1440, height: 900 }
    const key = narrowCellKey(264, viewport)
    await prepareMatrixCell(page, 264, viewport)
    if (!(await requireExpandedGroupsView(key, 264))) return 'skip'
    await waitForChromeFlag(page, 'data-narrow', 'true')
    await waitForChromeFlag(page, 'data-title-collapsed', 'true')
    // 264 -> 420 through the handle's reset path.
    await resetSidebarWidth(page)
    await waitForRootWidth(page, 408)
    await waitForChromeFlag(page, 'data-title-collapsed', 'false')
    // 420 -> 340 (keyboard) -> 420 (reset): the flag must not self-lock after
    // the label was hidden once (spec §6.6 / A6).
    await stepSidebarWidthTo(page, 340)
    await waitForRootWidth(page, 328)
    await waitForChromeFlag(page, 'data-narrow', 'true')
    await waitForChromeFlag(page, 'data-title-collapsed', 'false')
    await resetSidebarWidth(page)
    await waitForRootWidth(page, 408)
    await waitForChromeFlag(page, 'data-narrow', 'false')
    await waitForChromeFlag(page, 'data-title-collapsed', 'false')
  })

  await runNarrowCell('RTL 264/1440x900', async () => {
    const viewport = { width: 1440, height: 900 }
    await prepareMatrixCell(page, 264, viewport)
    if (!(await requireExpandedGroupsView(narrowCellKey(264, viewport), 264))) return 'skip'
    const ltrProfile = await measureSurface(page, 'profile', viewport)
    const ltrBlocked = await measureSurface(page, 'blocked', viewport)
    // The hook resolves the direction from the panel's nearest `[dir]`
    // ancestor, so flipping `.dsg-root` exercises the real RTL path.
    await page.evaluate(() => document.querySelector('.dsg-root')?.setAttribute('dir', 'rtl'))
    const rtlProfile = await measureSurface(page, 'profile', viewport)
    const rtlBlocked = await measureSurface(page, 'blocked', viewport)
    await openSurface(page, 'profile')
    await page.screenshot({ path: `${testHome}/narrow-264-1440x900-rtl-profile.png` })
    await closeSurface(page, 'profile')
    await openSurface(page, 'blocked')
    await page.screenshot({ path: `${testHome}/narrow-264-1440x900-rtl-blocked.png` })
    await closeSurface(page, 'blocked')
    // The profile panel is `inline-start`: LTR aligns its left edge to the
    // trigger's left, RTL must mirror that to the trigger's right edge. The
    // status panel is `inline-end`: in LTR the right edge overflows the
    // viewport and flips to the trigger's left, while in RTL the logical end is
    // already the physical left. Both tokens are recorded, not inferred.
    if (ltrProfile.panel.placement !== 'inline-start' || rtlProfile.panel.placement !== 'inline-start') {
      throw new Error(
        `profile popover placement must stay inline-start on both directions: ` +
          `LTR ${ltrProfile.panel.placement}, RTL ${rtlProfile.panel.placement}`
      )
    }
    if (Math.abs(ltrProfile.panel.rect.left - ltrProfile.trigger.left) > 1) {
      throw new Error(
        `LTR profile popover is not aligned to the trigger's left edge: ` +
          `${ltrProfile.panel.rect.left} vs ${ltrProfile.trigger.left}`
      )
    }
    if (Math.abs(rtlProfile.panel.rect.right - rtlProfile.trigger.right) > 1) {
      throw new Error(
        `RTL profile popover is not mirrored to the trigger's right edge: ` +
          `${rtlProfile.panel.rect.right} vs ${rtlProfile.trigger.right}`
      )
    }
    if (ltrBlocked.panel.placement !== 'flipped') {
      throw new Error(`LTR blocked popover placement ${ltrBlocked.panel.placement} != flipped`)
    }
    if (rtlBlocked.panel.placement !== 'inline-end') {
      throw new Error(`RTL blocked popover placement ${rtlBlocked.panel.placement} != inline-end`)
    }
    console.log(
      `narrow RTL: profile ${ltrProfile.panel.placement} ` +
        `[${Math.round(ltrProfile.panel.rect.left)}..${Math.round(ltrProfile.panel.rect.right)}] -> ` +
        `${rtlProfile.panel.placement} ` +
        `[${Math.round(rtlProfile.panel.rect.left)}..${Math.round(rtlProfile.panel.rect.right)}], blocked ` +
        `${ltrBlocked.panel.placement} -> ${rtlBlocked.panel.placement}`
    )
  })

  await runNarrowCell('menu 264/800x600 long label', async () => {
    const viewport = { width: 800, height: 600 }
    await prepareMatrixCell(page, 264, viewport)
    if (!(await requireExpandedGroupsView(narrowCellKey(264, viewport), 264))) return 'skip'
    // Seed the one user-controlled label that wants more room than the menu
    // allows: a group name far beyond 40 characters. The menu's own labels are
    // fixed i18n strings, so this is what a row-anchored surface can stress.
    const stamp = Date.now().toString(36).slice(-4)
    const longName = `很长的分组名称用于验证菜单宽度上限与省略号行为，并留下充分的运行时截断证据——${stamp}`
    if ([...longName].length < 40) throw new Error(`menu seed name is shorter than 40 chars: ${[...longName].length}`)
    const longGroupId = await createGroup(longName)
    const row = groupRowById(longGroupId)
    await row.waitFor({ state: 'visible' })
    const rowLabel = await row.evaluate((element) => {
      const label = element.querySelector('.dsg-group-name')
      const style = label ? getComputedStyle(label) : null
      return label && style
        ? {
            text: (label.textContent ?? '').trim(),
            title: element.getAttribute('title') ?? '',
            scrollWidth: label.scrollWidth,
            clientWidth: label.clientWidth,
            overflow: style.overflow,
            textOverflow: style.textOverflow,
            whiteSpace: style.whiteSpace,
          }
        : null
    })
    if (!rowLabel) throw new Error('long group row has no .dsg-group-name label')
    if (!rowLabel.title.includes(longName)) {
      throw new Error(`long group row lost the full name in title: ${JSON.stringify(rowLabel)}`)
    }
    if (!(rowLabel.scrollWidth > rowLabel.clientWidth + 1)) {
      throw new Error(`long group row label is not truncated: ${JSON.stringify(rowLabel)}`)
    }
    if (rowLabel.overflow !== 'hidden' || rowLabel.textOverflow !== 'ellipsis' || rowLabel.whiteSpace !== 'nowrap') {
      throw new Error(`long group row label is not a single-line ellipsis: ${JSON.stringify(rowLabel)}`)
    }

    // The seeded row is appended at the end of the tree, so bring it into view
    // before opening the menu: the menu closes on scroll, and a click-time
    // auto-scroll would otherwise dismiss it right after mount.
    await row.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await row.click({ button: 'right', position: { x: 24, y: 12 } })
    const menu = page.locator('[data-testid="session-groups-menu"]')
    await menu.waitFor({ state: 'visible' })
    await nextFrame(page)
    const panel = await assertPanel(page, 'session-groups-menu', viewport, { requirePlacement: false })
    const widthLimit = Math.min(360, viewport.width - PANEL_VIEWPORT_PADDING_PX * 2)
    if (!(panel.rect.width <= widthLimit)) {
      throw new Error(`menu width ${panel.rect.width} exceeds min(360, innerWidth-16)=${widthLimit}`)
    }
    const box = await page.evaluate((testid) => {
      const element = document.querySelector(`[data-testid="${testid}"]`)
      const style = getComputedStyle(element)
      return {
        boxSizing: style.boxSizing,
        maxWidth: style.maxWidth,
        overflowY: style.overflowY,
        items: Array.from(element.querySelectorAll('[role="menuitem"]')).map((item) => {
          const label = item.querySelector('.dsg-menu-item-label')
          const labelStyle = label ? getComputedStyle(label) : null
          return {
            text: (label?.textContent ?? item.textContent ?? '').trim(),
            title: item.getAttribute('title') ?? '',
            labelScrollWidth: label ? label.scrollWidth : null,
            labelClientWidth: label ? label.clientWidth : null,
            minWidth: labelStyle?.minWidth ?? null,
            overflow: labelStyle?.overflow ?? null,
            textOverflow: labelStyle?.textOverflow ?? null,
            whiteSpace: labelStyle?.whiteSpace ?? null,
          }
        }),
      }
    }, 'session-groups-menu')
    if (box.boxSizing !== 'border-box') throw new Error(`menu box-sizing is ${box.boxSizing}, expected border-box`)
    if (box.maxWidth !== `${widthLimit}px`) {
      throw new Error(`menu computed max-width ${box.maxWidth} != ${widthLimit}px (A7 cap)`)
    }
    if (box.items.length === 0) throw new Error('menu rendered no items')
    for (const item of box.items) {
      if (!item.title) throw new Error(`menu item ${item.text} has no title`)
      if (item.labelScrollWidth === null) throw new Error(`menu item ${item.text} has no .dsg-menu-item-label span`)
      if (item.minWidth !== '0px' || item.overflow !== 'hidden' || item.textOverflow !== 'ellipsis' || item.whiteSpace !== 'nowrap') {
        throw new Error(`menu item ${item.text} does not carry the single-line ellipsis rule: ${JSON.stringify(item)}`)
      }
    }
    // A7's truncation path is only reachable when a label wants more than the
    // cap; the English menu is content-sized well below it, so record the
    // longest row instead of pretending it clipped. The long group row above
    // proves the same single-line ellipsis + title contract with real overflow.
    const widest = box.items.reduce((left, right) =>
      left.labelScrollWidth >= right.labelScrollWidth ? left : right
    )
    await page.screenshot({ path: `${testHome}/narrow-264-800x600-menu-long-label.png` })
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    console.log(
      `narrow menu: 264/800x600 width=${Math.round(panel.rect.width)}<=${widthLimit} ` +
        `${box.items.length} items, widest "${widest.text}" ${widest.labelScrollWidth}px, ` +
        `row label ${rowLabel.scrollWidth}>${rowLabel.clientWidth}px`
    )
  })

  // The later sections (the profile-preview geometry gate in particular) still
  // assume the 1280x900 / 264px narrow layout from the gate above.
  await page.setViewportSize({ width: 1280, height: 900 })
  await setSidebarWidth(page, 264)
  if (!(await ensureHostSidebar(page))) throw new Error('narrow matrix cleanup could not restore the groups view')
  await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))

  const unexpectedSkips = [...narrowMatrix.skipped].filter((key) => !HOST_RAIL_ALLOWLIST.has(key))
  if (narrowMatrix.failures.length > 0 || unexpectedSkips.length > 0) {
    throw new Error(
      `narrow matrix: ${narrowMatrix.failures.length} failure(s), ${unexpectedSkips.length} unexpected skip(s): ` +
        JSON.stringify({ failures: narrowMatrix.failures, unexpectedSkips })
    )
  }
  if ([...HOST_RAIL_ALLOWLIST].every((key) => narrowMatrix.skipped.has(key))) {
    console.log(
      'SKIP(host-rail): 150%/175% 缩放在隔离宿主上因 rail 形态不可达，侧栏浮层在该形态下不存在；' +
        '该维度由 1152×720（125% 等效）与 1440×480/1280×400（短视口）覆盖。'
    )
  }
  console.log(
    `narrow matrix: ${narrowMatrix.passed} pass, ${narrowMatrix.skipped.size} skip (allowlist), 0 failure`
  )

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
  if ((await page.locator('[data-testid="session-groups-workspace-entry-hint"]').count()) !== 0) {
    throw new Error('entry hint reappeared after the first groups visit')
  }
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

  console.log('PASS: isolated onboarding, search, archive filter, drag auto-expand, group edges, dialog geometry, status buttons, head insertion, collapse/expand, 264px, narrow floating-panel matrix (Tier A/B/C/D, RTL subset, menu, host-rail allowlist), dark, host rail, external SSE refresh, workspace round-trip refresh, rapid revision convergence, multi-window SSE, concurrent CAS, forced reconnect, profiles (save-as, preview, undo, rename/archive, dual-window active/409, scoped collapse, limit 20), preview geometry (SPEC §8.1), session actions, clipboard copy, search, first-layer settings, localized title, option details, live diagnostics HUD, switch interaction and destructive confirmation')
} catch (error) {
  await screenshot()
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
}





