# Documentation index

## Current documentation

Use these for the current `0.4.0-beta.62` codebase (unreleased `dev` batch;
the latest published release is `v0.4.0-beta.61`, 2026-11-10, two GitHub
Release assets). `.61` shipped the module split; `.62`
adds group archive, the second view-options tri-state and the recursive
structural lock:

- [README](../README.md) — English default
- [README.zh.md](../README.zh.md) — Chinese
- [ARCHITECTURE.md](ARCHITECTURE.md) — layering, adapters, host/client boundaries, group archive
- [COMPATIBILITY.md](COMPATIBILITY.md) — DSH version policy, capability detection, distribution
- [I18N.md](I18N.md) — localized resources, resolution, aliases and language limits
- [TEST-MATRIX.md](TEST-MATRIX.md) — **single source of truth** for tested surfaces, languages and evidence levels
- [RELEASE.md](RELEASE.md) — release, install, update and verification
- [TEST-RESULTS.md](TEST-RESULTS.md) — `.62` local run plus the dated `0.4.0-beta.13` historical snapshot (TEST-MATRIX is current status)
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
