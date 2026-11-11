# 0.4.0-beta.62 分组归档与子树冻结 实施 PLAN

- 状态：approved；独立审核 GO；post-GO 非阻断修正已并入（不重开审核）
- 日期：2026-11-10
- Plan 审核指纹（审核时）：lines=290 bytes=25277 mtime=2026-11-10T19:36:40.3796667+08:00 sha256=254B52F234153B955D3401B9385324DD1B128182A934E79A6EFC1201DA831C98
- 分支：`feature/group-archive`（从 `dev` 0a05c2f 切出）
- Spec：`docs/specs/2026-11-10-group-archive-freeze.md`
- Spec 审核指纹：lines=391 bytes=25742 mtime=2026-11-10T19:10:36.7720389+08:00 sha256=22B2CE732DE3BA0F5F590DD74253E6F240161AF1A4A56A8EAAE044CDA7DA9518
- Spec 审核结论：GO，无阻断；12 条非阻断项在 §1 收敛。
- 基线：0.4.0-beta.61；726/726 unit/contract tests，39/39 UI runtime，331 locale keys。
- 本 plan 只描述实现；二维码资产瘦身只在 P12 最终文档任务执行。

## 0. 执行规则

1. 严格串行：本批**无并行组**。所有任务都触碰 `src/shared/**` 或共享 `npm test` 句柄；并行收益低、冲突风险高。
2. 每个任务派**全新 implementer subagent**；完成后依次过 **Stage 1 规格符合**、**Stage 2 代码质量** 两个全新 reviewer。默认 GO，只报阻断级；非阻断只记录。
3. 审核钉版本：实现未提交时以 `git diff`（相对分支基点）+ 相关文件 sha256/行数为准；每轮报告首行记录指纹。审核期间被审文件变动则该轮作废。
4. 每步最多 2 轮审核；未收敛即停手，把分歧和两种取舍摆给用户，不自行加轮。
5. 实现者禁止嵌套派 agent、禁止删除文件、禁止在系统临时目录外留临时文件；结束附删除操作清单（应为空）。唯一例外：P12 旧二维码资产的回收站删除由 Lead/用户执行，implementer 不删除。
6. 不自动 commit/push/merge/tag。提交、合并、归档 tag 都要用户明示；每一步的审核以工作树 diff 为准。
7. 共享 `npm test` 是唯一测试句柄；任何任务不得并发跑 build/test。`check:ui`/`check:style`/`check:coverage`/`check:release` 在 P11/P12 串行执行。
8. 写域严格按 §2；实现者发现需要改域外文件，停下报告，由 Lead 调整计划，不得顺手改。
9. 二维码任务只在 P12 执行；P1-P11 不得动 `assets/`、README、`package.json.files`。

## 1. Spec 审核非阻断项收敛

### N1 ungrouped 与分组过滤

- `groupFilter = hidden | all`：ungrouped 区块正常渲染，会话三态照常。
- `groupFilter = only`：ungrouped 区块**隐藏**；搜索/状态中的 ungrouped 会话也随之不可见。
- 因此 `only` 下没有归档组时视图为空（与 spec §4.2 一致）。
- 搜索可见性：分组会话必须在可见分组内；无分组会话跟随 ungrouped 区块可见性。
- 测试：hidden/all 下 ungrouped 搜索仍命中；only 下不命中。

### N2 `archived` 归一化路径

- `parseCommitBody`：只校验 `archived` 是 boolean/缺失，不做 false 归一化。
- `store.commit`：读 current doc；入站 group 缺失 `archived` 时按 id 继承 current 值（新组按 false）；然后 `validateForWrite` 归一化为显式 boolean 并写盘。
- `save` 新建 profile：缺失按 false。
- 读取/投影始终 `=== true`；`peek`/`readState` 接受缺失。

### N3 二维码体积表述与合并批次

- QR-only 基线：`1,275,645 → 约 704,553 bytes`，**约为原来的 55%（减少约 45%）**；避免只写“降 55%”。
- 但 62 是**合并批次**（功能 + 文档 + 新源文件），最终 `npm pack` 的 files/bytes 会高于 QR-only 的 233/704,553。验收断言改为：
  - QR 资产净减 ≈ 611,364 − 40,272 = **571,092 bytes**；
  - 最终 tgz 相对 `.61` 基线实测记录，目标约 55–60%，不硬编码 704,553；
  - files 数记录实际值（新 ADR/release note/源文件会增加），不拿 233 当硬断言。

### N4 `.62` release note 范围

- `.62` 同时包含分组归档功能与二维码资产瘦身；release note 必须覆盖整批，不能写“assets only / 无代码变化”。
- QR 只作为 release note 的 **Assets** 小节：该小节可写“资产替换本身无代码/API/存储变化”，但整篇 note 必须列出功能、控制协议、兼容与测试。
- CHANGELOG 分两个条目：feature 与 assets。

### N5 move-group 固定 index 0 / 兄弟位移

- `moveGroupStep`（菜单上移下移）：先按最新 doc 预检；会改变归档锚点时禁用并给原因。
- `move-group` 对话框默认 index 0；若 index 0 会违反锚点不变量，改为**追加到目标组末尾**（append 不会移动既有子组），并 toast 说明“已放到末尾以避开归档分组”；若目标组是归档组，选项直接禁用。
- `delete-group` 的目的地/删除动作：用候选 doc 跑不变量；会位移归档锚点时，目的地禁用或删除动作禁用 + 原因（不静默换位置）。
- 控制 `group.move/delete` 返回 `group-position-locked` 等结构化错误。
- 测试：目标组含归档子组、index 0 冲突、append 安全、delete 候选冲突。

### N6 control 409/422 分流

- Control plan/apply：schema/未知字段/类型/负索引等 → 422；归档状态冲突（`group-archived`、`group-contains-archived`、`group-destination-archived`、`group-position-locked`、`archive-frozen`）→ 409。
- Host `/commit`：`archive-frozen` → 409。
- Native tool：结构化 code，不用 HTTP 状态。

### N7 校验错误码命名

- `validateDoc`：`group-archived-type:<id>`（持久化类型错误）。
- 操作错误：`group-archived`、`group-contains-archived`、`group-destination-archived`、`group-position-locked`、`archive-frozen`。
- 测试断言两层不混用。

### N8 profile 切换

- 不把 `onProfileSwitchReset` 当兜底；现有 store/queue 会清 dialog/menu/pending，drag/search 本地态不保证。
- 本功能不新增本地归档态；若 P8/P9 新增 drag/drop 本地态，在 doc/profile epoch 变化时显式清理并加测试。

### N9 既有源码正则/快照测试

- 必须同步：`tests/client/ui-layout.test.js`（buildVisibleTree 调用/useMemo deps/归档三态源码断言）、`tests/client-logic/client-surface.test.js`（testid）、`tests/unit/model.test.js`、`tests/client/filter.test.js`、`tests/client/tree.test.js`、`tests/client/state.test.js`、`tests/docs/consistency.test.js`。
- `tests/host/identity.test.js` 只校验包名/路径/key/无旧前缀，通常不需改；若源正则触达再改。
- 靠 `npm test` 暴露遗漏，不能只跑目标测试。

### N10 CONTRACTS 冻结约束

- 不改 `docs/CONTRACTS.md`。
- 新增 `docs/adr/0004-group-archive-freeze.md`，记录：分组级 `archived` 是 additive extension；`buildRenderTree` 新增 groupFilter 剪枝，frozen CONTRACTS 的“Groups always returned”只适用于旧的纯 session filter 语义；新的群组过滤由本 spec/ADR 定义。
- ARCHITECTURE 同步新字段/新控制 op/新结果 kind。

### N11 会话三态措辞

- 会话三态在所有**已渲染分组内部**生效（full、普通可见组），pathOnly 自身会话不渲染、不参与。
- `group=all` 下归档组已渲染，同样套会话三态。

### N12 次要定义

- 归档确认边界：有直接会话、直接子组、运行中会话、或当前会话在该组内 → 确认；空叶子组直接提交。
- `data-contains-archived`：只加在“非 effective archived、但含归档后代”的组（pathOnly/祖先），用于提示；effective archived 组用 `data-archived`。
- `group.archive` 同值：`setGroupArchived` 返回同一 doc；control 整批无变化返回 `no-change`（422），不 bump revision；文档说明“doc 语义幂等，不是响应成功幂等”。
- `group.archive` 自身 flag 变化始终允许；不级联。

## 2. 任务分解（严格串行）

### P1 — shared archive 领域核心

- 写域：`src/shared/archive.js`（新建）、`src/shared/model.js`、`tests/unit/archive.test.js`（新建）、`tests/unit/model.test.js`、`tests/core/model-edge.test.js`
- 内容：
  - 新建 `archive.js`：`isOwnArchived`、`effectiveArchived`、`archivedInfo`、`hasArchivedDescendant`、`normalizeGroupArchived`、`findArchiveViolation`、`assertArchiveInvariant`、visibility 常量、错误码常量；不 import model，避免循环。
  - `model.js`：`Group.archived` 校验（`group-archived-type:<id>`）；现有 mutator 在 clone/mutate 后调用不变量；`validateDoc` 接受缺失/boolean。
  - `setGroupArchived` 的实现放在 `archive.js`（本地 clone/find，不 import model），由 `model.js` re-export；原因是 `tests/core/export-usage.test.js` 的 dead-export 守卫会在 P5/P7 消费前把 model.js 的直接导出判死；re-export 不改变 import 路径，测试仍从 model 导入。该偏差已由 Lead 授权。
  - 指纹比较：归一化 `groupColor`/`colorHex`/`archived===true`；父子/index/sessionIds/子组 id 顺序/祖先链。
  - `unarchive+编辑` 严格 before-state；`archive+编辑` 允许。
- 接口（供后续任务）：
  - `effectiveArchived(doc, groupId): boolean`
  - `archivedInfo(doc, groupId): { own, effective, archivedBy }`
  - `computeGroupVisibility(doc, groupFilter): { full:Set, path:Set }`
  - `findArchiveViolation(before, after): null | { code, groupId, field }`
  - `setGroupArchived(doc, groupId, archived): doc`（同值返回原 doc）
- 测试：predicate/继承/cycle 防御；每个 mutator 允许/拒绝；归一化误报；同值 no-op；validation。
- 完成定义：`npm test` 全绿；新增测试覆盖指纹矩阵；无 P2 范围（buildRenderTree 不改）。

### P2 — 可见性、树、搜索、状态

- 写域：`src/shared/model.js`、`src/shared/archive.js`、`src/core/filter.js`、`src/core/search.js`、`src/core/tree.js`、`tests/unit/model.test.js`、`tests/client/filter.test.js`、`tests/client/search.test.js`、`tests/client/tree.test.js`、`tests/client-logic/shared-invariants.test.js`
- 内容：
  - `buildRenderTree(doc, sessions, workspaces, { groupFilter, filter, ... })`；默认 `groupFilter='hidden'`；节点字段 `effectiveArchived/ownArchived/archivedBy/pathOnly/visibleCount`；`assigned` 从完整 doc；hidden/all/only + pathOnly；counts。
  - ungrouped：hidden/all 渲染；only 隐藏（N1）。
  - `buildVisibleTree` 透传 groupFilter。
  - 搜索：索引保留全部非 subagent 会话（entry 带 groupId/effective）；匹配与渲染前按分组可见性过滤，并暴露 hiddenMatches 计数供 P9 提示；无分组会话跟随 ungrouped；保留可见组内 archived session 的现有“可列出但不可打开”行为（组件层稍后）。
  - `statusSectionsByGroup`：同可见性；ungrouped only 隐藏；pathOnly 自身会话排除。
  - 共享 `computeGroupVisibility`，避免三套判定。
- 测试：hidden/all/only × session hidden/all/only；pathOnly own sessions；assigned 泄漏；counts；搜索/状态。
- 完成定义：`npm test` 全绿；P1 测试不回归。

### P3 — 拖拽/放置合法性

- 写域：`src/core/drag.js`、`src/core/group-drag.js`、`src/core/archive-drop.js`（新建）、`tests/client/drag.test.js`、`tests/client/group-drag.test.js`、`tests/core/group-position.test.js`、`tests/core/archive-drop.test.js`（新建）
- 内容：
  - `evaluateSessionDrop`/`evaluateGroupDrop`：完整 doc 解析 + 归档不变量；返回 position/violation/reason。
  - 会话：源/目标在归档子树 → violation；容器锁；不涉及单独归档会话的全局冻结。
  - 组：归档组自身/含归档后代的源禁止；目标父组归档禁止；兄弟 index 位移精确判定；归档组 append/head 禁止；before/after 条件判定。
  - 预览/提交共用同一函数；不 clone 整份 doc per dragover（定向 index 检查）。
  - reason：`archived-group`、`archived-container`、`archived-anchor`、`archived-destination` 等稳定字符串。
- 测试：完整 `[B,A,C]`/`[B,A]`/`[A,B]` 隐藏子组矩阵；归档组自身；祖先；会话源/目标；预览/提交一致性。
- 完成定义：`npm test` 全绿；UI 尚未接入。

### P4 — host 校验、提交守卫、兼容

- 写域：`src/host/http/wire.js`、`src/host/store.js`、`src/host/http/respond.js`、`src/host/routes.js`、`tests/host/store.test.js`、`tests/host/routes.test.js`、`tests/integration/host-routes.test.js`、`tests/host/profile-routes.test.js`（3 处“copied verbatim”期望因 save 显式 archived:false 归一化而过期；仅改期望）、`tests/host/archive-guard.test.js`（新建）
- 内容：
  - `parseCommitBody`：archived 类型校验，不做 false 归一化。
  - `store.commit`：读 current → 缺失 archived 按 id 继承 → `validateForWrite` 归一化显式 boolean → 不变量 → 写；返回 `kind:'archive-frozen'`；不 bump revision。
  - `store.save`/profile 新建：缺失 false；不做 transition guard。
  - `readState`/`peek`/backup 接受缺失/boolean。
  - `commitResponse` 映射 409；`routes` 透传；错误体含 `groupId/field`。
  - `archive-frozen` 不广播 revision。
- 测试：旧客户端缺字段继承；显式 false 取消归档；非法类型 422；结构/元数据/内容/锚点违规；CAS；备份/ save 例外；响应形状。
- 完成定义：`npm test` 全绿；无 control/UI 范围。

### P5 — 客户端过滤状态与 header 双三态

- 写域：`src/client/state.js`、`src/client/state/persistence.js`、`src/client/groups-view-state.js`、`src/client/components-header.js`、`src/client/components.js`、`src/client/groups-view-menu-handlers.js`、`tests/client/state.test.js`、`tests/client/ui-layout.test.js`、`tests/client/action-handlers.test.js`（`setGroupArchiveFilter` 接线，避免 header 分组三态点击 no-op）
- 内容：
  - `groupArchiveFilter` 默认 hidden；新 key `dsh-session-grove.archive.groups.v1`；blocked storage 回退；dispatch action。
  - `groups-view-state` 传 groupFilter；memo deps。
  - header popover 两段三态；旧 testid 保留；新 testid；`data-filter` + `data-group-filter`；选择后保持展开，外部/Escape 关闭；aria 分组。
  - 旧 e2e 3 行断言更新在 P11；本任务先改源码/单测。
- 测试：persistence/default/blocked；popover 源码/结构；memo deps。
- 完成定义：`npm test` 全绿；`npm run check:ui` 暂不要求（P11）。

### P6 — profile diff

- 写域：`src/core/profile-diff.js`、`src/client/profile-preview.js`、`src/client/profile-switch.js`、`tests/core/profile-diff.test.js`
- 内容：normalize archived；sameGroup/sameDocs；diff changed 增加 archived；preview 显示归档状态变化；missing/false 等价。
- 测试：仅 archived 差异时 sameDocs=false、diff changed；预览文案条件。
- 完成定义：`npm test` 全绿。

### P7 — 控制协议

- 写域：`src/core/control.js`、`src/host/control-routes.js`、`src/host/tool.js`、`skills/session-grove-control/SKILL.md`、`scripts/session-grove-control.mjs`、`tests/core/control.test.js`、`tests/core/control-values.test.js`、`tests/host/control.test.js`、`tests/host/tool.test.js`、`tests/host/control-cli.test.js`
- 内容：
  - `group.archive` schema/apply/state；`state.groups[]` own/effective/archivedBy；不暴露 pathOnly。
  - 守卫复用 P1；整批终校验原始 doc；同值 no-op → `no-change`。
  - 409/422 分流（N6）；错误体 groupId/field/operationIndex。
  - `CONTROL_OPERATIONS`、skill、CLI 示例/文档。
- 测试：schema/字段/守卫/state/批量顺序/同值/错误码/HTTP 状态/tool。
- 完成定义：`npm test` 全绿。

### P8 — 行、菜单、拖拽 UI

- 写域：`src/client/components-rows.js`、`src/client/session-menu.js`、`src/client/components-primitives.js`、`src/client/components.js`、`src/client/groups-view-menu-handlers.js`、`src/client/groups-view-dialog-handlers.js`、`src/core/session-row.js`、`tests/client/ui-layout.test.js`、`tests/client/action-handlers.test.js`、`tests/client/dialog-selection.test.js`、`tests/core/session-row.test.js`
- 内容：
  - Group row：`data-archived/effective`、`data-path-only`、`data-contains-archived`、badge/lock、拖拽锁、菜单禁用原因、`+` 禁用/reason。
  - Session row：`data-structural-locked`、`draggable=false`、不设置容器级 `data-archived`；菜单保留 rename/archive/copy，禁用 move/fork/up/down + 原因。
  - `src/core/session-row.js` 的 `sessionRowPropsEqual` 纳入 `structuralLocked/groupArchived`；`tests/core/session-row.test.js` 补比较器用例。
  - 拖拽 handlers：接入 P3 evaluate；归档组 body 拒绝且防冒泡；不调度 auto-expand；placeholder 只在合法目标。
  - pathOnly：只显示组头/路径；自身会话不渲染；内容创建允许（不可见结果 toast 在 P9）。
  - `groupFilter='only'` 时 `components.js` 不渲染 ungrouped 区块。
  - 过滤感知全局空态（hidden 下有隐藏归档组的提示 + 动作；only 无归档组时提示 + 切 `all`）因需要“显示已归档分组”动作与文案，**归 P9**（复用 `session-groups-empty-state`，P11 补测试）。
  - 菜单 handler 保持可用（取消归档）；归档/取消归档条目的动作实现归 P9。
  - 含归档后代的非归档祖先：只禁用 move/up/down/delete，保留 rename/icon/color/new-session/new-subgroup（spec §5.3/§6.2/§4.6；Lead 已确认）。
- 测试：行 attrs/memo；菜单禁用原因；drop 拒绝/不冒泡；pathOnly 渲染；空态。
- 完成定义：`npm test` 全绿；不要求 e2e。

### P9 — 对话框、动作、自动路径

- 写域：`src/client/plugin-host.js`、`src/client/plugin.js`（bridge 暴露 archiveGroup/unarchiveGroup/setGroupArchiveFilter）、`src/client/actions.js`、`src/core/dialog-selection.js`、`src/client/group-list-picker.js`、`src/client/dialog-host.js`、`src/client/components-search-box.js`、`src/client/groups-view-search.js`、`src/client/optimistic.js`、`src/client/api.js`、`src/client/session-menu.js`（组归档/取消归档菜单项）、`src/client/groups-view-dialog-handlers.js`（组归档 handler、moveGroupStep 预检）、`src/client/components.js`（过滤感知全局空态）、`tests/client/actions.test.js`、`tests/client/dialog-selection.test.js`、`tests/client/search.test.js`、`tests/client/action-handlers.test.js`、`tests/client/optimistic.test.js`、`tests/client/api.test.js`
- 内容：
  - 归档/取消归档动作：菜单入口、确认边界（N12）、strict commit、toast/焦点/“查看已归档分组”动作。
  - 对话框确认守卫；move-group 安全 index（N5）；目的地归档禁用 + 原因；delete 候选不变量；move-session 目的地。
  - new session / reconcile / fork 的 precheck、竞态、留在 ungrouped。
  - 搜索隐藏命中提示 + “显示已归档分组”动作；不自动切；隐藏命中计数由 P2 的可见性过滤结果提供（索引保留全量）。
  - 过滤感知全局空态：hidden 下有隐藏归档组的提示 + 动作；only 无归档组时提示 + 切 `all`；复用 `session-groups-empty-state`。
  - 不可见结果 toast + 切换动作；pathOnly 内容创建。
  - `optimistic`/`commitStrict` 对 `archive-frozen` 的失败映射：回滚、精确 toast、刷新 doc，不重试。
- 测试：确认边界；move-group index 0/append；目的地禁用；confirm 后归档 → inline archive-frozen；fork/follow race；search hidden action。
- 完成定义：`npm test` 全绿。

### P10 — CSS + 19 语言

- 写域：`src/client/css.js`、`locale/*.json`、`tests/client/i18n.test.js`、`tests/client/locale.test.js`、`tests/client/ui-layout.test.js`、`tests/docs/consistency.test.js`
- 内容：
  - 归档组单层 dim（最外层 `.62`，内部重置），pathOnly 不变暗，badge/lock，disabled 样式，structural locked cursor，RTL。
  - 新增 locale keys：分组三态、归档/取消归档、badge、pathOnly、locked reasons、toast/空态/search 动作、aria。
  - 19 语言 parity；en 键数更新；I18N 文档在 P12。
- 测试：i18n parity/keys；CSS 源码断言；RTL smoke 在 P11。
- 完成定义：`npm test` 全绿。

### P11 — UI runtime / e2e / 既有测试同步

- 写域：`e2e/groups.spec.mjs`、`e2e/isolated.spec.mjs`（P5 后 popover 选择保持展开，原“选完自动关闭”等待会超时）、`tests/ui/ui-runtime.spec.mjs`、`tests/client/ui-layout.test.js`、`tests/client-logic/client-surface.test.js`、`tests/client/filter.test.js`、`tests/unit/model.test.js`（如仍需）
- 内容：
  - 两段三态、选择后不关闭；`data-filter` + `data-group-filter`。
  - hidden 子树不存在；only path；会话改名/归档可用；拖拽/fork 禁用；搜索/状态不泄漏；焦点/toast；pathOnly。
  - 更新“3 行”断言、源码正则、testid。
  - `npm test`、`npm run check:ui`、`npm run check:style`。
- 完成定义：`npm test`、`npm run check:ui`、`npm run check:style` 三项全绿；A+ e2e 不在本任务自动跑（用户手工）。

### P12 — 文档、版本、二维码最终任务

- 写域：`docs/ARCHITECTURE.md`、`docs/TEST-MATRIX.md`、`docs/TEST-RESULTS.md`、`docs/I18N.md`、`docs/COMPATIBILITY.md`、`docs/INDEX.md`、`docs/adr/0004-group-archive-freeze.md`（新建）、`CHANGELOG.md`、`docs/release-notes/v0.4.0-beta.62.md`（新建）、`package.json`、`dsh.plugin.json`、`src/shared/constants.js`、`package-lock.json`、`README.md`、`README.zh.md`、`assets/qrcode-qq-group.jpg`（新建）、`package.json.files`、`lib/`（build 生成）。`assets/qrcode_1794236242994.jpg` 的回收站删除不在 implementer 写域，由 Lead/用户执行。
- 内容：
  - 版本 `.62` 五处一致；README/README.zh 的 “Current version” 行同步 `.62`；release note 覆盖整批 + Assets 小节（N4）；CHANGELOG 两条；TEST-MATRIX 计数/证据；ARCHITECTURE/ADR；I18N 键数。
  - QR：新图复制/校验哈希；README/README.zh/package.files 引用；assets 小节；**旧图不由 implementer 删除**，P12 证据齐备后由 Lead 经用户授权用回收站删除。
  - 验证 `check:style && npm test && build && check:lib && node --check lib/client.js && check:coverage && check:ui && check:release && npm pack --dry-run`。
  - 体积证据：新/旧资产实际 bytes 差（40,272 − 611,364 = −571,092）是硬事实；`npm pack --dry-run` 只记录最终 files/tgz 实测，不用 dry-run 证明资产差；合并批次目标约 55–60%，不硬编码 QR-only 的 233/704,553。
  - 不触碰 `v0.4.0-beta.61` tag/release；不自动 push/merge/tag。
- 完成定义：全部门禁绿；`npm pack --dry-run` 记录实测 files/bytes；新资产与引用就位；旧资产删除留给 Lead/用户回收站步骤；用户验收后另行授权提交/合并/发布。

## 3. 并行组表

本批**无并行组**。

| 任务 | 写域（相对路径前缀） | 测试句柄 | 前置 |
|---|---|---|---|
| P1 | src/shared/archive.js, src/shared/model.js, tests/unit/archive.test.js, tests/unit/model.test.js, tests/core/model-edge.test.js | npm test | — |
| P2 | src/shared/model.js, src/shared/archive.js, src/core/filter.js, src/core/search.js, src/core/tree.js, tests/... | npm test | P1 |
| P3 | src/core/drag.js, src/core/group-drag.js, src/core/archive-drop.js, tests/client/drag.test.js, tests/client/group-drag.test.js, tests/core/group-position.test.js, tests/core/archive-drop.test.js | npm test | P1 |
| P4 | src/host/http/wire.js, src/host/store.js, src/host/http/respond.js, src/host/routes.js, tests/host/... | npm test | P1 |
| P5 | src/client/state.js, state/persistence.js, groups-view-state.js, components-header.js, components.js, tests/client/state.test.js, ui-layout.test.js | npm test | P2 |
| P6 | src/core/profile-diff.js, src/client/profile-preview.js, src/client/profile-switch.js, tests/core/profile-diff.test.js | npm test | P2 |
| P7 | src/core/control.js, src/host/control-routes.js, src/host/tool.js, skills/..., scripts/..., tests/host/control*.test.js, tests/core/control*.test.js | npm test | P4 |
| P8 | src/client/components-rows.js, session-menu.js, components-primitives.js, components.js, groups-view-*-handlers.js, src/core/session-row.js, tests/core/session-row.test.js, tests/client/... | npm test | P2,P3,P5 |
| P9 | src/client/plugin-host.js, actions.js, group-list-picker.js, dialog-host.js, components-search-box.js, groups-view-search.js, optimistic.js, src/core/dialog-selection.js, tests/client/... | npm test | P8 |
| P10 | src/client/css.js, locale/*.json, tests/client/i18n.test.js, locale.test.js, tests/client/ui-layout.test.js, tests/docs/consistency.test.js | npm test | P8,P9 |
| P11 | e2e/groups.spec.mjs, tests/ui/ui-runtime.spec.mjs, tests/client/ui-layout.test.js, tests/client-logic/client-surface.test.js, tests/client/filter.test.js | npm test; check:ui; check:style | P1-P10 |
| P12 | docs/*, CHANGELOG.md, package.json, dsh.plugin.json, src/shared/constants.js, package-lock.json, README*, assets/qrcode-qq-group.jpg, lib/*；旧 QR 资产由 Lead 回收站删除 | full release commands | P11 |

说明：同一任务内也不并发跑 npm test/build；`src/shared/model.js` 在 P1/P2、`src/client/components.js` 在 P5/P8 出现，都是串行编辑，不构成并行写域重叠。

## 4. 审核协议

- Implementer：读 spec/plan/相关现有实现；只改写域；先写测试再实现（TDD）；运行 `npm test`；报告状态、关键结论、改动范围、未决项、删除清单。
- Stage 1 reviewer（全新）：逐条对照 spec/plan 与实现，查“缺/多”；只报阻断级；默认 GO。
- Stage 2 reviewer（全新）：正确性/边界/测试充分/可维护性/安全；只报阻断级；默认 GO。
- 每次审核首行记录：被审对象指纹（`git diff` 相对基点 + 文件 sha256/行数）、审核结论、阻断项、非阻断备注。
- 审核期间不修改被审写域；NO-GO 由新 implementer 修正，再定向复审；最多 2 轮。
- 每个任务 GO 后更新 todo，再派下一个。

## 5. 风险与回滚

- 风险：assigned 泄漏、归一化误报、三套可见性漂移、memo 不重绘、双重 dim、事件冒泡、预览/提交不一致、旧客户端丢字段、move-group index 0、control 状态码混用、既有源码正则失败、locale parity、release note 范围。
- 回滚：任务级按写域回退；不跨任务回滚；每步测试全绿才进下一步。
- QR 任务独立：只动 assets/README/package.files/docs；功能代码已稳定后再做。

## 6. 自审

- Spec 覆盖：§3→P1/P4；§4→P2/P5/P9；§5→P3/P8/P9/P10；§6→P1/P4；§7→P7；§8→P9；§9→P4/P6；§10→P5/P8/P10/P11；§11→P3/P8；§12→P11/P12；§13→P12。逐项有任务。
- 可执行性：每任务有写域、接口、测试、完成定义、前置；串行无共享写域并发。
- 接口一致性：`effectiveArchived/archivedInfo/computeGroupVisibility/findArchiveViolation/evaluateDrop/setGroupArchived` 在 P1/P2/P3/P4/P7 的引用一致；`buildRenderTree` groupFilter 命名一致。
- 审核意见：N1-N12 全部在 §1 收敛；N3 按“原来的 55%”表述；N4 改为整批 release note + Assets 小节；N5 增加 move-group append 回退；N6 明确 409/422 分流；N7 区分类型错误与操作错误；N8 不依赖 profile reset；N9 列入既有测试同步；N10 新增 ADR；N11 统一“已渲染分组”；N12 定义确认边界/data-contains/no-op。
- 未覆盖：具体函数签名细节、locale key 名、CSS 数值、测试文件精确行号由实现者按现有风格落；plan 审核可要求补，但不阻断 spec 已 GO 的范围。
- 执行细节补入：P8 负责 `groupFilter='only'` 时隐藏 ungrouped 区块；P9 负责 `archive-frozen` 的 optimistic 失败映射；P12 负责 COMPATIBILITY/INDEX 与新 ADR。
- 体积口径修正：QR-only 的 233/704,553 不能直接套到合并批次；P12 改为断言 QR 净减 571,092 bytes，最终 tgz/files 记录实测，避免把旧预期当硬断言。
- 二维码：P12 才执行；P1-P11 写域不含 assets/README/package.files，避免提前。
- Plan 审核 8 条非阻断修正已并入：P8 补 `src/core/session-row.js` + `tests/core/session-row.test.js` 并点名空态 owner；P9 的 `dialog-selection` 改为 `src/core/dialog-selection.js`；P10 补 `tests/client/ui-layout.test.js`；P2 搜索索引保留全量并暴露 hiddenMatches；P12 旧 QR 资产改由 Lead/用户回收站删除、体积证据改为实际 size 差 + dry-run 实测、README 版本行同步；N9 的 `tests/host/identity.test.js` 标为通常无需改。

## 7. 执行记录

### P1 — shared archive 领域核心（GO）

- 状态：Stage 1 规格符合 GO；Stage 2 代码质量 GO；`npm test` 752/752。
- 指纹（审核时）：`archive.js` 260 行/11803 bytes/`974CF100…3A097`；`model.js` 513 行/20690 bytes/`AD80C831…6525A`；`tests/unit/archive.test.js` 360 行/14232 bytes/`53051542…2D497`；`tests/unit/model.test.js` 638 行/28779 bytes/`D8447AB3…C552`；`tests/core/model-edge.test.js` 82 行/2766 bytes/`9B5A2EAF…8C27`。
- 授权 deviation：`setGroupArchived` 实现在 `archive.js`，`model.js` re-export；为过 `tests/core/export-usage.test.js` dead-export 守卫，未改测试。
- 后续 carry-over：
  - P4：`assertArchiveInvariant(currentDoc, incomingDoc)` 必须 current 作 before；`error.code` 进 409 body，`error.kind === 'archive-frozen'` 判状态；先 validateDoc 再守卫。
  - P4 可选收紧：裸提交可把归档组 icon 在 folder↔未知 icon 间显示等价改写；host 可在写路径按 color 同策略 normalizeIcon（非阻断）。
  - P7：`deleteGroupTo` 到归档目的地不变量本身可能放行（指纹无变化），操作层必须无条件拒绝；index 位移两类 code 都按“会改变归档分组位置”处理。
  - P2：补 `computeGroupVisibility`/hidden-all-only 契约，避免跨任务命名断裂。
  - P11/P12：`lib/` 未重建；最终 build/check:lib 负责。

### P2 — 可见性/树/搜索/状态（GO）

- 状态：Stage 1 GO；Stage 2 GO；`npm test` 772/772。
- 指纹（审核时）：`archive.js` 313/13925/`577B5D01…9E7C`；`model.js` 539/22085/`51CFFE0C…86DA`；`filter.js` 112/4630/`281741FD…1143`；`search.js` 251/10316/`7C8C6E4B…3ED5`；`tree.js` 237/10176/`FE14572D…5E92`；测试 5 个文件见 plan 审核报告。
- 后续 carry-over：
  - P5：`groups-view-state.js` 必须同时把 `groupFilter` 接进 `buildVisibleTree` 与 `statusSectionsByGroup` 两处及 memo deps，否则树/计数漂移。
  - P8：pathOnly 节点即使 `visibleCount=0/emptyVisible=true` 也先按 `pathOnly` 渲染路径头，不能画成空组锁定态。
  - P9：先对全量 match 做 visible/hidden split，再对 visible 限流；hidden 计数用 `hidden.length`，否则隐藏命中会吃掉 limit 预算。
  - search.js 的 only JSDoc 有一句把“不可见集合”写成 visible，行为正确、注释待 P9 顺手修正。

### P3 — 拖拽/放置合法性（GO）

- 状态：Stage 1 首轮 NO-GO（B1：ungrouped 锚点 index 丢失）→ 修复 → 定向复审 GO；Stage 2 GO；`npm test` 805/805。
- 最终指纹：`drag.js` 307/14789/`233EA364…FAD3`；`archive-drop.js` 164/7790/`43177A46…8FFB`；`group-drag.js` 未改 147/6750/`BD9E1A0B…8F46`；`tests/client/drag.test.js` 436/22799/`AB4E1BBC…B332`；`tests/client/group-drag.test.js` 216/9585/`794F0AF2…0248`；`tests/core/group-position.test.js` 96/4300/`BA0CD38A…1931`；`tests/core/archive-drop.test.js` 394/17484/`278B5348…F117`。
- 裁决：任务下发时“`[B,A(归档)]` after B 允许”示例错误；严格锚点下 after B 会推 A → 拒，允许 after A / B 本身归档时 after B。
- 后续 carry-over：
  - P8：预览用 `checkSessionDrop`/`checkGroupDrop`，提交用 `applyDrop`/`applyGroupDrop`；reason 映射；`applyGroupDrop` 可能由 `moveGroup` 抛 `depth-exceeded`，按既有方式兜。
  - P8/P9：ungrouped 同槽锚点 `checkSessionDrop` 恒 noop:false（会多写一次）属既有边界，可在 UI 侧比较 moving.index===position.index；derived ungrouped 行不在 doc.ungrouped，作为锚点会 invalid（与“完整 doc 解析”一致）。
  - P12：ARCHITECTURE drag 小节省 `checkSessionDrop`/`archive-drop`。
  - P8 接线后可将 `archive-drop.js` 底部 export 改回 `export const`，让 dead-export 守卫覆盖。

### P5 — 客户端过滤状态/header 双三态（GO）

- 状态：Stage 1 GO；Stage 2 GO；`npm test` 838/838；`check:ui` 39/39（P5 非必需，但已验证）。
- 指纹：`state.js` 573/23261/`B3AE0181…CE5C`；`persistence.js` 173/6098/`FE6EFF35…C814`；`groups-view-state.js` 104/4575/`510C360F…D7FC`；`components-header.js` 568/22074/`919A1B73…E2C7`；`components.js` 878/39945/`E63309BE…C399`；`groups-view-menu-handlers.js` 80/3447/`C0937E1F…8201`；`state.test.js` 650/28495/`17EDBB54…BED8`；`ui-layout.test.js` 1249/73084/`939AFD84…BFA7`；`action-handlers.test.js` 224/9168/`4A8A396C…52A9`。
- 后续 carry-over：
  - P10：必须给 19 语言补 5 个 key：`archive.group.hidden/all/only`、`archive.section.sessions/groups`（当前仅 map 常量，i18n literal-key 守卫扫不到）；补 `.dsg-view-options-section*` 样式与 popover max-height/overflow；`archive.label` 可能变成无引用资源 key，P10/P12 决定去留。
  - P11：`e2e/groups.spec.mjs` 与 `e2e/isolated.spec.mjs` 的“选完 popover 关闭”等待改为保持展开；3 行断言扩为两段 6 行；ui-layout 的源码正则脆弱断言按意图更新。
  - P8/P9：`setGroupArchiveFilter` 已接线；后续 P8/P9 不得改回 close-on-pick。

### P11 — UI runtime/e2e/既有测试同步（GO）

- 状态：Stage 1 GO；Stage 2 GO；`npm test` 907/907；`check:ui` 41/41；`check:style` OK；两个 e2e 文件 `node --check` OK。
- 指纹：`e2e/groups.spec.mjs` 5646/328674/`919465F2…24BA`；`e2e/isolated.spec.mjs` 1447/77364/`F8567CFD…49A5`；`tests/ui/ui-runtime.spec.mjs` 1458/69244/`0B105A3A…CD64`；`tests/client-logic/client-surface.test.js` 194/10035/`86272852…463E`。
- 后续 carry-over：
  - P12：测试计数 907/41/1 browser/384 locale；`docs/I18N.md` 331→384；release note 覆盖整批 + Assets；`lib/` 重建；`archive.label` 死 key 去留。
  - 最终手工验收关注：真实 e2e/isolated 未跑；e2e 没有 hidden 子树/only path/拖拽/fork/搜索计数的端到端；`setFilter`/`pickGroupFilter` 固定 sleep 有轻微 flake；归档组 × disabled `+` 的 .28 透明度；disabled picker 点击无 toast。
  - `ui-layout` 源码断言在 P11 未改，P12 不要重排。

### P12 — 文档/版本/二维码（GO）

- 状态：Stage 1 GO；Stage 2 GO；发布状态/体积定向复审 GO；`npm test` 907/907；`check:ui` 41/41；`check:style` 215 files OK；`check:release`/`check:lib`/`node --check lib/client.js` OK。
- 版本：`0.4.0-beta.62` 五处一致（package/dsh.plugin.json/PLUGIN_VERSION/lock version/packages[""]）；`lib/` 重建，bundle stamp `.62`。
- 指纹：`ARCHITECTURE.md` 22099/`7C661A2C…0410`；`TEST-MATRIX.md` 20407/`52F00FC0…63B4`；`TEST-RESULTS.md` 11906/`EB7A6E25…890E`；`I18N.md` 8362/`115DD2E5…D505`；`COMPATIBILITY.md` 11180/`B333FB9C…5C77`；`INDEX.md` 2291/`E86C8B9E…89E5`；ADR-0004 5618/`CF68FF09…C39C`；`README.md` 31750/`D0462B26…6F62`；`README.zh.md` 30144/`3013BF68…84C5`；`CHANGELOG.md` 58320/`DF1DCE6C…A771`；release note `.62` 9165/`7A958BA9…89C5`；`lib/client.js` 625150/`D8F3619B…FF89`。
- QR：新 `assets/qrcode-qq-group.jpg` 40,272/`A08F494F…003A`，480×855 真 JPEG；旧 `assets/qrcode_1794236242994.jpg` 611,364，仍在磁盘、未打包；净减 571,092。
- 最终 pack：237 files / 825.5 kB / 3.1 MB（文档记 825.6，差 0.1 kB 文本尾差）；coverage 94.54/86.58/91.33；A+ 全部 manual pending，未虚报；`.61` 已发布、`.62` 未发布口径已在 docs/README/CHANGELOG/release note 修正。
- 未 commit/push/merge/tag；旧 QR 经用户授权已走回收站删除（工作树为 `D`，新 QR 已就位，旧路径/打包引用为零）。
- 后续：用户手工 A+（`test:isolated`/`test:ui-browser`/`test:locale-pack`/`test:all-locales` + 真实桌面视觉）；提交/合并/tag/push 需用户明示；`AGENTS.md` 仍以 `.60` 为发布基线，未改（项目规则文件，非 P12 写域）。

### P10 — CSS + 19 语言（GO）

- 状态：Stage 1 GO；Stage 2 GO；`npm test` 907/907；`check:ui` 39/39。
- 指纹：`css.js` 1127/77105/`F23649F9…F463`；`i18n.test.js` 197/7829/`E964F56B…13F7`；`ui-layout.test.js` 1423/85920/`D443306C…59A`；`consistency.test.js` 36/1870/`7B67132F…82DA`；19 locale ×384 keys（331→384）。
- 后续 carry-over：
  - P11：归档组容器 `.62` × 禁用 `+` `.45` 有效透明度约 .28，视觉验收关注；`search.hidden*` 复数可补 `formatMessage` targeted 断言；disabled picker 点击无 toast（P9 代码，非 P10）；旧 lib locale-* 仍是 331 key，build 后重建。
  - P12：`docs/I18N.md` 331→384；`archive.label` 死资源 key 去留；`lib/` 重建；测试计数。
  - 源码断言脆弱性记录：ui-layout 精确计数/Popover 结构，P11 改 e2e 时不要顺手重排这些。

### P9 — 对话框/动作/自动路径（GO）

- 状态：Stage 1 首轮 NO-GO（B1 测试无法证明）→ 抽纯策略 + 10 用例 → 定向 GO；Stage 2 首轮 NO-GO（CAS adopt 假成功）→ desired-state 校验 + 2 用例 → 定向 GO；`npm test` 903/903。
- 最终指纹：`plugin-host.js` 933/39532/`B29A16C3…5EA4`；`plugin.js` 408/15969/`AC8EC4E6…1958`；`actions.js` 290/12260/`B9B9143A…7316`；`dialog-selection.js` 424/18234/`CBD0C324…60A4`；`group-list-picker.js` 71/2882/`80C09A0B…AC38`；`dialog-host.js` 932/37387/`EF078C62…E41C`；`components-search-box.js` 291/11763/`99D2E2CA…3E5E`；`groups-view-search.js` 136/5647/`E0FB3F36…4786`；`optimistic.js` 372/16421/`6D15997C…480A`；`api.js` 283/11492/`47BD78BE…2A0D`；`session-menu.js` 259/11734/`3783EEE8…7F03`；`groups-view-dialog-handlers.js` 198/9078/`43FF8C9A…D0B1`；`components.js` 1116/50885/`E17518C6…A38B`；测试 6 个（dialog-selection 487/26978/`FDAC5305…5CB91` 等）。
- 后续 carry-over：
  - P10：P9 32 key + P8 14 key + P5 5 key + P6 1 key，另建议 `banner.archive-frozen`；两处 `{n}`；CSS 见 P8/P9 清单 + profile archive tag 中性色 + popover max-height/scroll。
  - P11：plugin-host 归档编排的 UI runtime/e2e 断言（确认框/menu/隐藏搜索动作/空态/焦点）；fork placement/newSession follow 的 adopt 同根因；search `SEARCH_MATCH_BUDGET` 截断；16px 缩进槽冒泡；forbidden sticky；auto-expand 500ms 竞态；ungrouped 容器 no-op 写；preview tag。
  - P12：CAS adopt 语义、desired-state 校验、helper 文档。
  - 同根因未修：`newSessionInGroup`/`forkSession` placement 在 CAS adopt 时仍可能成功假象（P11/后续）。

### P8 — 行/菜单/拖拽 UI（GO）

- 状态：Stage 1 GO；Stage 2 GO；`npm test` 870/870；`check:ui` 39/39。
- 指纹：`components-rows.js` 523/23652/`1CAF0ACD…EEA6`；`session-menu.js` 220/9862/`EAD321D0…9F30`；`components-primitives.js` 300/12276/`2DD832BF…F7CF`；`components.js` 1063/48124/`34D7ADB6…7F1F`；`groups-view-menu-handlers.js` 148/6571/`9F29894A…BCAB`；`core/session-row.js` 63/2728/`6628C806…EB96`；`ui-layout.test.js` 1366/81735/`0918731D…FDBA`；`action-handlers.test.js` 289/13292/`B7B9A800…077F`；`core/session-row.test.js` 90/4254/`9486AD95…FA68`；`groups-view-dialog-handlers.js`/`dialog-selection.test.js` 未改。
- Lead 裁决：含归档后代的非归档祖先只禁 move/up/down/delete，保留 rename/icon/color/new-session/new-subgroup；全局过滤空态归 P9。
- 后续 carry-over：
  - P9：`moveGroupStep` 需按完整 doc 预检归档锚点位移，菜单项禁用 + 原因，不能只 console.warn/generic toast（P8 Stage 2 备注 1）；组归档/取消归档菜单项与动作；全局过滤空态；自动路径/搜索/optimistic/API 字段。
  - P10：14 个新 locale key（P8 报告清单）+ P5/P6 key + CSS。
  - P11：16px 缩进槽事件冒泡、forbidden 未清 sticky、auto-expand 500ms 竞态、ungrouped 容器 no-op 可能多写一次、runtime 行/菜单/drop 断言、archive-drop 底部 export 注释/改 const。

### P7 — 控制协议（GO）

- 状态：Stage 1 GO（审核进程后异常退出但报告完整、指纹有效）；Stage 2 GO；`npm test` 861/861。
- 指纹：`control.js` 528/20636/`C3740BD3…F9ED`；`control-routes.js` 468/18253/`DEC3FB09…5DB1`；`tool.js` 395/16657/`DF4CBA3C…3960`；`SKILL.md` 343/13770/`9371A44E…A447`；`scripts` 220/8247/`758ED798…854E`；`control.test.js` 527/23060/`6F1A3CFE…51A9`；`control-values.test.js` 未改 74/3312/`2B74AA95…13CF`；`host/control.test.js` 1338/57998/`C37F9ABD…EA51`；`host/tool.test.js` 669/28166/`93A347E0…55A5`；`host/control-cli.test.js` 317/13076/`5594EF3D…7819`。
- 后续 carry-over：
  - P11：补 `group.delete` destructive-disabled 优先于归档守卫的定向用例；tool 测试 `destination` 变量命名实为源组移动的覆盖瑕疵；可补 preview tag/UI。
  - P12：skill 错误码描述补 `group-archived` 也可表示“live 兄弟 move 到 frozen 锚点前后”的 index 冲突；`group-destination-archived` 补 session.assign 目的地；批级终校验 `operationIndex=-1` 说明。
  - 可选清理：`ARCHIVE_CONFLICT_CODES` 仅同文件引用，属弱死导出；可去 export 或让 routes 直接消费。
  - P8：`group.archive` 已在 `CONTROL_OPERATIONS`/catalog 自动暴露，UI 行动作由 P9 接。

### P6 — profile diff（GO）

- 状态：Stage 1 GO；Stage 2 GO；`npm test` 843/843。
- 指纹：`profile-diff.js` 321/12285/`6DA204F6…3086`；`profile-preview.js` 409/16210/`20D28EDF…F3B3`；`profile-switch.js` 未改 299/12098/`B24C5838…5D0C`；`tests/core/profile-diff.test.js` 440/20356/`C6CF905A…4635`。
- 后续 carry-over：
  - P10：19 语言补 `profiles.preview.archiveChanged`（当前缺 key 回退显示 raw key）；把该 key 加入 i18n dynamic 检查，避免漏补无测试变红；归档 tag 复用 `.dsg-profile-preview-change-tag` 但当前是 danger 红，需用 `.dsg-profile-preview-change-tag[data-kind="archive"]` 改中性色。
  - P11：可补 preview tag 的 UI runtime 断言（P6 只有 core diff 测试；只读探针已验证渲染）。
  - P12：profile diff 文档说明 archived 已纳入 equality/changed。

### P4 — host 校验/提交守卫（GO）

- 状态：Stage 1 GO；Stage 2 GO；`npm test` 831/831。
- 指纹：`store.js` 576/21383/`2E7EA616…B7EE`；`respond.js` 291/9996/`77150778…32BD`；`routes.js` 633/25486/`191A29A1…8685`；`wire.js` 未改 174/7053/`83317793…ACC4`；`archive-guard.test.js` 447/16352/`F6BAE2F6…8603`；`store.test.js` 684/29775/`95836DBA…B0BE`；`routes.test.js` 1045/43492/`7D81C90E…8679`；`integration/host-routes.test.js` 368/15435/`FB72E137…C53F`；`profile-routes.test.js` 1141/47324/`479E2291…ECA2`。
- 授权域外：`tests/host/profile-routes.test.js` 3 处 “copied verbatim” 期望改为显式 `archived:false`（save 归一化直接结果）。
- 后续 carry-over：
  - P7：`src/host/tool.js` 的 `committed.errors.join(...)` 遇 `kind:'archive-frozen'` 会 TypeError，必须映射；control apply 的 archive 冲突目前仍 422 `operation-failed`，P7 按 N6 细分 409。
  - P9：`src/client/api.js` 的 `ERROR_DETAIL_FIELDS` 缺 `groupId/field`；409 body 无 `revision/doc`，客户端需重新 load；`message` 等于 reason，不要直接展示。
  - P1 域（可选）：`validateDoc` 对 `groups:[null]` 的既有 TypeError（base 已存在）可后续加 isObject 守卫；P4 未回归。
  - P12：ARCHITECTURE 记录 host 409 `reason:<op code>` 形状。
