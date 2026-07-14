/**
 * 浏览执行层共用的 CDP 工具。
 *
 * 浏览循环里大量需要"在真实页面里跑一段 JS 取结果"或"派发硬件级输入事件"，
 * 这些都是对 CdpClient.send 的薄封装。抽出来便于各 browse 模块复用 + 单测打桩。
 *
 * 只依赖 `send(method, params)` 这一最小子集（与 cdp/dom-provider.ts 的假客户端同形），
 * 因此测试里用一个 `{ send }` 对象即可注入。
 *
 * 拟人化（见 docs/risk-control.md §3 / docs/anti-detection.md §5）：
 *  - dispatchClick 不再瞬移落点，而是先沿贝塞尔轨迹逐帧 mouseMoved 再 press/release；
 *  - dispatchKeystrokes 逐字符派发，按键间隔服从键盘节奏（替代一次性 insertText）。
 */

import {
  generateMousePath,
  type Point,
  generateKeyStrokes,
  type RandomFn as HumanRandomFn,
  defaultRandom as humanDefaultRandom,
  jitterAround,
} from '../humanize/index.js';

/** browse 模块需要的最小 CDP 能力（与 CdpClient 兼容） */
export interface BrowseCdp {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /**
   * 订阅事件（CDP 事件与 cdp.reconnected/cdp.unrecoverable 生命周期事件共用）。
   * 可选：真实 CdpClient 提供；纯 { send } 测试桩可省略（续跑/重连感知随之降级为不可用）。
   */
  on?(method: string, listener: (params: unknown) => void): () => void;
}

interface EvaluateResult {
  result?: { type: string; value?: unknown };
  exceptionDetails?: { text: string };
}

/** 随机源类型（注入便于测试确定性） */
export type RandomFn = () => number;

/** 默认随机源 */
export const defaultRandom: RandomFn = Math.random;

/** 默认 sleep（测试可注入） */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 在页面里 eval 一段表达式，期望其返回 JSON 字符串，解析为 T。
 * 用 returnByValue 取回字符串，再在 Node 侧 JSON.parse，避免 CDP 对象引用的复杂度。
 */
export async function evalJson<T>(cdp: BrowseCdp, expression: string): Promise<T> {
  const res = await cdp.send<EvaluateResult>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`Runtime.evaluate 失败: ${res.exceptionDetails.text}`);
  }
  const value = res.result?.value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }
  return value as T;
}

/** 在页面里 eval 一段表达式，返回布尔/原始值（不强制 JSON）。 */
export async function evalRaw<T = unknown>(cdp: BrowseCdp, expression: string): Promise<T> {
  const res = await cdp.send<EvaluateResult>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`Runtime.evaluate 失败: ${res.exceptionDetails.text}`);
  }
  return res.result?.value as T;
}

/** 拟人化点击选项 */
export interface DispatchClickOptions {
  /** 起始光标位置（默认从目标左上方一段距离处起步） */
  from?: Point;
  /** 是否模拟 overshoot（默认 15% 概率，由调用方决定时可显式传 true/false） */
  overshoot?: boolean;
  /** 落点抖动幅度(px)，默认 3 */
  jitter?: number;
  /** 随机源 */
  random?: HumanRandomFn;
  /** 注入 sleep（逐帧移动间的微延迟用） */
  sleep?: (ms: number) => Promise<void>;
  /** 逐帧移动间的延迟(ms)，默认 8（约 120fps，自然且不拖慢） */
  moveDelayMs?: number;
  /**
   * 逐帧延迟是否叠对数正态抖动（change captcha-assist-humanize-click）。默认 false = 固定 moveDelayMs
   *（等周期，浏览路径零回归）。true = 每帧 `jitterAround(moveDelayMs)`，打散 dt 方差为 0 的机器特征
   *（验证码等高审查场景用）。
   */
  moveDelayJitter?: boolean;
  /**
   * 移动到位后、按下之前的读图/瞄准停顿(ms)（change captcha-assist-humanize-click）。默认 0 = 无停顿
   *（现有 click 零回归）。>0 时在 hover 与 press 之间插一段可注入 sleep 的 dwell。
   */
  hoverDwellMs?: number;
  /**
   * 可选的整体操作截止时刻。只在下一条输入尚未发出时检查，绝不取消已经发出的 CDP 命令；
   * 这样调用方可在安全边界收敛长点击，而不会让页面写操作与后续任务并发。
   */
  deadlineAt?: number;
  /** deadlineAt 对应的墙钟（测试可注入，默认 Date.now）。 */
  clock?: () => number;
}

/** 拟人化输入在发送下一条 CDP 事件前发现预算已耗尽。 */
export class InputDispatchDeadlineError extends Error {
  constructor(public readonly deadlineAt: number) {
    super(`输入操作超过截止时间 deadlineAt=${deadlineAt}`);
    this.name = 'InputDispatchDeadlineError';
  }
}

/** 截止时刻契约：点击与逐字输入共用。缺省（无 deadlineAt）即完全不设限，行为与历史一致。 */
interface InputDeadlineOptions {
  deadlineAt?: number;
  clock?: () => number;
}

function assertInputDeadline(options: InputDeadlineOptions): void {
  if (options.deadlineAt === undefined) return;
  const clock = options.clock ?? Date.now;
  if (clock() >= options.deadlineAt) throw new InputDispatchDeadlineError(options.deadlineAt);
}

/**
 * 沿拟人化贝塞尔轨迹把光标移动到 (x, y)，**只 mouseMoved、不 press/release**（纯 hover）。
 * 返回轨迹末点（已含抖动/回拉），供 dispatchClick 复用为落点，或供调用方在 hover 触发的
 * 悬浮面板上继续操作。
 *
 * 用途：某些控件是 **hover 展开** 的悬浮面板（如小红书搜索结果页「筛选」）——对其直接
 * dispatchClick 会「移动上去 hover 展开 → 紧接着 click 又切回收起」，面板内选项永远点不到。
 * 这类控件应先 dispatchHover 展开、再对面板内目标 dispatchClick；且点击面板内目标时把
 * `from` 设为该 hover 控件的坐标，让移动路径落在「控件→面板」区域内、避免中途 mouseleave 收起。
 */
export async function dispatchHover(
  cdp: BrowseCdp,
  x: number,
  y: number,
  options: DispatchClickOptions = {},
): Promise<Point> {
  const random = options.random ?? humanDefaultRandom;
  const sleep = options.sleep ?? defaultSleep;
  const moveDelay = options.moveDelayMs ?? 8;
  const jitter = options.jitter ?? 3;
  // 默认起点：目标左上方一段随机距离（模拟光标本来在别处）
  const from: Point =
    options.from ?? {
      x: x - (40 + random() * 120),
      y: y - (40 + random() * 120),
    };
  // 默认 ~15% 概率 overshoot
  const overshoot = options.overshoot ?? random() < 0.15;

  const path = generateMousePath({ from, to: { x, y }, overshoot, jitter, random });

  let last: Point = from;
  for (const pt of path) {
    assertInputDeadline(options);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    last = pt;
    // 逐帧延迟：默认固定；开抖动时每帧走 lognormal（消 dt 方差=0 的机器特征）。
    const delay = options.moveDelayJitter ? jitterAround(moveDelay, 0.35, random) : moveDelay;
    if (delay > 0) await sleep(delay);
  }
  return last;
}

/**
 * 在 (x, y) 派发一次拟人化鼠标点击。
 *
 * 流程（docs/anti-detection.md §5.1）：
 *  1. 从 from（默认目标附近）沿三阶贝塞尔轨迹逐帧 mouseMoved（ease-in-out 速度，见 dispatchHover）；
 *  2. 偶发 overshoot 后回拉；
 *  3. 在落点 mousePressed + mouseReleased。
 *
 * 保持与旧签名兼容：`dispatchClick(cdp, x, y)` 仍可直接调用。
 */
export async function dispatchClick(
  cdp: BrowseCdp,
  x: number,
  y: number,
  options: DispatchClickOptions = {},
): Promise<Point> {
  // 落点 = 轨迹末点（已含抖动/回拉）；hover 与 click 共用同一移动实现，口径不漂移。
  const last = await dispatchHover(cdp, x, y, options);
  // 落点前读图/瞄准停顿（默认 0，普通 click 零回归）。
  const dwell = options.hoverDwellMs ?? 0;
  if (dwell > 0) {
    assertInputDeadline(options);
    await (options.sleep ?? defaultSleep)(dwell);
  }
  const base = { x: last.x, y: last.y, button: 'left' as const, clickCount: 1 };
  assertInputDeadline(options);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  assertInputDeadline(options);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  // 返回真实落点（含 jitter/overshoot 残差），供多点循环把上一落点作下一点起点、保光标连续。
  return last;
}

/** 派发一次按键（press + release），key/code 形如 'Escape' / 'Enter'。 */
export async function dispatchKey(
  cdp: BrowseCdp,
  key: string,
  code: string,
  windowsVirtualKeyCode?: number,
): Promise<void> {
  const common: Record<string, unknown> = { key, code };
  if (windowsVirtualKeyCode !== undefined) {
    common.windowsVirtualKeyCode = windowsVirtualKeyCode;
    common.nativeVirtualKeyCode = windowsVirtualKeyCode;
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

/** 派发 ESC 键 */
export function pressEscape(cdp: BrowseCdp): Promise<void> {
  return dispatchKey(cdp, 'Escape', 'Escape', 27);
}

/** 派发 Enter 键 */
export function pressEnter(cdp: BrowseCdp): Promise<void> {
  return dispatchKey(cdp, 'Enter', 'Enter', 13);
}

/** 把一段文本一次性插入（Input.insertText，简单可靠；仅在不需要拟人节奏时用）。 */
export async function insertText(cdp: BrowseCdp, text: string): Promise<void> {
  await cdp.send('Input.insertText', { text });
}

/** 拟人化逐字符输入选项 */
export interface DispatchKeystrokesOptions {
  /** 随机源 */
  random?: HumanRandomFn;
  /** 注入 sleep */
  sleep?: (ms: number) => Promise<void>;
  /**
   * 可选的整体输入截止时刻。逐字输入是 O(文本长度) 的操作，调用方（云端下发的单步预算）需要
   * 能让它**在安全边界内停手**——否则调用方放弃后这条循环仍在往活着的编辑器里写字，
   * 造成「上游已判失败、页面上却躺着半篇正文」的错位。
   *
   * 语义：只在下一个字符尚未发出时检查，绝不取消已经发出的 CDP 命令；超时即抛
   * InputDispatchDeadlineError，**已输入的部分留在编辑器里**，由调用方负责清场并诚实回报。
   * 缺省（不传）＝完全不设限，行为与历史逐字节一致。
   */
  deadlineAt?: number;
  /** deadlineAt 对应的墙钟（测试可注入，默认 Date.now）。 */
  clock?: () => number;
}

/**
 * 逐字符拟人化输入一段文本（docs/anti-detection.md §5.2）。
 *
 * 为每个字符按键盘节奏采样"距上一键的延迟"，先 sleep 再用 Input.insertText 输入单字符，
 * 形成不均匀的真人打字节奏（替代一次性 insertText）。
 *
 * @returns 实际已输入的字符数（未设 deadlineAt 时恒等于文本长度）。
 * @throws InputDispatchDeadlineError 设了 deadlineAt 且在输完前耗尽。
 */
export async function dispatchKeystrokes(
  cdp: BrowseCdp,
  text: string,
  options: DispatchKeystrokesOptions = {},
): Promise<number> {
  const random = options.random ?? humanDefaultRandom;
  const sleep = options.sleep ?? defaultSleep;
  const strokes = generateKeyStrokes(text, { random });
  let typed = 0;
  for (const stroke of strokes) {
    if (stroke.delay > 0) await sleep(stroke.delay);
    assertInputDeadline(options);
    await cdp.send('Input.insertText', { text: stroke.char });
    typed++;
  }
  return typed;
}

/**
 * 在 [minMs, maxMs] 区间取一个随机延迟并等待，模拟人类节奏。
 * sleep 可注入（测试用），random 可注入（确定性）。
 *
 * 注：新代码应优先用 humanize 的对数正态 sampleDelay；此函数保留作兼容/简单场景。
 */
export async function randomDelay(
  minMs: number,
  maxMs: number,
  random: RandomFn = defaultRandom,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  const ms = Math.round(lo + (hi - lo) * random());
  if (ms > 0) await sleep(ms);
}
