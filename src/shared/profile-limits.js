/**
 * Shared profile limits (issue #5, SPEC §7.5#1/#2).
 *
 * Single source for the unarchived-profile cap and the display-name length cap.
 * `src/host/constants.js` re-exports both for wire compatibility; the client
 * imports them from here instead of keeping private literal copies.
 */

/** Upper bound of unarchived profiles, default included (SPEC 4.3). */
export const MAX_PROFILES = 20

/** Maximum profile display-name length after trimming. */
export const MAX_PROFILE_NAME = 40
