# aidcp-edge publish flow 真实小红书页面联调准备清单

本文档用于 `publishPost` 在真实小红书页面上的静态盘点与联调前准备，不涉及真实浏览器执行，也不修改业务代码。注意：`src/flows/anchors.ts` 中的发布锚点（entry/title/content/tag/submit）已按真实小红书 creator DOM 校准（标题 placeholder、正文 `ProseMirror`、标签「话题」按钮、提交「发布」按钮等均为实测文本），下文「待真机确认」聚焦的是运行时仍未实测的行为（执行层输入写入方式、标签候选交互、二次确认弹窗、成功页跳转与 postId/分享链接提取等），而非锚点文本本身。目标是把这些真实 DOM 待确认点、联调顺序与高概率改动位一次性梳理清楚，方便真机阶段快速收敛。

## 1. 真实 DOM 依赖清单

### 1.1 流程总览

当前发布流定义在 `src/flows/publish-post.ts`，`publishPost()` 按固定顺序串行执行：

0. 前置守卫（precondition）：若 `payload.images?.length > 0`，整页路径直接 early-return 报错 `[images] use command-driven path (upload_image) ...`——v1 整页路径不支持上传图片，带图必须改走指令驱动路径（`upload_image`），绝不静默丢图后假成功（红线）。
1. `enter_publish_page`
2. `input_title`
3. `input_content`
4. `input_tag`（对 `payload.tags` 逐个循环）
5. （可选）审批门 `waitForPublishApproval(approvalGate)`：仅当调用方传入 `approvalGate` 时，在 `input_tag` 与 `submit_publish` 之间阻塞等待飞书审批通过（携带 `requestId`）；未通过则以 `[approval_gate] ... requestId=...` 失败返回（见 `src/publish/approval-gate.ts`）。
6. `submit_publish`
7. `validate_publish`（`publishPost()` 末尾另有强制 `extractPostId()` 的硬校验，见 §1.2 F）

每一步都通过 `ActionRequest` 携带 `actionId + goal + anchorHint` 进入 `LocatingEngine.resolveAndAct()`，定位层优先尝试缓存锚点，失败后退化到：

- `extractInteractiveElements(root, scope, { scopeFallback: 'root' })`
- `selector.select(goal, elements)`
- 执行后再走 `PublishStepValidator.validate()`

因此真实页面联调时，需要同时确认三类依赖是否成立：

- `src/flows/anchors.ts` 中的 `goal / anchorHint / scope`
- `src/locating/extractor.ts` 对真实 DOM 的可交互元素抽取是否能覆盖目标控件
- `src/flows/publish-post.ts` 中每一步 `PostValidator` 的后置校验是否符合真实页面行为

### 1.2 step-by-step DOM 依赖

#### A. entry：进入发布页

- 代码位置
  - `src/flows/anchors.ts` → `XHS_PUBLISH_ENTRY_ACTION_ID`
  - `src/flows/anchors.ts` → `XHS_PUBLISH_ENTRY_GOAL`
  - `src/flows/anchors.ts` → `XHS_PUBLISH_ENTRY_ANCHOR_HINT`
  - `src/flows/publish-post.ts` → `buildEnterPublishPageRequest()`
  - `src/flows/publish-post.ts` → `PublishStepValidator.validate()` 的 `enter_publish_page`

- 当前锚点（`anchors.ts` 实际值）
  - `actionId`: `note.publish_entry`
  - `goal`（`XHS_PUBLISH_ENTRY_GOAL`）: 进入笔记发布页，入口文案可能是「发布」「去发布」「发笔记」「写笔记」「创建」「创作中心」「发布笔记」「发图文」
  - `anchorHint`（`XHS_PUBLISH_ENTRY_ANCHOR_HINT`，**无 `role`**）
    - `text: '创作'`
    - `textMatch: 'contains'`
  - 后置校验（`isPublishPage()`）：点击后命中以下任一线索即判为已进入发布页（远比"仅标题/正文文本"宽）
    - 标题相关：「填写标题会有更多赞哦」「标题」「填写标题」「输入标题」
    - 正文相关：「正文」「写点什么」「添加正文」「输入正文」「图片编辑」「智能标题」
    - 发布页特征：「发布笔记」「发图文」「上传图文」「暂存离开」「定时发布」「笔记预览」
    - 标签相关：「添加标签」「添加话题」「话题」
    - data-action-id 兜底：存在 `note.publish_title` / `note.publish_content` / `note.publish_submit` 元素

- 待真机确认
  - 发布入口是否真的暴露为 `button` 角色，还是 `a/div/span` + click
  - 入口是否在创作中心、顶部导航、侧边栏、浮动按钮，还是需要先进入创作中心再二跳
  - 入口文案是否包含“发布”，还是更偏向「创作」「发图文」「发布笔记」
  - 点击后是否直接进入发布页，还是先进入创作中心再选内容类型
  - 后置校验依赖的标题/正文文本是否真实存在于首屏 DOM 中

#### B. title：填写标题

- 代码位置
  - `src/flows/anchors.ts` → `XHS_PUBLISH_TITLE_ACTION_ID`
  - `src/flows/anchors.ts` → `XHS_PUBLISH_TITLE_GOAL`
  - `src/flows/anchors.ts` → `XHS_PUBLISH_TITLE_ANCHOR_HINT`
  - `src/flows/publish-post.ts` → `buildTitleInputRequest()`
  - `src/flows/publish-post.ts` → `PublishStepValidator.validate()` 的 `input_title`

- 当前锚点（`anchors.ts`）
  - `actionId`: `note.publish_title`
  - `goal`（`XHS_PUBLISH_TITLE_GOAL`）: 在发布页填写标题，真实控件通常是 placeholder 为「填写标题会有更多赞哦」的输入框
  - `anchorHint`（`XHS_PUBLISH_TITLE_ANCHOR_HINT`）
    - `role: 'textbox'`
    - `text: '填写标题会有更多赞哦'`
    - `textMatch: 'contains'`
    - `scope: XHS_PUBLISH_SCOPE`
  - `XHS_PUBLISH_SCOPE.selector`
    - `.publish-container`
    - `[class*="publish-container"]`
    - `[class*="publishContainer"]`
    - `.note-edit-container`
    - `[class*="note-edit"]`
    - `[class*="noteEdit"]`
    - `.creator-container`
    - `[class*="creator-container"]`
  - 后置校验优先查找：
    - `[data-action-id="note.publish_title"]`
    - 否则按标题关键词（「填写标题会有更多赞哦」「标题」「填写标题」「输入标题」）找 `input/textarea/contenteditable=true`
  - 校验方式：读取 `value` 或 `textContent`，判断是否包含 `payload.title`

- 待真机确认
  - 标题控件真实标签是 `input`、`textarea`，还是 `contenteditable`
  - 标题区域是否存在 placeholder / aria-label / title 等可抽取文本
  - 标题控件是否位于当前 `XHS_PUBLISH_SCOPE` 能命中的容器内
  - 真实页面是否会把标题值同步到 `value`，还是只存在于富文本节点文本中
  - 是否存在标题长度限制、自动截断、失焦后格式化，导致后置校验需改为“前缀匹配/归一化匹配”

#### C. content：填写正文

- 代码位置
  - `src/flows/anchors.ts` → `XHS_PUBLISH_CONTENT_ACTION_ID`
  - `src/flows/anchors.ts` → `XHS_PUBLISH_CONTENT_GOAL`
  - `src/flows/anchors.ts` → `XHS_PUBLISH_CONTENT_ANCHOR_HINT`
  - `src/flows/publish-post.ts` → `buildContentInputRequest()`
  - `src/flows/publish-post.ts` → `PublishStepValidator.validate()` 的 `input_content`

- 当前锚点（`anchors.ts`）
  - `actionId`: `note.publish_content`
  - `goal`（`XHS_PUBLISH_CONTENT_GOAL`）: 找到正文输入框或内容编辑区，真实控件通常是 class 含 tiptap `ProseMirror` 的富文本编辑器
  - `anchorHint`（`XHS_PUBLISH_CONTENT_ANCHOR_HINT`，**不含 `text`**，改用 `classHint`）
    - `role: 'textbox'`
    - `classHint: 'ProseMirror'`
    - `textMatch: 'contains'`
    - `scope: XHS_PUBLISH_SCOPE`
  - 后置校验优先查找：
    - `[data-action-id="note.publish_content"]`
    - 否则按正文关键词（「正文」「写点什么」「添加正文」「输入正文」`ProseMirror`）找 `input/textarea/contenteditable=true`
  - 校验方式：读取 `value` 或 `textContent`，判断是否包含 `payload.content`

- 待真机确认
  - 正文是否为真正的富文本编辑器，且主编辑区是 `div[contenteditable=true]`
  - 正文 placeholder 是否只在空态显示，输入后 DOM 结构是否完全变化
  - 正文是否拆成多段 block，导致简单读取单节点 `textContent` 不稳定
  - 输入方式是否必须模拟真实键盘输入，不能只依赖 value 设置
  - scope 是否能覆盖正文编辑器；若正文编辑器挂在 portal / 独立容器，当前 scope 可能漏抽

#### D. tag：添加标签

- 代码位置
  - `src/flows/anchors.ts` → `XHS_PUBLISH_TAG_ACTION_ID`
  - `src/flows/anchors.ts` → `XHS_PUBLISH_TAG_GOAL`
  - `src/flows/anchors.ts` → `XHS_PUBLISH_TAG_ANCHOR_HINT`
  - `src/flows/publish-post.ts` → `buildTagInputRequest()`
  - `src/flows/publish-post.ts` → `PublishStepValidator.validate()` 的 `input_tag`

- 当前锚点（`anchors.ts`）
  - `actionId`: `note.publish_tag`
  - `goal`（`XHS_PUBLISH_TAG_GOAL`）: 在发布页添加标签，真实控件通常是文本为「话题」的按钮
  - `anchorHint`（`XHS_PUBLISH_TAG_ANCHOR_HINT`，**`button` 而非 `textbox`**）
    - `role: 'button'`
    - `text: '话题'`
    - `textMatch: 'contains'`
    - `scope: XHS_PUBLISH_SCOPE`
  - 每个 tag 单独执行一次 `op: 'input'`
  - `goal` 会附加动态文本：`当前要加入的标签是「${tag}」`
  - 后置校验：整页扫描所有元素，只要任一元素的 `textContent / aria-label / title / placeholder / value / data-placeholder` 包含当前 tag 即视为成功

- 待真机确认
  - 标签入口是真正的文本框，还是“添加话题”按钮
  - 输入 `#tag` 后是否需要从搜索下拉中点击候选项才能真正挂载标签
  - 标签是否以 chip/token 形式渲染，且只有选中候选后才出现在 DOM 中
  - 若标签是搜索选择模式，当前单步 `input` 逻辑不足，可能需要扩展为 `input -> click candidate -> validate`
  - 锚点已按「话题」按钮（`role:'button'`）校准；真机需确认入口确为 `button`，而非 `generic`/文本框，以及点击后是否进入标签输入态
  - 当前后置校验过宽，只要页面任意位置出现 tag 文本就算成功，真机时需确认是否会误判

#### E. submit：提交发布

- 代码位置
  - `src/flows/anchors.ts` → `XHS_PUBLISH_SUBMIT_ACTION_ID`
  - `src/flows/anchors.ts` → `XHS_PUBLISH_SUBMIT_GOAL`
  - `src/flows/anchors.ts` → `XHS_PUBLISH_SUBMIT_ANCHOR_HINT`
  - `src/flows/publish-post.ts` → `buildSubmitPublishRequest()`
  - `src/flows/publish-post.ts` → `PublishStepValidator.validate()` 的 `submit_publish`

- 当前锚点（`anchors.ts`）
  - `actionId`: `note.publish_submit`
  - `goal`（`XHS_PUBLISH_SUBMIT_GOAL`）: 找到最终发布按钮，真实小红书 creator 页面通常位于底部固定操作栏，文本精确为「发布」，其左侧同栏常有「暂存离开」按钮
  - `anchorHint`（`XHS_PUBLISH_SUBMIT_ANCHOR_HINT`，**无 `scope`**，改用 `classHint`）
    - `role: 'button'`
    - `text: '发布'`
    - `textMatch: 'contains'`
    - `classHint: 'submit'`
  - 后置校验（`submit_publish` 步）：**并非**硬性要求 postId——满足任一即通过：能提取到 `postId`，**或**深度扫描命中「发布」「暂存离开」「立即发布」「确认发布」，**或**命中 `publish / submit` 关键词。真正"必须拿到 `postId`"的硬校验只在 `publishPost()` 末尾（见 F）

- 待真机确认
  - 最终按钮文案是否与入口按钮同样包含“发布”，若同页存在多个“发布”按钮，当前锚点可能歧义
  - 提交后是否出现二次确认弹窗、风险提示、草稿保存提示
  - 提交按钮通常在固定底栏/portal 中，故 submit 锚点已不挂 `scope`、改用 `classHint:'submit'` + 文本「发布」定位；真机需确认 `classHint:'submit'` 能稳定命中且不误中其他 submit 类按钮
  - 点击后是否立即跳转，还是先 toast/loading，再异步跳转
  - 若存在二次确认，当前 `submit_publish` 的单次 click + postId 校验会直接失败

#### F. verify：发布成功校验与 postId / 分享链接提取

- 代码位置
  - `src/flows/publish-post.ts` → `extractPostId()`
  - `src/flows/publish-post.ts` → `extractPostUrl()`
  - `src/flows/publish-post.ts` → `PublishStepValidator.validate()` 的 `submit_publish`
  - `src/flows/publish-post.ts` → `PublishStepValidator.validate()` 的 `validate_publish`
  - `src/flows/publish-post.ts` → `publishPost()` 末尾 `finalValidator + extractPostId`

- 当前实现
  - `extractPostId()`：成功后从页面 DOM 提取 id
    - 优先扫描属性：`data-post-id` / `data-note-id` / `data-id` / `data-postid`
    - 否则从链接 `href` 命中 `/explore/<id>`、`/note/<id>`、`/notes/<id>` 取 id
  - `extractPostUrl()`：另抓「带 `xsec_token` 的完整小红书分享 URL」（可点开真实笔记，供后台跳转）
    - 来源：`link[rel=”canonical”]`、`meta[property=”og:url”]`、`a[href]`、`[data-share-url]`、`[data-url]`、`input[value]`
    - 只回**含 `xsec_token`** 的完整绝对链接；抓不到即诚实置 `undefined`，绝不用裸 id 拼一个缺 token、打不开的假链接冒充
  - 成功判据分两层（**并非**两步都以”能提取到 postId”为唯一标准）：
    - 步验证器 `submit_publish` / `validate_publish`：postId **或**「发布/暂存离开/立即发布/确认发布」**或**「publish/submit」关键词命中即通过（宽松，可被关键词兜底）
    - `publishPost()` 末尾硬校验：先跑 `validate_publish`，再**强制** `extractPostId()` 非空，否则返回 `[validate_publish] missing_post_id`——“必须拿到 postId”的红线只在这里

- 待真机确认
  - 发布成功后真实跳转 URL 是否为 `/explore/<id>`、`/discovery/item/<id>`、`/note/<id>` 或其他格式
  - postId 是否只存在于 URL，不存在于 DOM 属性
  - 是否需要等待跳转完成、SPA 路由切换完成或接口返回后才能拿到 postId
  - 若成功页是创作中心列表页，postId 可能只存在于新发布卡片链接中，当前提取逻辑需补充
  - 若成功后停留在编辑页并弹 toast，当前“必须提取 postId”策略可能需要改为多策略校验

## 2. 开放问题逐项展开

### 2.1 发布入口 / 创作中心真实路径与按钮文案

#### 真机要验证什么

- 已登录状态下，从小红书首页进入发布页的最短路径是什么
- 是否必须先进入创作中心，再点击“发布笔记/发图文”
- 首页、创作中心、个人页是否存在多个“发布”相关入口
- 入口元素的真实标签、role、可访问名、可见文本分别是什么
- 入口点击后是否直接进入图文发布页，还是需要选择发布类型

#### 可能的应对

- 若入口不是单一按钮：
  - 将 `enter_publish_page` 扩展为多步（例如“进入创作中心” + “选择图文发布”）
- 若入口文案不含“发布”：
  - 调整 `XHS_PUBLISH_ENTRY_GOAL`
  - 调整 `XHS_PUBLISH_ENTRY_ANCHOR_HINT.text`
- 若入口不具备 `button` role：
  - 放宽 `anchorHint.role`
  - 或依赖更强的 scope / attributes / classHint

### 2.2 标题 / 正文输入框是 input 还是 contenteditable

#### 真机要验证什么

- 标题控件是否为原生 `input/textarea`
- 正文控件是否为富文本 `contenteditable`
- 执行层当前 `op: 'input'` 在真实 executor 中是走 `insertText`、`fill`、`set value` 还是统一抽象
- 输入后 DOM 中值落在 `value`、`innerText`、`textContent` 还是内部子节点
- 输入后是否需要 focus / click 激活编辑器

#### 可能的应对

- 若标题/正文是 `contenteditable`：
  - 执行层需优先走真实键盘输入或 `insertText`
  - `PublishStepValidator.readInputValue()` 可能要更偏向 `textContent`
- 若标题是 `input`、正文是富文本：
  - 可能需要按 actionId 区分不同输入策略
- 若正文编辑器是复杂富文本：
  - 可能需要在 executor 层增加“先 click 再 input”的稳定流程

### 2.3 话题标签是纯文本输入还是搜索下拉选择

#### 真机要验证什么

- 输入标签时，是否只是把文本写入正文/标签框即可
- 是否会弹出搜索建议列表
- 是否必须点击某个候选项，标签才真正生效
- 候选项是否带固定 role/text，可否稳定定位
- 多标签时是重复打开选择器，还是一次输入多个

#### 可能的应对

- 若是纯文本输入：
  - 当前 `input_tag` 单步模型可继续沿用
- 若是搜索下拉选择：
  - `publishPost()` 需要把 `input_tag` 扩展为至少两步
    - 输入标签关键字
    - 点击候选项
  - 可能新增 actionId，例如 `note.publish_tag_candidate`
  - `PublishStepValidator` 需从“页面出现文本”升级为“标签 chip 已挂载”

### 2.4 发布按钮二次确认弹窗

#### 真机要验证什么

- 点击发布后是否出现确认弹窗、风险提示、协议确认、草稿提示
- 弹窗按钮文案是什么，例如「确认发布」「继续发布」「知道了」
- 弹窗是否属于 guard 场景，还是 publish flow 的正常步骤
- 弹窗出现后 URL / DOM 是否仍停留在编辑页

#### 可能的应对

- 若是稳定存在的确认弹窗：
  - 应把它纳入 publish flow 正常步骤，而不是依赖 guard
  - 新增 `confirm_publish` 步骤更稳
- 若是偶发风险提示：
  - 可考虑在 `src/locating/guard.ts` 增加 guard rule
- 若弹窗按钮文案与主发布按钮相似：
  - 需要额外 scope 限定弹窗容器，避免误点原页面按钮

### 2.5 postId 真实提取规则

#### 真机要验证什么

- 发布成功后浏览器 URL 的真实格式
- 是否发生整页跳转、SPA 路由切换，还是仅局部刷新
- DOM 中是否存在稳定属性承载 noteId/postId
- 若跳到详情页，详情页链接/分享按钮/数据属性中哪个最稳定
- 若跳到列表页，新发布卡片是否可通过首项链接提取 id

#### 可能的应对

- 若 URL 稳定：
  - 优先从当前页面 URL 提取，而不是扫描 DOM `href`
- 若 DOM 属性稳定：
  - 扩充 `extractPostId()` 的属性白名单
- 若成功后停留列表页：
  - `validate_publish` 可能要改为“找到最新发布卡片并提取链接”
- 若无法立即拿到 postId：
  - 需要增加等待/轮询策略，而不是一次性校验

### 2.6 登录态 / 草稿态 / 非目标域名等前置条件

#### 真机要验证什么

- 联调浏览器是否已登录小红书
- 当前页面域名是否就是目标站点发布入口域名
- 是否存在未完成草稿、草稿恢复弹窗、创作草稿箱干扰
- 是否需要固定从某个 URL 起步，避免落在非发布上下文
- 是否存在权限限制、风控页、未实名认证提示等前置阻断

#### 可能的应对

- 在真机联调 SOP 中明确：
  - 先确认登录态
  - 先确认目标域名
  - 先清理草稿/弹窗
- 若这些阻断稳定出现：
  - 可考虑在 guard 层补规则
  - 或在 publish flow 前增加 preflight 检查步骤

## 3. 真机联调 step-by-step checklist

以下 checklist 面向后续真实浏览器联调阶段，当前仅作为执行脚本与观察模板。

### 3.1 联调前准备

1. 准备一个已登录小红书的浏览器用户目录
2. 以远程调试方式启动浏览器，例如带 CDP 端口
3. 打开目标站点并确认账号已登录、可进入创作相关页面
4. 清理可能干扰的弹窗、草稿恢复提示、风控提示
5. 记录起始 URL、域名、页面标题、是否 SPA

### 3.2 接入方式建议

- 使用“已登录浏览器 + CDP 远程调试端口”接入
- 联调时优先保留浏览器可视界面，便于人工同步观察
- 每一步都同时记录：
  - 当前 URL
  - 目标元素 outerHTML 关键片段
  - 元素 tag / role / aria-label / placeholder / title / data-* / class 中可读语义
  - 操作前后 DOM 是否变化
  - 操作后是否满足当前 `PublishStepValidator`

### 3.3 逐步联调顺序

#### Step 1：确认发布入口

- 从预期起始页开始
- 人工定位“发布/创作”入口
- 记录：
  - 入口文案
  - 元素标签与 role
  - 是否存在多个相似入口
  - 点击后跳转路径
- 判断当前 `XHS_PUBLISH_ENTRY_GOAL / ANCHOR_HINT` 是否足够

#### Step 2：确认发布页 scope 容器

- 进入发布页后，检查页面是否存在以下任一容器语义
  - `publish-container`
  - `publishContainer`
  - `note-edit`
  - `noteEdit`
  - `creator-container`
- 若不存在，记录真实容器 class / data-* / 结构特征
- 判断 `XHS_PUBLISH_SCOPE.selector` 是否需要替换或补充

#### Step 3：确认标题输入控件

- 点击标题区域
- 记录：
  - 元素标签
  - 是否 `contenteditable=true`
  - placeholder / aria-label / title / data-placeholder
  - 输入后值落在哪个属性/节点
- 用一段测试标题输入，观察当前 validator 的“包含匹配”是否成立

#### Step 4：确认正文输入控件

- 点击正文区域
- 记录：
  - 是否富文本编辑器
  - 是否需要先 focus
  - 输入后 DOM 结构变化
  - 是否存在多层嵌套 editable 节点
- 判断 executor 未来应使用何种输入策略

#### Step 5：确认标签交互模型

- 尝试添加一个简单标签
- 记录：
  - 标签入口是按钮还是文本框
  - 输入后是否出现候选下拉
  - 是否必须点击候选项
  - 成功后标签以何种 DOM 形式展示
- 若存在候选列表，记录候选项容器与候选项元素特征

#### Step 6：确认提交发布行为

- 在测试内容完整后点击发布
- 记录：
  - 发布按钮真实文案
  - 是否出现 loading / toast / 二次确认弹窗
  - 若有弹窗，按钮文案与容器特征
  - 点击后 URL 与页面结构变化

#### Step 7：确认成功校验与 postId 提取

- 发布成功后立即记录：
  - 最终 URL
  - 页面中包含 noteId/postId 的 DOM 片段
  - 是否能从链接、属性、脚本数据中提取 id
- 对照 `extractPostId()` 当前规则，判断：
  - 哪些规则可保留
  - 哪些规则需新增
  - 是否应优先从 URL 提取

### 3.4 联调记录模板

建议真机阶段每一步至少记录以下字段：

| 字段 | 说明 |
| --- | --- |
| step | entry/title/content/tag/submit/verify |
| pageUrlBefore | 操作前 URL |
| pageUrlAfter | 操作后 URL |
| targetSummary | 目标元素一句话描述 |
| tagRole | 元素 tag + role |
| textSignals | text / aria-label / placeholder / title / data-placeholder |
| scopeContainer | 所属容器特征 |
| actionTaken | click / input / candidate click |
| validatorResult | 当前后置校验是否成立 |
| notes | 异常、弹窗、歧义点 |

## 4. 预判需要的代码改动点

以下为真机阶段最可能需要快速调整的位置，按“文件:函数/常量”列出。

### 4.1 高概率调整：锚点常量

#### `src/flows/anchors.ts`

- `XHS_PUBLISH_ENTRY_GOAL`
  - 若真实入口不是“发布”语义，需改文案描述
- `XHS_PUBLISH_ENTRY_ANCHOR_HINT`
  - 可能调整 `role`
  - 可能调整 `text`
  - 可能补充 `scope`

- `XHS_PUBLISH_TITLE_GOAL`
  - 若真实标题文案不是“标题/填写标题/输入标题”，需补充真实提示词
- `XHS_PUBLISH_TITLE_ANCHOR_HINT`
  - 可能调整 `role='textbox'`
  - 可能补充更准确的 `text`
  - 可能依赖新的 `scope`

- `XHS_PUBLISH_CONTENT_GOAL`
  - 若正文编辑器真实提示词不同，需补充
- `XHS_PUBLISH_CONTENT_ANCHOR_HINT`
  - 可能保留 `textbox`，也可能需要更宽松策略

- `XHS_PUBLISH_TAG_GOAL`
  - 若真实交互是“添加话题”而非“标签输入框”，需改目标描述
- `XHS_PUBLISH_TAG_ANCHOR_HINT`
  - 已为 `role:'button'` + 文本「话题」；真机若发现入口实为文本框/`generic` 或需"输入后点候选"，再调角色/文本或扩步骤

- `XHS_PUBLISH_SUBMIT_GOAL`
  - 若最终按钮文案不是“发布/立即发布/确认发布”，需改
- `XHS_PUBLISH_SUBMIT_ANCHOR_HINT`
  - 若存在多个“发布”按钮，需增加更强约束

- `XHS_PUBLISH_SCOPE`
  - 真机最可能需要补 selector
  - 若发布页容器完全不同，这是首要调整点

### 4.2 高概率调整：flow 步骤逻辑

#### `src/flows/publish-post.ts:PublishStepValidator.validate`

- `enter_publish_page`
  - 当前只看标题/正文关键词，若真实发布页首屏无这些文本，需改成功判据

- `input_title`
  - 若真实标题控件不是简单 `value/textContent` 可读，需改读取逻辑

- `input_content`
  - 若正文是复杂富文本，当前 `readInputValue()` 可能不足

- `input_tag`
  - 当前只要页面任意位置出现 tag 文本就算成功，误判风险最高
  - 真机后大概率要改为“标签 chip/已选话题区域命中”

- `submit_publish` / `validate_publish`
  - 当前完全依赖 `extractPostId()`
  - 若真实成功路径不是立即可提取 postId，需改为多阶段校验

#### `src/flows/publish-post.ts:extractPostId`

- 高概率需要补充：
  - 新 URL pattern
  - 新 data-* 属性
  - 从当前页面 URL 直接提取
  - 从成功页卡片链接提取

#### `src/flows/publish-post.ts:publishPost`

- 若标签需要候选点击：
  - `for (const tag of payload.tags)` 内逻辑需扩展
- 若提交后有确认弹窗：
  - `submit_publish` 后需新增确认步骤
- 若成功校验需要等待：
  - 末尾 `finalValidator` 前后可能需要轮询/等待机制

### 4.3 可能波及：定位层能力

#### `src/locating/extractor.ts:extractInteractiveElements`

- 若真实目标元素不是传统 interactive 标签，也无 role，但有稳定语义 class / data-*：
  - 可能需要补充可交互识别规则
- 若 scope 容器在 portal 中：
  - 需确认 `scopeFallback: 'root'` 是否足够，还是需要更精确 scope

#### `src/locating/selector.ts:buildSelectionPrompt`

- 若真实页面大量相似元素并且文本弱：
  - 可能需要在 prompt 中加入更具体的发布页上下文描述

#### `src/locating/engine.ts:resolveAndAct`

- 当前流程适合“单步定位 -> 单步执行 -> 单步校验”
- 若标签选择、确认弹窗成为常态：
  - 更可能在 flow 层扩步骤，而不是直接改 engine

## 5. 静态盘点结论

`anchors.ts` 的发布锚点文本（标题 placeholder「填写标题会有更多赞哦」、正文 `ProseMirror`、标签「话题」按钮、提交「发布」按钮 + `classHint:'submit'`）已按真实小红书 creator DOM 校准，不再是”理想化 fake DOM”。基于当前源码静态分析，真机联调仍未实测、不确定性最高的集中在四处**运行时行为**：

1. `XHS_PUBLISH_SCOPE` 是否能命中真实发布页容器（提交按钮锚点已不挂 scope，但标题/正文/标签仍依赖 scope）
2. 执行层 `op:'input'` 对 `ProseMirror` 富文本与标题输入框的真实写入方式（`insertText` / 模拟键盘 / set value）及取值落点是否与 `readInputValue()` 一致
3. 标签是否需要”输入后点击候选项”的扩展步骤（当前 `input_tag` 仅单步、后置校验偏宽松）
4. 发布成功后的 `postId` / 分享链接是否能按当前 `extractPostId()` / `extractPostUrl()` 规则稳定提取

当前 publish flow 的整体编排方式是合理的；真机阶段建议优先验证 scope 命中、输入控件写入与取值、标签候选交互、成功页 URL 与 postId/分享链接提取，这四项一旦确认，后续代码调整路径会非常直接。

## 6. 备注

- 本次仅产出文档，未修改 `src/flows/publish-post.ts`、`src/flows/anchors.ts`、`src/locating/*` 业务代码
- 工作区可能存在与本任务无关的未提交改动（如 `src/browse/browse-session.ts`）
- 若后续需要提交本次文档改动，建议提交时仅暂存本文档，避免混入无关文件