/**
 * Group/session dialog bodies: delete/archive/move plus the icon and color
 * option grids. The modal shell in dialog-host.js owns the chrome, effects,
 * geometry and footer; these builders only render body nodes and report the
 * chosen value or option through callbacks.
 */
import { createElement } from 'react'
import { deleteGroupDestinationVerdict, deleteGroupOptions, isArchiveErrorCode, moveGroupOptions, moveSessionOptions } from '../core/dialog-selection.js'
import { GROUP_COLORS, GROUP_COLOR_HEX } from '../shared/constants.js'
import { isColorHex, normalizeColorHex } from '../shared/model.js'
import { formatActivity } from './actions.js'
import { GroupListPicker } from './group-list-picker.js'
import { ICON_GROUPS, renderGlyph, renderIcon } from './icons.js'
import { ScrollArea } from './scroll-area.js'

const h = createElement

/**
 * Copy keys for the 0.4.0-beta.62 archive dialogs and disabled destinations
 * (resources ship in P10). Computed maps keep the i18n literal-key guard green.
 */
const DIALOG_KEYS = Object.freeze({
  archiveBody: 'dialog.archiveGroupBody',
  archiveConfirm: 'dialog.archiveGroupConfirm',
})

const DESTINATION_REASON_KEYS = Object.freeze({
  'group-archived': 'dialog.destinationArchived',
  'group-contains-archived': 'dialog.destinationArchived',
  'group-destination-archived': 'dialog.destinationArchived',
  'group-position-locked': 'dialog.groupPositionLocked',
})
const DEFAULT_DESTINATION_REASON_KEY = 'dialog.destinationArchived'

/** Body nodes for one group/session dialog kind (`[]` for every other kind). */
const groupDialogBody = ({
  store,
  t,
  dialog,
  selection,
  onSelect,
  dontAskAgain,
  onDontAskAgain,
  hexInput,
  onHexInput,
  onClose,
}) => {
  const bodyNodes = []
  if (dialog.kind === 'delete-group') {
    const options = deleteGroupOptions(store.doc, dialog.groupId)
    // N5: the implicit root/ungrouped destination is validated with the same
    // candidate-document invariant; a frozen-anchor shift disables it instead of
    // silently relocating elsewhere.
    const rootVerdict = deleteGroupDestinationVerdict(store.doc, dialog.groupId, null)
    const rootDisabled = !rootVerdict.ok && isArchiveErrorCode(rootVerdict.reason)
    bodyNodes.push(
      h(
        'div',
        { class: 'dsg-dialog-body dsg-dialog-delete-counts', 'data-testid': 'session-groups-dialog-delete-body' },
        h(
          'span',
          { 'data-testid': 'session-groups-dialog-delete-sessions' },
          t('group.sessionCount', { n: dialog.sessionCount ?? 0 }),
        ),
        h(
          'span',
          { 'data-testid': 'session-groups-dialog-delete-groups' },
          t('group.subgroupCount', { n: dialog.childCount ?? 0 }),
        ),
      )
    )
    bodyNodes.push(
      h(
        'div',
        { class: 'dsg-dialog-body', 'data-testid': 'session-groups-dialog-delete-instruction' },
        t('dialog.deleteMoveInstruction'),
      )
    )
    bodyNodes.push(h('div', { class: 'dsg-dialog-body' }, t('dialog.deleteDestination')))
    bodyNodes.push(
      h(GroupListPicker, {
        options,
        selection,
        onSelect,
        rootLabel: t('dialog.rootDestination'),
        ariaLabel: t('dialog.deleteDestination'),
        rootDisabled,
        rootReason: rootDisabled
          ? DESTINATION_REASON_KEYS[rootVerdict.reason] ?? DEFAULT_DESTINATION_REASON_KEY
          : null,
        testId: 'session-groups-dialog-delete-options',
      })
    )
  }
  if (dialog.kind === 'archive-group') {
    bodyNodes.push(
      h(
        'div',
        { class: 'dsg-dialog-body', 'data-testid': 'session-groups-dialog-archive-body' },
        t(DIALOG_KEYS.archiveBody)
      )
    )
    // Footer-level opt-out: checked means "skip the confirm next time", and only
    // a successful archive persists it (cancel/failure leave storage untouched).
    bodyNodes.push(
      h(
        'label',
        { class: 'dsg-dialog-check' },
        h('input', {
          type: 'checkbox',
          checked: dontAskAgain,
          'data-testid': 'session-groups-dialog-archive-dont-ask',
          onChange: (event) => onDontAskAgain(event.target.checked === true),
        }),
        h('span', { class: 'dsg-dialog-check-label' }, t('dialog.archiveGroupDontAsk'))
      )
    )
  }
  if (dialog.kind === 'archive-running') bodyNodes.push(h('div', { class: 'dsg-dialog-body' }, t('dialog.archiveRunningBody', { families: formatActivity(dialog.activity) })))
  if (dialog.kind === 'move-session' || dialog.kind === 'move-group') {
    const options = dialog.kind === 'move-group' ? moveGroupOptions(store.doc, dialog.groupId) : moveSessionOptions(store.doc)
    bodyNodes.push(h(GroupListPicker, {
      options,
      selection,
      onSelect,
      allowRoot: dialog.kind !== 'move-group',
    }))
  }
  if (dialog.kind === 'icon') {
    const icons = Array.isArray(dialog.icons) ? dialog.icons : []
    const available = new Set(icons)
    const sections = ICON_GROUPS.map((section) => ({
      ...section,
      icons: section.icons.filter((icon) => available.has(icon)),
    })).filter((section) => section.icons.length > 0)
    const grouped = new Set(sections.flatMap((section) => section.icons))
    const leftovers = icons.filter((icon) => !grouped.has(icon))
    if (leftovers.length > 0) {
      const general = sections.find((section) => section.key === 'general')
      if (general) general.icons.push(...leftovers)
      else sections.push({ key: 'general', labelKey: 'iconGroup.general', icons: leftovers })
    }
    const iconButton = (icon) => {
      const active = selection === icon
      return h(
        'button',
        {
          key: icon,
          type: 'button',
          role: 'radio',
          'aria-checked': active ? 'true' : 'false',
          class: 'dsg-menu-item dsg-dialog-option dsg-icon-option',
          'data-testid': 'session-groups-dialog-icon',
          'data-icon': icon,
          'data-selected': active ? 'true' : 'false',
          title: t(`icon.${icon}`),
          onClick: (event) => {
            event.stopPropagation()
            onSelect(icon)
          },
        },
        renderIcon(h, icon, 16),
        h('span', { class: 'dsg-dialog-option-label' }, t(`icon.${icon}`))
      )
    }
    bodyNodes.push(
      h(
        ScrollArea,
        {
          className: 'dsg-icon-sections',
          'data-testid': 'session-groups-dialog-options',
          'aria-label': t('group.icon'),
        },
        ...sections.map((section, index) =>
          h(
            'section',
            {
              key: section.key,
              class: 'dsg-icon-section',
              'data-icon-group': section.key,
              'aria-label': t(section.labelKey),
            },
            h(
              'div',
              { class: 'dsg-icon-section-title' },
              t(section.labelKey)
            ),
            h(
              'div',
              {
                class: 'dsg-menu dsg-dialog-icon-grid',
                role: 'radiogroup',
                'aria-label': t(section.labelKey),
              },
              ...section.icons.map(iconButton)
            )
          )
        )
      )
    )
  }
  if (dialog.kind === 'group-color') {
    const customActive = isColorHex(selection)
    const hexValid = normalizeColorHex(hexInput) !== null
    const nativeValue = normalizeColorHex(hexInput) ?? (isColorHex(selection) ? selection : GROUP_COLOR_HEX[selection] ?? GROUP_COLOR_HEX.blue)
    const pickPreset = (color) => {
      onSelect(color)
      onHexInput('')
    }
    const changeHex = (raw) => {
      onHexInput(raw)
      const hex = normalizeColorHex(raw)
      onSelect(hex ?? undefined)
    }
    const pickNative = (raw) => {
      const hex = normalizeColorHex(raw)
      if (!hex) return
      onHexInput(hex)
      onSelect(hex)
    }
    const hint = hexInput.trim() === '' || hexValid ? t('color.hint') : t('color.invalidHex')
    bodyNodes.push(
      h(
        'div',
        {
          class: 'dsg-color-grid',
          role: 'radiogroup',
          'data-testid': 'session-groups-dialog-options',
          'aria-label': t('dialog.groupColor'),
        },
        ...GROUP_COLORS.map((color) => {
          const active = selection === color
          return h(
            'button',
            {
              key: color,
              type: 'button',
              role: 'radio',
              'aria-checked': active ? 'true' : 'false',
              class: 'dsg-dialog-option dsg-color-option',
              'data-testid': 'session-groups-dialog-color',
              'data-color': color,
              'data-selected': active ? 'true' : 'false',
              title: t(`color.${color}`),
              onClick: (event) => {
                event.stopPropagation()
                pickPreset(color)
              },
            },
            h('span', { class: 'dsg-color-swatch', 'aria-hidden': 'true', style: { background: `var(--dsg-color-${color})` } }),
            h('span', { class: 'dsg-dialog-option-label' }, t(`color.${color}`)),
            // 0.2.7: the check slot is always present and only hidden, so the
            // label column never shifts when selection moves between cells.
            h(
              'span',
              {
                class: 'dsg-dialog-option-check',
                'data-testid': 'session-groups-dialog-color-check',
                'data-empty': active ? 'false' : 'true',
                'aria-hidden': 'true',
                style: { visibility: active ? 'visible' : 'hidden' },
              },
              renderGlyph(h, 'check', 16)
            )
          )
        })
      )
    )
    bodyNodes.push(
      h(
        'div',
        { class: 'dsg-color-custom-row', 'data-selected': customActive ? 'true' : 'false' },
        h('span', { class: 'dsg-color-custom-label' }, t('color.custom')),
        h('input', {
          type: 'color',
          class: 'dsg-color-native',
          'data-testid': 'session-groups-dialog-color-native',
          'aria-label': t('color.custom'),
          value: nativeValue,
          onChange: (event) => pickNative(event.target.value),
        }),
        h('input', {
          type: 'text',
          class: 'dsg-dialog-input dsg-color-hex',
          'data-testid': 'session-groups-dialog-color-hex',
          maxlength: '7',
          spellcheck: 'false',
          autocomplete: 'off',
          placeholder: '#RRGGBB',
          'aria-label': t('color.customHex'),
          value: hexInput,
          onChange: (event) => changeHex(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape') onClose()
          },
        })
      )
    )
    bodyNodes.push(
      h(
        'div',
        {
          class: 'dsg-color-hint',
          'data-testid': 'session-groups-dialog-color-hint',
          'data-tone': hexInput.trim() !== '' && !hexValid ? 'error' : 'hint',
          'aria-live': 'polite',
        },
        hint
      )
    )
  }
  return bodyNodes
}

export { DIALOG_KEYS, groupDialogBody }
