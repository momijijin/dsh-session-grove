# Test Matrix

Status: `0.4.0-beta.63`  
This file is the single source of truth for **what has actually been verified**
and at which level. Other docs should link here instead of restating counts.

Automated gates are `npm run check:style`, `npm run check:lib`, `npm test`,
`npm run check:coverage` and `npm run check:ui` in CI, plus
`npm run check:style`, `npm run check:lib`, `npm run check:ui` and
`npm run check:release` in the release workflow. Since the `.61` batch both
workflows also run a production dependency audit
(`npm audit --omit=dev --audit-level=high`) and the two third-party actions are
pinned to immutable commit SHAs. `check:ui` is now 44 UI runtime cases (1
module-load + 43 component tests, covering 19 components across 26 client
modules) + 1 browser runtime spec, not full browser UI coverage. The A+ / LP
rows below are manual local evidence: the release workflow does not start an
isolated DSH instance or run Playwright, so a release note cannot claim A+ or
all-locales as an automated CI result.

Counts in this file describe the current `dev` tree unless a line says
otherwise; the **`.64` batch evidence** below is the current count, and the
published `.63` figures that follow are historical. The `.63` tree (released as
`v0.4.0-beta.63` on 2026-11-12) ran **914/914** unit/contract tests and 42/42
`check:ui` cases with **397 locale keys in 19 dictionaries** (385 → 397 in this
batch: 12 keys for the entry hint, in-place hints and the documentation-site
entries; `onboarding.title` / `onboarding.body` were rewritten shorter). The
`.63` community run passed `test:isolated`, `test:locale-pack` and
`test:all-locales` on 2026-11-12; only the fresh-host
browser spec (`test:ui-browser`) was **not** run for `.63`. The `.62`
four-command A+ C evidence below remains the latest complete sweep and applies
to the `.62` tarball.

**`.64` batch evidence (narrow-viewport floating panels, 2026-11-12).**
This is the `0.4.0-beta.64` dev batch: the package version is still
`0.4.0-beta.63` until the release step, so the plugin tarball used below carries
the `.63` version string. The batch supersedes the `.63` counts in the status
paragraph above: the dev tree now runs **938/938** unit/contract tests and
**44/44** UI runtime cases (1 module-load + 43 component tests, 19 components
across 26 client modules; `floating-panel.js` is the new module), with the same
**397** locale keys in 19 dictionaries (no locale resource changed).

- `npm run test:isolated` — **PASS** (exit 0) on a local isolated DSH Desktop
  instance (community-host A+ C lane, `.63` plugin tarball built from this
  tree). The new narrow-viewport matrix ran **30 cells: 30 pass, 0 failure,
  0 `SKIP(host-rail)`**. The 4-key `HOST_RAIL_ALLOWLIST` (264/420 × 960×600 and
  264/420 × 823×514) was not needed this run, so the 150%/175% zoom geometries
  were reachable:
  - **Tier A** — all five surfaces (running/blocked/unread counts, view options,
    profile) × sidebar {264, 420} × viewport {1440×900, 1152×720 (125%),
    823×514 (175%), 1440×480 (short)} = **8 cells**; I1/I2/I3/I7.
  - **Tier B** — blocked + view options × {320, 340, 380} × {1440×900,
    1152×720} and × {264, 420} × {1280×800, 960×600, 1280×400} = **12 cells**,
    with the compact flags (`data-narrow` true at 264/320/340/380 and false at
    420; `data-title-collapsed` true only at 264).
  - **Tier C** — focus return, two-frame stability, exact outer width equal to
    the computed border-box width and internal scrolling × {264, 420} ×
    1440×900, plus a 1440×480 short-viewport sub-cell where view options really
    overflow (content 402 > box 228, `scrollTop` 174 > 0) = **4 cells**.
  - **Tier D** — data-* only × {280, 300, 360} × 1440×900 (280/300
    `data-title-collapsed=true`, 360 false, all three `data-narrow=true`) plus
    the 264 → 420 → 340 → 420 re-expand cell = **4 cells**.
  - **RTL subset** — 264 × 1440×900 with `dir=rtl` (`data-placement` mirrors:
    the profile panel stays `inline-start`, the status panel is `flipped` in LTR
    and `inline-end` in RTL, four corners still hit) = **1 cell**.
  - **Menu cell** — 264 × 800×600 with a >40-character group name: width ≤
    min(360, vw−16), `box-sizing: border-box`, label span + `title` +
    single-line ellipsis, long row label 576 > 88 = **1 cell**.
- **69 screenshots** were written to the test home as
  `narrow-<sidebar>-<vw>x<vh>-<surface>.png`. Key names:
  `narrow-264-1440x900-running.png`, `-blocked`, `-unread`, `-view-options`,
  `-profile`, `narrow-420-1440x900-blocked.png`,
  `narrow-264-1152x720-view-options.png`, `narrow-264-823x514-profile.png`,
  `narrow-264-1440x480-unread.png`, `narrow-320-1440x900-blocked.png`,
  `narrow-380-1152x720-view-options.png`, `narrow-264-1280x400-view-options.png`,
  `narrow-264-1440x480-view-options-scroll.png`,
  `narrow-264-1440x900-rtl-profile.png`, `narrow-264-1440x900-rtl-blocked.png`,
  `narrow-264-800x600-menu-long-label.png`.
- `npm run test:ui-browser` — **PASS** on a fresh test home. Reusing the home
  right after `test:isolated` fails at the 20-profile limit (Save-as disabled):
  the fresh-host requirement already recorded for `.62`, not a code failure.
- **Launcher note (non-blocking):** `scripts/qa/start-isolated-web.ps1`'s URL
  polling timed out on this run. The suite was executed against the **same test
  home** with the isolated web process started manually (`web.json` →
  `DSH_TEST_URL` / `DSH_TEST_HOME`), so the instance, the plugin package and the
  isolation are unchanged; only the launcher path differed. Recorded as
  environment evidence, not as a product failure.
- Not claimed for `.64`: `test:locale-pack` / `test:all-locales` were not re-run
  (no locale resource changed; the `.63` 397-key sweeps stay the locale
  evidence), official A+ O was not run (the latest official evidence remains
  `.61`), and the plan's manual ru/de long-locale and ar RTL spot checks were
  **not** performed — the RTL geometry above comes from the injected `dir=rtl`
  cell, not from an Arabic screenshot review.

**`.63` community evidence (partial: `test:isolated` + locale sweeps PASS,
2026-11-12).**
The `.63` tarball (`dsh-session-grove-0.4.0-beta.63.tgz`, built from this tree)
was exercised on a community DSH Desktop Stable 2.0.18 / DSH `0.2.1-rc.2`
isolated host (new test home `%TEMP%\dsh-sg-e2e-20261112-114220`, port 4420):
`npm run test:isolated` PASS (exit 0), including the first-run additions (entry
hint copy + docs link + retirement on entering, onboarding title / docs-site
link / dismiss and the reload non-reappearance) plus the full existing
regression (onboarding/search/archive filter/drag/dialog/status/head insertion/
collapse/264px/dark/host rail/external SSE/workspace round-trip/rapid revision/
multi-window SSE/CAS/reconnect/profiles/limits/session actions/clipboard/
settings/localized title/diagnostics/switch/destructive confirm; preview
geometry dialog 560×560px, narrow sidebar 252px, body scroll 3659>466px, row
gaps [0,0,0]). A second locale host (`%TEMP%\dsh-sg-e2e-20261112-114312`, port
4421, with `e2e/fixtures/ja-locale-pack`) then passed `npm run test:locale-pack`
(third-party `ja` pack; fixture expectation updated to the shortened
`フリーグループ` onboarding title) and `npm run test:all-locales` **23/23** (19
languages + aliases, 397 keys, including settings/config). `test:ui-browser`
(fresh host) was **not** run for `.63`, so no fresh-host browser PASS is
claimed. Both isolated web processes were stopped; the test homes were left in
`%TEMP%`.

**`.62` community A+ C evidence: PASS (2026-11-11).** The `.62` tarball
(`dsh-session-grove-0.4.0-beta.62.tgz`, **829,055 bytes**, sha256
`47DFB392…11B34`) was exercised on the community DSH Desktop Stable 2.0.18 /
DSH `0.2.1-rc.2` isolated host: `npm run test:isolated` PASS (exit 0; preview
geometry dialog 560×560px, narrow sidebar 252px, body scroll 3659>466px, row
gaps [0,0,0]); `npm run test:ui-browser` PASS on a **fresh** isolated host
(`bundleEntries:1`, `executedBytes:2538003`, `sourceBytes:2538003`,
`executedRatio:1`); `npm run test:locale-pack` PASS (third-party `ja` pack);
`npm run test:all-locales` PASS **23/23** (19 languages + aliases, 385 keys).
The four commands above are manual local evidence, not CI artifacts, and this
section is the `.62` claim. **The official `.62` A+ O run was not executed**:
the latest official evidence remains `.61` (official DeepSeek Harness 0.2.2.0 /
DSH `0.2.2-rc.1`), and no official `.62` PASS is claimed. Full command output
and the fresh-host constraint are in [TEST-RESULTS.md](TEST-RESULTS.md) and the
`.62` release note.

The `.62` e2e scripts were updated for the new UI contract and
`e2e/isolated.spec.mjs` was executed in the 2026-11-11 run (the session archive
tri-state picks keep the popover open and are closed with Escape; PASS).
`e2e/groups.spec.mjs` remains a historical manual script for the **group**
tri-state segment (6 rows, separate `data-filter` / `data-group-filter`,
`aria-checked`, 30px rows, titled `role=group` sections, keep-open across group
picks, group picks do not change the session filter); it was **not executed** in
this run, so its group-specific assertions are not `.62` A+ evidence.

The last published release, `v0.4.0-beta.61`, was gated by 726/726
unit/contract tests and 39/39 UI runtime cases; the `.60` release used 699/699
and 39/39, and `.59` used 529/529 + 15/15. Those published/dev-batch numbers
are historical and must not be quoted as `.62` evidence.

## Evidence levels

| Code | Meaning |
|---|---|
| `U` | Unit/contract tests: `npm test` (907 tests on the current `.62` dev tree; 726 at the `.61` dev tree; 699 at the `.60` release; 529 at the `.59` release) |
| `A+ C` | Isolated Playwright, community DSH Desktop 2.0.18 / DSH `0.2.1-rc.2` (`.62`: 2026-11-11 PASS, `.62` tarball 829,055 bytes) |
| `A+ O` | Isolated Playwright on an official DeepSeek Harness desktop host (`.60`: 0.2.1.0 / DSH `0.2.1-rc.5`; `.61`: 0.2.2.0 / DSH `0.2.2-rc.1`; `.62`: **not run**) |
| `LP` | Test-only all-locale pack (`e2e/fixtures/ja-locale-pack`): host catalog injection + active locale switch |
| `H` | Historical/manual evidence in an earlier release note or test-results snapshot; not a current default automation |
| `—` | Not tested |

The default English A+ is `e2e/isolated.spec.mjs`; the language-pack A+ is
`e2e/locale-pack.spec.mjs`, and `e2e/all-locales.spec.mjs` switches through
every packaged dictionary and checks the header + new-group dialog + profile
popover/preview copy and bounds.

## Current `.62` isolated evidence (2026-11-11)

Artifact: `dsh-session-grove-0.4.0-beta.62.tgz`, **829,055 bytes**, sha256
`47DFB392…11B34` (user-supplied abbreviated digest). Host: community DSH
Desktop Stable 2.0.18 / DSH `0.2.1-rc.2`, isolated instance with temporary
`DSH_HOME`.

- `npm run test:isolated` — **PASS** (exit 0). Suite covers onboarding/search/
  archive filter/drag/dialog/status/head insertion/collapse/264px/dark/host
  rail/external SSE/workspace refresh/rapid revision/multi-window SSE/CAS/
  reconnect/profiles/limits/session actions/clipboard/settings/localized title/
  diagnostics/switch/destructive confirm. Preview geometry: dialog 560×560px,
  narrow sidebar **252px**, body scroll **3659>466px**, row gaps [0,0,0].
- `npm run test:ui-browser` — **PASS** (exit 0) on a **fresh** isolated host:
  `bundleEntries:1`, `executedBytes:2538003`, `sourceBytes:2538003`,
  `executedRatio:1`.
- `npm run test:locale-pack` — **PASS** (exit 0): the third-party `ja` locale
  pack activates Japanese onboarding/dialog copy.
- `npm run test:all-locales` — **PASS 23/23** (exit 0): 19 languages + aliases
  (`en zh zh-Hant zh-TW zh-HK zh-CN ja ko de fr es pt pt-BR it nl pl tr vi th id
  ru hi ar`), settings/config included; VISUAL ru/hi/ar root 252px, header 4px,
  scroll 124/57/96.

**Fresh-host requirement (non-blocking environment constraint):** the first
`test:ui-browser` attempt reused the host immediately after `test:isolated`,
where the profile count had reached the limit of 20 and the Save-as button was
disabled. That is leftover host state, not a code failure; the fresh-host re-run
PASSed and is the recorded evidence. `test:ui-browser` must run on a fresh
isolated host.

**Official A+ O:** not run for `.62`. The latest official evidence is the
2026-11-10 `.61` run (official DeepSeek Harness 0.2.2.0 / DSH `0.2.2-rc.1`),
recorded below as historical; no official `.62` PASS is claimed.

## Historical isolated evidence (through `.61`)

This subsection records runs that predate `.62`; it is not `.62` evidence.

The `.60` profile rows below come from two isolated runs plus user acceptance.
The 2026-11-09 community isolated-host run on the profile candidate bundle
passed `test:isolated` (save-as, preview, undo, rename/archive, dual-window
active/`profile-changed` 409, scoped collapse, limit 20), `test:ui-browser`,
`test:locale-pack` and `test:all-locales` 23/23. The 2026-11-10 official A+ O
run used the official DeepSeek Harness desktop 0.2.1.0 / DSH `0.2.1-rc.5`
isolated host and the `.60` tarball (SHA256
`a27356f899d5b64f5c6134de0480428c4721d7403473f107c56a36b7225c5bc4`):
`test:isolated` passed (exit 0, port 4419, test home
`%TEMP%\dsh-sg-e2e-20261110-021019`; onboarding/search/drag/dialog/status/
264px/dark/host rail/SSE/CAS/reconnect plus the profile flows) and
`test:ui-browser` passed (exit 0, `executedRatio` 1, `executedBytes` 3091616,
fresh official host, port 4420, test home
`%TEMP%\dsh-sg-e2e-20261110-021259`). The first ui-browser attempt reused the
A+ home and was blocked by the limit-20 profile state (save-as disabled); it was
re-run on a fresh host, and that fresh-host PASS is the recorded evidence. Both
isolated web processes were stopped; the test homes were left in place.

The `.61` release tree has its own isolated evidence from 2026-11-10 on
a locally installed **community** DSH Desktop host, with the tarball
`dsh-session-grove-0.4.0-beta.61.tgz` built from the current branch:
`test:isolated` PASS on the full suite (new preview geometry measured: dialog
560×560px, narrow sidebar 252px, row gaps [0,0,0]; the body scroll assertion
holds — `scrollHeight` ≫ `clientHeight`, fixture-dependent order ~3.5–3.7k px >
466px, the absolute scroll height floats with the fixture content);
`test:ui-browser` PASS on a separate fresh host (`bundleEntries` 1,
`executedBytes` 2461374 = `sourceBytes` 2461374, `executedRatio` 1);
`test:locale-pack` PASS (third-party `ja` locale pack activates the Japanese
onboarding/dialog); `test:all-locales` PASS 23/23 (19 languages plus variants,
settings/config rows included). Flake note: the first `test:isolated` attempt
aborted early at `keyboard dialog move did not move right`; re-running the whole
suite on the same build PASSed, so it is recorded as a focus/timing flake, not a
refactor regression. The official A+ O host then ran the same `.61` tarball on
2026-11-10 (official DeepSeek Harness isolated host, FileVersion `0.2.2-rc.1` /
ProductVersion `0.2.2.0`): `test:isolated` PASS on the full suite with preview
geometry measured as dialog 560×560px, **narrow sidebar 256px**, row gaps
[0,0,0]; the body scroll assertion holds (`scrollHeight` ≫ `clientHeight`, same
fixture-dependent order), and the official host insets the plugin root
differently from the community host (256 vs 252px) — exactly what the
narrow-layout band assertion accepts by design; `test:ui-browser` PASS on a
separate fresh official host (`bundleEntries` 1, `executedBytes` 3096507 =
`sourceBytes` 3096507, `executedRatio` 1). Final re-verification on HEAD
`8df323c` (2026-11-10): community and official isolated runs both PASS, both
`test:ui-browser` runs report `executedRatio` 1, `test:locale-pack` PASS and
`test:all-locales` PASS 23/23. The `.60` official A+ O rows remain
historical.

The 2026-11-10 `.61` dev run repeated the all-locales / locale-pack sweep
(`test:locale-pack` PASS, `test:all-locales` PASS 23/23, 331 keys); `.60` itself
was not re-swept. `.62` added 54 keys (385 total) and changed the view-options
popover contract, and the 2026-11-11 community run repeated both
(`test:locale-pack` PASS, `test:all-locales` PASS 23/23 on 385 keys), so the
385-key dictionaries are runtime-covered on the community host. The latest
official A+ O sweep is `.61` (the 2026-11-10 official run covered
`test:isolated` + `test:ui-browser`, not the locale sweeps); the `.61`
locale-sweep evidence above is a community host, and `.62` was not re-run on the
official host. Earlier `.22` and `.30` cells remain historical artifacts.

## Environment matrix

| Area | U | A+ C | A+ O | LP | Native manual |
|---|---|---|---|---|---|
| Group CRUD, move, delete, session assignment | PASS | PASS | PASS | — | PASS (maintainer) |
| Group archive: additive `archived` (missing=false), effective inheritance, hidden/all/only + pathOnly, frozen-subtree invariants, host 409 `archive-frozen`, control `group.archive` (409/422 split) | PASS (907-test suite) | not covered by the `.62` isolated run (group flows live in `e2e/groups.spec.mjs`, not executed) | not run (official latest `.61`) | — | pending (manual) |
| Group archive UI: two tri-state segments, `data-path-only`/`data-contains-archived`/`data-structural-locked`, archived-session rename/archive still available, drag/fork disabled, search/status no leakage, invisible-result toast, 19-language copy | PASS (41 UI runtime cases + source/logic tests) | partial (session tri-state + popover keep-open in `test:isolated`; group-segment script not run) | not run (official latest `.61`) | PASS (23 cases, `.62` 385-key run) | partial (4 UI-patch items, user desktop 2026-11-11) |
| Persistence, CAS, conflict/SSE convergence | PASS | PASS | PASS | — | PASS |
| Control API, session actions, doctor | PASS | PASS | PASS | — | PASS |
| English onboarding/settings/menu/dialog copy | PASS | PASS | PASS | — | — |
| English plural/time labels | PASS | PASS | PASS | — | — |
| Third-party language activation (`ja`) | PASS | — | — | PASS (`.62` locale-pack, 2026-11-11) | — |
| All-locale switch: header + new-group dialog + group menu + settings/config + profile popover/preview (19 languages + zh-TW/zh-HK/zh-CN/pt-BR aliases) | PASS | — | — | PASS (23 cases, `.62` 385-key run) | — |
| Arabic RTL smoke: root `dir`, menu/dialog viewport bounds, settings panel direction | PASS | — | — | PASS (23 cases + ru/hi/ar visual notes, `.62`) | PASS (visual review .39) |
| Multiple profiles: create/save-as, switch + diff preview, same-content direct switch, rename/archive, limit 20, default restore | PASS | PASS (2026-11-11, `.62`; `.59` historical) | PASS (2026-11-10, `.60`; historical) | — | — |
| Profile multi-window: SSE active convergence and `profile-changed` 409 | PASS | PASS (2026-11-11, `.62`; earlier historical) | PASS (2026-11-10, historical) | — | — |
| Profile-scoped collapsed state, epoch reset and switch/undo/reset actions | PASS | PASS (2026-11-11, `.62`; earlier historical) | PASS (2026-11-10, historical) | — | — |
| Profile UI: chevron/popover/preview/save-as/manage (39 UI runtime cases in `.60`; 41 in `.62`) | PASS | PASS (2026-11-11, `.62`; `.59` historical) | PASS (2026-11-10, historical) | PASS (23 cases, `.62` 385-key run) | PASS (user desktop 2026-11-10, historical) |
| Profile preview real geometry (SPEC §8.1: width/height caps, body scroll, wrapping, adjacent-row gaps, narrow sidebar) | — (e2e assertions in `e2e/isolated.spec.mjs`; `.61`/`.62` runtime evidence) | PASS (2026-11-11, community isolated host, `.62` tarball; dialog 560×560px, narrow sidebar 252px, body scroll 3659>466px, row gaps [0,0,0]; `.61` 2026-11-10 values were the same 252px/560×560/gaps) | PASS (2026-11-10, official DeepSeek Harness 0.2.2.0 / `0.2.2-rc.1` isolated host, `.61` tarball; dialog 560×560px, narrow sidebar 256px, body `scrollHeight` ≫ `clientHeight` (fixture-dependent), row gaps [0,0,0]) | — | — |
| Profile i18n: 46 `profiles.*` keys × 19 dictionaries | PASS | — | — | PASS (23 cases, `.62` 385-key run) | — |
| Full non-English UI surfaces | PASS (resources only) | — | — | LP header/dialog/group menu/settings + ja onboarding/dialog only | — |

## Language matrix

The language-pack A+ column below is the **2026-11-11 `.62` community run
(385 keys, 23/23)**; it supersedes the `.61` 331-key cells. It covers the header
+ new-group dialog + group menu + settings/config + profile popover/preview (and
the Arabic RTL root), not full-surface A+.

| Locale | Packaged | U parity | Runtime A+ | Language-pack A+ (`.62`, 2026-11-11) | Native/manual | Claim |
|---|---|---|---|---|---|---|
| `en` English | yes | PASS | A+ C (`.62`) + A+ O (`.61`, historical) | PASS (header/dialog/group menu, `.62` 385 keys) | PASS | fully exercised |
| `zh` Simplified Chinese | yes | PASS | H (old `TEST-RESULTS` snapshot) | PASS (header/dialog/group menu, `.62` 385 keys) | H | **not a current default A+ assertion** |
| `ja` Japanese | yes | PASS | — | PASS (onboarding/dialog; `.62` all-locale + locale-pack) | — | follows a third-party pack |
| `ko` Korean | yes | PASS | — | PASS (header/dialog/group menu, `.62` 385 keys) | — | resources + locale-pack smoke |
| `de` German | yes | PASS | — | PASS (header/dialog/group menu, `.62` 385 keys) | — | resources + locale-pack smoke |
| `fr` French | yes | PASS | — | PASS (header/dialog/group menu, `.62` 385 keys) | — | resources + locale-pack smoke |
| `es` Spanish | yes | PASS | — | PASS (header/dialog/group menu, `.62` 385 keys) | — | resources + locale-pack smoke |
| `pt` Brazilian Portuguese | yes | PASS | — | PASS (header/dialog/group menu, `.62` 385 keys) | — | resources + locale-pack smoke |
| `it` Italian | yes | PASS | — | PASS (header/dialog/group menu, `.62` 385 keys) | — | resources + locale-pack smoke |
| `nl` Dutch | yes | PASS | — | PASS (header/dialog/group menu, `.62` 385 keys) | — | resources + locale-pack smoke |
| `pl` Polish | yes | PASS (one/few/many/other) | — | PASS (header/dialog/group menu, `.62` 385 keys) | — | resources + locale-pack smoke |
| `tr` Turkish | yes | PASS | — | PASS (header/dialog/group menu, `.62` 385 keys) | — | resources + locale-pack smoke |
| `vi` Vietnamese | yes | PASS | — | PASS (header/dialog/group menu, `.62` 385 keys) | — | resources + locale-pack smoke |
| `th` Thai | yes | PASS | — | PASS (header/dialog/group menu, `.62` 385 keys) | — | resources + locale-pack smoke |
| `id` Indonesian | yes | PASS | — | PASS (header/dialog/group menu, `.62` 385 keys) | — | resources + locale-pack smoke |
| `ru` Russian | yes | PASS (one/few/many/other) | — | PASS (header/dialog/group menu, `.62` 385 keys) | — | resources + locale-pack smoke |
| `hi` Hindi | yes | PASS (one/other) | — | PASS (header/dialog/group menu, `.62` 385 keys) | — | resources + locale-pack smoke |
| `ar` Arabic | yes | PASS (zero/one/two/few/many/other) | — | PASS (header/dialog/group menu + RTL root, `.62` 385 keys) | PASS (visual review .39) | RTL foundation + plugin surfaces visually accepted 2026-11-05 |
| `zh-Hant` Traditional Chinese | yes | PASS | — | PASS (header/dialog/group menu, `.62` 385 keys) | — | script-aware resolver; locale-pack smoke |

Important distinction:

```text
U parity PASS = the resource has the right keys, placeholders and plural
categories; it does not prove translation quality or visual fit.
LP PASS = the active locale changes and the header + new-group dialog + group
menu + settings + profile popover/preview render that dictionary; full drag
surfaces are still not part of this smoke.
```

## Locale aliases

All ids are trimmed, lowercased and `_` is treated as `-`. Script/region
candidates are tried before the base language (see `zh-Hant` rows).
`Intl.PluralRules` still receives the original normalized id, so regional
plural rules are used for plural selection.

| Input family | Selected dictionary | Notes |
|---|---|---|
| `en`, `en-US`, `en-GB`, `en_US` | `en` | fallback language |
| `zh`, `zh-CN`, `zh-Hans`, `zh-SG` | `zh` | Simplified Chinese |
| `zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO`, `zh-Hant-TW` | `zh-Hant` | Traditional Chinese; script/region fallback |
| `ja`, `ja-JP`, `ja_JP` | `ja` | |
| `ko`, `ko-KR` | `ko` | |
| `de`, `de-DE`, `de-AT` | `de` | |
| `fr`, `fr-FR`, `fr-CA` | `fr` | |
| `es`, `es-ES`, `es-419`, `es-MX` | `es` | |
| `pt`, `pt-BR`, `pt-PT` | `pt` | packaged resource is Brazilian Portuguese |
| `it`, `it-IT` | `it` | |
| `nl`, `nl-NL` | `nl` | |
| `pl`, `pl-PL` | `pl` | one/few/many/other |
| `tr`, `tr-TR` | `tr` | |
| `ru`, `ru-RU` | `ru` | one/few/many/other |
| `hi`, `hi-IN` | `hi` | one/other |
| `vi`, `vi-VN` | `vi` | |
| `th`, `th-TH` | `th` | |
| `id`, `id-ID` | `id` | |
| unknown, empty, malformed | `en` | no exception/throw |

## Surface matrix

A+ C / LP cells in this table include the 2026-11-11 `.62` community run; A+ O
cells remain historical through `.61` (no official `.62` run).

| Surface | Current evidence | Notes |
| Onboarding card | U + `.62` community A+ C + English A+ O (historical) + ja LP (`.62`) | ja LP checks title/dismiss |
| Settings/config form | U + `.62` community A+ C + all-locale settings smoke (`.62`, 23 cases) | all 23 cases check title/hint/controlApi/skill-repair copy |
| Group menu / session menu | U + `.62` community A+ C (`test:isolated` menu/dialog paths) + English A+ O (historical) + `.62` U for archive lock items | `.62` archive-locked menu items are covered by logic/UI runtime tests and the 23-case LP group-menu copy, not by a dedicated archive A+ |
| View options: session + group tri-state segments | U + 41-case UI runtime + `.62` community A+ C (`test:isolated`: session tri-state picks keep the popover open, Escape closes) + updated `e2e/groups.spec.mjs` (group segment, not executed) | two labelled `role=group` segments, 6 rows, keep-open behavior; the group-segment script remains unrun |
| Group archive row/header/drag surfaces | U + UI runtime (`data-archived`/`data-path-only`/`data-contains-archived`/`data-structural-locked`) + `.62` LP (group-menu/archive copy) | group-archive A+ flows live in `e2e/groups.spec.mjs`, which was not executed; dimming/pathOnly/disabled-`+` visual review still pending |
| Profile chevron / popover / switch preview / save-as / manage | U + UI runtime (39 cases in `.60`; 41 cases in `.62`) + community A+ C (2026-11-11, `.62`) + `.61` community A+ C (2026-11-10, historical) + official A+ O (2026-11-10, `.60`) + official A+ O (2026-11-10, `.61`) + LP (23 cases, `.62` 385 keys) | 46 keys × 19 dictionaries; the all-locales run checks chevron, popover and preview bounds; official A+ O ran the profile save-as/preview/undo/rename/archive/limit flows in `test:isolated` (both `.60` and `.61`); the `.61` community/official runs and the 2026-11-11 `.62` community run covered the same profile flows plus the preview real-geometry assertions. The `profiles.preview.archiveChanged` key added in `.62` has U parity only |
| Dialog titles/body | U + `.62` community A+ C + English A+ O (historical) + ja LP (new-group title, `.62`) | |
| Status labels and subagent count | U (including pl one/few/many/other) + `.62` community A+ C (status buttons) | UI uses one key + `{n}` |
| Drag labels | U + `.62` community A+ C (drag auto-expand/group edges) + English A+ O (historical) | |
| Search/empty/flat fallback | U + `.62` community A+ C (search) + English A+ O (historical) | |
| Plural objects | U parity for all 19 locales | translations are not native-reviewed |
| Long strings / narrow sidebar | `.62` community A+ C (264px, English) | ru/hi/ar 264px-min sidebar (252px content) screenshots: no root overflow; at 264/280/300px the header title is hidden as a whole (`data-title-collapsed`, `.64`), the wrapper's `title` and the chevron's `aria-label` stay readable, and the full title returns from 320px |
| RTL | Root `dir`, menu/dialog bounds, settings direction | fine geometry/drag mirroring still not exhaustively audited |

## Not verified

- **The group-archive-specific A+ script was not executed.** `e2e/groups.spec.mjs`
  (two group tri-state segments, keep-open across group picks, hidden/`only`/
  `pathOnly`, archived-session rename/archive, drag/fork disabled, search/status
  no-leak, focus/toast) is not part of the four commands run on 2026-11-11.
  `test:isolated` covers the session archive tri-state and the general
  archive-filter/drag/status/search paths, so the group-specific A+ flows have
  U + UI runtime + LP coverage only. This is the one `.62` A+ gap; run
  `e2e/groups.spec.mjs` manually on a fresh host to close it.
- **`.62` official A+ O was not run.** Community A+ C (2026-11-11) passed all
  four commands; the latest official evidence remains the 2026-11-10 `.61` run
  (official 0.2.2.0 / DSH `0.2.2-rc.1`). No official `.62` claim is made.
- **`test:ui-browser` requires a fresh isolated host.** The first `.62` attempt
  reused the host right after `test:isolated`, where the profile count had
  reached the limit of 20 and Save-as was disabled; that is leftover host
  state, not a code failure. The fresh-host re-run PASSed (`executedRatio` 1).
  This is a non-blocking environment constraint, not a product defect.
- The 385-key dictionaries have structural parity and the 2026-11-11 community
  all-locale runtime sweep (23/23); no official-host `.62` locale sweep exists.
- Profile flows in `.62` have community A+ C (2026-11-11); official A+ O is
  historical `.60`/`.61`. The official A+ O `.60` run is not a full all-locales
  / locale-pack re-run: `.60` itself was not re-swept and the `.62` official
  host was not exercised.
- The profile two-window active/`profile-changed` path has community A+ C
  (`.62`) and official A+ O (`.60`/`.61`, one context, two pages); a
  cross-desktop or cross-process multi-window run is still not recorded.
- Full A+ remains English-only; Japanese has the onboarding/dialog fixture.
- All 19 packaged dictionaries have header/dialog/group-menu/settings smoke
  coverage through `.62` (23 cases), not full-surface A+.
- No native/client visual pass beyond ru/hi/ar narrow-sidebar screenshots; the
  `.62` archived-group dimming and disabled-`+` effective opacity (~.28) still
  need a real-desktop visual check (the 2026-11-11 user desktop acceptance
  covered only the four UI-patch items).
- No translation-quality review beyond structural parity.
- Arabic RTL has root direction, menu/dialog bounds and settings direction,
  but no exhaustive drag/resize geometry or every-icon visual mirror audit; the
  `.62` archive badge/lock word order has not been visually reviewed in RTL.

## Required evidence before claiming a new language

1. `U`: key/placeholders/plural categories/non-empty values pass for every
   resource.
2. Add aliases and a base-language resolution test.
3. Run at least an English A+ regression (no global regression).
4. Add the language to `e2e/all-locales.spec.mjs`; assert header + new-group
   dialog copy, the profile popover/preview copy and bounds, and, for RTL, the
   plugin root `dir`. Full settings/menu copy
   still needs its own fixture.
5. For RTL languages, add `dir` propagation, core logical/physical overrides,
   and a visual regression before claiming full support.
