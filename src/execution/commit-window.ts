/**
 * 提交窗口守卫（change lease-strict-preemption 5.1）。
 *
 * 页面写者在进入**不可逆提交动作**（发布提交点击 / 评论回车 / 加群点击 / 通知分类栏目点击）之前
 * `enter(budgetMs)` 开一个有界窗口，拿到确认 / 预算耗尽后 `dispose()` 关闭。协调器抢占前读 `isOpen()`：
 * 窗口内**绝不强杀已提交动作**（回 window_busy + `remainingMs()` 剩余预算），窗口外才可抢占。
 *
 * 两条安全设计：
 *  ① **时基兜底自动过期**：`isOpen()` 按 `now < openUntil` 判定，即使 dispose 因异常/崩溃从未被调用，窗口
 *     也会在 `budgetMs` 后自动过期——一个卡死的窗口绝不永久挡住抢占。
 *  ② **世代守卫防误关**：`enter` 递增世代号，`dispose()` 只关闭自己那一代的窗口；一个迟到的旧 disposer
 *     绝不误关一个新开的窗口（重叠/连续提交下不串味）。
 *
 * 叶子模块、零 import（可脱离浏览器单测），`now` 注入以便测试。
 */
export class CommitWindowGuard {
  private openUntil = 0;
  private generation = 0;
  private currentLabel?: string;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * 进入一个有界提交窗口；返回 disposer（幂等、世代守卫）。
   * `budgetMs<=0` 视为不开窗（返回 no-op disposer）——绝不开一个已过期的假窗口。
   */
  enter(budgetMs: number, label?: string): () => void {
    if (!(budgetMs > 0)) return () => {};
    const gen = ++this.generation;
    this.openUntil = this.now() + budgetMs;
    this.currentLabel = label;
    return () => {
      if (gen !== this.generation) return;
      this.openUntil = 0;
      this.currentLabel = undefined;
    };
  }

  /** 当前是否处于提交窗口（时基兜底：过了预算自动为 false，即便 disposer 从未被调用）。 */
  isOpen(): boolean {
    return this.now() < this.openUntil;
  }

  /** 当前提交窗口的剩余毫秒；未开窗 / 已过期回 0。 */
  remainingMs(): number {
    const remaining = this.openUntil - this.now();
    return remaining > 0 ? remaining : 0;
  }

  /** 当前受保护动作的标签（观测用）；未开窗回 undefined。 */
  get label(): string | undefined {
    return this.isOpen() ? this.currentLabel : undefined;
  }
}

/**
 * 把多个写者各自的提交窗口聚合成协调器 `writers` 探针要的两个读法。
 * 系统中同一时刻至多一个独占任务在跑 ⇒ 至多一个窗口开着，取「任一开着」/「开着那个的剩余」即可。
 */
export function combineCommitWindows(guards: readonly CommitWindowGuard[]): {
  inCommitWindow: () => boolean;
  commitWindowRemainingMs: () => number;
} {
  return {
    inCommitWindow: () => guards.some((g) => g.isOpen()),
    commitWindowRemainingMs: () => {
      let max = 0;
      for (const g of guards) {
        const remaining = g.remainingMs();
        if (remaining > max) max = remaining;
      }
      return max;
    },
  };
}
