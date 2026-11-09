# 0.4.0-beta.59 发布与安装说明

- 版本：`0.4.0-beta.59`
- 包名：`dsh-session-grove`
- 插件显示名：Free Groups / 自由分组
- DSH core：`@deepseek-ai/dsh` 0.2.1-rc.2（community）/ 0.2.1-rc.5（official）
- 已验证桌面壳：社区版 DSH Desktop **Stable** 2.0.18；官方 DeepSeek Harness 桌面版 0.2.1.0
- 状态：698/698 测试；community A+ `0.4.0-beta.59` / official A+ `0.4.0-beta.59` 实测证据（手工本地，非 CI 自动门禁）；official ja 语言包 A+ PASS；all-locales 23/23 PASS（含阿拉伯语 RTL）；完整语言/运行时矩阵见 [TEST-MATRIX.md](TEST-MATRIX.md)
- 发布包：`dsh-session-grove-0.4.0-beta.59.tgz`

## 本版重点

- **New-session follow**：组加号新建的 blank 在首次发消息前，连续切换工作区仍保持在触发新建的分组；宿主复用其他 blank 时，旧占位被移除。
- **No timer**：跟随由 sessions active 变化驱动；非 blank / 手动移组 / 删除目标组即终止。
- **WYSIWYG**：layout effect + optimistic dispatch，避免第一次切换时旧组闪烁。
- **记录**：698 unit/contract + 38 UI runtime cases（profile 分支）；community A+ `.59`（2026-11-09 复跑，含 profile 流程）、official A+ `.59`（配置功能前证据）；locale-pack 与 all-locales 23/23 PASS（2026-11-09 复跑，含 profile 弹窗/预览）。
- 本批未发布；没有版本 tag 或 GitHub Release。

## 多配置（profiles）数据与兼容

配置（profile）数据与现有单记录安装兼容：

- default 配置继续使用 `<dshHome>/storages/dsh-session-grove.json`；升级不迁移、不改名、不复制该文件；
- registry 为 `<dshHome>/storages/dsh-session-grove.profiles.json`（含 `.bak` / `.lock`），命名配置文档在 `<dshHome>/storages/profiles/<id>/dsh-session-grove.json`；
- 每个配置有独立的 `.bak`、`.lock` 与 quarantine 文件族，一个配置损坏不会覆盖另一个；
- 归档只写 `archivedAt`，不删除文档、备份或会话；
- 降级到不支持配置的旧版：旧版只读 default 文档并忽略 registry；配置仍保留在磁盘上，重新升级后可见；
- `DOC_VERSION` 保持 1，profile 元数据不进 GroupDoc，无 v1→v2 迁移；
- **版本不 bump**：本 feature 分支仍为 `0.4.0-beta.59`；发布 PR 再统一 5 处版本、CHANGELOG、release note、TEST-MATRIX `Status:` 与 lib stamp。

## 安装方式

普通用户通过 **dshmarket** 安装；市场新条目发布后搜索 `dsh-session-grove`。

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
- 市场旧条目 `momijijin/dsh-session-groups` 需要替换为 `momijijin/dsh-session-grove`。
- 尚未创建 tag、GitHub Release 或市场 PR。

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
- `npm run check:ui`（38 个 UI runtime case，不计入逻辑 coverage）；
- `npm run check:release`：`package.json` / `dsh.plugin.json` / `src/shared/constants.js` / `package-lock.json` 四处版本一致，tag 必须为 `v<package.version>`，当前版本的 release note 存在，`lib/client.js` 已打上当前版本戳，`package.json.files` 中的每个路径存在；
- 打包后生成 `SHA256SUMS`，并随 tgz 一起上传到 GitHub Release。

以下**不是** CI 自动门禁，必须由维护者在本地隔离实例手工执行，并把输出（日期、locale 数、PASS 数）写进发布说明：

- `npm run test:isolated`（A+ 隔离 Playwright）；
- `npm run test:ui-browser`（真实浏览器 UI runtime coverage；同一隔离宿主环境）；
- `npm run test:locale-pack` / `npm run test:all-locales`（第三方语言包与全语言切换）。

release workflow 不运行 Playwright、不启动隔离 DSH 实例，也不会自动生成 A+ / all-locales 证据；这两类结论只能来自人工执行与人工记录。

## 验证基线

完整覆盖矩阵见 [TEST-MATRIX.md](TEST-MATRIX.md)；本候选版本的可重复门禁为：

- 698/698 单元/契约测试。
- coverage：93.1% lines / 83.9% branches / 90.5% functions（Node coverage 合并存在 ±0.05 的重复运行抖动）。
- UI runtime：38/38 cases（`npm run check:ui`；1 个模块加载 + 37 个组件测试，覆盖 17 个组件、21 个客户端模块）。
- community A+：`0.4.0-beta.59` PASS（2026-11-06，隔离 community host；2026-11-09 以 profile 分支复跑 PASS）；official A+：`0.4.0-beta.59` PASS（2026-11-06，隔离 official host，配置功能前证据）；official locale-pack PASS；official all-locales 23/23 PASS（2026-11-06）；community all-locales 23/23 PASS（2026-11-09，含 profile 弹窗/预览）；Arabic RTL 视觉验收：2026-11-05 PASS（独立 official isolated profile 注入 + 人工审阅截图）。
- profile 相关手工证据（2026-11-09，社区版隔离宿主，profile 分支 bundle）：`test:isolated` PASS（save-as、预览、撤销、重命名/归档、双窗口 active/`profile-changed` 409、折叠隔离、上限 20）；`test:ui-browser` PASS（executed ratio 1）；`test:locale-pack` PASS；`test:all-locales` 23/23 PASS（含配置弹窗/预览与阿拉伯语 RTL bounds）。官方 A+ O 的 profile 流程未跑；发布 PR 前补官方宿主证据。
- 隔离宿主验证：`test:isolated` 在被测包安装后 2026-11-09 PASS；`test:all-locales` 与 `test:locale-pack` 在同一隔离实例（ja locale pack）上 PASS；四个 Playwright 脚本（`isolated`、`ui-runtime`、`all-locales`、`locale-pack`）均拒绝真实 43120 端口与真实 `~/.dsh`（`groups.spec.mjs` 是历史 CDP 手工脚本，不属于当前 Playwright 门禁），测试 home 位于 `%TEMP%` 且未清理（不删除文件）。

A+ / all-locales 结论均为手工本地证据（见上节），不是 CI 自动门禁的产物。
