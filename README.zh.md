# dsh-session-grove

[English](README.md) | [中文](README.zh.md)

DSH Desktop 侧栏上的自由分组层：把不同工作区的会话归入同一分组，**不改变**会话的官方工作区归属、日志或 `workspace.json`；插件单独存一份分组记录。

- 归组只改插件自己的记录和会话在自由分组视图里的位置；
- 官方工作区归属、工作区注册表和会话日志从不改写；
- 会话标题与归档状态只会因用户显式操作或 opt-in 的 `controlSessions` API 改变；
- 从不写 `workspace.json`。

## 文档

**图文使用文档：<https://momijijin.github.io/dsh-session-grove-docs-site/>**

覆盖安装与 60 秒上手、分组、会话归组、分组配置、搜索筛选、头部状态、设置与 AI 控制、数据与备份、常见问题，以及逐版本更新说明。首次启动的入口提示/说明卡与插件设置页都提供同一入口。

- 当前版本：**0.4.0-beta.63**（最近发布，2026-11-12）
- DSH 范围：`>=0.2.0-rc.2 <0.3.0`；已在社区版 DSH Desktop Stable 2.0.18（DSH 0.2.1-rc.2）与官方 DeepSeek Harness 桌面版 0.2.2.0（DSH 0.2.2-rc.1）验证
- 不支持：社区版 DSH Desktop Beta 与 NEXT
- CI 在 Ubuntu/Windows/macOS 跑 Node 层门禁；真实 DSH UI 只在 Windows 验证
- 19 套界面字典，跟随宿主语言；插件没有独立语言开关
- MIT

## 安装

1. 从 **dshmarket** 安装 `dsh-session-grove`，宿主提示时重启 DSH Desktop。
2. 安装与更新都交给 dshmarket / 插件管理器；插件不自更新。
3. 从旧 `dsh-session-groups` 身份升级不会自动迁移数据，见 [docs/MIGRATION-0.4.md](docs/MIGRATION-0.4.md)。

本地 tarball/CLI 安装仅维护者调试路径，见 [docs/RELEASE.md](docs/RELEASE.md)。

## 快速上手

1. 点工作区标题行的网格图标进入**自由分组**；首次启动会有一条一次性提示，里面带本文档入口。
2. 新建一个分组。
3. 把任意工作区的会话拖进去；拖拽组头可以排序或嵌套（最多 8 层）。
4. 把会话拖出分组，即回到未归组。

## 能做什么

- 官方工作区视图与自由分组视图切换；侧栏宽度可拖动并恢复默认；
- 分组：新建、重命名、图标、预设色/自定义色、拖拽排序改父级、折叠、带目的地选择的删除；
- 会话：跨工作区归组、组内新建、打开/重命名/归档、分叉、复制 Session ID；
- 分组配置：命名的分组方案，切换前看只读差异预览，可撤销、归档；
- 归档：会话与分组两套独立三态；归档分组的整棵子树变为结构只读，但会话仍可打开；
- 搜索标题/工作区/分组路径；头部执行中/待介入/未读统计；
- 可选的 AI 控制（宿主原生 `session_grove_control` 工具），所有门禁默认关闭。

## 配置

**Plugins → dsh-session-grove** 页面顶部是文档入口，下面五个默认关闭的开关：`diagnostics`、`debugProbe`、`controlApi`、`controlSessions`、`controlDestructive`。每个开关都有说明行为与安全影响的信息提示；破坏性控制需要显式确认。安全边界与 AI 控制用法见[设置与 AI 控制](https://momijijin.github.io/dsh-session-grove-docs-site/2026/11/12/设置与%20AI%20控制/)。

## 数据

分组记录位于 `<dshHome>/storages/`（`dsh-session-grove.json`、配置注册表、每个命名配置一个目录），带 `.bak` 备份与隔离文件。官方工作区/会话数据从不写入。卸载插件只恢复官方视图，分组数据保留，重装后可继续使用。完整说明见[数据、备份与恢复](https://momijijin.github.io/dsh-session-grove-docs-site/2026/11/12/数据、备份与恢复/)与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 已知限制

- 头部统计只计入显式归组或显式未归组的会话；
- 分组、折叠与弹窗状态按窗口维护；跨窗口冲突返回 409，不做实时合并；
- active 配置对 DSH 实例全局；
- AI 控制可读写选定配置，但不能切换 active；
- 搜索最多返回 20 条；
- 折叠子树仍由 `buildRenderTree` 构建，大列表懒渲染仍 deferred。

## 开发

```powershell
npm run check:style
npm test
npm run build
npm run check:lib
npm run check:ui
npm run check:coverage
npm run check:release
```

维护者文档：[docs/INDEX.md](docs/INDEX.md)——架构、兼容性、i18n、测试矩阵、发布流程与 ADR。发布说明：[docs/release-notes/](docs/release-notes/) 与 [GitHub Releases](https://github.com/momijijin/dsh-session-grove/releases)。当前测试状态：[docs/TEST-MATRIX.md](docs/TEST-MATRIX.md)。

## 许可

MIT，见 `LICENSE`。
