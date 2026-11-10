/**
 * Profile dialog bodies and actions (SPEC §9.4/§9.5).
 *
 * `profile-save-as`, `profile-rename`, `profile-manage` and `profile-archive`
 * are DialogHost kinds; this module owns their bodies, the client-first name
 * validation and the footer actions so the modal shell stays generic. The shell
 * still owns the modal chrome (focus trap, geometry, keyboard, close/Escape) and
 * dispatches by `dialog.kind`; `profile-preview` keeps its body in
 * `profile-preview.js` because it is a read-only diff view, not a form.
 *
 * Write calls go through the runtime bridge (`createProfile`/`renameProfile`/
 * `archiveProfile`); the host stays authoritative for every name check.
 */
import { createElement } from 'react'
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

/** Dialog kinds owned by this module (`profile-preview` stays in the shell). */
const PROFILE_DIALOG_KINDS = ['profile-save-as', 'profile-rename', 'profile-manage', 'profile-archive']
/** Kinds that carry an editable name input and the client-first validation. */
const PROFILE_FORM_KINDS = ['profile-save-as', 'profile-rename']

const isProfileDialogKind = (kind) => PROFILE_DIALOG_KINDS.includes(kind)
const isProfileFormKind = (kind) => PROFILE_FORM_KINDS.includes(kind)

/**
 * SPEC §9.4 client-first validation for the save-as/rename form bodies: trim,
 * 1-40 characters and uniqueness among the unarchived profiles. Archived rows
 * are excluded because the host's `nameTaken` ignores them too.
 */
const profileDialogNameError = ({ kind, value, store, dialog }) => {
  if (!isProfileFormKind(kind)) return null
  return validateProfileName(value, {
    list: (store?.profiles?.list ?? []).filter((profile) => profile?.archived !== true),
    exceptId: kind === 'profile-rename' ? dialog.profileId : null,
  })
}

/** Body node for one profile dialog kind (null for every other kind). */
const profileDialogBody = ({ store, t, dialog, value, onValueChange, onKeyDown, inputRef }) => {
  if (dialog.kind === 'profile-save-as') {
    return h(ProfileSaveAsBody, {
      store,
      t,
      dialog,
      value,
      onValueChange,
      onKeyDown,
      inputRef,
    })
  }
  if (dialog.kind === 'profile-rename') {
    return h(ProfileRenameBody, {
      t,
      dialog,
      value,
      onValueChange,
      onKeyDown,
      inputRef,
    })
  }
  if (dialog.kind === 'profile-archive') return h(ProfileArchiveBody, { t, dialog })
  if (dialog.kind === 'profile-manage') return h(ProfileManageBody, { store, t })
  return null
}

/** Run the profile write behind the open dialog (returns the bridge result). */
const runProfileDialogAction = async ({ kind, store, t, name, profileId }) => {
  if (kind === 'profile-save-as') return confirmSaveAs({ store, t }, { name })
  if (kind === 'profile-rename') return confirmRename({ store, t }, { profileId, name })
  if (kind === 'profile-archive') return confirmArchive({ store, t }, { profileId })
  return null
}

const profileCancel = (t, testId, onClose) =>
  h(
    'button',
    { type: 'button', class: 'dsg-dialog-cancel', 'data-testid': testId, onClick: onClose },
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

/**
 * Footer actions for the profile dialogs (null for every other kind).
 *
 * The create/rename/archive buttons carry the request loading guard and the
 * client-side name error; manage only offers Cancel/Close. Cancel precedes
 * Confirm so the confirm button is never the initial focus target.
 */
const profileDialogActions = ({ kind, t, busy, nameError, onClose, onRun }) => {
  if (kind === 'profile-manage') {
    return [
      h(
        'button',
        {
          key: 'close',
          type: 'button',
          class: 'dsg-dialog-cancel',
          'data-testid': 'session-groups-profile-manage-close',
          onClick: onClose,
        },
        t('dialog.cancel')
      ),
    ]
  }
  if (kind === 'profile-save-as') {
    return [
      profileCancel(t, 'session-groups-profile-save-as-cancel', onClose),
      profileSubmit(
        'session-groups-profile-save-as-confirm',
        t('profiles.create'),
        busy || nameError !== null,
        () => {
          void onRun()
        }
      ),
    ]
  }
  if (kind === 'profile-rename') {
    return [
      profileCancel(t, 'session-groups-profile-rename-cancel', onClose),
      profileSubmit(
        'session-groups-profile-rename-confirm',
        t('profiles.rename'),
        busy || nameError !== null,
        () => {
          void onRun()
        }
      ),
    ]
  }
  if (kind === 'profile-archive') {
    return [
      profileCancel(t, 'session-groups-profile-archive-cancel', onClose),
      profileSubmit('session-groups-profile-archive-confirm', t('profiles.archive'), busy, () => {
        void onRun()
      }),
    ]
  }
  return null
}

export {
  isProfileDialogKind,
  isProfileFormKind,
  profileDialogNameError,
  profileDialogBody,
  runProfileDialogAction,
  profileDialogActions,
}
