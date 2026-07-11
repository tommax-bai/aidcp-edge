# aidcp-edge

AIDCP（AI-Driven Control Plane）**边缘端**。运行在贴近浏览器的一侧，负责把
云端的高层指令在**真实页面**上稳定地定位、执行、拟人化与上报。

> **演进提示**：早期边缘端只有定位层（`locating/`）与 CDP 接入（`cdp/`）。
> 随云端重构为[事件驱动多 Agent](../aidcp-cloud) 与[协议 v2](../aidcp/docs/protocol.md)，
> 边缘端补齐了 `browse`（浏览执行层）、`humanize`（拟人化）、`flows`（点赞/发布流程）、
> `client`（边-云客户端）、`publish`（发布审批）与 `electron`（桌面打包），
> 并加入 `supervise`（多节点看护重起策略，配合 `start:multinode`）。

> 📐 **关键必读**：小红书 web 是**宽/窄双布局**（主导航在左侧栏 vs 底部图标栏），edge 的定位/动作/监测/验收都须按两状态分别处理 —— 见 [`docs/xhs-layout-states.md`](docs/xhs-layout-states.md)。

## 能力

- **定位层引擎（`src/locating/`）** — DOM-first：锚点缓存 + 多信号一致性消歧
  + 文本 LLM 选择 + 三道闸（后置校验 / 重试升级 / 反污染回写）+ 守卫层。
  纯函数式，作用于通用 DOM，可在 jsdom 中完整单测。
- **CDP 接入层（`src/cdp/`）** — 用**原生 WebSocket** 连接 Chrome DevTools Protocol
  （不依赖 Playwright / chrome-remote-interface），把引擎接到真实浏览器；含 Chrome 启动/登录检测与 stealth 反检测注入。
- **浏览执行层（`src/browse/`）** — 接收云端角色驱动指令，分发到 feed 滚动 / 弹窗 / 笔记提取 / 搜索 / 卡片过滤，并结构化上报（`page.cards`/`note.detail`）。
- **拟人化（`src/humanize/`）** — 对数正态停顿、贝塞尔鼠标轨迹、键盘节奏、滚动物理、阅读停留、会话疲劳曲线。
- **发布流程（`src/flows/publish-post.ts` + `src/publish/`）** — 发布六步（进入→标题→正文→标签→提交→校验）+ 审批信号等待。
- **桌面打包（`src/electron/`）** — 系统托盘 + Chrome 启动网关 + 控制面板 UI（状态/暂停恢复/重登）。

## 目录

```
src/
  locating/        定位层引擎（types/extractor/matcher/cache/selector/guard/engine）
  cdp/             CDP 客户端 + DomProvider/ActionExecutor + 会话装配
    client.ts        原生 WebSocket CDP RPC 客户端
    targets.ts       DevTools /json target 发现
    dom-provider.ts  DomProvider：Runtime.evaluate 取 outerHTML → jsdom 解析
    action-executor.ts ActionExecutor：结构路径→XPath，在浏览器侧执行
    session.ts       attachToPage()：发现→连接→产出 dom/executor
    chrome-launcher.ts Chrome 自启（默认独立实例）+ 登录检测（复用需 AIDCP_CDP_ALLOW_REUSE）
    stealth-injector.ts 反检测脚本注入
    file-input-setter.ts 发布配图上传：CDP DOM.setFileInputFiles 注入文件
    self-identity.ts 登录后读出自己账号稳定 userid
    index.ts         cdp 子模块公共出口
  browse/          浏览执行层（browse-session/feed-scroller/modal-controller/note-extractor/search-handler/card-filter）
  humanize/        拟人化（timing/mouse-path/keyboard-rhythm/scroll-physics/reading-time/session-rhythm）
  client/          边-云 WS 客户端（edge-client/cloud-selector/like-runner）
  flows/           垂直业务流程（anchors/like-post/publish-post）
  publish/         发布审批信号（approval-gate）
  comm/            协议定义投影（protocol，v2）
  electron/        桌面打包（main/preload/chrome-launcher.cjs + renderer/）
  supervise/       看护重起策略（respawn-policy；供 start:multinode 多节点看护使用）
  index.ts         边缘端公共出口（re-exports：locating/cdp/comm/flows/client/browse）
  main.ts          启动入口：装配 Chrome/CDP、云端连接、浏览会话
test/              locating / cdp / browse / client / publish / flows / humanize /
                   integration / acceptance / manual / supervise 测试（非穷举）
```

## 快速开始

```bash
npm install
npm test        # 运行全部测试
npm run typecheck
```

### 接入真实 Chrome

```bash
# 1) 以远程调试端口启动 Chrome
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/aidcp-profile \
  --disable-blink-features=AutomationControlled

# 2) 启动 edge（显式选择 dev 或 ol）
# dev: AIDCP_CLOUD_URL=ws://121.89.85.150:8787 npm start
# ol:  AIDCP_CLOUD_URL=ws://123.56.253.183:8787 npm start
npm start
```

> 注意：edge 默认**自启独立 Chrome**（专属调试端口 + user-data-dir），不会复用已在监听的 Chrome；
> 若要复用上面手动启动的 9222 实例，须显式设置 `AIDCP_CDP_ALLOW_REUSE=true`，否则端口被占会被拒绝启动。
> 详见 `docs/browser-cdp-status.md`。

```ts
import { attachToPage } from 'aidcp-edge';
import { LocatingEngine, AnchorCache /* ... */ } from 'aidcp-edge';

const session = await attachToPage({ host: '127.0.0.1', port: 9222 });
// session.dom / session.executor 可直接喂给 LocatingEngine
```

> 关键环境变量：`AIDCP_CLOUD_URL`（连云地址；dev=`ws://121.89.85.150:8787`，ol=`ws://123.56.253.183:8787`）、
> `AIDCP_CDP_HOST/PORT`、`AIDCP_CHROME_PROFILE`、
> `AIDCP_AUTO_BROWSE`、`AIDCP_REAL_PUBLISH`。详见总览仓 `aidcp/docs/handoff-2026-06-05.md`。

### 同机并行两个 GUI（如 dev + ol）

桌面客户端默认「一台机一个监督者」（单实例锁）。若要在同一台机器上并行两个 GUI（例如一个连 dev、一个连 ol），给每个实例设不同的 `AIDCP_USER_DATA_DIR`——它把该实例的**用户数据目录**（进而单实例锁 / 设置名册 / 界面状态 / 日志 / 内置运行时落地）整体隔离；未设时用默认目录、行为不变。

```bash
# 实例甲：dev（默认目录）
AIDCP_CLOUD_URL=ws://121.89.85.150:8787 npm run electron:dev

# 实例乙：ol（独立用户数据目录）
AIDCP_USER_DATA_DIR="$HOME/Library/Application Support/aidcp-edge-ol" \
AIDCP_CLOUD_URL=ws://123.56.253.183:8787 npm run electron:dev
```

> 并行前置（本机全局 AdsPower 服务与分身库两实例共享，仅 userData 被隔离）：
> - 两实例的 AdsPower 分身**不重叠**（同一分身被两实例驱动 = 两套操纵系上同一浏览器，且因连不同云不报错、静默互扰）；
> - **先起一个、待 AdsPower 本机服务稳定后再起第二个**（避免冷启动抢杀机器全局 50325 守护进程）；
> - 两实例保持默认 AdsPower 模式（self 模式会撞固定 9222 调试端口）。

## 与云端的关系

边缘端做**定位 + 执行 + 拟人化 + 本地缓存命中 + 结构化上报**；任务规划、事件驱动编排、
Qwen LLM 推理、风控、锚点持久化集中在 **aidcp-cloud**。两端通过 **WebSocket 协议 v2** 通信，
消息格式见总览仓 `aidcp/docs/protocol.md`。

> 约束：CDP 一律走原生 WebSocket；不引入重型浏览器自动化框架，保持边缘轻量。
> 部署口径：本地只跑 edge 连命名 ECS target 上的 cloud，本地不起 cloud。dev 连接
> `ws://121.89.85.150:8787`；ol 连接 `ws://123.56.253.183:8787` 或后续 ol 域名。
