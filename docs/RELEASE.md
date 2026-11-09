# 0.4.0-beta.59 发布与安装说明

- 版本：`0.4.0-beta.59`
- 状态：**已发布**（2026-11-09）
- GitHub Release：`v0.4.0-beta.59`，assets **2 个**：`dsh-session-grove-0.4.0-beta.59.tgz`、`SHA256SUMS`
- 分发：已上架 **dshmarket**（`awesome-dsh-plugin` 目录）；普通用户从市场安装/更新，GitHub Release 附件与本地 tarball 仅维护者/调试路径
- 包名：`dsh-session-grove`
- 插件显示名：Free Groups / 自由分组
- DSH core：`@deepseek-ai/dsh` 0.2.1-rc.2（community）/ 0.2.1-rc.5（official）
- 已验证桌面壳：社区版 DSH Desktop **Stable** 2.0.18；官方 DeepSeek Harness 桌面版 0.2.1.0
- 发布证据：529/529 单元/契约测试 + 15/15 UI runtime cases；community A+ `.59`、official A+ `.59`、official ja 语言包 A+、all-locales 23/23（2026-11-09，隔离宿主；手工本地证据，非 CI 自动门禁）；完整语言/运行时矩阵见 [TEST-MATRIX.md](TEST-MATRIX.md)
- 发布包：`dsh-session-grove-0.4.0-beta.59.tgz`
- 发布说明：[release-notes/v0.4.0-beta.59.md](release-notes/v0.4.0-beta.59.md)

## 本版重点（`.59`）

- **New-session follow**：组加号新建的 blank 在首次发消息前，连续切换工作区仍保持在触发新建的分组；宿主复用其他 blank 时，旧占位被移除。
- **No timer**：跟随由 sessions active 变化驱动；非 blank / 手动移组 / 删除目标组即终止。
- **WYSIWYG**：layout effect + optimistic dispatch，避免第一次切换时旧组闪烁。
- **证据**：529 unit/contract + 15 UI runtime cases；community A+ `.59`、official A+ `.59`、official ja locale-pack、all-locales 23/23 PASS（2026-11-09，隔离宿主）。这些数字属于 `.59` Release，不能与下面 dev 的数字混用。

## Unreleased (dev)

`dev` 在 `v0.4.0-beta.59` 之后包含**尚未发布**的改动；它们不属于 `.59` Release，也没有版本 tag、GitHub Release 或市场更新：

- 多配置（profiles）：header chevron、切换差异预览、另存为/重命名/归档/管理、20 个未归档上限、5 秒撤销、全局 active + SSE、按配置隔离的折叠状态。
- 切换预览布局修复：差异改为两级层次（分组标题 + 缩进的 `from → to` 行）、分组标记 `+`/`−`/`~`、section/block/list 分隔线；预览区内部滚动（min 320 / max 560，宽度 560），长列表不再撑破弹窗。
- 测试：699/699 单元/契约测试；39/39 UI runtime cases（1 个模块加载 + 38 个组件测试，覆盖 17 个组件、21 个客户端模块）；331 个 locale keys；coverage 约 93.09% lines / 83.86% branches / 90.46% functions。
- 证据：community A+ profile 流程 2026-11-09 PASS（社区版隔离宿主，profile 分支 bundle：`test:isolated`、`test:ui-browser`、`test:locale-pack`、`test:all-locales` 23/23）；official A+ O（profile）仍 pending。
- 下一个 beta 版本号与发布日期由用户发布阶段决定；发布前需要 bump 五处版本、更新 CHANGELOG / release note / `TEST-MATRIX` 并重跑全部门禁。

### 多配置（profiles）数据与兼容

配置（profile）数据与现有单记录安装兼容：

- default 配置继续使用 `<dshHome>/storages/dsh-session-grove.json`；升级不迁移、不改名、不复制该文件；
- registry 为 `<dshHome>/storages/dsh-session-grove.profiles.json`（含 `.bak` / `.lock`），命名配置文档在 `<dshHome>/storages/profiles/<id>/dsh-session-grove.json`；
- 每个配置有独立的 `.bak`、`.lock` 与 quarantine 文件族，一个配置损坏不会覆盖另一个；
- 归档只写 `archivedAt`，不删除文档、备份或会话；
- 降级到不支持配置的旧版：旧版只读 default 文档并忽略 registry；配置仍保留在磁盘上，重新升级后可见；
- `DOC_VERSION` 保持 1，profile 元数据不进 GroupDoc，无 v1→v2 迁移。

## 安装方式

普通用户通过 **dshmarket** 安装和更新：在市场中搜索 `dsh-session-grove`（目录条目来自 `awesome-dsh-plugin`）。市场负责更新，插件不自更新，也不内置下一版本下载地址。

维护者/开发调试可使用本地 tarball：

```powershell
# 以本地 desktop profile 为例
DeepSeek Harness.exe --expose-internals `
  "C:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" `
  plugin --profile desktop add --force "file:<path>\dsh-session-grove-0.4.0-beta.59.tgz"
```

安装后必须重启对应桌面客户端。先卸载旧的 `dsh-session-groups`；不要在同一 profile 中并存两个身份。

## 发布流程

- release tag 只从 `main` 的版本边界创建。
- `.github/workflows/release.yml` 只在 tag push 时运行：校验 tag 可达 `main`，执行 `npm test` / `npm run build` / `npm run check:coverage` / `npm run check:ui` / `npm run check:release`，打包后生成 `SHA256SUMS`，把 tgz 与 `SHA256SUMS` 一起上传到 GitHub Release；只有 prerelease tag（如 `-beta`）才标记 prerelease，稳定版不标记。
- `npm run check:release` 断言 `GITHUB_REF_NAME` 恰好等于 `v<package.version>`（本地无该变量时只做结构校验）。
- 本次发布已完成：tag `v0.4.0-beta.59`、GitHub Release `v0.4.0-beta.59`（2 assets）、市场条目 `dsh-session-grove` 已上架。
- 市场条目对应仓库 `momijijin/dsh-session-grove`；旧的 `momijijin/dsh-session-groups` 身份不再使用。
- 下一个版本的 tag/Release 仍按同样流程创建，并由用户明确决定发布时间。

## 发布前本地门禁（必须）

除单元测试外，发布候选必须运行以下门禁并记录结果；任一失败不得进入 release：

```bash
npm run check:style
npm test
npm run build
npm run check:lib
node --check lib/client.js
npm run check:coverage
npm run check:ui
npm run check:release
npm run test:isolated
```

全语言和第三方语言包需要隔离实例：

```powershell
pwsh -File .\scripts\qa\start-isolated-web.ps1 `
  -Tarball .\dsh-session-grove-<version>.tgz `
  -LocalePack .\e2e\fixtures\ja-locale-pack
```

在该实例的 `web.json` 上设置 `DSH_TEST_URL` / `DSH_TEST_HOME`，然后运行：

```bash
npm run test:locale-pack
npm run test:all-locales
```

`test:all-locales` 覆盖 19 种语言 + 别名（23 例），并断言 header、新建分组弹窗、组菜单、配置弹窗/切换预览和阿拉伯语 RTL 根方向/边界。发布说明必须附上这两条输出（日期、locale 数、PASS 数）。

## 自动化门禁与手工证据的边界

`.github/workflows/release.yml` 自动执行的结构门禁：

- `npm run check:style`、`npm test`、`npm run build`、`npm run check:lib`、`node --check lib/client.js`；
- `npm run check:coverage`；
- `npm run check:ui`（当前 dev 为 39 个 UI runtime case，`.59` 发布时为 15 个；不计入逻辑 coverage）；
- `npm run check:release`：`package.json` / `dsh.plugin.json` / `src/shared/constants.js` / `package-lock.json` 四处版本一致，tag 必须为 `v<package.version>`，当前版本的 release note 存在，`lib/client.js` 已打上当前版本戳，`package.json.files` 中的每个路径存在；
- 打包后生成 `SHA256SUMS`，并随 tgz 一起上传到 GitHub Release。

以下**不是** CI 自动门禁，必须由维护者在本地隔离实例手工执行，并把输出（日期、locale 数、PASS 数）写进发布说明：

- `npm run test:isolated`（A+ 隔离 Playwright）；
- `npm run test:ui-browser`（真实浏览器 UI runtime coverage；同一隔离宿主环境）；
- `npm run test:locale-pack` / `npm run test:all-locales`（第三方语言包与全语言切换）。

release workflow 不运行 Playwright、不启动隔离 DSH 实例，也不会自动生成 A+ / all-locales 证据；这两类结论只能来自人工执行与人工记录。

## 验证基线

完整覆盖矩阵见 [TEST-MATRIX.md](TEST-MATRIX.md)。

### `0.4.0-beta.59`（已发布）

- 529/529 单元/契约测试。
- UI runtime：15/15 cases（`npm run check:ui`）。
- coverage：release workflow 的 `check:coverage` 通过（阈值 92/80/85）。
- community A+ `.59` PASS、official A+ `.59` PASS、official ja locale-pack PASS、official all-locales 23/23 PASS（2026-11-09，隔离宿主，手工本地）。
- Arabic RTL 视觉验收：2026-11-05 PASS（独立 official isolated profile 注入 + 人工审阅截图）。
- `npm run check:release` PASS。
- 发布说明见 [release-notes/v0.4.0-beta.59.md](release-notes/v0.4.0-beta.59.md)。

### dev（未发布，仅描述当前工作区）

- 699/699 单元/契约测试。
- coverage：93.09% lines / 83.86% branches / 90.46% functions（Node coverage 合并存在 ±0.05 的重复运行抖动）。
- UI runtime：39/39 cases（`npm run check:ui`；1 个模块加载 + 38 个组件测试，覆盖 17 个组件、21 个客户端模块）。
- profile 相关手工证据（2026-11-09，社区版隔离宿主，profile 分支 bundle）：`test:isolated` PASS（save-as、预览、撤销、重命名/归档、双窗口 active/`profile-changed` 409、折叠隔离、上限 20）；`test:ui-browser` PASS（executed ratio 1）；`test:locale-pack` PASS；`test:all-locales` 23/23 PASS（含配置弹窗/预览与阿拉伯语 RTL bounds）。official A+ O 的 profile 流程未跑。
- 隔离宿主验证：`test:isolated` 在被测包安装后 2026-11-09 PASS；`test:locale-pack` 与 `test:all-locales` 在同一隔离实例（ja locale pack）上 PASS；四个 Playwright 脚本（`isolated`、`ui-runtime`、`all-locales`、`locale-pack`）均拒绝真实 43120 端口与真实 `~/.dsh`（`groups.spec.mjs` 是历史 CDP 手工脚本，不属于当前 Playwright 门禁），测试 home 位于 `<temp>` 且未清理（不删除文件）。
- 这些数字只描述当前 `dev`，不是 `v0.4.0-beta.59` Release 证据，也未进入任何 tag。

A+ / all-locales 结论均为手工本地证据（见上节），不是 CI 自动门禁的产物。
