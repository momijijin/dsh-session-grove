# 0.4.0-beta.62 分组归档与子树冻结 SPEC

- 状态：draft，待独立审核
- 日期：2026-11-10
- 分支：`feature/group-archive`（从 `dev` 0a05c2f 切出）
- 基线：0.4.0-beta.61（main `ac16494`）
- 关联：`docs/ARCHITECTURE.md`、`docs/CONTRACTS.md`（frozen 历史契约）、`docs/I18N.md`、`docs/TEST-MATRIX.md`
- 范围：分组级归档字段、双三态可见性、归档子树结构锁、host 权威守卫、控制协议、UI/测试/文档；二维码资产瘦身只进入最终文档更新 Task，不在本 spec 的代码实现范围（见 §12）。

## 1. 目标与非目标

### 目标

1. 每个分组可持久化 `archived` 状态；旧文档缺失该字段时按 `false` 处理，不迁移、不报错。
2. 视图选项新增独立的“分组归档”三态；现有“会话归档”三态保持不变。
3. 归档分组的整棵递归子树被冻结：内容不可增减/换序，自身及递归子组的标题、图标、颜色不可变；归档开关本身始终可切。
4. 归档分组内的会话仍可重命名、切换自身归档状态、打开未归档会话；但不能拖拽、换序、换组、fork。
5. 交互遵循“合法性与可见性分离”：能用完整 doc 判定的操作按完整 doc 判定；不因当前视图剪枝而过度禁用；必然非法的操作可见但禁用并给出原因；合法但结果不可见的操作允许执行并给出显式反馈。
6. 由 host 在提交时做权威不变量校验，兜住旧客户端、裸 HTTP、第二窗口和控制 tool。

### 非目标

- 不批量修改会话或子分组的 `archived`；分组归档不是“把内部全部刷成归档”。
- 不冻结“单独归档、但不在归档分组内”的会话；它们保持现有行为。
- 不新增分组删除/归档级联；不自动清理 orphan。
- 不改变官方工作区视图的行为；官方视图无法感知分组锁。
- 不引入 `DOC_VERSION` 升级或迁移脚本。
- 二维码资产替换不在代码任务中提前执行；只在最终文档更新 Task 做（§12）。

## 2. 术语

- `ownArchived`：`group.archived === true`。
- `effectiveArchived`：`ownArchived || 任一祖先 effectiveArchived`；仅派生，不落盘。
- `full`：`only` 分组过滤下，effectiveArchived 为真的分组；整棵后代显示。
- `pathOnly`：`only` 下自身不归档、但有 effectiveArchived 后代的祖先分组；只显示组头和通往 full 的路径。
- `containerLock`：归档分组内会话的结构操作锁；与 `session.archived` 无关。
- `before-state`：一次提交开始前的已确认 doc 状态。
- `invisible result`：操作在 doc 上合法，但结果对象在当前分组/会话过滤下不渲染。

## 3. 数据模型

### 3.1 Group 字段

```ts
interface Group {
  id: string;
  name: string;
  icon: string;
  color?: GroupColor;
  colorHex?: string;
  parentId: string | null;
  sessionIds: string[];
  archived?: boolean; // 新增；缺失 = false
}
```

规则：

1. 读取/投影：`ownArchived = group.archived === true`；缺失、`false`、其他非 `true` 值都不视为归档（但持久化校验仍按 3.3 拒绝非法类型）。
2. 写入：host 在 `parseCommitBody`/`validateForWrite` 路径把每个 group 的 `archived` 归一化为显式 `true|false`；读取仍兼容缺失。
3. `DOC_VERSION` 保持 1；新字段 additive。
4. 分组归档按 profile 隔离：每个 profile 的 GroupDoc 各自持有 flag；不写 registry。

### 3.2 派生状态

- `effectiveArchived(doc, groupId)` 沿 `parentId` 上溯；防御 cycle（validateDoc 已禁止，仍用 seen 集合）。
- `archivedBy`：最近的 `ownArchived` 祖先 id；自身归档时为自身 id；没有则 null。
- `hasArchivedDescendant(doc, groupId)`：任一递归子组 effectiveArchived。
- 派生状态不持久化，不写入控制状态以外的存储。

### 3.3 校验与归一化

- `validateDoc` 新增错误 `group-archived:<id>`：字段存在且不是 boolean 时拒绝（沿用现有 invalid-file/quarantine 策略）。
- 缺失合法；`false` 合法。
- host 写盘保留 `archived`，与 `color` 一样可以被归一化；不得丢弃。
- `readBackupCandidate`/`readState`/`peekState` 接受缺失或 boolean。
- `cloneDoc`、备份恢复、profile save-as 原样保留字段。

### 3.4 旧客户端字段保留

- 入站 group 缺少 `archived` 时，host 在 `store.commit` 读取当前 doc 后、按 group id 继承该组当前的 `archived`；新组按 `false`。
- 显式 `true/false` 优先；这样旧客户端即使丢弃未知字段，也不会意外把归档组变成未归档。
- 该继承发生在当前 doc 读取之后、不变量校验之前；`parseCommitBody` 不做“无 current 的 false 归一化”。
- `save` 新建 profile 没有 current doc，缺失按 `false`；备份恢复路径按其内容原样。

### 3.5 profile diff

- `normalizeGroup` 增加 `archived: group?.archived === true`。
- `sameGroup` 比较该字段；`sameDocs` 在仅归档状态不同时必须返回 false。
- `diffDocs` 的 changed 增加 `archived` 标记；profile 切换预览显示归档状态变化。
- 缺失与 false 视为相同，避免误报。

## 4. 可见性

### 4.1 两个三态

- 会话归档：`hidden | all | only`；沿用现有 `archiveFilter` 与存储 key。
- 分组归档：新增 `groupArchiveFilter: hidden | all | only`；默认 `hidden`；存储 key `dsh-session-grove.archive.groups.v1`。
- 两者独立；分组过滤先决定渲染哪些分组，会话过滤只在“已渲染分组内部”生效。
- 隐藏子树内的会话三态不参与判定。

### 4.2 分组过滤算法

```text
visit(group, inherited):
  effective = inherited || group.archived === true
  hasArchivedBelow = any child (effective || hasArchivedBelow(child))

  hidden:
    effective ? prune : render normally
  all:
    render all
  only:
    effective ? full
    : hasArchivedBelow ? pathOnly
    : prune
```

- `full`：显示组本身和整棵后代；组内会话按会话三态过滤。
- `pathOnly`：只显示组头；子链只递归 full/path；**不显示自身会话、不显示其他非归档子组**。
- `only` 下无归档组时视图为空；提供“显示全部分组”动作。
- `hidden` 下非归档父组保留；其归档子组子树整棵剪掉；父组自身会话仍按会话三态显示。

### 4.3 会话三态

- 仅在 full 组、非归档可见组、ungrouped 中生效。
- 现有规则不变：subagent 排除；blank 仅当前例外；`hidden` 排除归档会话；`all` 显示并变暗；`only` 仅归档会话。
- 归档子树的会话即使自身 `archived=false`，在 `hidden` 下也整棵不显示（组级剪枝优先）。
- 归档分组内会话自身归档开关仍可切；切换只影响该会话在会话三态下的显隐，不改变组结构。

### 4.4 ungrouped 与计数

- `assigned` 集合必须从**完整 `doc.groups`** 计算，再剪枝；禁止从可见树反推，否则隐藏组会话会漏进 ungrouped。
- `stored/derived` 仍按现有规则，基于完整 assigned 排除。
- `visibleCount`：full = 自身可见会话 + 可见后代；pathOnly = 只统计 full 后代，自身会话为 0；hidden 不渲染。
- `emptyVisible`：full 空组仍渲染（locked 空态）；pathOnly 仍渲染组头。
- 分组计数不包含被剪枝内容。

### 4.5 搜索、状态计数、当前会话

- 搜索索引可继续包含全部非 subagent 会话，但结果渲染前按**分组可见性**过滤：
  - 不在 hidden 子树；
  - 不在 pathOnly 祖先的自身会话；
  - 在 full 组或普通可见组中。
- 可见组内已归档会话的现有搜索行为不变：可以列出，但选中时提示不可打开。
- 状态计数（running/blocked/unread）按分组可见性过滤；可见组内已归档会话的现有计数行为不变。
- 查询只命中隐藏内容时，显示“有结果在已归档分组中”+“显示已归档分组”动作；不自动切过滤器。
- 当前会话在隐藏组里时不高亮、不自动切过滤器；主界面照常打开。
- 语义明确：本次只新增“分组过滤”，不改变“会话三态是否参与搜索/计数”的既有行为。

### 4.6 空态与不可见结果

- 分组/会话过滤组合导致无可见内容时，显示过滤感知空态，并提供“显示已归档分组/显示全部分组”动作。
- `only` 无归档组：空态 + 切 `all`。
- 合法但结果不可见的操作（新建根组、pathOnly 祖先内新建/移动内容、归档后组消失、取消归档后组消失）：
  - 允许执行；
  - 完成后 toast：“已创建/已移动，当前过滤下不可见”+ 动作“切换到全部分组”；
  - 不自动改过滤器；切换后焦点落到目标（若可定位）。

## 5. 交互

### 5.1 四档策略

| 档位 | 判定 | 行为 |
|---|---|---|
| 总是合法 | 完整 doc + 不变量通过 | 正常可操作 |
| 条件合法 | 取决于目标/位置 | 保持可操作；预览与提交共用完整 doc 判定；真实冲突才 forbidden |
| 必然非法 | 当前状态下永远不成立 | 可见但 `aria-disabled` + 原因；拖拽类直接锁 |
| 合法但当前不可见 | doc 允许、过滤后不渲染 | 允许 + toast/动作 |

### 5.2 拖拽/放置

- slot 锚点只用稳定 id（`beforeGroupId`、`sessionId`、`targetId`）；位置解析一律对完整 doc 的 children 做，不用可见数组 index。
- 预览与提交共用一个纯函数 `evaluateDrop`，返回 `{ position }` 或 `{ violation, reason }`；不允许两套判定。
- 部分剪枝父组保留可见 slot；只在真实位移归档锚点时显示 forbidden 和原因（例如“会改变归档分组的同级顺序”）。
- 归档组 body 保留拒绝 handler，禁止事件冒泡到未归档父组；不渲染 placeholder。
- 归档组不触发 500ms 自动展开。
- 拖拽源在归档子树内：`draggable=false` + 锁定说明；不做“拖起来再失败”。
- 拖拽组自身归档、或包含归档后代：`draggable=false` + 原因。
- 会话拖入归档子树：显示 forbidden 状态与原因；不画 placeholder。
- 条件合法的边界放置（归档组前/后、隐藏子组周围）按完整 doc 判断：不位移归档锚点就允许。

### 5.3 菜单、按钮、选择器

- 菜单项不隐藏；必然非法时 `aria-disabled` + 原因，点击给 toast。
- 组头 `+`：归档组可见但禁用 + 原因；pathOnly 祖先可用（结果可能不可见 → toast）。
- 会话菜单保留“重命名/归档开关/复制 ID”；“上移/下移/移动到分组/fork”禁用 + 原因。
- 移动/删除/移动会话的目的地列表：归档目的地显示但禁用 + 原因，不静默排除。
- 来源组归档时，入口禁用；已打开对话框在 confirm 时按最新 doc 重校验。
- 唯一始终可用的组操作是“取消归档”（ownArchived 为真时）。

### 5.4 归档组内会话

| 操作 | 行为 |
|---|---|
| 打开/继续聊天（自身未归档） | 允许 |
| 重命名 | 允许 |
| 切换自身归档/取消归档 | 允许；运行中保留现有确认 |
| 复制 ID | 允许 |
| 右键/上下文菜单 | 允许 |
| 拖拽、换序、上移下移、移动到其他组 | 禁止；行锁 + 菜单禁用 + 原因 |
| fork | 禁止；菜单禁用 + 原因 |
| 会话行视觉 | `data-archived` 只表示自身归档；容器锁用 `data-structural-locked` |

### 5.5 归档动作

- 入口：分组菜单“归档分组/取消归档”；放在删除之前并带分隔。
- 确认：非空组或含运行中/当前会话时弹确认；空叶子组直接提交。确认文案说明：不修改会话归档、结构只读、当前过滤下可能隐藏。
- 提交：strict commit，先 flush optimistic 队列；失败 toast/刷新。
- 成功：toast；若组在当前过滤下不可见，带“查看已归档分组”动作；焦点回退到下一个可见行/header。
- 取消归档：同理；若在 `only` 下变为不可见，toast 说明。
- 不级联；不调用 `archiveSession`；不停止运行中的会话。

### 5.6 视觉与无障碍

- 分组容器/组头 `data-archived="true"`（effective）；`data-path-only="true"`；`data-contains-archived="true"`。
- 复用会话归档的 `.62` 变暗 token；只对最外层归档组应用一次，内部嵌套归档组/会话行重置 `opacity:1`，避免 `.62 × .62`。
- pathOnly 不变暗，加“含归档分组”的轻提示；会话行不因容器归档设置 `data-archived`。
- 组徽标/锁；`aria-label`/`aria-describedby` 说明“归档分组，结构只读”；pathOnly 说明“含归档子分组”。
- 禁用项可聚焦并读出原因；不要只靠颜色。
- RTL 下徽标/锁/禁用语序正确。

## 6. 冻结不变量与提交权威

### 6.1 指纹

对 `before` 中每个 `effectiveArchived` 组记录：

- id；
- `parentId`、同级 index（按完整 children 顺序）；
- `name/icon/color/colorHex`（归一化后）；
- `sessionIds` 顺序；
- 子组 id 顺序；
- 每个祖先的 `parentId`、同级 index（祖先元数据不比较）。

`after` 必须保持同一指纹；允许变化：该组自身的 `archived` flag、以及 before 未归档组的所有字段。

### 6.2 语义

- 提交前是归档的组：本笔提交除自身 `archived` 外不得有任何变化。
- `unarchive + 编辑` 必须拆成两笔提交（严格 before-state）。
- 从 before 未归档到 after 归档的“归档 + 编辑”允许（因为 before 未冻结）。
- 归档组不能被删除；含归档后代的组不能被移动/删除；删除目的地不能在归档子树内。
- 会话内容增减/换序、子组增减/换序、祖先移动/删除、兄弟插入导致的 index 位移都拒绝。
- 比较必须归一化：host 会补 `color`、`archived` 可能缺失；用 `groupColor()`、`colorHex` 归一化值、`archived === true` 比较，禁止原始字段直接比。

### 6.3 执行层

1. shared model 的 mutator 在生成 next doc 后调用不变量；失败抛结构化错误。
2. `applyControlOperations` 在多条操作全部应用后，用**原始 doc**做最终不变量校验；失败整批拒绝。
3. host 在 `store.commit` 的锁内，先按 §3.4 继承入站缺失的 `archived`，再做结构校验，最后调用同一不变量；失败返回 `kind:'archive-frozen'`。
4. `store.save()` 新建 profile 文档、`writeDoc(backup)` 恢复路径属于例外；文档说明。
5. `store.commit` 新增 kind 后，`commitResponse`、`tool.js`、控制 apply、客户端 optimistic/queue 的失败分支都要映射。

### 6.4 错误码

- `group-archived`：目标组/子树冻结；
- `group-contains-archived`：祖先/子树含归档后代；
- `group-destination-archived`：目的地冻结；
- `group-position-locked`：间接锚点位移；
- `archive-frozen`：整笔提交违反不变量（host）。
- 返回 `groupId`、`field`、`operationIndex`；客户端 toast/对话框 inline 本地化；host 用 409，不 bump revision。

## 7. 控制协议

- 新增 `group.archive { groupId: string, archived: boolean }`；独立于 `group.update`（后者仍只做 icon/color/colorHex）。
- `state.groups[]` 增加 `archived`（own）、`effectiveArchived`、`archivedBy`；不暴露 `pathOnly`（视图态）。
- 守卫：
  - `group.create` 父组 effective archived 拒绝；索引导致归档锚点位移拒绝；
  - `group.rename/update/move/delete` 目标 effective archived 拒绝；
  - `group.move/delete` 源含归档后代拒绝；目的地归档拒绝；
  - `session.assign` 源/目标归档拒绝；
  - `group.archive` 始终允许（自身 flag），不级联。
- 批量语义：顺序执行；archive/unarchive 尽量单独成批；`[rename, archive]` 允许，`[archive, rename]` 因第二步目标已归档被拒；`[unarchive, 编辑]` 被最终事务不变量拒绝。
- `CONTROL_OPERATIONS`、catalog、skill、CLI 文档同步。

## 8. 自动路径与跨视图

- `createSessionInGroup`：先查目标组；拒绝时不先创建 host 会话；竞态导致 commit 失败则新会话留在 ungrouped，清 pending。
- `reconcileNewSessionGroup`：目标组已归档时取消 pending，不 assign，不留下半移动 blank。
- `forkSession`：源会话所在组已归档则直接拒绝；host fork 成功后 placement 失败则子会话留在 ungrouped，toast 说明。
- 拖拽/对话框打开后被归档：commit 按最新 doc 守卫；`archive-frozen` inline/toast + 刷新 doc；清旧 drag/drop 状态。
- 归档动作 strict commit，先 flush；不做乐观隐藏。
- profile 切换：现有 epoch reset 清 dialog/drag/pending；归档集随 profile doc 变化，无额外逻辑。
- 官方工作区视图：改名/切换会话归档/删除会话/移动 workspace 都允许；不写 GroupDoc；orphan/blank 消失保留 id，冻结子树内不自动清理。
- 控制 tool/CLI 的会话改名/归档切换允许；结构操作走 group 守卫。

## 9. 兼容性

- `docs/CONTRACTS.md` §1 invariant 5 的 “Doc stores no … archive flags” 原意是会话归档 flag 由 host 持有；本次新增分组级 `archived` 是 additive contract extension，不修改 frozen 历史文件，由本 spec/后续 ADR 记录。
- 旧客户端 + 新 host：旧客户端忽略字段；host 按 §3.4 继承缺失字段，守卫拒绝结构修改；旧客户端可能显示泛化错误，属于可接受降级。
- 新客户端 + 旧 host：旧 host 忽略字段、无守卫；客户端 mutator 守卫仍生效；字段通常随整份 doc 保留。
- 混合窗口：host 守卫兜底。
- `DOC_VERSION` 保持 1；不因新字段拒绝旧文档；无迁移。
- 备份恢复可能回到归档前状态（恢复路径例外），文档说明。
- profile save-as 复制 flag；profile 预览必须显示归档差异。

## 10. UI / i18n

- 视图选项 popover 两段：会话语义沿用现有 key；分组新增独立 key（不能复用 “All conversations” 文案）。
- 选择一项后保持 popover 展开，便于连续设置两段；外部点击/Escape/再点按钮关闭。需要更新现有“选择后关闭”测试。
- 旧 testid 保留；新增分组三态 testid（建议 `session-groups-group-archive-filter`）；按钮 `data-filter` 保留会话值，新增 `data-group-filter`。
- 菜单/按钮禁用态：`aria-disabled` + `title`/说明；点击给 toast；不静默。
- 会话行新增 `data-structural-locked`；不设置容器级 `data-archived`。
- 空态、toast 动作、焦点回退、RTL、19 语言资源与 parity 测试。
- 视觉验收：归档组与会话归档的变暗程度一致；pathOnly 不变暗；无双重变暗；对比度可读。

## 11. 性能

- `effectiveArchived`/`hasArchivedDescendant` 每棵渲染树只算一次，向下传递。
- 搜索/状态共用同一组可见性集合，避免三套判定漂移。
- 拖拽预览用定向锚点检查，不每次 dragover 克隆整份 doc；drop 提交时跑完整不变量。
- `SessionRow` memo 纳入 `structuralLocked/groupArchived`，避免归档后行不重绘。
- 不变量比较在写入路径执行，文档规模小，允许 O(n·depth)。

## 12. 测试、验收、发布

### 12.1 基线

- 当前 `.61` 基线：726/726 unit/contract tests；39/39 UI runtime cases；1 browser spec；331 locale keys。
- 新增测试后更新 `docs/TEST-MATRIX.md` 的计数与真实运行时证据。

### 12.2 必测矩阵

- 单元：effective/archivedBy；hidden/all/only；pathOnly；会话三态；assigned 全量计算（隐藏组不泄漏 ungrouped）；计数；空态。
- 交互：部分剪枝父组的 slot 锚点（完整 `[B,A,C]` / `[B,A]` / `[A,B]` 等）；预览=提交；归档组 body forbidden 且不冒泡；目的地禁用项；pathOnly 不可见结果 toast；菜单禁用原因。
- 不变量：兄弟插入/删除、祖先移动/删除、删除目的地、会话换序、子组换序、`unarchive+编辑`、`archive+编辑`、归一化误报。
- host：validate/normalize/commit guard、409 形状、旧客户端整份提交、备份路径例外。
- 控制：state 字段、group.archive、错误码、批量语义、幂等。
- profile：diff/equality 归档差异；切换预览。
- UI/e2e：双三态；hidden 子树不存在；only path；归档样式；会话改名/归档可用；拖拽/fork 禁用；搜索/计数不泄漏；焦点/toast；e2e“3 行”断言更新；19 语言 + RTL。
- 手工：真实 DSH 桌面验收；A+ `test:isolated`/`test:ui-browser`/all-locales 记录。

### 12.3 二维码资产瘦身（最终文档更新 Task，禁止提前执行）

- 新图：`C:\Users\Momiji\AppData\Local\Temp\qr-candidates\qr-480.jpg`，480×855，JPEG q82，40,272 bytes，sha256 `A08F494F63D869389C1B70C31EEEBBF4426CC413E4587CCC4F6CF0083B8D003A`；用户已实测可扫（QQ 群 1128514213）。
- 旧图：`assets/qrcode_1794236242994.jpg`，实际 PNG（magic 89 50 4E 47）硬命名 `.jpg`，1284×2286，611,364 bytes。
- 目标：新图复制为 `assets/qrcode-qq-group.jpg`（真 JPEG）；旧资产删除（仓库规则：回收站方式，不允许直接 rm）。
- 引用更新：`README.md`、`README.zh.md` 的图片路径；`package.json` `files` 数组中的 `assets/qrcode_1794236242994.jpg` → `assets/qrcode-qq-group.jpg`。
- 版本/文档：0.4.0-beta.62 五处一致；`docs/release-notes/v0.4.0-beta.62.md` 说明 assets only（1284×2286 PNG 611 KB → 480×855 JPEG 40 KB，无代码/API/存储变化）；CHANGELOG 条目；TEST-MATRIX 状态。
- 验证：`npm run check:style && npm test && npm run build && npm run check:lib && node --check lib/client.js && npm run check:coverage && npm run check:ui && npm run check:release && npm pack --dry-run`；期望 files 233、tgz 约 705 KB（从 1,275,645 bytes 降约 55%）。
- 不触碰已发布的 `v0.4.0-beta.61` tag/release；不提前在本功能实现任务中执行。

## 13. 发布流程

- 62 批次从 `dev` 切 `feature/group-archive`；完成后按项目规则 `--no-ff` 合回 `dev`、打 `archive/feature/group-archive`、删本地分支。
- 版本 0.4.0-beta.62 五处一致；CHANGELOG、release note、TEST-MATRIX、ARCHITECTURE、I18N、skill/CLI 文档同步。
- 合并/推送/tag 必须用户明示；不在本 spec 中自动执行。
- 二维码任务只在最终文档更新 Task 执行，且与功能实现分开提交。

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| 隐藏组会话漏进 ungrouped | assigned 从完整 doc 计算，专项测试 |
| host 归一化导致不变量误报 | 归一化比较 color/colorHex/archived |
| 树/搜索/状态三套可见性漂移 | 共用 `computeGroupVisibility` |
| memo 行不重绘 | node 增加 structuralLocked，比较器纳入 |
| 归档组双重变暗 | 只对最外层 dim，内部重置 opacity |
| 事件冒泡到父组 | 归档组保留拒绝 handler |
| 预览允许、提交失败 | 预览/提交共用 `evaluateDrop` |
| 旧客户端绕过 | host commit 守卫 |
| pathOnly 创建不可见内容 | 允许 + toast 动作 |
| 焦点丢失 | 归档/过滤切换后焦点回退 |
| 测试/i18n 破坏 | 同步 e2e 3 行断言、19 语言、TEST-MATRIX |
| 过度限制祖先移动 | 严格锚点；祖先元数据仍可改 |

## 15. 验收清单

- [ ] `archived` 缺失=false；非法类型拒绝；host 写入显式 boolean；DOC_VERSION=1。
- [ ] 分组三态 hidden/all/only 与 pathOnly 符合 §4。
- [ ] hidden 子树整棵不渲染；会话三态不复活隐藏内容。
- [ ] 搜索/状态严格按分组可见性；显式“显示已归档分组”；当前会话不自动切过滤。
- [ ] 归归档组内会话可改名/切归档/打开；不可拖拽/换序/换组/fork。
- [ ] 归档组/祖先/目的地守卫完整；不变量 before-state；unarchive+编辑拆两笔。
- [ ] host commit 409 archive-frozen；旧客户端整份提交被拒。
- [ ] 部分剪枝 slot 按完整 doc 解析；预览=提交；无事件冒泡。
- [ ] 菜单/选择器显示禁用+原因；合法但不可见有 toast 动作。
- [ ] 双三态 UI、旧 testid 保留、新 testid、持久化、19 语言、RTL。
- [ ] 726 基线 + 新增测试全绿；A+ 手工证据；TEST-MATRIX/CHANGELOG/ARCHITECTURE/I18N 更新。
- [ ] 二维码资产瘦身只在最终文档更新 Task 执行，版本/引用/体积/回收站删除符合 §12.3。

## 自审

- 占位符：无 TBD/TODO；二维码路径/哈希/体积为实测值。
- 内部一致性：§4 的 pathOnly 不可见与 §5.5/§4.6 的“允许 + toast”一致；§6 before-state 与 §7 批量语义一致；§3 显式 boolean 与 §6 归一化比较一致。
- 范围：本 spec 只覆盖分组归档功能与二维码最终文档 Task；不包含具体 React 组件拆分、CSS 像素值、locale 键名清单——这些由 plan 落。
- 歧义修正：明确 `assigned` 必须从完整 doc 计算；明确隐藏子树不参与会话三态；明确 pathOnly 自身会话不渲染；明确菜单/选择器“可见禁用”而不是隐藏；明确 `unarchive+编辑` 拆两笔；明确 host 归一化误报与比较方式；明确归档组事件不冒泡父组。
- 遗漏补入：补充了搜索/状态口径、current session、focus、perf、备份例外、控制批量顺序、e2e 3 行断言、二维码最终文档 Task。
- 兼容补入：旧客户端缺失 `archived` 时 host 从 current doc 继承，避免隐式取消归档；CONTRACTS 的 “Doc stores no … archive flags” 明确为会话 flag，分组 flag 属于 additive extension。
- 仍需 plan 决定：具体模块拆分/新增文件、CSS token 实现、locale key 命名、测试文件组织、host guard 在 store.commit 的具体 API 形状。
