#!/usr/bin/env node
/**
 * Locale switch smoke for every packaged dictionary.
 *
 * The test-only locale pack adds all packaged languages to the host catalog
 * (the plugin itself does not call addLanguage). This spec switches the host
 * locale through that pack and verifies the plugin header, new-group dialog,
 * group menu, profile popover and profile switch-preview copy for each
 * language, including zh-TW and pt-BR aliases.
 */
import { chromium } from 'playwright'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

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
if (!existsSync(testHome)) fail(`test home does not exist: ${testHome}`)
// This spec saves and commits named profiles, so it must never attach to the
// live DSH host or the real home. Guard before the browser launches and before
// any profile write below.
let url
try {
  url = new URL(urlText)
} catch {
  fail(`invalid DSH_TEST_URL: ${urlText}`)
}
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) fail(`test URL must be loopback: ${url.origin}`)
if (url.port === '43120') fail('refusing the real DSH web port 43120')

const dictionaries = Object.fromEntries(
  ['en', 'zh', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'it', 'nl', 'pl', 'tr', 'vi', 'th', 'id', 'ru', 'hi', 'ar'].map(
    (id) => [id, JSON.parse(readFileSync(new URL(`../locale/${id}.json`, import.meta.url), 'utf8'))],
  ),
)
const cases = [
  ['en', 'en'],
  ['zh', 'zh'],
  ['zh-Hant', 'zh-Hant'],
  ['zh-TW', 'zh-Hant'],
  ['zh-HK', 'zh-Hant'],
  ['zh-CN', 'zh'],
  ['ja', 'ja'],
  ['ko', 'ko'],
  ['de', 'de'],
  ['fr', 'fr'],
  ['es', 'es'],
  ['pt', 'pt'],
  ['pt-BR', 'pt'],
  ['it', 'it'],
  ['nl', 'nl'],
  ['pl', 'pl'],
  ['tr', 'tr'],
  ['vi', 'vi'],
  ['th', 'th'],
  ['id', 'id'],
  ['ru', 'ru'],
  ['hi', 'hi'],
  ['ar', 'ar'],
]

const browser = await chromium.launch({
  headless: true,
  executablePath: (() => {
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    const root = resolve(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
    if (!existsSync(root)) return undefined
    const candidates = readdirSync(root).filter((name) => name.startsWith('chromium-')).sort().reverse()
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

const dismissOverlays = async () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const blocked = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'))
      for (const dialog of dialogs) {
        const button = Array.from(dialog.querySelectorAll('button')).find((candidate) =>
          /^(Continue|继续|続行|OK|Got it)$/i.test((candidate.textContent ?? '').trim()),
        )
        if (button) button.click()
        else dialog.querySelector('button[aria-label="Close"]')?.click()
      }
      const mask = document.querySelector('[class*="_mask_"]')
      if (dialogs.length === 0 && mask === null) return false
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return true
    })
    if (!blocked) return
    await page.waitForTimeout(350)
  }
}

try {
  await page.goto(urlText, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  await dismissOverlays()
  await page.waitForFunction(() => typeof globalThis.__DSH_E2E_SET_LOCALE__ === 'function')

  const groupView = page.locator('[data-testid="session-groups-view"]')
  if ((await groupView.count()) === 0) {
    await dismissOverlays()
    const toggle = page.locator('[data-testid="session-groups-workspace-toggle"], [data-testid="session-groups-toggle"]').first()
    if (await toggle.count()) await toggle.click({ force: true })
  }
  await groupView.waitFor({ state: 'visible' })
  const onboarding = page.locator('[data-testid="session-groups-onboarding"]')
  if (await onboarding.count()) {
    await page.locator('[data-testid="session-groups-onboarding-dismiss"]').click()
    await onboarding.waitFor({ state: 'detached' })
  }

  // One real group is enough to exercise the localized group menu in every
  // language; group names themselves are user data and intentionally untranslated.
  const groupMenuButton = page.locator('[data-testid="session-groups-group-menu"]')
  if ((await groupMenuButton.count()) === 0) {
    await page.locator('[data-testid="session-groups-new-group"]').click()
    const createDialog = page.locator('[data-testid="session-groups-dialog"]')
    await createDialog.waitFor({ state: 'visible' })
    await page.locator('[data-testid="session-groups-dialog-input"]').fill('Locale QA')
    await page.locator('[data-testid="session-groups-dialog-confirm"]').click()
    await createDialog.waitFor({ state: 'hidden' })
    await groupMenuButton.first().waitFor({ state: 'visible' })
  }

  // The profile surfaces (SPEC §9.1-§9.3) are localized too. Create one profile
  // with a structural difference, then return to default so every locale can
  // open the switch preview from the same starting document. The profile name
  // is user data and stays untranslated.
  const profileName = `Locale profile ${Date.now()}`
  const previewProfileId = await page.evaluate(async (name) => {
    const list = await fetch('/dsh-session-grove/profiles').then((response) => response.json())
    const created = await fetch('/dsh-session-grove/profiles/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: list.registryRevision, name }),
    }).then((response) => response.json())
    if (created.ok !== true) throw new Error(`profile create failed: ${JSON.stringify(created)}`)
    const loaded = await fetch('/dsh-session-grove/load').then((response) => response.json())
    const doc = loaded.doc
    if (!Array.isArray(doc?.groups) || doc.groups.length === 0) {
      throw new Error('no group available for the profile preview fixture')
    }
    doc.groups[0].name = 'Locale preview group'
    const commit = await fetch('/dsh-session-grove/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: loaded.profileId, baseRevision: loaded.revision, doc }),
    })
    if (!commit.ok) {
      throw new Error(`profile commit failed: ${commit.status} ${JSON.stringify(await commit.json())}`)
    }
    const preview = await fetch('/dsh-session-grove/profiles/preview?id=default').then((response) => response.json())
    const activated = await fetch('/dsh-session-grove/profiles/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'default', previewToken: preview.previewToken }),
    }).then((response) => response.json())
    if (activated.ok !== true) throw new Error(`restore default failed: ${JSON.stringify(activated)}`)
    return created.profile.id
  }, profileName)

  for (const [localeId, dictionaryId] of cases) {
    await page.evaluate((id) => globalThis.__DSH_E2E_SET_LOCALE__(id), localeId)
    await page.waitForFunction((id) => globalThis.__DSH_E2E_GET_LOCALE__?.().active === id, localeId)
    const expectedTitle = dictionaries[dictionaryId]['view.title']
    await page.waitForFunction((expected) => {
      const label = document.querySelector('.dsg-header-label')
      return label?.textContent?.trim() === expected
    }, expectedTitle)
    const expectedDirection = localeId === 'ar' ? 'rtl' : 'ltr'
    const actualDirection = await page.locator('[data-testid="session-groups-view"]').getAttribute('dir')
    if (actualDirection !== expectedDirection) {
      throw new Error(`${localeId}: direction ${actualDirection} != ${expectedDirection}`)
    }

    await page.locator('[data-testid="session-groups-new-group"]').click()
    const dialog = page.locator('[data-testid="session-groups-dialog"]')
    await dialog.waitFor({ state: 'visible' })
    const labelledBy = await dialog.getAttribute('aria-labelledby')
    const expectedDialogTitle = dictionaries[dictionaryId]['dialog.newGroup']
    await page.waitForFunction(
      (expected) => document.querySelector('#dsg-dialog-title')?.textContent?.trim() === expected,
      expectedDialogTitle,
      { timeout: 5000 },
    )
    const actualDialogTitle = labelledBy ? (await page.locator(`#${labelledBy}`).innerText()).trim() : ''
    if (actualDialogTitle !== expectedDialogTitle) {
      throw new Error(`${localeId}: dialog title ${JSON.stringify(actualDialogTitle)} != ${JSON.stringify(expectedDialogTitle)}`)
    }
    const dialogPlaceholder = await page.locator('[data-testid="session-groups-dialog-input"]').getAttribute('placeholder')
    const dialogCancel = (await page.locator('[data-testid="session-groups-dialog-cancel"]').innerText()).trim()
    const dialogConfirm = (await page.locator('[data-testid="session-groups-dialog-confirm"]').innerText()).trim()
    const expectedPlaceholder = dictionaries[dictionaryId]['dialog.namePlaceholder']
    const expectedCancel = dictionaries[dictionaryId]['dialog.cancel']
    const expectedConfirm = dictionaries[dictionaryId]['dialog.confirm']
    if (dialogPlaceholder !== expectedPlaceholder || dialogCancel !== expectedCancel || dialogConfirm !== expectedConfirm) {
      throw new Error(`${localeId}: dialog fields mismatch (${dialogPlaceholder}/${dialogCancel}/${dialogConfirm})`)
    }
    if (localeId === 'ar') {
      const box = await dialog.boundingBox()
      const viewport = page.viewportSize()
      if (!box || box.x < 0 || box.y < 0 || box.x + box.width > viewport.width + 1 || box.y + box.height > viewport.height + 1) {
        throw new Error(`ar: dialog outside viewport ${JSON.stringify(box)}`)
      }
      await page.screenshot({ path: `${testHome}/rtl-dialog.png`, fullPage: false })
    }
    await page.locator('[data-testid="session-groups-dialog-cancel"]').click()
    await dialog.waitFor({ state: 'hidden' })

    const firstGroupRow = page.locator('[data-testid="session-groups-group"]').first()
    await firstGroupRow.hover()
    await groupMenuButton.first().click()
    const menu = page.locator('[data-testid="session-groups-menu"]')
    await menu.waitFor({ state: 'visible' })
    // Lazy locale chunks may arrive one render after the header label; wait for
    // the menu dictionary before asserting the whole menu text.
    await page.waitForFunction(
      (expected) => document.querySelector('[data-testid="session-groups-menu"]')?.innerText?.includes(expected),
      dictionaries[dictionaryId]['group.newSession'],
      { timeout: 5000 },
    )
    if (localeId === 'ar') {
      const box = await menu.boundingBox()
      const viewport = page.viewportSize()
      if (!box || box.x < 0 || box.y < 0 || box.x + box.width > viewport.width + 1 || box.y + box.height > viewport.height + 1) {
        throw new Error(`ar: menu outside viewport ${JSON.stringify(box)}`)
      }
      await page.screenshot({ path: `${testHome}/rtl-menu.png`, fullPage: false })
    }
    const menuText = await menu.innerText()
    for (const key of ['group.newSession', 'group.newSubgroup', 'group.rename', 'group.color', 'group.delete']) {
      if (!menuText.includes(dictionaries[dictionaryId][key])) {
        throw new Error(`${localeId}: group menu missing ${key}`)
      }
    }
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })

    // Profile popover: title, footer actions and, for RTL, alignment/bounds.
    await page.locator('[data-testid="session-groups-profile-trigger"]').click()
    const profilePopover = page.locator('[data-testid="session-groups-profile-popover"]')
    await profilePopover.waitFor({ state: 'visible' })
    const popoverLabel = await profilePopover.getAttribute('aria-label')
    if (popoverLabel !== dictionaries[dictionaryId]['profiles.title']) {
      throw new Error(`${localeId}: profile popover title ${JSON.stringify(popoverLabel)}`)
    }
    for (const [testId, key] of [
      ['session-groups-profile-save-as', 'profiles.saveAs'],
      ['session-groups-profile-manage', 'profiles.manage'],
    ]) {
      const label = (await page.locator(`[data-testid="${testId}"]`).innerText()).trim()
      if (label !== dictionaries[dictionaryId][key]) {
        throw new Error(`${localeId}: ${key} ${JSON.stringify(label)} != ${JSON.stringify(dictionaries[dictionaryId][key])}`)
      }
    }
    if (localeId === 'ar') {
      const box = await profilePopover.boundingBox()
      const viewport = page.viewportSize()
      if (!box || box.x < 0 || box.y < 0 || box.x + box.width > viewport.width + 1 || box.y + box.height > viewport.height + 1) {
        throw new Error(`ar: profile popover outside viewport ${JSON.stringify(box)}`)
      }
      const direction = await profilePopover.evaluate((element) => getComputedStyle(element).direction)
      if (direction !== 'rtl') throw new Error(`ar: profile popover direction ${direction}`)
      await page.screenshot({ path: `${testHome}/rtl-profile-popover.png`, fullPage: false })
    }

    // Profile switch preview: localized title, summary labels and actions.
    await page.locator(`[data-testid="session-groups-profile-item"][data-profile-id="${previewProfileId}"]`).click()
    const previewBody = page.locator('[data-testid="session-groups-profile-preview"]')
    await previewBody.waitFor({ state: 'visible' })
    const previewSummary = page.locator('[data-testid="session-groups-profile-preview-summary"]')
    await previewSummary.waitFor({ state: 'visible' })
    const expectedPreviewTitle = dictionaries[dictionaryId]['profiles.previewTitle'].replace('{name}', profileName)
    const previewTitle = (await page.locator('#dsg-dialog-title').innerText()).trim()
    if (previewTitle !== expectedPreviewTitle) {
      throw new Error(`${localeId}: preview title ${JSON.stringify(previewTitle)} != ${JSON.stringify(expectedPreviewTitle)}`)
    }
    const previewCancel = (await page.locator('[data-testid="session-groups-profile-preview-cancel"]').innerText()).trim()
    const previewConfirm = (await page.locator('[data-testid="session-groups-profile-preview-confirm"]').innerText()).trim()
    if (
      previewCancel !== dictionaries[dictionaryId]['dialog.cancel'] ||
      previewConfirm !== dictionaries[dictionaryId]['profiles.preview.confirm']
    ) {
      throw new Error(`${localeId}: preview actions ${JSON.stringify({ previewCancel, previewConfirm })}`)
    }
    const summaryText = await previewSummary.innerText()
    for (const key of ['profiles.preview.groups', 'profiles.preview.sessions', 'profiles.preview.ungrouped']) {
      if (!summaryText.includes(dictionaries[dictionaryId][key])) {
        throw new Error(`${localeId}: preview summary missing ${key}`)
      }
    }
    if (localeId === 'ar') {
      const dialog = page.locator('[role="dialog"]').last()
      const box = await dialog.boundingBox()
      const viewport = page.viewportSize()
      if (!box || box.x < 0 || box.y < 0 || box.x + box.width > viewport.width + 1 || box.y + box.height > viewport.height + 1) {
        throw new Error(`ar: profile preview outside viewport ${JSON.stringify(box)}`)
      }
      const direction = await dialog.evaluate((element) => getComputedStyle(element).direction)
      if (direction !== 'rtl') throw new Error(`ar: profile preview direction ${direction}`)
      await page.screenshot({ path: `${testHome}/rtl-profile-preview.png`, fullPage: false })
    }
    await page.locator('[data-testid="session-groups-profile-preview-cancel"]').click()
    await previewBody.waitFor({ state: 'hidden' })

    console.log(`PASS ${localeId} -> ${dictionaryId}: header + dialog + group menu + profile popover/preview`)
  }

  // Long RTL/Indic/Cyrillic labels at the narrow sidebar width: fail on root
  // horizontal overflow and leave screenshots for the visual review.
  await page.setViewportSize({ width: 1024, height: 900 })
  const railExpand = page.locator('[data-testid="session-groups-rail-expand"]')
  if (await railExpand.count()) {
    await railExpand.first().click()
    await page.locator('.dsg-root').waitFor({ state: 'visible' })
  }
  const resizeHandle = page.locator('[data-testid="session-groups-resize-handle"]')
  if (await resizeHandle.count()) {
    const box = await resizeHandle.boundingBox()
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + 120)
      await page.mouse.down()
      await page.mouse.move(264, box.y + 120, { steps: 6 })
      await page.mouse.up()
      await page.waitForTimeout(300)
    }
  }
  for (const localeId of ['ru', 'hi', 'ar']) {
    await page.evaluate((id) => globalThis.__DSH_E2E_SET_LOCALE__(id), localeId)
    await page.waitForFunction((id) => globalThis.__DSH_E2E_GET_LOCALE__?.().active === id, localeId)
    await page.waitForTimeout(500)
    const metrics = await page.evaluate(() => {
      const root = document.querySelector('.dsg-root')
      const header = root?.querySelector('.dsg-header-label')
      return {
        found: Boolean(root),
        rootScroll: root?.scrollWidth ?? 0,
        rootClient: root?.clientWidth ?? 0,
        headerScroll: header?.scrollWidth ?? 0,
        headerClient: header?.clientWidth ?? 0,
      }
    })
    if (!metrics.found) throw new Error(`${localeId}: groups root not visible at narrow viewport`)
    if (metrics.rootScroll > metrics.rootClient + 2) {
      throw new Error(`${localeId}: root overflow ${metrics.rootScroll} > ${metrics.rootClient}`)
    }
    await page.screenshot({ path: `${testHome}/narrow-${localeId}.png`, fullPage: false })
    console.log(`VISUAL ${localeId}: root ${metrics.rootClient}px, header ${metrics.headerClient}px (scroll ${metrics.headerScroll})`)
  }
  await page.setViewportSize({ width: 1280, height: 900 })

  // Settings/config surface: use an English host route to reach the package
  // detail page, then switch locales and check that the plugin settings slot
  // follows the active dictionary.
  await page.evaluate((id) => globalThis.__DSH_E2E_SET_LOCALE__(id), 'en')
  await page.waitForFunction(() => globalThis.__DSH_E2E_GET_LOCALE__?.().active === 'en')
  await page.evaluate(() => [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Plugins')?.click())
  await page.waitForTimeout(1500)
  const packageRow = page.locator('[data-plugin-package="dsh-session-grove"]').first()
  await packageRow.waitFor({ state: 'visible', timeout: 15000 })
  await packageRow.click()
  await page.waitForTimeout(1200)
  const settingsPanel = page.locator('[data-testid="session-groups-settings-panel"]').first()
  await settingsPanel.waitFor({ state: 'visible', timeout: 15000 })

  for (const [localeId, dictionaryId] of cases) {
    await page.evaluate((id) => globalThis.__DSH_E2E_SET_LOCALE__(id), localeId)
    await page.waitForFunction((id) => globalThis.__DSH_E2E_GET_LOCALE__?.().active === id, localeId)
    const settingsKeys = ['config.title', 'config.hint', 'config.controlApi', 'skill.repairTitle']
    for (const key of settingsKeys) {
      await page
        .waitForFunction(
          ({ key, expected }) =>
            document.querySelector('[data-testid="session-groups-settings-panel"]')?.innerText?.includes(expected),
          { key, expected: dictionaries[dictionaryId][key] },
          { timeout: 5000 },
        )
        .catch(() => {
          throw new Error(`${localeId}: settings missing ${key}`)
        })
    }
    const text = await page.locator('[data-testid="session-groups-settings-panel"]').first().innerText()
    for (const key of settingsKeys) {
      if (!text.includes(dictionaries[dictionaryId][key])) {
        throw new Error(`${localeId}: settings missing ${key}`)
      }
    }
    if (localeId === 'ar') {
      const dir = await page.locator('[data-testid="session-groups-settings-panel"]').first().getAttribute('dir')
      if (dir !== 'rtl') throw new Error(`ar: settings direction ${dir}`)
      await page.screenshot({ path: `${testHome}/rtl-settings.png`, fullPage: false })
    }
    console.log(`PASS ${localeId}: settings/config`)
  }

  if (pageErrors.length > 0) fail(`page errors: ${pageErrors.join('; ')}`)
  console.log(`PASS: all ${cases.length} locale switch cases`)
} catch (error) {
  await page.screenshot({ path: `${testHome}/all-locales-failure.png`, fullPage: false }).catch(() => {})
  fail(error instanceof Error ? error.message : String(error))
} finally {
  await context.close()
  await browser.close()
}
