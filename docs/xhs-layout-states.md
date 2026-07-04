# 小红书 Web 布局双状态（宽窗口 / 窄窗口）—— 关键信息 · 必读

> 🔑 **权威文档**：小红书 web 首页/主框架是**响应式双布局**，主导航（我 / 通知 / 发布 / 头像）位置随视口宽度切换。
> edge 的**定位、拟人动作、监测、验收**都必须按这两个状态分别处理。**后续任何涉及主框架/导航/feed 的功能开发与验收都要参考本文档。**
>
> 来源：2026-06-27 真机 CDP 校准（Win11 / Chrome v148 / dpr=1 / 屏 1920×1080），用户现场确认。证据脚本：会话 scratchpad `cal*.mjs`。

## 0. 为什么重要（教训）

2026-06-27 真机首跑，self-identity / scroll / search / note-open / notification **五个核心动作同时失效**。根因不是各自的小 bug，而是**统一元凶**：edge 启动的 Chrome 窗口宽度落在**窄状态**，而既有选择器/滚动多按**宽状态**写 → 全线踩空。**只测一种布局 = 漏掉一半真机场景。**

## 1. 两个状态

| 状态 | 触发 | 主导航位置 | feed 滚动元素 |
|---|---|---|---|
| **WIDE 宽窗口** | 视口宽 ≥ 断点（实测 1920 命中；断点在 ~704 与 1920 之间，精确值待定） | **左侧栏** `.side-bar`（容器 `div.side-bar.side-bar-ai`） | 视情况：window/document 或内层容器 |
| **NARROW 窄窗口** | 视口宽 < 断点（实测 584 / 704 命中） | **底部图标栏** `div.bottom-menu-ai > div.channel-list > div.bottom-channel`（`position:fixed`，贴屏底） | 视情况：内层 `div.feeds-page` 或 window |

- 窄状态下侧栏 `.side-bar` **仍在 DOM 但整体隐藏**（`offsetParent===null`）；导航项以**图标**形式出现在底部栏。
- ⚠️ 因此 DOM 里**常同时存在两套同 href 入口**（隐藏的侧栏 + 可见的底部）。**任何 `querySelector` 取首个都可能命中隐藏的那个 → 误判。**

### 检测当前状态（推荐：按"哪套导航可见"判，而非硬编码宽度）
```js
function isWideLayout(){
  var sb = document.querySelector('.side-bar, [class*="side-bar"]');
  // 侧栏可见 = 宽；否则视为窄（底部栏）
  return !!(sb && sb.offsetParent !== null);
}
// 或：底部栏可见 = 窄
function isNarrowLayout(){
  var bm = document.querySelector('.bottom-menu-ai, [class*="bottom-menu"]');
  return !!(bm && bm.offsetParent !== null);
}
```
> 更稳健的通用做法：**不预判状态，直接对"目标入口的所有候选取可见的那个"**（见下方各动作）。

## 2. 各动作的双状态处理

### 2.1 自身账号 id（我 / self-identity）
- **稳定信号（两状态通用）**：`a[href*="/user/profile/"]` 中**文本恰为「我」且 href 无查询串**者即本人。作者链接一律带 `?channel_type=...&xsec_token=...`。
- 真机：`/user/profile/63e2ff0500000000260049ce`。
  - 宽：在 `.side-bar` 内（`a.link-wrapper` 包头像 `img.reds-img`，或文本「我」锚点）。
  - 窄：在底部栏 `a.bottom-channel[href="/user/profile/..."] > svg use #me`，文本「我」。
- **读 href 不依赖可见性**，两状态都能取——只要 DOM 已 hydrate。
- ✅ 做法：扫所有 `a[href*="/user/profile/"]`，取文本「我」+无 `?` 的 href 抽 id；**加有界等待重试**（轮询至出现，~5–8s）应对冷加载竞态。**勿**死绑 `.side-bar`、**勿**点「我的主页」（当前文案是「我」）。

### 2.2 通知未读（notification）
- 入口结构（两状态 DOM 同）：`a.link-wrapper.bottom-channel[href="/notification"][title="通知"] > div.badge-container > (svg.reds-icon[use #notification] + div.count="N")`。未读数 = `div.count`。
- ⚠️ 真机窄状态实测：DOM 两个 `a[href="/notification"]`——侧栏那个隐藏(`.count` 不可见)，**底部栏那个可见(`.count="10"` 可见, rect 贴屏底 y≈701)**。
- ✅ 做法：**遍历所有 `a[href*="/notification"]`，取 `offsetParent!==null`（可见）的那个，读其 `.count`**（数字=未读数；有 `.badge-container` 内可见非图标元素但无 `.count` 数字=有未读、数未知=红点）。两状态通吃。
- 旧实现 `buildNotificationBadgeJs` 用 `querySelector` 命中隐藏侧栏入口 → 窄状态恒判无未读 → 漏报。

### 2.3 翻页滚动（feed scroll）
- 两状态可滚元素不同（window/document 或内层 `div.feeds-page[overflowY:scroll]`）。
- ✅ 做法（首选）：**CDP `Input.dispatchMouseEvent type='mouseWheel'` 在 feed 区中心发真实滚轮**——浏览器原生滚动当前命中容器，两状态通吃，且补回硬件 wheel 事件（消除"无 wheel"指纹）。退路：运行时检测真正可滚祖先（window 或 `overflowY:auto/scroll` 且 `scrollHeight>clientHeight`）再设 scrollTop。
- 真机实测：滚动会触发**懒加载**（虚拟列表，scrollHeight 增长、note id 翻新）。

### 2.4 打开笔记（note open）
- feed 封面是**裸链** `<a href="/explore/<id>">`（**无 xsec_token**）。**直接导航裸 URL → 404 `error_code=300031 当前笔记暂时无法浏览`**（XHS 反爬：开笔记须带 xsec_token）。
- ✅ 正确路径：**真实点击**（CDP 鼠标事件，非 `el.click()` 裸 anchor 导航）触发 SPA 就地开 modal，URL 变 `/explore/<id>?xsec_token=...&xsec_source=pc_feed`（token 来自 feed 内存）。
- modal 关闭：`div.reds-button-new.close-icon`；笔记内点赞：`span.like-wrapper` + `svg.reds-icon.like-icon`(use `#like`)，**须限定在 modal 容器内**（feed 卡同款类名）。
- 🔶 **待补确认**：成功开一次 modal 后确认 detail 容器选择器（`#noteContainer` / `.note-container` 等，本轮窗口尺寸/坐标问题未开成）。

### 2.5 搜索（search）✅ 已修复 + 真机验证（宽窄两布局）
- 搜索框 = `textarea[name="aiSearchTextarea"]`（AI 搜索框，非 `<input placeholder=搜索>`）。**两布局各有一个实例、同一时刻只有一个可见**：
  - **窄布局**：`textarea#search-input`（在 `.search-area-in-header` 内）可见；
  - **宽布局**：`textarea#search-input-in-feeds`（在 `.search-area > .search-box-in-content > .search-input.large` 大框内）可见，而 `#search-input` 在 `display:none` 的 `.ai-header-container` 里**隐藏**。
- ⚠️ **坑**：`querySelector('#search-input')` 在宽布局命中**隐藏**框 → 聚焦/输入进不去（旧实现就栽这）。**必须取可见的那个**：`querySelectorAll(选择器).filter(e=>e.offsetWidth>0 && e.offsetParent!==null)[0]`。
- 提交：**Enter 即跳** `/search_result_ai?keyword=...`（当前 XHS 默认 AI 搜索；导航判据 `href.includes('search_result')` 命中）；提交按钮 `.submit-button`（宽布局可见的那个）作兜底。
- 真机验证：narrow(500) 与 wide(1264) 各一次，且用**真正的 `executeSearch`** 端到端——输入「上下文工程」→ 跳结果页 → 22 条相关结果卡。
- 修复落点：`browse/search-handler.ts`（`XHS_SEARCH_INPUT_SELECTOR` 补 `#search-input-in-feeds` + `name=aiSearchTextarea`；`buildIsVisibleJs`/`buildFocusClearJs` 改「取可见」；Enter 未跳则点 `.submit-button` 兜底）。

### 2.6 搜索结果页原生筛选（排序 + 发布时间）✅ 真机标定 2026-07-01（Tmax 分身，AI 搜索页）
- **落地页是 AI 搜索页**：`executeSearch` 回车后跳 `/search_result_ai?keyword=...`，容器 `<div class="ai-feeds-page with-ai-chat">`。顶部是**内容频道**「笔记/用户/问点点(ai)」，**不是**经典排序 tab——经典的「综合/最多收藏」排序**在页面上根本不存在行内**。
- **排序 + 发布时间都在「筛选」面板内**：右上角 `<span>筛选</span>`（在 `div.filter.ai-chat-filter` 里）。**hover 即展开**面板（无需 click），内含：
  - 排序依据：综合 / 最新 / 最多点赞 / 最多评论 / 最多收藏（`div.tags`，选中=`div.tags.active`）；
  - 发布时间：不限 / 一天内 / 一周内 / 半年内（同款 `div.tags`）。
- ⚠️ **每个选项都并排一个 `aria-hidden="true"` 的埋点/命中代理** `div.tags[data-hp-kind="filter-tag-*"]`，与真元素**精确重叠**。按「取最小可见元素」会点到代理 → **已点却没选上**（假阳性）。**定位/校验时必须跳过 `aria-hidden="true"` 子树内的元素**（`el.closest('[aria-hidden="true"]')`）。
- ⚠️ **应用任一筛选后，触发器文案由「筛选」变「已筛选」**：若只精确匹配「筛选」，切完第一个就找不到触发器、打不开面板、第二个永远切不上。触发器候选须含 `['筛选','已筛选']`。
- ⚠️ **面板刚展开就点会「瞬时高亮但不提交」**（排序项尤其明显）：hover 展开后需 settle 一下（一次 action 级停顿）再点，否则 `.active` 闪一下又回默认。
- **点选项即生效**（无「确定」按钮）：会触发结果重排 + 面板收起；被选项的 `.active` **持久**（重开面板仍在）。故**校验真生效 = 点后重新 hover 打开面板、看该项是否仍 `.active`**（点完原地立刻看会因面板收起、选项隐藏而假阴性）。
- **实现**：`src/browse/search-handler.ts` `applySearchFilters`——pass2 对每个目标「hover 触发器→settle→点→重开面板→校验持久 active」；`buildFindByTextRectJs`/`buildOptionSelectedJs` 排除 aria-hidden 子树；触发器 `SEARCH_FILTER_TRIGGER_TEXTS=['筛选','已筛选']`。真机实证：`最多收藏 + 一天内` 两项均切上、结果重排、持久 active。
- **宽窄**：本次在 innerWidth=1512（宽）标定；AI 搜索页 `isWide/isNarrow`（侧栏/底部栏）不适用（AI 页无侧栏），窄布局待补测——但定位全靠「可见文案 + 排除 aria-hidden + 取可见」，与宽窄解耦，预期通吃（窄布局若筛选入口收成图标另需补）。

### 2.6.1 ⚠️ 筛选「时好时坏」法证结论：**点击未提交的瞬态竞态**（非「流式重置已提交筛选」）✅ 真机 2026-07-03（Tmax 分身，三布局 + 法证级实验）

> 本节曾短暂记为「AI 流式生成会重置已提交筛选」，**该判定已被后续法证实验 + 用户人工复测证伪**，以下为修正后的确证事实。

- **搜索结果页三种情况**（用户报告，均已真机复现）：① **窄版 AI 总结在顶**（innerWidth≈760，主导航变底部图标栏）；② **宽版 AI 总结在右侧**（`ai-feeds-page with-ai-chat`）；③ **无 AI 总结**（可点右上 × 关掉→`search-layout` 全宽；**部分查询词天然不生成**）。**三布局筛选是同一套 hover 面板**（窄版触发器仍是文字「筛选」非图标）——定位机制与布局解耦。
- **已证实（forensic 铁证，DOM 打标 + 触发器文案跟踪 + elementFromPoint 命中链 + 逐 250ms 时间线）**：
  - **已提交的筛选能在 AI 流式生成全程存活**：窄/宽两布局各实测——AI 正在打字（textLen 9→947 / 211→2550 持续增长、未 finished）时点「最多收藏」，瞬间提交（触发器「筛选」→「已筛选」）、全程选中、甚至 AI 面板中途重启生成也不掉。**用户人工「生成中选筛选项没被重置」的观察正确**。
  - **当初的失败形态是「点击从未提交」**：瞬时高亮 ~1.7s（CSS 级 hover/active 闪烁）→ 面板自行收起 → 重开不选中、触发器未变「已筛选」。即 handler 没接住这次点击——疑似撞上页面/面板某个**亚秒级重渲染过渡窗口**（结果列表刷新 / AI 锚点注入等时机）；窗口窄、随词冷热与缓存漂移，**无法按需复现**（同参数重放多为成功），但真机已三次实锤（宽版 sort 两次 + 用户现场感知）。等 8s 再点成功 = 等过了窗口，非「等流式结束」。
  - **点已选中项不会 toggle 掉**（幂等安全，重试可放心做）；**触发器文案「筛选」→「已筛选」= 廉价提交信号**（必要非充分：只说明有筛选生效，不指明哪项）。
  - **AI 总结带原生完成信号**：正文容器窄版 `xhs-ai-message-card__content` / 宽版 `xhs-ai-chat-*` 两套类名家族；`.ai-message` 生成完挂 **`.ai-message-finished`**——比 loading 元素/textLen 启发稳得多（如需等待时用它）。
- **AI 总结可整体忽略、不必关闭**（产品决策 2026-07-03）：卡片采集不受它污染——真机验证 AI 面板内 `.note-item` 卡 0 个、`a[href*=/explore/]` 链接 0 个；主动关闭不可靠（× 异步晚出现、部分词无 AI、③无按钮）。
- **修法**（落 change comment-search-command task 5.4，**已实装 edge `3c616c5`**）：既然失败=「未提交的瞬态竞态」且无法预判窗口，**不押注任何具体机理**——`applySearchFilters` 改「**逐项幂等应用 + 提交校验 + 有界重试**」：先读持久选中态（已选中跳过）→ 点 → 校验（重开面板读持久 `.active`，触发器「已筛选」作辅助信号；无触发器布局以 selected 为准）→ 未提交则 settle ≥1.8s（瞬时高亮消退窗）重试，每项 ≤3 次，仍未提交诚实返回 false。返回值只由最终权威复核决定，瞬时高亮绝不作数。**附带修**：选项已可见时（面板残留开着/行内 tab）点击路径以目标自身为起点——默认外侧起点会划出面板 → mouseleave 收面板 → 点空/误点下层卡片（真机实证）。真机验收：干净词一点即中；脏状态（面板预开）第 1 点真被吞、重试当场救回；--twice 幂等。
- **探针**：`scripts/layout-filter-probe.ts`（`--search=<词>`/`--resize=WxH`/`--hover`/`--diag`(命中链)/`--exp`(微时序)/`--forensic [--await-stream] [--target=文案]`(DOM打标+提交跟踪时间线)/`--closeai`/`--production`(真实 applySearchFilters 端到端)/`--twice`(幂等)/`--nowait`(生产时序)/`--watchai`)，产物 `/tmp/aidcp-layout-probe-*`。

### 2.7 创作发布页（creator.xiaohongshu.com）选「上传图文」模式 ✅ 真机标定 + 端到端已验证 2026-07-04

> ⚠️ **新面**：前面 §1–§2.6 都是**消费端**（主站 feed / 搜索）。**创作发布页在另一子域 `creator.xiaohongshu.com/publish/publish`**，是发布下发段（`navigate_entry`→`select_mode`→…）落地的页。默认停「上传视频」，要发图文必须先点「上传图文」切模式。

**真机标定关键结论（2026-07-04，登录态「工程师大白」CDP 只读 + 端到端实测；探针 `scripts/calibrate-select-mode-layout.ts` / `scripts/verify-select-mode-live.ts`）**：

- **重复 tab 的隐藏机理 ≠ `display:none`，而是「移到屏幕外」**：`div.creator-tab` 里「上传图文」有**两份**——一份在**屏幕外** `rect≈{x:-9758,y:-9934}`、一份在屏内 `{x:369,y:81}`（真实可点的那个）。屏幕外那份 `offsetParent` **非空**、`getClientRects()` **非空** → **消费端那套 `offsetParent!==null || getClientRects().length>0` 判据会把它误判成可见、且它在文档序更靠前 → 旧「取第一个」正是点了它**。这跟消费端「隐藏=display:none/offsetParent=null」不是一回事。
- **不是宽/窄响应式差异**：`Emulation` 把视口压到 **600×900** 时，tab 栏**形态与 1904 宽完全一样**（还是那排 `div.creator-tab`：上传视频/上传图文/写长文/发播客 @ y:81），屏幕外副本也一样在 `-9758`。即**该重复是「持久的屏幕外克隆」、与视口宽度无关**——创作页 tab 栏没观察到独立的窄布局形态。（原「宽/窄双布局」是假说；真因是屏幕外克隆。）
- **默认模式信号**：视频模式下激活 tab = `div.creator-tab.active`「上传视频」；唯一文件输入 `accept=.mp4,.mov,...`。切图文后文件输入 `accept=.jpg,.jpeg,.png,.webp`、激活 tab 变「上传图文」。

- ⚠️ **坑（生产 `no_target`/`post_validate_failed` 元凶）**：旧 `select_mode`「取第一个文本『上传图文』就点、不挑可见、只等 12s」→ 双布局下点了**屏幕外克隆**（点之无效 → `post_validate_failed`）；冷加载慢又可能 12s 内不命中（→ `no_target`，2026-07-03 生产 recordId=37）。
- ✅ **做法（已实装 + 真机验，`runSelectMode`）**：
  - **取可见 = 与视口相交**（`IS_VISIBLE`，**真机标定后改**）：`getBoundingClientRect()` 有非零盒 **且** 落在视口内（`right>0 && bottom>0 && left<innerWidth && top<innerHeight`）。这才排除得掉屏幕外克隆（`-9758` 那份 `right<0`）；**注意：消费端的 `offsetParent` 判据在此不适用**（屏幕外元素 offsetParent 非空）。兼容 `position:fixed`（其 rect 亦在视口内）。选中优先「精确『上传图文』+ `creator-tab`/`tab` class」，其次 best-effort 短文本含「图文」的 tab。
  - **幂等早退（保守）** + **有界重试 20s（< 云 30s）出现即点、grace 1.5s 重点**（同前）。
  - **模式激活后置校验（权威 `MODE_STATE` + 辅助 `IMG_MODE_ACTIVE` 带 video 否决）**：`MODE_STATE` 读**可见激活 tab** 返回 `'image'|'video'|''`，`'image'` 判已在图文模式（权威）；辅助信号仅「已点击 + 激活态未识别（非 video）」时采信，`MODE_STATE==='video'` 即**否决**（评审硬化：辅助是「电平」非「跃变」，防残留图片信号谎报）。文件输入常 `display:none`，辅助探针刻意不按可见性过滤，安全靠 video 否决。
  - **诚实失败**：无可见 tab 且未在图文模式 → `no_target`；点了没切上（含 video 否决）→ `post_validate_failed`；绝不假成功。
- ✅ **端到端真机验证（2026-07-04）**：真实 `PublishCommandDispatcher` 跑一条 `select_mode`——BEFORE `mode=video`/accept 视频类；`ok:true` **531ms**（点中屏内 `369,81`、未误点屏外克隆、无重试）；AFTER `mode=image`/`accept=.jpg,.jpeg,.png,.webp`（**模式真切换**）。窄视口（600×900）dump 亦确认取的是屏内可见 tab。
- **相关代码/探针**：`src/flows/publish-command-handlers.ts` `runSelectMode()`（`IS_VISIBLE`=视口相交 / `MODE_STATE` / `CLICK_TAB` / `IMG_MODE_ACTIVE`）；`scripts/calibrate-select-mode-layout.ts`（宽/窄只读 dump）；`scripts/verify-select-mode-live.ts`（驱动真实 dispatcher 端到端）；序列 `aidcp-cloud/src/publish-agent/command-sequencer.ts`（fail-fast + 30s 单指令超时）。openspec change `publish-select-mode-layout-robust`。

## 3. 跨切面建议
- **启动固定桌面视口**：edge 启动 Chrome 带 `--window-size=1440,980`（+ 启动后 `Browser.setWindowBounds` 兜底 maximize；高 DPI 机另需 `--force-device-scale-factor=1` 或 `Emulation.setDeviceMetricsOverride{deviceScaleFactor:1,width:1440}`）→ 优先进 WIDE。
- **但不得只赌宽窗口**：真实运营机分辨率/缩放不可控，**两状态都必须能跑**（用户硬要求）。所有动作按 §2 的"取可见入口 / 真实滚轮 / SPA 开 modal"做到状态无关。

## 4. 验收清单（每项都要在 WIDE 与 NARROW 两状态各验一次）
- [ ] self-identity：两状态都能读出本人 id（不靠 `AIDCP_ACCOUNT_ID` override）。
- [ ] notification：页面有 N 条未读时，两状态都上报 `notification.detected` 且 count 正确。
- [ ] scroll：两状态滚动都推进 feed（page.cards 内容变化 + 懒加载）。
- [ ] note open：两状态都能就地开 modal（不 404、URL 带 xsec_token），并能读取/点赞/关闭。
- [ ] search：两状态都能展开搜索、输入、跳结果页并上报结果卡片。
- [ ] 窗口尺寸跨断点切换时不崩（宽→窄 / 窄→宽）。

## 5. 相关代码
`src/cdp/self-identity.ts`、`src/cdp/chrome-launcher.ts`（登录探测头像选择器镜像 + 启动窗口尺寸）、`src/browse/feed-scroller.ts`（滚动）、`src/browse/notification-monitor.ts`（通知）、`src/browse/search-handler.ts`（搜索）、`src/browse/modal-controller.ts` + `src/browse/cdp-util.ts`（开笔记/点击）。
