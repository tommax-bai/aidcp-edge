/**
 * 拟人化节奏统一出口（HumanizedTiming）。
 *
 * 把停顿分布、会话疲劳曲线、贝塞尔鼠标轨迹、惯性滚动、键盘节奏、阅读时间汇聚到
 * 一处，供 browse 执行层（browse-session / cdp-util / feed-scroller / search-handler）
 * 统一引用，替换原先的均匀随机延迟与瞬时操作。
 *
 * 策略数值锚定 docs/risk-control.md §3 与 docs/anti-detection.md §5。
 */

export * from './timing.js';
export * from './session-rhythm.js';
export * from './mouse-path.js';
export * from './scroll-physics.js';
export * from './keyboard-rhythm.js';
export * from './reading-time.js';
