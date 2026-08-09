import { evalRaw, type BrowseCdp } from '../browse/cdp-util.js';
import type {
  BlockingOverlayKind,
  BlockingOverlaySnapshot,
  OverlayKind,
  OverlayMonitor,
} from '../browse/overlay-monitor.js';

export interface FacebookBlockingSignals {
  href: string;
  text?: string;
  frameUrls?: string[];
}

/**
 * FB 中文「频率」框架限流文案（change fb-throttle-popup-zh-frequency-copy）。
 *
 * 既有词库只覆盖「封锁 / 不可用」框架（暂时被限制 / 操作被封锁 / 功能暂时不可用…），不认这句真实文案：
 * 「为让社群免受垃圾信息打扰，我们限制了你发帖、评论或执行其他操作的频率。你可以稍后再试。」
 * ⇒ classify='none' ⇒ 连 captcha.detected 都不发 ⇒ 账号已被平台限流、云端风控态仍停 normal 继续按
 * 原节奏发（全静默）。
 *
 * **词条纪律（硬约束，误报代价不对称）**：命中一次 → 云端升 confirmed → restricted → 钉住恢复窗且不自动
 * 回滚、只能人工恢复；漏报仅维持现状。故：
 *  - 只用**长专属句片段**，绝不加裸词「限制」/「频率」（FB 群规则页 / 隐私设置页遍地都是）；
 *  - 刻意**不含标点**——用户文案来自截图转录，标点全 / 半角未坐实，含标点的词条会因转录差异空转；
 *  - 刻意**不含「社群」**——地区差异（社群 / 社区）未坐实；
 *  - 「你 / 您」两版并列（FB zh-CN 用「你」，留一手）；
 *  - **不凭空扩充未见过的变体**（见 change Non-Goals）。
 *
 * 与云端 FB_THROTTLE_PHRASES 逐条对齐（两仓各自维护、无共享模块；两侧单测各锁一份集合，任一侧漂移即失败）。
 * 词条为 FB 专属措辞，小红书 overlay 不命中 ⇒ 零回归（云端 isFacebookThrottleText 对所有平台的 overlay 文案生效）。
 */
export const FB_THROTTLE_ZH_FREQUENCY_PHRASES: readonly string[] = [
  '我们限制了你发帖',
  '我们限制了您发帖',
  '执行其他操作的频率',
];

/**
 * FB 法语界面的软阻断文案（change fb-throttle-popup-fr-copy）。
 *
 * 真实文案：「Cette fonctionnalité n'est pas disponible. / Un contrôle de sécurité est requis pour
 * continuer. / Si vous pensez que ceci ne va pas à l'encontre des Standards de la communauté,
 * dites-le nous.」
 *
 * 该弹窗的**英文版**今天已被下方既有正则命中（`this feature is( ?n.?t| not) available`）⇒ 判阻断态、
 * 上报、云端一次刹车到 restricted；法语版零命中 ⇒ classify='none' ⇒ 连上报都不发 ⇒ 云端风控停 normal
 * 继续按原节奏下发动作。**同一平台阻断因界面语言不同得到截然不同的处置，是覆盖面缺陷，不是设计意图。**
 *
 * **词条纪律（硬约束，误报代价不对称，同中文那份）**：
 *  - 只用**长专属句片段**；`est requis` 是必需限定，绝不可省——裸的「contrôle de sécurité」在 FB 法语
 *    安全设置页里是功能名、遍地都是，加上「是必需的」后语义才从「这里有个功能」变为「平台要求你现在做」；
 *  - **显式不收第三句**「ne va pas à l'encontre des Standards de la communauté」——那是违规**申诉入口
 *    话术**，附在一切违规告知之后、包括通知中心里的**陈年**内容删除通知 ⇒ 一条旧通知就能把账号打进
 *    restricted。与云端删除 'we removed your' 的理由完全同源；
 *  - **不凭空扩充未见过的变体**（不预填其他拉丁语种，见 change Non-Goals）。
 *
 * 词条以 `normalizeLatin()` 的**归一后形式**书写（小写 / 去撇号 / 去变音符 / 折空白）。
 * 与云端 FB_THROTTLE_PHRASES 的法语段**逐条一致**（两仓无共享模块；两侧单测各锁一份集合，任一侧漂移即失败）。
 */
export const FB_THROTTLE_FR_PHRASES: readonly string[] = [
  'controle de securite est requis',
  'cette fonctionnalite nest pas disponible',
];

/**
 * 拉丁语系文本归一：小写 → 去撇号/智能引号 → **去变音符** → 折叠空白。
 *
 * 与云端 facebook-throttle-signals.ts 的 normalize() 行为一致（两仓无共享模块）。去变音符消解三条
 * **无法在代码评审中看出来**、命中任一条都会使判据静默空转的失配路径：
 *  ① Unicode 等价形式——'é' 可以是预组合的 U+00E9，也可以是 'e' + U+0301 的组合序列，页面 innerText
 *     用哪种不受我们控制，两者字面比较不相等；
 *  ② 转录损耗——文案取证多经截图转录，变音符在这一步丢失；
 *  ③ 地区变体——同一措辞在不同地区可能标注不同。
 *
 * **刻意只服务于新增的拉丁语系集合，不施加于下方既有正则**：那条正则跑在未做撇号 / 变音符归一的
 * textLower 上，把归一引入它会改变全部既有英文与中文判据的输入面，风险远超收益。
 */
function normalizeLatin(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 拉丁语系限流词条匹配。归一只做一次（整页文本可达 4000 字、遮罩监测体每秒轮询一次），且刻意保持惰性
 * ——调用点排在既有正则之后，前面任一条命中即短路、根本不会走到这里。
 */
function matchesLatinThrottlePhrase(text: string): boolean {
  const normalized = normalizeLatin(text);
  return FB_THROTTLE_FR_PHRASES.some((phrase) => normalized.includes(phrase));
}

export function classifyFacebookOverlayFromSignals(signals: FacebookBlockingSignals): OverlayKind {
  const href = String(signals.href || '').toLowerCase();
  const text = String(signals.text || '').replace(/\s+/g, ' ');
  const textLower = text.toLowerCase();
  const frames = (signals.frameUrls || []).join('\n').toLowerCase();

  // `checkpoint` 只是 Facebook 的通用安全检查路由，不等于页面上真的出现了验证码。
  // 旧逻辑仅凭 URL 就即时上报 captcha → confirmed → restricted；这会把身份确认、设备确认等
  // 没有验证码控件的 checkpoint 冒充成「验证码弹出」。captcha 必须有正向证据：厂商 iframe
  // 或明确的人机验证语义。真实 captcha 仍然排在所有 route fallback 之前、即时 fail-closed。
  if (
    frames.includes('fbsbx.com/captcha') ||
    frames.includes('google.com/recaptcha') ||
    /进行人机身份验证|人机身份验证|captcha|recaptcha|prove you(?:'|’)re human|confirm you(?:'|’)re human|verify you(?:'|’)re human/i.test(text)
  ) {
    return 'captcha';
  }

  if (
    href.includes('/login') ||
    href.includes('/recover') ||
    href.includes('/two_step_verification') ||
    /登录 facebook|登录或注册|log in to facebook|forgot password|account recovery|账号恢复|找回账号/i.test(text)
  ) {
    return 'login';
  }

  // 通用 checkpoint / security check 仍是阻断态：本地立即停手，云端上报走 unknown 的一轮
  // 持续性确认，既不放行自动化，也不凭 URL 臆称已经看见验证码。
  if (
    href.includes('/checkpoint') ||
    /security check|security checkpoint|安全检查|安全验证/i.test(text)
  ) {
    return 'unknown';
  }

  // FB 软阻断 / 限流信号（change account-nurture-discipline-spine §5.2）：FB 主力限流是 inline
  // 弹窗/toast（"Action Blocked"/"we limit how often you can do this"/"misusing this feature"/
  // "you can't use this feature right now"/"going too fast"）。识别为 'unknown' 阻断态 → 经既有
  // captcha.detected 带 overlay.text 上报（不改协议）→ 云端 §3 词库匹配把风控迁至 restricted。
  // 与云端 FB_THROTTLE_PHRASES 语义对齐（两仓各自维护，无共享模块）。
  // 'we restrict certain content and actions'：此前只在云端词库、边缘不认 ⇒ 边缘不分类就永不上报、云端永远
  // 收不到能命中它的文本 ⇒ 该条是**死代码**。本 change 补齐边缘侧使其真正可达（FB 账号受限通知的专属措辞，
  // 特异性足够）。云端另一条 'we removed your' 反向处理：见云端词库注释（过于宽泛，已删而非补齐）。
  if (
    href.includes('/help/contact') ||
    /temporarily blocked|action blocked|we limit how often you can do this|misusing this feature|you can.?t use this feature right now|going too fast|this feature is( ?n.?t| not) available|your account is restricted|we restrict certain content and actions|暂时被限制|功能暂时不可用|此功能暂时无法使用|你暂时无法使用|操作被封锁/i.test(textLower) ||
    FB_THROTTLE_ZH_FREQUENCY_PHRASES.some((phrase) => text.includes(phrase)) ||
    matchesLatinThrottlePhrase(text)
  ) {
    return 'unknown';
  }

  return 'none';
}

const FACEBOOK_OVERLAY_SCAN_JS = `(function(){
  function clip(s, n){ s = String(s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) : s; }
  var frameUrls = [];
  var frames = document.querySelectorAll('iframe');
  for (var i = 0; i < frames.length && frameUrls.length < 20; i++) {
    var src = frames[i].getAttribute('src') || frames[i].src || '';
    if (src) frameUrls.push(src);
  }
  return JSON.stringify({
    href: location.href,
    text: clip(document.body ? document.body.innerText : '', 4000),
    frameUrls: frameUrls
  });
})()`;

/** 一次扫描的结果：判定 + **判定所依据的那份信号**（供上报回填同源证据）。 */
export interface FacebookOverlayScan {
  kind: OverlayKind;
  signals: FacebookBlockingSignals;
}

export async function scanFacebookOverlay(cdp: BrowseCdp): Promise<FacebookOverlayScan> {
  const raw = await evalRaw<string>(cdp, FACEBOOK_OVERLAY_SCAN_JS);
  try {
    const signals = JSON.parse(raw) as FacebookBlockingSignals;
    return { kind: classifyFacebookOverlayFromSignals(signals), signals };
  } catch {
    // 解析失败仍 fail-closed 为 unknown（既有语义不变）；但此时无可信文本 ⇒ 不臆造证据。
    return { kind: 'unknown', signals: { href: '' } };
  }
}

export async function classifyFacebookOverlay(cdp: BrowseCdp): Promise<OverlayKind> {
  return (await scanFacebookOverlay(cdp)).kind;
}

/** 上报证据文案的截断上限（判定面是整页 4000 字，证据只需够定性 + 留证）。 */
export const OVERLAY_EVIDENCE_MAX_CHARS = 1000;

/**
 * 保证「判为阻断态的上报必然携带非空证据文案」（change fb-throttle-popup-zh-frequency-copy）。
 *
 * **为什么需要**：分类读整页 innerText（4000 字），上报却带遮罩快照里**某个 DOM 元素**的 textContent（500 字）
 * —— 两者不同源。而快照对 kind='unknown' 的候选筛选要求「带 iframe **或**（宽≥60% 视口 **且** 高≥40%
 * **且** 无关闭控件）」；FB 标准限流弹窗 role=dialog / 无 iframe / 约占视口 35% / 右上角有关闭 × ⇒ 三分支
 * 全不满足 ⇒ candidates 空 ⇒ text=undefined ⇒ 云端按「无文案不臆断限流」返否定 ⇒ 信号只到 light ⇒ 仅
 * warned 降速 ×0.7，而非 restricted 刹车。**证据与判定不同源时，判据补得再全也不会改变结果。**
 *
 * 回填**只决定已判为阻断那一刻随上报携带什么证据，绝不改变判定本身**（判定仍由词库在整页文本上完成）。
 * 明确**不**走「放宽快照 DOM 可信阈」那条路：放宽会把良性弹层拖进快照、成倍放大误报面，而误报代价是账号
 * 停摆至恢复窗结束且需人工恢复（见 design.md 决策 2）。
 */
export function backfillOverlayEvidenceText(
  overlay: BlockingOverlaySnapshot | undefined,
  kind: BlockingOverlayKind,
  url: string,
  sameSourceText: string | undefined,
  now: () => number = Date.now,
): BlockingOverlaySnapshot | undefined {
  if (overlay?.text) return overlay; // 候选非空 ⇒ 沿用原证据，回填绝不覆盖
  const clipped = clipEvidence(sameSourceText);
  if (!clipped) return overlay; // 无同源文本 ⇒ 诚实保持现状，绝不臆造证据
  if (overlay) return { ...overlay, text: clipped };
  // 快照采集整个失败时，仍把同源证据送达云端（否则这一次限流照样只到降速档）。
  return {
    kind,
    ...(url ? { firstDetectedUrl: url } : {}),
    capturedAt: now(),
    text: clipped,
    candidates: [],
  };
}

function clipEvidence(text: string | undefined): string | undefined {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return undefined;
  return clean.length > OVERLAY_EVIDENCE_MAX_CHARS ? clean.slice(0, OVERLAY_EVIDENCE_MAX_CHARS) : clean;
}

export interface FacebookOverlayMonitorOptions {
  pollMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
  logger?: (msg: string) => void;
}

export class FacebookOverlayMonitor implements OverlayMonitor {
  private current: OverlayKind = 'none';
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private lastText?: string;

  constructor(
    private readonly cdp: BrowseCdp,
    private readonly opts: FacebookOverlayMonitorOptions = {},
  ) {}

  get state(): OverlayKind {
    return this.current;
  }

  /**
   * 最近一次探测**判定所依据的**那份页面文本（非快照 DOM 元素文本）。
   * 供上报侧回填同源证据，见 backfillOverlayEvidenceText。探测失败不覆盖（与 state 的 sticky 语义一致）。
   */
  get lastScanText(): string | undefined {
    return this.lastText;
  }

  async probeNow(): Promise<OverlayKind> {
    const scan = await scanFacebookOverlay(this.cdp);
    this.lastText = scan.signals.text || undefined;
    return scan.kind;
  }

  start(onTransition?: (from: OverlayKind, to: OverlayKind) => void): void {
    if (!this.stopped) return;
    this.stopped = false;
    const pollMs = this.opts.pollMs ?? 1000;
    const setTimer = this.opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const loop = async (): Promise<void> => {
      if (this.stopped) return;
      await this.tick(onTransition);
      if (this.stopped) return;
      this.timer = setTimer(() => void loop(), pollMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      const clearTimer = this.opts.clearTimer ?? ((h: ReturnType<typeof setTimeout>) => clearTimeout(h));
      clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  async tick(onTransition?: (from: OverlayKind, to: OverlayKind) => void): Promise<void> {
    let next: OverlayKind;
    try {
      next = await this.probeNow();
    } catch (err) {
      this.opts.logger?.(`[facebook-overlay] probe failed; keeping state=${this.current}: ${(err as Error).message}`);
      return;
    }
    if (next !== this.current) {
      const prev = this.current;
      this.current = next;
      onTransition?.(prev, next);
    }
  }
}
