/**
 * 默认步骤执行器：把云端下发的 PlanStep 落到真实页面。
 *
 * 当前垂直切片只实现点赞（note.like_button → likePost）；其他 op 走通用
 * LocatingEngine 路径（缓存优先 → 云端选择器兜底）。每步产出与协议对齐的
 * ActionResultPayload，由 EdgeClient 回传云端。
 */

import { LocatingEngine } from '../locating/engine.js';
import type { DomProvider, ActionExecutor, EngineDeps } from '../locating/engine.js';
import { AnchorCache } from '../locating/cache.js';
import type { ElementSelector } from '../locating/selector.js';
import type { ActionResult, ActionRequest } from '../locating/types.js';
import type { ActionResultPayload, PlanStep } from '../comm/protocol.js';
import type { StepRunner } from './edge-client.js';
import { likePost } from '../flows/like-post.js';
import { XHS_LIKE_ACTION_ID, XHS_LIKE_GOAL } from '../flows/anchors.js';

export interface LikeStepRunnerDeps {
  dom: DomProvider;
  executor: ActionExecutor;
  selector: ElementSelector;
  /** 边缘本地锚点缓存（默认空，命中靠云端/反污染回写） */
  cache?: AnchorCache;
}

/** 把 locating 的 ActionResult 投影成协议 ActionResultPayload */
export function toActionResultPayload(r: ActionResult): ActionResultPayload {
  const payload: ActionResultPayload = {
    actionId: r.actionId,
    ok: r.ok,
    outcome: r.outcome,
    attempts: r.attempts,
    reason: r.reason,
  };
  if (r.escalation) payload.escalation = r.escalation;
  return payload;
}

/** 默认步骤执行器（点赞切片） */
export class LikeStepRunner implements StepRunner {
  private readonly cache: AnchorCache;

  constructor(private readonly deps: LikeStepRunnerDeps) {
    this.cache = deps.cache ?? new AnchorCache();
  }

  async run(step: PlanStep): Promise<ActionResultPayload> {
    const base: Omit<EngineDeps, 'validator'> = {
      dom: this.deps.dom,
      executor: this.deps.executor,
      selector: this.deps.selector,
      cache: this.cache,
    };

    // 点赞：用专用流程（自带点赞态后置校验）
    if (step.actionId === XHS_LIKE_ACTION_ID || /(点赞|like)/i.test(step.goal)) {
      const result = await likePost(base, {}, step.goal || XHS_LIKE_GOAL);
      return toActionResultPayload(result);
    }

    // 其他步骤：通用引擎 + 简单"执行无抛错即通过"的兜底校验
    const engine = new LocatingEngine({
      ...base,
      validator: { validate: () => true },
    });
    const req: ActionRequest = { actionId: step.actionId, op: step.op, goal: step.goal };
    if (step.value !== undefined) req.value = step.value;
    const result = await engine.resolveAndAct(req);
    return toActionResultPayload(result);
  }
}
