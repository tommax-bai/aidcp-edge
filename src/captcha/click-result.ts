/**
 * 验证码协助点击 / 键入的**回执打包**（change restore-native-xiaohongshu-session-guards §3）。
 *
 * 从 `src/main.ts` 就地提取成纯函数，唯一动机是让它**可被行为断言**：宿主装配文件零导出，
 * 现有的全部 main.ts 用例都是源码正则断言，而正则断言恰恰是「死码把检查喂绿」的高发形态。
 *
 * 本文件守的那条不变量只有一句：
 *   **`inputMode: 'click_type'` 是一个关于「已经发生的事」的断言。**
 * 它只能由引擎回执里「确有字符派发」这一取证支撑，MUST NOT 由「云端下发了什么」推断出来——
 * 迁移后的宿主正是按请求载荷推断的，于是「下发了文本、一个字符都没打进去」也照样标成
 * 「点击并键入」，云端那道版本偏斜探测器因此永久静默。
 */
import type {
  CaptchaAssistClickResultPayload,
  CaptchaAssistFocusTier,
  CaptchaAssistTypeReportPayload,
} from '../comm/protocol.js';

/** Native 引擎的验证码点击回执（`captcha_click` 的 action receipt）。 */
export interface NativeCaptchaClickReceipt {
  ok: boolean;
  reason?: string;
  typeReport?: unknown;
}

/** 打包结果里由本函数负责的那几格；信封身份（incidentId / edgeId / checkedAt 等）仍由调用方补齐。 */
export type CaptchaClickResultFacts = Pick<CaptchaAssistClickResultPayload, 'status'> &
  Partial<Pick<CaptchaAssistClickResultPayload, 'reason' | 'replayMode' | 'inputMode' | 'typeReport'>>;

const FOCUS_TIERS: readonly CaptchaAssistFocusTier[] = ['editable', 'opaque', 'none'];
const CLEAR_OUTCOMES = ['verified', 'attempted'] as const;
const VERIFY_OUTCOMES = ['match', 'mismatch', 'unverifiable'] as const;

function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * 把引擎回执里的取证**按白名单逐格抄进**载荷。
 *
 * 逐格抄而不是整块转发，是为了让「回执绝不夹带答案本身」成为**结构保证**而不是一句注释：
 * 引擎侧哪天多回了一格（哪怕误带了答案），这里也只会取这六格。
 * 焦点档读不出来时整份判为缺席——「读不到」MUST NOT 被补成一个看着确定的 `none`。
 */
function sanitizeTypeReport(raw: unknown): CaptchaAssistTypeReportPayload | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const focus = pickEnum(source.focus, FOCUS_TIERS);
  if (!focus) return undefined;
  if (typeof source.typed !== 'number' || !Number.isFinite(source.typed)) return undefined;
  if (typeof source.submitted !== 'boolean') return undefined;
  const focusTag = typeof source.focusTag === 'string' ? source.focusTag : undefined;
  const cleared = pickEnum(source.cleared, CLEAR_OUTCOMES);
  const verified = pickEnum(source.verified, VERIFY_OUTCOMES);
  return {
    focus,
    ...(focusTag !== undefined ? { focusTag } : {}),
    ...(cleared !== undefined ? { cleared } : {}),
    typed: Math.max(0, Math.trunc(source.typed)),
    ...(verified !== undefined ? { verified } : {}),
    submitted: source.submitted,
  };
}

/**
 * 打包一次验证码协助点击的结论。
 *
 * `_request` 只为可读性保留在签名里：**本函数刻意不从它推导任何一格**。参数留着而不删，
 * 是为了让「打包不看请求」这件事在调用点也看得见；一旦有人想按请求补一格，会先撞到这段注释。
 */
export function buildCaptchaClickResultFacts(
  _request: { text?: unknown },
  receipt: NativeCaptchaClickReceipt | undefined,
): CaptchaClickResultFacts {
  if (!receipt) {
    // 引擎没回一份认得出的回执：什么都不知道，就什么都不声称（连 inputMode 都不给）。
    return { status: 'failed', reason: 'native_captcha_receipt_missing', replayMode: 'synthetic' };
  }
  const typeReport = sanitizeTypeReport(receipt.typeReport);
  const status: CaptchaAssistClickResultPayload['status'] =
    receipt.reason === 'cleared'
      ? 'cleared'
      : receipt.reason === 'still_blocked'
        ? 'still_blocked'
        : typeReport?.focus === 'none'
          // 焦点没落定＝结构确定的「找不到目标」。红线：找不到目标报 no_target，不压进兜底的 failed。
          ? 'no_target'
          : 'failed';
  return {
    status,
    ...(receipt.reason ? { reason: receipt.reason } : {}),
    replayMode: 'synthetic',
    // 唯一判据：取证在场**且**确有字符派发。取证缺席或零派发一律回落 'click'，
    // 让云端「下发了文本却未键入」的探测器如实响。
    inputMode: (typeReport?.typed ?? 0) > 0 ? 'click_type' : 'click',
    ...(typeReport ? { typeReport } : {}),
  };
}
