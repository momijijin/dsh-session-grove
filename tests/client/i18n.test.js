import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { dictionaries, en, ja, zh } from '../../src/client/locale.js'

const root = new URL('../..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1))
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  )

const literalKeys = () => {
  const keys = new Set()
  for (const file of walk(join(root, 'src', 'client')).filter((path) => path.endsWith('.js'))) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)) keys.add(match[2])
  }
  return [...keys].sort()
}

const placeholders = (value) => [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

test('every packaged dictionary has the same keys, placeholders and no empty values', () => {
  const reference = Object.keys(en).sort()
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    assert.deepEqual(Object.keys(dictionary).sort(), reference, `${language} key set`)
    for (const key of reference) {
      if (key === 'meta') {
        for (const field of ['title', 'description']) {
          assert.equal(typeof dictionary.meta?.[field], 'string', `${language} meta.${field} must be a string`)
          assert.notEqual(dictionary.meta[field].trim(), '', `${language} meta.${field} must not be empty`)
        }
        continue
      }
      const value = dictionary[key]
      const referenceValue = en[key]
      if (referenceValue !== null && typeof referenceValue === 'object') {
        assert.equal(typeof value, 'object', `${language} ${key} must be a plural object`)
        const categories = Object.keys(value)
        assert.ok(categories.includes('other'), `${language} ${key} must include other`)
        for (const category of Object.keys(referenceValue)) {
          assert.equal(typeof value[category], 'string', `${language} ${key}.${category} must be a string`)
        }
        for (const category of categories) {
          const referenceCategory = referenceValue[category] ?? referenceValue.other
          assert.equal(typeof value[category], 'string', `${language} ${key}.${category} must be a string`)
          assert.notEqual(value[category].trim(), '', `${language} ${key}.${category} must not be empty`)
          assert.deepEqual(placeholders(value[category]), placeholders(referenceCategory), `${language} ${key}.${category} placeholders`)
        }
        continue
      }
      assert.equal(typeof value, 'string', `${language} ${key} must be a string`)
      assert.notEqual(value.trim(), '', `${language} ${key} must not be empty`)
      assert.deepEqual(placeholders(value), placeholders(referenceValue), `${language} ${key} placeholders`)
    }
  }
})

test('every literal client translation key exists in every dictionary', () => {
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    const missing = literalKeys().filter((key) => !(key in dictionary))
    assert.deepEqual(missing, [], `${language} missing literal keys`)
  }
})

test('dynamic keys used by status, archive, settings and errors are present', () => {
  const dynamic = [
    'archive.hidden',
    'archive.all',
    'archive.only',
    'archive.group.hidden',
    'archive.group.all',
    'archive.group.only',
    'archive.section.sessions',
    'archive.section.groups',
    'profiles.preview.archiveChanged',
    'group.archivedLocked',
    'group.containsArchived',
    'group.archivedEmpty',
    'group.archive',
    'group.unarchive',
    'session.structuralLocked',
    'menu.groupArchivedLocked',
    'menu.groupContainsArchivedLocked',
    'menu.sessionStructuralLocked',
    'menu.groupPositionLocked',
    'drag.invalidTarget',
    'drag.archivedContainer',
    'drag.archivedDestination',
    'drag.archivedSource',
    'drag.archivedSourceSubtree',
    'drag.archivedAnchor',
    'drag.dropRejected',
    'dialog.archiveGroup',
    'dialog.archiveGroupBody',
    'dialog.archiveGroupConfirm',
    'dialog.archiveGroupDontAsk',
    'dialog.groupArchived',
    'dialog.groupContainsArchived',
    'dialog.groupPositionLocked',
    'dialog.archiveFrozen',
    'dialog.destinationArchived',
    'toast.groupArchived',
    'toast.groupUnarchived',
    'toast.groupArchivedHidden',
    'toast.groupUnarchivedHidden',
    'toast.showArchivedGroups',
    'toast.showAllGroups',
    'toast.createdInvisible',
    'toast.movedInvisible',
    'toast.moveGroupAppended',
    'toast.archiveFrozen',
    'search.hiddenInArchived',
    'search.hiddenOutsideArchived',
    'search.showArchivedGroups',
    'search.showAllGroups',
    'search.hiddenTarget',
    'empty.archivedHiddenTitle',
    'empty.archivedHiddenBody',
    'empty.onlyNoArchivedTitle',
    'empty.onlyNoArchivedBody',
    'empty.showArchivedGroups',
    'empty.showAllGroups',
    'banner.archive-frozen',
    'status.idle',
    'status.running',
    'status.completed',
    'status.waitingApproval',
    'status.planReview',
    'status.waitingAnswer',
    'status.compact.approval',
    'status.compact.planReview',
    'status.compact.answer',
    'status.subagentsRunning',
    'iconGroup.status',
    'iconGroup.work',
    'iconGroup.devices',
    'iconGroup.actions',
    'iconGroup.life',
    'iconGroup.general',
    'time.justNow',
    'time.minutes',
    'time.hours',
    'time.days',
    'time.years',
    'banner.registration-failed',
    'banner.loadFailed',
    'banner.routeUnavailable',
    'session.archived',
    'config.title',
    'config.hint',
    'config.details.diagnostics',
    'config.details.debugProbe',
    'config.details.controlApi',
    'config.details.controlDestructive',
    'config.details.controlSessions',
    'config.detailsLabel',
    'skill.repairTitle',
    'skill.repairBody',
    'skill.repairButton',
    'skill.repairRunning',
    'skill.repairOk',
    'skill.repairFailed',
  ]
  for (const key of dynamic) {
    for (const [language, dictionary] of Object.entries(dictionaries)) {
      const value = dictionary[key]
      if (value !== null && typeof value === 'object') {
        assert.equal(typeof value.other, 'string', `${language} missing ${key}.other`)
      } else {
        assert.equal(typeof value, 'string', `${language} missing ${key}`)
      }
    }
  }
})

test('plugin manifest exposes localized title and description', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'dsh.plugin.json'), 'utf8'))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  for (const language of Object.keys(dictionaries)) {
    assert.equal(typeof manifest.title?.[language], 'string', `manifest title ${language}`)
    assert.equal(typeof manifest.description?.[language], 'string', `manifest description ${language}`)
  }
  assert.equal(zh.title, '自由分组')
  assert.equal(en.title, 'Free Groups')
  assert.equal(ja.title, 'フリーグループ')
  assert.equal(zh.meta.title, '自由分组')
  assert.equal(en.meta.title, 'Free Groups')
  assert.equal(ja.meta.title, 'フリーグループ')
  assert.equal(typeof zh.meta.description, 'string')
  assert.equal(typeof en.meta.description, 'string')
  assert.equal(typeof ja.meta.description, 'string')
  assert.equal(pkg.icon, 'assets/icon-180.png')
  assert.equal(pkg.files.includes('assets/icon-180.png'), true)
  assert.equal(existsSync(join(root, 'assets', 'icon-180.png')), true)
})
