/**
 * PublishCommandDispatcher — A 阶段1 边缘「指令运行时」。
 *
 * 云端 CommandSequencer 逐条下发 `publish.command {recordId, seq, kind, params}`；
 * 边缘按 `kind` 路由到处理器，复用 `LocatingEngine` 五层编排 + 三道闸（守卫→定位→执行→后置校验→晋升）
 * 做「定位 + 原子操作 + 后置校验」，逐条回 `publish.command.result {recordId, seq, kind, ok, value?, error?, details?}`。
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
  PublishRequestPayload,
} from '../comm/protocol.js';
import {
  XHS_PUBLISH_SELECT_MODE_ACTION_ID,
  XHS_PUBLISH_SELECT_MODE_ANCHOR_HINT,
  XHS_PUBLISH_SELECT_MODE_GOAL,
} from './anchors.js';
import {
  PublishStepValidator,
  buildContentInputRequest,
  buildEnterPublishPageRequest,
  buildSubmitPublishRequest,
  buildTagInputRequest,
  buildTitleInputRequest,
  extractPostId,
  extractPostUrl,
} from './publish-post.js';
import { dispatchClick } from '../browse/cdp-util.js';
import { jitterAround, type RandomFn } from '../humanize/timing.js';

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

/** set_schedule：定位定时发布控件并设定时刻（best-effort）。 */
function buildSetScheduleRequest(publishTime: number): ActionRequest {
  return {
    actionId: 'note.publish_set_schedule',
    op: 'input',
    value: String(publishTime),
    goal: '在发布页设置定时发布：打开「定时发布」并填入目标时刻',
    anchorHint: { text: '定时', textMatch: 'contains' },
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

export class PublishCommandDispatcher {
  private readonly clock: () => number;
  private inputEnabled = false;
  private domEnabled = false;
  /** 拟人节奏（change publish-fill-humanization，Phase A）：开关 + 可注入 sleep/random。 */
  private readonly pacingEnabled: boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: RandomFn;

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
  ) {
    this.clock = clock;
    this.pacingEnabled = pacing.enabled !== false;
    this.sleep = pacing.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = pacing.random ?? Math.random;
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
    if (kind === 'capture_postId' || kind === 'upload_image' || kind === 'submit_publish') return;
    await this.pause(PACING_MS.stepThink);
  }

  /** 按 kind 路由并执行一条发布指令，返回结果（绝不抛——异常也转成诚实的 ok:false）。 */
  async dispatch(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    // 拟人：动作前"想一下"，给整条发布序列加上逐项填写的节奏（治"指令间零节奏一气呵成"）。
    await this.thinkBeforeStep(payload.kind);
    switch (payload.kind) {
      case 'navigate_entry':
        return this.runNavigateEntry(payload);
      case 'select_mode':
        return this.runSelectMode(payload);
      case 'fill_field':
        return this.runFillField(payload);
      case 'add_with_candidate': {
        const value = payload.params.value ?? '';
        const candidateKind = payload.params.candidateKind;
        // topic 走话题专用步骤校验器；mention/location/collection 用 best-effort 值校验。
        if (!candidateKind || candidateKind === 'topic') {
          return this.runAtom(
            payload,
            buildTagInputRequest(value),
            new PublishStepValidator({ step: 'input_tag', currentTag: value, payload: synthPayload(payload) }),
          );
        }
        return this.runAtom(payload, buildCandidateRequest(candidateKind, value), valueValidator(value));
      }
      case 'submit_publish':
        return this.runSubmit(payload);
      case 'capture_postId':
        return this.runCapturePostId(payload);
      case 'set_option': {
        const optionValue = payload.params.optionValue ?? payload.params.value ?? '';
        return this.runAtom(
          payload,
          buildSetOptionRequest(payload.params.optionKind, optionValue),
          valueValidator(optionValue),
        );
      }
      case 'set_schedule': {
        const publishTime = payload.params.publishTime ?? 0;
        return this.runAtom(payload, buildSetScheduleRequest(publishTime), valueValidator('定时'));
      }
      case 'upload_image':
        return this.runUploadImage(payload);
      case 'set_cover':
        // 封面：定位封面入口 + 点击 + 封面激活态后置校验（断言真成为封面，非仅点到）。
        return this.runAtom(payload, buildSetCoverRequest(), coverActiveValidator());
      default:
        return this.notImplemented(payload);
    }
  }

  /**
   * 进入发布页：优先 CDP Page.navigate 直达创作发布页（跨子域点击入口会开新标签、edge 看不到）。
   * 导航后绑定式轮询 isPublishPage 后置校验；未注入 navigate 时回退原点击入口逻辑。
   */
  private async runNavigateEntry(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    if (!this.cdp) {
      // 回退：无 CDP 直驱能力时，沿用点击入口 + 后置校验。
      return this.runAtom(
        payload,
        buildEnterPublishPageRequest(),
        new PublishStepValidator({ step: 'enter_publish_page', payload: synthPayload(payload) }),
      );
    }
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    const details = { actionId: 'note.publish_entry', durationMs: 0 };
    try {
      await this.cdp.send('Page.navigate', { url: XHS_CREATOR_PUBLISH_URL });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ...base, ok: false, error: `navigate_failed: ${message}`, details: { ...details, durationMs: this.clock() - startedAt } };
    }
    // 绑定式轮询：等创作发布页渲染出来（isPublishPage 命中）。
    const validator = new PublishStepValidator({ step: 'enter_publish_page', payload: synthPayload(payload) });
    const req = buildEnterPublishPageRequest();
    const deadline = this.clock() + 20_000;
    for (;;) {
      let root: Element | Document | undefined;
      try {
        root = await this.deps.dom.getRoot();
      } catch {
        root = undefined;
      }
      if (root && validator.validate(req, root)) {
        // 拟人：发布页渲染好后"环顾/定位输入框"再动手。
        await this.pause(PACING_MS.navigateSettle);
        return { ...base, ok: true, details: { ...details, durationMs: this.clock() - startedAt } };
      }
      if (this.clock() >= deadline) {
        return { ...base, ok: false, error: 'post_validate_failed', details: { ...details, durationMs: this.clock() - startedAt } };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /**
   * 选「上传图文」模式：发布页特殊 UI（div.creator-tab 非标准可交互元素），通用 extractor/LLM 选择器不可靠。
   * 用 CDP in-page click 直驱（task-0 校准实证可用），再绑定式轮询确认进入图文模式（文件输入 accept 变为图片类）。
   */
  private async runSelectMode(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    if (!this.cdp) {
      return this.runAtom(
        payload,
        buildSelectModeRequest(),
        new PublishStepValidator({ step: 'enter_publish_page', payload: synthPayload(payload) }),
      );
    }
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    const details = { actionId: XHS_PUBLISH_SELECT_MODE_ACTION_ID, durationMs: 0 };
    const CLICK_TAB = String.raw`(() => {
      const els = Array.from(document.querySelectorAll('div,span,[role=tab],[role=button]'));
      const tab = els.find((e) => (e.innerText || '').trim() === '上传图文' && (String(e.className || '')).includes('creator-tab'))
        || els.find((e) => (e.innerText || '').trim() === '上传图文' && (String(e.className || '')).includes('tab'))
        || els.find((e) => (e.innerText || '').trim() === '上传图文');
      if (!tab) return { clicked: false };
      try { tab.scrollIntoView({ block: 'center' }); } catch (e) {}
      tab.click();
      return { clicked: true };
    })()`;
    const IMG_MODE_ACTIVE = String.raw`(() => {
      const fi = document.querySelector('input[type=file]');
      const acc = (fi && fi.getAttribute('accept')) || '';
      if (/jpg|jpeg|png|webp/i.test(acc)) return true;
      const body = (document.body && document.body.innerText) || '';
      return body.includes('上传图片') || body.includes('文字配图');
    })()`;
    // 标签在导航后异步渲染——轮询重试点击，直到点中或超时（一次性点击会因渲染晚而 no_target）。
    const clickDeadline = this.clock() + 12_000;
    let clicked = false;
    for (;;) {
      try {
        const r = await this.cdp.send<{ result?: { value?: { clicked?: boolean } } }>('Runtime.evaluate', {
          expression: CLICK_TAB,
          returnByValue: true,
        });
        if (r?.result?.value?.clicked) { clicked = true; break; }
      } catch {
        // 瞬时 evaluate 失败，继续重试
      }
      if (this.clock() >= clickDeadline) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!clicked) {
      return { ...base, ok: false, error: 'no_target', details: { ...details, durationMs: this.clock() - startedAt } };
    }
    const deadline = this.clock() + 10_000;
    for (;;) {
      try {
        const c = await this.cdp.send<{ result?: { value?: boolean } }>('Runtime.evaluate', {
          expression: IMG_MODE_ACTIVE,
          returnByValue: true,
        });
        if (c?.result?.value === true) {
          return { ...base, ok: true, details: { ...details, durationMs: this.clock() - startedAt } };
        }
      } catch {
        // 忽略瞬时 evaluate 失败，继续轮询
      }
      if (this.clock() >= deadline) {
        return { ...base, ok: false, error: 'post_validate_failed', details: { ...details, durationMs: this.clock() - startedAt } };
      }
      await new Promise((r) => setTimeout(r, 400));
    }
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
  private async typeHumanized(text: string): Promise<void> {
    if (!this.cdp) return;
    if (!this.pacingEnabled) {
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
      await this.cdp.send('Input.insertText', { text: chunk });
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

  /**
   * 填标题/正文：标题是 React 受控 input、正文是 tiptap contenteditable——JS 直接赋 value/textContent 都不被框架接收。
   * 用 CDP 真实输入：聚焦目标（校准选择器）→ Input.insertText（React/tiptap 都正确响应）→ 后置校验值真进去。
   */
  private async runFillField(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    const isContent = payload.params.fieldType === 'content';
    const rawValue = payload.params.value ?? '';
    // 标题/正文均原样填入：长度策略收口云端一处（TitleCreator 已保证标题 ≤18、字形安全）。
    // edge 不做任何截断/策略——只原样填、后置校验真写入、失败如实回报（边轻云重；不静默假成功）。
    const value = rawValue;
    if (!this.cdp) {
      return isContent
        ? this.runAtom(payload, buildContentInputRequest(value), new PublishStepValidator({ step: 'input_content', payload: { title: '', content: value, tags: [] } }))
        : this.runAtom(payload, buildTitleInputRequest(value), new PublishStepValidator({ step: 'input_title', payload: { title: value, content: '', tags: [] } }));
    }
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    const details = { actionId: isContent ? 'note.publish_content' : 'note.publish_title', durationMs: 0 };
    // 校准选择器：标题=placeholder「填写标题会有更多赞哦」的 input；正文=tiptap.ProseMirror。
    const findExpr = isContent
      ? `document.querySelector('.tiptap.ProseMirror') || document.querySelector('[contenteditable="true"]')`
      : `document.querySelector('input[placeholder="填写标题会有更多赞哦"]') || document.querySelector('div.edit-container input.d-text') || document.querySelector('input.d-text')`;
    const FOCUS = String.raw`(() => { const el = ${findExpr}; if (!el) return false; try { el.scrollIntoView({ block: 'center' }); } catch (e) {} el.focus(); try { el.click && el.click(); } catch (e) {} return true; })()`;
    const probe = JSON.stringify(value.slice(0, 8));
    const CHECK = isContent
      ? String.raw`(() => { const el = ${findExpr}; return !!el && (el.innerText || '').includes(${probe}); })()`
      : String.raw`(() => { const el = ${findExpr}; return !!el && (el.value || '').includes(${probe}); })()`;
    try {
      await this.ensureInputEnabled();
      const f = await this.cdp.send<{ result?: { value?: boolean } }>('Runtime.evaluate', { expression: FOCUS, returnByValue: true });
      if (f?.result?.value !== true) {
        return { ...base, ok: false, error: 'no_target', details: { ...details, durationMs: this.clock() - startedAt } };
      }
      // 拟人：聚焦后短停顿（手移到输入框）→ 逐字打字（替代一次性灌入，标题/正文都逐字）→ 填完微停顿。
      await this.pause(PACING_MS.fieldFocus);
      await this.typeHumanized(value);
      await this.pause(PACING_MS.fieldDone);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ...base, ok: false, error: `engine_error: ${message}`, details: { ...details, durationMs: this.clock() - startedAt } };
    }
    const deadline = this.clock() + 5_000;
    for (;;) {
      try {
        const c = await this.cdp.send<{ result?: { value?: boolean } }>('Runtime.evaluate', { expression: CHECK, returnByValue: true });
        if (c?.result?.value === true) return { ...base, ok: true, details: { ...details, durationMs: this.clock() - startedAt } };
      } catch {
        // 忽略瞬时失败，继续轮询
      }
      if (this.clock() >= deadline) return { ...base, ok: false, error: 'post_validate_failed', details: { ...details, durationMs: this.clock() - startedAt } };
      await new Promise((r) => setTimeout(r, 300));
    }
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
  private async runSubmit(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    if (!this.cdp) {
      return this.runAtom(payload, buildSubmitPublishRequest(), new PublishStepValidator({ step: 'submit_publish', payload: synthPayload(payload) }));
    }
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    const details = { actionId: 'note.publish_submit', durationMs: 0 };
    // 发布按钮在 <xhs-publish-btn> 闭合 shadow 内（BUTTON.ce-btn.bg-red，文本「发布」）；CDP DOM 穿透闭合 shadow 取精确盒模型中心点。
    let center: { x: number; y: number } | null = null;
    try {
      await this.ensureInputEnabled();
      center = await this.findShadowButtonCenter('发布');
    } catch (err) {
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
        await dispatchClick(this.cdp, x, y, { random: this.random, sleep: this.sleep, overshoot: false, jitter: 0 });
      } else {
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ...base, ok: false, error: `engine_error: ${message}`, details: { ...details, durationMs: this.clock() - startedAt } };
    }
    // 诊断（只观测）：点击后立即快照页面状态（在 deadline 计算之前，不占用 15s 校验窗口）。
    await this.logSubmitDiag(x, y, 'after-click');
    // 后置校验：发布成功信号（出现成功提示 / 离开发布编辑页）。
    const CHECK = String.raw`(() => { const b = (document.body && document.body.innerText) || ''; return /发布成功|发布中|笔记已?发布|成功发布|稍后可在/.test(b) || !location.href.includes('/publish/publish'); })()`;
    const deadline = this.clock() + 15_000;
    for (;;) {
      try {
        const c = await this.cdp.send<{ result?: { value?: boolean } }>('Runtime.evaluate', { expression: CHECK, returnByValue: true });
        if (c?.result?.value === true) return { ...base, ok: true, details: { ...details, durationMs: this.clock() - startedAt } };
      } catch {
        // 忽略瞬时失败
      }
      if (this.clock() >= deadline) {
        // 诊断（只观测）：超时时快照终态——区分 仍在编辑页有弹层/toast vs 已跳但晚于窗口。
        await this.logSubmitDiag(x, y, 'timeout');
        return { ...base, ok: false, error: 'post_validate_failed', details: { ...details, durationMs: this.clock() - startedAt } };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** 通用原子执行：构造带 validator 的引擎跑 resolveAndAct，按真实结果组装回报。 */
  private async runAtom(
    payload: PublishCommandPayload,
    req: ActionRequest,
    validator: PostValidator,
  ): Promise<PublishCommandResultPayload> {
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    let result: ActionResult;
    try {
      const engine = new LocatingEngine({ ...this.deps, validator }, this.options);
      result = await engine.resolveAndAct(req);
    } catch (err) {
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

  /** 配图上传：URL→下载→CDP 文件输入桥→后置校验成功态。未注入 uploader 则诚实 kind_not_implemented。 */
  private async runUploadImage(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    const startedAt = this.clock();
    const base = { recordId: payload.recordId, seq: payload.seq, kind: payload.kind };
    const imageUrl = payload.params.imageUrl;
    if (!this.uploader) return this.notImplemented(payload);
    if (!imageUrl) {
      return { ...base, ok: false, error: 'no_target', details: { actionId: 'note.publish_upload_image', durationMs: this.clock() - startedAt } };
    }
    const r = await this.uploader.upload(imageUrl);
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
