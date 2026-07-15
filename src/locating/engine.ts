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
import { rethrowIfTakeover, type TakeoverCtx } from '../execution/takeover.js';

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
  /**
   * 单次云端选元素上限（change lease-strict-preemption 4.3）。缺省沿用选择器自己的默认值（200s）。
   *
   * MUST > 云端单次模型调用天花板 180s（见 client/cloud-selector.ts 的不变量）：压小了会把一次
   * **尚在进行的合法 thinking 选择**误判成 llm_error，而引擎见 llm_error 立刻升级上报、不再重试
   * ⇒ 一条本可成功的发布指令被判失败。
   *
   * 取消信号 MUST NOT 放这里：EngineOptions 在指令运行时是**构造期字段**，塞进来就退化成跨命令
   * 共享的状态（布尔冻结标志那个坑的换皮版）。取消按调用传 TakeoverCtx。
   */
  selectTimeoutMs?: number;
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
  private readonly selectTimeoutMs?: number;

  constructor(
    private readonly deps: EngineDeps,
    options: EngineOptions = {},
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.maxGuardRounds = Math.max(1, options.maxGuardRounds ?? 2);
    this.thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
    this.guardRules = options.guardRules ?? DEFAULT_GUARD_RULES;
    this.selectTimeoutMs = options.selectTimeoutMs;
  }

  /**
   * @param takeover 可选的取消上下文（change lease-strict-preemption 4.3）。**接管只由异常表达**
   *        （ActionResult.outcome 绝不新增 'preempted'——该联合在协议里有一份逐字重复，是热点文件）。
   *        取消点**恰好 2 处**：进守卫之前、每轮重试边界。`executor.execute` 返回到 `validator.validate`
   *        返回之间**一格都不能加**——那会把一次可能已经生效的写当成没发生，且造成「写了页面、缓存不
   *        记账」的漂移。
   */
  async resolveAndAct(req: ActionRequest, takeover?: TakeoverCtx): Promise<ActionResult> {
    takeover?.checkpoint(); // 安全点 ①：进守卫之前（守卫会关浮层 = 页面写）
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
      // 安全点 ②：重试边界——上一轮的写要么已被后置校验、要么根本没发出。
      takeover?.checkpoint();
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
        // 选元素是一段**纯等待**（平台侧零副作用）：接管时就地作废在飞请求。选择器 MUST 让
        // TaskTakeoverError 原样穿出——吞成 llm_error 会走下面的 escalated 分支，把一次「让路」
        // 谎报成「模型不可用、已升级」。
        const sel = await this.deps.selector.select(req.goal, els, {
          signal: takeover?.signal,
          timeoutMs: this.selectTimeoutMs,
        });
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
        rethrowIfTakeover(err); // 被接管 ≠ 执行失败：绝不降级成 exec_error 再重试
        lastReason = `exec_error:${(err as Error).message}`;
        if (source === 'cache') forceLlm = true;
        else this.deps.cache.dropStaged(req.actionId);
        continue;
      }

      // 🔴 从这里到 validate 返回，**MUST NOT 取消**：页面已经被写、结果尚未校验，
      //    中止 = 把一次可能已生效的写当成没发生（且缓存记账全在校验之后，会一并漂移）。
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
          rethrowIfTakeover(err); // 被接管 ≠ 关不掉浮层：绝不降级成 guard_blocked
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
