# publish flow 真机联调进展记录

更新时间：2026-06-02

## 本轮目标

阶段四真机端到端发布：在真实小红书环境中跑通 `publishPost`，最终真实发布一条测试笔记。

用户已明确授权 B 方案（真实发布、不可逆、会出现在账号主页）。

当前状态：**尚未真实发布**，本轮先完成真机适配中间态收口与文档沉淀。

## 根因链与踩坑记录（按时间顺序）

### 1. 后台 nohup 无 TTY，首次启动读不到 Enter

- 早期 `chrome-launcher` 首次启动依赖“人工登录后按 Enter 继续”
- 但后台常驻 edge 使用 `nohup` 启动，没有可交互 TTY
- 结果：edge 会卡在等待 Enter，无法继续真机联调

处理：

- 已改为 **CDP 自动检测登录态后继续**
- 相关提交：`7ee536d fix: auto-detect xiaohongshu login`

### 2. `enter_publish_page` 旧判据只看标题/正文关键词，与真实页面不符

旧逻辑问题：

- `PublishStepValidator.enter_publish_page` 只接受页面出现「标题 / 正文 / 写点什么」等关键词
- 真实小红书流程并不会直接落到最终编辑页
- 因此即使入口点击成功，也会被误判为未进入发布页

处理：

- 放宽发布入口目标词
- 新增 `isPublishPage()` 多信号判定
- 允许通过发布页相关文案 / actionId / 话题等信号判断

### 3. 点击侧边栏“发布” `<a>` 链接，SPA 没真正切页

真实观察：

- LLM 能选中 explore 页侧边栏“发布”链接
- 该元素真实是：
  - `tag: a`
  - `text: 发布`
  - `href: https://creator.xiaohongshu.com/publish/publish?source=official`
- 但点击后：
  - 当前 CDP session 仍停留在 `https://www.xiaohongshu.com/explore`
  - `/json` 中也始终只有 explore page target

结论：

- 不能依赖“点击侧边栏发布链接”进入 creator 发布页
- 应直接导航到 creator publish URL

### 4. 改为直接 `Page.navigate` 到 creator publish URL，成功到达 creator 子域

当前采用的最稳妥方案：

- 在**当前已 attach 成功的 explore page session 上**
- 直接执行：

```ts
Page.navigate('https://creator.xiaohongshu.com/publish/publish?source=official')
```

结果：

- 当前 session 不变
- CDP 连接不变
- 成功到达：
  - `https://creator.xiaohongshu.com/publish/publish?source=official`
- 页面标题：
  - `小红书创作服务平台`
- 说明：
  - 主站登录态已成功延续到 creator 子域
  - 不需要再走 create_target / 切 session 的复杂路线

### 5. 当前最新卡点：到达的是 creator“发布方式选择页”，不是最终图文编辑页

当前 creator 页真实信号：

- `发布笔记`
- `上传视频`
- `上传图文`
- `写长文`
- `发播客`
- `草稿箱`

结论：

- 当前到达的是 **creator 发布方式选择页**
- 还没有进入最终图文编辑页
- 因此当前还看不到：
  - 标题输入框
  - 正文编辑器
  - 标签输入
  - 最终发布按钮

### 6. “上传图文” 入口仍未稳定点进最终编辑页

当前脚本已尝试：

- 在 creator 选择页中查找包含“上传图文”的元素
- 对其执行 `scrollIntoView + click`
- 然后轮询等待最终编辑页信号

但当前结果：

- 页面仍停留在 creator 选择页
- 尚未进入最终图文编辑页

可能原因：

- “上传图文”真实可点击元素不是当前命中的文本节点本身
- 可能需要点击其外层卡片 / 按钮容器
- 也可能存在事件代理、遮罩层、内部路由等待等问题

### 7. 图文发布是否必须至少上传 1 张图片：**待确认**

当前尚未进入最终图文编辑页，因此还不能可靠判断：

- 是否必须先上传图片
- 是否允许无图直接填写标题/正文并发布

从产品常识看，小红书图文发布**大概率至少需要 1 张图片**，但必须等进入最终编辑页后再以真实 DOM / 表单校验信号确认。

## 当前各步状态

### enter

- 状态：**部分打通**
- 已完成：
  - 从 explore 页直接 `Page.navigate` 到 creator publish URL
  - 成功到达 creator 子域选择页
- 未完成：
  - 从 creator 选择页继续进入“上传图文”最终编辑页

### 选择上传图文

- 状态：**待做**
- 当前脚本已尝试点击“上传图文”
- 但尚未稳定进入最终图文编辑页

### title

- 状态：**未到**
- 原因：最终图文编辑页尚未进入，标题输入框尚未出现

### content

- 状态：**未到**

### tags

- 状态：**未到**

### submit

- 状态：**未到**

## 下一步 TODO

1. 在 creator 选择页上精确定位“上传图文”真实可点击元素
2. 成功进入最终图文编辑页
3. 确认是否必须先上传图片
4. 若必须传图，先由用户确认测试图来源
5. dump 最终编辑页真实 DOM：
   - 标题输入框
   - 正文编辑器
   - 标签输入 / 话题入口
   - 发布按钮
6. 修正：
   - `src/flows/anchors.ts`
   - `src/flows/publish-post.ts`
7. 用 `--dry-run` 逐步跑通：
   - enter
   - title
   - content
   - tags
8. 前面全绿后，再执行最终提交真发
9. 发布成功后提取真实 `postId` 与可见位置

## 关键文件与入口

### 1. 本地真机调试入口

- `/Users/bears/aidcp-edge/scripts/dev-publish.ts`

用途：

- 复用 `attachToPage + EdgeClient + CloudElementSelector + publishPost`
- 支持 `--dry-run`
- 当前用于真机逐步联调

### 2. 发布锚点定义

- `/Users/bears/aidcp-edge/src/flows/anchors.ts`

### 3. 发布流程与后置校验

- `/Users/bears/aidcp-edge/src/flows/publish-post.ts`

### 4. 登录自动检测 / Chrome 启动

- `/Users/bears/aidcp-edge/src/cdp/chrome-launcher.ts`

## 运行方式备忘

### 后台常驻 edge 启动命令

```bash
nohup env AIDCP_AUTO_BROWSE=false pnpm start > /Users/bears/.aidcp-edge-logs/edge.out 2>&1 < /dev/null &
```

## 部署与重启提醒

- 本次修复属于代码变更，部署后必须重启对应进程才能生效，不会热加载。
- `edge` 对应提交：`ab8d71f`。
- 本次修复点：`src/main.ts` 已改为每次发布生成全新 `requestId`，不再复用 `process.env` 中的永久值。
- 重启对象：`edge` 常驻进程。
- 推荐后台启动方式：

```bash
nohup env AIDCP_AUTO_BROWSE=false pnpm start > /Users/bears/.aidcp-edge-logs/edge.out 2>&1 < /dev/null &
```

- 真发联调时需额外加上：

```bash
AIDCP_REAL_PUBLISH=true
```

- 验证修复前，务必确认当前运行中的 `edge` 进程是在部署 `ab8d71f` 之后重启拉起的。

## 通用排查提醒

- 涉及 TypeScript 源码改动后，若旧进程仍在运行，会继续执行旧逻辑，不会自动切到新代码。
- 典型现象：进程启动时间早于目标 commit 提交时间，说明当前进程大概率尚未加载新代码。
- 因此在验证修复是否生效前，必须先确认已使用最新代码完成重启，再进行联调或回归检查。

PID 文件：

- `/Users/bears/.aidcp-edge-logs/edge.pid`

日志文件：

- `/Users/bears/.aidcp-edge-logs/edge.out`
- `/Users/bears/.aidcp-edge-logs/chrome-stderr.log`

### dry-run 命令

```bash
pnpm exec tsx scripts/dev-publish.ts --dry-run --title='【测试请忽略】AIDCP 自动化发布联调' --content='这是AIDCP端到端发布功能的真机联调测试笔记,请忽略。' --tags='测试'
```

### 真发命令（后续恢复时再用）

```bash
pnpm exec tsx scripts/dev-publish.ts --title='【测试请忽略】AIDCP 自动化发布联调' --content='这是AIDCP端到端发布功能的真机联调测试笔记,请忽略。' --tags='测试'
```

### 查看 CDP target

```bash
curl -s http://127.0.0.1:9222/json
```

### 查看 CDP browser 信息

```bash
curl -s http://127.0.0.1:9222/json/version
```

## 当前结论

本轮真机联调已经把问题从“登录 / attach / creator 子域切换”收敛到最后一段：

- **当前真正未打通的只剩 creator 选择页 → 上传图文最终编辑页**

只要这一步打通，后续就可以继续：

- 确认是否必须上传图片
- dump 编辑页真实控件
- 修正 title/content/tags/submit
- dry-run 全绿
- 最终真实发布