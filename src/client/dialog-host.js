/**
 * Modal dialog host: group/session dialogs, selectors, geometry and color UI.
 * Extracted from components.js as a behavior-neutral split.
 */
import { createElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clientRuntime as rt } from '../adapters/client-runtime.js'
import { deleteGroupOptions, dialogConfirmPayload, findGroupsFlat, initialDialogSelection, isSelectionDialog, moveGroupOptions, selectionIsValid } from '../core/dialog-selection.js'
import { GROUP_COLORS, GROUP_COLOR_HEX, MAX_GROUP_NAME, PLUGIN_VERSION } from '../shared/constants.js'
import { isColorHex, normalizeColorHex } from '../shared/model.js'
import { formatActivity } from './actions.js'
import { centeredDialogRect, clampDialogRect, dragDialogRect, readDialogGeometries, resizeDialogRect, saveDialogGeometry } from './dialog-geometry.js'
import { dialogKeyboardDelta } from './dialog-keyboard.js'
import { GroupListPicker } from './group-list-picker.js'
import { ICON_GROUPS, renderGlyph, renderIcon } from './icons.js'
import { ScrollArea } from './scroll-area.js'
import { ProfilePreviewActions, ProfilePreviewBody } from './components-profiles.js'
import {
  ProfileArchiveBody,
  ProfileManageBody,
  ProfileRenameBody,
  ProfileSaveAsBody,
  confirmArchive,
  confirmRename,
  confirmSaveAs,
  validateProfileName,
} from './components-profile-dialogs.js'

const h = createElement
const dispatch = (action, payload) => rt()?.store.dispatch(action, payload)
const focusableSelector =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

const focusableIn = (element) =>
  Array.from(element?.querySelectorAll?.(focusableSelector) ?? []).filter(
    (candidate) =>
      candidate instanceof globalThis.HTMLElement &&
      !candidate.closest('[aria-hidden="true"]') &&
      candidate.getClientRects().length > 0
  )


export const DialogHost = ({ store, props, sessionsById }) => {
  const dialog = store.dialog
  const t = rt()?.t
  const dialogKind = dialog?.kind ?? ''
  const isProfilePreview = dialogKind === 'profile-preview'
  const isProfileSaveAs = dialogKind === 'profile-save-as'
  const isProfileManage = dialogKind === 'profile-manage'
  const isProfileRename = dialogKind === 'profile-rename'
  const isProfileArchive = dialogKind === 'profile-archive'
  const isProfileForm = isProfileSaveAs || isProfileRename
  const needsNameInput =
    dialogKind === 'new-group' ||
    dialogKind === 'rename-group' ||
    dialogKind === 'rename-session' ||
    isProfileForm
  // Seed from the dialog descriptor when the host is first created (tests call
  // the component directly); the effect below still re-seeds on every dialog
  // change, which is the production path.
  const [value, setValue] = useState(() => dialog?.value ?? '')
  const [selection, setSelection] = useState(undefined)
  const [hexInput, setHexInput] = useState('')
  const [profileBusy, setProfileBusy] = useState(false)
  // Re-seed the local form state only when the edited target changes; an inline
  // error dispatch replaces the descriptor object but must keep the typed value.
  const dialogSeedRef = useRef(null)
  const inputRef = useRef(null)
  const dialogRef = useRef(null)
  const restoreFocusRef = useRef(null)
  const [dialogRect, setDialogRect] = useState(null)
  const dialogRectRef = useRef(null)
  const gestureRef = useRef(null)
  const gestureCleanupRef = useRef(null)
  const debugSentRef = useRef(null)
  dialogRectRef.current = dialogRect
  useEffect(() => {
    if (!dialog) {
      setDialogRect(null)
      return
    }
    const saved = readDialogGeometries()[dialog.kind]
    setDialogRect(saved ? clampDialogRect(saved, globalThis.innerWidth, globalThis.innerHeight) : null)
  }, [dialog?.kind])

  // SPEC §9.3: Escape closes the preview through the generic dialog action; the
  // preview target/token must be cleared with it, otherwise the next switch
  // starts from a stale diff and disabled confirm.
  useEffect(() => {
    if (dialog) return
    if (store?.profilePreview?.open !== true) return
    dispatch('profile-preview-close')
  }, [dialog, store?.profilePreview?.open])

  useEffect(() => {
    if (!dialog) {
      const previous = restoreFocusRef.current
      restoreFocusRef.current = null
      if (previous && typeof previous.focus === 'function') {
        const active = globalThis.document?.activeElement
        if (!active || active === globalThis.document?.body || dialogRef.current?.contains?.(active)) {
          previous.focus({ preventScroll: true })
        }
      }
      return undefined
    }
    if (!restoreFocusRef.current) {
      const active = globalThis.document?.activeElement
      if (active && active !== globalThis.document?.body) restoreFocusRef.current = active
    }
    const timer = setTimeout(() => {
      if (needsNameInput) {
        inputRef.current?.focus()
        return
      }
      const element = dialogRef.current
      if (!element) return
      const focusable = focusableIn(element)[0]
      if (focusable) {
        focusable.focus({ preventScroll: true })
      } else {
        element.focus?.({ preventScroll: true })
      }
    }, 10)
    return () => clearTimeout(timer)
  }, [dialog])

  useEffect(() => {
    if (!dialog) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        // SPEC §9.5: the rename/archive confirm dialogs return to the manage
        // list instead of dropping the whole flow.
        dispatch('dialog', {
          dialog: dialog.returnTo === 'profile-manage' ? { kind: 'profile-manage', titleKey: 'profiles.title' } : null,
        })
        return
      }
      if (event.key !== 'Tab') return
      const element = dialogRef.current
      if (!element) return
      const focusables = focusableIn(element)
      if (focusables.length === 0) {
        event.preventDefault()
        element.focus?.({ preventScroll: true })
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = globalThis.document?.activeElement
      const inside = element.contains(active)
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault()
          last.focus({ preventScroll: true })
        }
      } else if (!inside || active === last) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    globalThis.document?.addEventListener('keydown', onKeyDown, true)
    return () => globalThis.document?.removeEventListener('keydown', onKeyDown, true)
  }, [dialog])

  // Measure the natural dialog once when there is no saved geometry; after that
  // the explicit rect is the single source of truth for drag/resize.
  useLayoutEffect(() => {
    if (!dialog || dialogRect !== null) return
    const element = dialogRef.current
    if (!element) return
    const box = element.getBoundingClientRect()
    const titlebar = element.querySelector('.dsg-dialog-titlebar')
    const content = element.querySelector('.dsg-dialog-content')
    const actions = element.querySelector('.dsg-dialog-actions')
    // The dialog is a column flex with gap:12px and 16px vertical padding, so
    // include the two gaps + padding + the 0.5px top/bottom border (which
    // becomes fractional at non-1 DPR) or the content bottom is clipped.
    const borderHeight =
      (Number.parseFloat(globalThis.getComputedStyle(element).borderTopWidth) || 0) +
      (Number.parseFloat(globalThis.getComputedStyle(element).borderBottomWidth) || 0)
    const laidOutHeight = Math.ceil(
      (titlebar?.offsetHeight ?? 0) +
        Math.ceil(content?.scrollHeight ?? 0) +
        (actions?.offsetHeight ?? 0) +
        57 +
        borderHeight
    )
    const naturalHeight = laidOutHeight || Math.ceil(box.height) || 320
    // SPEC §9.3/§9.5: the switch preview and the manage list are wider (420)
    // than the standard 360; save-as/rename/archive stay at 360.
    const wideKind = dialog.kind === 'icon' || dialog.kind === 'profile-preview' || dialog.kind === 'profile-manage'
    setDialogRect(
      centeredDialogRect(
        box.width || (wideKind ? 420 : 360),
        naturalHeight || 320,
        globalThis.innerWidth,
        globalThis.innerHeight
      )
    )
  }, [dialog, dialogRect])

  useEffect(() => {
    if (!dialog || dialogRect === null) return undefined
    const onResize = () => {
      const next = clampDialogRect(dialogRectRef.current ?? dialogRect, globalThis.innerWidth, globalThis.innerHeight)
      setDialogRect(next)
      saveDialogGeometry(dialog.kind, next)
    }
    globalThis.addEventListener('resize', onResize)
    return () => globalThis.removeEventListener('resize', onResize)
  }, [dialog?.kind, dialogRect === null])

  useEffect(() => {
    if (rt()?.debugProbe !== true) return undefined
    if (!dialog) {
      debugSentRef.current = null
      return undefined
    }
    if (debugSentRef.current === dialog.kind) return undefined
    debugSentRef.current = dialog.kind
    const timer = setTimeout(() => {
      const element = dialogRef.current
      if (!element || typeof globalThis.getComputedStyle !== 'function') return
      try {
        const bodyStyle = globalThis.getComputedStyle(globalThis.document.body)
        const dialogStyle = globalThis.getComputedStyle(element)
        const content = element.querySelector('.dsg-dialog-content')
        const input = element.querySelector('.dsg-dialog-input')
        const confirm = element.querySelector('.dsg-dialog-confirm')
        const contentStyle = content ? globalThis.getComputedStyle(content) : null
        const inputStyle = input ? globalThis.getComputedStyle(input) : null
        const confirmStyle = confirm ? globalThis.getComputedStyle(confirm) : null
        const tokenNames = [
          '--dsw-alias-bg-layer-1',
          '--dsw-alias-bg-layer-2',
          '--dsw-alias-button-primary-fill',
          '--dsw-alias-button-primary-hover',
          '--dsw-alias-label-primary-foreground',
          '--dsw-alias-border-l3',
          '--dsw-alias-border-l4',
          '--dsw-alias-label-primary',
          '--dsw-alias-label-secondary',
          '--dsh-scrollbar-thumb',
          '--dsh-scrollbar-thumb-hover',
          '--dsw-radius-panel',
        ]
        const tokens = Object.fromEntries(tokenNames.map((name) => [name, bodyStyle.getPropertyValue(name).trim()]))
        const payload = {
          pluginVersion: PLUGIN_VERSION,
          kind: dialog.kind,
          dark: globalThis.document.body?.getAttribute?.('data-ds-dark-theme'),
          dialog: {
            rect: element.getBoundingClientRect().toJSON?.() ?? null,
            background: dialogStyle.backgroundColor,
            color: dialogStyle.color,
            border: dialogStyle.border,
            borderRadius: dialogStyle.borderRadius,
            padding: dialogStyle.padding,
          },
          content: content
            ? {
                rect: content.getBoundingClientRect().toJSON?.() ?? null,
                flex: contentStyle?.flex,
                height: contentStyle?.height,
                scrollHeight: content.scrollHeight,
              }
            : null,
          input: input
            ? {
                rect: input.getBoundingClientRect().toJSON?.() ?? null,
                display: inputStyle?.display,
                height: inputStyle?.height,
                flex: inputStyle?.flex,
                opacity: inputStyle?.opacity,
                background: inputStyle?.backgroundColor,
                color: inputStyle?.color,
                border: inputStyle?.border,
              }
            : null,
          confirm: confirm
            ? {
                background: confirmStyle?.backgroundColor,
                color: confirmStyle?.color,
                height: confirmStyle?.height,
              }
            : null,
          scrollAreas: [...element.querySelectorAll('.dsg-scroll-area')].map((area) => {
            const scroller = area.firstElementChild
            const rail = [...area.children].find((child) => child.classList?.contains('dsg-scroll-rail')) ?? null
            const thumb = rail ? [...rail.children].find((child) => child.classList?.contains('dsg-scroll-thumb')) ?? null : null
            return {
              className: scroller?.className ?? '',
              clientHeight: scroller?.clientHeight ?? null,
              scrollHeight: scroller?.scrollHeight ?? null,
              max: scroller ? scroller.scrollHeight - scroller.clientHeight : null,
              rail: rail
                ? {
                    rect: rail.getBoundingClientRect().toJSON?.() ?? null,
                    display: getComputedStyle(rail).display,
                    opacity: getComputedStyle(rail).opacity,
                    zIndex: getComputedStyle(rail).zIndex,
                  }
                : null,
              thumb: thumb
                ? {
                    rect: thumb.getBoundingClientRect().toJSON?.() ?? null,
                    display: getComputedStyle(thumb).display,
                    background: getComputedStyle(thumb).backgroundColor,
                  }
                : null,
            }
          }),
          tokens,
        }
        void globalThis.fetch?.('/dsh-session-grove/debug', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {})
      } catch {
        /* debug probe must never affect the dialog */
      }
    }, 50)
    return () => clearTimeout(timer)
  }, [dialog?.kind])

  const beginDialogGesture = (event, dir = null) => {
    if (!dialog || event.button !== 0) return
    if (dir === null && event.target?.closest?.('button, input, textarea, select, a')) return
    const start = dialogRectRef.current
    if (!start) return
    event.preventDefault()
    event.stopPropagation()
    const doc = event.currentTarget?.ownerDocument ?? globalThis.document
    const gesture = { start, x: event.clientX, y: event.clientY, dir }
    gestureRef.current = gesture
    const onMove = (moveEvent) => {
      const current = gestureRef.current
      if (!current) return
      const dx = moveEvent.clientX - current.x
      const dy = moveEvent.clientY - current.y
      const next = current.dir
        ? resizeDialogRect(current.start, current.dir, dx, dy, globalThis.innerWidth, globalThis.innerHeight)
        : dragDialogRect(current.start, dx, dy, globalThis.innerWidth, globalThis.innerHeight)
      setDialogRect(next)
    }
    const onEnd = () => {
      const current = gestureRef.current
      gestureRef.current = null
      doc?.removeEventListener?.('pointermove', onMove)
      doc?.removeEventListener?.('pointerup', onEnd)
      doc?.removeEventListener?.('pointercancel', onEnd)
      gestureCleanupRef.current = null
      if (current && dialogRectRef.current) saveDialogGeometry(dialog.kind, dialogRectRef.current)
    }
    doc?.addEventListener?.('pointermove', onMove)
    doc?.addEventListener?.('pointerup', onEnd)
    doc?.addEventListener?.('pointercancel', onEnd)
    gestureCleanupRef.current = () => {
      doc?.removeEventListener?.('pointermove', onMove)
      doc?.removeEventListener?.('pointerup', onEnd)
      doc?.removeEventListener?.('pointercancel', onEnd)
    }
  }

  // A dialog can unmount mid-gesture; release its window listeners.
  useEffect(
    () => () => {
      gestureRef.current = null
      gestureCleanupRef.current?.()
      gestureCleanupRef.current = null
    },
    []
  )
  useEffect(() => {
    const seedKey = dialog
      ? `${dialog.kind}:${dialog.groupId ?? dialog.sessionId ?? dialog.profileId ?? ''}`
      : null
    if (dialogSeedRef.current === seedKey) return undefined
    dialogSeedRef.current = seedKey
    setValue(dialog?.value ?? '')
    // A new dialog/edit target starts a fresh request slot for the profile
    // footer's loading guard; an inline error on the same target keeps it.
    setProfileBusy(false)
    // Every selection dialog opens with a visible current/inferred highlight;
    // when nothing usable exists Confirm stays disabled until the user picks.
    const initial = dialog ? initialDialogSelection(dialog, store.doc) : undefined
    setSelection(initial)
    setHexInput(dialog?.kind === 'group-color' && isColorHex(initial) ? initial : '')
    if (dialog && (dialog.kind === 'new-group' || dialog.kind === 'rename-group' || dialog.kind === 'rename-session')) {
      const timer = setTimeout(() => inputRef.current?.focus(), 10)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [dialog])
  if (!dialog) return null
  const close = () => {
    // SPEC §9.5: cancel/Escape on the rename/archive confirm returns to manage.
    dispatch('dialog', {
      dialog: dialog.returnTo === 'profile-manage' ? { kind: 'profile-manage', titleKey: 'profiles.title' } : null,
    })
  }
  const confirm = (payload) => rt()?.confirmDialog(dialog, payload)
  const persistDialogRect = () => {
    if (dialogRectRef.current) saveDialogGeometry(dialog.kind, dialogRectRef.current)
  }
  const moveDialogByKeyboard = (event) => {
    const delta = dialogKeyboardDelta(event.key, event.shiftKey)
    if (delta.dx === 0 && delta.dy === 0) return false
    event.preventDefault()
    const current = dialogRectRef.current
    if (!current) return true
    const next = dragDialogRect(current, delta.dx, delta.dy, globalThis.innerWidth, globalThis.innerHeight)
    dialogRectRef.current = next
    setDialogRect(next)
    return true
  }
  const resizeDialogByKeyboard = (event) => {
    const delta = dialogKeyboardDelta(event.key, event.shiftKey)
    if (delta.dx === 0 && delta.dy === 0) return false
    event.preventDefault()
    const current = dialogRectRef.current
    if (!current) return true
    const next = resizeDialogRect(current, 'se', delta.dx, delta.dy, globalThis.innerWidth, globalThis.innerHeight)
    dialogRectRef.current = next
    setDialogRect(next)
    return true
  }
  const resetDialogRect = () => {
    const current = dialogRectRef.current
    if (!current) return
    const next = centeredDialogRect(current.width, current.height, globalThis.innerWidth, globalThis.innerHeight)
    dialogRectRef.current = next
    setDialogRect(next)
    saveDialogGeometry(dialog.kind, next)
  }
  const errorText = dialog.error
    ? t(dialog.error === 'name-required' ? 'dialog.namePlaceholder' : dialog.error, dialog.errorParams ?? undefined)
    : null
  const title = isProfilePreview
    ? t('profiles.previewTitle', {
        name: dialog.targetName ?? store?.profilePreview?.targetName ?? dialog.targetId ?? '',
      })
    : t(dialog.titleKey)
  // SPEC §9.4: save-as/rename validate the name client-first (the host re-checks
  // under CAS); the error is inline and also blocks the confirm button.
  const profileNameError = isProfileForm
    ? validateProfileName(value, {
        list: (store?.profiles?.list ?? []).filter((profile) => profile?.archived !== true),
        exceptId: isProfileRename ? dialog.profileId : null,
      })
    : null
  const changeProfileName = (next) => {
    setValue(next)
    if (dialog.error) dispatch('dialog', { dialog: { ...dialog, error: null, errorParams: null } })
  }
  const submitProfileForm = (event) => {
    if (event?.key !== 'Enter' || profileBusy || profileNameError !== null) return
    event.preventDefault()
    if (isProfileSaveAs) void runProfileAction('save-as')
    else if (isProfileRename) void runProfileAction('rename')
  }
  const optionCheck = () => h('span', { class: 'dsg-dialog-option-check', 'aria-hidden': 'true' }, renderGlyph(h, 'check', 16))
  const bodyNodes = []
  if (isProfilePreview) {
    bodyNodes.push(h(ProfilePreviewBody, { store, t, byId: sessionsById }))
  }
  if (isProfileSaveAs) {
    bodyNodes.push(
      h(ProfileSaveAsBody, {
        store,
        t,
        dialog,
        value,
        onValueChange: changeProfileName,
        onKeyDown: submitProfileForm,
        inputRef,
      })
    )
  }
  if (isProfileRename) {
    bodyNodes.push(
      h(ProfileRenameBody, {
        t,
        dialog,
        value,
        onValueChange: changeProfileName,
        onKeyDown: submitProfileForm,
        inputRef,
      })
    )
  }
  if (isProfileArchive) {
    bodyNodes.push(h(ProfileArchiveBody, { t, dialog }))
  }
  if (isProfileManage) {
    bodyNodes.push(h(ProfileManageBody, { store, t }))
  }
  if (dialog.kind === 'delete-group') {
    const options = deleteGroupOptions(store.doc, dialog.groupId)
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
        onSelect: setSelection,
        rootLabel: t('dialog.rootDestination'),
        ariaLabel: t('dialog.deleteDestination'),
        testId: 'session-groups-dialog-delete-options',
      })
    )
  }
  if (dialog.kind === 'archive-running') bodyNodes.push(h('div', { class: 'dsg-dialog-body' }, t('dialog.archiveRunningBody', { families: formatActivity(dialog.activity) })))
  if (dialog.kind === 'move-session' || dialog.kind === 'move-group') {
    const options = dialog.kind === 'move-group' ? moveGroupOptions(store.doc, dialog.groupId) : findGroupsFlat(store.doc)
    bodyNodes.push(h(GroupListPicker, {
      options,
      selection,
      onSelect: setSelection,
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
            setSelection(icon)
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
      setSelection(color)
      setHexInput('')
    }
    const changeHex = (raw) => {
      setHexInput(raw)
      const hex = normalizeColorHex(raw)
      setSelection(hex ?? undefined)
    }
    const pickNative = (raw) => {
      const hex = normalizeColorHex(raw)
      if (!hex) return
      setHexInput(hex)
      setSelection(hex)
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
            if (event.key === 'Escape') close()
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
  const needsInput = dialog.kind === 'new-group' || dialog.kind === 'rename-group' || dialog.kind === 'rename-session'
  const selectable = isSelectionDialog(dialog.kind)
  const danger = dialog.kind === 'delete-group' || dialog.kind === 'archive-running'
  const canConfirm = needsInput ? value.trim().length > 0 : selectable ? selectionIsValid(dialog, selection, store.doc) : true
  // SPEC §9.4/§9.5 footer: Create/Rename/Archive carry the request loading guard
  // and the client-side name error; none of them is the initial focus target.
  const runProfileAction = async (kind) => {
    if (profileBusy) return
    setProfileBusy(true)
    try {
      if (kind === 'save-as') await confirmSaveAs({ store, t }, { name: value })
      else if (kind === 'rename') await confirmRename({ store, t }, { profileId: dialog.profileId, name: value })
      else if (kind === 'archive') await confirmArchive({ store, t }, { profileId: dialog.profileId })
    } finally {
      setProfileBusy(false)
    }
  }
  const profileCancel = (testId) =>
    h(
      'button',
      { type: 'button', class: 'dsg-dialog-cancel', 'data-testid': testId, onClick: close },
      t('dialog.cancel')
    )
  const profileSubmit = (testId, label, disabled, onClick) =>
    h(
      'button',
      {
        type: 'button',
        class: 'dsg-dialog-confirm',
        'data-testid': testId,
        ...(disabled ? { disabled: true } : {}),
        onClick,
      },
      label
    )
  const profileActions = isProfileManage
    ? [
        h(
          'button',
          {
            key: 'close',
            type: 'button',
            class: 'dsg-dialog-cancel',
            'data-testid': 'session-groups-profile-manage-close',
            onClick: close,
          },
          t('dialog.cancel')
        ),
      ]
    : isProfileSaveAs
      ? [
          profileCancel('session-groups-profile-save-as-cancel'),
          profileSubmit(
            'session-groups-profile-save-as-confirm',
            t('profiles.create'),
            profileBusy || profileNameError !== null,
            () => {
              void runProfileAction('save-as')
            }
          ),
        ]
      : isProfileRename
        ? [
            profileCancel('session-groups-profile-rename-cancel'),
            profileSubmit(
              'session-groups-profile-rename-confirm',
              t('profiles.rename'),
              profileBusy || profileNameError !== null,
              () => {
                void runProfileAction('rename')
              }
            ),
          ]
        : isProfileArchive
          ? [
              profileCancel('session-groups-profile-archive-cancel'),
              profileSubmit(
                'session-groups-profile-archive-confirm',
                t('profiles.archive'),
                profileBusy,
                () => {
                  void runProfileAction('archive')
                }
              ),
            ]
          : null
  return h(
    'div',
    {
      class: 'dsg-dialog-backdrop',
      // Backdrop click deliberately does not close independent dialogs. The
      // user closes via Cancel/Escape or the explicit action.
    },
    h(
      'div',
      {
        ref: dialogRef,
        class: 'dsg-dialog',
        role: 'dialog',
        tabindex: '-1',
        'aria-modal': 'true',
        'aria-labelledby': 'dsg-dialog-title',
        'data-testid': 'session-groups-dialog',
        'data-kind': dialog.kind,
        'data-positioned': dialogRect ? 'true' : 'false',
        style: dialogRect
          ? {
              left: `${dialogRect.x}px`,
              top: `${dialogRect.y}px`,
              width: `${dialogRect.width}px`,
              height: `${dialogRect.height}px`,
            }
          : undefined,
      },
      h(
        'div',
        {
          class: 'dsg-dialog-titlebar',
          'data-testid': 'session-groups-dialog-titlebar',
          tabindex: '0',
          'aria-label': t('dialog.moveDialog'),
          onPointerDown: (event) => beginDialogGesture(event),
          onKeyDown: (event) => {
            if (event.key === 'Home') {
              event.preventDefault()
              resetDialogRect()
              return
            }
            moveDialogByKeyboard(event)
          },
          onKeyUp: (event) => {
            if (/^Arrow(?:Up|Down|Left|Right)$/.test(event.key)) persistDialogRect()
          },
        },
        h('div', { id: 'dsg-dialog-title', class: 'dsg-dialog-title' }, title)
      ),
      h(
        ScrollArea,
        { className: 'dsg-dialog-content' },
        ...bodyNodes,
        needsInput
          ? h('input', {
              ref: inputRef,
              class: 'dsg-dialog-input',
              'data-testid': 'session-groups-dialog-input',
              value,
              maxlength: String(MAX_GROUP_NAME),
              placeholder: t('dialog.namePlaceholder'),
              onChange: (event) => setValue(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && canConfirm) confirm({ value: value.trim() })
              },
            })
          : null,
        profileNameError
          ? h(
              'div',
              {
                class: 'dsg-dialog-error',
                'data-testid': 'session-groups-profile-dialog-error',
                'aria-live': 'polite',
              },
              t(profileNameError)
            )
          : errorText
            ? h(
                'div',
                {
                  class: 'dsg-dialog-error',
                  ...(isProfileForm || isProfileArchive || isProfileManage
                    ? { 'data-testid': 'session-groups-profile-dialog-error' }
                    : {}),
                },
                errorText
              )
            : null
      ),
      h(
        'div',
        { class: isProfilePreview ? 'dsg-dialog-actions dsg-profile-preview-actions' : 'dsg-dialog-actions' },
        ...(isProfilePreview
          ? // SPEC §9.3 footer: [x] switch directly / Cancel / Switch. Confirm is
            // never the initial focus target; DialogHost focuses the checkbox.
            ProfilePreviewActions({ store, t })
          : profileActions ?? [
              h('button', { type: 'button', class: 'dsg-dialog-cancel', 'data-testid': 'session-groups-dialog-cancel', onClick: close }, t('dialog.cancel')),
              h(
                'button',
                {
                  type: 'button',
                  class: 'dsg-dialog-confirm',
                  'data-testid': 'session-groups-dialog-confirm',
                  'data-variant': danger ? 'danger' : 'primary',
                  disabled: !canConfirm,
                  onClick: () =>
                    confirm(needsInput ? { value: value.trim() } : selectable ? dialogConfirmPayload(dialog, selection) : {}),
                },
                danger ? (dialog.kind === 'delete-group' ? t('dialog.moveAndDelete') : t('dialog.stopAndArchive')) : t('dialog.confirm')
              ),
            ])
      ),
      ...['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'].map((dir) => {
        const keyboardResizable = dir === 'se'
        return h('div', {
          key: dir,
          class: 'dsg-dialog-resizer',
          'data-dir': dir,
          ...(keyboardResizable
            ? {
                'data-testid': 'session-groups-dialog-resizer',
                tabindex: '0',
                role: 'separator',
                'aria-label': t('dialog.resizeDialog'),
              }
            : { 'aria-hidden': 'true' }),
          onKeyDown: keyboardResizable
            ? (event) => {
                if (event.key === 'Home') {
                  event.preventDefault()
                  resetDialogRect()
                  return
                }
                resizeDialogByKeyboard(event)
              }
            : undefined,
          onKeyUp: keyboardResizable
            ? (event) => {
                if (/^Arrow(?:Up|Down|Left|Right)$/.test(event.key)) persistDialogRect()
              }
            : undefined,
          onPointerDown: (event) => beginDialogGesture(event, dir),
        })
      })
    )
  )
}

