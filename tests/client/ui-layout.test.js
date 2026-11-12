// tests/client/ui-layout.test.js
//
// 0.2.2 UI-layout contract: footer two-segment switch, theme-aware surfaces,
// header action order and the view-options archive menu. Pure source/CSS
// assertions keep the host-DOM details covered by E2E step 1/2/16/17.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { CSS } from '../../src/client/css.js'
import { ICON_GROUPS } from '../../src/client/icons.js'
import { SESSION_WATERMARK_AUTO_MAX, SESSION_WATERMARK_BASE } from '../../src/shared/constants.js'
import { en, zh } from '../../src/client/locale.js'
import { UI_GLYPHS, ICON_PATHS } from '../../src/client/icons.js'
import { GROUP_COLORS, GROUP_ICONS } from '../../src/shared/constants.js'

const componentsSource = readFileSync(new URL('../../src/client/components.js', import.meta.url), 'utf8')
const componentPrimitives = readFileSync(new URL('../../src/client/components-primitives.js', import.meta.url), 'utf8')
const componentRows = readFileSync(new URL('../../src/client/components-rows.js', import.meta.url), 'utf8')
const componentUngrouped = readFileSync(new URL('../../src/client/components-ungrouped.js', import.meta.url), 'utf8')
const componentResize = readFileSync(new URL('../../src/client/components-resize-handle.js', import.meta.url), 'utf8')
const componentSearch = readFileSync(new URL('../../src/client/components-search-box.js', import.meta.url), 'utf8')
const componentHeader = readFileSync(new URL('../../src/client/components-header.js', import.meta.url), 'utf8')
const componentProfiles = [
  readFileSync(new URL('../../src/client/profile-switcher.js', import.meta.url), 'utf8'),
  readFileSync(new URL('../../src/client/profile-preview.js', import.meta.url), 'utf8'),
  readFileSync(new URL('../../src/client/profile-switch.js', import.meta.url), 'utf8'),
  readFileSync(new URL('../../src/client/profile-storage.js', import.meta.url), 'utf8'),
].join('\n')
const componentProfileDialogs = readFileSync(new URL('../../src/client/components-profile-dialogs.js', import.meta.url), 'utf8')
const dialogHost = readFileSync(new URL('../../src/client/dialog-host.js', import.meta.url), 'utf8')
// Profile form bodies/validation/actions live in dialog-profile.js; the shell
// keeps the generic modal chrome and the `dialog.kind` dispatch, so the
// profile-dialog assertions read both files.
const dialogProfile = readFileSync(new URL('../../src/client/dialog-profile.js', import.meta.url), 'utf8')
const dialogHostProfile = [dialogHost, dialogProfile].join('\n')
const groupsViewWidth = readFileSync(new URL('../../src/client/groups-view-width.js', import.meta.url), 'utf8')
const groupsViewState = readFileSync(new URL('../../src/client/groups-view-state.js', import.meta.url), 'utf8')
const groupsViewMenu = readFileSync(new URL('../../src/client/groups-view-menu-handlers.js', import.meta.url), 'utf8')
const groupsViewDialog = readFileSync(new URL('../../src/client/groups-view-dialog-handlers.js', import.meta.url), 'utf8')
const components = [
  componentsSource,
  componentPrimitives,
  componentRows,
  componentUngrouped,
  componentResize,
  componentSearch,
  componentHeader,
  componentProfiles,
  componentProfileDialogs,
  dialogHost,
  groupsViewWidth,
  groupsViewState,
  groupsViewMenu,
  groupsViewDialog,
].join('\n')
const sessionMenu = readFileSync(new URL('../../src/client/session-menu.js', import.meta.url), 'utf8')
const scrollArea = readFileSync(new URL('../../src/client/scroll-area.js', import.meta.url), 'utf8')
const groupPicker = readFileSync(new URL('../../src/client/group-list-picker.js', import.meta.url), 'utf8')
/**
 * The plugin family is split across the composition root (`plugin.js`), the
 * three controllers it wires (document / profiles / host) and the host command
 * layer (`plugin-host-commands.js`). Source-text assertions read the
 * concatenation of all five, plus the small mount adapters.
 */
const pluginHostShell = () => readFileSync(new URL('../../src/client/plugin-host.js', import.meta.url), 'utf8')
const pluginHostCommands = () =>
  readFileSync(new URL('../../src/client/plugin-host-commands.js', import.meta.url), 'utf8')
const pluginFamily = () =>
  [
    readFileSync(new URL('../../src/client/plugin.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/client/plugin-document.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../../src/client/plugin-profiles.js', import.meta.url), 'utf8'),
    pluginHostShell(),
    pluginHostCommands(),
  ].join('\n')
const plugin = [
  pluginFamily(),
  readFileSync(new URL('../../src/client/plugin-settings.js', import.meta.url), 'utf8'),
  readFileSync(new URL('../../src/client/plugin-workspace-chrome.js', import.meta.url), 'utf8'),
].join('\n')
const workspaceToggle = readFileSync(new URL('../../src/client/workspace-toggle.js', import.meta.url), 'utf8')

/** Source block for one CSS selector (compiled stylesheet is flat). */
const block = (selector) => {
  const start = CSS.indexOf(selector)
  assert.notEqual(start, -1, `stylesheet is missing ${selector}`)
  const end = CSS.indexOf('}', start)
  assert.notEqual(end, -1, `stylesheet selector ${selector} has no closing brace`)
  return CSS.slice(start, end + 1)
}

test('0.2.2 surfaces use official theme tokens and never hard-code white', () => {
  assert.equal(CSS.includes('--dsw-elevation-surface'), false, 'the nonexistent elevation surface token must be gone')
  assert.equal(/background:\s*#fff\b/i.test(CSS), false, 'no white surface backgrounds')
  assert.equal(CSS.includes('#f8f9fa'), false, 'no hard-coded light card color')

  assert.match(block('.dsg-menu {'), /background:\s*var\(--dsw-specific-menu/)
  assert.match(block('.dsg-search-results {'), /background:\s*var\(--dsw-specific-menu/)
  assert.match(block('.dsg-dialog {'), /background:\s*var\(--dsw-alias-bg-layer-2/)
  assert.match(block('.dsg-dialog-input {'), /background:\s*var\(--dsw-alias-bg-layer-1/)
  assert.match(block('.dsg-search-input {'), /background:\s*var\(--dsw-alias-bg-layer-1/)

  // Text/borders ride the official aliases; Canvas/CanvasText are the last
  // fallback only.
  assert.match(block('.dsg-menu {'), /color:\s*var\(--dsw-alias-label-primary,\s*CanvasText\)/)
  assert.match(block('.dsg-dialog {'), /border:[^;]*var\(--dsw-alias-border-l2/)
  assert.match(block('.dsg-search-input {'), /border:[^;]*var\(--dsw-alias-border-l3/)
})

test('header is a 36px official section row: neutral 自由分组 title and 28px actions', () => {
  const header = block('.dsg-header {')
  assert.match(header, /padding:\s*4px 8px/)
  const row = block('.dsg-header-row {')
  assert.match(row, /height:\s*28px/)

  const title = block('.dsg-header-title {')
  assert.match(title, /font-size:\s*var\(--dsg-font-14,\s*14px\)/)
  assert.match(title, /line-height:\s*20px/)
  assert.match(title, /font-weight:\s*400/)
  // Align with the shipped workspace section label; no plugin accent.
  assert.match(title, /color:\s*var\(--dsw-alias-label-secondary/)
  assert.equal(components.includes('dsg-header-accent'), false)
  assert.equal(CSS.includes('.dsg-header-accent'), false)

  const actions = block('.dsg-header-actions {')
  assert.match(actions, /gap:\s*4px/)
  for (const testId of [
    'session-groups-running-button',
    'session-groups-new-group',
    'session-groups-search-toggle',
    'session-groups-view-options',
    'session-groups-view-options-popover',
  ]) {
    assert.equal(components.includes(testId), true, `components must render ${testId}`)
  }
  const search = components.indexOf("testId: 'session-groups-search-toggle'")
  const options = components.indexOf("testId: 'session-groups-view-options'")
  const plus = components.indexOf("testId: 'session-groups-new-group'")
  assert.ok(search !== -1 && search < options && options < plus, 'header action order must be search, view-options, plus (official workspace section order)')
  // 0.2.5: the three header actions consume the official DSH artwork, not the
  // custom search/sliders/plus approximations.
  assert.match(components, /icon: 'search'/)
  assert.match(components, /icon: 'view-options'/)
  assert.match(components, /icon: 'project-add'/)
  assert.equal(components.includes("glyph: 'search'"), false)
  assert.equal(components.includes("glyph: 'sliders'"), false)
})

test('0.4.0-beta.64 compact header is measured: root width drives data-narrow, title width drives collapse', () => {
  // Both flags come from layout measurements; `appliedWidth` only seeds the
  // first frame as root = sidebar − 12 (spec §6.6).
  assert.match(components, /import \{ resolveNarrow, shouldCollapseTitle \} from '\.\/floating-panel\.js'/)
  assert.match(components, /narrow: appliedWidth !== null && appliedWidth - 12 <= 377/)
  assert.match(components, /const rootWidth = rect \? rect\.width : NaN/)
  assert.match(components, /const title = root\.querySelector\?\.\('\.dsg-header-title'\)/)
  assert.match(components, /const titleWidth = title \? title\.clientWidth : NaN/)
  assert.match(components, /const narrow = resolveNarrow\(rootWidth, current\.narrow\)/)
  assert.match(components, /const collapsed = shouldCollapseTitle\(titleWidth, current\.collapsed, narrow\)/)
  // Re-measure on a root resize and on a window resize; the collapse decision
  // re-runs after `data-narrow` swaps the title gap 4px -> 2px.
  assert.match(components, /globalThis\.addEventListener\?\.\('resize', measure\)/)
  assert.match(components, /new Observer\(measure\)/)
  assert.match(components, /useEffect\(\(\) => \{\r?\n\s+measureChromeRef\.current\?\.\(\)\r?\n\s+\}, \[chrome\.narrow\]\)/)
  // Collapse hides only the label; the measured title box stays in layout.
  assert.match(CSS, /\[data-title-collapsed="true"\] \.dsg-header-label \{ display: none; \}/)
})

test('0.2.39 dialog restores the compact 0.2.30 chrome with theme tokens', () => {
  const dialog = block('.dsg-dialog {')
  assert.match(dialog, /background:\s*var\(--dsw-alias-bg-layer-2/)
  assert.match(dialog, /border:[^;]*var\(--dsw-alias-border-l2/)
  assert.match(dialog, /border-radius:\s*var\(--dsw-radius-md/)
  assert.match(dialog, /padding:\s*16px/)
  assert.match(dialog, /gap:\s*12px/)
  const confirm = block('.dsg-dialog-confirm {')
  assert.match(confirm, /background:\s*var\(--dsw-alias-button-primary-fill/)
  assert.match(confirm, /color:\s*var\(--dsw-alias-label-primary-foreground/)
  assert.match(confirm, /height:\s*32px/)
  assert.match(CSS, /\.dsg-dialog-confirm:hover:not\(:disabled\) \{ background:\s*var\(--dsw-alias-button-primary-hover/s)
  const cancel = block('.dsg-dialog-cancel {')
  assert.match(cancel, /border:[^;]*var\(--dsw-alias-border-l3/)
  assert.match(cancel, /height:\s*32px/)
  assert.match(CSS, /\.dsg-dialog-title \{[^}]*font-size:\s*var\(--dsg-font-14/s)
  assert.match(CSS, /\.dsg-dialog-actions \{[^}]*gap:\s*10px/s)
  assert.equal(CSS.includes('.dsg-dialog-close'), false)
  assert.equal(block('.dsg-dialog-backdrop {').includes('backdrop-filter'), false)
  assert.match(CSS, /\.dsg-dialog-resizer\[data-dir="se"\]::after/)

  // 0.4.0-beta.62 UI patch: the archive-group confirm owns the opt-out row.
  // The checkbox starts unchecked on every open and only the archive-group
  // confirm payload carries it; cancel/failure never write the preference.
  assert.match(dialogHost, /const \[dontAskAgain, setDontAskAgain\] = useState\(false\)/)
  assert.match(dialogHost, /setDontAskAgain\(false\)/)
  assert.match(dialogHost, /class: 'dsg-dialog-check'/)
  assert.match(dialogHost, /'data-testid': 'session-groups-dialog-archive-dont-ask'/)
  assert.match(dialogHost, /t\('dialog\.archiveGroupDontAsk'\)/)
  assert.match(dialogHost, /\{ dontAskAgain \}/)
  assert.match(CSS, /\.dsg-dialog-check \{ display:\s*flex; align-items:\s*center;/)
  assert.match(CSS, /\.dsg-dialog-check input \{ flex:\s*none; width:\s*14px; height:\s*14px;/)
})

test('dialog natural height uses the complete flex layout', () => {
  assert.match(components, /const dialogChrome = isProfilePreview \? 41 : 57/)
  assert.match(components, /borderHeight/)
  assert.match(components, /const laidOutHeight = Math\.ceil\(/)
  assert.match(components, /Math\.ceil\(content\?\.scrollHeight/)
  assert.match(components, /laidOutHeight \|\| Math\.ceil\(box\.height\)/)
})

test('0.2.50 dialog scroll areas use a persistent draggable thin thumb', () => {
  assert.match(CSS, /\.dsg-dialog-content \{[^}]*flex:\s*0 0 auto/s)
  assert.match(CSS, /\.dsg-dialog\[data-positioned="true"\] > \.dsg-scroll-area \{ flex:\s*1 1 auto/)
  assert.match(CSS, /\.dsg-scroll-area \{[^}]*position:\s*relative/s)
  assert.match(CSS, /\.dsg-scroll-rail \{[^}]*width:\s*5px[^}]*z-index:\s*20/s)
  assert.match(CSS, /\.dsg-scroll-thumb \{[^}]*width:\s*5px/s)
  assert.match(CSS, /\.dsg-scroll-thumb \{[^}]*background:\s*var\(--dsw-alias-scrollbar-bg-l2/)
  assert.match(CSS, /\.dsg-scroll-thumb:hover \{[^}]*--dsw-alias-scrollbar-hover-l2/s)
  assert.match(CSS, /\.dsg-scroll-thumb:hover/)
  assert.match(CSS, /\.dsg-dialog-content, \.dsg-dialog-list, \.dsg-icon-sections \{ scrollbar-width:\s*none/s)
  assert.match(CSS, /\.dsg-dialog-content::-webkit-scrollbar,[^{]*\{ width:\s*0; height:\s*0; display:\s*none; \}/s)
  assert.match(scrollArea, /const ScrollArea =/)
  assert.match(scrollArea, /class: 'dsg-scroll-rail'/)
  assert.match(scrollArea, /class: 'dsg-scroll-thumb'/)
  assert.match(scrollArea, /onPointerDown: startDrag/)
  assert.equal(CSS.includes('dsg-scroll-fade'), false)
  assert.equal(components.includes('ScrollFade'), false)
  assert.match(CSS, /\.dsg-dialog-input \{[^}]*height:\s*32px/s)
  assert.match(CSS, /\.dsg-dialog-input \{[^}]*flex:\s*none/s)
  assert.match(components, /naturalHeight/)
  assert.match(components, /content\?\.scrollHeight/)
})

test('0.2.42 top-level group destinations keep separators', () => {
  assert.match(groupPicker, /dsg-dialog-group-separator/)
  assert.match(CSS, /\.dsg-dialog-group-separator \{[^}]*border-top/s)
  assert.match(CSS, /\.dsg-dialog-list \{[^}]*z-index:\s*auto/s)
})

test('0.2.31 dialogs are draggable/resizable and backdrop clicks do not close', () => {
  assert.match(components, /dsg-dialog-titlebar/)
  assert.match(components, /dsg-dialog-resizer/)
  assert.match(components, /beginDialogGesture/)
  assert.match(components, /saveDialogGeometry/)
  assert.equal(components.includes('if (event.target === event.currentTarget) close()'), false)
  assert.match(CSS, /\.dsg-dialog\[data-positioned="true"\]/)
  assert.match(CSS, /\.dsg-dialog-titlebar \{[^}]*cursor:\s*move/s)
  assert.match(CSS, /\.dsg-dialog-resizer\[data-dir="se"\]/)
})

test('0.2.30 visible tree is memoized behind the narrow snapshot compare', () => {
  // P5 moved the tree builder out of components.js; assert the owning module.
  assert.match(groupsViewState, /const tree = useMemo/)
  assert.match(groupsViewState, /buildVisibleTree\(store\.doc, byId, workspaceItems/)
  assert.match(groupsViewState, /groupFilter: store\.groupArchiveFilter/)
  assert.match(
    groupsViewState,
    /\[store\?\.doc, store\?\.archiveFilter, store\?\.groupArchiveFilter, byId, workspaceItems, archivedSessionIds, highlightCurrent, statuses, subagentCounts\]/,
  )
})

test('0.4.0-beta.62 group visibility feeds both the tree and the header counters', () => {
  // SPEC §4.5: the tree and the running/blocked/unread counters must share one
  // group tri-state; wiring only one of them would drift the sidebar silently.
  assert.match(groupsViewState, /buildVisibleTree\(store\.doc, byId, workspaceItems/)
  assert.match(groupsViewState, /groupFilter: store\.groupArchiveFilter,/)
  assert.match(
    groupsViewState,
    /\[store\?\.doc, store\?\.archiveFilter, store\?\.groupArchiveFilter, byId, workspaceItems, archivedSessionIds, highlightCurrent, statuses, subagentCounts\]/,
  )
  assert.match(groupsViewState, /statusSectionsByGroup\(\s*store\?\.doc,/)
  assert.match(groupsViewState, /store\?\.groupArchiveFilter,/)
  assert.match(
    groupsViewState,
    /\[store\?\.doc, sessions\?\.byId, statuses, workspaces\?\.archivedSessionIds, subagentCounts, store\?\.groupArchiveFilter\]/,
  )
  // Both memos must list the new dependency, not just one.
  assert.equal((groupsViewState.match(/groupArchiveFilter/g) ?? []).length, 4)
})

test('0.4.0-beta.62 view options expose both archive tri-states and keep the popover open', () => {
  // The shipped session segment keeps its testid, data attribute and copy keys.
  assert.match(componentHeader, /'data-testid': 'session-groups-archive-filter'/)
  assert.match(componentHeader, /'data-filter': value/)
  assert.match(componentHeader, /ARCHIVE_FILTER_LABEL_KEYS\[value\]/)
  // Additive group segment: own testid, data attribute and label namespace.
  assert.match(componentHeader, /'data-testid': 'session-groups-group-archive-filter'/)
  assert.match(componentHeader, /'data-group-filter': value/)
  assert.match(componentHeader, /GROUP_ARCHIVE_FILTER_LABEL_KEYS\[value\]/)
  for (const key of [
    'archive.group.hidden',
    'archive.group.all',
    'archive.group.only',
    'archive.section.sessions',
    'archive.section.groups',
  ]) {
    assert.equal(componentHeader.includes(key), true, `view options must reference ${key}`)
  }
  // One popover, two labelled groups, each mapping the same tri-state values.
  assert.equal((componentHeader.match(/class: 'dsg-view-options-section'/g) ?? []).length, 2)
  assert.equal((componentHeader.match(/role: 'group'/g) ?? []).length, 2)
  assert.equal((componentHeader.match(/ARCHIVE_FILTERS\.map\(/g) ?? []).length, 2)
  assert.match(componentHeader, /'aria-label': t\('view\.options'\)/)
  // The header reads the store value into both the button and the popover.
  assert.match(componentHeader, /const groupFilter = store\.groupArchiveFilter \?\? 'hidden'/)
  assert.match(componentHeader, /data: \{ ref: optionsTriggerRef, 'data-filter': filter, 'data-group-filter': groupFilter \}/)
  assert.match(componentHeader, /onPickGroup: \(value\) => handlers\.setGroupArchiveFilter\(value\)/)

  // §10: picking a row keeps the popover open; only reset layout closes it.
  const popoverUse = componentHeader.indexOf('h(ArchiveFilterPopover, {')
  assert.ok(popoverUse !== -1)
  const resetAt = componentHeader.indexOf('onResetLayout: () => {', popoverUse)
  assert.ok(resetAt > popoverUse)
  const pickBlock = componentHeader.slice(popoverUse, resetAt)
  assert.doesNotMatch(pickBlock, /setOptionsOpen\(false\)/)
  assert.match(pickBlock, /handlers\.setArchiveFilter\(value\)/)
  assert.match(pickBlock, /handlers\.setGroupArchiveFilter\(value\)/)
  const resetBlock = componentHeader.slice(resetAt)
  assert.match(resetBlock, /setOptionsOpen\(false\)/)

  // 0.4.0-beta.62 UI patch: "restore default display" uses the return-arrow
  // `restore` glyph instead of the refresh/X-like glyph; label and testid stay.
  const resetRowAt = componentHeader.indexOf("'data-testid': 'session-groups-reset-layout'")
  assert.ok(resetRowAt !== -1)
  const resetRow = componentHeader.slice(resetRowAt, resetRowAt + 600)
  assert.match(resetRow, /t\('about\.resetLayout'\)/)
  assert.match(resetRow, /renderGlyph\(h, 'restore', 16\)/)
  assert.doesNotMatch(resetRow, /renderGlyph\(h, 'refresh'/)
  assert.doesNotMatch(resetRow, /renderGlyph\(h, 'close'/)
  assert.equal(typeof UI_GLYPHS.restore, 'string')
  assert.notEqual(UI_GLYPHS.restore, UI_GLYPHS.close, 'restore must not reuse the X/close path')

  // The confirm-skip preference only bypasses the dialog; the strict commit and
  // failure handling are unchanged, the preference is written on success only,
  // and reset-layout re-arms the confirmation.
  assert.match(plugin, /readArchiveConfirmSkip, writeArchiveConfirmSkip/)
  const skipGuardAt = plugin.indexOf(
    'if (shouldConfirmGroupArchive(archiveNeedsConfirm(groupId), readArchiveConfirmSkip())) {'
  )
  assert.ok(skipGuardAt !== -1, 'archiveGroup must gate the dialog on the skip preference')
  const directCommitAt = plugin.indexOf('const result = await commitGroupArchive(groupId, true)', skipGuardAt)
  assert.ok(directCommitAt > skipGuardAt, 'skipping the dialog must fall through to the same strict commit')
  const archiveCaseAt = plugin.indexOf("case 'archive-group':")
  assert.ok(archiveCaseAt !== -1)
  const archiveCase = plugin.slice(archiveCaseAt, plugin.indexOf("case 'archive-running':", archiveCaseAt))
  const failureAt = archiveCase.indexOf('if (!result.ok) {')
  const writeAt = archiveCase.indexOf('writeArchiveConfirmSkip(payload.dontAskAgain === true)')
  assert.ok(failureAt !== -1 && writeAt > failureAt, 'only the success branch writes the skip preference')
  assert.match(archiveCase.slice(0, writeAt), /failDialog\(/)
  const resetLayoutAt = plugin.indexOf('const resetLayout = () => {')
  assert.ok(resetLayoutAt !== -1)
  assert.match(plugin.slice(resetLayoutAt, resetLayoutAt + 700), /writeArchiveConfirmSkip\(false\)/)
  // components.js needs no edit: the Header receives the store snapshot through
  // the `viewState` spread, so `groupArchiveFilter` is already present.
  assert.match(componentsSource, /const viewState = \{\s*\.\.\.store,/)
})

// ---------------------------------------------------------------------------
// 0.4.0-beta.62 archive freeze: rows, menus, drop checks (P8)
// ---------------------------------------------------------------------------
test('0.4.0-beta.62 archived group rows expose structure state, lock drag and the plus', () => {
  assert.match(componentRows, /const effectiveArchived = node\.effectiveArchived === true/)
  assert.match(componentRows, /const pathOnly = node\.pathOnly === true/)
  assert.match(componentRows, /const containsArchived = !effectiveArchived && hasArchivedDescendant\(store\.doc, group\.id\)/)
  // Both the container wrapper and the group header row carry the triple state.
  assert.equal((componentRows.match(/'data-archived': effectiveArchived/g) ?? []).length, 2)
  assert.equal((componentRows.match(/'data-path-only': pathOnly/g) ?? []).length, 2)
  assert.equal((componentRows.match(/'data-contains-archived': containsArchived/g) ?? []).length, 2)
  assert.match(componentRows, /draggable: effectiveArchived \|\| containsArchived \? 'false' : 'true'/)
  assert.match(componentRows, /session-groups-group-archived/)
  assert.match(componentRows, /session-groups-group-contains-archived/)
  assert.match(componentRows, /\(archiveReason === null \? \{\} : \{ 'aria-label'/)
  // Archived groups keep the plus visible but disabled with a reason; pathOnly
  // ancestors stay usable (their result may be invisible → P9 toast).
  assert.match(componentRows, /disabled: effectiveArchived,/)
  assert.match(componentRows, /disabledReason: effectiveArchived \? archiveReason : null,/)
  // The group menu meta carries the derived flags for session-menu's policy.
  assert.match(componentRows, /const menuMeta = \{ archived: effectiveArchived, containsArchived \}/)
  assert.match(componentRows, /handlers\.onGroupContextMenu\(event, group, menuMeta\)/)
  assert.match(componentRows, /handlers\.openGroupMenuAtRow\(rowElement, group, menuMeta\)/)
  assert.match(componentRows, /handlers\.openGroupMenu\(event, group, menuMeta\)/)
})

test('0.4.0-beta.62 archived empty groups show a locked hint and pathOnly wins', () => {
  // pathOnly is decided before the emptyVisible/empty-group branch, so a path
  // ancestor is never painted as an empty locked group (P2 carry-over).
  const pathGuard = componentRows.indexOf('if (!pathOnly && node.visibleCount === 0')
  assert.ok(pathGuard !== -1, 'pathOnly must gate the empty box')
  const lockedBox = componentRows.indexOf('locked: effectiveArchived', pathGuard)
  assert.ok(lockedBox > pathGuard, 'the empty box must render the locked variant')
  assert.match(componentRows, /GROUP_ROW_KEYS\.archivedEmpty/)
  assert.match(componentRows, /active: !effectiveArchived && emptyDropActive/)
  // The locked hint is a read-only surface, not an active drop box.
  assert.match(componentPrimitives, /'data-locked': locked \? 'true' : 'false'/)
  assert.match(componentPrimitives, /locked \? renderIcon\(h, 'lock', 14\) : renderGlyph\(h, 'plus', 14\)/)
})

test('0.4.0-beta.62 session rows use a structural lock separate from own archive', () => {
  assert.match(componentRows, /structuralLocked = false,/)
  assert.match(componentRows, /'data-structural-locked': structuralLocked \? 'true' : 'false'/)
  assert.match(componentRows, /draggable: structuralLocked \? 'false' : 'true'/)
  // The own-archive attribute keeps its meaning; the container lock never sets it.
  assert.match(componentRows, /'data-archived': archived \? 'true' : 'false'/)
  assert.doesNotMatch(componentRows, /'data-archived': structuralLocked/)
  // GroupNode hands the containing group's effective state down to the rows.
  assert.match(componentRows, /structuralLocked: effectiveArchived,/)
  // Menus receive the lock separately from the session's own archive flag.
  assert.match(componentRows, /handlers\.onSessionContextMenu\(event, sessionNode, structuralLocked\)/)
  assert.match(componentRows, /handlers\.openSessionMenuAtRow\(rowElement, sessionNode, structuralLocked\)/)
  assert.match(componentRows, /handlers\.openSessionMenu\(event, sessionNode, structuralLocked\)/)
  // Opening/toggling the container lock stays legal; only the own flag toasts.
  assert.match(componentRows, /if \(archived\) \{\s*toast\('error', rt\(\)\?\.t\('session\.archivedBadge'\)\)/)
  // Both click and Enter/Space keep the own-archive refusal.
  assert.equal((componentRows.match(/toast\('error', rt\(\)\?\.t\('session\.archivedBadge'\)\)/g) ?? []).length, 2)
})

test('0.4.0-beta.62 menus disable frozen actions with a visible reason', () => {
  assert.match(sessionMenu, /groupMenuLockReason\(menu, action\)/)
  assert.match(sessionMenu, /sessionMenuLockReason\(menu, action\)/)
  assert.match(sessionMenu, /'aria-disabled': 'true'/)
  assert.match(sessionMenu, /title: disabledReason/)
  assert.match(sessionMenu, /toast\('info', disabledReason\)/)
  for (const action of ['new-session', 'new-subgroup', 'rename', 'icon', 'color', 'move', 'delete']) {
    assert.match(sessionMenu, new RegExp(`groupLockedExtra\\('${action}'\\)`), action)
  }
  assert.match(sessionMenu, /sessionLockedExtra\('fork'\)/)
  assert.match(sessionMenu, /sessionLockedExtra\('move'\)/)
  assert.match(sessionMenu, /sessionMenuLockReason\(menu, key\)/)
  // Rename / archive toggle / copy id are never routed through a lock check.
  assert.doesNotMatch(sessionMenu, /sessionLockedExtra\('rename'\)/)
  assert.doesNotMatch(sessionMenu, /sessionLockedExtra\('archive'\)/)
  assert.doesNotMatch(sessionMenu, /sessionLockedExtra\('copy-id'\)/)
})

test('0.4.0-beta.64 menu labels ellipsize instead of wrapping', () => {
  assert.match(block('.dsg-menu-item-label {'), /text-overflow:\s*ellipsis/)
})

test('0.4.0-beta.62 drag preview and commit share the archive drop checks', () => {
  assert.match(componentsSource, /import \{ applyGroupDrop, checkGroupDrop \} from '\.\.\/core\/archive-drop\.js'/)
  assert.match(componentsSource, /import \{ effectiveArchived, hasArchivedDescendant \} from '\.\.\/shared\/archive\.js'/)
  assert.match(componentsSource, /const verdict = checkSessionDrop\(store\.doc, source, target\)/)
  assert.match(componentsSource, /const result = applyDrop\(currentDoc, source, target, visibleUngrouped\)/)
  assert.match(componentsSource, /const verdict = checkGroupDrop\(store\.doc, draggedId, target\)/)
  assert.match(componentsSource, /const result = applyGroupDrop\(latest, draggedId, target\)/)
  // A rejected commit reports the stable reason instead of writing the doc.
  assert.match(componentsSource, /if \(!verdict\.ok\) \{\s*toast\('error', dropReasonText\(t, verdict\.reason\)\)/)
  // Forbidden group previews keep the existing surface, never a placeholder.
  assert.match(componentsSource, /setDropTargetTracked\(\{ \.\.\.viewTarget, kind: 'group-forbidden' \}\)/)
  assert.match(componentsSource, /rejectSessionDragOver\(event, verdict\.reason, \{ kind: 'group-forbidden', targetId: groupId \}\)/)
  // Archived bodies keep the reject handler and stop the bubble.
  assert.match(componentsSource, /if \(!effectiveArchived\(store\.doc, groupId\)\) return/)
  assert.match(componentsSource, /checkSessionDrop\(store\.doc, drag, \{ kind: 'group-head', groupId: parentId \}\)/)
  // Defense-in-depth source guards behind draggable=false.
  assert.match(componentsSource, /location\.groupId !== null && effectiveArchived\(store\.doc, location\.groupId\)/)
  assert.match(componentsSource, /if \(hasArchivedDescendant\(store\.doc, group\.id\)\) \{/)
  // Auto-expand is scheduled only after the drop check allows the target.
  const overGroup = componentsSource.slice(componentsSource.indexOf('onDragOverGroup:'), componentsSource.indexOf('onDropGroup:'))
  const checkAt = overGroup.indexOf('checkSessionDrop')
  const expandAt = overGroup.indexOf('scheduleAutoExpand(groupId)')
  assert.ok(checkAt !== -1 && expandAt > checkAt, 'auto-expand must follow the drop check')
  // SPEC §4.2/N1: the only group filter hides the ungrouped section.
  assert.match(componentsSource, /store\.groupArchiveFilter === 'only'/)
})

test('0.4.0-beta.62 IconButton supports a focusable disabled reason', () => {
  assert.match(componentPrimitives, /'aria-disabled': disabled \? 'true' : undefined/)
  assert.match(componentPrimitives, /'data-disabled': disabled \? 'true' : 'false'/)
  assert.match(componentPrimitives, /disabledReason/)
  assert.match(componentPrimitives, /if \(disabled\) \{/)
})

// ---------------------------------------------------------------------------
// 0.4.0-beta.62 archive freeze: visual states (P10)
// ---------------------------------------------------------------------------
test('0.4.0-beta.62 archived groups dim once while pathOnly stays at full opacity', () => {
  // §5.6: only the outermost archived group owns the shipped .62 dim.
  assert.match(block('.dsg-group[data-archived="true"] {'), /opacity:\s*\.62/)
  // Nested archived groups and own-archived session rows reset so `.62` is
  // never composited twice; the parent dim still applies once.
  assert.match(CSS, /\.dsg-group\[data-archived="true"\] \.dsg-group\[data-archived="true"\] \{ opacity:\s*1; \}/)
  assert.match(CSS, /\.dsg-group\[data-archived="true"\] \.dsg-session-row\[data-archived="true"\] \{ opacity:\s*1; \}/)
  // A live parent keeps full opacity, so only the archived child subtree dims.
  assert.match(CSS, /\.dsg-group\[data-path-only="true"\] \{ opacity:\s*1; \}/)
  assert.match(CSS, /\.dsg-group\[data-path-only="true"\] > \.dsg-group-row \.dsg-group-name \{ color:\s*var\(--dsw-alias-label-secondary/)
  // Own-archived session rows outside any frozen group keep the shipped dim.
  assert.match(CSS, /\.dsg-session-row\[data-archived="true"\] \{ opacity:\s*\.62; \}/)
})

test('0.4.0-beta.62 badges, locked drop boxes and disabled rows stay readable', () => {
  const badge = block('.dsg-group-badge {')
  assert.match(badge, /display:\s*inline-flex/)
  assert.match(badge, /color:\s*var\(--dsw-alias-label-tertiary/)
  // Icons only plus the row gap: no physical side margin/alignment to mirror.
  assert.doesNotMatch(badge, /margin-(left|right)|text-align/)
  assert.match(CSS, /\.dsg-group-badge-contains \{ opacity:\s*\.7; \}/)
  // The archived empty group swaps the plus for a lock (component) and keeps a
  // neutral, non-active surface even with a stale drop flag.
  assert.match(componentPrimitives, /locked \? renderIcon\(h, 'lock', 14\) : renderGlyph\(h, 'plus', 14\)/)
  assert.match(CSS, /\.dsg-empty-dropbox\[data-locked="true"\][^}]*cursor:\s*default/s)
  assert.match(CSS, /\.dsg-empty-dropbox\[data-locked="true"\]\[data-drop-active="true"\]/)
  // Structural lock is a cursor hint; the row stays clickable/focusable.
  assert.match(CSS, /\.dsg-session-row\[data-structural-locked="true"\] \{ cursor:\s*default; \}/)
  assert.doesNotMatch(CSS, /structural-locked[^{]*\{[^}]*pointer-events/s)
  // Disabled icon/menu entries are muted but never pointer-events-blocked.
  assert.match(CSS, /\.dsg-icon-button\[aria-disabled="true"\][^}]*opacity:\s*\.45/s)
  assert.match(CSS, /\.dsg-menu-item\[aria-disabled="true"\][^}]*cursor:\s*default/s)
  assert.doesNotMatch(CSS, /(icon-button|menu-item)\[(aria-|data-)disabled[^{]*\{[^}]*pointer-events/s)
})

test('0.4.0-beta.62 view-options sections are labelled and scrollable', () => {
  assert.match(componentHeader, /class: 'dsg-view-options-section-title'/)
  assert.equal((componentHeader.match(/class: 'dsg-view-options-section'/g) ?? []).length, 2)
  assert.match(CSS, /\.dsg-view-options-section \{ display:\s*flex; flex-direction:\s*column; gap:\s*2px; min-width:\s*0; \}/)
  assert.match(CSS, /\.dsg-view-options-section-title \{[^}]*font-size:\s*var\(--dsg-font-11[^}]*color:\s*var\(--dsw-alias-label-secondary/s)
  const popover = block('.dsg-view-options-popover {')
  // 0.4.0-beta.64 §6.4: the box is fixed and placed by the floating-panel
  // controller, sized as a border-box between 200 and 360px; the vh cap is the
  // static first-frame fallback for the height the controller writes (I7).
  assert.match(popover, /position:\s*fixed/)
  assert.match(popover, /box-sizing:\s*border-box/)
  assert.match(popover, /min-width:\s*min\(200px, calc\(100vw - 16px\)\)/)
  assert.match(popover, /max-width:\s*min\(360px, calc\(100vw - 16px\)\)/)
  assert.match(popover, /max-height:\s*calc\(100vh - 24px\)/)
  assert.match(popover, /overflow-y:\s*auto/)
  // RTL headings align with the row text; badges rely on flex order only.
  assert.match(CSS, /\.dsg-root\[dir="rtl"\] \.dsg-view-options-section-title \{ text-align:\s*right; \}/)
})

test('0.4.0-beta.62 archive preview tag is neutral while stale stays danger', () => {
  assert.match(CSS, /\.dsg-profile-preview-change-tag \{ color:\s*var\(--dsw-alias-state-danger/)
  assert.match(CSS, /\.dsg-profile-preview-change-tag\[data-kind="archive"\] \{ color:\s*var\(--dsw-alias-label-secondary, CanvasText\); \}/)
  assert.match(componentProfiles, /'data-kind': 'archive'/)
  assert.equal(en['profiles.preview.archiveChanged'], 'Archive state changed')
})

test('0.2.29 status aggregation is one pass and subscriptions compare visible fields', () => {
  assert.match(components, /statusSectionsByGroup\(/)
  assert.match(components, /sessionViewEqual/)
  assert.match(components, /statusMapEqual/)
  assert.match(components, /workspaceViewEqual/)
  assert.match(components, /useMemo\(/)
})

test('0.2.28 blocked and unread counters reuse the grouped dropdown contract', () => {
  assert.match(components, /statusSectionsByGroup/)
  assert.match(components, /blockedSessions/)
  assert.match(components, /unreadSessions/)
  assert.match(components, /session-groups-blocked-button/)
  assert.match(components, /session-groups-unread-button/)
  assert.match(components, /icon: 'pause'/)
  assert.match(components, /icon: 'mail'/)
  assert.match(components, /icon: 'activity'/)
  assert.match(CSS, /\.dsg-status-actions \{[^}]*margin-right:\s*28px/s)
  assert.equal(zh['blocked.empty'], '没有等待用户介入的会话')
  assert.equal(zh['unread.empty'], '没有未读会话')
})

test('0.2.27 ungrouped inbox is session-only for drops and group move menus', () => {
  assert.match(components, /ungrouped\.sessionsOnly/)
  assert.match(components, /if \(drag\.kind === 'group'\)/)
  assert.match(components, /allowRoot: dialog\.kind !== 'move-group'/)
  assert.equal(components.includes("previewGroupDrop(event, { kind: 'group-root-end' }"), false)
  assert.equal(components.includes("commitGroupDrop(drag.groupId, { kind: 'root-end' })"), false)
})

test('0.2.54 ungrouped body drop is position-aware and does not bubble invalid rows', () => {
  assert.match(components, /onDragOverUngroupedBody/)
  assert.match(components, /onDropUngroupedBody/)
  assert.match(components, /ungroupedBodyTarget/)
  assert.match(components, /sessionId !== drag\.sessionId/)
  assert.match(components, /event\.stopPropagation\(\)/)
})

test('settings page is bundle-level and uses DSH primitives with option details', () => {
  const skillRepair = readFileSync(new URL('../../src/client/skill-repair.js', import.meta.url), 'utf8')
  assert.match(plugin, /plugins\.bundle\.config/)
  assert.doesNotMatch(plugin, /plugins\.row\.config/)
  assert.match(skillRepair, /Switch/)
  assert.match(skillRepair, /Tooltip/)
  assert.match(skillRepair, /IconInfoOutlineRegular/)
  assert.match(skillRepair, /config\.details\.diagnostics/)
  assert.match(skillRepair, /config\.detailsLabel/)
  assert.match(skillRepair, /destructivePrompt/)
  assert.match(skillRepair, /renderConfirm/)
  assert.match(skillRepair, /skill-user-owned/)
  assert.match(CSS, /dsg-config-confirm/)
  assert.doesNotMatch(CSS, /dsg-config-checkbox/)
  assert.doesNotMatch(CSS, /dsg-skill-repair-button/)
  // 0.4.0-beta.63: the docs entry is the first block of the settings page.
  assert.match(skillRepair, /import \{ DocsCard \} from '\.\/docs-card\.js'/)
  assert.match(skillRepair, /h\(DocsCard\)/)
  assert.match(CSS, /\.dsg-settings-docs \{/)
  assert.match(CSS, /\.dsg-settings-docs-link \{/)
  assert.equal(typeof zh['config.details.controlApi'], 'string')
  assert.equal(typeof en['config.details.controlApi'], 'string')
  assert.match(skillRepair, /field === 'controlSessions' && config\.controlApi !== true/)
  assert.match(skillRepair, /disabled: dependencyBlocked/)
  assert.match(skillRepair, /dsg-config-dependent/)
  assert.match(CSS, /\.dsg-config-dependent \{[^}]*margin-left:\s*18px/)
  assert.equal(zh['config.requiresControlApi'], '需要先开启 AI 控制接口')
  assert.equal(en['config.requiresControlApi'], 'Requires AI control API')
  assert.equal(typeof zh['config.destructiveConfirmBody'], 'string')
  assert.equal(typeof en['skill.repairUserOwned'], 'string')
})

test('session menu drops pin and adds fork, copy id and hover archive', () => {
  assert.doesNotMatch(components, /t\('session\.pin'\)/)
  assert.doesNotMatch(components, /t\('session\.unpin'\)/)
  assert.doesNotMatch(components, /pinned:/)
  assert.match(sessionMenu, /t\('session\.fork'\)/)
  assert.match(sessionMenu, /t\('session\.copyId'\)/)
  assert.match(components, /session-groups-session-archive/)
  assert.match(components, /glyph: 'archive'/)
  assert.match(components, /glyph: 'unarchive'/)
  assert.match(sessionMenu, /menu\.blank !== true/)
  assert.match(sessionMenu, /capabilities\.fork\?\./)
  assert.match(plugin, /Boolean\(remoteAccess/)
  assert.match(plugin, /placeForkedSession\(latest, sessionId, childId\)/)
  assert.match(plugin, /toast\.forked/)
  assert.equal(typeof UI_GLYPHS.archive, 'string')
  assert.equal(typeof UI_GLYPHS.unarchive, 'string')
  assert.equal(zh['session.fork'], '分叉会话')
  assert.equal(zh['session.copyId'], '复制 Session ID')
  assert.equal(en['session.fork'], 'Fork session')
  assert.equal(en['session.copyId'], 'Copy Session ID')
})

test('0.3.0 beta exposes onboarding, reset layout and opaque status popovers', () => {
  assert.match(components, /session-groups-onboarding/)
  assert.match(components, /session-groups-empty-state/)
  assert.match(components, /session-groups-reset-layout/)
  assert.match(components, /session-groups-about/)
  assert.match(components, /rt\(\)\?\.debugProbe !== true/)
  assert.match(components, /readOnboardingDone/)
  assert.match(CSS, /\.dsg-onboarding \{/)
  assert.match(CSS, /\.dsg-empty-state \{/)
  assert.match(CSS, /\.dsg-running-popover \{[^}]*background:\s*var\(--dsw-alias-bg-layer-1/s)
  assert.equal(zh['onboarding.title'], '自由分组')
  assert.match(components, /search\.collapse/)
  assert.match(components, /glyph: 'chevronUp'/)
  assert.equal(zh['about.resetLayout'], '恢复默认显示')
  assert.match(zh['about.scope'], /不会删除或调整分组/)
  assert.match(zh['about.scope'], /分组归属/)
  assert.match(en['about.scope'], /does not delete or change groups/i)
  assert.equal(en['onboarding.title'], 'Free Groups')
})

test('0.4.0-beta.63 first-run funnel and in-place hints are wired', () => {
  // Entry hint: plain-DOM coach mark + one-time key, retired on entering.
  const toggle = readFileSync(new URL('../../src/client/workspace-toggle.js', import.meta.url), 'utf8')
  assert.match(toggle, /dsg-entry-hint/)
  assert.match(toggle, /session-groups-workspace-entry-hint-primary/)
  assert.match(toggle, /onHintDismiss/)
  const host = readFileSync(new URL('../../src/client/plugin-host.js', import.meta.url), 'utf8')
  assert.match(host, /readEntryHintDone/)
  assert.match(host, /writeEntryHintDone/)
  assert.match(host, /t\('entry\.title'\)/)
  // The card is the genuine empty state; docs point at the illustrated site.
  assert.match(componentsSource, /onboardingOpen && filterEmptyKind === 'none'/)
  assert.match(componentsSource, /DOCS_SITE_URL/)
  assert.match(componentHeader, /session-groups-onboarding-docs/)
  assert.match(componentHeader, /t\('onboarding\.docs'\)/)
  // Entry hint and settings card carry their own docs entries.
  const docsCard = readFileSync(new URL('../../src/client/docs-card.js', import.meta.url), 'utf8')
  assert.match(docsCard, /DOCS_SITE_URL/)
  assert.match(docsCard, /session-groups-settings-docs-link/)
  assert.match(docsCard, /t\('docs\.open'\)/)
  assert.match(toggle, /session-groups-workspace-entry-hint-docs/)
  assert.match(toggle, /docsUrl/)
  assert.match(toggle, /\.dsg-entry-hint-docs\{/)
  assert.match(host, /docsUrl: DOCS_SITE_URL/)
  assert.match(CSS, /\.dsg-settings-docs \{/)
  assert.match(CSS, /\.dsg-settings-docs-link \{/)
  // In-place hints: view options, status popover, fork, group archive.
  assert.match(componentHeader, /dsg-view-options-hint/)
  assert.match(componentHeader, /t\('archive\.hint'\)/)
  assert.match(componentHeader, /dsg-status-hint/)
  assert.match(componentHeader, /t\('status\.hint'\)/)
  assert.match(sessionMenu, /t\('session\.forkHint'\)/)
  assert.match(sessionMenu, /t\('group\.archiveHint'\)/)
  assert.match(CSS, /\.dsg-view-options-hint \{/)
  assert.match(CSS, /\.dsg-status-hint \{/)
  assert.match(CSS, /\.dsg-onboarding-docs \{/)
  // The new keys ship in both static dictionaries.
  assert.equal(typeof en['entry.primary'], 'string')
  assert.equal(typeof zh['entry.primary'], 'string')
  assert.equal(typeof en['onboarding.docs'], 'string')
  assert.equal(typeof zh['docs.title'], 'string')
  assert.equal(typeof zh['docs.body'], 'string')
  assert.equal(typeof en['docs.open'], 'string')
  assert.equal(typeof zh['archive.hint'], 'string')
  assert.equal(typeof zh['session.forkHint'], 'string')
})

test('0.2.26 running-session action counts all spinners and groups its menu by parent', () => {
  const runningAt = components.indexOf('session-groups-running-button')
  const toggleAt = components.indexOf("testId: 'session-groups-toggle'")
  assert.ok(runningAt > 0 && runningAt < toggleAt, 'running action must be left of the view toggle')
  assert.match(components, /statusSectionsByGroup\(/)
  assert.match(components, /session-groups-running-popover/)
  assert.match(components, /-item/)
  assert.match(components, /handlers\.openRunningSession/)
  assert.match(components, /running\.group\.ungrouped/)
  assert.match(CSS, /\.dsg-running-section \+ \.dsg-running-section[^}]*border-top/s)
  assert.match(CSS, /\.dsg-status-action \{[^}]*min-width:\s*28px/s)
  assert.equal(zh['view.title'], '自由分组')
  assert.equal(zh['running.group.ungrouped'], '未分组')
})

test('0.2.24 both views expose the header switch and share one width override', () => {
  const actionsStart = components.indexOf("class: 'dsg-header-actions'")
  const toggleAt = components.indexOf("testId: 'session-groups-toggle'", actionsStart)
  const searchAt = components.indexOf("testId: 'session-groups-search-toggle'", actionsStart)
  assert.ok(toggleAt > actionsStart)
  assert.ok(searchAt > toggleAt, 'view toggle must sit left of search')

  assert.match(components, /glyph: 'grid'/)
  assert.match(components, /data: \{ 'data-mode': store\.viewMode, 'data-target': 'workspace' \}/)
  assert.match(components, /rt\(\)\?\.toggleMode\(\)/)
  assert.match(workspaceToggle, /session-groups-workspace-toggle/)
  assert.match(workspaceToggle, /searchButton/)
  assert.match(plugin, /installWorkspaceToggle/)
  assert.match(plugin, /syncWorkspaceChrome/)
  assert.match(plugin, /applyManagedWidth/)
  assert.match(plugin, /\[data-side="sidebar"\]/)
  assert.match(components, /applyManagedWidth/)
  assert.equal(components.includes('dsg-footer-toggle'), false)
  assert.equal(CSS.includes('.dsg-footer-toggle'), false)
  assert.equal(plugin.includes('FOOTER_SLOT'), false)

  const actionButton = block('.dsg-icon-button {')
  assert.match(actionButton, /width:\s*28px/)
  assert.match(actionButton, /height:\s*28px/)
  assert.equal(UI_GLYPHS.grid.length > 0, true)
})

test('ungrouped inbox is windowed with exact spacers and bounded DOM rows', () => {
  assert.match(components, /computeVirtualWindow/)
  assert.match(components, /session-groups-virtual-spacer/)
  assert.match(components, /'data-virtual-start'/)
  assert.match(components, /'data-virtual-end'/)
  assert.match(components, /virtualRef/)
  assert.match(components, /scrollToIndex/)
  const line = block('.dsg-virtual-list {')
  assert.match(line, /gap:\s*2px/)
  assert.match(block('.dsg-virtual-spacer {'), /flex:\s*none/)
})

test('archive tri-state lives in the view-options popover with 30px rows and a check', () => {
  assert.match(components, /role: 'menuitemradio'/)
  assert.match(components, /'data-testid': 'session-groups-archive-filter'/)
  assert.match(components, /'data-filter': value/)
  assert.match(components, /'aria-checked': active \? 'true' : 'false'/)
  assert.match(components, /renderGlyph\(h, 'check', 16\)/)
  assert.match(components, /icon: 'view-options'/)
  const option = block('.dsg-view-option {')
  assert.match(option, /height:\s*30px/)
  assert.match(block('.dsg-view-options-popover {'), /position:\s*fixed/)
})

test('0.4.0-beta.64 header popovers are placed by the floating-panel controller', () => {
  // One controller for the three status panels (248px fixed box) and the
  // view-options / profile popovers (content-sized 200-360 / 220-300px).
  assert.match(componentHeader, /useFloatingPanel\(\{\s*open,/)
  assert.match(componentHeader, /align:\s*'inline-end'/)
  assert.match(componentHeader, /designWidth:\s*248/)
  assert.match(componentHeader, /designHeight:\s*320/)
  assert.match(componentHeader, /designWidth:\s*360/)
  assert.match(componentHeader, /fixedWidth:\s*false/)
  assert.match(componentHeader, /'data-placement': panel\.placement/)
  assert.match(componentProfiles, /align:\s*'inline-start'/)
  assert.match(componentProfiles, /designWidth:\s*300/)
  assert.match(componentProfiles, /'data-placement': panel\.placement/)
  // The status panel root carries the same additive placement hook plus the
  // controller's inline style; 0.4.0-beta.64 P8 cannot open the local
  // `useState` panel under the test React stub, so the runtime ui-runtime spec
  // covers the two content-sized roots and this pins the third.
  assert.match(
    componentHeader,
    /class: 'dsg-running-popover',\s*ref: panel\.ref,\s*style: panel\.style,\s*'data-placement': panel\.placement/
  )
  // The status panel is a fixed, border-box box: no CSS side anchor positions
  // it anymore, so the 248px width lives in the component, not in the sheet.
  const running = block('.dsg-running-popover {')
  assert.match(running, /position:\s*fixed/)
  assert.match(running, /box-sizing:\s*border-box/)
  assert.match(running, /max-width:\s*calc\(100vw - 16px\)/)
  assert.match(running, /background:\s*var\(--dsw-alias-bg-layer-1/)
  assert.equal(running.includes('right: 0'), false)
  assert.equal(running.includes('top: calc(100% + 6px)'), false)
  // Truncated single-line labels stay readable through `title` (spec §6.3).
  assert.match(componentHeader, /class: 'dsg-running-group-label', title: groupLabel/)
  assert.match(componentHeader, /class: 'dsg-running-item',[\s\S]*?title: itemTitle/)
  assert.match(componentHeader, /class: 'dsg-view-option-label', title: label/)
  assert.match(componentProfiles, /class: 'dsg-profile-item-label', title: profileLabel\(profile\)/)
})

test('archive labels and footer action labels match the 0.2.4 copy', () => {
  assert.equal(zh['archive.hidden'], '隐藏已归档')
  assert.equal(zh['archive.all'], '全部对话（显示已归档）')
  assert.equal(zh['archive.only'], '仅显示已归档')
  assert.equal(en['archive.hidden'], 'Hide archived')
  assert.equal(en['archive.all'], 'All conversations (archived shown)')
  assert.equal(en['archive.only'], 'Archived only')
  // Exact footer copy requested for 0.2.4: workspace -> groups / groups -> workspace.
  assert.equal(zh['footer.toGroups'], '切换到自由分组视图')
  assert.equal(zh['footer.toWorkspace'], '返回默认工作区视图')
  assert.equal(en['footer.toGroups'], 'Switch to free grouping view')
  assert.equal(en['footer.toWorkspace'], 'Back to default workspace view')
  assert.equal(Object.hasOwn(zh, 'footer.switchLabel'), false, 'unused 0.2.2 switch label must be removed')
  assert.equal(Object.hasOwn(en, 'footer.switchLabel'), false, 'unused 0.2.2 switch label must be removed')
})

test('drag insertion uses a row-height theme-aware placeholder, not a 2px border', () => {
  const placeholder = block('.dsg-drop-placeholder {')
  assert.match(placeholder, /height:\s*var\(--dsg-drop-height,\s*32px\)/)
  assert.match(placeholder, /border:\s*1px dashed var\(--dsw-alias-state-business-primary/)
  assert.match(placeholder, /background:\s*var\(--dsw-alias-state-business-primary-fade/)
  assert.match(placeholder, /color:\s*var\(--dsw-alias-state-business-primary/)
  assert.match(placeholder, /pointer-events:\s*auto/)
  assert.match(block('.dsg-tree {'), /overflow-anchor:\s*none/, 'scroll anchoring must not cancel the placeholder gap')
  assert.match(block('.dsg-tree {'), /padding:\s*6px 8px 8px/, 'top-level left/right inset must be symmetric')
  assert.equal(CSS.includes('.dsg-drop-indicator'), false, 'the old 2px indicator must be gone')
  assert.equal(CSS.includes('.dsg-insert-before'), false, 'the old 2px before-border must be gone')
  assert.equal(CSS.includes('.dsg-insert-after'), false, 'the old 2px after-border must be gone')

  // 32px session / 34px group heights are wired from the component.
  assert.match(components, /const SESSION_PLACEHOLDER_HEIGHT = 32/)
  assert.match(components, /const GROUP_PLACEHOLDER_HEIGHT = 34/)
  assert.match(components, /'data-testid': 'session-groups-drop-indicator'/)
  assert.match(components, /'data-drop-height': String\(height\)/)
  assert.match(components, /class: 'dsg-drop-placeholder-label'/)
  // The active child slot expands from 6px to the group-row placeholder.
  const slot = block('.dsg-group-drop-slot {')
  assert.match(slot, /height:\s*6px/)
  const activeSlot = block('.dsg-group-drop-slot[data-drop-active="true"] {')
  assert.match(activeSlot, /height:\s*34px/)
  // Every drop family gets a placeholder label key.
  assert.equal(typeof zh['drag.dropHere'], 'string')
  assert.equal(typeof en['drag.dropHere'], 'string')
  assert.equal(typeof zh['drag.groupAppend'], 'string')
  assert.equal(typeof en['drag.groupAppend'], 'string')
  assert.equal(typeof zh['drag.toUngrouped'], 'string')
  assert.equal(typeof en['drag.toUngrouped'], 'string')
})

test('0.2.6 row hover actions match header controls: 28x28, 16px glyph, 4px gap, rows unchanged', () => {
  const actions = block('.dsg-group-actions, .dsg-session-actions {')
  assert.match(actions, /gap:\s*4px/)
  const actionButton = block('.dsg-group-actions .dsg-icon-button, .dsg-session-actions .dsg-icon-button {')
  assert.match(actionButton, /width:\s*28px/)
  assert.match(actionButton, /height:\s*28px/)
  // The header controls remain the reference: 28px buttons with 16px artwork.
  assert.match(block('.dsg-header-actions {'), /gap:\s*4px/)
  assert.match(block('.dsg-icon-button {'), /width:\s*28px/)
  assert.match(components, /renderGlyph\(h, glyph\)/)
  // Row heights stay 34/32 while the hit area grows.
  assert.match(block('.dsg-group-row {'), /height:\s*34px/)
  assert.match(CSS, /\.dsg-session-row \{\s*height:\s*32px/)
  // The group name/count still ellipsize (flex:1 min-width:0 / flex:none).
  assert.match(block('.dsg-group-name {'), /flex:\s*1/)
  assert.match(block('.dsg-group-name {'), /text-overflow:\s*ellipsis/)
  assert.match(block('.dsg-group-count {'), /flex:\s*none/)
})

test('0.2.7 unified guide: 16/4 content, 2px line at x=16, 60% group / 45% ungrouped', () => {
  // Group and ungrouped lists share the same rail geometry and 2px line; only
  // the color differs (group 60% mix, ungrouped label-tertiary 45%).
  const base = block('.dsg-group-line {')
  assert.match(base, /position:\s*relative/)
  assert.match(base, /margin-left:\s*16px/)
  assert.match(base, /padding-left:\s*4px/)
  assert.match(base, /border-left:\s*0/)
  const neutral = block('.dsg-group-line::before {')
  assert.match(neutral, /left:\s*-1px/)
  assert.match(neutral, /top:\s*2px/)
  assert.match(neutral, /bottom:\s*2px/)
  assert.match(neutral, /width:\s*2px/)
  assert.match(neutral, /label-tertiary[^)]*\) 45%/)
  const groupGuide = block('.dsg-group > .dsg-group-body > .dsg-group-line::before {')
  assert.match(groupGuide, /var\(--dsg-group-color[^;]*60%, transparent\)/)
  // Row padding 8 + 16px caret => caret tip x=16; guide center = margin 16 (-1 + 2/2).
  assert.match(block('.dsg-group-row {'), /padding:\s*0 8px/)
  assert.match(block('.dsg-group-caret {'), /width:\s*16px/)
  // 16px margin + 4px padding = the original 20px of content start per level.
  assert.equal(16 + 4, 20)
  // Color hierarchy: caret 85%, icon 100%, guide 60%.
  assert.match(block('.dsg-group > .dsg-group-row .dsg-group-caret {'), /var\(--dsg-group-color/)
  assert.match(block('.dsg-group > .dsg-group-row .dsg-group-caret {'), /opacity:\s*\.85/)
  assert.match(block('.dsg-group-icon {'), /color:\s*var\(--dsg-group-color/)
})

test('0.2.15 group palette: twelve distinct ids, color-token rules and a menu color dialog', () => {
  assert.deepEqual([...GROUP_COLORS], ['blue', 'green', 'orange', 'red', 'purple', 'gray', 'teal', 'pink', 'brown', 'cyan', 'navy', 'magenta'])
  for (const color of GROUP_COLORS) {
    assert.match(CSS, new RegExp(`\\.dsg-group\\[data-color="${color}"\\]`))
    assert.equal(typeof zh[`color.${color}`], 'string', `zh color.${color}`)
    assert.equal(typeof en[`color.${color}`], 'string', `en color.${color}`)
  }
  assert.equal(zh['group.color'], '修改颜色')
  assert.equal(en['group.color'], 'Change color')
  assert.equal(zh['dialog.groupColor'], '修改颜色')
  assert.equal(en['dialog.groupColor'], 'Change color')
  // Color rules drive the icon and the child guide line.
  assert.match(block('.dsg-group-icon {'), /color:\s*var\(--dsg-group-color/)
  // Menu item opens the color dialog; the dialog renders palette swatches.
  assert.match(sessionMenu, /handlers\.openGroupColor\(menu\.groupId\)/)
  assert.match(components, /kind: 'group-color'/)
  assert.match(components, /'data-testid': 'session-groups-dialog-color'/)
  assert.match(components, /role: 'radiogroup'/)
  assert.match(components, /dsg-color-swatch/)
  assert.match(block('.dsg-color-swatch {'), /background:|width:\s*16px/)
  assert.match(block('.dsg-color-option[data-selected="true"] {'), /border-color:\s*var\(--dsw-alias-label-primary/)
  // The plugin applies the choice through the shared model setter.
  const plugin = pluginFamily()
  assert.match(plugin, /case 'group-color'/)
  assert.match(plugin, /setGroupColor\(latest, dialog\.groupId, payload\.color\)/)
})

test('0.2.11 row order: title → workspace → actions → archived → time', () => {
  const name = components.indexOf("class: 'dsg-group-name'")
  const actions = components.indexOf("class: 'dsg-group-actions'", name)
  const count = components.indexOf("class: 'dsg-group-count'", actions)
  assert.ok(name !== -1 && actions !== -1 && count !== -1 && name < actions && actions < count)
  assert.ok(components.includes("'data-testid': 'session-groups-group-count'"))
  const title = components.indexOf("class: 'dsg-session-title'")
  const workspace = components.indexOf("class: 'dsg-workspace-badge'", title)
  const sessionActions = components.indexOf("class: 'dsg-session-actions'", workspace)
  const badge = components.indexOf("class: 'dsg-session-badge'", sessionActions)
  const time = components.indexOf("class: 'dsg-session-time'", badge)
  assert.ok(title !== -1 && workspace !== -1 && sessionActions !== -1 && badge !== -1 && time !== -1)
  assert.ok(title < workspace && workspace < sessionActions && sessionActions < badge && badge < time)
  assert.ok(components.includes("'data-testid': 'session-groups-session-time'"))

  // Count always visible, tabular 12/16, right-aligned at the 8px row padding.
  const countCss = block('.dsg-group-count {')
  assert.match(countCss, /text-align:\s*right/)
  assert.match(countCss, /font-size:\s*var\(--dsg-font-12,\s*12px\)/)
  assert.match(countCss, /line-height:\s*16px/)
  assert.match(countCss, /font-variant-numeric:\s*tabular-nums/)
  // 0.2.8: official trailing type is 10/16, 40px minimum, right-aligned.
  const timeCss = block('.dsg-session-time {')
  assert.match(timeCss, /min-width:\s*40px/)
  assert.match(timeCss, /text-align:\s*right/)
  assert.match(timeCss, /font-size:\s*var\(--dsg-font-10,\s*10px\)/)
  assert.match(timeCss, /line-height:\s*16px/)
  assert.match(timeCss, /tabular-nums/)
  // Actions are invisible *and* non-interactive until hover/focus.
  const actionsCss = block('.dsg-group-actions, .dsg-session-actions {')
  assert.match(actionsCss, /opacity:\s*0/)
  assert.match(actionsCss, /pointer-events:\s*none/)
  const reveal = block('.dsg-group-row:hover .dsg-group-actions, .dsg-group-row:focus-within .dsg-group-actions,')
  assert.match(CSS, /\.dsg-session-row:hover \.dsg-session-actions[^}]*pointer-events:\s*auto/s)
  assert.match(reveal, /opacity:\s*1/)
  // Row focus ring.
  assert.match(CSS, /\.dsg-group-row:focus-visible, \.dsg-session-row:focus-visible \{[^}]*outline:\s*2px/s)
  // The applied-width flag hides the workspace badge at the narrow minimum.
  assert.match(CSS, /\.dsg-root\[data-narrow="true"\] \.dsg-workspace-badge \{ display: none; \}/)
  // 0.4.0-beta.64: the root flags now come from the measured chrome state, not
  // from the stored width preference (spec §6.6).
  assert.match(components, /'data-narrow': chrome\.narrow \? 'true' : 'false'/)
  assert.match(components, /'data-title-collapsed': chrome\.collapsed \? 'true' : 'false'/)
  assert.match(components, /'data-width': String\(Math\.round\(chrome\.width\)\)/)
})

test('0.2.8 session status: official 16x20 slot, spinner, dots, hidden labels and compact trailing', () => {
  const slot = block('.dsg-session-status {')
  assert.match(slot, /width:\s*16px/)
  assert.match(slot, /height:\s*20px/)
  assert.match(slot, /flex:\s*none/)
  assert.match(components, /class: 'dsg-session-status'/)
  assert.match(components, /testId = 'session-groups-session-status'/)
  // Idle/archived/blank only paint an empty slot; no transparent dot class remains.
  assert.equal(CSS.includes('.dsg-session-dot'), false, 'the 0.2.7 6px dot must be gone')
  assert.match(components, /const show = primary !== null && primary\.state !== 'idle'/)
  assert.match(components, /hidden = false/)
  assert.match(components, /hiddenStatus = archived \|\| row\.blank === true/)
  // Official 14px spinner: two r=9.5 circles in a 24 viewBox.
  assert.match(components, /class: 'dsg-status-spinner'/)
  assert.match(components, /width: '14'/)
  assert.match(components, /height: '14'/)
  assert.match(components, /viewBox: '0 0 24 24'/)
  assert.equal((components.match(/r: '9\.5'/g) ?? []).length, 2)
  assert.match(components, /class: 'dsg-status-spinner-track'/)
  assert.match(components, /class: 'dsg-status-spinner-arc'/)
  const spinner = block('.dsg-status-spinner-motion {')
  assert.match(spinner, /animation:\s*dsg-state-dot-spin 1\.5s linear infinite/)
  // Only the outer transform rotates; the arc stays static so the compositor
  // does not repaint the SVG stroke every frame.
  assert.equal(CSS.includes('dsg-state-dot-dash'), false)
  assert.match(CSS, /\.dsg-status-spinner-arc \{ stroke-dasharray:\s*18 150;/)
  assert.doesNotMatch(block('.dsg-status-spinner-arc {'), /animation:/)
  assert.match(CSS, /stroke-width:\s*2/)
  assert.match(block('.dsg-status-spinner-track {'), /opacity:\s*\.25/)
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*\.dsg-status-spinner-motion \{ animation: none; \}/)
  // 10px dot with 6px core (inset 20%) and official warn/success aliases.
  assert.match(block('.dsg-status-dot {'), /width:\s*10px/)
  assert.match(block('.dsg-status-dot {'), /height:\s*10px/)
  assert.match(block('.dsg-status-dot::after {'), /inset:\s*20%/)
  assert.match(CSS, /--dsw-alias-state-warn-primary/)
  assert.match(CSS, /--dsw-alias-state-success-primary/)
  // Pending swaps the trailing time cell for the compact locale label.
  assert.match(components, /primaryStatus\.compactKey/)
  assert.match(components, /'data-compact-status': primaryStatus\.pendingKind/)
  assert.match(components, /dsg-session-compact-status/)
  // Visually hidden labels carry every displayed status (including subagents).
  assert.match(block('.dsg-visually-hidden {'), /clip:\s*rect\(0 0 0 0\)/)
  assert.match(components, /class: 'dsg-visually-hidden'/)
  assert.match(components, /statusText\(status\)/)
})

test('0.2.8 empty drop box matches DropPlaceholder and never doubles a body placeholder', () => {
  const box = block('.dsg-empty-dropbox {')
  assert.match(box, /box-sizing:\s*border-box/)
  assert.match(box, /display:\s*flex/)
  assert.match(box, /align-items:\s*center/)
  assert.match(box, /justify-content:\s*center/)
  assert.match(box, /width:\s*100%/)
  assert.match(box, /min-width:\s*0/)
  assert.match(box, /min-height:\s*32px/)
  assert.match(box, /padding:\s*0 8px/)
  assert.match(box, /border:\s*1px dashed/)
  assert.match(box, /border-radius:\s*6px/)
  assert.match(box, /font-size:\s*var\(--dsg-font-12,\s*12px\)/)
  const active = block('.dsg-empty-dropbox[data-drop-active="true"] {')
  assert.match(active, /border-color:\s*var\(--dsw-alias-state-business-primary/)
  assert.match(active, /background:\s*var\(--dsw-alias-state-business-primary-fade/)
  assert.match(active, /color:\s*var\(--dsw-alias-state-business-primary/)
  assert.match(components, /classNames\('dsg-empty-dropbox'/)
  assert.match(components, /class: 'dsg-empty-dropbox-plus'/)
  assert.match(components, /renderGlyph\(h, 'plus', 14\)/)
  assert.match(components, /class: 'dsg-empty-dropbox-label'/)
  // The old left-aligned italic plain hint is gone.
  assert.equal(components.includes('dsg-group-empty'), false)
  assert.equal(CSS.includes('.dsg-group-empty'), false)
  // Body placeholders suppress the hint; boundary targets keep its accent state.
  assert.match(components, /bodyPlaceholderVisible/)
  assert.match(components, /node\.visibleCount === 0 && childGroups\.length === 0 && !bodyPlaceholderVisible/)
  assert.match(components, /dropKind !== 'ungrouped'/)
})

test('0.2.14 color dialog: 2x3 roomy grid, fixed check slot, custom native+hex row', () => {
  const grid = block('.dsg-color-grid {')
  assert.match(grid, /display:\s*grid/)
  assert.match(grid, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(grid, /padding:\s*8px/)
  assert.match(grid, /background:\s*var\(--dsw-alias-bg-layer-1/)
  assert.match(grid, /border:[^;]*var\(--dsw-alias-border-l3/)
  const option = block('.dsg-color-option {')
  assert.match(option, /height:\s*36px/)
  assert.match(option, /width:\s*100%/)
  // Every preset cell renders a check node; unselected cells hide (not remove) it.
  assert.match(components, /'data-testid': 'session-groups-dialog-color-check'/)
  assert.match(components, /'data-empty': active \? 'false' : 'true'/)
  assert.match(components, /visibility: active \? 'visible' : 'hidden'/)
  assert.match(block('.dsg-dialog-option-check {'), /width:\s*16px/)
  assert.match(block('.dsg-dialog-option-check {'), /flex:\s*none/)
  // Custom row: native color swatch + 7-char hex input + aria-live hint.
  assert.match(components, /type: 'color'/)
  assert.match(components, /'data-testid': 'session-groups-dialog-color-native'/)
  assert.match(components, /'data-testid': 'session-groups-dialog-color-hex'/)
  assert.match(components, /maxlength: '7'/)
  assert.match(components, /'aria-live': 'polite'/)
  assert.match(components, /'data-testid': 'session-groups-dialog-color-hint'/)
  assert.match(components, /normalizeColorHex\(raw\)/)
  assert.match(components, /setHexInput\(''\)/)
  assert.match(block('.dsg-color-custom-row {'), /height:\s*32px/)
  assert.match(block('.dsg-color-hex {'), /flex:\s*1/)
  assert.match(block('.dsg-color-hint {'), /font-size:\s*var\(--dsg-font-11,\s*11px\)/)
})

test('0.2.7 hash default icon and custom color precedence helpers', () => {
  assert.equal(GROUP_ICONS.includes('hash'), true)
  assert.equal(typeof ICON_PATHS.hash, 'object')
  const colorCore = readFileSync(new URL('../../src/core/color.js', import.meta.url), 'utf8')
  assert.match(colorCore, /groupColorHex\(group\) \?\? `var\(--dsg-color-\$\{groupColor\(group\)\}\)`/)
  assert.match(components, /style: \{ '--dsg-group-color': groupColorCss\(group\) \}/)
  // The host stores the custom hex alongside the legacy palette id.
  const plugin = pluginFamily()
  assert.match(plugin, /setGroupColorHex\(latest, dialog\.groupId, payload\.colorHex\)/)
})

test('0.2.7 right-click/keyboard menu wiring and clamped anchors', () => {
  assert.match(components, /onContextMenu: \(event\) => handlers\.onGroupContextMenu/)
  assert.match(components, /onContextMenu: \(event\) => handlers\.onSessionContextMenu/)
  assert.match(components, /'aria-haspopup': 'menu'/)
  assert.match(components, /menuAnchorFromEvent/)
  assert.match(components, /menuAnchorFromRow/)
  assert.match(components, /isMenuKey\(event\)/)
  assert.match(components, /if \(dragRef\.current\) return/)
  // The mounted menu re-clamps with its real rect.
  assert.match(sessionMenu, /clampMenuPosition\(\{/)
  const plugin = pluginFamily()
  assert.match(plugin, /'scroll', closeMenuOnViewportChange, true/)
  assert.match(plugin, /'resize', closeMenuOnViewportChange/)
})

test('0.3.0-beta.70 group menu starts with new session and reuses the group plus action', () => {
  assert.equal(zh['group.newSession'], '新建会话')
  assert.equal(en['group.newSession'], 'New session')
  const newSessionIndex = sessionMenu.indexOf("t('group.newSession')")
  const newSubgroupIndex = sessionMenu.indexOf("t('group.newSubgroup')")
  assert.ok(newSessionIndex >= 0, 'group menu must contain group.newSession')
  assert.ok(newSubgroupIndex >= 0, 'group menu must keep group.newSubgroup')
  assert.ok(newSessionIndex < newSubgroupIndex, 'new session must be the first group menu action')
  assert.match(sessionMenu, /handlers\.openNewSession\(null, menu\.groupId\)/)
  assert.match(sessionMenu, /'data-testid': 'session-groups-group-new-session'/)
  // The plus tooltip keeps its explanatory wording.
  assert.equal(zh['group.addSession'], '在分组内新建会话')
  assert.equal(en['group.addSession'], 'New session in this group')
})

test('0.3.0-beta.71 dialog has an accessible name and restores opener focus', () => {
  assert.match(dialogHost, /'aria-labelledby': 'dsg-dialog-title'/)
  assert.match(dialogHost, /id: 'dsg-dialog-title'/)
  assert.match(dialogHost, /restoreFocusRef/)
})

test('0.3.0-beta.71 dialog traps Tab and handles Escape at the dialog boundary', () => {
  assert.match(dialogHost, /addEventListener\('keydown', onKeyDown, true\)/)
  assert.match(dialogHost, /event\.key === 'Escape'/)
  assert.match(dialogHost, /event\.key !== 'Tab'/)
  assert.match(dialogHost, /event\.shiftKey/)
  assert.match(dialogHost, /focusableSelector/)
})

test('0.3.0-beta.71 dialog exposes keyboard move and resize controls', () => {
  assert.match(dialogHost, /dialog\.moveDialog/)
  assert.match(dialogHost, /dialog\.resizeDialog/)
  assert.match(dialogHost, /session-groups-dialog-titlebar/)
  assert.match(dialogHost, /session-groups-dialog-resizer/)
  assert.match(dialogHost, /dialogKeyboardDelta/)
})

test('0.4.0-beta.65 dialog reuses the focus guard and the measured-rect fallback once', () => {
  assert.match(dialogHost, /dialogRectFromElement\(/)
  assert.match(dialogHost, /resolveDialogRect\(/)
  assert.match(dialogHost, /shouldFocusDialogTarget\(/)
  // Only the [dialog] effect keeps its delayed focus; a second timer in the
  // seed effect would fight the user's own focus on inline-error re-dispatches.
  const delayedFocuses = dialogHost.match(/inputRef\.current\?\.focus\(\)/g) ?? []
  assert.equal(delayedFocuses.length, 1, 'inputRef.current?.focus() must appear exactly once')
})

test('0.3.0-beta.71 group menu supports roving keyboard focus', () => {
  assert.match(sessionMenu, /role: 'menuitem'/)
  assert.match(sessionMenu, /event\.key === 'ArrowDown'/)
  assert.match(sessionMenu, /event\.key === 'ArrowUp'/)
  assert.match(sessionMenu, /event\.key === 'Home'/)
  assert.match(sessionMenu, /event\.key === 'End'/)
  assert.match(sessionMenu, /\.focus\(/)
})


test('0.3.0-beta.73 ungrouped scroll caches layout reads', () => {
  assert.match(componentUngrouped, /scheduleScroll/)
  assert.match(componentUngrouped, /measureLayout/)
  assert.match(componentUngrouped, /ResizeObserver/)
  assert.match(componentUngrouped, /addEventListener\('scroll', scheduleScroll, \{ passive: true \}\)/)
})

test('0.2.9 delete group: destination picker, empty direct path and move-and-delete footer', () => {
  // Group menu keeps the delete entry and the color entry now says 修改颜色/Change color.
  assert.match(sessionMenu, /t\('group\.delete'\)/)
  assert.match(sessionMenu, /t\('group\.color'\)/)
  assert.equal(zh['group.color'], '修改颜色')
  assert.equal(en['group.color'], 'Change color')
  // Non-empty delete dialog: 删除分组 title, counts, destination list and root option.
  assert.match(components, /kind: 'delete-group'/)
  assert.match(components, /titleKey: 'dialog\.deleteGroup'/)
  assert.match(components, /t\('group\.sessionCount'/)
  assert.match(components, /t\('group\.subgroupCount'/)
  assert.match(components, /t\('dialog\.deleteMoveInstruction'/)
  assert.match(components, /session-groups-dialog-delete-body/)
  assert.match(components, /deleteGroupOptions\(store\.doc, dialog\.groupId\)/)
  assert.match(components, /rootLabel: t\('dialog\.rootDestination'\)/)
  assert.match(components, /session-groups-dialog-delete-options/)
  // Group and session moves use separate titles; neither claims to move the session.
  assert.equal(zh['dialog.moveGroup'], '移动分组')
  assert.equal(zh['dialog.moveSession'], '归入分组')
  assert.equal(en['dialog.moveGroup'], 'Move group')
  assert.equal(en['dialog.moveSession'], 'Assign session to group')
  assert.equal(Object.hasOwn(zh, 'dialog.moveTo'), false)
  assert.equal(Object.hasOwn(en, 'dialog.moveTo'), false)
  assert.match(components, /titleKey: 'dialog\.moveGroup'/)
  assert.match(components, /titleKey: 'dialog\.moveSession'/)
  // Footer is danger-styled and says 转移后删除 / Reassign and delete only for this dialog.
  assert.match(components, /dialog\.kind === 'delete-group' \? t\('dialog\.moveAndDelete'\)/)
  assert.equal(zh['dialog.moveAndDelete'], '转移后删除')
  assert.equal(en['dialog.moveAndDelete'], 'Reassign and delete')
  assert.match(components, /data-variant': danger \? 'danger' : 'primary'/)
  // Empty leaf: no dialog, direct runtime commit + toast.
  assert.match(components, /deleteGroupNeedsDialog\(store\.doc, groupId\)/)
  assert.match(components, /deleteGroupDirect\?\.\(groupId\)/)
  const plugin = pluginFamily()
  assert.match(plugin, /const deleteGroupDirect = async \(groupId\)/)
  assert.match(plugin, /'toast\.groupDeleted'/)
  assert.match(plugin, /deleteGroupTo\(latest, dialog\.groupId, payload\.destinationId \?\? null\)/)
  assert.match(plugin, /deleteGroupDirect,/)
  // A destination is mandatory before Confirm: no initial highlight for delete.
  assert.equal(components.includes("t('dialog.deleteBody'"), false)
})

test('0.2.11 dialog hover/focus affordances', () => {
  assert.match(CSS, /\.dsg-dialog-option:hover\s*\{/)
  assert.match(CSS, /\.dsg-dialog-option\[aria-selected="true"\]:hover/)
  assert.match(CSS, /\.dsg-dialog-cancel:hover\s*\{/)
  assert.match(CSS, /\.dsg-dialog-confirm:hover:not\(:disabled\)/)
  assert.match(CSS, /\.dsg-dialog-confirm\[data-variant="danger"\]:hover:not\(:disabled\)/)
  assert.match(CSS, /\.dsg-color-option:hover\s*\{/)
  assert.match(CSS, /\.dsg-color-option\[data-selected="true"\]:hover/)
  assert.match(CSS, /\.dsg-dialog-option:focus-visible/)
})

test('0.2.13 active row, official session watermark and semantic icon sections', () => {
  assert.equal(SESSION_WATERMARK_BASE, 5)
  assert.equal(SESSION_WATERMARK_AUTO_MAX, 50)
  assert.match(components, /mainSessionIdOf\(sessions\)/)
  assert.match(CSS, /\.dsg-session-row\[data-current="true"\][^}]*inset 2px 0 0/)
  assert.match(CSS, /\.dsg-session-row\[data-current="true"\] \.dsg-session-title/)
  assert.match(components, /showSessionOverflow/)
  assert.match(components, /setSessionWatermark/)
  assert.match(components, /session-groups-session-overflow/)
  assert.match(CSS, /\.dsg-session-overflow\s*\{/)
  assert.match(CSS, /\.dsg-session-overflow:hover/)
  assert.equal(zh['sessions.expand'].other, '展开其余 {n} 个会话')
  assert.equal(zh['sessions.expand'].one, '展开其余 {n} 个会话')
  assert.equal(zh['sessions.collapse'], '收起')
  const icons = ICON_GROUPS.flatMap((group) => group.icons)
  for (const icon of ['check-circle', 'check', 'x-circle', 'x', 'pause-circle', 'pause', 'play-circle', 'play', 'stop-circle', 'stop', 'ban']) {
    assert.ok(icons.includes(icon), `missing semantic icon ${icon}`)
  }
  assert.ok(ICON_GROUPS.length >= 6)
  assert.ok(GROUP_ICONS.length >= 70)
  assert.match(CSS, /\.dsg-icon-section-title/)
  assert.match(CSS, /\.dsg-icon-section \+ \.dsg-icon-section/)
})

test('0.2.14 dialog options use roomy padding and standard depth indent', () => {
  const option = CSS.slice(CSS.indexOf('.dsg-dialog-option {'), CSS.indexOf('.dsg-dialog-option {') + 260)
  assert.match(option, /min-height:\s*36px/)
  assert.match(option, /padding:\s*6px 12px/)
  const footer = CSS.slice(CSS.indexOf('.dsg-dialog-confirm {'), CSS.indexOf('.dsg-dialog-confirm {') + 260)
  assert.match(footer, /height:\s*32px/)
  assert.match(footer, /padding:\s*0 16px/)
  assert.match(groupPicker, /paddingLeft:\s*`\$\{12 \+ depth \* 16\}px`/)
  assert.match(CSS, /\.dsg-dialog-list \{[^}]*padding:\s*8px/s)
  assert.match(CSS, /\.dsg-color-option \{[^}]*height:\s*36px/s)
})

test('0.3.0-beta.3 move dialogs insert at the target group head', () => {
  const plugin = pluginFamily()
  assert.match(plugin, /actions\.moveSession\(dialog\.sessionId, payload\.groupId \?\? null, 0\)/)
  assert.match(plugin, /moveGroup\(latest, dialog\.groupId, payload\.groupId \?\? null, 0\)/)
})

test('0.3.0-beta.2 drag floating labels are localized', () => {
  assert.match(components, /t\('drag\.sessionIntoGroup'/)
  assert.match(components, /t\('drag\.sessionOut'\)/)
  assert.equal(components.includes('放入『'), false)
  assert.equal(components.includes('移出分组'), false)
  assert.equal(zh['drag.sessionIntoGroup'], '放入『{name}』')
  assert.equal(en['drag.sessionIntoGroup'], 'Drop into “{name}”')
  assert.equal(zh['drag.sessionOut'], '移出分组')
  assert.equal(en['drag.sessionOut'], 'Remove from group')
})

test('0.2.23 row-boundary dragleave keeps the placeholder while inside the sidebar', () => {
  assert.match(components, /const pointerOutsideRoot = \(event\) =>/)
  assert.match(components, /if \(!pointerOutsideRoot\(event\)\) return/)
  assert.match(components, /visible flicker/)
})

test('0.2.22 group-body gaps do not become group-head drop targets', () => {
  assert.match(components, /querySelector\?\.\('\[data-session-id\]'\)/)
  assert.match(components, /event\.clientY >= firstRect\.top/)
  assert.match(components, /next\.closest\('\.dsg-group-line'\)/)
})

test('0.2.20 session rows are memoized behind a stable handler facade', () => {
  assert.match(components, /const SessionRow = memo\(SessionRowImpl, sessionRowPropsEqual\)/)
  assert.match(components, /const stableHandlers = useMemo\(/)
  assert.match(components, /new Proxy\(/)
  assert.match(components, /handlersRef\.current\?\.\[property\]/)
  assert.match(components, /handlers: stableHandlers, sessionsById: byId/)
  assert.match(components, /handlers: stableHandlers, virtualRef/)
})

test('0.2.19 active-session highlight receives the live view store', () => {
  // The group call is multi-line since the archive freeze added
  // `structuralLocked`; match the whole element instead of one source line.
  const calls = [...components.matchAll(/h\(SessionRow, \{[\s\S]*?\}\)/g)].map((match) => match[0])
  assert.equal(calls.length, 2)
  for (const call of calls) assert.match(call, /\bstore\b/)
})

test('0.2.16 icon set covers devices/actions', () => {
  for (const icon of ['computer', 'phone', 'mail', 'log', 'cpu', 'memory', 'hard-drive', 'server', 'network', 'camera', 'music', 'video', 'wifi', 'map', 'gift']) {
    assert.ok(GROUP_ICONS.includes(icon), `missing icon ${icon}`)
  }
  assert.equal(zh['icon.computer'], '电脑')
  assert.equal(zh['icon.phone'], '手机')
  assert.equal(zh['icon.mail'], '邮箱')
  assert.equal(zh['iconGroup.devices'], '设备')
})

test('0.3.0-beta.74 session menu aligns move-up/down with the group menu', () => {
  const up = sessionMenu.indexOf("t('session.moveUp')")
  const down = sessionMenu.indexOf("t('session.moveDown')")
  assert.ok(up >= 0, 'session menu must contain Move up')
  assert.ok(down > up, 'session menu must place Move down after Move up')
  assert.match(sessionMenu, /handlers\.moveSessionStep\(menu\.sessionId, delta\)/)
  assert.match(sessionMenu, /'data-testid': testid/)
  assert.equal(zh['session.moveUp'], '上移')
  assert.equal(zh['session.moveDown'], '下移')
  assert.equal(en['session.moveUp'], 'Move up')
  assert.equal(en['session.moveDown'], 'Move down')
  assert.match(components, /const moveSessionStep = \(sessionId, delta\)/)
  assert.match(components, /assignSession\(latest, sessionId, container\.groupId, nextIndex\)/)
})

// ---------------------------------------------------------------------------
// 0.4.0 multi-profile switch UI (SPEC §9.1-§9.3 / §9.6-§9.9)
// ---------------------------------------------------------------------------
test('0.4.0 profiles: header chevron is a fixed 24px target beside the title', () => {
  const trigger = block('.dsg-profile-trigger {')
  assert.match(trigger, /flex:\s*none/)
  assert.match(trigger, /width:\s*24px/)
  assert.match(trigger, /height:\s*24px/)
  const menu = block('.dsg-profile-menu {')
  assert.match(menu, /position:\s*relative/)
  assert.match(menu, /display:\s*inline-flex/)
  assert.match(menu, /flex:\s*none/)
  const label = block('.dsg-header-label {')
  assert.match(label, /min-width:\s*0/)
  assert.match(label, /text-overflow:\s*ellipsis/)
  // Tiny sidebar: the collapsed title hides only the label, never the measured
  // `.dsg-header-title` box that drives the flag (spec §6.3/§6.6).
  assert.match(CSS, /\[data-title-collapsed="true"\] \.dsg-header-label \{ display: none; \}/)
  assert.match(CSS, /\.dsg-root\[data-narrow="true"\] \.dsg-header-title \{ gap:\s*2px; \}/)
  assert.match(componentProfiles, /renderGlyph\(h, 'chevronDown', 14\)/)
  assert.match(componentProfiles, /'aria-haspopup': 'menu'/)
  assert.match(componentProfiles, /'aria-expanded': open \? 'true' : 'false'/)
  assert.match(componentProfiles, /'data-testid': 'session-groups-profile-trigger'/)
  assert.match(componentHeader, /h\(ProfileMenu, \{/)
  // The title must not clip the anchored popover anymore.
  assert.equal(/\.dsg-header-title \{[^}]*overflow:\s*hidden/s.test(CSS), false)
})

test('0.4.0 profiles: popover mirrors view-options with a logical anchor and rows', () => {
  // 0.4.0-beta.64: the anchor edge moved to JS (logical `inline-start`), so the
  // block keeps only the border-box cap and the content surface.
  const popover = block('.dsg-profile-popover {')
  assert.equal(/left:\s*0/.test(popover), false)
  assert.equal(/right:\s*auto/.test(popover), false)
  assert.match(popover, /box-sizing:\s*border-box/)
  assert.match(popover, /min-width:\s*220px/)
  assert.match(popover, /max-width:\s*min\(300px, calc\(100vw - 16px\)\)/)
  assert.match(popover, /max-height:\s*60vh/)
  assert.match(popover, /overflow-y:\s*auto/)
  assert.match(componentProfiles, /dsg-view-options-popover dsg-profile-popover/)
  assert.match(componentProfiles, /role: 'menuitemradio'/)
  assert.match(componentProfiles, /'aria-checked': active \? 'true' : 'false'/)
  assert.match(componentProfiles, /'data-testid': 'session-groups-profile-item'/)
  assert.match(componentProfiles, /t\('profiles\.counts'/)
  assert.match(componentProfiles, /renderGlyph\(h, 'check', 14\)/)
  assert.match(block('.dsg-profile-item[data-active="true"] {'), /font-weight:\s*600/)
  assert.match(block('.dsg-profile-item:disabled {'), /opacity:\s*\.45/)
  assert.match(CSS, /\.dsg-profile-warning \{/)
  // SPEC §9.2 defers the save-as/manage footer to S7; the class exists for it.
  assert.match(CSS, /\.dsg-profile-footer \{/)
})

test('0.4.0 profiles: preview dialog is wider, scrolls and reuses DialogHost chrome', () => {
  assert.match(CSS, /\.dsg-dialog\[data-kind="profile-preview"\] \{ width:\s*min\(560px, calc\(100vw - 24px\)\); padding:\s*12px; gap:\s*8px; \}/)
  assert.match(dialogHost, /dialog\.kind === 'profile-preview'/)
  assert.match(dialogHost, /ProfilePreviewBody/)
  assert.match(dialogHost, /ProfilePreviewActions/)
  assert.match(dialogHost, /'aria-labelledby': 'dsg-dialog-title'/)
  assert.match(componentProfiles, /'data-testid': 'session-groups-profile-preview'/)
  assert.match(componentProfiles, /'data-testid': 'session-groups-profile-preview-confirm'/)
  assert.match(componentProfiles, /'data-testid': 'session-groups-profile-preview-cancel'/)
  assert.match(componentProfiles, /'data-testid': 'session-groups-profile-preview-disable'/)
  assert.match(componentProfiles, /dsh-session-grove\.profilePreview\.v1/)
  // DialogHost owns Escape/Tab; the profile module must not add its own dialog Escape.
  assert.doesNotMatch(componentProfiles, /event\.key === 'Escape'/)
  assert.match(componentProfiles, /profiles\.preview\.staleRefresh/)
  assert.match(componentProfiles, /profiles\.preview\.ungroupedWarning/)
  assert.match(componentProfiles, /slice\(0, 8\)/)
  assert.match(CSS, /\.dsg-profile-preview-auto \{[^}]*margin-right:\s*auto/s)
  // 0.4.0-beta.64: the physical RTL edge override is gone (the logical edge is
  // resolved in JS); the row alignment override stays.
  assert.equal(CSS.includes('.dsg-root[dir="rtl"] .dsg-profile-popover'), false)
  assert.match(CSS, /\.dsg-root\[dir="rtl"\] \.dsg-profile-item \{ text-align:\s*right; \}/)
})

test('0.4.0 profiles: preview diff uses a two-level hierarchy and a capped scrolling height', () => {
  // Preview-only space: 560px clamped to the viewport, tighter padding/gap.
  const previewDialog = block('.dsg-dialog[data-kind="profile-preview"] {')
  assert.match(previewDialog, /width:\s*min\(560px, calc\(100vw - 24px\)\)/)
  assert.match(previewDialog, /padding:\s*12px/)
  assert.match(previewDialog, /gap:\s*8px/)

  // Top summary: still three inline stats on one wrapping line.
  const summary = block('.dsg-profile-preview-summary {')
  assert.match(summary, /display:\s*flex/)
  assert.match(summary, /flex-wrap:\s*wrap/)
  assert.match(summary, /gap:\s*2px 10px/)
  assert.match(summary, /padding:\s*6px 8px/)
  assert.match(block('.dsg-profile-preview-summary-stat {'), /display:\s*inline-flex/)
  assert.match(CSS, /\.dsg-profile-preview-summary-stat \+ \.dsg-profile-preview-summary-stat::before \{ content: '·';/)
  assert.equal(CSS.includes('.dsg-profile-preview-summary-row'), false)
  assert.match(componentProfiles, /class: 'dsg-profile-preview-summary-stat', 'data-stat': key/)
  assert.equal(componentProfiles.includes("'dsg-profile-preview-summary-row'"), false)

  // Warning: 11/15 with an inline hint + noDelete pair that may share a line.
  const warning = block('.dsg-profile-preview-warning {')
  assert.match(warning, /display:\s*flex/)
  assert.match(warning, /flex-wrap:\s*wrap/)
  assert.match(warning, /padding:\s*6px 8px/)
  assert.match(warning, /font-size:\s*var\(--dsg-font-11, 11px\)/)
  assert.match(warning, /line-height:\s*15px/)
  assert.match(block('.dsg-profile-preview-warning-note {'), /color:\s*var\(--dsw-alias-label-secondary/)

  // Section > block > indented list: two title levels plus a tree guide line.
  const sectionDivider = block('.dsg-profile-preview-section + .dsg-profile-preview-section {')
  assert.match(sectionDivider, /border-top:\s*1px solid/)
  assert.match(sectionDivider, /padding-top:\s*8px/)
  assert.match(block('.dsg-profile-preview-section-title {'), /font-size:\s*var\(--dsg-font-12, 12px\)/)
  const blockLabel = block('.dsg-profile-preview-block-label {')
  assert.match(blockLabel, /font-size:\s*var\(--dsg-font-11, 11px\)/)
  assert.match(blockLabel, /line-height:\s*16px/)
  assert.match(blockLabel, /color:\s*var\(--dsw-alias-label-secondary/)
  const blockDivider = block('.dsg-profile-preview-block + .dsg-profile-preview-block {')
  assert.match(blockDivider, /border-top:\s*1px solid/)
  assert.match(blockDivider, /padding-top:\s*5px/)

  const list = block('.dsg-profile-preview-list {')
  assert.match(list, /gap:\s*0/)
  assert.match(list, /margin-inline-start:\s*10px/)
  assert.match(list, /padding-inline-start:\s*8px/)
  assert.match(list, /border-inline-start:\s*1px solid/)
  const change = block('.dsg-profile-preview-change {')
  assert.match(change, /gap:\s*1px/)
  assert.match(change, /padding:\s*8px 0/)
  // Adjacent changes are separated by a hairline using the shared border token;
  // the adjacent-sibling selector leaves the first row borderless.
  const changeDivider = block('.dsg-profile-preview-change + .dsg-profile-preview-change {')
  assert.match(changeDivider, /border-top:\s*1px solid var\(--dsw-alias-border-l2/)
  assert.equal(change.includes('border-top'), false)

  // 13/19 title, 12/17 indented detail, every title/path wraps (no ellipsis).
  const title = block('.dsg-profile-preview-change-title {')
  assert.match(title, /font-size:\s*var\(--dsg-font-13, 13px\)/)
  assert.match(title, /line-height:\s*19px/)
  assert.match(title, /white-space:\s*normal/)
  assert.match(title, /overflow-wrap:\s*anywhere/)
  assert.equal(title.includes('text-overflow'), false)
  const detail = block('.dsg-profile-preview-change-detail {')
  assert.match(detail, /display:\s*flex/)
  assert.match(detail, /flex-wrap:\s*wrap/)
  assert.match(detail, /font-size:\s*var\(--dsg-font-12, 12px\)/)
  assert.match(detail, /line-height:\s*17px/)
  assert.match(detail, /margin-inline-start:\s*12px/)
  assert.match(detail, /overflow-wrap:\s*anywhere/)
  assert.equal(detail.includes('nowrap'), false)
  assert.match(
    CSS,
    /\.dsg-profile-preview-path-old \{ color:\s*var\(--dsw-alias-label-secondary, CanvasText\); text-decoration:\s*line-through; text-decoration-thickness:\s*1px; overflow-wrap:\s*anywhere; \}/
  )
  assert.match(
    CSS,
    /\.dsg-profile-preview-path-new \{ color:\s*var\(--dsw-alias-label-primary, CanvasText\); font-weight:\s*500; overflow-wrap:\s*anywhere; \}/
  )
  assert.match(block('.dsg-profile-preview-arrow {'), /color:\s*var\(--dsw-alias-label-tertiary/)

  // Added/removed paths read as success/danger; markers carry + / − / ~.
  assert.match(
    CSS,
    /\.dsg-profile-preview-change\[data-kind="added"\] \.dsg-profile-preview-path-new \{ color:\s*var\(--dsw-alias-state-success/
  )
  assert.match(
    CSS,
    /\.dsg-profile-preview-change\[data-kind="removed"\] \.dsg-profile-preview-path-old \{ color:\s*var\(--dsw-alias-state-danger/
  )
  assert.match(componentProfiles, /class: 'dsg-profile-preview-change', 'data-kind': change\.kind/)
  assert.match(componentProfiles, /class: 'dsg-profile-preview-change-title'/)
  assert.match(componentProfiles, /class: 'dsg-profile-preview-change-detail'/)
  assert.match(componentProfiles, /class: 'dsg-profile-preview-path-old'/)
  assert.match(componentProfiles, /class: 'dsg-profile-preview-path-new'/)
  assert.match(componentProfiles, /class: 'dsg-profile-preview-arrow'/)
  assert.match(componentProfiles, /changeMarker\('\+', 'marker'\)/)
  assert.match(componentProfiles, /changeMarker\('−', 'marker'\)/)
  assert.match(componentProfiles, /changeMarker\('~', 'marker'\)/)

  // Initial geometry: 560px width fallback, a viewport-clamped 320px floor and a
  // viewport-clamped 560px ceiling, so a long diff scrolls inside the body
  // instead of stretching the dialog past the screen.
  assert.match(dialogHost, /box\.width \|\| \(isProfilePreview \? 560 : wideKind \? 420 : 360\)/)
  assert.match(
    dialogHost,
    /Math\.min\(\s*Math\.max\(naturalHeight, Math\.min\(Math\.max\(0, globalThis\.innerHeight - 24\), 320\)\),\s*Math\.min\(560, Math\.max\(0, globalThis\.innerHeight - 24\)\)\s*\)/
  )
  assert.match(dialogHost, /centeredDialogRect\(/)
  assert.match(dialogHost, /clampDialogRect\(/)
  // The fixed-height dialog keeps drag/resize/persistence; its body owns the
  // scroll, so the scroll area must shrink below its content.
  const positionedScrollArea = block('.dsg-dialog[data-positioned="true"] > .dsg-scroll-area {')
  assert.match(positionedScrollArea, /flex:\s*1 1 auto/)
  assert.match(positionedScrollArea, /min-height:\s*0/)
  assert.match(block('.dsg-dialog[data-positioned="true"] .dsg-dialog-content {'), /flex:\s*1 1 auto/)
  assert.match(block('.dsg-dialog-content {'), /overflow-y:\s*auto/)

  // RTL: list indent/dividers use logical properties; only the flow arrow flips.
  assert.match(
    CSS,
    /\.dsg-root\[dir="rtl"\] \.dsg-profile-preview-auto \{ margin-right:\s*0; margin-left:\s*auto; \}/
  )
  assert.match(
    CSS,
    /\.dsg-root\[dir="rtl"\] \.dsg-profile-preview-arrow \{ transform:\s*scaleX\(-1\); \}/
  )
})

test('0.4.0 profiles: toast action keeps the old text toast and adds a button', () => {
  assert.match(sessionMenu, /session-groups-toast-action/)
  assert.match(sessionMenu, /action\.onClick\?\.\(\)/)
  assert.match(block('.dsg-toast-action {'), /text-decoration:\s*underline/)
  assert.match(plugin, /duration:\s*Number\.isFinite\(action\.duration\) \? action\.duration : 5000/)
  assert.match(plugin, /storedAction \? storedAction\.duration : 2600/)
  assert.match(plugin, /profiles\.switchedElsewhere/)
})

test('0.4.0 profiles: save-as/manage footer and dialogs reuse the dialog chrome', () => {
  // SPEC §9.2 footer: divider + two rows, capped save-as and always-reachable manage.
  assert.match(componentProfiles, /'data-testid': 'session-groups-profile-footer'/)
  assert.match(componentProfiles, /'data-testid': 'session-groups-profile-save-as'/)
  assert.match(componentProfiles, /'data-testid': 'session-groups-profile-manage'/)
  assert.match(componentProfiles, /t\('profiles\.limit', \{ max: limit \}\)/)
  assert.match(block('.dsg-profile-footer-button:disabled {'), /opacity:\s*\.45/)
  // S6 review carry #2: the header's nowrap must not leak into the popover.
  assert.match(block('.dsg-profile-popover {'), /white-space:\s*normal/)
  // SPEC §9.4/§9.5 dialog bodies, widths and manage rows.
  assert.match(CSS, /\.dsg-dialog\[data-kind="profile-manage"\] \{ width:\s*min\(420px/)
  assert.match(CSS, /\.dsg-dialog\[data-kind="profile-save-as"\]/)
  assert.match(CSS, /\.dsg-dialog\[data-kind="profile-rename"\]/)
  assert.match(CSS, /\.dsg-dialog\[data-kind="profile-archive"\]/)
  assert.match(block('.dsg-profile-manage-row {'), /border-radius:\s*6px/)
  assert.match(block('.dsg-profile-manage-reset {'), /display:\s*inline-flex/)
  assert.match(CSS, /\.dsg-root\[dir="rtl"\] \.dsg-profile-footer-button \{ text-align:\s*right; \}/)
  assert.match(componentProfileDialogs, /'data-testid': 'session-groups-profile-save-as-name'/)
  assert.match(componentProfileDialogs, /'data-testid': 'session-groups-profile-save-as-preview'/)
  assert.match(componentProfileDialogs, /'data-testid': 'session-groups-profile-manage-dialog'/)
  assert.match(componentProfileDialogs, /'data-testid': 'session-groups-profile-manage-row'/)
  assert.match(componentProfileDialogs, /'data-testid': 'session-groups-profile-rename'/)
  assert.match(componentProfileDialogs, /'data-testid': 'session-groups-profile-archive'/)
  assert.match(componentProfileDialogs, /'data-testid': 'session-groups-profile-preview-reset'/)
  assert.match(componentProfileDialogs, /profiles\.copySuffix/)
  assert.match(componentProfileDialogs, /profiles\.createPreview/)
  assert.match(componentProfileDialogs, /readProfilePreviewDisabled/)
  assert.match(componentProfileDialogs, /writeProfilePreviewDisabled/)
  // The plugin maps host write codes onto the reused inline copy keys.
  assert.match(plugin, /const profileDialogError = \(code\)/)
  assert.match(plugin, /profile-name-duplicate'\) return 'profiles\.nameDuplicate'/)
  assert.match(plugin, /profile-name-invalid'\) return 'profiles\.nameInvalid'/)
  // DialogHost owns the new kinds, the wide manage rect and the shared Escape.
  assert.match(dialogHostProfile, /'profile-save-as'/)
  assert.match(dialogHostProfile, /'profile-manage'/)
  assert.match(dialogHostProfile, /'profile-rename'/)
  assert.match(dialogHostProfile, /'profile-archive'/)
  assert.match(dialogHostProfile, /ProfileSaveAsBody/)
  assert.match(dialogHostProfile, /ProfileManageBody/)
  assert.match(dialogHostProfile, /dialog\.returnTo === 'profile-manage'/)
  assert.match(dialogHostProfile, /dialog\.kind === 'profile-manage'/)
  // The shell facade registers every open/confirm entry.
  assert.match(components, /createProfileDialogHandlers\(\{ t \}\)/)
  // S6 review carry #3: unique keys for the stale preview section and notice.
  assert.match(componentProfiles, /key: 'stale-section'/)
  assert.match(componentProfiles, /key: 'stale-notice'/)
  // S6 review carry #4: activation rechecks pending/epoch after the preview.
  assert.match(componentProfiles, /epochAtStart/)
  assert.match(componentProfiles, /latest\.profileEpoch \?\? 0\) !== epochAtStart/)
  // S6 review carry #4: undo/recover preview calls are guarded.
  assert.match(componentProfiles, /catch \{\s*preview = \{ ok: false, code: 'network' \}/)
})

test('0.4.0 profiles: save-as echo is local and archive refresh is forced', () => {
  // A save-as create activates its copy host-side before the HTTP response
  // lands: the SSE `active` echo must be treated as local while the request is
  // in flight, and the flag must be cleared on both success and failure so a
  // later switch from another window is still announced.
  assert.match(plugin, /let createInFlight = false/)
  assert.match(plugin, /createInFlight = true/)
  assert.match(plugin, /createInFlight = false/)
  assert.match(plugin, /const isLocalSwitch = \(activeId\) =>\s*createInFlight \|\|/)
  assert.match(plugin, /if \(info\.local\) return/)
  // Forced list reads bypass the in-flight slot and drop the older response,
  // so the manage list cannot be repopulated by a read started before archive.
  assert.match(
    plugin,
    /const refreshProfiles = \(\{ background = false, includeArchived = false, force = false \}/
  )
  assert.match(plugin, /if \(!force && inFlight !== null\) return inFlight/)
  assert.match(plugin, /profiles\.list\.stale/)
  assert.match(plugin, /refreshProfiles\(\{ background: true, force: true \}\)/)
  assert.match(plugin, /refreshProfiles\(\{ background: true, includeArchived: true, force: true \}\)/)
  // The last-profile tooltip uses the registry cap, never the remaining rows.
  assert.match(componentProfileDialogs, /!canArchiveAnother\s*\?\s*t\('profiles\.limit', \{ max \}\)/s)
  assert.doesNotMatch(componentProfileDialogs, /max: list\.length/)
  // The default copy name is shortened/numbered before the dialog renders so a
  // taken default never opens as nameDuplicate with Create disabled.
  assert.match(componentProfileDialogs, /PROFILE_NAME_MAX - tail\.length - 1/)
})

test('0.4.0-beta.65 plugin host shell returns exactly the 21 documented keys', () => {
  // S2 split the command layer out but kept the host surface frozen: the shell
  // literal return block is the single place the 21 keys are assembled.
  const source = pluginHostShell().replace(/\r\n/g, '\n')
  const block = source.match(/\n  return \{\n([\s\S]*?)\n  \}\n\}/)
  assert.ok(block, 'the shell keeps a literal return block')
  const keys = block[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/^([A-Za-z_$][\w$]*)\s*[,:]/)?.[1])
  assert.deepEqual(keys, [
    'mount',
    'dispose',
    'actions',
    'capabilities',
    'archiveSession',
    'unarchiveSession',
    'forkSession',
    'copySessionId',
    'archiveGroup',
    'unarchiveGroup',
    'openDialog',
    'newSessionInGroup',
    'reconcileNewSessionGroup',
    'confirmDialog',
    'deleteGroupDirect',
    'setArchiveFilter',
    'setGroupArchiveFilter',
    'resetLayout',
    'setMode',
    'toggleMode',
    'applyEpoch',
  ])
  // No spread: every command key is forwarded literally, so a new key can
  // never leak into the host surface silently.
  assert.doesNotMatch(block[1], /\.\.\./)
  // The moved layer still owns the factory and the follow guard.
  assert.match(pluginHostCommands(), /export const createHostCommands = \(/)
  assert.match(pluginHostCommands(), /const installFollowGuard = \(\) =>/)
})
