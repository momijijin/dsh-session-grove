# 架构：纯函数核心 + DSH 适配器

当前实现：**0.4.0-beta.63**  
支持宿主：`@deepseek-ai/dsh` 0.2.1-rc.2 / 0.2.1-rc.5  
已验证壳：社区版 DSH Desktop **Stable** 2.0.18（rc.2）；官方 DeepSeek Harness 桌面版 0.2.2.0（rc.1，隔离 A+）；0.2.1.0（rc.5）为 `.60` 历史验证（隔离 A+ + 桌面窗口验收）  
明确不支持：社区版 DSH Desktop Beta、社区版 DSH NEXT（`-next`）  
分发状态：`.60` 已上架 dshmarket；GitHub Release 附件与本地 beta tarball 仅维护者/调试路径。`.62` 是上一发布版本（分组归档 + 双三态 + 结构锁）；`.63` 已发布（2026-11-12，首次引导漏斗 + 就地提示 + 文档站点入口），README 已瘦身为入口页。  
测试基线（`.63` dev tree）：914/914 unit/contract、42/42 UI runtime（1 module-load + 41 component tests，19 components / 25 client modules）+ 1 browser spec；397 locale keys × 19 dictionaries。

插件按洋葱圈分层，宿主升级时只改外圈。

## 图层

```text
src/core/        纯函数核心：无 React、无 DSH、无 DOM、无存储
src/shared/      共享领域内核：GroupDoc 模型、常量（host/client 都可依赖）
src/adapters/    DSH 版本相关适配器：runtime 注入、locale、slot、storage
src/client/      DSH 客户端 UI 与交互编排
src/host/        DSH host 路由 / fence / store
src/index.js     Cordis host 入口
```

## 核心规则

- `src/core/**` 只能依赖自身、`src/shared/**` 中的纯常量/模型，以及标准 JavaScript。
- `src/shared/**` 是共享领域内核，必须保持纯函数、无 React/DSH/DOM/存储依赖；host 和 client 都允许依赖它。唯一平台能力是 `globalThis.crypto` 用于生成 UUID。
- 目前不把 `src/shared/model.js` 物理迁入 `src/core`：它是 host/client 共同消费的稳定领域层，迁移只会制造 22 处 import churn，不增加隔离价值。边界测试直接覆盖 `src/shared`。
- `src/core/**` 不允许 import：
  - `react` / `react-dom`
  - `@deepseek-ai/*`
  - `src/client/**`、`src/host/**`、`src/adapters/**`
  - `document`、`window`、`localStorage`、`globalThis` 等宿主全局
- 宿主 API 变化时优先改 `src/adapters/**` 或 `src/client/**`；只要插件功能不变，`src/core/**` 不改。
- 核心函数必须能直接用 Node 测试，不需要浏览器、DSH 窗口或真实 profile。
- 依赖方向由 `tests/core/dependency-direction.test.js` 强制：
  - `shared` 只能依赖自己
  - `core` 只能依赖 `core` / `shared`
  - `adapters` 只能依赖 `adapters` / `core` / `shared`
  - `client` 只能依赖 `client` / `core` / `shared` / `adapters`
  - `host` 只能依赖 `host` / `core` / `shared`
  - `src/index.js` 是 composition root，可依赖 `host` / `core` / `shared` / `adapters`；`adapters` 只承载 DSH 版本相关能力检测，不向上依赖 client/host。
- `npm run check:core` 独立加载全部核心模块，不启动 DSH。

## 分组归档与子树冻结（0.4.0-beta.62）

`src/shared/archive.js` 是分组归档的共享领域内核（只依赖 `constants.js`；`model.js` 从它导入，反向导入会成环）：

- `isOwnArchived` / `normalizeGroupArchived`：只有 `group.archived === true` 才算归档；缺失按 `false` 读取，写盘归一化为显式 boolean。
- `archivedInfo` / `effectiveArchived`：own 或任一祖先归档；`archivedBy` 是最近的归档祖先 id（自身归档时即自身），纯派生、不落盘、cycle-safe。
- `hasArchivedDescendant`：递归子树含 effective 归档分组。
- `computeGroupVisibility(doc, groupFilter)`：一次算出 `{ full, path, sessionGroups, ungroupedVisible }`。`full` 是 effective 归档集合；`path` 是 `only` 下通往 full 的组头祖先（`hidden`/`all` 为空）；`sessionGroups` 决定哪些组的自身会话可渲染；`only` 下 `ungroupedVisible=false`。渲染树、搜索、状态计数共用这一份结果，避免三套判定漂移。
- `findArchiveViolation` / `assertArchiveInvariant`：before-state 指纹 = 归一化 name/icon/color/colorHex + `parentId` + 同级 index + `sessionIds` 顺序 + 直接子组 id 顺序 + 每个祖先的 `parentId`/同级 index（祖先元数据不比较）。冻结组自身唯一允许的变化是 `archived` 开关；`unarchive + 编辑` 必须拆两笔，`archive + 编辑` 合法。
- `setGroupArchived`：只切 own flag，不级联；同值返回原 doc（控制层据此报 `no-change`，不 bump revision）。

`src/shared/model.js` 的 `Group.archived?: boolean` 是 `DOC_VERSION` 1 的 additive 字段；`validateDoc` 只拒绝非 boolean（`group-archived-type:<id>`），缺失合法；现有 mutator 在生成 next doc 后调用 `assertArchiveInvariant`，失败抛结构化错误。

拖拽/放置：

- `src/core/drag.js` 的 `checkSessionDrop`：会话落入 effective archived 容器返回 `archived-destination`；预览与提交共用。
- `src/core/archive-drop.js` 的 `checkGroupDrop` / `applyGroupDrop`：先复用 `src/core/group-drag.js` 的 `resolveGroupDrop` 按**完整 doc**解析坐标，再叠加 `archived-source`、`archived-source-subtree`、`archived-destination` 与 `archived-anchor`（插入会推动冻结锚点的同级 index）；预览与提交共用同一判定。部分剪枝的 `only` 视图里 slot 锚点仍用稳定 id + 完整 children，不用可见数组 index；归档组 body 保留拒绝 handler，不渲染 placeholder。

Host 权威守卫：

- `src/host/store.js` 的 `commit` 在锁内先按 group id 继承入站缺失的 `archived`（旧客户端整份提交不会隐式取消归档），再 `validateForWrite`，最后用 current doc 作 before 跑同一个不变量；违反返回 `kind:'archive-frozen'`，不写文件、不 bump revision。
- `src/host/http/respond.js` 把该结果映射为 409 `{ ok:false, code:'archive-frozen', reason:<op code>, groupId, field }`；`reason` 是结构化操作码（`group-archived` 等），`message` 不作为用户文案直接展示。
- `store.save()` 新建 profile 没有 current doc（缺失按 `false`），`writeDoc(backup)` 恢复路径按备份内容原样写回；两者是不变量的明确例外。

控制协议：

- 新增独立操作 `group.archive { groupId, archived }`；`group.update` 仍只改 icon/color/colorHex。
- `state.groups[]` 增加 `archived`（own）、`effectiveArchived`、`archivedBy`，不暴露视图态 `pathOnly`。
- `group.create/rename/update/move/delete/session.assign` 按归档状态守卫（源/目标/目的地/锚点）；`group.archive` 自身始终允许、不级联。
- 批量顺序执行，最后用**原始 doc**做整批终校验（失败 `operationIndex: -1`）；归档冲突走 409，schema/类型/未知字段仍是 422。

客户端：

- 视图选项 popover 拆成两段独立三态：会话沿用 `archiveFilter` 与 `dsh-session-grove.archive.v1`；分组新增 `groupArchiveFilter`（默认 `hidden`）与 `dsh-session-grove.archive.groups.v1`。选择后保持展开，Escape/外部点击关闭；header 按钮同时镜像 `data-filter` 与 `data-group-filter`。
- `src/client/groups-view-state.js` 把 `groupFilter` 同时接进 `buildVisibleTree` 与 `statusSectionsByGroup` 的 memo deps；树先按 `computeGroupVisibility` 剪枝，再在已渲染分组内套会话三态；搜索用同一 visibility 并在渲染前 split visible/hidden。
- `SessionRow` 用 `data-structural-locked` 表示“容器归档导致的会话结构锁”，`data-archived` 只表示会话自身归档；`GroupNode` 用 `data-archived`（effective）/`data-path-only`/`data-contains-archived`；归档组只对最外层应用一次变暗，内部嵌套组/会话行重置 `opacity:1`，`pathOnly` 不变暗。
- 归档/取消归档、不可见结果、`archive-frozen` 失败都有 toast/inline 本地化文案；`optimistic.js` 按 code 映射失败 key，409 后重新 load。

## 多配置（profiles）

配置（profile）是分组文档的命名作用域：官方工作区与会话数据不分叉，切换只决定当前显示哪份 GroupDoc。元数据在独立 registry 中，不塞进 GroupDoc，因此 `DOC_VERSION` 保持 1。

- `src/host/profile-registry.js`
  - registry schema（`version/revision/activeId/profiles[]`）与不变量校验；
  - 原子写（临时文件 → fsync → `.bak` → rename → 目录 fsync）、跨进程 `.lock`、同进程 promise tail；
  - 除 `activate` 外的写操作走 CAS（`baseRevision`）；损坏时优先 `.bak`，否则 quarantine 并进入 degraded；
  - 未归档上限 20、名字校验（trim 后 1–40、无控制字符、大小写不敏感唯一）、归档只写 `archivedAt`。
- `src/host/profile-manager.js`
  - 固定 `storageDir`，解析 default 与 `profiles/<id>/` 路径；拒绝逃出 `storages` 的 id；
  - 按绝对路径缓存 `createStore` 实例，保证同一 profile 的 store 身份稳定（客户端 store 订阅依赖身份）；
  - `activeId/activeStore/storeFor/peekFor/peekRegistry/newProfileId/entryFor/orphans`；registry degraded 时 active 回落 default；
  - 创建采用 doc-first：先写新文档，再 CAS registry 加条目并设 active；registry 失败保留孤儿目录，由 doctor 报告，不自动删除。
- `src/host/profile-routes.js`
  - 6 条精确 path 路由：list/preview/create/rename/archive/activate（预览用 `?id=`，不引入路径匹配器）；
  - preview 全程只读：`peekRegistry` + `peekFor`，不 quarantine、不写 registry、不改 active；
  - `previewToken = sha256({activeId, activeRevision, targetId, targetRevision, registryRevision})`，activate 时重算，防止 TOCTOU；
  - active 不健康时 `activeRevision=null`，仍允许预览健康目标并切到它（default 优先）。
- `src/host/store.js` 的 additive `peek()`
  - 读文件 → 解析 → 归一化颜色 → `validateDoc`，返回 `{kind, doc, revision, exists}` 或 `{kind:'missing'|'corrupt'|'invalid'|'unsupported-version', detail}`；
  - 不加锁、不写文件、不 quarantine；`load()` 语义不变（可隔离/恢复）。
- `src/index.js`
  - composition root 创建 manager 并传给 `registerRoutes`/`createControlTool`/storage-health；每个请求解析 active store，不在 apply 时快照单一 store；
  - diagnostics/debug/control-token/skill dshHome 固定到 `storageDir`，不从 per-profile `filePath` 回推。
- SSE（`src/host/change-hub.js`）
  - `revision` 事件带 `profileId`；新增 `active` 事件（`activeId, registryRevision`），在 create/activate 后广播；
  - 客户端只接受缺失 `profileId`（旧 host）或等于本地 active 的 revision；`active` 事件触发 epoch++、清队列、`/load` + `/profiles`。
- 客户端
  - `src/client/profile-switcher.js`：header chevron、popover、recovery strip；
  - `src/client/profile-preview.js`：切换差异预览 body 与预览 footer；
  - `src/client/profile-switch.js`：预览→激活→撤销/恢复编排与 GroupsView handler facade；
  - `src/client/profile-storage.js`：preview 偏好（localStorage 开关）读写；
  - `src/client/components-profile-dialogs.js`：save-as/rename/archive/manage 弹窗主体；
  - `src/client/dialog-profile.js`：DialogHost 的 profile 弹窗 body、名字校验与 footer 动作；group/session body 仍在壳内；
  - `src/client/state.js`：`profiles`/`profilePreview`/`profileEpoch`/`profileSwitching`；切换成功或收到 active 事件时递增 epoch、清零 `latestSeenRevision`、清空 optimistic/doc 状态（存储适配在 `state/persistence.js`，SSE 变更判定在 `state/external-change.js`，`state.js` 保留 `createStore` 与 re-export）；`.62` 新增 `groupArchiveFilter`（持久化键 `dsh-session-grove.archive.groups.v1`）；
  - 折叠状态键不变，值变为 `{[profileId]: {[groupId]: true}}`；旧扁平值按 default 读取，下一次写入升级；
  - 旧 host（`/profiles` 404）→ `profiles.available=false`，不渲染 chevron。
- `src/core/profile-diff.js`
  - 纯函数 `normalizeDocForCompare/sameDocs/diffDocs`；忽略 `version/revision`，按 id-first + 唯一 path-fallback 匹配分组；
  - 返回完整数组，`truncated` 恒为 false；100/300 行截断只在 UI 层（`profile-preview.js`）。

## 客户端 i18n 分层

`src/client/locale.js` 只是兼容 facade。运行时 i18n 拆为六个模块，另有 1 个 build-only chunk 加载器：

- `src/client/i18n/resources.js`：唯一 import `locale/*.json` 的模块，导出字典注册表与 `FALLBACK_LANGUAGE`
- `src/client/i18n/locale-id.js`：基础语言归一化、Host snapshot / `<html lang>` / navigator 解析
- `src/client/i18n/message-format.js`：CLDR 类别选择、`{placeholder}` 插值、英文兜底
- `src/client/i18n/translator.js`：字典选择与 `createTranslator`
- `src/client/i18n/direction.js`：RTL 检测（基础语言 + `Intl.Locale` textInfo）
- `src/client/i18n/date-format.js`：`Intl.DateTimeFormat` 绝对时间格式化（UI 通过 runtime bridge 调用）
- `src/client/i18n/resources-lazy.js`（build-only，不计入上述六个运行时模块）：构建期 en/zh 子集与 17 个字典 chunk 加载器

以下其余客户端模块不属于 i18n 分层：

- `src/client/groups-view-width.js`：`GroupsView` 的 sidebar width controller hook（持久化/视口 clamp/host DOM 生命周期）
- `src/client/groups-view-state.js`：framework session/workspace/status hooks 与可见树（纯数据适配）
- `src/client/groups-view-search.js`：搜索 reveal/highlight 的 DOM 控制器与 timer 生命周期
- `src/client/command-runtime.js`：非 React 命令/Toast bridge（dispatch 与 toast）
- `scripts/build-client.mjs`：主 bundle + `lib/client.locale-*.js` 懒加载 chunk 生成
- `src/client/groups-view-menu-handlers.js`：菜单锚点/上下文菜单/导航命令
- `src/client/groups-view-dialog-handlers.js`：新建/重命名/移动/删除/归档/fork 等 dialog 命令
- `src/client/profile-switcher.js`：配置 chevron/popover 与 recovery strip
- `src/client/profile-preview.js`：切换差异预览 body 与预览 footer
- `src/client/profile-switch.js`：预览/激活/撤销/恢复流程与 handler facade
- `src/client/profile-storage.js`：preview 偏好 storage 开关
- `src/client/components-profile-dialogs.js`：另存为、重命名、归档与管理列表弹窗
- `src/client/plugin-locale.js`：locale service 注册/订阅、translator/direction/time 运行时
- `src/client/plugin-settings.js`：`plugins.bundle.config` slot 注册与 config form
- `src/client/plugin-workspace-chrome.js`：workspace overlay toggle + width retry 生命周期

边界规则：

- UI 组件只调用 `t(key, params)`；不 import 语言 JSON，不判断语言，不直接调用 `Intl.PluralRules`
- `src/core` 不依赖 locale 字典或格式化；`statusLabel` 只接收注入的 translator
- 新语言只增加资源、registry、manifest 和测试，不把分支写进组件
- 架构测试 `tests/client/i18n-architecture.test.js` 校验以上边界

## 当前核心

- `src/core/session-row.js`
  - `sessionRowPropsEqual`：memo 行是否重绘
  - `statusLabel`：状态无障碍文案
- `src/core/layout.js`
  - `estimatedTreeHeight`：虚拟列表首帧估算
- `src/core/drag.js`
  - `hitTest` / `applyDrop` / sticky target / ungrouped target
  - `checkSessionDrop`：会话放置的完整 doc 合法性（含 `archived-destination`）
- `src/core/archive-drop.js`
  - `checkGroupDrop` / `applyGroupDrop`：分组拖拽的归档子树合法性（源、源子树、目的地、冻结锚点位移），预览与提交共用
- `src/core/tree.js`
  - 状态聚合、树扁平化、祖先展开、分组路径
  - `statusSectionsByGroup`：按 group visibility 过滤 running/blocked/unread 计数
- `src/core/filter.js`
  - 可见树、会话归档三态、分组归档三态（`buildVisibleTree` 的 `groupFilter`）、标题/子代理判定
- `src/core/search.js`
  - 搜索索引、匹配与 reveal 折叠补丁
  - 渲染前按 `computeGroupVisibility` 拆 visible/hidden 命中；`pathOnly` 祖先的自身会话不参与，`only` 下 ungrouped 不参与
- `src/core/virtual-list.js`
  - 虚拟列表窗口与 spacer 算术
- `src/core/group-drag.js`
  - 分组拖拽目标解析与稳定 anchor
- `src/core/dialog-selection.js`
  - 选择弹窗初始值、合法性与 Confirm payload
- `src/core/dialog-geometry.js`
  - 矩形 viewport clamp、居中、拖动、八方向缩放
  - `src/client/dialog-geometry.js` 保留 localStorage 持久化并 re-export 纯数学
- `src/core/group-drag.js` 补充
  - `isCurrentGroupPosition`：当前兄弟位置 no-op 判定
  - `groupHeaderZoneFromRect`：上/下 25% 边缘 zone
- `src/core/menu-position.js`
  - 菜单 anchor/clamp 纯数学；viewport 由调用方注入
- `src/core/control.js`
  - `resolveGroupPath`：完整根路径 → 唯一 ID；不存在/同名歧义/控制字符均结构化失败
  - AI 控制协议：catalog（共享图标/色板词表）、state、结构化 operation、plan/apply 候选 doc
  - `group.archive` 独立操作；其余分组/会话操作按归档状态做源/目标/目的地/锚点守卫；批量语义顺序执行 + 原始 doc 终校验
  - 无 HTTP、无设置、无 revision/CAS、无审计；这些在 `src/host/routes.js` 与 `src/index.js`
  - 删除操作必须显式 `allowDestructive`，无 raw-doc 写入
  - 严格 operation schema：未知字段、错误类型、负数/非整数 index、未知 icon/color、非法 colorHex、color+colorHex 并用一律结构化拒绝，不做静默降级
  - `group.create` 的 plan 不返回随机 ID；apply 后通过 state 读取
- `src/core/color.js`
  - `groupColorCss` 自定义 hex 优先、palette token 回退
- `src/core/profile-diff.js`
  - 配置切换的纯差异核心：`sameDocs` 判断结构相同（忽略 `version/revision`）、`diffDocs` 输出分组/会话变化与计数
  - 不依赖 locale/Intl/存储；不做展示截断，由 UI 按 100/300 行截断

## 当前适配器

- `src/adapters/client-runtime.js`
  - `installClientRuntime` / `clientRuntime`
  - 由 `plugin.js` 注入，React 组件只读取这个薄桥
- `src/client/dialog-geometry.js`
  - 只保留 geometry key、read/save/clear 与 localStorage 适配
- `src/host/routes.js` + `src/index.js`
  - 路由始终注册；`controlApi` / `debugProbe` / `diagnostics` 在请求时读取配置门禁，关闭时分别返回 404/403，而不是依赖 apply 时快照
  - 本地 bearer token（0600）+ host fence；token 目前会预生成，合法 token 在插件内部放行 control 路由，但不绕过 Host 外层浏览器 fence
  - revision CAS、planHash、idempotency、审计日志
  - `change-hub` 在每次 commit 后广播 revision；浏览器通过 `/events` SSE 重新 load
  - 0.3.0-beta.79 拆分：`routes.js` 只保留注册编排；控制路由在 `control-routes.js`
  - 0.4.0-beta.61 再拆分：HTTP 原语/请求体解析在 `host/http/wire.js`，冻结响应形状在 `host/http/respond.js`，profile 策略（planHash/目标解析/doctor 存储报告/名称策略）在 `profile-policy.js`，legacy 单 store 适配器在 `legacy-profile-manager.js`
  - 0.4.0-beta.62：`/commit` 的 `archive-frozen` 结果在 `respond.js` 固定为 409 `{ code, reason, groupId, field, message }`；`/control/apply` 的归档冲突由 `control-routes.js` 映射 409，schema/类型错误保持 422
- `src/client/components.js` + `components-*.js`
  - `components.js` 只保留 GroupsView 编排；primitives、rows、ungrouped、resize-handle、search-box、header 分模块
  - DOM、testid、CSS 类与 props 契约不变
- `src/host/storage-health.js`
  - doctor 的只读存储健康检查；不使用 store.load，不触发 quarantine 或写入
  - 多配置后同时检查 registry、每个 profile 文档、`.bak` 与 quarantine 家族，报告 `storage.registry` 与 `storage.profiles[]`
- `src/host/profile-registry.js` + `profile-manager.js` + `profile-routes.js`
  - registry 原子性/CAS/degraded 在 `profile-registry.js`；路径解析、per-profile store 缓存与只读 peek 在 `profile-manager.js`
  - `/profiles*` 六条路由与 previewToken 在 `profile-routes.js`；`/load`/`/commit` 只按 active 解析，不信任请求里的 profileId
- `src/host/tool.js`
  - 原生 `session_grove_control`；Host 进程内执行，不经过 HTTP fence
  - action 门禁：`controlApi` / `controlSessions` / `controlDestructive`；`doctor` 只读且不受 write gates 阻挡
  - 分组写走同一套 core control + CAS；session 动作走 Host registry
- `src/client/skill-repair.js`
  - `plugins.bundle.config` 第一层设置卡
  - 标准 `Switch` / `Button` / `Tooltip`；destructive 有二次确认
- `src/host/skill-install.js`
  - managed skill 安装/校验；用户自有同名文件不覆盖
- `scripts/session-grove-control.mjs`
  - 本地 CLI；只调用 state/plan/apply，不直接写 JSON
  - 读取 DSH_HOME 下的 control token；受 Host 浏览器 fence 限制
- `skills/session-grove-control/SKILL.md`
  - 模型侧操作流程与安全约束

## 已有纯模块

这些模块目前仍在原位置，但同样必须保持纯函数性质，后续可按同样方式迁入 `src/core`：

- `src/shared/model.js`
- `src/shared/archive.js`（分组归档投影/可见性/不变量/单组开关；只依赖 `constants.js`）

## 测试边界

`tests/core/boundary.test.js` 会扫描 `src/core/**`，阻止 React/DSH/DOM 依赖倒灌进来。  
`tests/core/shared-boundary.test.js` 对共享领域内核施加同样的约束。  
`tests/core/session-row.test.js` 直接测试纯比较与文案策略。  
`tests/unit/archive.test.js` / `tests/core/archive-drop.test.js` / `tests/host/archive-guard.test.js` 覆盖归档指纹矩阵、可见性、拖拽合法性与 host 提交守卫。
































