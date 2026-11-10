# Test Matrix

Status: `0.4.0-beta.61`  
This file is the single source of truth for **what has actually been verified**
and at which level. Other docs should link here instead of restating counts.

Automated gates are `npm run check:style`, `npm run check:lib`, `npm test`,
`npm run check:coverage` and `npm run check:ui` in CI, plus
`npm run check:style`, `npm run check:lib`, `npm run check:ui` and
`npm run check:release` in the release workflow. `check:ui` is 39 UI runtime cases (1 module-load + 38 component tests, covering
17 components across 24 client modules) + 1 browser runtime spec, not full browser UI coverage. The A+ / LP rows below are
manual local evidence: the release workflow does not start an isolated DSH
instance or run Playwright, so a release note cannot claim A+ or all-locales as
an automated CI result.

Counts in this file describe the current `dev` tree (`0.4.0-beta.61`,
**unreleased**) unless a line says otherwise. The `.61` dev tree runs
**726/726** unit/contract tests, 39/39 UI runtime cases (1 module-load + 38
component tests, 24 client modules) and 1 browser runtime spec, with 331 locale
keys. Five real-geometry preview assertions were added to
`e2e/isolated.spec.mjs` in this batch and **PASSed on the 2026-11-10 community
isolated host** (measured: dialog 560×560px, narrow sidebar 252px, body scroll
3492 > 466px, row gaps [0,0,0]); the official A+ O host has not run `.61` yet.
The last published
release, `v0.4.0-beta.60`, was gated by 699/699 unit/contract tests and 39/39 UI
runtime cases; `.59` used 529/529 + 15/15. Those published-release numbers are
historical and must not be quoted as `.61` evidence.

## Evidence levels

| Code | Meaning |
|---|---|
| `U` | Unit/contract tests: `npm test` (726 tests on the current `.61` dev tree; 699 at the `.60` release; 529 at the `.59` release) |
| `A+ C` | Isolated Playwright, community DSH Desktop 2.0.18 / DSH `0.2.1-rc.2` |
| `A+ O` | Isolated Playwright, official DeepSeek Harness desktop 0.2.1.0 / DSH `0.2.1-rc.5` |
| `LP` | Test-only all-locale pack (`e2e/fixtures/ja-locale-pack`): host catalog injection + active locale switch |
| `H` | Historical/manual evidence in an earlier release note or test-results snapshot; not a current default automation |
| `—` | Not tested |

The default English A+ is `e2e/isolated.spec.mjs`; the language-pack A+ is
`e2e/locale-pack.spec.mjs`, and `e2e/all-locales.spec.mjs` switches through
every packaged dictionary and checks the header + new-group dialog + profile
popover/preview copy and bounds.

The `.60` profile rows below come from two isolated runs plus user acceptance.
The 2026-11-09 community isolated-host run on the profile candidate bundle
passed `test:isolated` (save-as, preview, undo, rename/archive, dual-window
active/`profile-changed` 409, scoped collapse, limit 20), `test:ui-browser`,
`test:locale-pack` and `test:all-locales` 23/23. The 2026-11-10 official A+ O
run used the official DeepSeek Harness desktop 0.2.1.0 / DSH `0.2.1-rc.5`
isolated host and the `.60` tarball (SHA256
`a27356f899d5b64f5c6134de0480428c4721d7403473f107c56a36b7225c5bc4`):
`test:isolated` passed (exit 0, port <ephemeral>, test home
`<temp>\<isolated-home>`; onboarding/search/drag/dialog/status/
264px/dark/host rail/SSE/CAS/reconnect plus the profile flows) and
`test:ui-browser` passed (exit 0, `executedRatio` 1, `executedBytes` 3091616,
fresh official host, port <ephemeral>, test home
`<temp>\<isolated-home>`). The first ui-browser attempt reused the
A+ home and was blocked by the limit-20 profile state (save-as disabled); it was
re-run on a fresh host, and that fresh-host PASS is the recorded evidence. Both
isolated web processes were stopped; the test homes were left in place.

The `.61` dev tree (unreleased) has its own isolated evidence from 2026-11-10 on
a locally installed **community** DSH Desktop host, with the tarball
`dsh-session-grove-0.4.0-beta.61.tgz` built from the current branch:
`test:isolated` PASS on the full suite (new preview geometry measured: dialog
560×560px, narrow sidebar 252px, body scroll 3492 > 466px, row gaps [0,0,0]);
`test:ui-browser` PASS on a separate fresh host (`bundleEntries` 1,
`executedBytes` 2461374 = `sourceBytes` 2461374, `executedRatio` 1);
`test:locale-pack` PASS (third-party `ja` locale pack activates the Japanese
onboarding/dialog); `test:all-locales` PASS 23/23 (19 languages plus variants,
settings/config rows included). Flake note: the first `test:isolated` attempt
aborted early at `keyboard dialog move did not move right`; re-running the whole
suite on the same build PASSed, so it is recorded as a focus/timing flake, not a
refactor regression. The official A+ O desktop host was not exercised for
`.61`; those rows remain `.60` evidence.

The last full all-locales / locale-pack sweep was the 2026-11-09 `.59` run
(23/23) until the 2026-11-10 `.61` dev run repeated it (`test:locale-pack` PASS,
`test:all-locales` PASS 23/23); `.60` itself was not re-swept. No locale
resources changed after the `.59` sweep, so the 331-key dictionaries are
covered. The latest official A+ O sweep is `.60`; the `.61` evidence above is a
community host. Earlier `.22` and `.30` cells remain historical artifacts.

## Environment matrix

| Area | U | A+ C | A+ O | LP | Native manual |
|---|---|---|---|---|---|
| Group CRUD, move, delete, session assignment | PASS | PASS | PASS | — | PASS (maintainer) |
| Persistence, CAS, conflict/SSE convergence | PASS | PASS | PASS | — | PASS |
| Control API, session actions, doctor | PASS | PASS | PASS | — | PASS |
| English onboarding/settings/menu/dialog copy | PASS | PASS | PASS | — | — |
| English plural/time labels | PASS | PASS | PASS | — | — |
| Third-party language activation (`ja`) | PASS | — | — | PASS | — |
| All-locale switch: header + new-group dialog + group menu + settings/config + profile popover/preview (19 languages + zh-TW/zh-HK/zh-CN/pt-BR aliases) | PASS | — | — | PASS (23 cases) | — |
| Arabic RTL smoke: root `dir`, menu/dialog viewport bounds, settings panel direction | PASS | — | — | PASS (23 cases + RTL screenshots) | PASS (visual review .39) |
| Multiple profiles: create/save-as, switch + diff preview, same-content direct switch, rename/archive, limit 20, default restore | PASS | PASS (2026-11-09) | PASS (2026-11-10) | — | — |
| Profile multi-window: SSE active convergence and `profile-changed` 409 | PASS | PASS (2026-11-09) | PASS (2026-11-10) | — | — |
| Profile-scoped collapsed state, epoch reset and switch/undo/reset actions | PASS | PASS (2026-11-09) | PASS (2026-11-10) | — | — |
| Profile UI: chevron/popover/preview/save-as/manage (39 UI runtime cases) | PASS | PASS (2026-11-09) | PASS (2026-11-10) | PASS (23 cases) | PASS (user desktop 2026-11-10) |
| Profile preview real geometry (SPEC §8.1: width/height caps, body scroll, wrapping, adjacent-row gaps, narrow sidebar) | — (e2e assertions added in `e2e/isolated.spec.mjs`) | PASS (2026-11-10, community isolated host, `.61` tarball; dialog 560×560px, narrow sidebar 252px, body scroll 3492>466px, row gaps [0,0,0]) | — (official host not run for `.61`) | — | — |
| Profile i18n: 45 `profiles.*` keys × 19 dictionaries | PASS | — | — | PASS (23 cases) | — |
| Full non-English UI surfaces | PASS (resources only) | — | — | LP header/dialog/group menu/settings + ja onboarding/dialog only | — |

## Language matrix

| Locale | Packaged | U parity | Runtime A+ | Language-pack A+ | Native/manual | Claim |
|---|---|---|---|---|---|---|
| `en` English | yes | PASS | A+ C + A+ O | PASS (header/dialog/group menu) | PASS | fully exercised |
| `zh` Simplified Chinese | yes | PASS | H (old `TEST-RESULTS` snapshot) | PASS (header/dialog/group menu) | H | **not a current default A+ assertion** |
| `ja` Japanese | yes | PASS | — | PASS (onboarding/dialog; all-locale) | — | follows a third-party pack |
| `ko` Korean | yes | PASS | — | PASS (header/dialog/group menu) | — | resources + locale-pack smoke |
| `de` German | yes | PASS | — | PASS (header/dialog/group menu) | — | resources + locale-pack smoke |
| `fr` French | yes | PASS | — | PASS (header/dialog/group menu) | — | resources + locale-pack smoke |
| `es` Spanish | yes | PASS | — | PASS (header/dialog/group menu) | — | resources + locale-pack smoke |
| `pt` Brazilian Portuguese | yes | PASS | — | PASS (header/dialog/group menu) | — | resources + locale-pack smoke |
| `it` Italian | yes | PASS | — | PASS (header/dialog/group menu) | — | resources + locale-pack smoke |
| `nl` Dutch | yes | PASS | — | PASS (header/dialog/group menu) | — | resources + locale-pack smoke |
| `pl` Polish | yes | PASS (one/few/many/other) | — | PASS (header/dialog/group menu) | — | resources + locale-pack smoke |
| `tr` Turkish | yes | PASS | — | PASS (header/dialog/group menu) | — | resources + locale-pack smoke |
| `vi` Vietnamese | yes | PASS | — | PASS (header/dialog/group menu) | — | resources + locale-pack smoke |
| `th` Thai | yes | PASS | — | PASS (header/dialog/group menu) | — | resources + locale-pack smoke |
| `id` Indonesian | yes | PASS | — | PASS (header/dialog/group menu) | — | resources + locale-pack smoke |
| `ru` Russian | yes | PASS (one/few/many/other) | — | PASS (header/dialog/group menu) | — | resources + locale-pack smoke |
| `hi` Hindi | yes | PASS (one/other) | — | PASS (header/dialog/group menu) | — | resources + locale-pack smoke |
| `ar` Arabic | yes | PASS (zero/one/two/few/many/other) | — | PASS (header/dialog/group menu + RTL root) | PASS (visual review .39) | RTL foundation + plugin surfaces visually accepted 2026-11-05 |
| `zh-Hant` Traditional Chinese | yes | PASS | — | PASS (header/dialog/group menu) | — | script-aware resolver; locale-pack smoke |

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

| Surface | Current evidence | Notes |
|---|---|---|
| Onboarding card | U + English A+ C/O + ja LP | ja LP checks title/dismiss |
| Settings/config form | U + English A+ C/O + all-locale settings smoke | all 23 cases check title/hint/controlApi/skill-repair copy |
| Group menu / session menu | U + English A+ C/O | |
| Profile chevron / popover / switch preview / save-as / manage | U + UI runtime (39 cases) + community A+ C (2026-11-09) + `.61` community A+ C (2026-11-10) + official A+ O (2026-11-10) + LP (23 cases) | 45 keys × 19 dictionaries; the all-locales run checks chevron, popover and preview bounds; official A+ O ran the profile save-as/preview/undo/rename/archive/limit flows in `test:isolated`; the `.61` community run covered the same profile flows plus the new preview real-geometry assertions |
| Dialog titles/body | U + English A+ C/O + ja LP (new-group title) | |
| Status labels and subagent count | U (including pl one/few/many/other) | UI uses one key + `{n}` |
| Drag labels | U + English A+ C/O | |
| Search/empty/flat fallback | U + English A+ C/O | |
| Plural objects | U parity for all 19 locales | translations are not native-reviewed |
| Long strings / narrow sidebar | English A+ only | ru/hi/ar 264px-min sidebar (252px content) screenshots: no root overflow; title ellipsizes at minimum width |
| RTL | Root `dir`, menu/dialog bounds, settings direction | fine geometry/drag mirroring still not exhaustively audited |

## Not verified

- Preview dialog real geometry in `.61`: PASS on the 2026-11-10 **community**
  isolated host (see the `.61` evidence paragraph above; measured dialog
  560×560px, narrow sidebar 252px, body scroll 3492 > 466px, row gaps [0,0,0]).
  The official A+ O desktop host has NOT run the `.61` tarball yet, so official
  A+ O coverage for `.61` remains pending.
- Profile flows in `.60` have community A+ C (2026-11-09), official A+ O
  (2026-11-10, `test:isolated` + `test:ui-browser`), LP (2026-11-09) and user
  desktop acceptance (2026-11-10) evidence. The official A+ O `.60` run is not
  a full all-locales / locale-pack re-run: the `.59` run was the last full sweep
  until the `.61` dev run repeated it on a community host (23/23), and `.60`
  itself was not re-swept.
- The profile two-window active/`profile-changed` path has community A+ C and
  official A+ O coverage (one context, two pages); a cross-desktop or
  cross-process multi-window run is still not recorded.
- Full A+ remains English-only; Japanese has the onboarding/dialog fixture.
- All 19 packaged dictionaries have header/dialog/group-menu/settings smoke
  coverage, not full-surface A+.
- No native/client visual pass beyond ru/hi/ar narrow-sidebar screenshots.
- No translation-quality review beyond structural parity.
- Arabic RTL has root direction, menu/dialog bounds and settings direction,
  but no exhaustive drag/resize geometry or every-icon visual mirror audit.

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
