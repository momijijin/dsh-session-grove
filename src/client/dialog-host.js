/**
 * Modal dialog shell: geometry, focus/trap, gestures, footer and body assembly.
 * Group/session bodies live in dialog-bodies.js; profile bodies stay in
 * dialog-profile.js and profile-preview.js.
 */
import { createElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clientRuntime as rt } from '../adapters/client-runtime.js'
import { dialogConfirmPayload, initialDialogSelection, isSelectionDialog, selectionIsValid } from '../core/dialog-selection.js'
import { MAX_GROUP_NAME, PLUGIN_VERSION } from '../shared/constants.js'
import { isColorHex } from '../shared/model.js'
import { DIALOG_KEYS, groupDialogBody } from './dialog-bodies.js'
import { centeredDialogRect, clampDialogRect, dialogRectFromElement, dragDialogRect, readDialogGeometries, resolveDialogRect, resizeDialogRect, saveDialogGeometry } from './dialog-geometry.js'
import { dialogKeyboardDelta } from './dialog-keyboard.js'
import { ScrollArea } from './scroll-area.js'
import { ProfilePreviewActions, ProfilePreviewBody } from './profile-preview.js'
import {
  isProfileDialogKind,
  isProfileFormKind,
  profileDialogActions,
  profileDialogBody,
  profileDialogNameError,
  runProfileDialogAction,
} from './dialog-profile.js'

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

/**
 * The delayed auto-focus must not steal focus that the user (or a test) has
 * already placed inside the open dialog. The dialog element itself, an outside
 * element, a body-like object and a null activeElement all keep auto-focus.
 */
export const shouldFocusDialogTarget = (activeElement, dialogElement) =>
  !(activeElement && dialogElement?.contains?.(activeElement) && activeElement !== dialogElement)


export const DialogHost = ({ store, props, sessionsById }) => {
  const dialog = store.dialog
  const t = rt()?.t
  const dialogKind = dialog?.kind ?? ''
  const isProfilePreview = dialogKind === 'profile-preview'
  const needsNameInput =
    dialogKind === 'new-group' ||
    dialogKind === 'rename-group' ||
    dialogKind === 'rename-session' ||
    isProfileFormKind(dialogKind)
  // Seed from the dialog descriptor when the host is first created (tests call
  // the component directly); the effect below still re-seeds on every dialog
  // change, which is the production path.
  const [value, setValue] = useState(() => dialog?.value ?? '')
  const [selection, setSelection] = useState(undefined)
  const [hexInput, setHexInput] = useState('')
  const [profileBusy, setProfileBusy] = useState(false)
  // Archive-group "don't ask again" checkbox: unchecked on every open, and only
  // the archive-group confirm payload carries it (other dialogs are untouched).
  const [dontAskAgain, setDontAskAgain] = useState(false)
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
      if (!shouldFocusDialogTarget(globalThis.document?.activeElement, dialogRef.current)) return
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
    // The dialog is a column flex with gap/padding chrome; the 0.5px top/bottom
    // border becomes fractional at non-1 DPR, so read it instead of assuming
    // 1px. Every dialog uses 16px padding + 12px gaps (57px); the switch
    // preview tightens to 12px padding + 8px gaps (41px).
    const borderHeight =
      (Number.parseFloat(globalThis.getComputedStyle(element).borderTopWidth) || 0) +
      (Number.parseFloat(globalThis.getComputedStyle(element).borderBottomWidth) || 0)
    const dialogChrome = isProfilePreview ? 41 : 57
    const laidOutHeight = Math.ceil(
      (titlebar?.offsetHeight ?? 0) +
        Math.ceil(content?.scrollHeight ?? 0) +
        (actions?.offsetHeight ?? 0) +
        dialogChrome +
        borderHeight
    )
    const naturalHeight = laidOutHeight || Math.ceil(box.height) || 320
    // SPEC §9.3/§9.5: the switch preview and the manage list are wider (560/420)
    // than the standard 360; save-as/rename/archive stay at 360. The preview
    // opens while its diff is still loading, so the measured natural height is
    // only the spinner row: keep a compact 320px floor (viewport-clamped) so a
    // short diff does not leave a half-empty dialog. The height is also capped
    // at 560px (viewport-clamped as well) so a long diff scrolls inside the
    // body instead of stretching the modal past the screen.
    const wideKind = dialog.kind === 'icon' || dialog.kind === 'profile-preview' || dialog.kind === 'profile-manage'
    const initialHeight = isProfilePreview
      ? Math.min(
          Math.max(naturalHeight, Math.min(Math.max(0, globalThis.innerHeight - 24), 320)),
          Math.min(560, Math.max(0, globalThis.innerHeight - 24))
        )
      : naturalHeight
    setDialogRect(
      centeredDialogRect(
        box.width || (isProfilePreview ? 560 : wideKind ? 420 : 360),
        initialHeight || 320,
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

  // The explicit in-memory rect is the gesture source of truth; before the
  // natural measurement lands (or after a reset clears it) fall back to the
  // element's rendered box so keyboard move/resize still work instead of
  // silently doing nothing.
  const currentDialogRect = () =>
    resolveDialogRect(
      dialogRectRef.current,
      dialogRectFromElement(dialogRef.current),
      globalThis.innerWidth,
      globalThis.innerHeight
    )

  const beginDialogGesture = (event, dir = null) => {
    if (!dialog || event.button !== 0) return
    if (dir === null && event.target?.closest?.('button, input, textarea, select, a')) return
    const start = currentDialogRect()
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
    // The archive opt-out is per confirmation, never sticky across dialogs.
    setDontAskAgain(false)
    // Every selection dialog opens with a visible current/inferred highlight;
    // when nothing usable exists Confirm stays disabled until the user picks.
    const initial = dialog ? initialDialogSelection(dialog, store.doc) : undefined
    setSelection(initial)
    setHexInput(dialog?.kind === 'group-color' && isColorHex(initial) ? initial : '')
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
    const current = currentDialogRect()
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
    const current = currentDialogRect()
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
  const profileNameError = profileDialogNameError({ kind: dialogKind, value, store, dialog })
  const changeProfileName = (next) => {
    setValue(next)
    if (dialog.error) dispatch('dialog', { dialog: { ...dialog, error: null, errorParams: null } })
  }
  const submitProfileForm = (event) => {
    if (event?.key !== 'Enter' || profileBusy || profileNameError !== null) return
    event.preventDefault()
    void runProfileAction()
  }
  const bodyNodes = []
  if (isProfilePreview) {
    bodyNodes.push(h(ProfilePreviewBody, { store, t, byId: sessionsById }))
  }
  const profileBody = profileDialogBody({
    store,
    t,
    dialog,
    value,
    onValueChange: changeProfileName,
    onKeyDown: submitProfileForm,
    inputRef,
  })
  if (profileBody !== null) bodyNodes.push(profileBody)
  // Group/session bodies (delete/archive/move/icon/color) live in
  // dialog-bodies.js; the shell only assembles them in order.
  bodyNodes.push(
    ...groupDialogBody({
      store,
      t,
      dialog,
      selection,
      onSelect: setSelection,
      dontAskAgain,
      onDontAskAgain: setDontAskAgain,
      hexInput,
      onHexInput: setHexInput,
      onClose: close,
    })
  )
  const needsInput = dialog.kind === 'new-group' || dialog.kind === 'rename-group' || dialog.kind === 'rename-session'
  const selectable = isSelectionDialog(dialog.kind)
  const danger = dialog.kind === 'delete-group' || dialog.kind === 'archive-running'
  const canConfirm = needsInput ? value.trim().length > 0 : selectable ? selectionIsValid(dialog, selection, store.doc) : true
  // Footer copy: delete keeps "Move and delete", archive-running keeps
  // "Stop and archive", the new archive-group confirm names its action.
  const confirmLabel = danger
    ? (dialog.kind === 'delete-group' ? t('dialog.moveAndDelete') : t('dialog.stopAndArchive'))
    : dialog.kind === 'archive-group'
      ? t(DIALOG_KEYS.archiveConfirm)
      : t('dialog.confirm')
  // SPEC §9.4/§9.5 footer: Create/Rename/Archive carry the request loading guard
  // and the client-side name error; none of them is the initial focus target.
  const runProfileAction = async () => {
    if (profileBusy) return
    setProfileBusy(true)
    try {
      await runProfileDialogAction({
        kind: dialog.kind,
        store,
        t,
        name: value,
        profileId: dialog.profileId,
      })
    } finally {
      setProfileBusy(false)
    }
  }
  const profileActions = profileDialogActions({
    kind: dialog.kind,
    t,
    busy: profileBusy,
    nameError: profileNameError,
    onClose: close,
    onRun: runProfileAction,
  })
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
                  ...(isProfileDialogKind(dialog.kind)
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
                    confirm(
                      needsInput
                        ? { value: value.trim() }
                        : selectable
                          ? dialogConfirmPayload(dialog, selection)
                          : dialog.kind === 'archive-group'
                            ? { dontAskAgain }
                            : {}
                    ),
                },
                confirmLabel
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

