/**
 * aidcp-edge 边缘端公共出口。
 *
 * 能力：
 * - locating：DOM-first 定位层引擎（锚点缓存 + 一致性消歧 + 文本LLM选择 + 三道闸 + 守卫层）。
 * - cdp     ：通过原生 WebSocket CDP 把引擎接到真实 Chrome，提供 DomProvider / ActionExecutor。
 * - comm    ：边-云通信协议定义（与云端同源）。
 * - flows   ：业务流程（点赞等垂直切片）。
 * - client  ：边-云 WS 客户端（接收命令、派发执行、回传结果）。
 * - browse  ：浏览执行层（自动浏览 explore feed：滚动/打开/提取/搜索/会话编排）。
 */
export * from './locating/index.js';
export * from './cdp/index.js';
export * from './comm/index.js';
export * from './flows/index.js';
export * from './client/index.js';
export * from './browse/index.js';
