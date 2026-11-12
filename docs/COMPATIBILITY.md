# DSH 版本兼容策略

## 结论

这个插件**没有按 DSH 版本编译多套代码，也没有启动时 `switch (version)`**。

当前策略是三层：

```text
1. package.json engines.dsh / peerDependencies
   → 插件管理器在安装/加载阶段拒绝明显不兼容的 DSH

2. src/adapters/dsh-capabilities.js
   → 启动时检测本轮真正依赖的 service/slot 签名

3. 业务代码的 feature detection / fail-soft
   → 可选服务缺失时降级，不把整个分组数据拖垮
```

DSH 的 plugin client 是 **单个客户端 bundle**，没有为插件准备 `#if DSH_VERSION` 之类的预编译指令。`esbuild` 的 define 是构建期常量，不会随宿主版本自动切换；用版本号写死分支反而容易把未测试路径带进发布包。

## 当前支持线

```text
主支持：@deepseek-ai/dsh 0.2.1-rc.2 / 0.2.1-rc.5
插件 engines.dsh: >=0.2.0-rc.2 <0.3.0
当前 dev 树：0.4.0-beta.65（dev 批次，**未发布**；最新已发布仍为 v0.4.0-beta.64，2026-11-12）

已验证（最新一轮 community 证据是 0.4.0-beta.65（2026-11-13，`.65` 证据包
**835,756 bytes** / sha256 `AE0DE4AC…`，在 `a60f616` 代码树打包、包内 docs 早于
证据段；HEAD 的 docs-current 重打包记录在 `AGENTS.md`；agent debug run at the
user's explicit request：用户明确要求“这次你先跑”，因此两项 fresh-host e2e 由
agent 执行、**不是**用户桌面验收；fresh home 共两个（isolated `024652` +
ui-browser `025209`，ui-browser 首跑与 02:57 重试复用 `025209`）：`test:isolated`
PASS，**narrow matrix** 30 pass / 0 skip / 0 failure、71 截图；`test:ui-browser`
第 2 次 PASS（1 次干净失败 + 1 次同 home 复跑；首跑 log 只有 12s 可见性超时、
未保留失败截图，“Get started” 对话框在 3.5s 探测后挂载遮挡是从 timeout 与
`e2e/ui-runtime.spec.mjs:74-82` 的推断，非直接观察；重试 PASS 依据 = exit 0 +
`UI_RUNTIME` 行 + 无 FAIL + coverage JSON `pageErrors: []`；非插件问题）；
`.65` 无 locale 改动，不需要 `test:locale-pack` / `test:all-locales`）。
上一轮 community `.64`
（2026-11-12，插件 `.64` 包 + fresh home：`test:isolated` PASS，30 格窄视口矩阵、
0 skip、69 截图；`test:ui-browser` PASS，另一 fresh home；`test:locale-pack`
PASS 与 `test:all-locales` 23/23 PASS，均在带 `e2e/fixtures/ja-locale-pack` 的
隔离实例（fresh home `<temp>\<isolated-home>`，port <ephemeral>））；历史序列：
0.4.0-beta.63（2026-11-12，`test:isolated` + `test:locale-pack` +
`test:all-locales` PASS，`test:ui-browser` 未跑）；official A+ O：
0.4.0-beta.61；0.4.0-beta.62 / .63 / .64 / .65 的 official A+ O 未重跑）：
  community DSH Desktop Stable 2.0.18 (anywhere-labs) / DSH 0.2.1-rc.2
  official DeepSeek Harness desktop 0.2.2.0 / DSH 0.2.2-rc.1
    （官方 bundle DSH host/core 隔离 A+；0.4.0-beta.60 在 0.2.1.0 / rc.5 上另含维护者桌面窗口验收）

明确不官方支持、不承诺兼容：
  community DSH Desktop Beta
  community DSH NEXT (-next channel)
```

包级声明是 `package.json` 的 `engines.dsh`；插件管理器使用同一 DSH 兼容性检查。官方 `@deepseek-ai/*` 运行时包（包括 `@deepseek-ai/schemastery`）使用 `peerDependencies`，由 DSH 宿主提供；插件安装时不再携带重复副本。

**兼容目标不是桌面壳名字。** 壳提供窗口和安装容器，插件实际依赖的是壳内置的 DSH core、Host service 和 client slot。官方版和社区 Stable 可能内置不同 DSH 版本或不同插件组合，因此必须分别实测。

## 桌面壳验证矩阵

| 桌面端/通道 | 支持状态 | 内置 DSH | 是否发布门禁 |
|---|---|---|---|
| community DSH Desktop Stable 2.0.18（anywhere-labs） | 支持；已验证 | `@deepseek-ai/dsh` 0.2.1-rc.2 | 是 |
| official DeepSeek Harness desktop 0.2.2.0 | 支持；已验证（隔离 A+；`.60` 的 0.2.1.0 另含桌面窗口验收） | `@deepseek-ai/dsh` 0.2.2-rc.1 | 是 |
| community DSH Desktop Beta (`DSH Desktop Beta`, `.dsh-beta`) | **不支持；不承诺兼容** | 可能不同 | 否 |
| community DSH NEXT (`DSH NEXT`, `-next`) | **不支持；不承诺兼容** | 可能不同 | 否 |

官方 A+ O 验证覆盖官方 bundle 的 DSH host/core 隔离 A+（`0.4.0-beta.60` 在 official 0.2.1.0 / DSH `0.2.1-rc.5` 上完成 `test:isolated` + `test:ui-browser` 的 profile 全量路径 PASS，2026-11-10；`0.4.0-beta.61` 又在 official 0.2.2.0 / DSH `0.2.2-rc.1` 隔离宿主复跑 `test:isolated` + `test:ui-browser` PASS）；`.60` 另在已安装桌面 profile 完成维护者验收；不代表官方桌面 profile 内所有第三方插件组合都已认证。`.60` 的 rc.5 宿主启动时可能记录一次 client `sessions service` 能力警告，但会话创建、分组与 A+ 全量路径均已通过；插件优先使用 `sessions.create`，并保留 rc.2 的 `startSession`/快照差分/`connectWorkspace` fallback。A+ 与 all-locales 都是手工本地证据：`.62` 的 community A+ C 四项（`test:isolated`、`test:ui-browser`、`test:locale-pack`、`test:all-locales` 23/23，385 locale keys）已于 2026-11-11 在 community 隔离宿主 PASS，与 official A+ O 的 `.61` 隔离运行相互独立；`.62` 的 official A+ O **未重跑**，不得写成 official `.62` 已通过。

## 分组归档字段兼容（0.4.0-beta.62）

分组级 `archived` 是 `DOC_VERSION` 1 的 additive 字段，不做版本升级、不迁移：

- **旧文档**：缺少 `archived` 读取为 `false`，不报错、不拒绝、不触发 quarantine。
- **旧客户端 + 新 host**：旧客户端序列化整份 doc 时不带 `archived`；`store.commit` 在锁内按 group id 从 current doc 继承该 flag（显式 `true/false` 优先，新组按 `false`），所以旧客户端不会意外把归档组变回未归档。若旧客户端尝试改归档子树的结构，host 的 before-state 不变量会返回 409 `archive-frozen`（`reason` 为 `group-archived` 等），不写入、不 bump revision；旧客户端可能只显示泛化错误，这是可接受降级。
- **新客户端 + 旧 host**：旧 host 忽略 `archived` 且没有结构守卫；该字段通常随整份 doc 保留。客户端的 mutator 守卫仍在，但跨窗口/裸 HTTP 的权威兜底不存在——升级 host 后恢复。
- **备份 / save**：`save()` 新建 profile 没有 current doc，缺失按 `false`；备份恢复路径按备份内容原样写回，可能回到归档前状态，这是恢复语义例外。
- **降级 caveat**：从 `.62` 回退到旧版本时，`archived` 字段留在 JSON 中但旧版本不展示归档态、也不执行结构锁；重新升级后自动恢复，无需迁移。`DOC_VERSION` 始终为 1，旧版本不会因新字段拒绝文档。
- **控制协议**：`group.archive` 是独立操作；归档状态冲突返回 409，schema/类型错误仍是 422；批量操作顺序执行后以原始 doc 做整批终校验。

`docs/CONTRACTS.md` 是 frozen 历史契约，其中“Doc stores no … archive flags”指的是会话归档 flag 由 host 持有；分组级 `archived` 由 [ADR-004](adr/0004-group-archive-freeze.md) 记录为 additive extension，不改该文件。

Beta 和 NEXT 是社区自己的实验通道。即使插件在某个 Beta/NEXT 构建里能加载，也不构成兼容承诺，不能替代 Stable 或官方桌面版的回归。

## 运行时检测

`src/adapters/dsh-capabilities.js` 只报告能力，不猜版本：

```text
host required:
  webServer.register

host optional:
  tools.register
  ctx.inject
  sessions / workspaces / workspaceRegistry / sessionTitle

client required:
  slots.register
  sessions service

client optional:
  slots.inject
  workspaces / uiWorkspace
  locale service
  configForms
```

- 缺少 **required**：插件记录 `missing ... capabilities`，不会假装正常。
- 缺少 **optional**：相应功能隐藏或返回明确失败，分组文件仍保留。
- 不把“版本号相同”误当成“API 相同”。

## 破坏性升级会发生什么

不会保证“零修改继续运行”。如果未来 DSH 改动：

- `webServer.register` 签名；
- slot 名称或注册方式；
- `sessions` / `uiWorkspace` 的公开方法；
- 原生工具 service 形状；
- 宿主客户端 bundle 加载协议；

则可能出现：

```text
侧栏不注册 / 设置卡不出现 / 原生工具不可用
```

但不会主动删除 `dsh-session-grove.json`；分组数据文件仍可作为恢复源。最坏情况下需要安装更新版本的插件或回滚 DSH。

## 版本适配器选择器

已把多 release line 的扩展点独立出来：

```text
src/adapters/dsh-0.2.js      当前 release line 的适配器
src/adapters/dsh-selector.js 显式注册表 + 精确版本选择
tests/client/dsh-selector.test.js 版本矩阵
```

当前矩阵：

```text
dsh-0.2  >=0.2.0-rc.2 <0.3.0
```

选择规则：

- 宿主暴露 `dshVersion` / `runtimeVersion` 时，按精确版本选择；
- 版本存在但不在矩阵内：host 拒绝挂载，不猜测;
- 当前 DSH 未暴露稳定版本 service，因此正常路径回退到 capability detection；
- 未来新增 0.3 支持时，新增 `dsh-0.3.js` 并注册，不在主流程写 `if (version >= ...)`。

这不是假装已经支持 0.3：0.3 适配器和真实矩阵尚未存在，选择器会对它返回 unsupported。

## 为什么优先能力检测

- 目前 community Stable 与 official 两个桌面族都已有隔离实例证据（最新一轮 community A+ C 为 `0.4.0-beta.65`，2026-11-13：agent debug run at the user's explicit request，两个 fresh home（ui-browser 重试复用同一 home）`test:isolated`（narrow matrix 30 pass）+ `test:ui-browser` PASS，不是用户桌面验收；official A+ O 为 `0.4.0-beta.61`；`.64` / `.65` 的 official A+ O 均未重跑）；仍不为“壳名”写死版本分支，写死分支等于发布未测试代码。
- DSH 的扩展点本身是 service/slot 组合，能力检测比版本判断更精确。
- 插件管理器已经承担版本范围拒绝；插件内部重复版本判断会制造双重真相源。

真正需要平行支持时，才补对应版本的独立适配器实现和测试矩阵。

## 升级检查清单

1. 用目标 DSH 安装新包。
2. 打开 Plugins 详情，确认第一层设置卡出现。
3. 做一次分组拖动/commit。
4. 检查 `/load` 和 `/dsh-session-grove/events`。
5. 调用 `session_grove_control` action `doctor`，或运行 `node scripts/session-grove-control.mjs doctor`，核对 host capabilities、storage、gates 和 routes。
6. 开启 `controlApi` 后调用一次 `session_grove_control` state。
7. 运行 `npm test` 和 `npm run test:isolated`。

## 平台支持矩阵

插件 runtime 是纯 JS/Node + DSH，没有 PowerShell 运行时依赖；`scripts/qa/*.ps1` 只是维护者测试工具，不随 npm 包发布。

| 平台 | Node/单测 | 构建/打包 | 真实 DSH UI |
|---|---|---|---|
| Windows | 本地已验证 | 本地已验证 | 本地已验证 |
| Linux | CI 已验证 | CI 已验证 | 未验证 |
| macOS | CI 已验证 | CI 已验证 | 未验证 |

当前 CI 在 Ubuntu、Windows、macOS 上运行 Node 层检查（coverage gate 仅 Ubuntu）：

```text
npm ci
语法检查
907 项单元/契约测试（0.4.0-beta.62 dev 树；0.4.0-beta.61 dev 树为 726；v0.4.0-beta.60 发布基线为 699；v0.4.0-beta.59 发布时为 529）；0.4.0-beta.63 dev 树为 914
客户端构建
coverage gate
UI runtime smoke（41 cases）
npm pack --dry-run
```

它**不能**证明真实 DSH UI、真实 fence、sidebar slot、dshmarket 安装/更新在三个平台都可用。Linux/macOS 的真实 UI 在完成真实宿主回归前属于 experimental。

发布侧另有 `.github/workflows/release.yml`，只在版本 tag push 时运行 `npm run check:style`、`npm run check:lib`、`npm run check:coverage`、`npm run check:ui` 与 `npm run check:release`（版本一致 / tag 匹配 / release note / 客户端版本戳 / 打包路径），并生成 `SHA256SUMS` 随 tgz 上传。A+（`npm run test:isolated`）与 all-locales 是维护者本地手工证据，不在 CI / release workflow 中自动执行。

## 分发与更新

`dsh-session-grove` 已上架 **dshmarket**（`awesome-dsh-plugin` 目录）；GitHub Release 附件与本地 tarball 仅维护者/调试路径。

更新责任属于 **dshmarket / 插件管理器**，不属于插件设置页：

- 插件不实现自更新，也不内置下一版本下载地址；
- dshmarket 从 `awesome-dsh-plugin` 精选目录获取条目；
- 用户通过 dshmarket 安装和更新（目录条目已上架）；
- 不要混用本地 tarball 安装与市场更新：先通过市场重装一次，让安装来源绑定到市场。

提交目录条目的位置是 `awesome-dsh-plugin/awesome-dsh-plugin`，不是 `dshmarket` 应用仓库。
