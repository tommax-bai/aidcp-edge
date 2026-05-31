/**
 * 五层编排引擎：规划(上层给) → 守卫 → 定位 → 执行 → 校验，内含三道闸。
 *
 * 三道闸（决定"自愈"不变"自残"）：
 *  1) 后置校验：操作后必须验证业务结果真实发生，校验不过才判失败。
 *  2) 重试上限 + 升级：连续失败到上限 → 判系统性改版 → 停手并升级，绝不静默成功。
 *  3) 反污染回写：LLM 新锚点先暂存，连续确认成功才晋升主缓存（见 cache.ts）。
 */

import type {
  ActionRequest,
  ActionResult,
  Anchor,
  ElementDescriptor,
  ResolutionSource,
} from './types.js';
import { AnchorCache } from './cache.js';
import { extractInteractiveElements } from './extractor.js';
import { DEFAULT_THRESHOLDS, matchAnchor, type MatchThresholds } from './matcher.js';
import type { ElementSelector } from './selector.js';
import { DEFAULT_GUARD_RULES, scanInterrupts, type GuardRule } from './guard.js';

/** 提供当前 DOM 根（真实边缘下由 CDP 快照，单测下为 jsdom document） */
export interface DomProvider {
  getRoot(): Promise<Element | Document> | Element | Document;
}

/** 执行层：把原子操作落到真实页面（CDP click/input/scroll） */
export interface ActionExecutor {
  execute(
    op: ActionRequest['op'],
    element: ElementDescriptor,
    value?: string,
  ): Promise<void> | void;
}

/** 后置校验器：验证业务结果是否真实发生 */
export interface PostValidator {
  validate(req: ActionRequest, root: Element | Document): Promise<boolean> | boolean;
}

export interface EngineOptions {
  maxAttempts?: number;
  maxGuardRounds?: number;
  thresholds?: MatchThresholds;
  guardRules?: GuardRule[];
}

export interface EngineDeps {
  dom: DomProvider;
  executor: ActionExecutor;
  selector: ElementSelector;
  validator: PostValidator;
  cache: AnchorCache;
}

/** 由选中的元素构造候选锚点（用于暂存与后续命中） */
export function anchorFromElement(
  actionId: string,
  el: ElementDescriptor,
  scope?: Anchor['scope'],
): Anchor {
  const identifying: Record<string, string> = {};
  for (const key of ['aria-label', 'data-testid', 'data-id', 'name', 'type']) {
    if (el.attributes[key]) identifying[key] = el.attributes[key];
  }
  const anchor: Anchor = {
    actionId,
    role: el.role,
    text: el.text || undefined,
    textMatch: 'contains',
  };
  if (Object.keys(identifying).length > 0) anchor.attributes = identifying;
  // 语义 class 线索（如 like-wrapper）随锚点回写，便于晋升后按稳定语义 class 命中。
  if (el.classHint) anchor.classHint = el.classHint;
  if (scope) anchor.scope = scope;
  return anchor;
}

export class LocatingEngine {
  private readonly maxAttempts: number;
  private readonly maxGuardRounds: number;
  private readonly thresholds: MatchThresholds;
  private readonly guardRules: GuardRule[];

  constructor(
    private readonly deps: EngineDeps,
    options: EngineOptions = {},
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.maxGuardRounds = Math.max(1, options.maxGuardRounds ?? 2);
    this.thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
    this.guardRules = options.guardRules ?? DEFAULT_GUARD_RULES;
  }

  async resolveAndAct(req: ActionRequest): Promise<ActionResult> {
    // ---- 守卫层：清理偶现干扰 ----
    const guard = await this.handleGuards();
    if (!guard.ok) {
      return {
        ok: false,
        actionId: req.actionId,
        attempts: 0,
        outcome: 'guard_blocked',
        escalation: 'guard_unhandled',
        reason: guard.reason ?? 'guard_blocked',
      };
    }

    let attempts = 0;
    let forceLlm = false;
    let executedAtLeastOnce = false;
    let lastReason = 'init';

    while (attempts < this.maxAttempts) {
      attempts++;
      const root = await this.deps.dom.getRoot();

      let source: ResolutionSource | undefined;
      let element: ElementDescriptor | undefined;
      let candidateAnchor: Anchor | undefined;

      // ---- 定位层：缓存优先 ----
      const cached = forceLlm ? undefined : this.deps.cache.get(req.actionId);
      if (cached) {
        const scopeEls = extractInteractiveElements(root, cached.scope, {
          scopeFallback: 'root',
        });
        const m = matchAnchor(cached, scopeEls, this.thresholds);
        if (m.status === 'hit' && m.element) {
          source = 'cache';
          element = m.element;
        } else {
          lastReason = `cache_${m.status}:${m.reason}`;
        }
      }

      // ---- 缺口路径：文本 LLM 从清单选 ----
      if (!element) {
        const scope = cached?.scope ?? req.anchorHint?.scope;
        const els = extractInteractiveElements(root, scope, {
          scopeFallback: 'root',
        });
        const sel = await this.deps.selector.select(req.goal, els);
        if (sel.reason.startsWith('llm_error')) {
          return {
            ok: false,
            actionId: req.actionId,
            attempts,
            outcome: 'escalated',
            escalation: 'llm_unavailable',
            reason: sel.reason,
          };
        }
        if (sel.index === null || !sel.element) {
          lastReason = `select_none:${sel.reason}`;
          forceLlm = true;
          continue;
        }
        source = 'llm';
        element = sel.element;
        candidateAnchor = anchorFromElement(req.actionId, sel.element, scope);
      }

      if (!element || !source) {
        lastReason = 'no_element';
        forceLlm = true;
        continue;
      }

      // ---- 执行层 ----
      try {
        await this.deps.executor.execute(req.op, element, req.value);
        executedAtLeastOnce = true;
      } catch (err) {
        lastReason = `exec_error:${(err as Error).message}`;
        if (source === 'cache') forceLlm = true;
        else this.deps.cache.dropStaged(req.actionId);
        continue;
      }

      // ---- 校验层（第一道闸：后置校验） ----
      const rootAfter = await this.deps.dom.getRoot();
      const valid = await this.deps.validator.validate(req, rootAfter);
      if (valid) {
        if (source === 'cache') {
          this.deps.cache.recordHit(req.actionId);
        } else if (candidateAnchor) {
          // 第三道闸：反污染回写（暂存→确认→晋升）
          this.deps.cache.stage(candidateAnchor);
          this.deps.cache.confirmStaged(req.actionId);
        }
        return {
          ok: true,
          actionId: req.actionId,
          source,
          element,
          attempts,
          outcome: 'success',
          reason: source === 'cache' ? 'cache_hit_validated' : 'llm_resolved_validated',
        };
      }

      // 校验失败：不晋升、不静默
      if (source === 'cache') {
        this.deps.cache.recordFailure(req.actionId);
        forceLlm = true; // 缓存锚点疑似失效，后续强制走 LLM
      } else {
        this.deps.cache.dropStaged(req.actionId);
      }
      lastReason = 'post_validate_failed';
    }

    // ---- 第二道闸：重试到上限 → 升级，绝不静默成功 ----
    if (!executedAtLeastOnce) {
      return {
        ok: false,
        actionId: req.actionId,
        attempts,
        outcome: 'no_target',
        reason: lastReason,
      };
    }
    return {
      ok: false,
      actionId: req.actionId,
      attempts,
      outcome: 'escalated',
      escalation: 'systemic_revision',
      reason: lastReason,
    };
  }

  /** 守卫层：扫描并清除偶现干扰；无法清除则返回阻断 */
  private async handleGuards(): Promise<{ ok: boolean; reason?: string }> {
    let rounds = 0;
    while (rounds < this.maxGuardRounds) {
      const root = await this.deps.dom.getRoot();
      const hits = scanInterrupts(root, this.guardRules);
      if (hits.length === 0) return { ok: true };
      rounds++;
      for (const hit of hits) {
        if (!hit.dismissActionId) {
          return { ok: false, reason: `unhandled_guard:${hit.ruleId}` };
        }
        try {
          await this.deps.executor.execute('click', hit.element);
        } catch (err) {
          return { ok: false, reason: `dismiss_failed:${hit.ruleId}:${(err as Error).message}` };
        }
      }
    }
    // 多轮后仍有干扰
    const root = await this.deps.dom.getRoot();
    const remain = scanInterrupts(root, this.guardRules);
    return remain.length === 0 ? { ok: true } : { ok: false, reason: 'guard_persist' };
  }
}
