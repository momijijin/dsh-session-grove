# 0.4.0-beta.65 本地测试结果（当前轮）

> `docs/TEST-MATRIX.md` 仍是当前可重复验证状态、语言覆盖与测试缺口的**真相源**；本文件记录 2026-11-13 本地候选树的实际执行结果，并保留 `0.4.0-beta.63` 历史轮与 `0.4.0-beta.13` 历史快照（见文末）。`.65` 是未发布的 dev 批次（未 tag、未发布）；最新已发布仍为 `0.4.0-beta.64`（2026-11-12）。

日期：2026-11-13  
版本：`0.4.0-beta.65`（dev，未发布；最新已发布 `0.4.0-beta.64`，2026-11-12）  
宿主基线：`@deepseek-ai/dsh` 0.2.1-rc.2（community）/ 0.2.2-rc.1（official，`.61` A+ 证据；0.2.1-rc.5 为 `.60` 历史）  
变更范围：对话框键盘时序修复（焦点守卫 + rect 兜底 + e2e 定位/焦点断言）+ 架构债清理（plugin-host / dialog-host 拆分、host 原子写/文件锁去重、sessionContainer / registry 分类器 / MAX_PROFILES 去重、import-cycle 守卫）；无公开 API/存储/locale/UX 契约变更

## 本轮自动门禁（2026-11-13，本地 Windows）

- `npm run check:style`：**PASS**（227 files）
- `npm test`：**1027/1027 PASS**（0 failed / 0 skipped）
- `npm run build`：**PASS**（`lib/client.js` 实际 662,098 bytes；构建日志打印的 654,255 是字符数；17 个 lazy locale chunks 497,865 bytes；版本戳 `0.4.0-beta.65`）
- `npm run check:lib`：**PASS**
- `node --check lib/client.js`：**PASS**
- `npm run check:coverage`：**PASS**，all files **94.81% lines / 86.81% branches / 91.44% functions**（门禁 92/80/85；同批运行在 94.68–94.84 / 86.79–86.87 / 91.44–91.55 波动，最终门禁轮为 94.81 / 86.81 / 91.44）
- `npm run check:ui`：**45/45 PASS**（1 module-load + 44 component tests，覆盖 19 components / 28 client modules）
- `npm run check:release`：**PASS**（`check:release` 校验四个机器源版本一致：`package.json` / `dsh.plugin.json` / `src/shared/constants.js` / `package-lock.json`；文档中的版本引用是人工同步，不由该门禁校验。`.65` release note 存在、bundle 版本戳、`package.json.files` 路径 25/25 存在）
- `npm pack --dry-run`：**PASS**，**246 files**，package **835.8 kB**，unpacked **3.2 MB**（dry-run 不修改仓库）
- 验收 tarball：`dsh-session-grove-0.4.0-beta.65.tgz`，**835,756 bytes**，sha256 `AE0DE4AC115B0E39FD9ADBFDDA89A0BFCB211DAF9D5E116972226331F190B766`，位于系统临时目录 `%TEMP%\dsh-grove-pack\`（不进仓库；包内 docs 与打包时 HEAD 逐文件一致）
- locale：**397 keys × 19 dictionaries** 不变（本批无 locale 资源改动）

## 真实宿主证据（`.65`，2026-11-13，agent debug run at the user's explicit request）

用户 2026-11-13 明确要求“这次你先跑”，因此本轮 fresh-host e2e 由 **agent** 执行，**不是**用户桌面验收。被测包为上面的 `dsh-session-grove-0.4.0-beta.65.tgz`（**835,756 bytes**，sha256 `AE0DE4AC115B0E39FD9ADBFDDA89A0BFCB211DAF9D5E116972226331F190B766`，`%TEMP%\dsh-grove-pack\`，仓库外）。

- `npm run test:isolated`：**PASS**（exit 0），fresh home `<temp>\dsh-sg-e2e-20261113-024652`；**30 pass / 0 skip / 0 failure**，**71 screenshots**；preview geometry dialog **560×560**、narrow sidebar **252**、body scroll **3659>466**、row gaps **[0,0,0]**；之前失败的 dialog keyboard 段通过。
- `npm run test:ui-browser`：**PASS（第 2 次）**（exit 0），fresh home `<temp>\dsh-sg-e2e-20261113-025209`；`bundleEntries 1`、`executedBytes 2,572,166 = sourceBytes`、`executedRatio 1`、`pageErrors []`。第 1 次在 `session-groups-view` 可见性等待超时：宿主 “Get started” 对话框在脚本 3.5s overlay 探测之后才挂载并挡住视图——测试脚本时序竞态，不是插件问题；重试 PASS。`e2e/ui-runtime.spec.mjs` 的 `dismissOverlays` 后续可加固（本批未改）。
- 无 locale sweep：397 keys × 19 dictionaries 未变；official A+ O 未跑、不声称（最新 official 证据仍是 `.61`）。

## 0.4.0-beta.63 历史轮（2026-11-12，已发布）

版本：`0.4.0-beta.63`（已发布，2026-11-12；上一发布为 `0.4.0-beta.62`，2026-11-11）  
变更范围：首次引导漏斗（入口一次性提示 + 动作化说明卡）+ 4 处就地提示 + 三处文档站点入口（入口提示 / 说明卡 / 设置页）+ README 瘦身为入口页（长文迁移到文档站点）+ 移除 QQ 群图片 + 19 语言 397 keys；无文档 schema 变更

### 本轮自动门禁（2026-11-12，本地 Windows）

- `npm run check:style`：**PASS**（217 files）
- `npm test`：**914/914 PASS**（0 failed / 0 skipped）
- `npm run build`：**PASS**（`lib/client.js` 实际 642,180 bytes；构建日志打印的 634,341 是字符数；17 个 lazy locale chunks 497,865 bytes；版本戳 `0.4.0-beta.63`）
- `npm run check:lib`：**PASS**
- `node --check lib/client.js`：**PASS**
- `npm run check:coverage`：**PASS**，all files **95.20% lines / 86.02% branches / 91.31% functions**（门禁 92/80/85）
- `npm run check:ui`：**42/42 PASS**（1 module-load + 41 component tests，覆盖 19 components / 25 client modules）
- `npm run check:release`：**PASS**（五处版本一致、release note 存在、bundle 版本戳、`package.json.files` 路径 25/25 存在）
- `npm pack --dry-run`：**PASS**，**238 files**，package **797.7 kB**，unpacked **3.1 MB**（tarball `dsh-session-grove-0.4.0-beta.63.tgz`；QQ 群图片已移出插件仓并同步移出 `package.json.files`；dry-run 不修改仓库）
- locale：**397 keys × 19 dictionaries**（385 → 397，新增 12 个 key；`onboarding.title/body` 改写、`onboarding.docs` 指向文档站点）

### 用户本地桌面验收（`.63`，2026-11-12，PASS）

用户在真实桌面宿主安装 `0.4.0-beta.63` 后验收通过（2026-11-12），覆盖：

- 官方工作区视图：首次启动时入口提示（圆点 + 小气泡）出现一次，气泡里有「使用文档」链接；点「进去看看」或直接点图标进入视图后不再出现；
- 首次进入视图：空状态动作卡（新建分组 / 使用文档 / 知道了）与文案，链接打开文档站点；退出重开后说明卡不再出现；
- 插件设置页：顶部「使用文档」卡片可打开文档站点（`https://momijijin.github.io/dsh-session-grove-docs-site/`）；
- 视图选项里的归档说明、状态弹层三态说明、会话分叉与分组归档菜单的 hover 文案；
- 264px 窄栏、深色主题与阿拉伯语 RTL 下入口气泡不越界。

这是用户本地验收记录，不替代 A+ / locale sweeps；自动化证据见下节。

### 本轮隔离宿主证据（`.63`，2026-11-12，community）

A+ 宿主：community DSH Desktop Stable 2.0.18 / DSH `0.2.1-rc.2` 隔离实例（新 test home `<temp>\<isolated-home>`，port <ephemeral>；安装包 `dsh-session-grove-0.4.0-beta.63.tgz`，安装版本 `0.4.0-beta.63`）。

- `npm run test:isolated`：**PASS**（exit 0）。文档站点相关断言：入口提示的 docs 链接为 `https://momijijin.github.io/dsh-session-grove-docs-site/`；说明卡标题 "Free Groups"、docs 链接为同一文档站点、dismiss 为 "Got it"，dismiss 后重载不再出现。首次运行还覆盖入口提示英文标题、进视图后提示元素消失。其余既有全量路径保持 PASS（onboarding/search/archive filter/drag/dialog/status/head insertion/collapse/264px/dark/host rail/external SSE/workspace round-trip/rapid revision/multi-window SSE/CAS/reconnect/profiles/limits/session actions/clipboard/settings/localized title/diagnostics/switch/destructive confirm）。preview geometry：dialog 560×560px、narrow sidebar 252px、body scroll 3659>466px、row gaps [0,0,0]。隔离 web 进程已停止；test home 未删除（按删除纪律留给用户）。
- `npm run test:locale-pack`：**PASS**。third-party `ja` locale pack 激活日文 onboarding/dialog 文案；本轮把 fixture 的日文 onboarding 标题期望更新为缩短后的「フリーグループ」（locale 宿主 test home `<temp>\<isolated-home>`，port <ephemeral>）。
- `npm run test:all-locales`：**PASS 23/23**。19 languages + aliases：`en/zh/zh-Hant/zh-TW/zh-HK/zh-CN/ja/ko/de/fr/es/pt/pt-BR/it/nl/pl/tr/vi/th/id/ru/hi/ar`；含 settings/config；397 keys；VISUAL ru/hi/ar root 252px、header 4px、scroll 124/57/96。
- **未运行**：`test:ui-browser`（需要 fresh 隔离宿主，本轮未起第二个）；不得写成 `.63` 的 fresh-host browser PASS。`.62` 历史证据见下节。

## 历史隔离宿主证据（`.62`，2026-11-11，community）

`.63` 的 `test:ui-browser` **未运行**；`test:isolated` 与 locale sweeps 见上节。下列四项是 `.62` tarball 的历史 PASS，只作为基线参考，不能写成 `.63` 证据。

宿主：community DSH Desktop Stable 2.0.18 / DSH `0.2.1-rc.2` 隔离实例。被测包：`.62` tarball `dsh-session-grove-0.4.0-beta.62.tgz`，**829,055 bytes**，sha256 `47DFB392…11B34`（用户提供的截断摘要）。以下四项均为 **PASS**（exit 0）：

- `npm run test:isolated`：**PASS**。全量覆盖 onboarding/search/archive filter/drag/dialog/status/head insertion/collapse/264px/dark/host rail/external SSE/workspace refresh/rapid revision/multi-window SSE/CAS/reconnect/profiles/limits/session actions/clipboard/settings/localized title/diagnostics/switch/destructive confirm。preview geometry：dialog **560×560px**、narrow sidebar **252px**、body scroll **3659>466px**、row gaps **[0,0,0]**。
- `npm run test:ui-browser`：**PASS**（fresh isolated host）：`bundleEntries:1`、`executedBytes:2538003`、`sourceBytes:2538003`、`executedRatio:1`。**fresh-host 约束（非阻断环境限制）**：第一次在刚跑完 `test:isolated` 的共享宿主上执行，profile 已达 20 上限、Save-as 按钮 disabled；这是宿主残留状态，不是代码失败。换 fresh host 重跑 PASS；`test:ui-browser` 必须在 fresh 隔离宿主上跑。
- `npm run test:locale-pack`：**PASS**。third-party `ja` locale pack 激活日文 onboarding/dialog 文案。
- `npm run test:all-locales`：**PASS 23/23**。19 languages + aliases：`en/zh/zh-Hant/zh-TW/zh-HK/zh-CN/ja/ko/de/fr/es/pt/pt-BR/it/nl/pl/tr/vi/th/id/ru/hi/ar`；含 settings/config；VISUAL ru/hi/ar root 252px、header 4px、scroll 124/57/96。

**official A+ O `.62` 未重跑**：最新 official 证据仍是 `.61`（official DeepSeek Harness 0.2.2.0 / DSH `0.2.2-rc.1`，2026-11-10，`test:isolated` + `test:ui-browser`）；不得写成 official `.62` PASS。分组归档专用的 `e2e/groups.spec.mjs`（group 三态段、group 选择保持 popover 打开）不在这四项命令内，**未单独执行**；这四项里的 `archive filter` 是 session 归档三态路径。

## 0.4.0-beta.13 历史快照

日期：2026-11-05  
版本：`0.4.0-beta.13`  
宿主基线：`@deepseek-ai/dsh` 0.2.1-rc.2（community）/ 0.2.1-rc.5（official）  
已验证壳：community DSH Desktop **Stable** 2.0.18（rc.2）；official DeepSeek Harness desktop 0.2.1.0（rc.5，隔离 A+ + 维护者桌面窗口验收）  
不官方支持：community DSH Desktop Beta、community DSH NEXT（`-next`）

## 当时的结论（0.4.0-beta.13 历史）

- 本地候选 0.4.0-beta.13：**486/486 PASS**（identity reset + i18n fallback + 15 locales + CLDR plural templates + a11y + maintainability + perf + icon/title + session reorder + official rc.5 compatibility）
- 身份边界：package/manifest/bundle、host 路由、record/token/diagnostics/debug、client localStorage、skill/tool 名称全部为 grove；旧 `dsh-session-groups` 标识没有残留于 active source。
- i18n fallback：英文客户端在 Host locale handle 缺失时按 Host snapshot → `<html lang>` → navigator 解析；onboarding、settings、menu、dialog 英文断言已补入隔离 A+。
- i18n 基础：BCP 47 基础语言归一化、未知语言回退英文、全量字典 Host 注册；已打包 `en/zh/ja/ko/de/fr/es/pt/it/nl/pl/tr/vi/th/id` 十五种 locale（各 287 keys，key/placeholder/非空值一致），区域变体解析到基础语言，其他未支持语言回退英文。
- 复数机制：`Intl.PluralRules` + per-category JSON；`group.sessionCount` 与 `sessions.expand` 已迁移 one/other，其他数量文案后续迁移。
- 第三方语言包 fixture：test-only ja bundle 调用 `addLanguage({id:ja})` + `setLocale(ja)`，隔离 A+ 断言日文 onboarding 与新建分组弹窗 PASS。
- 时间复数：`time.minutes/hours/days/years` 已迁移 one/other；`dialog.deleteMoveBody` 双计数仍为已知限制。
- 构建修复：重建 `lib/client.js`，确保 it/nl 最终润色文案进入客户端 bundle（纯构建产物修正）。
- 子智能体状态复数：`status.subagentsRunning` 改为复数对象，波兰语 one/few/many/other 完整覆盖。
- 无自动迁移：旧 `dsh-session-groups` 记录/localStorage 被刻意忽略且不删除；手动迁移见 `docs/MIGRATION-0.4.md`。
- 包声明：`@deepseek-ai/schemastery` 从 `dependencies` 移到 `peerDependencies`，保留 `devDependencies` 供测试；隔离安装的插件包不再携带重复运行时副本。
- 控制面：只读 catalog、严格 icon/color/colorHex 校验均已覆盖边界测试。
- Node 内置 coverage：**93.63% lines / 82.20% branches / 88.98% functions**
- community A+ 隔离 Playwright（0.2.1-rc.2）：**PASS**
- official A+ 隔离 Playwright（0.2.1-rc.5，官方 bundle 的 DSH host/core + 独立 web profile）：**PASS**
- Core 纯函数测试：**29/29 PASS**
- 构建：`lib/client.js` 成功
- 语法检查：通过
- 真实 `~/.dsh`：隔离测试未写入真实分组记录
- 真实非空会话 Fork（隔离 DSH home + 临时独立 API key）：**PASS**，源会话 `Greeting` 生成子会话 `Greeting (1)`
- 损坏记录 + 有效 `.bak`：隔离坏文件并自动恢复上一 revision，warning `recovered-backup`
- 真实恢复演练（隔离实例）：主文件 rev15 损坏 → 自动恢复 `.bak` rev14，4 个分组保留，坏文件进入 `.corrupt-*`
- 损坏记录 + 无效 `.bak`：降级为空分组，保持两份原文件不删除
- 原生工具 `doctor` 只读兼容性报告（host capabilities/adapter/gates/storage-health/services/routes）：486 项套件覆盖
- 真实 CLI `doctor` 返回 storage.health.status=ok、revision、backup=true、quarantined=0
- doctor CLI compatibility gate：host compatibility 不支持时退出非零，JSON 报告保留
- 真实 CLI `doctor`（隔离实例，交换 DSH web launch cookie + 插件 bearer token）：**PASS**，返回 14 条路由与 host 服务状态
- 真实模型原生工具（隔离实例）：**PASS**，session log 记录 `tool/call` / `tool/result`，返回 `protocol: 1` 和成功 state
- 官方 rc.5 兼容：优先 `sessions.create`，会话创建不再复用已归入其他分组的 blank；社区 rc.2 fallback 保留并复跑

- 跨进程锁：两个独立 Node 进程竞争同一记录时一个成功、一个 conflict；过期锁自动回收；活跃锁超时返回 `store-busy`
- 包图标：`package.json` 根部 `icon` + `assets/icon-180.png` 打包，A+ 验证插件管理器实际渲染 data URL；英文标题统一为 Free Groups。
- 会话菜单：上移/下移与分组菜单对齐，边界禁用，覆盖 group 内与显式 ungrouped 顺序。
- A11y：对话框有 `aria-labelledby` 标题、初始/返回焦点、Tab 焦点陷阱、Escape；标题栏和右下 resizer 支持键盘移动/缩放；分组菜单支持 Arrow/Home/End。A+ 键盘路径 PASS
- 性能：spinner 只旋转外层 transform，弧线不再逐帧重绘；会话订阅先裁到主会话 + 当前 retained 子代理；未归组滚动只在挂载/resize 时读取布局。
- 维护性拆分：`components.js` 3051→1366 行；`routes.js` 1040→520 行；客户端模块、route-contract 和 control-routes 均有完整测试与 A+ 回归

## A+ 覆盖

A+ 使用独立 `DSH_HOME`、隔离端口和临时 profile（community `sg-e2e` / official `sg-official76`），覆盖：

- 首次引导出现/关闭后刷新不重现
- 三状态按钮存在，后台任务按钮不存在
- 分组移动/会话归入后的 head 顺序
- 收起/展开后的会话顺序
- 264px 窄侧栏、深色、宿主 Rail
- 搜索、归档 tri-state
- 拖拽自动展开、分组边缘占位、弹窗拖动/缩放
- 外部 commit 通过 SSE 触发刷新
- 同浏览器上下文两个页面均收到外部 commit 的 SSE 刷新
- 两页面在同一 baseRevision 上并发 commit：一个 200、一个 409，双方收敛到胜者
- EventSource 路由强制断开后恢复，onopen 触发强制 reload
- change stream adapter 单测：revision 回调、onopen 重连回调、关闭清理
- 中文 locale 隔离页面：插件设置/标题/选项文案为中文，未出现英文控件回退
- 切到官方工作区再切回自由分组后重新 load
- 快速连续 revision 收敛
- 会话菜单无 Pin；Copy Session ID 写入真实剪贴板并显示 toast
- hover archive 控件存在
- 第一层插件设置卡、本地化 `Free Groups` 标题
- 详情 Tooltip 打开
- 标准 Switch 交互；diagnostics 开关热启动/关闭 HUD
- `controlDestructive` 打开前出现确认，取消后仍保持关闭

## Fork 和核心策略

- `placeForkedSession` 纯函数：源分组组头、未归组头部、确定性、不修改输入文档
- 真实非空会话 Fork 成功路径仍需可控的非空 session fixture；当前未伪造该数据
- 组件拆分：`Toast`/`MenuPopover` -> `session-menu.js`，`ScrollArea` -> `scroll-area.js`，`GroupListPicker` -> `group-list-picker.js`，`DialogHost` -> `dialog-host.js`，session routes -> `host/session-routes.js`，DOM/test id 不变

## 原生工具和隔离控制

- `session_grove_control`：注册、state/resolve/plan/apply/CAS、session 动作、开关门禁
- 隔离 control E2E：state/resolve/plan/apply、icon/color、同名歧义、未知字段
- 隔离 session E2E：inspect / rename / archive / unarchive 实际 CLI 通过；HTTP/CLI 仍受 Host 浏览器 fence 限制，AI 使用原生工具
- 自动 skill 安装：`controlApi` 开启后写入 `<DSH_HOME>/skills/session-grove-control/SKILL.md`
- skill repair：managed skill 可修复；用户自有同名文件返回 `409 skill-user-owned`，不被覆盖

## 运行方式

```powershell
cd <repo-path>
npm test
npm run check:core
npm run check:coverage
npm run build
npm run test:isolated   # 需先启动隔离 web
```

## 当时的未决验证（历史快照，后续版本可能已覆盖）

- 真实桌面回归（首次引导、侧栏宽度、主题、中文视觉）
- 非空会话 Fork 成功路径已在隔离实例真实 E2E 验证（beta.53）
- 原生工具被真实模型发现并完成 state → plan → apply 的端到端链路
- SSE 断线重连和多窗口并发
- Windows 下 control token ACL 的实际审计

## 备注

- 当前默认自动门禁是 `e2e/isolated.spec.mjs`。
- `e2e/groups.spec.mjs` 是历史手工脚本，未纳入默认门禁。
- 发布包 SHA256 以最终 `npm pack` 输出为准。





