/**
 * PublishCommandDispatcher — A 阶段1 边缘「指令运行时」。
 *
 * 云端 CommandSequencer 逐条下发 `{p}.publish.command {recordId, seq, kind, params}`（平台在消息名里）；
 * 边缘按 `kind` 路由到处理器，复用 `LocatingEngine` 五层编排 + 三道闸（守卫→定位→执行→后置校验→晋升）
 * 做「定位 + 原子操作 + 后置校验」，逐条回 `{p}.publish.command.result {recordId, seq, kind, ok, value?, error?, details?}`。
 *
 * 红线（MUST NOT 静默假成功）：定位失败 / 后置校验失败 / 抓不到目标 → `ok:false` + 真实 error，绝不伪造 `ok:true`、绝不兜底凑值。
 * 边轻云重：本运行时只做原子操作 + 就地校验；编排（序列/重试/人审闸）在云端。
 */

import { LocatingEngine } from '../locating/engine.js';
import type { ActionRequest, ActionResult, PostValidator } from '../locating/index.js';
import type { EngineDeps, EngineOptions } from '../locating/engine.js';
import type { ImageUploader } from './image-uploader.js';
import type { CdpLike } from '../cdp/file-input-setter.js';
import type {
  PublishCommandPayload,
  PublishCommandResultPayload,
} from '../comm/protocol.js';
import {
  XHS_PUBLISH_SELECT_MODE_ACTION_ID,
  XHS_PUBLISH_SELECT_MODE_ANCHOR_HINT,
  XHS_PUBLISH_SELECT_MODE_GOAL,
} from './anchors.js';
import {
  type PublishRequestPayload,
  PublishStepValidator,
  buildContentInputRequest,
  buildEnterPublishPageRequest,
  buildSubmitPublishRequest,
  buildTagInputRequest,
  buildTitleInputRequest,
  committedTopicPill,
  extractPostId,
  extractPostUrl,
} from './publish-post.js';
import { dispatchClick, dispatchKey } from '../browse/cdp-util.js';
import { jitterAround, type RandomFn } from '../humanize/timing.js';
import {
  rethrowIfTakeover,
  TaskTakeoverError,
  type Checkpoint,
  type TakeoverCtx,
} from '../execution/takeover.js';
import type { CommitWindowGuard } from '../execution/commit-window.js';
import { pollBounded } from './bounded-poll.js';

/** 指令运行时依赖（EngineDeps 去掉 validator——validator 由各处理器按 kind 提供）。 */
export type PublishCommandDeps = Omit<EngineDeps, 'validator'>;

/**
 * 发布填写拟人化节奏（change publish-fill-humanization，Phase A：纯 edge）。
 * 复用浏览侧已有原语（逐字打字 / 贝塞尔点击 / 对数正态停顿），把"瞬时机械填写"改成有节奏的真人填写。
 * 全部是中心值常量，便于后续标定；sleep/random 可注入（测试用 instant sleep 保持快+确定）。
 */
export interface PublishPacing {
  /** 关：跳过所有拟人停顿/逐字（仍走原瞬时路径）。默认开。 */
  enabled?: boolean;
  /** 注入 sleep（测试传 instant 保持快）；缺省真实 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  /** 注入随机源（确定性测试）；缺省 Math.random。 */
  random?: RandomFn;
}

export interface PlatformPublishCommandExecutor {
  dispatch(
    payload: PublishCommandPayload,
    takeover?: TakeoverCtx,
  ): Promise<PublishCommandResultPayload>;
}

/**
 * 各「人类时刻」的中心值（毫秒）；实际值再叠对数正态抖动。集中一处便于标定。
 * 红线约束：单条指令的 edge 执行时长（含 thinkBeforeStep + 本步停顿 + 后置校验轮询）MUST < 云端
 * CommandSequencer 的单条等待超时（非配图 30s，command-sequencer.ts）。故打字软上限/审阅停留都压在安全线内，
 * 否则 fill_field/submit_publish 会被云端判超时 → 发布失败。要更长节奏须走 Phase B（云端抬高该步超时）。
 */
const PACING_MS = {
  /** 落地发布页后"环顾/定位"再动手 */
  navigateSettle: 1500,
  /** 选模式/加话题/设选项 等小步前的"想一下" */
  stepThink: 900,
  /** 填字段前聚焦后的短停顿（手移到输入框） */
  fieldFocus: 700,
  /** 字段填完后的微停顿 */
  fieldDone: 600,
  /** 点「发布」前"通读全文确认"停留。压在 2s（提交步预算紧：找按钮+本停顿+点击+最长 15s 后置校验 < 云端 30s） */
  submitReview: 2_000,
} as const;

const CAPTURE_POST_ID_ACTION = 'note.capture_post_id';
const CAPTURE_SCHEDULED_ACTION = 'note.capture_scheduled';
const RECONCILE_SCHEDULED_ACTION = 'note.reconcile_scheduled';

/** 小红书创作平台当前原生定时窗口（实机 + 官方前端约束）：未来 1h 至 14d。 */
export const XHS_SCHEDULE_MIN_AHEAD_MS = 60 * 60 * 1000;
export const XHS_SCHEDULE_MAX_AHEAD_MS = 14 * 24 * 60 * 60 * 1000;

/** epoch → 北京时间分钟字符串；cloud 永远存 epoch，只有 edge 在平台边界格式化。 */
export function formatXhsScheduleTime(publishTime: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(publishTime));
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')} ${read('hour')}:${read('minute')}`;
}

export function isValidXhsScheduleTime(publishTime: number, now: number): boolean {
  return Number.isFinite(publishTime)
    && publishTime - now >= XHS_SCHEDULE_MIN_AHEAD_MS
    && publishTime - now <= XHS_SCHEDULE_MAX_AHEAD_MS;
}

/** 与页面侧读回同口径归一（折叠空白、去首尾），供全文比对（change lease-strict-preemption）。 */
function normalizeFieldText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * 只保留汉字（Unicode Han script，含各扩展区）。保留给 Enter 后过程前缀确认与既有标题验收；
 * 正文最终回读改走包含英文和数字的 normalizeXhsContentSemanticText，避免丢失模型名仍被放行。
 */
function hanziOnly(value: string): string {
  return value.replace(/[^\p{Script=Han}]/gu, '');
}

/** 小红书正文最终语义验收阈值：用户允许最多约一成字母/数字差异。 */
export const XHS_CONTENT_SEMANTIC_SIMILARITY_THRESHOLD = 0.90;

/**
 * URL 必须先整体移除；若先过滤符号，`https://example.com` 会残留为 `httpsexamplecom` 并被误计为正文。
 * URL 字符集有意限于常见 ASCII URL，遇到紧邻中文的链接时不会把链接后的正文一起吞掉。
 */
const XHS_CONTENT_URL_PATTERN = /(?:https?:\/\/|www\.)[a-z0-9._~:/?#@!$&()*+,;=%+-]+/giu;

/**
 * 小红书正文的可比较语义文字：NFKC 后只保留 Unicode 字母和数字。
 * DOM 标签已由调用侧 innerText 排除；这里继续忽略 URL、空白/换行、标点、emoji 与 Markdown 定界符。
 */
export function normalizeXhsContentSemanticText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(XHS_CONTENT_URL_PATTERN, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** O(min(m,n)) 空间的 Unicode code point Levenshtein 距离。 */
function unicodeLevenshteinDistance(left: string, right: string): number {
  let leftPoints = Array.from(left);
  let rightPoints = Array.from(right);
  if (leftPoints.length < rightPoints.length) {
    [leftPoints, rightPoints] = [rightPoints, leftPoints];
  }
  let previous = new Uint32Array(rightPoints.length + 1);
  let current = new Uint32Array(rightPoints.length + 1);
  for (let j = 0; j <= rightPoints.length; j++) previous[j] = j;
  for (let i = 1; i <= leftPoints.length; i++) {
    current[0] = i;
    for (let j = 1; j <= rightPoints.length; j++) {
      const substitutionCost = leftPoints[i - 1] === rightPoints[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + substitutionCost,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[rightPoints.length]!;
}

/**
 * 对输入值和 innerText 回读做相同语义投影后计算对称相似度。
 * 两边都为空视为相同；仅一边为空视为完全不同。调用侧对“期望投影为空”另走非空精确兜底。
 */
export function xhsContentSemanticSimilarity(expected: string, actual: string): number {
  const normalizedExpected = normalizeXhsContentSemanticText(expected);
  const normalizedActual = normalizeXhsContentSemanticText(actual);
  const expectedLength = Array.from(normalizedExpected).length;
  const actualLength = Array.from(normalizedActual).length;
  const longest = Math.max(expectedLength, actualLength);
  if (longest === 0) return 1;
  const distance = unicodeLevenshteinDistance(normalizedExpected, normalizedActual);
  return 1 - distance / longest;
}

/** 既有标题/空语义正文精确兜底允许的额外字符数；普通正文改由 90% 对称相似度统一计分。 */
const FILL_EXTRA_CHAR_TOLERANCE = 4;

/** 清场三态：清干净 / 字段已不在（无残文可留）/ 字段还在但清不掉（真脏页）。 */
interface FieldClearResult {
  cleared: boolean;
  residual: string | null;
  fieldFound: boolean;
}

type ContentInputUnit =
  | { kind: 'text'; value: string }
  | { kind: 'newline' };

/**
 * 构造小红书正文换行后的页面侧状态探针。
 *
 * ProseMirror 的 selection 位于末段 `<p>` 内；它与外层 `.ProseMirror` 的末端 Range
 * 视觉等价但 boundary container 不同，不能用 compareBoundaryPoints 严格相等判断（dev record #159）。
 * 正确语义是：caret 位于最后一个顶层段落内，且从 caret 到该段末端没有实际文本。
 */
export function buildXhsContentCaretStateExpression(findExpr: string): string {
  return String.raw`(() => { /* xhs-content-caret-state */
    const el = ${findExpr};
    if (!el) return JSON.stringify({ found: false, text: '', newlines: 0, atEnd: false });
    const raw = el.innerText || el.textContent || '';
    const text = raw.replace(/\s+/g, ' ').trim();
    const directBlocks = Array.from(el.children || []).filter((child) =>
      /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|PRE)$/.test(child.tagName || '')).length;
    const brCount = el.querySelectorAll ? el.querySelectorAll('br').length : 0;
    const newlines = Math.max(Math.max(0, directBlocks - 1), brCount);
    const sel = getSelection();
    const lastBlock = el.lastElementChild || el;
    let atEnd = false;
    try {
      if (sel && sel.rangeCount > 0 && sel.isCollapsed && el.contains(sel.anchorNode)) {
        const anchor = sel.anchorNode;
        const inLastBlock = lastBlock === el
          ? el.contains(anchor)
          : lastBlock === anchor || lastBlock.contains(anchor);
        if (inLastBlock) {
          const tail = document.createRange();
          tail.setStart(anchor, sel.anchorOffset);
          tail.setEnd(lastBlock, lastBlock.childNodes.length);
          atEnd = tail.toString().replace(/[\u200B\uFEFF]/g, '') === '';
        }
      }
    } catch (e) {}
    if (!atEnd && sel) {
      try {
        const end = document.createRange();
        end.selectNodeContents(lastBlock); end.collapse(false);
        sel.removeAllRanges(); sel.addRange(end);
      } catch (e) {}
    }
    return JSON.stringify({ found: true, text, newlines, atEnd });
  })()`;
}

/** 由指令参数合成最小 PublishRequestPayload，供复用 PublishStepValidator 的字段读取。 */
function synthPayload(payload: PublishCommandPayload): PublishRequestPayload {
  const value = payload.params.value ?? '';
  return { title: value, content: value, tags: value ? [value] : [] };
}

function buildSelectModeRequest(): ActionRequest {
  return {
    actionId: XHS_PUBLISH_SELECT_MODE_ACTION_ID,
    op: 'click',
    goal: XHS_PUBLISH_SELECT_MODE_GOAL,
    anchorHint: XHS_PUBLISH_SELECT_MODE_ANCHOR_HINT,
  };
}

// ── stage-4 元数据应用：best-effort 锚点（真实小红书 DOM 待实机 CDP 校准；未命中如实 no_target）──

function normalize(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 扫 DOM 文本是否含关键词（best-effort 后置校验：确认选项/值已反映，未反映则如实失败）。 */
function domHasText(root: Element | Document, keyword: string): boolean {
  const kw = normalize(keyword);
  if (!kw) return true;
  const start = 'documentElement' in root ? ((root as Document).body ?? (root as Document).documentElement) : (root as Element);
  for (const el of Array.from(start.querySelectorAll('*'))) {
    const signals = [
      el.textContent,
      el.getAttribute('aria-label'),
      el.getAttribute('value'),
      el.getAttribute('title'),
      (el as { value?: string }).value, // 表单控件：值在 property 上而非 attribute
    ];
    if (signals.some((s) => normalize(s).includes(kw))) return true;
  }
  return false;
}

/** 关键词后置校验器（best-effort）：校验目标值/关键词已出现在页面。 */
function valueValidator(keyword: string): PostValidator {
  return { validate: (_req: ActionRequest, root: Element | Document) => domHasText(root, keyword) };
}

const CANDIDATE_ANCHOR: Record<string, { actionId: string; text: string; goal: string }> = {
  mention: { actionId: 'note.publish_mention', text: '@', goal: '在发布页 @提及用户：找到 @ 入口/输入框，输入用户名并从候选列表选择' },
  location: { actionId: 'note.publish_location', text: '地点', goal: '在发布页添加地点：找到地点/位置入口，输入并从候选选择' },
  collection: { actionId: 'note.publish_collection', text: '合集', goal: '在发布页加入合集/专辑：找到合集入口，选择目标合集' },
};

/** add_with_candidate 按 candidateKind 路由：topic 用话题锚点，其余 mention/location/collection 用各自锚点。 */
function buildCandidateRequest(candidateKind: string | undefined, value: string): ActionRequest {
  if (!candidateKind || candidateKind === 'topic') return buildTagInputRequest(value);
  const a = CANDIDATE_ANCHOR[candidateKind] ?? CANDIDATE_ANCHOR.mention;
  return {
    actionId: a.actionId,
    op: 'input',
    value,
    goal: `${a.goal}。当前要加入的是「${value}」。`,
    anchorHint: { text: a.text, textMatch: 'contains' },
  };
}

const OPTION_KEYWORD: Record<string, string> = {
  visibility: '可见范围',
  comment_permission: '评论',
  save_permission: '保存',
  declaration_ai: 'AI',
  declaration_ad: '广告',
  declaration_origin: '原创',
};

/** set_option：按 optionKind 定位开关/选项控件，设为 optionValue（best-effort）。 */
function buildSetOptionRequest(optionKind: string | undefined, optionValue: string): ActionRequest {
  const kw = OPTION_KEYWORD[optionKind ?? ''] ?? optionKind ?? '选项';
  return {
    actionId: `note.publish_set_option.${optionKind ?? 'unknown'}`,
    op: 'click',
    goal: `在发布页设置「${kw}」为「${optionValue}」：找到对应的开关/下拉/单选控件并选中目标值`,
    anchorHint: { text: kw, textMatch: 'contains' },
  };
}

/** set_cover：定位封面入口并将所选图设为封面（best-effort；真实 DOM 待实机校准）。 */
function buildSetCoverRequest(): ActionRequest {
  return {
    actionId: 'note.publish_set_cover',
    op: 'click',
    goal: '在发布页设置封面：找到封面/首图选择入口并将目标图设为封面',
    anchorHint: { text: '封面', textMatch: 'contains' },
  };
}

/**
 * 封面后置校验：**fail-closed**——只认精确锚点 `note.publish_cover_active`（断言所选图真成封面，非仅点到）。
 * 真实 DOM 在 task-0 校准前不含此锚点 → 诚实失败，绝不用宽泛 [class*=cover][class*=active] 子串误命中页面既有节点假成功。
 */
function coverActiveValidator(): PostValidator {
  return {
    validate: (_req: ActionRequest, root: Element | Document) => {
      try {
        return !!root.querySelector('[data-action-id="note.publish_cover_active"]');
      } catch {
        return false;
      }
    },
  };
}

/** 创作平台图文发布页（navigate_entry 直达；跨子域点击入口会开新标签、edge 看不到，故用 Page.navigate）。 */
const XHS_CREATOR_PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official';
/** 创作平台笔记管理；capture/reconcile 只读导航到这里核验平台事实。 */
const XHS_CREATOR_MANAGE_URL = 'https://creator.xiaohongshu.com/new/note-manager?source=official';

interface ScheduleDomState {
  checked: boolean;
  inputFound: boolean;
  value: string;
  toggle?: { x: number; y: number };
}

interface ManagedNoteMatch {
  state: 'found' | 'missing' | 'ambiguous';
  noteId?: string;
  postUrl?: string;
}

export class PublishCommandDispatcher {
  private readonly clock: () => number;
  private inputEnabled = false;
  private domEnabled = false;
  /** 只在专用 set_schedule 三项正证据全部通过后置真；新发布页导航必清。 */
  private scheduleModeConfirmed = false;
  /** 拟人节奏（change publish-fill-humanization，Phase A）：开关 + 可注入 sleep/random。 */
  private readonly pacingEnabled: boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: RandomFn;
  /**
   * change split-topic-roles：CDP 直驱真实加话题开关（env `AIDCP_PUBLISH_TOPIC_CDP`）。
   * 实机确认真话题贴上后（task 2.5，工程师大白 verified：runAddTopic → a.tiptap-topic）**默认启用**；
   * 保留 env kill-switch——显式 `AIDCP_PUBLISH_TOPIC_CDP=0/false/no/off` 回退旧 buildTagInputRequest 兜底路径。
   * 仍不靠 `this.cdp` 存在与否判启用（生产 cdp 恒注入）。runAddTopic fail-closed：DOM 不符即诚实失败（best-effort 跳过、不误贴）。
   */
  private readonly topicCdpEnabled: boolean;

  constructor(
    private readonly deps: PublishCommandDeps,
    private readonly options: EngineOptions = {},
    clock: () => number = Date.now,
    /** 配图上传器（publish-media-upload）；未注入时 upload_image 诚实回 kind_not_implemented。 */
    private readonly uploader?: ImageUploader,
    /**
     * 原始 CDP（注入时用于发布页的"已校准直驱"步骤——navigate_entry 用 Page.navigate 直达、
     * select_mode 用 in-page click 选「上传图文」标签——绕开通用 extractor/LLM 选择器对发布页特殊 UI 的不可靠定位）。
     * 未注入则回退通用 LocatingEngine 路径。
     */
    private readonly cdp?: CdpLike,
    /** 发布填写拟人节奏（缺省开、真实 sleep + Math.random）。 */
    pacing: PublishPacing = {},
    /** Facebook 发布执行器；未注入时 Facebook 指令诚实回 kind_not_implemented。 */
    private readonly facebookPublisher?: PlatformPublishCommandExecutor,
    /**
     * 提交窗口守卫（change lease-strict-preemption 5.1）：XHS `runSubmit` 点「发布」前 `enter()`、确认后 `dispose()`。
     * 未注入 = 抢占能力休眠、行为逐字不变。与 Facebook 发布执行器共用同一实例（同一发布写者的两个平台分支）。
     */
    private readonly publishGuard?: CommitWindowGuard,
  ) {
    this.clock = clock;
    this.pacingEnabled = pacing.enabled !== false;
    this.sleep = pacing.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = pacing.random ?? Math.random;
    // 默认启用（实机已确认）；仅在显式 kill-switch 值时关闭、回退旧兜底路径。
    this.topicCdpEnabled = !['0', 'false', 'no', 'off'].includes((process.env.AIDCP_PUBLISH_TOPIC_CDP ?? '').toLowerCase());
  }

  /** 围绕中心值叠对数正态抖动后停顿（拟人）；pacing 关 / 中心值 ≤0 时直接返回。 */
  private async pause(centerMs: number): Promise<void> {
    if (!this.pacingEnabled || centerMs <= 0) return;
    await this.sleep(jitterAround(centerMs, 0.35, this.random));
  }

  /**
   * 动作前"想一下"：各人类动作指令执行前的统一停顿。
   * 不加的：读操作 capture_postId、配图下载 upload_image、以及 submit_publish——
   * submit 有自己的"通读停留"且其后置校验最长 15s，再叠通用 think 易撞云端 30s 单步上限。
   */
  private async thinkBeforeStep(kind: PublishCommandPayload['kind']): Promise<void> {
    if (kind === 'capture_postId' || kind === 'capture_scheduled' || kind === 'reconcile_scheduled'
      || kind === 'upload_image' || kind === 'submit_publish') return;
    await this.pause(PACING_MS.stepThink);
  }

  /**
   * 按 kind 路由并执行一条发布指令，返回结果（绝不抛业务异常——异常也转成诚实的 ok:false）。
   *
   * `takeover`（change lease-strict-preemption 第 4 节）：可选的取消上下文。**接管只由异常表达**，
   * 在这里统一分类成 `preempted_by_task` —— 它的语义是「**未开始 / 已作废**」，不是发布失败。
   * 云端 MUST NOT 据此写不可逆的 failed 终态（cloud 侧接线见 tasks 7.1 / 7.4）。
   *
   * 注：本节生产路径**不注入** takeover（main.ts 的调用点不传）；管道先铺好，抢占在第 5 节接线。
   */
  async dispatch(
    payload: PublishCommandPayload,
    platform: 'xiaohongshu' | 'facebook',
    takeover?: TakeoverCtx,
  ): Promise<PublishCommandResultPayload> {
    try {
      return await this.route(payload, platform, takeover);
    } catch (err) {
      if (err instanceof TaskTakeoverError) {
        return {
          recordId: payload.recordId,
          seq: payload.seq,
          kind: payload.kind,
          ok: false,
          error: 'preempted_by_task',
        };
      }
      throw err; // 其余异常原样上抛 ⇒ 上层既有的 dispatch_error 兜底路径不变
    }
  }

  private async route(
    payload: PublishCommandPayload,
    // 批 6b：平台维在消息名里；调用方从命令名前缀解析后显式传入，载荷不再携平台字段。
    platform: 'xiaohongshu' | 'facebook',
    takeover?: TakeoverCtx,
  ): Promise<PublishCommandResultPayload> {
    if (platform === 'facebook') {
      if (!this.facebookPublisher) return this.notImplemented(payload);
      return this.facebookPublisher.dispatch(payload, takeover);
    }
    takeover?.checkpoint(); // 入口：零页面副作用
    // 拟人：动作前"想一下"，给整条发布序列加上逐项填写的节奏（治"指令间零节奏一气呵成"）。
    await this.thinkBeforeStep(payload.kind);
    takeover?.checkpoint(); // 犹豫之后、第一个页面写之前
    switch (payload.kind) {
      case 'navigate_entry':
        return this.runNavigateEntry(payload, takeover);
      case 'select_mode':
        return this.runSelectMode(payload, takeover);
      case 'fill_field':
        return this.runFillField(payload, takeover);
      case 'add_with_candidate': {
        const value = payload.params.value ?? '';
        const candidateKind = payload.params.candidateKind;
        // change split-topic-roles：topic 优先走 CDP 直驱真实加话题（#→下拉→选建议→校验真 token），
        //   由 AIDCP_PUBLISH_TOPIC_CDP 门控（默认 OFF、非按 cdp 存在与否）；OFF 或无 cdp 回退旧 buildTagInputRequest 兜底。
        if (!candidateKind || candidateKind === 'topic') {
          if (this.topicCdpEnabled && this.cdp) return this.runAddTopic(payload, value, takeover);
          return this.runAtom(
            payload,
            buildTagInputRequest(value),
            new PublishStepValidator({ step: 'input_tag', currentTag: value, payload: synthPayload(payload) }),
            takeover,
          );
        }
        return this.runAtom(payload, buildCandidateRequest(candidateKind, value), valueValidator(value), takeover);
      }
      case 'submit_publish':
        return this.runSubmit(payload, takeover);
      case 'capture_postId':
        return this.runCapturePostId(payload);
      case 'capture_scheduled':
        return this.runCaptureScheduled(payload);
      case 'reconcile_scheduled':
        return this.runReconcileScheduled(payload);
      case 'set_option': {
        const optionValue = payload.params.optionValue ?? payload.params.value ?? '';
        return this.runAtom(
          payload,
          buildSetOptionRequest(payload.params.optionKind, optionValue),
          valueValidator(optionValue),
          takeover,
        );
      }
      case 'set_schedule': {
        const publishTime = payload.params.publishTime ?? 0;
        return this.runSetSchedule(payload, publishTime, takeover);
      }
      case 'upload_image':
        return this.runUploadImage(payload, takeover);
      case 'set_cover':
        // 封面：定位封面入口 + 点击 + 封面激活态后置校验（断言真成为封面，非仅点到）。
        return this.runAtom(payload, buildSetCoverRequest(), coverActiveValidator(), takeover);
      default:
        return this.notImplemented(payload);
    }
  }

  /**
   * 进入发布页：优先 CDP Page.navigate 直达创作发布页（跨子域点击入口会开新标签、edge 看不到）。
   * 导航后绑定式轮询 isPublishPage 后置校验；未注入 navigate 时回退原点击入口逻辑。
   */
  private async runNavigateEntry(
    payload: PublishCommandPayload,
    takeover?: TakeoverCtx,
  ): Promise<PublishCommandResultPayload> {
    // 新的一篇必须重新通过专用定时正证据；绝不沿用上一页内存态决定提交按钮。
    this.scheduleModeConfirmed = false;
    if (!this.cdp) {
      // 回退：无 CDP 直驱能力时，沿用点击入口 + 后置校验。
      return this.runAtom(
        payload,
        buildEnterPublishPageRequest(),
        new PublishStepValidator({ step: 'enter_publish_page', payload: synthPayload(payload) }),
        takeover,
      );
    }
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    const details = { actionId: 'note.publish_entry', durationMs: 0 };
    try {
      takeover?.checkpoint(); // 唯一安全取消点：导航尚未发出
      await this.cdp.send('Page.navigate', { url: XHS_CREATOR_PUBLISH_URL });
    } catch (err) {
      rethrowIfTakeover(err);
      const message = err instanceof Error ? err.message : String(err);
      return { ...base, ok: false, error: `navigate_failed: ${message}`, details: { ...details, durationMs: this.clock() - startedAt } };
    }
    // 🔴 导航已提交：以下后置校验 MUST NOT 取消（pollBounded 签名里也没有取消入参）。
    // 绑定式轮询：等创作发布页渲染出来（isPublishPage 命中）。
    const validator = new PublishStepValidator({ step: 'enter_publish_page', payload: synthPayload(payload) });
    const req = buildEnterPublishPageRequest();
    const entered = await pollBounded<true>({
      probe: async () => {
        let root: Element | Document | undefined;
        try {
          root = await this.deps.dom.getRoot();
        } catch {
          root = undefined;
        }
        return root && validator.validate(req, root) ? true : undefined;
      },
      timeoutMs: 20_000,
      intervalMs: 500,
      clock: this.clock,
      sleep: this.sleep,
    });
    if (!entered) {
      return { ...base, ok: false, error: 'post_validate_failed', details: { ...details, durationMs: this.clock() - startedAt } };
    }
    // 拟人：发布页渲染好后"环顾/定位输入框"再动手。
    await this.pause(PACING_MS.navigateSettle);
    return { ...base, ok: true, details: { ...details, durationMs: this.clock() - startedAt } };
  }

  /**
   * 选「上传图文」模式（change publish-select-mode-layout-robust：跨宽/窄双布局稳健）。
   *
   * 创作发布页与消费端首页/搜索页同机理——**tab 栏重复渲染两套**（一套可见、一套隐藏），且默认停在「上传视频」。
   * 通用 extractor/LLM 选择器对该特殊 UI 不可靠，仍用 CDP in-page click 直驱，但必须按消费端已定型的双布局套路：
   *  ① **只点可见**的那个「上传图文」tab（可见性判据 `offsetParent!==null || getClientRects().length>0`，
   *     与 notification-monitor 一致、兼容窄布局 `position:fixed`）——躲开隐藏副本（治「点隐藏副本→no-op→post_validate_failed」）；
   *  ② **幂等早退**：点击前先以**保守信号**（当前激活 tab 文本含「图文」不含「视频」）判是否已在图文模式，已在则直接成功；
   *     保守 = 仅正面证据才算已在图文模式，仍是视频模式绝不谎报（红线：不静默假成功）；
   *  ③ **有界重试「出现即点」**容忍冷加载晚渲染，点后留 grace 再重点；整步窗口 20s 严格 < 云端单指令 30s 超时；
   *  ④ **失败诚实分类**：始终无可见 tab 且未在图文模式 → `no_target`；点了但模式始终未激活 → `post_validate_failed`。
   *
   * 注：窄布局下「上传图文」的精确形态（是否收成图标 / 换文案）**待真机标定**，当前窄布局候选为 best-effort、
   * 不死绑精确中文文案；命中不了如实 `no_target`。校准入口见 `docs/xhs-layout-states.md`「创作发布页双布局」一节。
   */
  private async runSelectMode(
    payload: PublishCommandPayload,
    takeover?: TakeoverCtx,
  ): Promise<PublishCommandResultPayload> {
    if (!this.cdp) {
      return this.runAtom(
        payload,
        buildSelectModeRequest(),
        new PublishStepValidator({ step: 'enter_publish_page', payload: synthPayload(payload) }),
        takeover,
      );
    }
    const cdp = this.cdp; // 越过 guard 后固化为非空局部，供下方闭包捕获（class 属性不跨闭包收窄）。
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    const details = { actionId: XHS_PUBLISH_SELECT_MODE_ACTION_ID, durationMs: 0 };
    const done = (extra: { ok: boolean; error?: string }): PublishCommandResultPayload =>
      ({ ...base, details: { ...details, durationMs: this.clock() - startedAt }, ...extra });

    // 可见性判据（**真机标定 2026-07-04**）：创作页的「上传图文」隐藏副本不是 display:none，而是被移到**屏幕外**
    // （实测隐藏副本 rect≈{x:-9758,y:-9934}，offsetParent 非空、getClientRects 非空——消费端那套 offsetParent 判据会误判其可见）。
    // 故这里判「与视口相交」：有非零盒 + 落在视口内（排除屏幕外副本）。兼容 position:fixed（其 rect 亦在视口内）。
    const IS_VISIBLE = String.raw`function(el){ try { const r = el.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return false; const vw = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0; const vh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0; return r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh; } catch (e) { return false; } }`;
    const TXT_OF = String.raw`function(e){ return ((e.innerText || e.textContent || '')).replace(/\s+/g, '').trim(); }`;

    // 权威模式判据：读【可见激活】tab 的文本判当前处于哪个模式，返回 'image' | 'video' | ''（激活态识别不出）。
    // 'image'（激活 tab 含「图文」不含「视频」）= 权威「已在图文模式」；'video'（激活 tab 含「视频」不含「图文」）
    // = 权威「仍在视频模式」，用于**否决**下方辅助信号（防「点了没切上却因残留图片信号谎报成功」，双布局硬化）；
    // ''（active class 没识别出来）= 未知，点击后回落辅助信号兜底（旧验证路径）。保守：仅 'image' 才判已在图文模式。
    const MODE_STATE = String.raw`/*MODE_STATE*/(() => {
      const visible = ${IS_VISIBLE}; const txtOf = ${TXT_OF};
      const tabs = Array.prototype.slice.call(document.querySelectorAll('[role=tab],[class*=creator-tab],[class*=tab]'));
      let sawVideo = false;
      for (const t of tabs) {
        if (!visible(t)) continue;
        const cls = String((t.className && t.className.baseVal != null) ? t.className.baseVal : (t.className || ''));
        const active = /(^|[\s_-])(active|selected|current)([\s_-]|$)/i.test(cls)
          || t.getAttribute('aria-selected') === 'true' || t.getAttribute('aria-current') === 'true';
        if (!active) continue;
        const txt = txtOf(t);
        const isImg = txt.indexOf('图文') >= 0, isVid = txt.indexOf('视频') >= 0;
        if (isImg && !isVid) return 'image';   // 激活 tab 明确是图文 → 权威判已在图文模式
        if (isVid && !isImg) sawVideo = true;  // 激活 tab 是视频 → 记「仍在视频」（否决辅助信号）
      }
      return sawVideo ? 'video' : '';          // '' = 激活态未识别
    })()`;

    // 点【可见】的「上传图文」tab：先精确文本 + creator-tab/tab class，再窄布局 best-effort（可见 + 文本含「图文」而非其它频道、取最短文本贴近 tab 自身）。
    const CLICK_TAB = String.raw`/*CLICK_TAB*/(() => {
      const visible = ${IS_VISIBLE}; const txtOf = ${TXT_OF};
      const all = Array.prototype.slice.call(document.querySelectorAll('div,span,button,a,li,[role=tab],[role=button]'));
      const vis = all.filter(visible);
      let tab = vis.find((e) => txtOf(e) === '上传图文' && /creator-tab/.test(String(e.className || '')))
        || vis.find((e) => txtOf(e) === '上传图文' && /tab/i.test(String(e.className || '')))
        || vis.find((e) => txtOf(e) === '上传图文');
      if (!tab) {
        // 窄布局 best-effort（待真机标定）：可见 + 文本含「图文」而非「视频/长文/播客/直播」、短文本（贴近 tab 而非容器）。
        const cand = vis.filter((e) => {
          const t = txtOf(e);
          return t.length > 0 && t.length <= 6 && t.indexOf('图文') >= 0
            && t.indexOf('视频') < 0 && t.indexOf('长文') < 0 && t.indexOf('播客') < 0 && t.indexOf('直播') < 0
            && (/tab/i.test(String(e.className || '')) || e.getAttribute('role') === 'tab' || t === '图文' || t === '写图文');
        });
        cand.sort((a, b) => txtOf(a).length - txtOf(b).length);
        tab = cand[0];
      }
      if (!tab) return { clicked: false };
      try { tab.scrollIntoView({ block: 'center' }); } catch (e) {}
      try { tab.click(); } catch (e) { return { clicked: false }; }
      return { clicked: true };
    })()`;

    // 图文模式激活的**辅助**信号（仅在「已点击 + 激活态未知（非 video）」时才采信）：任一文件输入 accept 变图片类，
    // 或页面出现「上传图片/文字配图」。多文件输入取 some、补 image/* 前缀。注意文件输入常 display:none，故此探针
    // 刻意**不按可见性过滤**（否则恒空）——安全性由「MODE_STATE==='video' 时否决本信号」保证，而非靠可见性。
    const IMG_MODE_ACTIVE = String.raw`/*IMG_MODE_ACTIVE*/(() => {
      const fis = Array.prototype.slice.call(document.querySelectorAll('input[type=file]'));
      if (fis.some((fi) => /jpg|jpeg|png|webp|image\//i.test((fi.getAttribute('accept') || '')))) return true;
      const body = (document.body && document.body.innerText) || '';
      return body.indexOf('上传图片') >= 0 || body.indexOf('文字配图') >= 0;
    })()`;

    const evalBool = async (expression: string): Promise<boolean> => {
      try {
        const r = await cdp.send<{ result?: { value?: boolean } }>('Runtime.evaluate', { expression, returnByValue: true });
        return r?.result?.value === true;
      } catch {
        return false; // 瞬时 evaluate 失败当「未就绪」，继续轮询
      }
    };
    const evalState = async (): Promise<string> => {
      try {
        const r = await cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', { expression: MODE_STATE, returnByValue: true });
        return typeof r?.result?.value === 'string' ? r.result.value : '';
      } catch {
        return ''; // 瞬时失败当「激活态未知」
      }
    };
    // 是否已在图文模式（幂等早退 + 后置校验二合一）：
    //  - 'image'（权威、可见激活 tab 是图文）→ 成功；
    //  - 未点击前：只认权威 'image'（保守，绝不用辅助信号盲判——避免残留图片信号在视频模式误判）；
    //  - 点击后：'video'（仍确认在视频模式）→ **否决**辅助信号（点了没切上不谎报，双布局硬化）；
    //    激活态未知（''）才回落辅助信号 IMG_MODE_ACTIVE（旧真机验证路径：文件输入 accept 变图片类 / 出现上传图片·文字配图）。
    const inImageMode = async (clicked: boolean): Promise<boolean> => {
      const state = await evalState();
      if (state === 'image') return true;
      if (!clicked) return false;
      if (state === 'video') return false;
      return await evalBool(IMG_MODE_ACTIVE);
    };

    // 统一有界重试：每轮先判「已在图文模式」（幂等早退 + 后置校验二合一）→ 否则点可见 tab（点后 grace 再重点）。
    const RECLICK_GRACE_MS = 1_500;
    let everClicked = false;
    let lastClickAt = Number.NEGATIVE_INFINITY;
    const hit = await pollBounded<true>({
      probe: async () => ((await inImageMode(everClicked)) ? true : undefined),
      onMiss: async () => {
        // 六个轮询里**唯一**存在安全取消窗口的一处：上一次点击刚被 probe 判为「尚未生效」、
        // 下一次点击尚未发出。everClicked 之后本轮起不可取消——有一次未被后置校验的写在飞。
        if (!everClicked) takeover?.checkpoint();
        const now = this.clock();
        if (!everClicked || now - lastClickAt >= RECLICK_GRACE_MS) {
          try {
            const r = await cdp.send<{ result?: { value?: { clicked?: boolean } } }>('Runtime.evaluate', {
              expression: CLICK_TAB,
              returnByValue: true,
            });
            if (r?.result?.value?.clicked) { everClicked = true; lastClickAt = now; }
          } catch {
            // 瞬时 evaluate 失败，下一轮重试
          }
        }
      },
      timeoutMs: 20_000,
      intervalMs: 400,
      clock: this.clock,
      sleep: this.sleep,
    });
    if (hit) return done({ ok: true });
    // 收尾一次模式判定（末次点击可能刚落）。
    if (await inImageMode(everClicked)) return done({ ok: true });
    // 诚实分类：点过但模式没切上 → post_validate_failed；从未点中任何可见 tab → no_target。
    return done(everClicked ? { ok: false, error: 'post_validate_failed' } : { ok: false, error: 'no_target' });
  }

  /**
   * 拟人打字（change publish-fill-humanization）：分块「突发式」输入——短字段逐字、长正文按小块（突发）输入，
   * 块间叠对数正态停顿。pacing 关 → 回退一次性 insertText（旧快路径）。
   *
   * 为何不逐字到底：每个 Input.insertText 是一次 CDP 往返（~数十 ms），长正文逐字 = 数百次往返，
   * 其固有开销会连同停顿一起把本步拖过云端 30s 单步超时（task-0 实测 seq=4 fill_field timeout）。
   * 故用 maxSends 封顶往返数、PAUSE_BUDGET 封顶总停顿——任意长度都稳在 30s 内，又不再是瞬时灌入。
   * 红线：全部字符都会输入（封顶只缩时间/往返，不丢内容）。
   */
  private async typeHumanized(text: string, checkpoint?: Checkpoint): Promise<void> {
    if (!this.cdp) return;
    if (!this.pacingEnabled) {
      checkpoint?.(); // 快路径是一次性整段灌入、中途无粒度 → 进入前查一次
      await this.cdp.send('Input.insertText', { text });
      return;
    }
    const chars = Array.from(text); // 按 grapheme 切，正确处理中文/emoji
    if (chars.length === 0) return;
    // 往返数封顶：短文(≤50)块=1（逐字最像人）；长文按比例增大块，使 insertText 次数 ≤ maxSends。
    const maxSends = 50;
    const chunkSize = Math.max(1, Math.ceil(chars.length / maxSends));
    const chunks: string[] = [];
    for (let i = 0; i < chars.length; i += chunkSize) chunks.push(chars.slice(i, i + chunkSize).join(''));
    // 总停顿预算（远小于云端 30s 单步超时，留 think/focus/done/后置校验余量）；均摊到每块、再叠抖动。
    const PAUSE_BUDGET = 12_000;
    const perPause = Math.min(220, Math.floor(PAUSE_BUDGET / chunks.length));
    for (const chunk of chunks) {
      await this.sleep(jitterAround(perPause, 0.4, this.random));
      // 唯一正确的取消缝：这一块的停顿已结束、它的 CDP 写尚未发出（与逐字输入原语逐行同形）。
      // 已写入的部分留在编辑器里，调用方 MUST 清场后再让位。
      checkpoint?.();
      await this.cdp.send('Input.insertText', { text: chunk });
    }
  }

  /**
   * 小红书正文换行不是普通字符，而是 ProseMirror 的段落结构事务。
   * `Input.insertText({text:'上一段\n下一段'})` 会让段落重排与 selection 更新互相抢跑：旧 selection
   * 可能落回块尾字之前，后续块遂插到尾字前，尾字逐块倒序堆到文末（dev record #153）。
   *
   * 因此正文 MUST 拆为两类原语：纯文本 insertText 与独立 Enter；任何 insertText 都不携 CR/LF。
   * 普通字符仍共享 maxSends/PAUSE_BUDGET，避免按行重置预算使长正文往返数失控。
   */
  private buildContentInputUnits(text: string): ContentInputUnit[] {
    const normalized = text.replace(/\r\n?/g, '\n');
    const textChars = Array.from(normalized.replace(/\n/g, ''));
    const maxSends = this.pacingEnabled ? 50 : 1;
    const chunkSize = Math.max(1, Math.ceil(textChars.length / maxSends));
    const lines = normalized.split('\n');
    const units: ContentInputUnit[] = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const chars = Array.from(lines[lineIndex]!);
      for (let i = 0; i < chars.length; i += chunkSize) {
        units.push({ kind: 'text', value: chars.slice(i, i + chunkSize).join('') });
      }
      if (lineIndex < lines.length - 1) units.push({ kind: 'newline' });
    }
    return units;
  }

  /**
   * Enter 已写入页面后不可取消：先有界确认「已写前缀仍在 + selection 连续两次位于末端」。
   * 探针发现 selection 偏移时会就地 collapse(false) 归尾；下一轮再确认没有被 ProseMirror 的
   * 延迟 selection 事务覆盖。命令 ACK 只代表 CDP 收到指令，不能替代此编辑器状态确认。
   */
  private async stabilizeContentAfterNewline(
    findExpr: string,
    expectedPrefix: string,
    expectedNewlines: number,
  ): Promise<void> {
    if (!this.cdp) throw new Error('content_newline_unstable');
    const expected = normalizeFieldText(expectedPrefix);
    const expectedHanzi = hanziOnly(expected);
    const STATE = buildXhsContentCaretStateExpression(findExpr);
    let stableAtEnd = 0;
    const stable = await pollBounded<boolean>({
      probe: async () => {
        const r = await this.cdp!.send<{ result?: { value?: string } }>('Runtime.evaluate', {
          expression: STATE,
          returnByValue: true,
        });
        const parsed = JSON.parse(r?.result?.value ?? '{"found":false,"text":"","newlines":0,"atEnd":false}') as {
          found: boolean;
          text: string;
          newlines: number;
          atEnd: boolean;
        };
        if (!parsed.found) {
          stableAtEnd = 0;
          return undefined;
        }
        const prefixMatches = expected === ''
          || (expectedHanzi ? hanziOnly(parsed.text).includes(expectedHanzi) : parsed.text.includes(expected));
        if (!prefixMatches || parsed.newlines < expectedNewlines || !parsed.atEnd) {
          stableAtEnd = 0;
          return undefined;
        }
        stableAtEnd++;
        return stableAtEnd >= 2 ? true : undefined;
      },
      timeoutMs: 1_500,
      intervalMs: 80,
      clock: this.clock,
      sleep: this.sleep,
    });
    if (stable !== true) throw new Error('content_newline_unstable');
  }

  private async typeHumanizedContent(
    text: string,
    findExpr: string,
    checkpoint?: Checkpoint,
  ): Promise<void> {
    if (!this.cdp) return;
    const units = this.buildContentInputUnits(text);
    if (units.length === 0) return;
    const PAUSE_BUDGET = 12_000;
    const perPause = this.pacingEnabled ? Math.min(220, Math.floor(PAUSE_BUDGET / units.length)) : 0;
    let expectedPrefix = '';
    let expectedNewlines = 0;
    for (const unit of units) {
      if (perPause > 0) await this.sleep(jitterAround(perPause, 0.4, this.random));
      checkpoint?.();
      if (unit.kind === 'text') {
        await this.cdp.send('Input.insertText', { text: unit.value });
        expectedPrefix += unit.value;
        continue;
      }
      // 裸 Enter 让 ProseMirror 自己执行 splitBlock；携 '\r' 的搜索框专用 keypress 形态不用于正文。
      await dispatchKey(this.cdp as unknown as Parameters<typeof dispatchKey>[0], 'Enter', 'Enter', 13);
      expectedPrefix += '\n';
      expectedNewlines++;
      await this.stabilizeContentAfterNewline(findExpr, expectedPrefix, expectedNewlines);
    }
  }

  private async ensureInputEnabled(): Promise<void> {
    if (!this.cdp || this.inputEnabled) return;
    try {
      await this.cdp.send('Input.enable');
    } catch {
      // 某些环境 Input 无需显式 enable；失败忽略，insertText 仍可尝试。
    }
    this.inputEnabled = true;
  }

  /** 页面侧读回字段当前文本（与 normalizeFieldText 同口径归一）。字段不在 → null。 */
  private async readFieldText(findExpr: string, isContent: boolean): Promise<string | null> {
    if (!this.cdp) return null;
    const READ = String.raw`(() => { const el = ${findExpr}; if (!el) return JSON.stringify({ found: false, text: '' });
      const raw = ${isContent ? `(el.innerText || '')` : `(el.value || '')`};
      return JSON.stringify({ found: true, text: raw.replace(/\s+/g, ' ').trim() }); })()`;
    try {
      const r = await this.cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', { expression: READ, returnByValue: true });
      const parsed = JSON.parse(r?.result?.value ?? '{"found":false,"text":""}') as { found: boolean; text: string };
      return parsed.found ? parsed.text : null;
    } catch {
      return null;
    }
  }

  /**
   * 清空字段（全选 + Backspace）并回读确认真的空了。
   *
   * 必要性（change lease-strict-preemption）：输入是在光标处**追加**，而小红书这条路径过去
   * **没有任何清空前置**——上一次被抢占 / 失败留下的半截正文不清掉，就会和这一篇拼在一起发出去。
   *
   * 三态 MUST 分开：清干净了 / 字段已不在（无残文可留）/ 字段还在但清不掉（真脏页）。
   */
  private async clearField(findExpr: string, isContent: boolean): Promise<FieldClearResult> {
    if (!this.cdp) return { cleared: false, residual: null, fieldFound: false };
    const SELECT = String.raw`(() => { const el = ${findExpr}; if (!el) return JSON.stringify({ found: false, selected: false });
      try {
        el.focus();
        ${
          isContent
            ? `const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);`
            : `el.select();`
        }
        return JSON.stringify({ found: true, selected: true });
      } catch (e) { return JSON.stringify({ found: true, selected: false }); } })()`;
    let residual: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let sel: { found: boolean; selected: boolean };
      try {
        const r = await this.cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', { expression: SELECT, returnByValue: true });
        sel = JSON.parse(r?.result?.value ?? '{"found":false,"selected":false}') as { found: boolean; selected: boolean };
      } catch {
        sel = { found: false, selected: false };
      }
      // 字段不在（页面被导航走）≠ 字段里有清不掉的残文。两者 MUST 区分上报。
      if (!sel.found) return { cleared: false, residual: null, fieldFound: false };
      if (!sel.selected) return { cleared: false, residual: await this.readFieldText(findExpr, isContent), fieldFound: true };
      await dispatchKey(this.cdp as unknown as Parameters<typeof dispatchKey>[0], 'Backspace', 'Backspace', 8);
      residual = await this.readFieldText(findExpr, isContent);
      if (residual === '') return { cleared: true, residual: '', fieldFound: true };
      if (residual === null) return { cleared: false, residual: null, fieldFound: false };
    }
    return { cleared: false, residual, fieldFound: true };
  }

  /**
   * 放弃这一步：清场 + 诚实回报。绝不把「清不干净」谎报成干净页——上游据此知道浏览器里
   * 还躺着残文，而不是以为下一篇能干净地开工。（与 Facebook 侧 abandonFill 同形）
   */
  private async abandonFill(
    base: Pick<PublishCommandResultPayload, 'recordId' | 'seq' | 'kind'>,
    details: { actionId: string; durationMs: number },
    findExpr: string,
    isContent: boolean,
    error: string,
  ): Promise<PublishCommandResultPayload> {
    const cleanup = await this.clearField(findExpr, isContent).catch<FieldClearResult>(() => ({
      cleared: false,
      residual: null,
      fieldFound: true,
    }));
    const suffix = cleanup.cleared ? '' : cleanup.fieldFound ? '_dirty_editor' : '_editor_gone';
    return { ...base, ok: false, error: `${error}${suffix}`, details };
  }

  /**
   * 填标题/正文：标题是 React 受控 input、正文是 tiptap contenteditable——JS 直接赋 value/textContent 都不被框架接收。
   * 用 CDP 真实输入：聚焦目标（校准选择器）→ **清空并回读确认为空** → Input.insertText 逐块输入 → **全文回读校验**。
   *
   * 红线（不假成功）：校验回读全文的语义文字。老的「前 8 字」探针有两个致命面——
   * ① 被抢占 / 失败留下的残文 + 新正文追加，探针只看新正文的前 8 字，照样放行 ⇒ 真发出一篇拼接的帖子；
   * ② 正文被吞掉 90% 也判成功 ⇒ 真发出截断的帖子。全文回读堵住这两条。
   *
   * 正文最终回读先移除 URL，再保留 Unicode 字母和数字，语义相似度达到 90% 放行；空语义投影
   * 回退既有精确子串校验，避免“空投影恒成功”。标题与 Enter 后过程确认保持既有严格口径。
   */
  private async runFillField(
    payload: PublishCommandPayload,
    takeover?: TakeoverCtx,
  ): Promise<PublishCommandResultPayload> {
    const isContent = payload.params.fieldType === 'content';
    const rawValue = payload.params.value ?? '';
    // 标题/正文均原样填入：长度策略收口云端一处（TitleCreator 已保证标题 ≤18、字形安全）。
    // edge 不做任何截断/策略——只原样填、后置校验真写入、失败如实回报（边轻云重；不静默假成功）。
    const value = rawValue;
    if (!this.cdp) {
      return isContent
        ? this.runAtom(payload, buildContentInputRequest(value), new PublishStepValidator({ step: 'input_content', payload: { title: '', content: value, tags: [] } }), takeover)
        : this.runAtom(payload, buildTitleInputRequest(value), new PublishStepValidator({ step: 'input_title', payload: { title: value, content: '', tags: [] } }), takeover);
    }
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    const details = { actionId: isContent ? 'note.publish_content' : 'note.publish_title', durationMs: 0 };
    const finish = (): { actionId: string; durationMs: number } => ({ ...details, durationMs: this.clock() - startedAt });
    // 校准选择器：标题=placeholder「填写标题会有更多赞哦」的 input；正文=tiptap.ProseMirror。
    const findExpr = isContent
      ? `document.querySelector('.tiptap.ProseMirror') || document.querySelector('[contenteditable="true"]')`
      : `document.querySelector('input[placeholder="填写标题会有更多赞哦"]') || document.querySelector('div.edit-container input.d-text') || document.querySelector('input.d-text')`;
    const FOCUS = String.raw`(() => { const el = ${findExpr}; if (!el) return false; try { el.scrollIntoView({ block: 'center' }); } catch (e) {} el.focus(); try { el.click && el.click(); } catch (e) {} return true; })()`;
    const expected = normalizeFieldText(value);
    // 标题沿用既有 Hanzi/精确口径；正文改用包含英文数字的语义文字，空投影时回退精确口径。
    const expectedHanzi = hanziOnly(expected);
    const expectedSemantic = isContent ? normalizeXhsContentSemanticText(value) : '';
    const legacyFillMatches = (readback: string): boolean =>
      expectedHanzi ? hanziOnly(readback).includes(expectedHanzi) : readback.includes(expected);
    const fillMatches = (readback: string): boolean => {
      if (!isContent || expectedSemantic === '') return legacyFillMatches(readback);
      const actualSemantic = normalizeXhsContentSemanticText(readback);
      return actualSemantic.includes(expectedSemantic)
        || xhsContentSemanticSimilarity(expectedSemantic, actualSemantic) >= XHS_CONTENT_SEMANTIC_SIMILARITY_THRESHOLD;
    };
    try {
      await this.ensureInputEnabled();
      const f = await this.cdp.send<{ result?: { value?: boolean } }>('Runtime.evaluate', { expression: FOCUS, returnByValue: true });
      if (f?.result?.value !== true) {
        return { ...base, ok: false, error: 'no_target', details: finish() };
      }
      // 清场前置：输入是追加，不先清空就会把残文和这一篇拼在一起发出去。
      const before = await this.clearField(findExpr, isContent);
      if (!before.fieldFound) return { ...base, ok: false, error: 'no_target', details: finish() };
      if (!before.cleared) {
        const residual = (before.residual ?? '').slice(0, 40);
        return { ...base, ok: false, error: `editor_not_clean: ${JSON.stringify(residual)}`, details: finish() };
      }
      // 拟人：聚焦后短停顿（手移到输入框）→ 逐字打字（替代一次性灌入，标题/正文都逐字）→ 填完微停顿。
      await this.pause(PACING_MS.fieldFocus);
      if (isContent) {
        await this.typeHumanizedContent(value, findExpr, takeover?.checkpoint);
      } else {
        await this.typeHumanized(value, takeover?.checkpoint);
      }
      await this.pause(PACING_MS.fieldDone);
    } catch (err) {
      if (err instanceof TaskTakeoverError) {
        // 让位前 MUST 清场：半截正文留在活着的编辑器里，下一篇稿的清场闸会把它判成 editor_not_clean、
        // 白白毙掉一篇有效稿（清不掉时更会真发出一篇拼接的帖子）。清场是让位前必须跑完的写。
        await this.clearField(findExpr, isContent).catch(() => undefined);
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      // 打字途中抛出的任何异常同样把半截正文留在活着的编辑器里 → MUST 走清场 + 诚实回报。
      return this.abandonFill(base, finish(), findExpr, isContent, `engine_error: ${message}`);
    }
    // 🔴 正文已写入：以下全文回读 MUST NOT 取消——中止 = 把一次可能已生效的填写当成没发生，
    //    而残文还留在编辑器里毒害下一篇。
    const text = await pollBounded<string>({
      probe: async () => {
        const t = await this.readFieldText(findExpr, isContent);
        return t !== null && fillMatches(t) ? t : undefined;
      },
      timeoutMs: 5_000,
      intervalMs: 300,
      clock: this.clock,
      sleep: this.sleep,
    });
    if (text === undefined) {
      return this.abandonFill(base, finish(), findExpr, isContent, 'post_validate_failed');
    }
    if (isContent && expectedSemantic !== '') {
      const similarity = xhsContentSemanticSimilarity(expectedSemantic, text);
      // probe 允许“完整期望文本 + 大量额外内容”先返回，以保留 field_polluted 的诚实分类；
      // 真正成功仍必须达到统一的 90% 对称相似度。
      if (similarity < XHS_CONTENT_SEMANTIC_SIMILARITY_THRESHOLD) {
        return this.abandonFill(base, finish(), findExpr, isContent, `field_polluted: similarity=${similarity.toFixed(4)}`);
      }
    } else {
      const extra = expectedHanzi ? hanziOnly(text).length - expectedHanzi.length : text.length - expected.length;
      if (extra > FILL_EXTRA_CHAR_TOLERANCE) {
        return this.abandonFill(base, finish(), findExpr, isContent, `field_polluted: extra=${extra}`);
      }
    }
    return { ...base, ok: true, details: finish() };
  }

  /**
   * 穿透闭合 shadow 找「文本恰为 label 的元素」的盒模型中心点（CDP DOM 协议级可见闭合 shadow）。
   * 多命中时取最靠下者（底部操作栏）。返回视口 CSS 像素中心坐标，供 Input 坐标点击。
   */
  private async findShadowButtonCenter(label: string): Promise<{ x: number; y: number } | null> {
    if (!this.cdp) return null;
    if (!this.domEnabled) {
      try {
        await this.cdp.send('DOM.enable');
      } catch {
        // 已 enable 或无需 enable
      }
      this.domEnabled = true;
    }
    const doc = await this.cdp.send<{ root?: unknown }>('DOM.getDocument', { depth: -1, pierce: true });
    const hits: number[] = [];
    const walk = (n: any): void => {
      if (!n || typeof n !== 'object') return;
      if (n.nodeType === 1 && Array.isArray(n.children)) {
        if (n.children.some((c: any) => c.nodeType === 3 && (c.nodeValue || '').trim() === label)) {
          hits.push(n.nodeId);
        }
      }
      for (const c of n.children || []) walk(c);
      for (const sr of n.shadowRoots || []) walk(sr);
      if (n.contentDocument) walk(n.contentDocument);
    };
    walk((doc as { root?: unknown }).root);
    let best: { x: number; y: number; cy: number; nodeId: number } | null = null;
    for (const nodeId of hits) {
      try {
        const bm = await this.cdp.send<{ model?: { content?: number[] } }>('DOM.getBoxModel', { nodeId });
        const q = bm?.model?.content;
        if (!q || q.length < 8) continue;
        const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
        const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
        if (!best || cy > best.cy) best = { x: Math.round(cx), y: Math.round(cy), cy, nodeId };
      } catch {
        // 文本节点 / 无布局节点无盒模型，跳过
      }
    }
    // 诊断（change diagnose-publish-submit-failure，只观测不改行为）：记录命中按钮节点的属性，
    // 用于区分「按钮禁用 no-op」——禁用红按钮仍有文字与坐标、点上去无效。诊断失败不影响主路径。
    if (best) {
      try {
        const at = await this.cdp.send<{ attributes?: string[] }>('DOM.getAttributes', { nodeId: best.nodeId });
        const a = at?.attributes ?? [];
        const attr = (k: string): string | undefined => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
        console.warn(
          `[publish-submit-diag] button '${label}' node class=${JSON.stringify(attr('class'))} ` +
          `disabled=${a.includes('disabled')} aria-disabled=${JSON.stringify(attr('aria-disabled'))} center=${best.x},${best.y}`,
        );
      } catch { /* 诊断尽力而为 */ }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  /** 读取定时开关与时间输入真态；只读，找不到任一关键控件即返回保守 false。 */
  private async readScheduleDomState(): Promise<ScheduleDomState> {
    if (!this.cdp) return { checked: false, inputFound: false, value: '' };
    const expression = String.raw`(() => { /*SCHEDULE_STATE*/
      const visible = (el) => { try { const r=el.getBoundingClientRect(); const s=getComputedStyle(el); const vw=window.innerWidth||0,vh=window.innerHeight||0; return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<vw&&r.top<vh&&s.display!=='none'&&s.visibility!=='hidden'; } catch(e) { return false; } };
      const norm = (s) => String(s||'').replace(/\s+/g,'').trim();
      const all = Array.from(document.querySelectorAll('label,span,div,p'));
      const label = all.find((el) => visible(el) && /^定时发布(?:$|[:：])/.test(norm(el.textContent)));
      const scope = label && (label.closest('[class*="post-time-wrapper" i]') || label.closest('[class*="custom-switch-wrapper" i],[class*="form" i],[class*="item" i],[class*="row" i]') || label.parentElement?.parentElement || label.parentElement);
      const root = scope || document;
      const checks = Array.from(root.querySelectorAll('input[type="checkbox"],[role="checkbox"],[class*="switch-simulator" i],[class*="checkbox" i]')).filter(visible);
      const check = checks.find((el) => el instanceof HTMLInputElement || el.hasAttribute('aria-checked') || /(^|[\s_-])(un)?checked([\s_-]|$)/i.test(String(el.className||''))) || checks[0] || null;
      const checkClass = String(check&&check.className||'');
      const checked = !!check && ((check instanceof HTMLInputElement && check.checked) || check.getAttribute('aria-checked')==='true' || (!/(^|[\s_-])unchecked([\s_-]|$)/i.test(checkClass) && /(^|[\s_-])(checked|active|selected)([\s_-]|$)/i.test(checkClass)));
      const inputs = Array.from(root.querySelectorAll('input')).filter((el) => visible(el) && el.type!=='checkbox');
      const input = inputs.find((el) => /时间|日期|date|time/i.test((el.placeholder||'')+' '+(el.getAttribute('aria-label')||'')+' '+(el.type||''))) || inputs[0] || null;
      const toggleEl = check && (check.closest('label,[role="checkbox"],[class~="d-switch"],[class*="custom-switch-switch" i],[class*="checkbox" i]') || check) || label;
      let toggle;
      if (toggleEl) { const r=toggleEl.getBoundingClientRect(); if(r.width>0&&r.height>0) toggle={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; }
      return JSON.stringify({checked,inputFound:!!input,value:input ? String(input.value||input.getAttribute('value')||'') : '',toggle});
    })()`;
    try {
      const response = await this.cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', { expression, returnByValue: true });
      const parsed = JSON.parse(response?.result?.value ?? '{}') as Partial<ScheduleDomState>;
      return {
        checked: parsed.checked === true,
        inputFound: parsed.inputFound === true,
        value: typeof parsed.value === 'string' ? parsed.value : '',
        ...(parsed.toggle && Number.isFinite(parsed.toggle.x) && Number.isFinite(parsed.toggle.y) ? { toggle: parsed.toggle } : {}),
      };
    } catch {
      return { checked: false, inputFound: false, value: '' };
    }
  }

  /** 用原生 value setter + input/change/blur 写平台受控时间输入；回 false 表示控件不存在/拒绝写入。 */
  private async writeScheduleTime(displayTime: string): Promise<boolean> {
    if (!this.cdp) return false;
    const localValue = displayTime.replace(' ', 'T');
    const expression = String.raw`(() => { /*SCHEDULE_SET_TIME*/
      const visible = (el) => { try { const r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(el).display!=='none'; } catch(e) { return false; } };
      const norm = (s) => String(s||'').replace(/\s+/g,'').trim();
      const label = Array.from(document.querySelectorAll('label,span,div,p')).find((el) => visible(el) && /^定时发布(?:$|[:：])/.test(norm(el.textContent)));
      const scope = label && (label.closest('[class*="post-time-wrapper" i]') || label.closest('[class*="custom-switch-wrapper" i],[class*="form" i],[class*="item" i],[class*="row" i]') || label.parentElement?.parentElement || label.parentElement);
      const root = scope || document;
      const inputs = Array.from(root.querySelectorAll('input')).filter((el) => visible(el) && el.type!=='checkbox');
      const el = inputs.find((node) => /时间|日期|date|time/i.test((node.placeholder||'')+' '+(node.getAttribute('aria-label')||'')+' '+(node.type||''))) || inputs[0];
      if(!el) return false;
      const value = el.type==='datetime-local' ? ${JSON.stringify(localValue)} : ${JSON.stringify(displayTime)};
      try {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto,'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
        if(desc&&desc.set) desc.set.call(el,value); else el.value=value;
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
        el.blur();
        return true;
      } catch(e) { return false; }
    })()`;
    try {
      const response = await this.cdp.send<{ result?: { value?: boolean } }>('Runtime.evaluate', { expression, returnByValue: true });
      return response?.result?.value === true;
    } catch {
      return false;
    }
  }

  /** 将定时设置行滚入可点击视口；页面设置区位于独立长滚动容器内，不能直接点击屏外坐标。 */
  private async revealScheduleRow(): Promise<boolean> {
    if (!this.cdp) return false;
    const expression = String.raw`(() => { /*SCHEDULE_REVEAL*/
      const norm=(s)=>String(s||'').replace(/\s+/g,'').trim();
      const label=Array.from(document.querySelectorAll('label,span,div,p')).find((el)=>/^定时发布(?:$|[:：])/.test(norm(el.textContent)));
      if(!label)return false;
      const row=label.closest('[class*="post-time-wrapper" i]')||label.closest('[class*="custom-switch-wrapper" i],[class*="form" i],[class*="item" i],[class*="row" i]')||label;
      row.scrollIntoView({block:'center',inline:'nearest'});
      return true;
    })()`;
    try {
      const response = await this.cdp.send<{ result?: { value?: boolean } }>('Runtime.evaluate', { expression, returnByValue: true });
      if (response?.result?.value !== true) return false;
      await this.sleep(150);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 小红书原生定时设置：窗口校验 → 开开关 → 写北京时间 → 三项正证据（checked/value/定时发布按钮）。
   * 任何失败都 fail-closed；绝不回退通用「页面有定时文案即成功」假校验。
   */
  private async runSetSchedule(
    payload: PublishCommandPayload,
    publishTime: number,
    takeover?: TakeoverCtx,
  ): Promise<PublishCommandResultPayload> {
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    const details = () => ({ actionId: 'note.publish_set_schedule', durationMs: this.clock() - startedAt });
    this.scheduleModeConfirmed = false;
    if (!this.cdp) return { ...base, ok: false, error: 'kind_not_implemented', details: details() };
    if (!isValidXhsScheduleTime(publishTime, this.clock())) {
      return { ...base, ok: false, error: 'schedule_time_out_of_range', details: details() };
    }
    const displayTime = formatXhsScheduleTime(publishTime);
    try {
      await this.ensureInputEnabled();
      takeover?.checkpoint();
      if (!(await this.revealScheduleRow())) return { ...base, ok: false, error: 'no_target', details: details() };
      let state = await this.readScheduleDomState();
      if (!state.checked) {
        if (!state.toggle) return { ...base, ok: false, error: 'no_target', details: details() };
        await dispatchClick(this.cdp, state.toggle.x, state.toggle.y, {
          random: this.random,
          sleep: this.sleep,
          overshoot: false,
          jitter: 0,
        });
        state = await pollBounded<ScheduleDomState>({
          probe: async () => {
            const next = await this.readScheduleDomState();
            return next.checked ? next : undefined;
          },
          timeoutMs: 5_000,
          intervalMs: 250,
          clock: this.clock,
          sleep: this.sleep,
        }) ?? { checked: false, inputFound: false, value: '' };
      }
      if (!state.checked) return { ...base, ok: false, error: 'post_validation_failed', details: details() };
      if (!state.inputFound) return { ...base, ok: false, error: 'no_target', details: details() };
      if (!(await this.writeScheduleTime(displayTime))) {
        return { ...base, ok: false, error: 'post_validation_failed', details: details() };
      }
      const verified = await pollBounded<ScheduleDomState>({
        probe: async () => {
          const next = await this.readScheduleDomState();
          const normalized = next.value.replace('T', ' ').slice(0, 16);
          return next.checked && next.inputFound && normalized === displayTime ? next : undefined;
        },
        timeoutMs: 5_000,
        intervalMs: 250,
        clock: this.clock,
        sleep: this.sleep,
      });
      if (!verified || !(await this.findShadowButtonCenter('定时发布'))) {
        return { ...base, ok: false, error: 'post_validation_failed', details: details() };
      }
      this.scheduleModeConfirmed = true;
      return { ...base, ok: true, value: displayTime, details: details() };
    } catch (err) {
      rethrowIfTakeover(err);
      return { ...base, ok: false, error: `engine_error: ${err instanceof Error ? err.message : String(err)}`, details: details() };
    }
  }

  /**
   * 诊断（change diagnose-publish-submit-failure，只观测不改行为）：只读捕获点击坐标处的页面状态——
   * 顶层命中元素 / 是否在弹层内 / role=dialog / toast 文案 / 正文头 / URL，用于区分
   * (a) 遮挡或风控 toast 拦截 vs (b) 点到按钮但 no-op vs (c) URL 是否已跳。捕获失败不影响主路径。
   */
  private async logSubmitDiag(x: number, y: number, when: string): Promise<void> {
    if (!this.cdp) return;
    const EXPR = String.raw`(() => { try {
      const X=${x}, Y=${y};
      const top = document.elementFromPoint(X, Y);
      const desc = (e) => e ? (e.tagName + (e.id ? '#'+e.id : '') + (e.className && e.className.toString ? '.'+e.className.toString().trim().split(/\s+/).join('.') : '')).slice(0,160) : null;
      const dialogs = Array.from(document.querySelectorAll('[role=dialog],[aria-modal="true"]')).map(function(d){ return { sel: desc(d), text: (d.innerText||'').replace(/\s+/g,' ').slice(0,120) }; });
      const toast = document.querySelector('[class*="toast" i],[class*="message" i],[class*="tips" i]');
      return JSON.stringify({
        href: location.href,
        atPoint: desc(top),
        atPointInDialog: !!(top && top.closest && top.closest('[role=dialog],[aria-modal]')),
        dialogs: dialogs,
        toast: toast ? { sel: desc(toast), text: (toast.innerText||'').replace(/\s+/g,' ').slice(0,120) } : null,
        bodyHead: ((document.body&&document.body.innerText)||'').replace(/\s+/g,' ').slice(0,200)
      });
    } catch (e) { return JSON.stringify({ diagError: String(e) }); } })()`;
    try {
      const r = await this.cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', { expression: EXPR, returnByValue: true });
      console.warn(`[publish-submit-diag] ${when}: ${r?.result?.value ?? '(no value)'}`);
    } catch (err) {
      console.warn(`[publish-submit-diag] ${when}: capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 点「发布」提交：发布栏是自定义元素 <xhs-publish-btn>（闭合 shadow，文本搜不到）；
   * 「发布」为其右侧红色按钮、「暂存离开」在左。用坐标点击宿主右侧区域（安全避开左侧暂存），再后置校验发布成功。
   */
  private async runSubmit(
    payload: PublishCommandPayload,
    takeover?: TakeoverCtx,
  ): Promise<PublishCommandResultPayload> {
    if (!this.cdp) {
      return this.runAtom(payload, buildSubmitPublishRequest(), new PublishStepValidator({ step: 'submit_publish', payload: synthPayload(payload) }), takeover);
    }
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    const details = { actionId: 'note.publish_submit', durationMs: 0 };
    // 已派发提交动作（6.2）：点击真正发出那一刻置真；center 查找 / no_target 等**点击之前**的失败保持 false。
    let submitDispatched = false;
    // 提交窗口守卫（5.1）：点「发布」前 enter、确认段（≤15s poll）内绝不被强杀，disposer 关窗（时基兜底自动过期）。
    let closeWindow: (() => void) | undefined;
    // 发布按钮在 <xhs-publish-btn> 闭合 shadow 内（BUTTON.ce-btn.bg-red，文本「发布」）；CDP DOM 穿透闭合 shadow 取精确盒模型中心点。
    let center: { x: number; y: number } | null = null;
    try {
      await this.ensureInputEnabled();
      center = await this.findShadowButtonCenter(this.scheduleModeConfirmed ? '定时发布' : '发布');
    } catch (err) {
      rethrowIfTakeover(err);
      const message = err instanceof Error ? err.message : String(err);
      return { ...base, ok: false, error: `engine_error: ${message}`, details: { ...details, durationMs: this.clock() - startedAt } };
    }
    if (!center) {
      return { ...base, ok: false, error: 'no_target', details: { ...details, durationMs: this.clock() - startedAt } };
    }
    const { x, y } = center;
    try {
      if (this.pacingEnabled) {
        // 拟人：点「发布」前"通读全文确认"停留，再走贝塞尔轨迹点击。
        // 关键：发布按钮小而精确，**关掉 overshoot/落点抖动**（精确落点）确保点中——保留移动轨迹(反检测)，但不冒"点偏发不出"的险。
        await this.pause(PACING_MS.submitReview);
        // 🔴 整条发布流的**最后一个安全取消点**：帖子一个字节都还没提交出去。
        takeover?.checkpoint();
        // 🔴 提交窗口开启（5.1）：越过此点即不可逆，协调器此间不强杀（回 window_busy + 剩余预算）。
        closeWindow = this.publishGuard?.enter(15_000, 'xhs_publish_submit');
        await dispatchClick(this.cdp, x, y, {
          random: this.random,
          sleep: this.sleep,
          overshoot: false,
          jitter: 0,
          // 贝塞尔轨迹途中也能让路——但只在按下之前（cdp-util 的按下-松开是原子区）。
          checkpoint: takeover?.checkpoint,
          // 🔴 6.2：press 派发那一刻置真——即便 press 响应超时/release 抛出（点击可能已生效），也不谎报「压根没点」→ 双发。
          onPressDispatched: () => {
            submitDispatched = true;
          },
        });
      } else {
        takeover?.checkpoint();
        // 🔴 提交窗口开启（5.1）：同 pacing 路径，越过此点即不可逆。
        closeWindow = this.publishGuard?.enter(15_000, 'xhs_publish_submit');
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        // 🔴 6.2：mousePressed 已发出即置真（此后 mouseReleased 抛出，点击也可能已生效）；mousePressed 抛出则跳 catch、保持假（正确）。
        submitDispatched = true;
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      }
    } catch (err) {
      closeWindow?.(); // 点击段抛错（含被接管前的 CDP 故障）：关窗，别让一个已作废的提交窗口挡住后续抢占。
      rethrowIfTakeover(err);
      const message = err instanceof Error ? err.message : String(err);
      // 🔴 MUST 带 submitDispatched：若 press 已派发（onPressDispatched 已置真）但 CDP 响应抛错，回执必须如实告知「已点」，
      //    否则云端按提交前失败重投 → 双发（复核 wf_1657e89b MEDIUM）。press 未发时它仍为 false（正确）。
      return { ...base, ok: false, error: `engine_error: ${message}`, submitDispatched, details: { ...details, durationMs: this.clock() - startedAt } };
    }
    // 点击已派发（submitDispatched 由上面两分支在 press 派发那一刻各自置真，覆盖 press 已发/release 抛出的窗口）。
    // 诊断（只观测）：点击后立即快照页面状态（在 deadline 计算之前，不占用 15s 校验窗口）。
    await this.logSubmitDiag(x, y, 'after-click');
    // 🔴 提交点已跨过：以下 MUST NOT 取消（全仓代价最高的禁区）。中止 = 一篇**可能已经发出去的帖子**
    //    被当成没发生 → 云端重投 → 发两遍。pollBounded 签名里没有取消入参，编译器焊死。
    // 后置校验：**只认正证据**——页面成功文案（5.9 收紧）。原「离开发布编辑页(!href.includes('/publish/publish'))」
    // 判据是已上膛的假成功：抢占方 / 恢复导航会在这 15s 窗口内把发布页导走 → 一篇可能根本没发出去的稿被记成已发布。
    // 该假成功由 5.2/5.3（publishInFlight 闸封住恢复导航）从根上堵住，这里再去掉 URL 判据做纵深防御（URL 缺失单独不得判成功）。
    // 真机项 F/D 待核：若确有成功后跳转的落地帖 URL 正证据，可再补为「成功文案 OR 落地帖 URL」白名单。
    const CHECK = String.raw`(() => { const b = (document.body && document.body.innerText) || ''; return /发布成功|发布中|笔记已?发布|成功发布|稍后可在/.test(b); })()`;
    const ok = await pollBounded<true>({
      probe: async () => {
        try {
          const c = await this.cdp!.send<{ result?: { value?: boolean } }>('Runtime.evaluate', { expression: CHECK, returnByValue: true });
          return c?.result?.value === true ? true : undefined;
        } catch {
          return undefined; // 忽略瞬时失败
        }
      },
      timeoutMs: 15_000,
      intervalMs: 500,
      clock: this.clock,
      sleep: this.sleep,
    });
    closeWindow?.(); // 确认段结束：关窗（成功/超时都在此后回执，窗口不再需要保护）。
    if (ok) return { ...base, ok: true, submitDispatched, details: { ...details, durationMs: this.clock() - startedAt } };
    // 诊断（只观测）：超时时快照终态——区分 仍在编辑页有弹层/toast vs 已跳但晚于窗口。
    await this.logSubmitDiag(x, y, 'timeout');
    return { ...base, ok: false, error: 'post_validate_failed', submitDispatched, details: { ...details, durationMs: this.clock() - startedAt } };
  }

  /**
   * 加话题（change split-topic-roles，实机校准）：在正文富文本 `.tiptap.ProseMirror` 里打 `#关键词`
   * → 等平台建议下拉 `.tippy-box[role="tooltip"]` → **真实鼠标事件**点匹配建议（无精确命中点「新建话题」贴字面词）
   * → 后置校验正文出现真话题 token `a.tiptap-topic`（非纯文本）。fail-closed，绝不静默假成功。
   * 仅在开关开 + cdp 注入时被 dispatch 调用（见 add_with_candidate 分支）。
   */
  private async runAddTopic(
    payload: PublishCommandPayload,
    keyword: string,
    takeover?: TakeoverCtx,
  ): Promise<PublishCommandResultPayload> {
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    const details = { actionId: 'note.publish_topic', durationMs: 0 };
    const done = (extra: { ok: boolean; error?: string }): PublishCommandResultPayload => ({ ...base, details: { ...details, durationMs: this.clock() - startedAt }, ...extra });
    const kw = keyword.replace(/^#+/, '').trim();
    if (!this.cdp || !kw) return done({ ok: false, error: 'no_target' });
    try {
      await this.ensureInputEnabled();
      // 1. 聚焦正文编辑器、光标移到正文末尾（避免插进已有 token 中间）。
      const FOCUS = String.raw`(() => { const el = document.querySelector('.tiptap.ProseMirror') || document.querySelector('[contenteditable="true"]'); if(!el) return false; try{el.scrollIntoView({block:'center'});}catch(e){} el.focus(); try{el.click&&el.click();}catch(e){} try{const r=document.createRange();r.selectNodeContents(el);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);}catch(e){} return true; })()`;
      const f = await this.cdp.send<{ result?: { value?: boolean } }>('Runtime.evaluate', { expression: FOCUS, returnByValue: true });
      if (f?.result?.value !== true) return done({ ok: false, error: 'no_target' });
      await this.pause(PACING_MS.fieldFocus);
      // 本步**唯一**的安全取消点：话题词尚未进正文。
      takeover?.checkpoint();
      // 2. 打 " #关键词"（逐字触发建议下拉；前导空格避免与前一 token 粘连）。
      // 🔴 **不传 checkpoint**：中途取消会在正文里留一串裸 ' #关键'，而本文件唯一的清场原语 clearField
      //    是**整字段清空**——此刻正文里躺着整篇稿子，清它等于毁稿。「取消 + 清场」这条路在加话题上
      //    根本不存在 ⇒ 打完就没有安全取消点，把剩下的下拉等待与后置校验跑完再让位（合计 ≤10s）。
      await this.typeHumanized(' #' + kw);
      // 3. 轮询等下拉里的目标项（优先文本精确匹配 #kw；否则「新建话题」首项贴字面词），取其视口中心坐标。
      const CENTER = String.raw`(() => {
        const box = document.querySelector('.tippy-box[role="tooltip"]'); if(!box) return '';
        const items = Array.prototype.slice.call(box.querySelectorAll('#creator-editor-topic-container .item, .item'));
        if(!items.length) return '';
        const norm = function(s){ return (s||'').replace(/\s+/g,'').replace(/^#/,''); };
        const kw = ${JSON.stringify(kw)};
        const exact = items.find(function(e){ return !/新建话题/.test(e.innerText||'') && norm(e.innerText).indexOf(kw)===0; });
        const create = items.find(function(e){ return /新建话题/.test(e.innerText||''); });
        // 只选「文本精确匹配的项」或「新建话题」；都没有则不点（避免误贴一个无关话题）→ 上层 no_target。
        const target = exact || create; if(!target) return '';
        const r = target.getBoundingClientRect(); if(!(r.width>0 && r.height>0)) return '';
        return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
      })()`;
      // 🔴 话题词已进正文：以下两个轮询 MUST NOT 取消（清场会毁稿，见上）。
      const center = await pollBounded<{ x: number; y: number }>({
        probe: async () => {
          try {
            const c = await this.cdp!.send<{ result?: { value?: string } }>('Runtime.evaluate', { expression: CENTER, returnByValue: true });
            const v = c?.result?.value;
            return v ? (JSON.parse(v) as { x: number; y: number }) : undefined;
          } catch {
            return undefined; // 瞬时 evaluate 失败，继续轮询
          }
        },
        timeoutMs: 4000,
        intervalMs: 250,
        clock: this.clock,
        sleep: this.sleep,
      });
      if (!center) return done({ ok: false, error: 'no_target' });
      await this.pause(PACING_MS.fieldFocus);
      // 4. 真实鼠标事件点建议（.click() 实测不提交待定 span）。精确落点、保留移动轨迹（反检测）。
      await dispatchClick(this.cdp, center.x, center.y, { random: this.random, sleep: this.sleep, overshoot: false, jitter: 0 });
      // 5. 后置校验：正文出现真话题 token（a.tiptap-topic），非纯文本。读 DOM 快照 + committedTopicPill，fail-closed。
      const committed = await pollBounded<true>({
        probe: async () => {
          let root: Element | Document | undefined;
          try {
            root = await this.deps.dom.getRoot();
          } catch {
            root = undefined;
          }
          return root && committedTopicPill(root, kw) ? true : undefined;
        },
        timeoutMs: 4000,
        intervalMs: 300,
        clock: this.clock,
        sleep: this.sleep,
      });
      if (committed) return done({ ok: true });
      return done({ ok: false, error: 'post_validate_failed' });
    } catch (err) {
      rethrowIfTakeover(err);
      const message = err instanceof Error ? err.message : String(err);
      return done({ ok: false, error: `engine_error: ${message}` });
    }
  }

  /** 通用原子执行：构造带 validator 的引擎跑 resolveAndAct，按真实结果组装回报。 */
  private async runAtom(
    payload: PublishCommandPayload,
    req: ActionRequest,
    validator: PostValidator,
    takeover?: TakeoverCtx,
  ): Promise<PublishCommandResultPayload> {
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    let result: ActionResult;
    try {
      const engine = new LocatingEngine({ ...this.deps, validator }, this.options);
      result = await engine.resolveAndAct(req, takeover);
    } catch (err) {
      rethrowIfTakeover(err);
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...base,
        ok: false,
        error: `engine_error: ${message}`,
        details: { actionId: req.actionId, durationMs: this.clock() - startedAt },
      };
    }
    const details = {
      actionId: result.actionId,
      outcome: result.outcome,
      attempts: result.attempts,
      durationMs: this.clock() - startedAt,
    };
    // 红线：engine 内部已跑后置校验，result.ok 即真实结果（定位失败 / 校验失败 → ok:false）。此处绝不翻成 ok:true。
    if (!result.ok) {
      return { ...base, ok: false, error: result.reason || result.outcome, details };
    }
    return { ...base, ok: true, details };
  }

  /** 抓真实 postId：只读 DOM，抓不到诚实 no_target，绝不 postId||fake。 */
  private async runCapturePostId(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    let postId: string | undefined;
    // 详情页分享链接（带 xsec_token）：附带抓取，供后台跳转。抓取失败绝不连累 postId 抓取/成功判定。
    let postUrl: string | undefined;
    try {
      const root = await this.deps.dom.getRoot();
      postId = extractPostId(root);
      try {
        postUrl = extractPostUrl(root);
      } catch {
        postUrl = undefined;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...base,
        ok: false,
        error: `dom_error: ${message}`,
        details: { actionId: CAPTURE_POST_ID_ACTION, durationMs: this.clock() - startedAt },
      };
    }
    if (!postId) {
      return {
        ...base,
        ok: false,
        error: 'no_target',
        details: { actionId: CAPTURE_POST_ID_ACTION, durationMs: this.clock() - startedAt },
      };
    }
    return {
      ...base,
      ok: true,
      value: postId,
      // 抓到带 xsec_token 的完整分享链接才带；抓不到为 undefined（诚实置空，云端不写假链接）。
      ...(postUrl ? { postUrl } : {}),
      details: { actionId: CAPTURE_POST_ID_ACTION, durationMs: this.clock() - startedAt },
    };
  }

  /** 导航到创作平台笔记管理并等待列表壳出现；只读核验，不携 takeover 取消点。 */
  private async navigateToManage(): Promise<boolean> {
    if (!this.cdp) return false;
    try {
      await this.cdp.send('Page.navigate', { url: XHS_CREATOR_MANAGE_URL });
    } catch {
      return false;
    }
    return !!(await pollBounded<true>({
      probe: async () => {
        try {
          const response = await this.cdp!.send<{ result?: { value?: boolean } }>('Runtime.evaluate', {
            expression: String.raw`(() => { /*MANAGE_READY*/ const text=(document.body&&document.body.innerText)||''; return /笔记管理|内容管理/.test(text); })()`,
            returnByValue: true,
          });
          return response?.result?.value === true ? true : undefined;
        } catch {
          return undefined;
        }
      },
      timeoutMs: 20_000,
      intervalMs: 500,
      clock: this.clock,
      sleep: this.sleep,
    }));
  }

  /** 点击笔记管理的精确语义 tab；只点可见项，找不到诚实 false。 */
  private async clickManageTab(label: '全部' | '定时发布' | '已发布'): Promise<boolean> {
    if (!this.cdp) return false;
    const expression = String.raw`(() => { /*MANAGE_TAB*/
      const wanted=${JSON.stringify(label)};
      const visible=(el)=>{try{const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}catch(e){return false;}};
      const norm=(s)=>String(s||'').replace(/\s+/g,'').trim();
      const candidates=Array.from(document.querySelectorAll('[role="tab"],button,a,li,div,span')).filter((el)=>visible(el));
      const target=candidates.find((el)=>{const text=norm(el.textContent);return text===wanted||text.startsWith(wanted+'(')||text.startsWith(wanted+'（')||(wanted==='全部'&&text.startsWith('全部'));});
      if(!target)return false;
      target.click();
      return true;
    })()`;
    try {
      const response = await this.cdp.send<{ result?: { value?: boolean } }>('Runtime.evaluate', { expression, returnByValue: true });
      return response?.result?.value === true;
    } catch {
      return false;
    }
  }

  /**
   * 在当前管理 tab 中做保守唯一匹配。内部 id 优先；否则必须同时命中冻结标题与目标日期/分钟。
   * 只接受平台给出的 explore 链接，绝不从裸 id 拼 URL。
   */
  private async findManagedNote(
    title: string,
    publishTime: number,
    scheduledPlatformId?: string,
    expectedStatus?: 'scheduled' | 'published',
  ): Promise<ManagedNoteMatch> {
    if (!this.cdp) return { state: 'missing' };
    const displayTime = formatXhsScheduleTime(publishTime);
    const expression = String.raw`(() => { /*MANAGED_NOTE_MATCH*/
      const title=${JSON.stringify(title)};
      const display=${JSON.stringify(displayTime)};
      const wantedId=${JSON.stringify(scheduledPlatformId ?? '')};
      const expectedStatus=${JSON.stringify(expectedStatus ?? '')};
      const norm=(s)=>String(s||'').replace(/\s+/g,'').trim();
      const titleNorm=norm(title);
      const d=new Date(${JSON.stringify(publishTime)});
      const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d);
      const get=(t)=>parts.find((p)=>p.type===t)?.value||'';
      const y=get('year'),m=get('month'),day=get('day'),hm=get('hour')+':'+get('minute');
      const dateSignals=[norm(display),norm(y+'/'+m+'/'+day+' '+hm),norm(y+'年'+m+'月'+day+'日 '+hm),norm(Number(m)+'月'+Number(day)+'日 '+hm)];
      const seen=new Set(); const rows=[];
      const seeds=Array.from(document.querySelectorAll('[data-impression],a[href*="/explore/"],a[href*="/discovery/item/"]'));
      for(const seed of seeds){
        const row=seed.closest('tr,li,[class*="note" i],[class*="card" i],[class*="item" i]')||seed.parentElement||seed;
        if(seen.has(row))continue;seen.add(row);
        const text=norm(row.innerText||row.textContent||'');
        const signalEls=[row,...Array.from(row.querySelectorAll('[data-impression]'))];
        const raw=signalEls.map((el)=>el.getAttribute&&el.getAttribute('data-impression')||'').join(' ');
        const idMatch=raw.match(/["'](?:note_id|noteId)["']\s*:\s*["']([0-9a-f]{16,32})["']/i);
        const link=Array.from(row.querySelectorAll('a[href]')).find((a)=>/xiaohongshu\.com\/(?:explore|discovery\/item)\//i.test(a.href||''));
        const href=link&&link.href||'';
        const urlId=(href.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{16,32})/i)||[])[1]||'';
        const noteId=idMatch&&idMatch[1]||urlId;
        const idOk=!!wantedId&&(noteId===wantedId||raw.includes(wantedId));
        const titleOk=!!titleNorm&&text.includes(titleNorm);
        const timeOk=dateSignals.some((s)=>s&&text.includes(s));
        const statusOk=expectedStatus!=='scheduled'||text.includes(norm('定时发布'));
        if(statusOk&&(idOk||(titleOk&&timeOk)))rows.push({noteId,postUrl:href,text});
      }
      const unique=[];const keys=new Set();
      for(const row of rows){const key=row.noteId||row.postUrl||row.text;if(keys.has(key))continue;keys.add(key);unique.push(row);}
      if(unique.length===0)return JSON.stringify({state:'missing'});
      if(unique.length!==1)return JSON.stringify({state:'ambiguous'});
      return JSON.stringify({state:'found',noteId:unique[0].noteId||undefined,postUrl:unique[0].postUrl||undefined});
    })()`;
    try {
      const response = await this.cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', { expression, returnByValue: true });
      const parsed = JSON.parse(response?.result?.value ?? '{}') as Partial<ManagedNoteMatch>;
      if (parsed.state !== 'found' && parsed.state !== 'ambiguous') return { state: 'missing' };
      return {
        state: parsed.state,
        ...(typeof parsed.noteId === 'string' && parsed.noteId ? { noteId: parsed.noteId } : {}),
        ...(typeof parsed.postUrl === 'string' && parsed.postUrl ? { postUrl: parsed.postUrl } : {}),
      };
    } catch {
      return { state: 'missing' };
    }
  }

  /** 定时提交后抓平台内部句柄；失败不代表提交失败，由 cloud 保持 scheduled 并后续按标题/时间对账。 */
  private async runCaptureScheduled(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    const details = () => ({ actionId: CAPTURE_SCHEDULED_ACTION, durationMs: this.clock() - startedAt });
    const title = payload.params.scheduledTitle?.trim() ?? '';
    const publishTime = payload.params.publishTime ?? 0;
    if (!this.cdp) return { ...base, ok: false, error: 'kind_not_implemented', details: details() };
    if (!title || !Number.isFinite(publishTime)) return { ...base, ok: false, error: 'invalid_schedule_identity', details: details() };
    if (!(await this.navigateToManage())) return { ...base, ok: false, error: 'manage_navigation_failed', details: details() };
    if (!(await this.clickManageTab('定时发布'))) return { ...base, ok: false, error: 'no_target', details: details() };
    let match = await pollBounded<ManagedNoteMatch>({
      probe: async () => {
        const next = await this.findManagedNote(title, publishTime, undefined, 'scheduled');
        return next.state === 'missing' ? undefined : next;
      },
      timeoutMs: 3_000,
      intervalMs: 500,
      clock: this.clock,
      sleep: this.sleep,
    });
    // 平台刚提交后「定时发布」筛选偶尔短暂返回空集，但「全部」已出现带定时状态的卡片；
    // 只在卡片同时命中冻结标题、目标分钟和“定时发布”状态时兜底，仍保持 fail-closed。
    if (!match && await this.clickManageTab('全部')) {
      match = await pollBounded<ManagedNoteMatch>({
        probe: async () => {
          const next = await this.findManagedNote(title, publishTime, undefined, 'scheduled');
          return next.state === 'missing' ? undefined : next;
        },
        timeoutMs: 8_000,
        intervalMs: 500,
        clock: this.clock,
        sleep: this.sleep,
      });
    }
    if (!match) return { ...base, ok: false, error: 'scheduled_record_not_found', details: details() };
    if (match.state === 'ambiguous') return { ...base, ok: false, error: 'ambiguous_match', details: details() };
    if (!match.noteId) return { ...base, ok: false, error: 'scheduled_id_unavailable', details: details() };
    return { ...base, ok: true, value: match.noteId, details: details() };
  }

  /** 到期后只读对账：仍在定时列表即 pending；已发布列表必须同时给真实 id 与平台 URL 才确认。 */
  private async runReconcileScheduled(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    const details = () => ({ actionId: RECONCILE_SCHEDULED_ACTION, durationMs: this.clock() - startedAt });
    const title = payload.params.scheduledTitle?.trim() ?? '';
    const publishTime = payload.params.publishTime ?? 0;
    const scheduledId = payload.params.scheduledPlatformId?.trim() || undefined;
    if (!this.cdp) return { ...base, ok: false, error: 'kind_not_implemented', details: details() };
    if (!title || !Number.isFinite(publishTime)) return { ...base, ok: false, error: 'invalid_schedule_identity', details: details() };
    if (!(await this.navigateToManage())) return { ...base, ok: false, error: 'manage_navigation_failed', details: details() };

    if (await this.clickManageTab('定时发布')) {
      const stillScheduled = await this.findManagedNote(title, publishTime, scheduledId, 'scheduled');
      if (stillScheduled.state === 'ambiguous') return { ...base, ok: false, error: 'ambiguous_match', details: details() };
      if (stillScheduled.state === 'found') return { ...base, ok: false, error: 'scheduled_pending', details: details() };
    }
    // 同 capture：筛选页可能短暂为空；在“全部”中只认明确带“定时发布”状态的唯一卡片。
    if (await this.clickManageTab('全部')) {
      const stillScheduled = await this.findManagedNote(title, publishTime, scheduledId, 'scheduled');
      if (stillScheduled.state === 'ambiguous') return { ...base, ok: false, error: 'ambiguous_match', details: details() };
      if (stillScheduled.state === 'found') return { ...base, ok: false, error: 'scheduled_pending', details: details() };
    }
    if (!(await this.clickManageTab('已发布'))) return { ...base, ok: false, error: 'no_target', details: details() };
    const published = await pollBounded<ManagedNoteMatch>({
      probe: async () => {
        const next = await this.findManagedNote(title, publishTime, scheduledId);
        return next.state === 'missing' ? undefined : next;
      },
      timeoutMs: 10_000,
      intervalMs: 500,
      clock: this.clock,
      sleep: this.sleep,
    });
    if (!published) return { ...base, ok: false, error: 'published_record_not_found', details: details() };
    if (published.state === 'ambiguous') return { ...base, ok: false, error: 'ambiguous_match', details: details() };
    if (!published.noteId) return { ...base, ok: false, error: 'public_post_id_unavailable', details: details() };
    if (!published.postUrl) return { ...base, ok: false, error: 'public_link_unavailable', details: details() };
    return { ...base, ok: true, value: published.noteId, postUrl: published.postUrl, details: details() };
  }

  /** 配图上传：URL→下载→CDP 文件输入桥→后置校验成功态。未注入 uploader 则诚实 kind_not_implemented。 */
  private async runUploadImage(
    payload: PublishCommandPayload,
    takeover?: TakeoverCtx,
  ): Promise<PublishCommandResultPayload> {
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    const imageUrl = payload.params.imageUrl;
    if (!this.uploader) return this.notImplemented(payload);
    if (!imageUrl) {
      return { ...base, ok: false, error: 'no_target', details: { actionId: 'note.publish_upload_image', durationMs: this.clock() - startedAt } };
    }
    // 上传器自己管取消边界：下载段可取消、塞文件之后不可取消（TaskTakeoverError 由 dispatch 顶层分类）。
    const r = await this.uploader.upload(imageUrl, takeover);
    const details = { actionId: 'note.publish_upload_image', durationMs: this.clock() - startedAt };
    // 红线：上传器的 ok 即真实结果（下载/桥接/后置校验任一失败 → ok:false），此处绝不翻成 ok:true。
    if (!r.ok) return { ...base, ok: false, error: r.error ?? 'upload_failed', details };
    return { ...base, ok: true, details };
  }

  private notImplemented(payload: PublishCommandPayload): PublishCommandResultPayload {
    return {
      recordId: payload.recordId,
      seq: payload.seq,
      kind: payload.kind,
      ok: false,
      error: 'kind_not_implemented',
    };
  }
}
