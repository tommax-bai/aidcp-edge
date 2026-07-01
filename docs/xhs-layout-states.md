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
