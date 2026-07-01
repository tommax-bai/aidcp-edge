/**
 * 入口级全局 WebSocket 兜底。
 *
 * 背景：Electron 打包后经 `ELECTRON_RUN_AS_NODE` 用 **Electron 自带 Node** 跑
 * `dist/main.js`（Electron 31 → Node 20，见 electron 依赖 @types/node ^20）。
 * 该运行时**没有全局 WebSocket**——全局 WebSocket 到 Node ≥22 才默认可用。
 *
 * 而边缘三处 WebSocket 消费方的默认工厂都落在全局 WebSocket 上：
 *  ① 登录态探测 `evaluateLoginState`（cdp/chrome-launcher.ts，默认 `new WebSocket(url)`）；
 *  ② CDP 客户端 `cdp/client.ts` 的 `defaultWsFactory`（读 `globalThis.WebSocket`）；
 *  ③ 云端边缘客户端 `client/edge-client.ts` 的 `defaultWsFactory`（读 `globalThis.WebSocket`）。
 * 全局缺失时，① 直接抛 `ReferenceError: WebSocket is not defined`，登录探测每轮报错、
 * 卡死在「等待小红书登录」；②③ 抛「global WebSocket 不可用」。
 *
 * 修复：入口最先安装本兜底——仅当运行时确无全局 WebSocket 时，用生产依赖 `ws` 补齐，
 * 一处覆盖上述三处（它们统一读同一个全局 WebSocket）。这与 `electron/chrome-launcher.cjs`
 * 已有的 `require('ws')` 做法一致。已有全局（本地 Node ≥22 / 浏览器）时不改动；
 * 单测各自注入假 wsFactory，也不受影响。
 */
import { WebSocket as WsWebSocket } from 'ws';

const globalRef = globalThis as { WebSocket?: unknown };
if (typeof globalRef.WebSocket === 'undefined') {
  globalRef.WebSocket = WsWebSocket;
}
