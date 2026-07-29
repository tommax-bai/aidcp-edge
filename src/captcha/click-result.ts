/**
 * 验证码协助点击 / 键入的**回执打包**（change restore-native-xiaohongshu-session-guards §3）。
 *
 * 从 `src/main.ts` 就地提取成纯函数，唯一动机是让它**可被行为断言**：宿主装配文件零导出，
 * 现有的全部 main.ts 用例都是源码正则断言，而正则断言恰恰是「死码把检查喂绿」的高发形态。
 *
 * 本文件守的那条不变量只有一句：
 *   **`inputMode` 说的是「哪条执行路径驱动了这次协助」，而且只能由回执里的取证支撑。**
 * MUST NOT 由「云端下发了什么」推断出来——迁移后的宿主正是按请求载荷推断的，于是
 * 「下发了文本、边缘整段忽略」也照样标成「点击并键入」，云端那道版本偏斜探测器因此永久静默。
 *
 * 反过来也不许过头：`inputMode` **不是**「有没有真派发成字符」的同义词。云端那道判据
 * （`textNotExecuted = 下发了文本 && inputMode !== 'click_type'`）诊断的是**客户端太旧**——
 * 老边缘收到 text 却整段忽略、只点了 points（能力闸漏网）。把「零派发」也算进去，就会让
 * 一个最新客户端「点位没点中输入框」的常见失败被控制台说成「客户端太旧、请重装」，
 * 诊断被指向完全错误的方向。「有没有真派发」这个事实由 `typeReport.typed` 单独承载，
 * 云端本来就收得到；原始缺陷仍然被治住——老边缘根本不产出 `typeReport`。
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
    // 唯一判据：**键入执行路径真的跑过**（回执带取证即为跑过），与 `typed` 是否为 0 无关。
    // 取证缺席 ⇒ 这次协助根本没走键入路径（老边缘忽略 text 就是这个形态），回落 'click'，
    // 让云端「客户端太旧」的版本偏斜探测器如实响。
    inputMode: typeReport ? 'click_type' : 'click',
    ...(typeReport ? { typeReport } : {}),
  };
}
