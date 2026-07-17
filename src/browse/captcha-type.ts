/**
 * 验证码协助键入原语（change captcha-assist-text-answer）。
 *
 * 为什么**不复用 `cdp-util.ts` 的 `dispatchKeystrokes`**（spec «协助键入必须产生与字符数一一对应的
 * 真实键事件»）：它内部是逐字符 `Input.insertText`（`cdp-util.ts:334`），产生 **0 个
 * keydown/keypress/keyup**。「键事件数与字符数不匹配」是验证码厂商的成熟判据，而验证码正是其主战场
 * ——在最敏感的现场用零键事件的输入等于自曝。且它是 FB 发帖 / XHS 搜索 / FB 评论的热点依赖，
 * 改它的行为 = 改它们。故本模块另起一套，只服务 captcha assist。
 *
 * 字符集边界是**机制不是约定**：仅 ASCII 可见字符（0x20–0x7E）、无修饰键暴露、无功能键
 *（提交键由调用方单独派发）⇒ 键入序列在结构上不可能触发浏览器快捷键 / 开发者工具 / 导航。
 * 表外字符在注入前即被拒绝。
 *
 * 依赖闭包与 cdp-util 一致：只 `../humanize/index.js`，零业务依赖，脱 CDP 可单测。
 */

import {
  assertInputSafety,
  evalRaw,
  type BrowseCdp,
  type InputSafetyOptions,
} from './cdp-util.js';
import {
  generateKeyStrokes,
  gaussian,
  defaultRandom as humanDefaultRandom,
  type RandomFn,
} from '../humanize/index.js';

/** 键位描述：CDP `Input.dispatchKeyEvent` 需要的四件套 + 是否需要 Shift。 */
export interface KeySpec {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  needsShift: boolean;
}

/** 焦点分级（spec «协助键入必须在焦点落定后才派发字符»）。 */
export type FocusTier = 'editable' | 'opaque' | 'none';

export interface FocusProbeResult {
  tier: FocusTier;
  /** 持有焦点的元素 tag（'INPUT' / 'IFRAME' / 'CANVAS' …）。供事后取证，MUST NOT 据此分支。 */
  tag: string;
}

/** 清空结果三态：verified=回读确认为空；attempted=尽力清了但读不回来（绝不声称清空了）。 */
export type ClearOutcome = 'verified' | 'attempted';

function letterSpec(ch: string): KeySpec {
  const upper = ch.toUpperCase();
  return {
    key: ch,
    code: `Key${upper}`,
    windowsVirtualKeyCode: upper.charCodeAt(0),
    needsShift: ch !== ch.toLowerCase(),
  };
}

function digitSpec(ch: string): KeySpec {
  return { key: ch, code: `Digit${ch}`, windowsVirtualKeyCode: ch.charCodeAt(0), needsShift: false };
}

/**
 * Shift 上档字符 → 其无 Shift 的基键。用于把 '!' 派发成 Shift+Digit1（真人怎么打就怎么打），
 * 而不是凭空造一个不存在的键。
 */
const SHIFTED_BASE: Record<string, { code: string; vk: number }> = {
  '!': { code: 'Digit1', vk: 0x31 }, '@': { code: 'Digit2', vk: 0x32 }, '#': { code: 'Digit3', vk: 0x33 },
  $: { code: 'Digit4', vk: 0x34 }, '%': { code: 'Digit5', vk: 0x35 }, '^': { code: 'Digit6', vk: 0x36 },
  '&': { code: 'Digit7', vk: 0x37 }, '*': { code: 'Digit8', vk: 0x38 }, '(': { code: 'Digit9', vk: 0x39 },
  ')': { code: 'Digit0', vk: 0x30 }, _: { code: 'Minus', vk: 0xbd }, '+': { code: 'Equal', vk: 0xbb },
  '{': { code: 'BracketLeft', vk: 0xdb }, '}': { code: 'BracketRight', vk: 0xdd },
  '|': { code: 'Backslash', vk: 0xdc }, ':': { code: 'Semicolon', vk: 0xba }, '"': { code: 'Quote', vk: 0xde },
  '<': { code: 'Comma', vk: 0xbc }, '>': { code: 'Period', vk: 0xbe }, '?': { code: 'Slash', vk: 0xbf },
  '~': { code: 'Backquote', vk: 0xc0 },
};

/** 无 Shift 的标点 → 基键。 */
const PLAIN_PUNCT: Record<string, { code: string; vk: number }> = {
  ' ': { code: 'Space', vk: 0x20 }, '-': { code: 'Minus', vk: 0xbd }, '=': { code: 'Equal', vk: 0xbb },
  '[': { code: 'BracketLeft', vk: 0xdb }, ']': { code: 'BracketRight', vk: 0xdd },
  '\\': { code: 'Backslash', vk: 0xdc }, ';': { code: 'Semicolon', vk: 0xba }, "'": { code: 'Quote', vk: 0xde },
  ',': { code: 'Comma', vk: 0xbc }, '.': { code: 'Period', vk: 0xbe }, '/': { code: 'Slash', vk: 0xbf },
  '`': { code: 'Backquote', vk: 0xc0 },
};

/** ASCII 可见字符键位表。表外字符 = 诚实拒绝（返回 undefined），绝不猜。 */
export function keySpecFor(ch: string): KeySpec | undefined {
  if (ch.length !== 1) return undefined;
  if (/[a-zA-Z]/.test(ch)) return letterSpec(ch);
  if (/[0-9]/.test(ch)) return digitSpec(ch);
  const shifted = SHIFTED_BASE[ch];
  if (shifted) return { key: ch, code: shifted.code, windowsVirtualKeyCode: shifted.vk, needsShift: true };
  const plain = PLAIN_PUNCT[ch];
  if (plain) return { key: ch, code: plain.code, windowsVirtualKeyCode: plain.vk, needsShift: false };
  return undefined;
}

/** 答案长度上界（spec：1..24）。 */
export const CAPTCHA_TEXT_MAX_LEN = 24;

export type TextValidation = { ok: true } | { ok: false; reason: 'empty' | 'too_long' | 'unsupported_char' };

/**
 * 答案字符集/长度校验。**注入前**调用——与坐标越界校验同一位置纪律。
 * 畸形 = 整单拒绝（绝不"丢掉打字、只帮你点一下"，那正是静默假成功的形态）。
 */
export function validateCaptchaText(text: string): TextValidation {
  if (text.length === 0) return { ok: false, reason: 'empty' };
  if (text.length > CAPTCHA_TEXT_MAX_LEN) return { ok: false, reason: 'too_long' };
  for (const ch of text) {
    if (!keySpecFor(ch)) return { ok: false, reason: 'unsupported_char' };
  }
  return { ok: true };
}

const SHIFT_MODIFIER = 8;

/**
 * 派发一个字符：keyDown(text) → dwell → keyUp，需 Shift 时用真实 Shift 键包裹。
 *
 * **签名里没有 InputSafetyOptions —— 词法上就插不进取消点**（照抄 `commitLeftClick` 已定案的形状）。
 * 这里是「已执行、未收尾」窗口的键盘形态：keyDown 发了、keyUp 没发即抛出 = **按键卡在按下状态**，
 * 此后页面收到的一切都带着一个幽灵按键；Shift 更糟——Shift 卡住会把后续所有字符变成上档。
 * try/finally 保证 keyUp 与 Shift-up 必发，且不覆盖原始异常。
 */
async function commitKeyStroke(cdp: BrowseCdp, spec: KeySpec, dwellMs: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  const modifiers = spec.needsShift ? SHIFT_MODIFIER : 0;
  if (spec.needsShift) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Shift',
      code: 'ShiftLeft',
      windowsVirtualKeyCode: 0x10,
      nativeVirtualKeyCode: 0x10,
      modifiers: SHIFT_MODIFIER,
    });
  }
  try {
    const common = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
      modifiers,
    };
    try {
      // keyDown 带 text/unmodifiedText ⇒ 产生真实 keypress 形态（与 pressEnter 的 '\r' 同理）。
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text: spec.key, unmodifiedText: spec.key });
      if (dwellMs > 0) await sleep(dwellMs);
    } finally {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common }).catch(() => undefined);
    }
  } finally {
    if (spec.needsShift) {
      await cdp
        .send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 0x10, nativeVirtualKeyCode: 0x10, modifiers: 0 })
        .catch(() => undefined);
    }
  }
}

export interface HumanTypingOptions extends InputSafetyOptions {
  random?: RandomFn;
  sleep?: (ms: number) => Promise<void>;
  /** 按键间隔的对数正态中位(ms)。调用方按 edgeId 派生每机偏置后传入。 */
  medianMs?: number;
  /** 单键按下时长的中位(ms)，默认 75。 */
  dwellMedianMs?: number;
  /**
   * 每成功派发一个字符后回调实际累计数（change captcha-assist-text-answer，§5 接线所需）。
   * **抛出时（被抢占 / 超预算）函数不返回、局部 typed 计数丢失**，调用方拿不到已派发数就没法「如实回报
   * typed」——那正是 spec 要求区分「答案打错了」与「字根本没打进去」的凭据。调用方在闭包里存下最后一次
   * 回调值，catch 时即为真实派发数。MUST NOT 在此抛出（非取消点）。
   */
  onProgress?: (typed: number) => void;
}

const DWELL = { median: 75, sigma: 0.3, min: 30, max: 180 };

function sampleDwell(random: RandomFn, medianMs: number): number {
  const v = Math.exp(Math.log(medianMs) + DWELL.sigma * gaussian(random));
  return Math.round(Math.min(DWELL.max, Math.max(DWELL.min, v)));
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 逐字符拟人键入。
 *
 * 节奏复用 `generateKeyStrokes`（对数正态 flight、8% 想词长停顿、标点更慢），dwell 另采样。
 *
 * **RTT 补偿**（spec «协助键入的节奏必须拟人且不被传输层压平»）：每次 CDP 往返都有真实耗时，
 * 不扣除它则实际键间隔 = 采样值 + RTT，分布被整体右移；重载 AdsPower 下 RTT 可达上百毫秒，
 * 键间隔会趋近 RTT 地板 —— **花力气采样出来的对数正态被传输层抹平成常数**，拟人化在最敏感的
 * 现场失效。故从下一次 sleep 里扣掉上一次实测往返。
 *
 * 循环边界 = strokes 数组长度 ⇒ 天然按迭代次数限界，不存在「恒定 now 死循环」。
 *
 * @returns 实际派发的字符数。**调用方 MUST NOT 用 `typed || text.length` 之类回退到意图值**。
 * @throws 调用方 checkpoint 抛出的异常（被抢占）/ InputDispatchDeadlineError（超预算）。
 *         已派发的部分留在页面上，调用方 MUST 清场并如实回报 typed。
 */
export async function dispatchHumanTyping(cdp: BrowseCdp, text: string, options: HumanTypingOptions = {}): Promise<number> {
  const random = options.random ?? humanDefaultRandom;
  const sleep = options.sleep ?? defaultSleep;
  const clock = options.clock ?? Date.now;
  const dwellMedian = options.dwellMedianMs ?? DWELL.median;
  const strokes = generateKeyStrokes(text, { random, ...(options.medianMs ? { medianMs: options.medianMs } : {}) });

  let typed = 0;
  let lastRttMs = 0;
  for (const stroke of strokes) {
    const spec = keySpecFor(stroke.char);
    // 前置校验已挡住表外字符；这里是纵深防御——宁可少打也绝不派发一个猜出来的键位。
    if (!spec) break;
    const wait = Math.max(0, stroke.delay - lastRttMs);
    if (wait > 0) await sleep(wait);
    // 唯一正确的取消缝：这一字符的等待已结束、它的 CDP 写尚未发出。
    // 顺序 checkpoint→deadline 由 assertInputSafety 保证（接管优先于死线，不可反）。
    assertInputSafety(options);
    const startedAt = clock();
    const dwell = sampleDwell(random, dwellMedian);
    await commitKeyStroke(cdp, spec, dwell, sleep);
    typed++;
    options.onProgress?.(typed);
    // 实测往返里扣掉我们自己 sleep 的 dwell —— 剩下的才是传输层的账。
    lastRttMs = Math.max(0, clock() - startedAt - dwell);
  }
  return typed;
}

/**
 * 只读探测当前焦点并分级。
 *
 * - `none`（null / body / documentElement）= **唯一结构确定的失败** ⇒ 调用方 MUST 回 no_target、零派发。
 * - `editable`（INPUT 非 disabled/readOnly / TEXTAREA / contentEditable）= 可清、可回读，证据最强。
 * - `opaque` = 其余任何**持有焦点**的元素（iframe / shadow host / canvas / tabindex 容器）。
 *   MUST NOT 据此 fail-closed：厂商挂 tabindex 的 canvas 会真拿焦点，拒绝 = 确定的死路
 *   （无远程桌面后路）；而字符落在一个复检刚证明仍被遮罩挡住的页面上，遮罩的职能就是吃输入。
 *   打、但如实标 unverifiable。
 *
 * 探针抛错由调用方 fail-closed 处理（绝不盲打）。
 */
export async function probeFocus(cdp: BrowseCdp): Promise<FocusProbeResult> {
  const raw = await evalRaw<{ tier?: string; tag?: string }>(
    cdp,
    `(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) {
        return { tier: 'none', tag: el ? String(el.tagName || '') : '' };
      }
      const tag = String(el.tagName || '');
      const editable =
        (tag === 'INPUT' && !el.disabled && !el.readOnly) ||
        (tag === 'TEXTAREA' && !el.disabled && !el.readOnly) ||
        el.isContentEditable === true;
      return { tier: editable ? 'editable' : 'opaque', tag };
    })()`,
  );
  const tier: FocusTier = raw?.tier === 'editable' || raw?.tier === 'opaque' ? raw.tier : 'none';
  return { tier, tag: typeof raw?.tag === 'string' ? raw.tag : '' };
}

/** 读回已聚焦字段的**全文**（仅 editable 有意义）；读不到回 null。 */
export async function readFocusedText(cdp: BrowseCdp): Promise<string | null> {
  const raw = await evalRaw<{ text?: string | null }>(
    cdp,
    `(() => {
      const el = document.activeElement;
      if (!el) return { text: null };
      if (typeof el.value === 'string') return { text: el.value };
      if (el.isContentEditable === true) return { text: String(el.textContent == null ? '' : el.textContent) };
      return { text: null };
    })()`,
  );
  return typeof raw?.text === 'string' ? raw.text : null;
}

/** darwin 用 Meta(4) 全选，其余 Ctrl(2)。修饰键**只活在本原语内部**，绝不进运营的动作词汇。 */
const SELECT_ALL_MODIFIER = process.platform === 'darwin' ? 4 : 2;

async function pressBackspace(cdp: BrowseCdp): Promise<void> {
  const common = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
  try {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common });
  } finally {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common }).catch(() => undefined);
  }
}

/**
 * 清空已聚焦字段。**强制、非开关**（spec «协助键入前必须强制清空目标字段»）。
 *
 * 不清空 = 重试时残文与新答案拼接 = 在一个已 `restricted` 的账号上无界消耗挑战次数。
 *
 * 「盲发全选会选中整页」这个顾虑不成立：select-all 跟随焦点，而焦点闸已经先跑过了
 *（tier==='none' 根本走不到这里）；Backspace 导航返回自 Chrome 52 起已不存在。
 *
 * @returns `verified` = 回读确认为空；`attempted` = 尽力清了但读不回来（opaque）——**绝不声称清空了**。
 */
export async function clearFocusedField(cdp: BrowseCdp, tier: FocusTier): Promise<ClearOutcome> {
  if (tier === 'editable') {
    // 可读路径：用 JS 选中（比键盘全选确定），Backspace 删除，回读确认。
    await evalRaw(
      cdp,
      `(() => {
        const el = document.activeElement;
        if (!el) return false;
        try {
          if (typeof el.select === 'function') { el.select(); return true; }
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          return true;
        } catch { return false; }
      })()`,
    );
    await pressBackspace(cdp);
    const residual = await readFocusedText(cdp);
    return residual === '' ? 'verified' : 'attempted';
  }
  // 不可读路径（opaque）：只能键盘全选 + 删除，且无法证明清空了。
  const selectAll = {
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 0x41,
    nativeVirtualKeyCode: 0x41,
    modifiers: SELECT_ALL_MODIFIER,
  };
  try {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...selectAll });
  } finally {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...selectAll }).catch(() => undefined);
  }
  await pressBackspace(cdp);
  return 'attempted';
}
