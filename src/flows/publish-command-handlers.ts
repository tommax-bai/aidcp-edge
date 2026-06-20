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

export class PublishCommandDispatcher {
  private readonly clock: () => number;

  constructor(
    private readonly deps: PublishCommandDeps,
    private readonly options: EngineOptions = {},
    clock: () => number = Date.now,
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
        return this.runAtom(
          payload,
          buildTagInputRequest(value),
          new PublishStepValidator({ step: 'input_tag', currentTag: value, payload: synthPayload(payload) }),
        );
      }
      case 'submit_publish':
        return this.runAtom(
          payload,
          buildSubmitPublishRequest(),
          new PublishStepValidator({ step: 'submit_publish', payload: synthPayload(payload) }),
        );
      case 'capture_postId':
        return this.runCapturePostId(payload);
      // 本阶段协议已登记、处理器未实装的 kind：诚实回 kind_not_implemented，绝不假成功。
      case 'upload_image':
      case 'set_cover':
      case 'set_option':
      case 'set_schedule':
        return this.notImplemented(payload);
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
