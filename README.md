# aidcp-edge

AIDCP（AI-Driven Control Plane）**边缘端**。运行在贴近浏览器的一侧，负责把
高层指令在**真实页面**上稳定地定位与执行。

## 能力

- **定位层引擎（`src/locating/`）** — DOM-first：锚点缓存 + 多信号一致性消歧
  + 文本 LLM 选择 + 三道闸（后置校验 / 重试升级 / 反污染回写）+ 守卫层。
  纯函数式，作用于通用 DOM，可在 jsdom 中完整单测。
- **CDP 接入层（`src/cdp/`）** — 用**原生 WebSocket** 连接 Chrome DevTools Protocol
  （不依赖 Playwright / chrome-remote-interface），把引擎接到真实浏览器：
  - `CdpDomProvider` 实现定位层的 `DomProvider`：从真实页面取 DOM 快照。
  - `CdpActionExecutor` 实现定位层的 `ActionExecutor`：click / input / scroll。

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
test/
  locating/        迁移自 aidcp 主仓的定位层测试
  cdp/             CDP 客户端 / Provider / Executor 测试
```

## 快速开始

```bash
npm install
npm test        # 运行全部测试（locating + cdp）
npm run typecheck
```

### 接入真实 Chrome

```bash
# 1) 以远程调试端口启动 Chrome
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/aidcp-profile

# 2) 在代码中附着到页面
```

```ts
import { attachToPage } from 'aidcp-edge';
import { LocatingEngine, AnchorCache /* ... */ } from 'aidcp-edge';

const session = await attachToPage({ host: '127.0.0.1', port: 9222 });
// session.dom / session.executor 可直接喂给 LocatingEngine
```

## 与云端的关系

边缘端只做**定位 + 执行 + 本地缓存命中**。任务规划、Qwen LLM 推理、锚点缓存的
持久化集中在 **aidcp-cloud**。两端通过 **WebSocket 协议**通信，消息格式见主仓
`docs/protocol.md`。

> 约束：CDP 一律走原生 WebSocket；不引入重型浏览器自动化框架，保持边缘轻量。
