# SPEC：窄侧栏 / 小屏 / 缩放下的浮层普适适配（0.4.0-beta.64）

> 批次：`feature/narrow-viewport-floaters`（默认从 `dev` 切出；`dev` 当前 `02c7d8f` = beta.62 归档合入，beta.63 仍在 `feature/first-run-guide`。见 §11.1）
> 状态：**v6 定稿**。第 5 轮独立定向复审 **GO**（2026-11-12，0 新阻断）；实现按本文件 §6 口径，勘误见 plan §0。
> 日期：2026-11-12
> 证据目录：`%TEMP%\dsg-narrow-probe\`（`probe-results.json`、`probe2b-results.json`、`probe4.mjs`+PNG、`probe5.mjs`+PNG、`probe6-results.json`；`probe3` 为失败探针——宿主 rail 形态下未进入分组视图，**不作为证据引用**）
> 实测基座：隔离 DSH web（`%TEMP%\dsh-sg-e2e-20261111-235935`，端口 4481，插件包 0.4.0-beta.62；其 `lib/client.js` 中相关 CSS 与 beta.63 源一致）

## 0. 一句话目标

让**所有浮层**（header 三个状态 popover、视图选项 popover、配置 popover、行右键菜单、拖拽标签、对话框）在**窄侧栏 / 小窗口 / 高 DPI（等效 CSS 视口更小）/ 短视口**下都满足同一组不变量：完整可见、可点、可读、可关闭；放不下就翻边、再不行就收缩，绝不被宿主裁剪或盖住。

## 1. 用户报告与问题陈述

用户同事在侧栏较窄时点了 header 的「暂停/等待介入」状态按钮，弹出的 popover 从左侧溢出并被遮挡，截图里只剩残缺的「…的会话」。用户要求：

1. 不要只修截图这一处，要**举一反三**；
2. 覆盖**小屏幕**与**调过缩放**（125% / 150% / 175%）的场景；
3. 适配要同时包含**样式**与**文字**；
4. 先做**全量分析**，不要直接改代码；
5. 允许起临时隔离实例在浏览器里实测。

可测陈述（按实测校正后的表述）：

- **F1（已实测，P0）**：状态 popover（`.dsg-running-popover`）左边缘越出宿主侧栏，被宿主 `overflow: hidden` 裁剪，首行文字被截断。**默认 420px 即已发生**，不是窄栏专属。
- **F1b（已实测，P0）**：短视口下同一族浮层**纵向**越界（视图选项 popover 在 1440×480 下底部超出 112px），机制同源：尺寸用常量/vh 百分比，没扣掉锚点已占空间。
- **F2（部分实测，P1）**：视图选项 popover 在 264px 实测 `12..226`，**当前未左溢**（"恰好塞下"）；风险来自长语种标签使内容变宽（`min-width:200px`、无 `max-width`）与短视口高度。**不写成"同样左溢出"**。
- **F3（代码推断，P1）**：配置 popover 在 LTR 为 `left:0`、RTL 被 CSS 改成 `right:0`，RTL 窄栏下会左溢；本轮无 RTL 实测，由 A4 验收。
- **F4（已实测，P1）**：行右键菜单虽 fixed + clamp，但只有平移：无宽度上限、无翻边。
- **F5（实测 + 代码推断，P1）**：`data-narrow` 取的是 `appliedWidth = clampSidebarWidth(偏好宽度, vw)`（`groups-view-width.js:26`）——**偏好宽度的视口夹取，不是宿主实际渲染宽度**；它只在 `maxSidebarWidth = floor(0.8×vw) ≤ 264`（即 `vw ≤ 331`）时为 `null`，`findLayoutNodes` 失败只把 `widthSupported` 置 false。因此宿主不托管宽度、或宿主自己夹到别的宽度时（同事真实 264、`appliedWidth` 仍 420），窄态不生效（**代码推断，待 A5 验收**）。另：固定阈值 320 造成 320→340「加宽反而更糟」的悬崖（**已实测**，§3.3.7 表）。
- **F6（已实测，P1）**：header 标题在 264px 只剩 4px、340px 只剩 7px（1 个字符残片）。
- **F7（已实测，P2）**：单行标签缺 `title`（省略后不可读）；菜单项 `height:30px` 固定、裸文本节点无 `min-width:0`，长标签会溢出/只裁不省略。

## 2. 现状盘点（全量浮层清单）

`src/client/css.js` 中 `position: fixed|absolute|sticky` 与 `z-index` 正则命中 **24 处（排除注释行；裸正则含注释为 25）**，按"是否为用户可交互浮层"分类：

| # | 表面 | 定位 | z-index | 尺寸策略 | 锚定 | 视口/裁剪防护 | 结论 |
|---|------|------|---------|----------|------|----------------|------|
| 1 | `.dsg-running-popover`（状态三兄弟） | absolute | 72 | `width:248px`（content-box，实测外宽 258） | wrapper，`right:0` | **无** | **P0** |
| 2 | `.dsg-view-options-popover` | absolute | 72 | `min-width:200px`，无 `max-width`；`max-height:min(70vh,420)` | 同上，`right:0` | 宽度靠内容恰好塞下；高度未扣 top | P0（高度/长语种） |
| 3 | `.dsg-profile-popover` | absolute | 72 | `min-width:220px`、`max-width:min(300px,100vw-24px)` | wrapper，`left:0`（RTL 改 `right:0`） | 宽度有上限；RTL 无防护 | P1（RTL 推断） |
| 4 | `.dsg-menu`（行菜单） | fixed | 70 | `min-width:160px`（content-box，实测外宽 174）、`max-height:60vh` | 指针点/行左缘 | JS 仅平移 | P1 |
| 5 | `.dsg-search-results` | absolute | 65 | `left/right:0` 跟随输入框 | 搜索输入框 | 宽度天然受限 | 回归 |
| 6 | `.dsg-dialog` + backdrop | fixed | 80 | `min(360px,100vw-32px)`、`max-height:85vh` | 居中/记忆矩形 | `clampDialogRect` | 回归 |
| 7 | `.dsg-toast` | fixed | 90 | `max-width:min(420px,100vw-24px)` | 底部居中 | 已有 | 回归 |
| 8 | `.dsg-floating-label` | fixed | 60 | 无 `max-width` | 常量 (24,120) + `translate(12px,10px)` | 无 | P2 |
| 9 | `.dsg-entry-hint`（注入 DOM） | fixed | 71 | 固定 `HINT_WIDTH` | workspace toggle | 已有 left/right clamp | 回归 |
| 10 | `.dsg-diag-hud` | fixed | max | `max-width:380px` | 右下 | 已有 | 回归 |
| 11 | `.dsg-resize-handle` | fixed | 30 | 6px | 侧栏边缘 | 天然 | 回归 |
| 12 | 装饰性 absolute（guide/drop 占位/状态点/滚动条/resizer） | absolute | 低 | — | 行内 | 不适用 | 回归 |

结论：浮层有**三套**互不一致的定位实现——(a) absolute + CSS 边（1/2/3），无视口防护；(b) fixed + 仅平移 clamp（4）；(c) fixed + 自绘 clamp（9，最完整）。本批次收敛为一套。

## 3. 根因

### 3.1 直接根因（代码）

```
.dsg-running-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;          /* 以 28px 触发器右缘为锚，向左长 */
  width: 248px;      /* 固定宽度，content-box → 外宽 258 */
}
```

- 触发器是 header 左侧 `.dsg-status-actions`（三个 26–28px 按钮），右缘距侧栏右边 150–200px；`right:0` 再减 258px，左缘必为负。
- 宿主的 `.MnhYfG_sidebarCol`（0..侧栏宽）与 `.bJOniG_regionArea`（8..侧栏宽）都是 `overflow:hidden`。absolute 子元素被裁 → 「溢出」变成「被遮挡」。**264px 时 left=−149，即 149px 在窗口外、另有 8px 被 regionArea 吃掉**。
- 无 flip / clamp / `max-width`；宽度越小越糟。DPI 无关（CSS px 语义不变），DPI 只是把等效视口变小。

### 3.2 实测证据：横向（决定性）

`.dsg-root` 实测 `left=12`，裁剪链（`elementFromPoint` 命中宿主 root 而非 popover）：

| 侧栏宽 | `.dsg-root` | blocked 按钮右缘 | popover 实测矩形 | 从 x=8 起可见 | 被裁 |
|---|---|---|---|---|---|
| 420（默认） | 12..420 | 217 | **left −41**, right 217, W 258 | 209 / 258 | **49px** |
| 360 | 12..360 | 157 | −101 .. 157 | 149 / 258 | 109px |
| 320（旧 narrow 边界） | 12..320 | 165 | −93 .. 165 | 157 / 258 | 101px |
| 300 | 12..300 | 145 | −113 .. 145 | 137 / 258 | 121px |
| 264（插件最小） | 12..264 | 109 | **−149 .. 109** | **101 / 258** | **157px** |

裁剪祖先链：

```
.bJOniG_regionArea   overflow: hidden   rect 8..264
.MnhYfG_sidebarCol   overflow: hidden   rect 0..264
.MnhYfG_frame        overflow: hidden   rect 0..1440
```

A/B 对照（同一 popover、同一左缘 8，只改 `position`）：

| | position | rect | x=265（侧栏右缘外）命中 | 结论 |
|---|---|---|---|---|
| 对照组 | absolute | 91..349 | `dsg-resize-handle`（被裁） | absolute 逃不出裁剪 |
| 实验组 | fixed（显式 left/top） | 8..266 | **`dsg-running-popover`（自身）** | fixed 可逃出裁剪 |

### 3.2.1 实测证据：纵向（短视口，同构缺陷）

1440×480（短视口；**不是**某个缩放比例的等效视口），侧栏 264，视图选项 popover：

- `rect = 12..226 × 242..592`（W 214 / H 350）；视口高 480 → **底部越界 112px**，底部内缩点 `elementFromPoint` 命中宿主 root；
- `max-height` 计算值 `336px`（`min(70vh,420)`）只限制自身高度，**没减去锚点已占的 242px 顶部空间**。

状态 popover 的 `max-height:320px` 同构：242+320=562 > 480。→ 高度必须按**剩余空间**算（§6.1 第 3 步）。

### 3.2.2 方案预演（同一实例，DOM-only，未改仓库）

264px 下按 §6.1 把状态 popover 临时改 `fixed` + 翻边 + 剩余高度：

- 触发器 83..109（bottom 236）→ popover `83..341 × 242..290`（旧 258 外框实测值；按 v4 的 248 外框重算约 `83..331`）；
- `insideViewport=true`；四角 `elementFromPoint` **全部命中自身**；
- 截图 `%TEMP%\dsg-narrow-probe\probe5-dryrun-flip-264.png`。

### 3.3 其它根因与缺口

1. **宽度语义（content-box）**：`width:248px` + `padding:4px` + `border:0.5px` = 外宽 258。**方案必须显式 `box-sizing:border-box` 并把设计宽度定义为外宽**，否则"把测到的 258 写回 `width`"会变成 268，下次测量再涨 10px（§6.4）。
2. **高度**：两个 header popover 都用 vh 百分比/固定 px 限高，没扣锚点已占空间（§3.2.1）。
3. **`data-narrow` 来源（实测 + 代码推断）**：`components.js:1024` 用 `appliedWidth !== null && appliedWidth <= 320`。`appliedWidth` 是 `clampSidebarWidth(偏好宽度, vw)`（`groups-view-width.js:26`），**不代表宿主实际渲染宽度**；它只在 `maxSidebarWidth ≤ 264`（`vw ≤ 331`）时为 `null`，`widthSupported=false`（宿主不托管）并不会把它置空。→ 窄态判断与实际布局脱节（代码推断）；另外固定阈值 320 造成 320→340 悬崖（实测）。"header 行是否横向溢出"**不能**当信号：实测七档 `scrollWidth === clientWidth`（flex 收缩，标题被压而不是行溢出）。
4. **RTL**：`.dsg-root[dir="rtl"] .dsg-profile-popover { left:auto; right:0 }` 把左锚改右锚，窄栏同样左溢；物理边锚定不适合 RTL。
5. **文字**：单行标签缺 `title`；菜单项是 30px 固定高 + 裸文本节点（无 `min-width:0`），长标签只裁不省略；`status.hint` / `about.scope` 靠无限换行占高（§6.3 改为高度上限 + 面板滚动，不隐藏）。
6. **菜单**：只平移；宽度无上限；`max-height:60vh` 在 400px 高窗口只有 240px，需与翻边同时验证。
7. **紧凑阈值悬崖**（实测 `.dsg-header-label` 可用宽度）：

| 侧栏 | 旧 narrow | root 宽 | label 宽 | 标题可用宽 | actions 宽 |
|------|-----------|---------|----------|-----------|-----------|
| 264 | true | 252 | **4px** | 30 | 200 |
| 280 | true | 268 | 20 | 46 | 200 |
| 300 | true | 288 | 40 | 66 | 200 |
| 320 | true | 308 | 56（完整） | 86 | 200 |
| 340 | **false** | 328 | **7px** | 35 | **271** |
| 360 | false | 348 | 27 | 55 | 271 |
| 420 | false | 408 | 56（完整） | 115 | 271 |

→ 320→340 一过阈值，narrow 关闭使 actions 从 200 涨到 271，标题反而从 56px 掉到 7px。**"header 行溢出"不是可用信号**（实测七档都不溢出），必须改用**可推导的宽度阈值**（§6.6）。

## 4. 触发矩阵

- 侧栏宽度：`264`（插件最小）、`280`、`300`、`320`（旧边界）、`340`（旧悬崖区）、`360`、`380`（新边界附近）、`420`（默认）、`0.8×vw`（最大）
- 视口：
  - 常规：`1280×800`、`1440×900`、`1960×1080`
  - **缩放等效**：`1152×720`（1440×900 @125%）、`960×600`（@150%）、`823×514`（@175%）
  - **短视口**（独立维度，不是缩放等效）：`1440×480`、`1280×400`
- 方向：`ltr`、`rtl`
- 表面：状态三兄弟、视图选项、配置 popover、行菜单、拖拽标签（仅 I1/I3）、对话框（回归）

**不变量 I1–I7**（其余浮层全适用；**拖拽标签只适用 I1/I3**——它 `pointer-events:none`，I2 命中测试在物理上不可执行）：

- I1（可见）：`S.rect` 完全落在 `visualViewport` 内，四边 ≥ 8px。
- I2（未被裁）：`S.rect` 四边内缩 3px 的四点，`elementFromPoint` 命中节点必须 `S.contains(node)`。
- I3（可读）：`S.scrollWidth <= S.clientWidth + 1`；单行标签 ellipsis 且带 `title`；多行文案可换行。
- I4（可关且回焦）：Escape / 外部 pointerdown 关闭；**关闭后焦点回到触发按钮**（header popover 现状没有回焦，属"补齐"而非"保持"）。
- I5（不跳动）：打开后两帧内 `S.rect` 不变（允许 `useLayoutEffect` 内一次校正）。
- I6（RTL 对称）：RTL 下 I1–I5 成立，锚定按 inline 方向镜像。
- I7（纵向剩余空间）：`S.bottom <= visualViewport.height - 8`；高度上限按剩余空间算（下方 `vh-pad-top`，上方 `anchor.top-gap-pad`）。

## 5. 设计目标与非目标

### 目标

1. 一套**纯函数几何策略** + 一套**客户端挂载器**，供全部浮层复用，替掉三套实现。
2. 定位模型：`position: fixed`（逃出宿主裁剪）+ 视口 clamp + **翻边** + **收缩** + 剩余高度上限。
3. **文字**：可截断单行统一 ellipsis + `title`；说明性文案允许换行，由剩余高度上限 + 面板滚动兜底，**不隐藏**；header 标题在容不下时**整段隐藏**（不留 1 字符残片）。
4. 紧凑样式由**可推导的实测宽度**驱动（不是"行溢出"这种失效信号），标题残片由 `.dsg-header-title` 的**可用宽**（扣 24px chevron 与 title 内 gap）驱动，绝不测量被隐藏的 label。
5. 测试：纯函数单测 + 客户端逻辑单测 + UI runtime 结构用例 + 隔离浏览器矩阵；覆盖率门禁不降。

### 非目标

- 不改宿主 rail（56px 折叠态）的交互；插件 rail 入口保持不变。
- 不重做对话框几何（`clampDialogRect` 已满足 I1，仅回归）。
- 不引入用户可配置浮层尺寸/位置设置；不改数据模型、存储键、host 路由、既有 `data-testid` 语义。
- 不改文案内容；不隐藏任何说明性文案（只换行 + 滚动/标题折叠）。
- 不新增 i18n key（若确需新增，按 `docs/I18N.md` 同步 19 语言）。

## 6. 方案

### 6.1 纯函数：`src/core/popover-position.js`（新）

```js
export const POPOVER_GAP = 6
export const POPOVER_VIEWPORT_PADDING = 8
export const POPOVER_MIN_USABLE_HEIGHT = 96

/**
 * @param {{
 *   anchor: {left, right, top, bottom},   // 触发器；点锚用 left/top + 零尺寸
 *   size: {width, height},                // **外框**尺寸（border-box 语义）
 *   viewport: {width, height},            // visualViewport ?? innerWidth/Height
 *   align?: 'inline-end' | 'inline-start',
 *   rtl?: boolean, gap?: number, padding?: number,
 *   maxWidth?: number, maxHeight?: number, flip?: boolean,
 * }} input
 * @returns {{ left, top, width, maxHeight,
 *   horizontal: 'inline-end'|'flipped'|'clamped',
 *   vertical: 'below'|'above'|'clamped' }}
 */
```

算法（顺序即优先级）：

1. `pad=8`、`gap=6`；`aw = max(0, vw - 2*pad)`；`width = min(size.width, maxWidth ?? aw, aw)`（**均为外框**）。
2. 水平：`align` 解析为物理边（`inline-end` → LTR 右 / RTL 左）。
   - 首选边对齐得 `candidate`；`candidate` 越界且 `flip` → 换对侧边；仍越界 → `clamp`。
   - `horizontal` 记录实际策略。
3. 垂直（**按剩余空间**）：
   - `topBelow = anchor.bottom + gap`；
   - `flip` 且 `topBelow + height > vh - pad` 且 `anchor.top - gap - height >= pad` → `top = anchor.top - gap - height`、`maxHeight = min(maxHeightDesign, anchor.top - gap - pad)`、`vertical='above'`；
   - 否则 `top = topBelow`、`maxHeight = min(maxHeightDesign, vh - pad - topBelow)`、`vertical='below'`；
   - 若下方剩余 `< 96` 且上方也放不下 → `top = pad`、`maxHeight = vh - 2*pad`、`vertical='clamped'`。
4. 高度不在函数内改写（实测后二次调用）；调用方写 `style.maxHeight`。
5. `NaN`/负数/零视口一律回退 `pad`（沿用现有 `finite()` 风格）。

`src/core/menu-position.js` 保留全部导出与返回形状（`{x,y}` / `{x,y,anchorX,anchorY}`），内部改为调用 `resolvePopoverRect`（点锚、`flip:false`、`maxWidth = vw - 2*pad`），使菜单获得 I1/I2/I7。

### 6.2 客户端挂载器：`src/client/floating-panel.js`（新）

- 导出纯决策函数（可被 node 单测直接覆盖，避免覆盖率盲区）：
  - `panelStyle(resolved)` → `{ left, top, width, maxHeight }` 的 CSS 字符串映射；
  - `shouldCollapseTitle(titleClientWidth, previous)` → 可用宽 = `titleClientWidth − 24 − (data-narrow ? 2 : 4)`；`< 42` 置位、`>= 50` 撤销、中间保持 `previous`（8px 滞回；测量源是 `.dsg-header-title`，不是被隐藏的 label，见 §6.6）；
  - `resolveNarrow(rootWidth, previous)` → 带 8px 滞回的窄态判定（见 §6.6）。
- `useFloatingPanel({ open, triggerRef, align, designWidth, designHeight, gap, flip })` → `{ ref, style, placement }`：
  - `useLayoutEffect`：打开时先用设计常量定位（避免首帧跳 0,0），再用真实外框重算（宽 → 高 → 位置），写 style；
  - **收敛写**：若新 `width` 与当前写入值差 < 1px 则不写（防逐次增长，见 §6.4）；
  - 监听 `window resize` + `ResizeObserver(trigger)`，视口变化**重排**（锚是按钮不是点，与菜单"滚动即关闭"并存）；
  - 视口来源：优先 `window.visualViewport`，否则 `innerWidth/innerHeight`；每次打开与 resize 重新取。
- 无障碍：`role`/`aria-expanded` 现状保持；`data-testid` 不变；additive 属性 `data-placement`。

### 6.3 文字（样式 + 文字）

1. 可截断单行统一 `min-width:0` + `overflow:hidden` + `text-overflow:ellipsis` + `white-space:nowrap`，并补 `title`：`.dsg-running-group-label`、`.dsg-running-item`、`.dsg-view-option-label`、`.dsg-profile-item-label`、`.dsg-icon-option`。
2. **菜单项**：把裸文本包一层 `<span class="dsg-menu-item-label">`（`min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`），按钮保持 30px 行高；长标签 ellipsis + 按钮 `title`。不换行（菜单高度可预测、可键盘遍历）。
3. **header 标题**：`data-title-collapsed`（§6.6）为真时 `.dsg-header-label { display:none }`，保留 profile chevron 与 `.dsg-header-title` 的 `title`/aria；不再出现 1 字符残片。**测量源必须是 `.dsg-header-title`（始终参与布局）**，不能量被隐藏的 label（否则 `clientWidth` 恒 0，形成自锁）。
4. **说明性长文案**（`status.hint`、`about.scope`）：允许换行 + `overflow-wrap:anywhere`；高度受 I7 上限约束，超出由面板 `overflow-y:auto` 滚动。**不隐藏**。
5. 断言：面板 `scrollWidth <= clientWidth + 1`（I3）。

### 6.4 CSS：盒模型与尺寸收敛（修 content-box 根因）

- 三个 header popover 与 `.dsg-menu` **显式加 `box-sizing: border-box`**（`.dsg-root` 上的 border-box 不会继承；宿主也没有全局 reset）。
- 设计宽度按**外框**定义：状态 `248`（原 248 content = 258 外框，改为 248 外框后内容区 238，窄 10px 可接受）；视图选项 `min-width:200`、`max-width:min(360px, calc(100vw - 16px))`；配置 `min-width:220`、`max-width:min(300px, calc(100vw - 16px))`；菜单 `min-width:160`、`max-width:min(360px, calc(100vw - 16px))`。
- 定位：`position: fixed; left:0; top:0;`（首帧瞬间由 JS 写到位）；`right/left` 的 CSS 边锚与 RTL 覆盖**全部删除**。
- 高度：`max-height: calc(100vh - 24px)` **仅作静态兜底**；真实上限由 JS 按 I7 写入（§6.1 第 3 步）。
- 面板滚动：`.dsg-running-popover`、`.dsg-view-options-popover`、`.dsg-profile-popover` 保留 `overflow-y:auto` + `overscroll-behavior:contain`。
- 拖拽标签：`box-sizing: border-box` + `max-width: min(280px, calc(100vw - 44px))`（扣除 `translate(12px,10px)` 与 8px 边距）+ ellipsis；JS 加 `left/top` clamp；**只适用 I1/I3，不作 I2**（`pointer-events:none` 无法命中）。

### 6.5 RTL

- 逻辑边在 JS 解析：状态/视图选项 = `inline-end`；配置 = `inline-start`。删除 `.dsg-root[dir="rtl"] .dsg-profile-popover` 的物理边覆盖；其余 RTL 覆盖（文本对齐、guide、rail）保持。

### 6.6 紧凑态与标题折叠（修 F5/§3.3.7）

- `data-narrow`：由**实测 `.dsg-root` 宽度**驱动，阈值为可推导常量
  `NARROW_ROOT_MAX = 16(header 左右 padding) + 271(实测 full actions) + 6(header-row gap) + 56(完整 label) + 4(title 内 gap) + 24(profile chevron) = 377`
  - 开：`rootWidth <= 377`；关：`rootWidth >= 385`（8px 滞回）。
  - 等价侧栏宽约 ≤389（root = 侧栏 − 12，probe6 七档一致）。它同时修掉 320→340 悬崖（340/360 进入窄态，标题恢复，见 §3.3.7 表）。
  - 首帧：沿用现有 `appliedWidth` 初始化避免闪跳，随后由 `ResizeObserver(root)` 收敛；**`appliedWidth` 只当首帧估计，不当真相源**（它是偏好宽度夹取，见 §3.3.3）。
  - **明确不用**"header 行 `scrollWidth > clientWidth`"当信号（实测七档均相等）；该结论写入代码注释。
- `data-title-collapsed`（**修自锁**）：测量源是**永不隐藏的 `.dsg-header-title`**，不是被折叠的 label：
  - `titleAvailable = title.clientWidth − 24(chevron) − 4(title 内 gap)`；
  - 判定：`titleAvailable < 42`（3 个 CJK 字宽 @14px）→ 置位并 `.dsg-header-label{display:none}`；`>= 50` 撤销（8px 滞回）。
  - 这样 `display:none` 不参与测量、不构成反馈环：264/280/300 命中（narrow 态 title gap=2，可用宽 4/20/40），320 起不命中（60+），340/360 在窄态生效后可用宽 80+ 也不命中；从 264 加宽到 420、或 420→340→420 都能正常恢复。
  - 首帧：`data-narrow` 先用 `appliedWidth − 12 <= 377`（等价侧栏 ≤389）初始化（340/360 首帧即为 true，不会先测到 7/27），再由 root 实测收敛；两个 flag 都**只由各自测量源驱动**，互不推导。
- `data-width`：写入实测 root 宽，便于测试断言与诊断。

## 7. 逐表面验收要求

| 表面 | 要求 |
|------|------|
| 状态 popover ×3 | I1–I7；窄栏**向右翻边**；高度按剩余空间；说明行不隐藏 |
| 视图选项 popover | I1–I7；宽度上限 `min(360px,100vw-16px)`；长语种标签 ellipsis+`title`；`about.scope` 换行 + 面板滚动 |
| 配置 popover | I1–I7；RTL 用逻辑边；长文案换行 |
| 行菜单 | I1–I4/I7；宽度上限 + 菜单项 label span + ellipsis + `title`；保留"滚动/resize 关闭"与焦点回归 |
| header 标题 | 264/280/300 隐藏 label（`data-title-collapsed`：按 title 可用宽 <42px 判定），chevron 与 `title` 保留；320 起恢复 |
| 拖拽标签 | 仅 I1/I3：`max-width` + `left/top` clamp + ellipsis；不作 I2 断言 |
| 对话框 / 搜索 / toast / 入口提示 | 回归，不改行为 |

## 8. 兼容性与风险

- **fixed 逃逸依赖无 transform/filter 祖先**：若宿主将来给 `.MnhYfG_frame` 加 `transform`，fixed 会被重新包含并再次被裁。**防御**：每次打开后做一次 I2 四角自检（4 次 `elementFromPoint`，开销可忽略）；失败则退化到"按宿主裁剪矩形 clamp"（宽度收进侧栏内），并记 `data-fallback="clip"`。
- **z-index**：fixed + 72 实测可盖住聊天区（A/B 命中自身）；72 低于 toast 90、对话框 backdrop 80，符合现状。回归断言：打开后中心点命中自身。
- **焦点**：现状 header popover 关闭**不回焦**（只有行菜单回焦）；本批次补齐（I4/A13）。
- **性能**：ResizeObserver 只在打开态挂；一次 layout 内完成测量；写 DOM style 不走 state。
- **测试 id**：不改既有 `data-testid`；新增 `data-placement` / `data-title-collapsed` / `data-width` / `data-fallback` 为 additive。
- **beta.63 未合入 dev**：见 §11.1。

## 9. 测试计划

1. `tests/core/popover-position.test.js`（新）：首选边 fit / 翻边 / 收缩 / 垂直翻上 / 上下都放不下 → clamp+收缩 / **maxHeight 必须扣 top** / box 装饰（padding+border 的外框语义，两次 resolve 收敛） / RTL 镜像 / 零尺寸与 NaN / `flip:false` 点锚。
2. `tests/client/menu-position.test.js`（改）：旧断言全过（形状不变）；新增宽度上限与"菜单外框 == 设定值"断言。
3. `tests/client/floating-panel.test.js`（新）：`panelStyle` / `shouldCollapseTitle` / `resolveNarrow`（含滞回与首帧兜底）纯函数覆盖——保证新增客户端模块在 `tests/**/*.test.js` 覆盖率统计内有真实执行行。
4. `tests/ui/ui-runtime.spec.mjs`（改）：三个 popover 面板组件、`title` 属性、`data-menu-item-label` span 结构；`uiModules` 数组与计数同步（24 → 25）。
5. `e2e/isolated.spec.mjs`（改）——**自动化的精确矩阵**（分三层；未列出的组合只做 §7 手工 spot check，见 A1）：

   **Tier A｜全表面（3 状态 + 视图选项 + 配置），断言 I1/I2/I3/I7**
   - 侧栏 264 × 视口 {1440×900, 1152×720, 823×514, 1440×480}
   - 侧栏 420 × 视口 {1440×900, 1152×720, 823×514}

   **Tier B｜状态 + 视图选项，断言 I1/I2/I3**
   - 侧栏 {320, 340, 380} × 视口 {1440×900, 1152×720}
   - 侧栏 264 × 视口 {1280×800, 960×600, 1280×400}
   - 侧栏 420 × 视口 {960×600, 1280×400}

   **Tier C｜行为回归（I4 回焦 + I5 两帧稳定）**
   - 侧栏 {264, 420} × 视口 1440×900

   **Tier D｜只断言 data-*（不截图、不开浮层）**
   - 侧栏 {280, 300, 360} × 视口 1440×900：断言 `data-narrow`（280/300/360 均为 true）与 `data-title-collapsed`（280/300 为 true、360 为 false）；先断言起始格 264 的 `data-title-collapsed=true`，再断言 264→420、420→340→420 两次 re-expand 后恢复为 false（避免"从未折叠→最终 false"的空转，修自锁的回归用例）。

   - **Tier A/B** 每格截图 `narrow-<w>-<vp>-<surface>.png`（Tier D 不截图）；I2 用四边内缩 3px 的 `elementFromPoint`；
   - 短视口档（1440×480、1280×400）额外断言 `bottom <= vh - 8`；
   - 断言 `data-narrow`：264/320/340/360/380 = true、420 = false；`data-title-collapsed`：264/280/300 = true、320 起 = false；
   - `dir=rtl` 子集（264 × 1440×900）断言 I6 + 截图。

   **宿主 rail 的处置（闭合 A1）**：隔离宿主在窄窗口（约 ≤960 CSS px）可能默认折叠成 56px rail（probe3 探针观察，非通过证据），该形态下分组视图**不存在 header 浮层**。规则：
   1. 每格开始前先尝试展开宿主侧栏（宿主自身展开控件/持久状态），成功则正常跑；
   2. 展开失败时该格记 `SKIP(host-rail)`，**只有列在测试文件顶部 `HOST_RAIL_ALLOWLIST` 里的格子键允许跳过**（初始值：`264×960×600`、`420×960×600`、`264×823×514`、`420×823×514`），并额外断言"该形态下不渲染 header 浮层或只渲染 rail 入口"；
   3. **"全绿" = 0 failure 且 skipped ⊆ allowlist**；出现 allowlist 之外的 SKIP 一律判失败；
   4. 若 allowlist 内四格全部 SKIP，结论必须写明"150% / 175% 缩放在隔离宿主上因 rail 形态不可达，侧栏浮层在该形态下不存在；该维度由 1152×720（125% 等效）与 1440×480/1280×400（短视口）覆盖"——不得写成"通过"。
6. A+ 手工/证据：`npm run test:isolated`、`npm run test:ui-browser`（新增列入）、`npm run test:all-locales`（长语种 ru/de 打开视图选项与配置 popover 的 spot check）、用户桌面验收（真实运行时由用户完成）。
7. 门禁：`npm test`、`npm run build`、`npm run check:lib`、`npm run check:ui`、`npm run check:coverage`、`npm run check:style`、`npm run check:release`。

## 10. 验收标准

- [ ] A1 §9.5 **Tier A/B/C/D 全绿**（0 failure，且 skipped ⊆ `HOST_RAIL_ALLOWLIST`）+ §7 手工 spot check（1960×1080、0.8×vw、ru/de 长语种、ar RTL 截图）；不再声称"§4 所有组合都自动化"；allowlist 内全 SKIP 时按 §9.5 第 4 条写清"不可达"而不是"通过"。
- [ ] A2 264px + 1440×900 打开"等待介入"popover：`left>=8`、四角命中自身、提示行首字完整；按 248 外框的预演值约 `83..331`（截图）。
- [ ] A3 420px（默认）同样成立（回归"默认宽度已被裁 49px"）。
- [ ] A4 ar/RTL 264px：三个 header popover 不被裁、`data-placement` 镜像正确（截图）。
- [ ] A5 `data-narrow` 由实测 root 宽驱动：264/320/340/360/380 为 true、420 为 false（阈值 377 / 滞回 385）；模拟宿主不可托管（root 252）时仍为 true。
- [ ] A6 `data-title-collapsed` 由 **title 可用宽 <42px** 驱动（不是 label `clientWidth`）：264/280/300 为 true（narrow 态可用宽 4/20/40），320 起为 false（60+）；340/360 在窄态生效后不命中；**264→420、420→340→420 两次 re-expand 后必须恢复为 false**（自锁回归）；隐藏 label 时 chevron 与 `title` 仍在。
- [ ] A7 菜单 264 / 800×600：宽度上限生效、长标签 ellipsis+`title`、I1 成立；滚动/resize 关闭 + 焦点回归不变。
- [ ] A8 既有测试与门禁全绿，覆盖率不低于 `92/80/85`；新增客户端模块有 node 单测覆盖。
- [ ] A9 无新增 i18n key；未隐藏任何说明性文案（header 标题整段隐藏不算说明文案）。
- [ ] A10 文档与版本：`docs/ARCHITECTURE.md`（浮层策略 + additive DOM 属性）、`docs/TEST-MATRIX.md`（矩阵与证据）、`docs/I18N.md`（文字规则）、`CHANGELOG.md`、`docs/release-notes/v0.4.0-beta.64.md`；**不改 frozen 的 `docs/CONTRACTS.md`**（如需解冻另开 Gate 1 决策）；版本五处一致（`package.json` / `dsh.plugin.json` / `src/shared/constants.js` / `package-lock.json` / 文档引用，`npm install --package-lock-only`）——**版本 bump 属开工动作，本轮只设计，未执行**。
- [ ] A11 短视口：1440×480 下视图选项/状态 popover `bottom <= 472`；1280×400 下 `bottom <= 392`；底部内缩点命中自身（回归实测 112px 越界）。
- [ ] A12 面板超出高度时内部滚动可见，且五处 popover 的外框宽 == CSS 设定外框（无 10px 逐次增长）。
- [ ] A13 header popover 关闭（Escape/外部点击/选项点击）后焦点回到触发按钮。

## 11. 待用户裁决 / 已裁决

1. **阶段（已裁决 2026-11-12）**：**当前只做设计，不建分支、不动版本、不改仓库**；spec 在 `%TEMP%` 推进，开工需另行放行。
2. **分支与版本（开工时才需要裁决；基线需在开工前重新确认）**：`dev` = `02c7d8f`（beta.62 归档合入）；`feature/first-run-guide` 在本设计期间继续前进到 `f1f6cec`（beta.63 后续提交，已跟踪 `origin/feature/first-run-guide`）；本设计**未**对该仓库做任何写操作。
   - (a) 先把 `feature/first-run-guide`（beta.63）合并进 `dev`，再从 `dev` 切 `feature/narrow-viewport-floaters`，消费 beta.64；**（默认，符合"每个批次从 dev 切"）**
   - (b) 直接从 `feature/first-run-guide` 切、之后再回落 `dev`——**违反仓库 AGENTS.md，需用户显式例外**。
3. **`data-narrow` 阈值（已定）**：§6.6 的 **377（root）/ ≈389（侧栏）**，8px 滞回。v3 的"回退 308"选项**删除**：它与 A5/A6 自相矛盾；且 340/360 在窄态下 title 可用宽 80+，不会再出现 7/27px 残片（那是未进窄态时的中间态）；真实取舍是"整段隐藏标题 vs 紧凑按钮"。

## 12. 自审

- 覆盖：用户四条要求逐条落点（举一反三 → §2/§6.7 逐表面；小屏+缩放 → §4 含 125/150/175% 等效视口与短视口；样式+文字 → §6.3/§6.4；先分析不改代码 → 仓库零改动）。四条均可判定。
- v3 对审核回执的处置（逐条）：
  1. **`data-narrow` 信号**：采纳。删除"header 行溢出"方案（实测七档 `scrollWidth === clientWidth`），改为可推导阈值（v3 写 368，v4 校正为 377）+ 8px 滞回 + 首帧 `appliedWidth − 12` 兜底；标题残片 v5 起改为由 `.dsg-header-title` 可用宽 <42 / ≥50 驱动（v3 的 label `clientWidth < 40` 已废弃，正是自锁成因）。§3.3.3/§3.3.7/§6.6/A5/§9.5 同步。
  2. **content-box**：采纳。三 popover + 菜单显式 `border-box`，设计宽度改外框（248/200/220），新增"两次 resolve 收敛"单测与 A12 外框断言；§6.1/§6.4/§9.1。
  3. **矩阵/可达性/覆盖率**：采纳。补 125/150/175% 等效视口与短视口；A1 改成"自动化矩阵（§9.5 精确列举）+ 手工 spot check"；拖拽标签移出 I2/A1 并补 `left/top` clamp 与 `max-width` 扣 transform；新增 `tests/client/floating-panel.test.js` 覆盖新模块；`test:ui-browser` 列入 §9.6。
  4. **正文矛盾**：采纳。§5 目标 3 改为"不隐藏、换行 + 滚动 + 标题折叠"；非目标同步；§3.3.5 改为"高度上限 + 面板滚动兜底"；§6.4 的 vh fallback 改为静态兜底并注明真实值由 JS 按剩余空间写。
  5. **CONTRACTS/bump/branch**：采纳。A10 不再改 frozen `docs/CONTRACTS.md`（additive 属性写 ARCHITECTURE）；补版本五处一致与 bump 步骤；§11.1 (b) 标注"需用户显式例外"，默认 (a)。
- 非阻断项也已顺手处理：F2 改为"当前恰好塞下、风险是长语种宽度与短视口高度"；F3 标注"代码推断，A4 验收"；证据清单去除 probe3 并注明其为失败探针；§3.2.1 改用"短视口"表述；§2 计数与源码一致（v4 校正为 24 行）；§3.1 删除"负左边缘不致命"的易误读句；I4 从"现状保持"改为"补齐回焦"。
- **v4 修正（第 2 轮复审：一路 GO / 一路 NO-GO 的 4 条阻断 + 5 条非阻断）**：
  1. **矩阵闭合**：§9.5 改为 Tier A/B/C 精确格子，补 `1152×720`（125%）与 `1280×400`；A1 改为"Tier 全绿 + skipped ⊆ `HOST_RAIL_ALLOWLIST`"；A11 补 400 高断言。
  2. **F5/§3.3.3 表述**：改为"`appliedWidth` 是偏好宽度的视口夹取，不是实际渲染宽度；只有 `vw ≤ 331`（`maxSidebarWidth ≤ 264`）才为 null"；"窄态判断与实际脱节"标为代码推断（待 A5），只有 320→340 悬崖与 label 宽度是实测。
  3. **§11.2 删除**：阈值固定 377（不是 368，补回 row gap 6 与 title 内 gap 4），8px 滞回；`data-title-collapsed` 与 `data-narrow` 解耦；A5/A6 数值随之更新（A6 由"320 起 false"改为"300 起 false"）。
  4. **拖拽标签范围**：§4 改为"其余浮层 I1–I7；拖拽标签仅 I1/I3"，并给标签补 `box-sizing: border-box`（消除 <340px 视口下 8px 右溢的理论风险）。
  5. 非阻断校正：264 行"被裁 161px"→**157px**；A2 预演值 `83..341`→**83..331**（248 外框）；§2 行数 25→**24**；§12 措辞精确为"说明性文案不隐藏；header 标题整段隐藏是唯一折叠"。
- **v5 修正（第 3 轮复审：3/4 已消除，残留矩阵缺口 + 新增自锁阻断）**：
  1. **矩阵闭合（补 Tier D）**：新增"只断言 data-*、不截图"的 Tier D（280/300/360 × 1440×900），承载 §9.5 与 A5/A6 里的 280/300/360 断言；`HOST_RAIL_ALLOWLIST` 改为**格子键**（`264|420 × 960×600|823×514`）；新增"allowlist 内全 SKIP 时必须写'不可达'而不是'通过'"。
  2. **`data-title-collapsed` 自锁修复**：测量源从"被 `display:none` 的 label `clientWidth`"改为**永不隐藏的 `.dsg-header-title` 可用宽**（`title.clientWidth − 24 − 4`），阈值 `< 42`（3 个 CJK 字宽）、撤销 `>= 50`（8px 滞回）；`display:none` 不参与测量，264↔420、420↔340 都能恢复。Tier D 增加两次 re-expand 回归；A6 明确测量源与边界（264/280/300 true、320+ false）。首帧 `data-narrow` 用 `appliedWidth <= 377` 初始化，避免 340/360 先测到 7/27 的闪跳。
  3. 非阻断校正：`vw ≤ 330` → **`vw ≤ 331`（`maxSidebarWidth ≤ 264`）**；`§3.3.6 表` → `§3.3.7 表`；probe3 引用标注"探针观察，非通过证据"；§2 计数写明"24 处（排除注释行；裸正则 25）"。
- **v6 修正（第 4 轮复审：两处目标修复已到位，唯一阻断是正文残留旧规则）**：
  1. **测量源传导**：§5 目标 4、§12.1、§11.3 三处"量 label / `clientWidth < 40` / 7/27px"旧句已全部改为"`.dsg-header-title` 可用宽 <42 / ≥50"，并注明 v3 的 label 方案已废弃（正是自锁成因）。
  2. **滞回可测**：§6.2 的 `shouldCollapseTitle(titleClientWidth, previous)` 增加 `previous` 参数，使 §9.3 的"含滞回"在 node 单测层可直接覆盖。
  3. **数值校正**：narrow 态下 `.dsg-header-title` 的 gap 是 2px（`css.js:136`），可用宽为 **4/20/40**（264/280/300）与 **60**（320），不是 2/18/38；340/360 窄态后为 80+。首帧初始化改为 `appliedWidth − 12 <= 377`（等价侧栏 ≤389），消除 378–389 的一帧误判。
  4. **Tier D**：先断言起始 264 为 `data-title-collapsed=true`，再测两次 re-expand，避免空转；`每格截图`限定为 Tier A/B。
- 矛盾检查：`data-compact` 概念已彻底移除；"隐藏文案"表述已无残留（§5/§6.3/§7/A9/A12 一致）；`data-narrow` 只由 root 宽驱动、`data-title-collapsed` 只由 title 可用宽驱动，两者不互相推导、也都不读取被隐藏元素；§11 的阈值选项已删除，A5/A6 与 §6.6 一致。
- 范围控制：不含宿主 rail 重做、侧栏最小宽下调、对话框几何重算；搜索/toast/入口提示/诊断 HUD 仅回归。
- 可执行性：§9 每条都能落到现有 harness（node test / ui runtime / e2e isolated / ui-browser）；§10 每条可自动化或截图判定。

## 13. 复审历史与放行条件

- **第 1 轮（v2）**：NO-GO，5 条 → v3 修复。
- **第 2 轮（v3）**：两路独立复审，一路 GO、一路 NO-GO（4 条）→ 取最严格，v4 修复。
- **第 3 轮（v4）**：NO-GO（3/4 已消除；残留矩阵缺口 + 新增 `data-title-collapsed` 自锁）→ **v5 修复**（Tier D、title 可用宽测量源、331 校正等）。
- **第 4 轮（v5）**：NO-GO —— 两处目标修复（Tier D、title 测量源）已到位，唯一阻断是**正文残留旧规则**（§5.4/§12.1/§11.3 仍写"量 label"）；另有 4 条非阻断（滞回参数、4/20/40 数值、首帧 12px 域偏、Tier D 起始断言）→ **v6 修复**。
- **第 5 轮（若用户追加）**：只核对 v6 的 5 处（§5.4/§12.1/§11.3 的测量源表述、§6.2 的 `previous` 参数、4/20/40、`appliedWidth − 12`、Tier D 起始断言），不重开全文。
- 若不再追加：本文件按 **v6** 作为**设计基线**放行（用户裁决），残余风险由 plan 阶段的独立审核 + 实现期的矩阵用例兜住。
- **本轮只设计**：不建分支、不改版本、不写仓库；plan 在放行后才落。


