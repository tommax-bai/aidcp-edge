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
} from './publish-post.js';

/** 指令运行时依赖（EngineDeps 去掉 validator——validator 由各处理器按 kind 提供）。 */
export type PublishCommandDeps = Omit<EngineDeps, 'validator'>;

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

export class PublishCommandDispatcher {
  private readonly clock: () => number;

  constructor(
    private readonly deps: PublishCommandDeps,
    private readonly options: EngineOptions = {},
    clock: () => number = Date.now,
    /** 配图上传器（publish-media-upload）；未注入时 upload_image 诚实回 kind_not_implemented。 */
    private readonly uploader?: ImageUploader,
  ) {
    this.clock = clock;
  }

  /** 按 kind 路由并执行一条发布指令，返回结果（绝不抛——异常也转成诚实的 ok:false）。 */
  async dispatch(payload: PublishCommandPayload): Promise<PublishCommandResultPayload> {
    switch (payload.kind) {
      case 'navigate_entry':
        return this.runAtom(
          payload,
          buildEnterPublishPageRequest(),
          new PublishStepValidator({ step: 'enter_publish_page', payload: synthPayload(payload) }),
        );
      case 'select_mode':
        // 选图文模式后，标题/正文编辑区应出现 → 复用 enter_publish_page 的 isPublishPage 后置校验。
        return this.runAtom(
          payload,
          buildSelectModeRequest(),
          new PublishStepValidator({ step: 'enter_publish_page', payload: synthPayload(payload) }),
        );
      case 'fill_field': {
        const value = payload.params.value ?? '';
        if (payload.params.fieldType === 'content') {
          return this.runAtom(
            payload,
            buildContentInputRequest(value),
            new PublishStepValidator({ step: 'input_content', payload: { title: '', content: value, tags: [] } }),
          );
        }
        return this.runAtom(
          payload,
          buildTitleInputRequest(value),
          new PublishStepValidator({ step: 'input_title', payload: { title: value, content: '', tags: [] } }),
        );
      }
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
        return this.runAtom(
          payload,
          buildSubmitPublishRequest(),
          new PublishStepValidator({ step: 'submit_publish', payload: synthPayload(payload) }),
        );
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
    try {
      const root = await this.deps.dom.getRoot();
      postId = extractPostId(root);
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
