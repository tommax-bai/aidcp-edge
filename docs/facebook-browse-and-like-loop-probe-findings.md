# Facebook 浏览 / 就地点赞 真机探针发现（feed inline + like loop）

> 环境：AdsPower profile **Dennis Scott（`k1ej3o8f`）**，facebook.com，桌面 Mac Chrome UA，意大利/多语言 feed。
> 方法：`scripts/fb-inline-probe.ts`（注入**生产** `FB_TARGET_HELPERS_JS` + 实例化**生产** `FacebookLikeExecutor`，
> 结论建立在线上逻辑上、非另写一份）。纪律：每次导航后等 ~12s、点击一律页内 `el.click()`、破坏性步骤旗标 gated。
> 覆盖 change `facebook-feed-inline-browse`（C2）落地前硬阻断 P0–P7。**日期：2026-07-14。**
>
> 本文档同时兑现 `cta-labels.ts` / `feed-reader.ts` / `post-reader.ts` 头注引用（此前指向不存在的同名文档）。

---

## Action bar / LIKE DISAMBIGUATION（帖级点赞按钮消歧 + 点赞是两段）

home feed 逐卡动作栏（P0，本轮 P4 复核）：

- **帖级中性点赞按钮** = `[role=button]`，`aria-label="给<作者>的帖子留下心情"`（zh-CN），**文案为空**。与同栏
  `aria-label="评论<作者>的帖子"`（text="评论"）并存——帖级 react 与评论级 react 靠「同栏是否有『评论』按钮」区分
  （`fbSharesActionBarWithComment`）。生产执行器 shadow 在真机逐卡命中此按钮、判「中性可点」，**定位链路端到端可用**。
- **反应【计数汇总】按钮陷阱真实存在**：卡内「所有心情：5,623」这类是计数按钮、`aria-label` 亦含反应词但带**数字文案**，
  须靠 `/\d/` 数字守卫排除（`reactState` / `isReactedState` 已做），否则每条有反应的帖都会被误判已赞。

### ⭐ 关键发现（P4）：feed 点赞是**两段**，不是一击

对真机逐卡下点赞命令（生产 `FacebookLikeExecutor.like({noteId})`，noteId = 规范化 permalink）：

1. **第一段** `el.click()` 打在 `留下心情` 按钮上 → **不直接提交 Like**，而是**弹出反应选择器浮层**
   （probe 侧 `反应选择器浮层出现=true`）；按钮状态**不翻转**（仍 `留下心情`、text 空）。
   → 生产执行器（单击后校验按钮翻转）此时回 **`state_unchanged`**：**当前实现会在 feed 上把点赞误报为失败**。
2. **第二段** 点浮层里的「赞」项（`aria-label="赞"`）→ **才真正提交**。按钮翻转成已赞态。
   - 真机 picker 反应项样本：`["赞","大爱","哇","怒"]`（子集，「赞」恒在）。
   - **已赞态确切串（ground truth，此前 `cta-labels.ts §8.2` 空缺，本轮拿到）**：
     点赞后该按钮 `aria-label="从iQIYI的帖子中移除赞"`、`text="赞"`。
   - `isReactedState` 对该串**已正确判已赞**（`移除赞` 命中 `UNREACT_LABEL_SOURCE`，`text="赞"` 命中反应词）——
     **已赞态检测无需改；缺的只是「两段提交」这一段执行动作。**

> 复核样本：两张不同卡（pfbid 帖「Napoli…」、video 帖「iQIYI」）行为一致——**两段是 feed 的普遍行为、非个例**。
> 待辨析（不阻塞两段方案）：`el.click()` 弹 picker，可能是合成 click 缺 pointer 序列所致；真实 pointerdown+up 快击
> 是否直接 Like 未测。C2 采**已验证可行的两段路径**（click→picker→click「赞」），把 pointer 直击留作可选优化。

---

## Feed 就地读全文（P1 展开控件 + textContent 捷径）

- **锚定展开控件形态确定**（18–21 帖样本，10–11 帖带展开控件，形态高度一致）：
  `<div role="button">`、文案 **"展开"**、**非 `<a href>`**（`非<a>=true`）、**在 message 容器内**（`inMsg=true`）。
  → C2 inline-reader 可靠地锚定它并页内 `el.click()` 展开（配合 P2「展开不离 feed」已证）。
- **textContent 捷径：折叠帖上被证伪、须点展开**。带「展开」控件的长帖 `textContent ≈ innerText`（ratio~1.0）——
  折叠正文**不在 DOM**，非点不可读全文。**例外**：个别无折叠帖 `textContent > innerText`（实测 ratio 1.51，全文已在 DOM）。
  → 读全文策略：**有「展开」控件⇒必须点；无⇒读 textContent 即可**。不能一律靠 textContent 捷径。

## Detail（评论必进详情页，P5/P6）

- feed 卡点「评论」= **导航到 permalink**（URL 变 `/posts/…`）+ 弹 dialog 模态；评论框在 dialog 内、feed 卡内联无编辑框。
  → 评论**走迁移**（C1b 回执驱动两步 `open_note{purpose:navigate}` → `comment`），不做 feed 内联评论。
- 详情 = 叠在 feed 之上的 dialog、同一 document（feed 的 `[role=article]` 仍在 DOM）。作用域按「最后打开且真含帖的 dialog」。

## 身份 / 目标锁定（P3，强）

- 18 + 21 帖两轮：**全部 `resolve=ok`、反查命中数恒 =1、零撞卡、零 null 身份**。
  home feed 形态分布：`pfbid` 占多数（`/<page>/posts/pfbid…` 或 `permalink.php?story_fbid=pfbid…`）+ `video`
  （`watch/?v=` / `reel/…`）；`multi_permalinks`（群帖）本轮未采到（home feed 无群帖）。
- → **按 postId 就地锁卡在真机成立**：生产 `canonicalPostId` + 三段式 `fbTgtResolve` 逐卡唯一命中，不点错卡地基牢。

## 虚拟化（P7）：**回收**，游标须用 postId 集合

- 连续下滚：`[role=article]` 数 3→23 攀升后**回落**（25→21）；**首屏 postId 第 1 轮即退出 DOM**（存活 0/1）。
  → FB home feed **回收已滚过的卡**。**feed 游标绝不能靠 DOM 序水位，必须用 postId 集合**（C2 设计假设，真机坐实）。

---

## 对 C2 的直接结论

1. **feed 点赞改两段**：click `留下心情` → 若弹 picker → click picker 里「赞」项 → 校验按钮翻转（`isReactedState` 已够）。
   当前单击执行器在 feed 上会 `state_unchanged` 误判失败——C2 feed-like 必须处理 picker（**最高优先级实装点**）。
2. **inline 读**：有「展开」`div[role=button]` 就点、否则读 textContent；展开前后校验 location/dialog/卡索引不变（P2）。
3. **feed 游标 = postId 集合**（回收已证），非 DOM 序；`ensureFeed` 守卫防重载回顶。
4. **评论走迁移**（C1b），不做 feed 内联评论。

## Open / backlog（真机簇 67）

- P4 已提交一次真实点赞（Dennis→iQIYI 帖，未撤销，作线上证据）。
- 跨入口/跨会话 postId 恒等（feed 打开 vs permalink 直达同帖）单 feed 会话证不了 → 真机 backlog。
- pointer 直击是否免 picker（免两段）→ 可选优化探针。
- group 帖 `multi_permalinks` 形态在 home feed 未采到 → 进群浏览时补采。
