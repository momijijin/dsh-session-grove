# Documentation index

## User documentation

- [Illustrated guides](https://momijijin.github.io/dsh-session-grove-docs-site/) — installation and the 60-second start, groups, sessions, profiles, search, header status, settings/AI control, data and backups, FAQ and per-version update notes (Chinese). The in-app first-run hint/card and the plugin settings page link here; the README is a short landing page.

## Maintainer documentation

Use these for the current `0.4.0-beta.66` codebase (the sidebar performance
batch: the observation layer now ships **off** behind a two-end opt-in, and the
batch lands the plugin-side work it measured — P2 CSS-variable width writes,
chrome measurement suspended during a width drag, the drag line decoupled from
layout with adaptive backpressure, two dialog fill fixes plus per-frame
dialog/scrollbar coalescing, and the 70 ms drop-target hold with the speed gate;
the batch ran the unit/contract gates and produced release-lane evidence:
on 2026-11-16, `test:isolated` passed on a fresh isolated home (port 4418;
narrow matrix 30 pass / 0 skip / 0 failure), and `test:locale-pack` plus
`test:all-locales` 23/23 passed on a fresh home carrying the `ja-locale-pack`
fixture (port 4419) — both are agent debug runs at the user's explicit
request, not user runs. The batch package is 899,088 bytes / sha256
`FB2A4EE93E742B30D85A51A1778A21A3518408C7E444D748D406E9C6C32ABDB8`; the real-host
UI acceptance remains the 2026-11-15 user desktop run. The last published
release is `v0.4.0-beta.65`, 2026-11-13; the
previous published release is `v0.4.0-beta.64`, 2026-11-12; before that
`v0.4.0-beta.63`, 2026-11-12). `.62`
shipped group archive, the second view-options tri-state
and the recursive structural lock; `.63` adds the first-run funnel (entry hint
+ action-first onboarding card), four in-place hints and the documentation-site
entries, and trims the READMEs to a landing page; `.64` adds one viewport
placement policy for every floating panel (status / view-options / configuration
popovers, menus and the drag label), with narrow-width and RTL adaptation;
`.65` fixes the dialog keyboard timing (focus guard + measured-rect fallback +
e2e focus/positioning assertions), adds menu scroll stability (S7: a row menu
now closes only when its own source-row ancestors scroll or the row/resize
invalidates it; unrelated scrollers such as the streaming conversation pane no
longer close it, and the scroll path reads no layout), and pays down
architecture debt (`plugin-host` / `dialog-host` splits, shared host
atomic-write/file-lock, deduplicated `sessionContainer` / registry classifier /
`MAX_PROFILES`, and an import-cycle guard). `.65` fresh-host evidence passed:
`test:isolated` (narrow matrix 30 pass) and
`test:ui-browser` (agent debug run at the user's explicit request; the S1–S6
lane used two fresh homes — the ui-browser retry reused its home; the first
ui-browser attempt had only a 12s visibility timeout and no failure screenshot,
and the "Get started" dialog timing race is inferred from that timeout plus
`e2e/ui-runtime.spec.mjs:74-82`; PASS on the same-home retry, whose log has no
explicit PASS line; S1–S6 evidence package 835,756 bytes / `AE0DE4AC…`; S7 adds
a third fresh home, `160323`, below). After
the S7 rebuild, the full `test:isolated` run against the S7 code-evidence
package (842,325 bytes / `F868…`) on fresh home `160323` also passed (narrow
matrix 30 pass, 71 screenshots, new menu case). The five manual menu checks
**passed in the user's desktop client on 2026-11-13** (user desktop acceptance:
profile `desktop`, plugin `0.4.0-beta.65`, `lib/client.js` 662,743 B /
`01F2B5B6…`); because the e2e probe does not target the real conversation-pane
scroller, that manual PASS is the direct validation of the real right-hand
pane. The e2e runs above are still an agent debug run at the user's explicit
request, not a user run:

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

- [specs/2026-11-13-perf-instrumentation.md](specs/2026-11-13-perf-instrumentation.md) — `.66` performance-instrumentation SPEC, archived at the final §18 closeout: 668 lines, 57,333 bytes, sha256 `CD9708C8C233064908CCC097AF74D18BB0945316D0F39DC08B3C09905AACEC15`
- [specs/2026-11-13-perf-instrumentation-plan.md](specs/2026-11-13-perf-instrumentation-plan.md) — `.66` implementation plan through Step 14: 386 lines, 30,027 bytes, sha256 `D713C9B8FDB3C37F792E66F5CB11FD23E7E0AFF14F68A6730C806D6EBB764A27`
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
