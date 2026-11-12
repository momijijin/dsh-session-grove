# Documentation index

## User documentation

- [Illustrated guides](https://momijijin.github.io/dsh-session-grove-docs-site/) — installation and the 60-second start, groups, sessions, profiles, search, header status, settings/AI control, data and backups, FAQ and per-version update notes (Chinese). The in-app first-run hint/card and the plugin settings page link here; the README is a short landing page.

## Maintainer documentation

Use these for the current `0.4.0-beta.65` dev codebase (not tagged or released;
the latest published release is `v0.4.0-beta.64`, 2026-11-12; before that
`v0.4.0-beta.63`, 2026-11-12). `.62` shipped group
archive, the second view-options tri-state
and the recursive structural lock; `.63` adds the first-run funnel (entry hint
+ action-first onboarding card), four in-place hints and the documentation-site
entries, and trims the READMEs to a landing page; `.64` adds one viewport
placement policy for every floating panel (status / view-options / configuration
popovers, menus and the drag label), with narrow-width and RTL adaptation;
`.65` fixes the dialog keyboard timing (focus guard + measured-rect fallback +
e2e focus/positioning assertions) and pays down architecture debt
(`plugin-host` / `dialog-host` splits, shared host atomic-write/file-lock,
deduplicated `sessionContainer` / registry classifier / `MAX_PROFILES`, and an
import-cycle guard). `.65` real-host evidence is pending (user fresh host):

- [README](../README.md) — short landing page (English); [README.zh.md](../README.zh.md) — Chinese
- [ARCHITECTURE.md](ARCHITECTURE.md) — layering, adapters, host/client boundaries, group archive
- [COMPATIBILITY.md](COMPATIBILITY.md) — DSH version policy, capability detection, distribution
- [I18N.md](I18N.md) — localized resources, resolution, aliases and language limits
- [TEST-MATRIX.md](TEST-MATRIX.md) — **single source of truth** for tested surfaces, languages and evidence levels
- [RELEASE.md](RELEASE.md) — release, install, update and verification
- [TEST-RESULTS.md](TEST-RESULTS.md) — `.65` local run plus the dated `.63` historical round and `0.4.0-beta.13` snapshot (TEST-MATRIX is current status)
- [MIGRATION-0.4.md](MIGRATION-0.4.md) — manual old-identity migration
- [BACKLOG.md](BACKLOG.md) — deferred render/performance work

## Batch design records

- [specs/2026-11-10-group-archive-freeze.md](specs/2026-11-10-group-archive-freeze.md) — `.62` group-archive/freeze SPEC
- [specs/2026-11-10-group-archive-freeze-plan.md](specs/2026-11-10-group-archive-freeze-plan.md) — `.62` implementation plan (P1–P12) and execution records
- [adr/0004-group-archive-freeze.md](adr/0004-group-archive-freeze.md) — additive `archived` field, visibility, before-state invariant, host guard and compatibility decisions

## Historical / frozen records

These document earlier design gates or V1/V1.1 decisions. They are kept for traceability and must not be read as current behavior:

- [CONTRACTS.md](CONTRACTS.md) — frozen V1/V1.1 contract
- [archive/README.md](archive/README.md) — pointer to historical records moved outside Git
- [adr/](adr/) — architecture decision records
- [release-notes/](release-notes/) — historical release notes
- External maintainer archive — V1 plans, Gate 0/Spike, superpowers plans/specs

For current behavior, current docs above win over historical records.
