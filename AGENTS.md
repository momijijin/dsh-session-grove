# dsh-session-grove — 项目开发与发布规则

本文件只适用于本仓库；与全局 `~/.dsh/AGENTS.md` 或外层工作区规则冲突时，以本文件为准。

## 1. 分支模型：dev 集成，main 只发布

```text
dev              开发集成主分支；日常所有工作从这里开始
main             发布分支；只接收经过验收的 dev 环形合并，不直接开发
feature/<slug>   本地临时开发分支；每个问题/需求一条
hotfix/<slug>    线上修复分支；从 main 切出
```

硬规则：

- **不再把 dev 和 main 做日常全量同步**；main 的每一次前进都必须对应一次发布或热修复。
- main 不直接提交功能、文档或测试改动。
- feature/hotfix 合并必须使用 `--no-ff`，保留环形合并边界。
- 本地临时分支默认不推送；需要协作或备份时再单独说明并推送。
- 合并前分支上必须完成对应验证；CI 绿灯是前置条件，不是验收结论。

## 2. 日常开发：feature → dev

```bash
git switch dev
git switch -c feature/<slug>

# 开发、补测试、更新文档
npm test
npm run build

git switch dev
git merge --no-ff feature/<slug> -m "merge: <简述> (feature/<slug>)"
git tag -a archive/feature/<slug> -m "archive feature/<slug>" feature/<slug>
git branch -d feature/<slug>
```

要求：

- 每个问题/需求一个分支，不把无关改动塞进同一批。
- 合并前至少运行受影响测试；UI/设置/拖拽类改动还必须跑对应 A+ 回归。
- **提交标题必须带当前批次版本号**，例如：
  ```text
  feat(settings): [0.3.0-beta.69] nest dependent switches
  fix(host): [0.3.0-beta.70] classify a corrupt backup
  ```
  版本 bump 之后，后续提交统一使用新的 beta 号，直到下一次 bump。
- **合并后必须先打 `archive/feature/<slug>` 归档 tag，再删除本地 feature 分支**；归档 tag 用来替代已删除分支的历史入口。
- 归档 tag 默认只留本地，除非用户明确要求推送；它永远不触发 Release。
- 不为了“同步”把 main 合回 dev；只有在 main 产生热修复时，才按热修复流程回收。

## 2.1 当前节奏：小步快跑

- 每个改动批次始终从 `dev` 切一条 `feature/<slug>`；完成一个小目标就 `--no-ff` 合并、打 `archive/feature/<slug>`、删本地分支。
- 不把多个无关类型堆进同一批；一个批次内仍按“代码 / 测试 / 文档 / 版本”拆小提交。
- 每个批次消费下一个 beta 号；未发布号不回收、不复用。最终是否打版本 tag/Release 由用户明示。
- 当前文档真相源：
  - 测试矩阵/语言运行时状态/aliases：`docs/TEST-MATRIX.md`
  - 本地化资源、解析和限制：`docs/I18N.md`
  - 当前架构/兼容：`docs/ARCHITECTURE.md`、`docs/COMPATIBILITY.md`；`docs/CONTRACTS.md` 是 frozen 历史契约
  - 历史 V1/Gate0/Spike/superpowers 已移出 Git，保存在用户本地归档；不要在仓库里重新引入。
- i18n 分层规则：
  - UI 只调用 `t(key, params)`，不判断语言、不选 `one/few/many`、不拼句子；
  - 语言解析、字典选择、CLDR 复数、插值集中在 client i18n 层；
  - `src/core` 不引入 locale/Intl/字典，只接收注入的 translator；
  - 新增语言必须同时补资源、registry、manifest、aliases 测试，并在 TEST-MATRIX 标出真实运行时验证级别。
- 当前包身份是 `dsh-session-grove`；旧 `dsh-session-groups` 数据不做自动迁移，手动迁移见 `docs/MIGRATION-0.4.md`。

## 3. 发布：dev → main → tag

只有用户明确宣布“这一批可以发布”时才进入本流程。

### 3.1 在 dev 上准备

1. 更新版本号，五处保持一致：
   - `package.json`
   - `dsh.plugin.json`
   - `src/shared/constants.js`
   - `package-lock.json`（`npm install --package-lock-only`）
   - 当前文档中的版本引用
2. 更新 `CHANGELOG.md`。
3. 已发布版本必须有对应的 `docs/release-notes/v<version>.md`（`check:release` 强制当前版本 note 存在）；只有仅存在于 dev、尚未发布的批次才可以不建。
4. 运行：
   ```bash
   npm run check:style
   npm test
   npm run build
   npm run check:lib
   node --check lib/client.js
   npm run check:coverage
   npm run check:ui
   npm run check:release
   npm pack --dry-run
   npm run test:isolated
   # 隔离 web + -LocalePack 上运行：
   # npm run test:locale-pack
   # npm run test:all-locales
   ```
   全语言门禁结果必须记录在发布验证中；未跑或失败不得 release。`check:release` 是可自动执行的结构门禁；A+ / all-locales 属于手工本地证据，release workflow 不会代跑。
5. UI/行为改动必须有用户本地验收或对应 A+ 证据。

### 3.1.1 版本号消费策略

- **每个改动批次消费一个新的 beta 版本号**，即使这一批不打 tag、不触发 Release。
- 未发布的版本号不回收、不复用；后续批次继续顺延。
- 只有用户选定一个“认为稳定可推出”的 beta 时，才走 3.2 合并到 main 并打版本 tag。
- 中间跳过的版本号允许永久没有 tag/Release；它们代表真实的本地改动批次，不是空洞号。
- Release workflow 只接受 `v<major>.<minor>.<patch>[-prerelease]`；`archive/*` 永不触发。

### 3.2 环形合并到 main

```bash
git switch main
git merge --no-ff dev -m "release: v<version>"
git tag -a v<version> -m "dsh-session-grove <version>"
```

确认 `main` 上只有发布边界，随后按用户授权推送：

```bash
git push origin main
git push origin v<version>
```

tag 推送会触发 `.github/workflows/release.yml`，但 workflow 先校验：

- tag 必须是 `v<semver>`；
- tag 指向的提交必须可从 `origin/main` 到达。

因此 **在 dev 提交上打版本 tag 会直接失败**；Release 只能从 main 的发布边界产生。普通 `push` 不触发发版。

### 3.3 发布后

- main 停在发布点，不跟随 dev 前进。
- dev 从当前发布点继续接收下一个 feature；main 与 dev 暂时分叉是正常状态。
- 不在每次提交后把 dev 全量合回 main。

## 4. 热修复：main → hotfix → main → dev

```bash
git switch main
git switch -c hotfix/<slug>
# 修复 + 测试
git switch main
git merge --no-ff hotfix/<slug> -m "hotfix: <简述>"
git tag -a archive/hotfix/<slug> -m "archive hotfix/<slug>" hotfix/<slug>
git tag -a v<version> -m "dsh-session-grove <version>"
git push origin main v<version>
git branch -d hotfix/<slug>

# 把这次修复回收进 dev，避免下一次发布丢失
git switch dev
git merge --no-ff main -m "merge: hotfix v<version> back to dev"
```

热修复也必须有独立版本 tag 和 release；不能只改 main 不回收 dev。`archive/hotfix/<slug>` 与 `archive/feature/<slug>` 一样只是分支归档，不是版本 tag。

## 5. CI / Release 边界

- `.github/workflows/ci.yml`：只检查 dev push / PR，不发布、不 bump 版本。
- `.github/workflows/release.yml`：只监听 `v<semver>` 形态的版本 tag；`archive/*` 等分支归档 tag 永不触发发布。
- release workflow 在 tag push 时运行 `npm test`、`npm run build`、`npm run check:coverage`、`npm run check:ui`、`npm run check:release`，并保留 tag 可达 `main` 的检查。
- `npm run check:release` 校验：四处版本一致（`package.json` / `dsh.plugin.json` / `src/shared/constants.js` / `package-lock.json`）、tag 必须等于 `v<package.version>`、当前版本 release note 存在、`lib/client.js` 带版本戳、`package.json.files` 路径全部存在。
- 打包后生成 `SHA256SUMS` 并随 tgz 上传到 GitHub Release；仅 prerelease tag（含 `-` 后缀，如 `-beta`）加 `--prerelease`，稳定版不加。
- **A+ / all-locales 是手工本地证据，不是 CI 自动 gate**：release workflow 不运行 Playwright、不启动隔离 DSH 实例；未跑或失败不得 release，结果必须人工记录在发布说明。
- CI 不自动决定版本号；版本号由发布准备阶段人工写入并验证。
- release notes 文件名必须与版本 tag 对应；发布前检查 workflow 引用的 notes 路径。
- 当前 repo 若仍是 `main` 为 GitHub 默认分支，建议在仓库设置中把默认分支改为 `dev`；main 保持发布视图。

## 6. 当前基线

- 最新已发布版本：`0.4.0-beta.64`（GitHub Release `v0.4.0-beta.64`，2026-11-12，assets `.tgz` + `SHA256SUMS`；dshmarket 条目以市场同步为准）
- 当前 dev：`0.4.0-beta.65`（dev 批次，未 tag/未发布；真实宿主 **PASS**：agent debug run at the user's explicit request，2026-11-13 —— S1–S6 lane 用 `.65` 证据包 **835,756 bytes** / sha256 `AE0DE4AC…`（在 `a60f616` 打包，包内 `lib/client.js` 与当时 HEAD 逐字节一致、版本戳 `.65`；包内 docs 早于证据段、release note 仍写 pending，不得当作 HEAD；两个 fresh home：isolated `024652`；ui-browser `025209`，首跑与 02:57 重试同 home）；S7 lane 用 code-evidence 包 **842,325 bytes** / sha256 `F868…`（`a24a414` 树，`lib/client.js` 662,743 B；fresh home `160323`，port 4493，全量 `test:isolated` PASS，narrow matrix 30/0/0、71 截图、新菜单用例通过）；S7 菜单 5 条手工验收仍 **pending**（真实右侧会话容器未在 e2e 直接验证）；**不是**用户桌面验收）
- `.65` 包记录：S1–S6 历史证据包 **835,756 B** / sha256 `AE0DE4AC115B0E39FD9ADBFDDA89A0BFCB211DAF9D5E116972226331F190B766`（`a60f616` 代码树，`%TEMP%\dsh-grove-pack\`，不含 S7 代码，包内 `lib/client.js` 662,098 B）；S7 code-evidence 包 **842,325 B** / sha256 `F8680868A88B119DBC0158C81CD2D818AE9AF8DABDEFD06972CEFA548001D2F7`（`a24a414` 树，`%TEMP%\dsh-grove-pack-s7\`；`lib/client.js` 662,743 B / sha256 `01F2B5B62FAF3AE9B649607B5698F5ADF7C1846C55AEEE8676B2E9A54D0A7E8B`；e2e 证据来自该包）；S7 菜单 5 条手工验收仍 pending。旧 docs-current 包 **840,566 B** / sha256 `C0CE85DB…`（`%TEMP%\dsh-grove-pack-final\`）与 **841,069 B** / sha256 `D373C7D4…`（`%TEMP%\dsh-grove-pack-final2\`）均早于 S7、保留为历史。`AGENTS.md` 不参与打包。
- `.65` docs-current 历史包（S7 之前，均保留）：**840,566 B** / sha256 `C0CE85DB831B67FC61A1076D725E00DD45C7BA64BC1758660B5F7DD28259C988`（`%TEMP%\dsh-grove-pack-final\`）与 **841,069 B** / sha256 `D373C7D497B6106F9B348443F2B488401D55A4A5870CDE994B8DF398EA417DE9`（`%TEMP%\dsh-grove-pack-final2\`，于 `db76885` 重打包）；均为 246 files、仅 docs 不同，不含 S7 文档/代码。提交 B 的 S7 docs-current 包另起一行记录。
- `.65` docs-current 包（提交 A 后从 HEAD `0d06f2b` 重打包，S7 文档定稿；与旧 `-final` / `-final2` 包并存）：**848,301 B** / sha256 `4A6A6672EDCCAAB4DBF5E497FB3A0DF2B28F5F610A5863C1BD549BD104FE01C1`（`%TEMP%\dsh-grove-pack-s7-final\`；246 files；代码/lib 与 code-evidence F868 逐字节一致（`lib/client.js` sha256 `01F2B5B62FAF3AE9B649607B5698F5ADF7C1846C55AEEE8676B2E9A54D0A7E8B`、`src/**` 0 差异），仅 docs 不同（`docs/**` 6 个 + 根 `CHANGELOG.md`，共 7 个文件）；e2e 证据来自 F868）。提交 B 只改本文件、不参与打包，故包内容与提交 B 后的 HEAD 树一致。
- 当前测试：1031/1031 unit/contract + 45 UI runtime cases（1 module-load + 44 component tests，19 components / 28 client modules）+ 1 browser runtime spec，397 locale keys，coverage 94.84/86.92/91.46（阈值 92/80/85；同批运行在 94.68–94.85 / 86.79–86.94 / 91.44–91.55 波动，最终门禁轮为 94.84/86.92/91.46）；真实运行时证据以 `docs/TEST-MATRIX.md` 为准（`.65` S1–S6：`test:isolated` **PASS**（**narrow matrix** 30 pass / 0 skip / 0 failure（不是整个 suite 的计数）、71 截图、preview geometry dialog 560×560 / narrow sidebar 252 / body scroll 3659>466 / row gaps [0,0,0]）+ `test:ui-browser` **PASS**（第 2 次；同 home 复跑，1 次干净失败 + 1 次同 home 重试；首跑 log 只有 12s 可见性超时、无失败截图，“Get started” 遮挡为 timeout + `e2e/ui-runtime.spec.mjs:74-82` 推断；PASS 依据 exit 0 + `UI_RUNTIME` 行 + 无 FAIL + coverage JSON `pageErrors []`；非插件问题），包 sha `AE0DE4AC…`；`.65` S7：code-evidence 包 `F868…`（842,325 B，`a24a414` 树）在 fresh home `160323`（port 4493）全量 `test:isolated` **PASS**（narrow matrix 30/0/0、71 截图、新菜单用例通过，宿主仍 community 2.0.18 / DSH 0.2.1-rc.2），真实右侧会话容器未在 e2e 直接验证、5 条菜单手工验收 pending；均为 agent debug run at the user's explicit request、非用户桌面验收（S1–S6 包 sha `AE0DE4AC…`，S7 包 sha `F868…`）；**用户桌面验收无 `.65` 记录，不得写成有**；community `.64`：`test:isolated` PASS（30 格矩阵、69 截图）+ `test:ui-browser` PASS + `test:locale-pack` PASS + `test:all-locales` 23/23 PASS，均用 `.64` 包与 fresh home，其中 locale 两项在带 `e2e/fixtures/ja-locale-pack` 的隔离实例（`<temp>\<isolated-home>`，port <ephemeral>）；community `.63`：test:isolated + test:locale-pack + test:all-locales 23/23 PASS，test:ui-browser 未跑；official A+ O 最新为 `.61`；user desktop acceptance 2026-11-12 `.63` PASS）
- main / dev：以 `git log --oneline -1` 为准，允许分叉
- 下一次开发从 `dev` 开新 feature 分支，不从 main 拉功能分支
