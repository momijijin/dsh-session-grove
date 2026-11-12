# PLAN：窄侧栏 / 小屏 / 缩放下的浮层普适适配（0.4.0-beta.64）

> 输入：`2026-11-12-narrow-viewport-floaters.md` **v6**（第 5 轮独立复审 **GO**）
> 版本：**plan v2 定稿**。第 2 轮独立定向复审 **GO**（2026-11-12，0 新阻断；6 条非阻断见文末 §9）。
> 状态：**已开工**（2026-11-12）：分支 `feature/narrow-viewport-floaters`，P1–P8 已实现并各自双审通过；本文件为批次设计记录。
> 基线（2026-11-12 复核）：`dev = 146149e`（PR #9 已合并、package.json `0.4.0-beta.63`）。因此 spec §11 的 (a) 已满足：**从 `dev` 切 `feature/narrow-viewport-floaters`，消费 beta.64**。

## 0. 勘误与口径统一（不改已 GO 的 spec 文本）

| # | spec v6 处 | 实际口径 | 处理 |
|---|---|---|---|
| E1 | §9.4 写 `uiModules` 24→25 | 仓库在 beta.63 期间已是 **25**（`tests/ui/ui-runtime.spec.mjs:69`），新增 `floating-panel.js` 后应是 **25→26** | 本 plan 全部按 25→26 |
| E2 | §6.6 公式行写 `− 4(title 内 gap)` | 以 §6.2 的 `− (data-narrow ? 2 : 4)` 为准（`css.js:136` narrow 态 gap=2） | 实现/测试按 2/4 口径；264/280/300 = 4/20/40、320 = 60、340/360 窄态 = 80/100 |
| E3 | §6.2 的 `shouldCollapseTitle(titleClientWidth, previous)` | 实现加第三参 `narrow`（决定 gap 2/4），语义等价 | plan P3/P5 用三参；纯函数签名以此为准 |
| E4 | §9.5 的菜单断言 | Tier A/B/C/D 未单独列菜单格 | P8 增菜单格（264 × 800×600，A7） |

## 1. 范围

目标/不变量 I1–I7 与验收 A1–A13 见 spec §0/§4/§10；本 plan 只做拆分，不新增需求。每个实现步骤后必须过两道独立审（Stage 1 规格符合、Stage 2 代码质量）；真实运行时验收由用户完成。

## 2. 写域表（精确到 create / modify）

| 步骤 | create | modify |
|------|--------|--------|
| P1 核心解析器 | `src/core/popover-position.js`、`tests/core/popover-position.test.js` | — |
| P2 菜单收敛 | — | `src/core/menu-position.js`、`src/client/session-menu.js`、`src/client/css.js`、`tests/client/menu-position.test.js`、`tests/client/ui-layout.test.js` |
| P3 浮层挂载器 | `src/client/floating-panel.js`、`tests/client/floating-panel.test.js` | — |
| P4 三个 header popover 迁移 + I2 自检 | — | `src/client/components-header.js`、`src/client/profile-switcher.js`、`src/client/css.js`、`tests/client/ui-layout.test.js` |
| P5 紧凑态与标题折叠 | — | `src/client/components.js`、`src/client/css.js`、`tests/client/ui-layout.test.js` |
| P6 header popover 回焦（5 个触发器） | — | `src/client/components-header.js`、`src/client/profile-switcher.js` |
| P7 拖拽标签 clamp | — | `src/client/floating-label.js`、`src/client/css.js`、`tests/client/floating-label.test.js` |
| P8 浏览器矩阵 + UI runtime | — | `e2e/isolated.spec.mjs`、`tests/ui/ui-runtime.spec.mjs`、`tests/client/ui-layout.test.js` |
| P9 文档 | `docs/release-notes/v0.4.0-beta.64.md` | `docs/ARCHITECTURE.md`、`docs/TEST-MATRIX.md`、`docs/I18N.md`、`CHANGELOG.md` |
| P10 门禁 + 版本（用户批准后） | — | `package.json`、`dsh.plugin.json`、`src/shared/constants.js`、`package-lock.json`、`README.md`、`README.zh.md`、`docs/INDEX.md`、`docs/COMPATIBILITY.md`、`docs/TEST-RESULTS.md` |

**并行组表：本批无并行组。** 严格理由：`src/client/css.js` 被 P2/P4/P5/P7 共享、`components-header.js` 被 P4/P6 共享、`tests/client/ui-layout.test.js` 被 P2/P4/P5/P8 共享、`e2e/isolated.spec.mjs` 独占一份；并共享 `npm run build` → `lib/` 与隔离实例端口/home 两个全局句柄。P1/P3 写域虽不相交，但它们的下游（P2/P4）与其余步骤串行，拆并行无收益，故全部串行。

## 3. 测试与编译句柄（含真实约束）

| 句柄 | 可直接执行的命令 | 约束 |
|------|------------------|------|
| 单测 | `npm test` | `tests/**/*.test.js`；`tests/client/ui-layout.test.js` 会正则断言 CSS/组件源码，**每个改 CSS/组件的步骤都必须跑** |
| UI runtime | `npm run check:ui` | `uiModules` 25 → **26**（E1） |
| 覆盖率 | `npm run check:coverage` | 门禁 92/80/85；hook 行无 node 覆盖，靠纯函数覆盖 |
| 构建 | `npm run build` | **写仓库 `lib/`**；bump 版本后必须重跑才有新 stamp |
| lib 新鲜度 | `npm run check:lib` | 构建到 `tmpdir` 比对（**不写 `lib/`**）；仍串行执行 |
| 样式 | `npm run check:style` | — |
| 发布结构 | `npm run check:release` | 版本五处一致 + release note + `lib` 版本戳 |
| 打包 | `npm pack --pack-destination "$env:TEMP\dsh-grove-pack"` | pwsh 不展开 `%TEMP%`；先 `New-Item -ItemType Directory -Force` 目标目录 |
| 隔离 A+ | `scripts/qa/start-isolated-web.ps1 -Tarball <tgz> -Port 44xx` → 读该实例 `web.json` → `$env:DSH_TEST_URL` / `$env:DSH_TEST_HOME` → `npm run test:isolated` | 两个 e2e 脚本缺 env 会直接 fail；**单端口单 home**，与 `test:ui-browser` 串行 |
| 浏览器覆盖 | 同上 env → `npm run test:ui-browser` | 与 `test:isolated` 串行 |
| 语言门禁 | `npm run test:locale-pack` / `npm run test:all-locales` | 后者是 A1 的 ru/de 证据；需同样带 env 的隔离实例 + LocalePack 安装 |

## 4. 分步任务

### P1 核心解析器（纯函数，无 react 依赖）
- `src/core/popover-position.js`：`resolvePopoverRect({anchor, size, viewport, align, rtl, gap, padding, maxWidth, maxHeight, flip})`；`size` 是**外框**；`align` 逻辑边（RTL 镜像）；返回 `{left, top, width, maxHeight, horizontal, vertical}`；高度按剩余空间（下方 `vh-pad-topBelow`、上方 `anchor.top-gap-pad`、双失败 `vh-2pad`+`clamped`）；`NaN`/负/零视口回退 `pad`。另导出 `POPOVER_GAP/PADDING/MIN_USABLE_HEIGHT`。
- 测试：fit / 翻边 / 收缩 / 上翻 / 双失败 / RTL / 点锚 `flip:false` / 两次 resolve 收敛（外框宽不增长）/ `maxHeight` 扣 top。
- 退出：`npm test` 新文件全绿；`check:coverage` 不掉门禁。

### P2 菜单收敛（形状契约不变）
- **`src/core/menu-position.js` 保留自己的 x/y 平移夹取**（`clampMenuPosition` 实现与返回形状逐值不变，`tests/client/menu-position.test.js:10-14` 不改断言直接过）；新增 `menuBoxLimits(viewport)` 用 `resolvePopoverRect` 只计算 `{width, maxWidth, maxHeight}`（点锚、`flip:false`）。spec §6.1 的"内部委托"按此落地（位移夹取不委托）。
- `src/client/session-menu.js`：菜单根写 `maxWidth`；菜单项文本包 `<span class="dsg-menu-item-label">`，按钮带 `title`。
- `src/client/css.js`：`.dsg-menu` 加 `box-sizing:border-box`、`max-width:min(360px, calc(100vw - 16px))`；`.dsg-menu-item` 保持 30px 行高；新增 `.dsg-menu-item-label` ellipsis 规则。
- `tests/client/ui-layout.test.js`：`.dsg-menu {}` 块断言（L94/L102）随新增属性更新；新增 label span 结构断言。
- 退出：`npm test`、`npm run check:ui`、`npm run build` + `check:lib` 全绿。

### P3 浮层挂载器
- `src/client/floating-panel.js`：纯函数 `panelStyle(resolved)`、`shouldCollapseTitle(titleClientWidth, previous, narrow)`（可用宽 = `titleClientWidth − 24 − (narrow ? 2 : 4)`；`<42` 置位、`≥50` 撤销、中间保持）、`resolveNarrow(rootWidth, previous)`（`≤377` 开、`≥385` 关）、`viewportSize(win)`；hook `useFloatingPanel(...)`（`useLayoutEffect` 两段测量、收敛写、`resize` + `ResizeObserver(trigger)`、写 `data-placement`）。
- 测试：`tests/client/floating-panel.test.js` **先 `register(new URL('../support/react-loader.mjs', import.meta.url))`** 再动态 import（与 `tests/ui/ui-runtime.spec.mjs` 同法），覆盖 4 个纯函数（含 42/50、377/385 滞回、首帧 `appliedWidth−12` 兜底）。
- 退出：`npm test` 全绿。

### P4 三个 header popover 迁移 + I2 自检
- **5 个触发器**：`components-header.js` 的 3 个状态按钮 + 视图选项按钮；`profile-switcher.js` 的配置 chevron。全部改用 `useFloatingPanel`（状态/视图选项 `inline-end`，配置 `inline-start`；设计外框 248 / 200–360 / 220–300），根节点写 `data-placement`。
- **title 补全**（spec §6.3）：`.dsg-running-group-label`、`.dsg-running-item`、`.dsg-view-option-label`、`.dsg-profile-item-label`、`.dsg-icon-option`、菜单项。
- **I2 四角自检 + 回退**（spec §8）：定位后对四角 `elementFromPoint` 自检；失败则按宿主裁剪矩形 clamp 宽度并写 `data-fallback="clip"`（成功时该属性不存在）。
- `css.js`：三个 popover 改 `position:fixed; left:0; top:0; box-sizing:border-box`；`max-width:min(设计值, calc(100vw-16px))`；`max-height:calc(100vh-24px)` 仅静态兜底（真实值 JS 写）；保留 `overflow-y:auto`；**删除 RTL 物理边覆盖**。
- `tests/client/ui-layout.test.js`：L489/L725（`.dsg-view-options-popover` 的 `max-height:min(70vh,420px)`、`position:absolute`）、L1264-1271/L1301（profile popover 的 `left:0/right:auto/max-height:60vh` 与 RTL 覆盖）、L604（无变化但同块检查）同步更新。
- 退出：`npm test`（含 ui-layout）、`check:ui`、`npm run build`、`check:lib` 全绿。

### P5 紧凑态与标题折叠
- `components.js`：`ResizeObserver(root)` → `data-width`；`data-narrow` 由 `resolveNarrow` 驱动（首帧 `appliedWidth−12`）；`.dsg-header-title` 实测可用宽 → `data-title-collapsed`（`shouldCollapseTitle`，第三参 `narrow`）；仅 flag 变化时 `setState`。
- `css.js`：`[data-title-collapsed="true"] .dsg-header-label{display:none}`；`data-narrow` 既有紧凑规则保留。
- `tests/client/ui-layout.test.js`：L889 的 `'data-narrow': appliedWidth !== null && appliedWidth <= 320` 断言改写为新表达式；新增 `data-title-collapsed` 选择器断言。
- 退出：`npm test` + `check:ui` + `build` + `check:lib`。

### P6 header popover 回焦（5 个触发器）
- 状态 ×3、视图选项、配置 chevron 各持 ref；关闭（Escape / 外部 pointerdown / 选项点击 / 再次点击触发器）后 `focus({preventScroll:true})` 回触发按钮；不干扰 `session-menu.js` 的行回焦。
- 退出：`check:ui` 结构断言（ref/回调存在）+ P8 Tier C 行为断言。

### P7 拖拽标签 clamp
- `floating-label.js`：写 `left/top` 时按视口夹取（8px 内缩、扣 `translate(12px,10px)`）；`css.js` 加 `box-sizing:border-box`、`max-width:min(280px, calc(100vw - 44px))`、ellipsis。只适用 I1/I3（不做 I2）。
- 退出：`tests/client/floating-label.test.js` 新增 clamp 断言，既有用例全过。

### P8 浏览器矩阵 + UI runtime
- `e2e/isolated.spec.mjs` 新增/改写：
  - **Tier A**（全表面：3 状态 + 视图选项 + 配置；I1/I2/I3/I7）：264/420 × {1440×900, 1152×720, 823×514, 1440×480}。
  - **Tier B**（状态 + 视图选项）：{320,340,380} × {1440×900, 1152×720}；264/420 × {1280×800, 960×600, 1280×400}。**新增 flag 断言**：320/340/380 断言 `data-narrow=true`、`data-title-collapsed=false`。
  - **Tier C**（I4 回焦 + I5 两帧稳定 + A12 外框/滚动）：{264,420} × 1440×900；断言 5 个触发器的关闭回焦、打开两帧后 rect 不变、5 个 popover 外框宽 == 设计外框（248/≤360/≤300）、内容超长时 `scrollHeight > clientHeight` 且可滚动。
  - **Tier D**（只断言 data-*）：{280,300,360} × 1440×900；280/300 `data-title-collapsed=true`、360 false；280/300/360 `data-narrow=true`；先断言起始 264 collapsed=true，再 264→420、420→340→420 re-expand 恢复 false。
  - **RTL 子集**：264 × 1440×900，`dir=rtl`，断言 I6（`data-placement` 镜像）+ 四角命中 + 截图。
  - **菜单格**：264 × 800×600 右键行菜单，断言 I1/I2/I3 + 宽度上限 + 长标签 ellipsis。
  - **I2 自检**：正常路径断言 `data-fallback` 不存在；用页面注入 transform 的负例验证回退路径写 `clip`（可选，smoke 级）。
  - `HOST_RAIL_ALLOWLIST` = 4 个格子键；全绿 = 0 failure 且 skipped ⊆ allowlist；allowlist 全 skip 写"不可达"。
  - 截图仅 Tier A/B。
- `tests/ui/ui-runtime.spec.mjs`：`uiModules` 25 → **26**；三个 popover 的 `data-placement` 钩子、菜单 label span、`title` 存在性。
- 退出：`npm run test:isolated`、`npm run test:ui-browser`、`check:ui` 全绿。

### P9 文档
- `docs/ARCHITECTURE.md`（浮层策略 + additive 属性）、`docs/TEST-MATRIX.md`（矩阵 + rail allowlist 结论 + 语言证据）、`docs/I18N.md`（文字规则）、`CHANGELOG.md`、`docs/release-notes/v0.4.0-beta.64.md`；**不改 frozen 的 `docs/CONTRACTS.md`**。
- **A1 手工 spot check 清单**（写入 TEST-MATRIX 并执行留证）：1960×1080 × 264；`0.8×vw` 最大宽；ru/de 长语种打开视图选项与配置 popover；ar RTL 264 截图。
- 退出：`check:release`（版本项待 P10）。

### P10 门禁 + 版本（用户批准后）
- **顺序**：① 版本五处 bump（`package.json`/`dsh.plugin.json`/`src/shared/constants.js`/`package-lock.json`（`npm install --package-lock-only`）/文档版本引用：`README.md:18`、`README.zh.md:18`、`docs/INDEX.md:9`、`docs/COMPATIBILITY.md:27`、`docs/TEST-RESULTS.md:1,6`）→ ② `npm run build`（重生成 `lib/` 版本戳）→ ③ 下列门禁。
- 门禁顺序：`check:style` → `npm test` → `build`（已做）→ `check:lib` → `node --check lib/client.js` → `check:coverage` → `check:ui` → `check:release` → `npm pack --dry-run` → `test:isolated` → `test:ui-browser` → `test:locale-pack` → `test:all-locales`。
- 退出：全绿 + 用户桌面验收。

## 5. 验收映射（每个 A 项落到具体步骤与断言）

| spec | 落点（步骤 + 可判定断言） |
|---|---|
| A1 | P8 Tier A/B/C/D 全绿 + allowlist（0 failure、skipped ⊆ allowlist）+ P9 手工 spot check 清单 |
| A2 | P4 + P8 Tier A：264×1440×900 状态 popover `left>=8`、四角 `elementFromPoint` 命中自身、首字可见（截图） |
| A3 | P8 Tier A：420×1440×900 同上（回归默认宽被裁 49px） |
| A4 | P4 逻辑边 + P8 RTL 子集：264×1440×900 `dir=rtl`，`data-placement` 镜像 + 四角命中 + 截图 |
| A5 | P3 `resolveNarrow` 单测 + P5 接线 + P8 Tier B（320/340/380 true）+ Tier D（280/300/360 true）+ Tier A（420 false） |
| A6 | P3 `shouldCollapseTitle` 单测 + P5 + P8 Tier D（280/300 true、360 false、264 起始 true、两次 re-expand 恢复 false）+ Tier B（320/340/380 false） |
| A7 | P2 单测（宽度上限/形状不变）+ P8 菜单格（264×800×600：I1/I2/I3 + ellipsis + `title`） |
| A8 | P10 全门禁 + `check:coverage` |
| A9 | P4/P9 审阅项：无新增 i18n key、未隐藏说明文案（`status.hint`/`about.scope` 仍渲染） |
| A10 | P9 文档 + P10 版本五处/release note/`check:release` |
| A11 | P8 Tier A（1440×480 `bottom<=472`）+ Tier B（1280×400 `bottom<=392`） |
| A12 | P1 两次 resolve 收敛单测 + P8 Tier C（5 个 popover 外框宽 == 设计值；长内容 `scrollHeight>clientHeight` 可滚动） |
| A13 | P6 + P8 Tier C（5 个触发器关闭后 `document.activeElement === trigger`） |

## 6. 风险与回退

- **R1 视觉位移**：border-box 让 248 content-box（258）变 248 外框；420 默认宽下翻边后 popover 贴触发器左缘。预期，截图对照。
- **R2 紧凑态扩面**：`data-narrow` 320→377 使 320–380 进入紧凑按钮态。预期；回退需同步改 A5/A6（spec 已注明）。
- **R3 fixed 逃逸失效**：宿主未来加 transform 时会被包含；**P4 已实现** I2 四角自检 + `data-fallback="clip"` 退化（本批实现，不是遗留）。
- **R4 覆盖率**：hook 行无 node 覆盖；纯函数拆在 P3 且单测覆盖；P10 前检查，不足补纯函数测试。
- **R5 e2e 环境**：单端口/单 home；需要 `web.json` → env；宿主 rail 下允许 allowlist skip，但不得记 PASS。
- 回退粒度：每步一个 commit；P4/P5/P8 可单独 revert；`lib/` 由 build 重生。

## 7. 自审（写作者，逐条过检查单）

- **spec 覆盖**：I1–I7 均有步骤（I1/I2/I3 → P1/P2/P4/P5/P8；I4 → P6+P8 Tier C；I5 → P3 收敛写 + P8 Tier C 两帧；I6 → P4 逻辑边 + P8 RTL 子集；I7 → P1 高度公式 + P4 + P8 短视口档）。A1–A13 在 §5 每条都写了"步骤 + 断言"，不再是标签式映射。
- **可执行性**：写域表含 `tests/client/ui-layout.test.js`（P2/P4/P5/P8）；每个改 CSS/组件的步骤退出都跑 `npm test`（不只 check:ui）；`uiModules` 25→26（E1）；e2e 需 `web.json` → env；打包用 `$env:TEMP`；版本 bump 在 build 之前；语言门禁两条已列。
- **接口一致**：`resolvePopoverRect` 外框/逻辑边/剩余高度在 P1 定义、P2（只用于 box limits）/P3/P4 使用一致；`clampMenuPosition` 形状契约保持不变（P2 明确不委托位移夹取）；`shouldCollapseTitle(titleClientWidth, previous, narrow)` 与 P5 调用、E3 一致。
- **结构纪律**：并行组表写明"本批无并行组"及共享写域/句柄理由；未改 frozen `CONTRACTS.md`；版本五处 + release note + 具体文档版本引用已列。
- **占位检查**：无"看看情况/待定"；P4 的 I2 自检与回退已定为**本批实现**（不是遗留）。
- **已知偏差**：E1–E4 记录在 §0，实现按 plan 口径、不改已 GO 的 spec 文本。

## 8. 前置条件（不满足则不动仓库）

1. **用户放行开工**（当前"先设计，不要先开工"）。
2. **分支**：`dev = 146149e`（`.63` 已并入）；从 `dev` 切 `feature/narrow-viewport-floaters`；开工前重跑 `git log -1 dev` 确认。
3. **版本 bump 授权**：`.64` 五处一致 + `package-lock` 需用户批准。
4. **隔离实例与桌面验收**：`test:isolated`/`test:ui-browser`/`test:locale-pack`/`test:all-locales` 需现起临时实例（单端口/单 home）；最终桌面验收由用户完成。

## 9. 复审非阻断备注（第 2 轮 plan 审核记录；实现时顺手处理，不构成前置）

- **N1（flag 断言落点）**：A5 的"264=true / 420=false / 宿主不可托管 root 252 仍 true"补齐落点——Tier D 起始格加 data-narrow=true 与收尾 420 格加 data-narrow=false；root 252 由 P3 的 esolveNarrow(252, …) 单测覆盖，并在 §5 的 A5 行点名。
- **N2（A12 写法）**：外框宽断言统一为 ect.width === parseFloat(getComputedStyle(el).width)（精确等值才证明无 10px 增长）；248 用等值，视图选项/配置用上述等值式而非 <=360/<=300。
- **N3（P6 退出）**：P6 也改 components-header.js/profile-switcher.js，退出条件补 
pm test（与 §3 的规则一致）。
- **N4（menuBoxLimits 契约）**：menuBoxLimits 只返回 {width, maxHeight}；maxWidth 由调用方入参透传（等于 esolved.width 的来源），避免与 P1 的 esolvePopoverRect 返回形状混淆。spec §6.1"菜单内部委托"的偏离并入 §0 勘误：**E5 —— 位移夹取不委托，只有 box limits 委托**。
- **N5（P8 写域）**：P8 从写域表移除 	ests/client/ui-layout.test.js（P4/P5 已各自覆盖该文件的相应断言）；P8 只改 2e/isolated.spec.mjs 与 	ests/ui/ui-runtime.spec.mjs。
- **N6（title 清单归属）**：.dsg-icon-option 的 	itle 仓库已存在（dialog-host.js:610）、菜单项 title 属 P2 写域；P4 只做"验证/引用"，不重复实现。

**审核结论记录**：plan v2 = GO（第 2 轮，0 新阻断）；spec v6 = GO（第 5 轮，0 新阻断）。设计阶段完成；实现需用户放行。
