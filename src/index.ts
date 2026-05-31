/**
 * aidcp-edge 边缘端公共出口。
 *
 * 两块能力：
 * - locating：DOM-first 定位层引擎（锚点缓存 + 一致性消歧 + 文本LLM选择 + 三道闸 + 守卫层）。
 * - cdp     ：通过原生 WebSocket CDP 把引擎接到真实 Chrome，提供 DomProvider / ActionExecutor。
 */
export * from './locating/index.js';
export * from './cdp/index.js';
