/**
 * 在途发布的两件事：**回执登记**与**写者在场**。
 *
 * 它们长得很像（都是「有一条发布正在跑」），生命周期却完全不同，而且**回收路径会把前者一次清空、
 * 绝不影响后者**：
 *
 *  - **回执登记**（`recycle`）：断连 / 暂停 / 执行器故障时，必须立刻把全部在途发布诚实判失败，
 *    让审批与通知侧看到失败而不是半成品，也避免重连后被当成未完成而重放。这一步只是**发回执**。
 *  - **写者在场**（`begin` / `settle`）：dispatch 仍在页面上逐字打字（自我掐表，Facebook 正文上限 400s）。
 *    只有它自己的 `finally` 知道写者何时真的离开页面。
 *
 * 曾经这两件事共用一张表，`publishInFlight` 探针读的就是回执登记表。于是回收路径一 `clear()`，
 * 探针当场变假——租约已 `reset()`、浏览闸同时松开，而 dispatch 还在页面上打字。
 * 两个写者短暂共用同一个 CDP 页面：恢复导航把发布页导走，发布这一侧看到的是「我打的字不见了」。
 * 提交那一步另有租约闸挡着（`task_lease_mismatch`），所以后果不是重复发帖，是**页面互踩**。
 *
 * ⇒ 判「浏览能不能恢复」MUST 读 {@link writerOnPage}，MUST NOT 读 {@link pendingReceipts}。
 * 前者是「页面上还有没有人在写」，后者是「还有没有人在等回执」——回收之后后者恒为 0，
 * 而页面上那个人一个字都没少打。
 */
export class InFlightPublishes {
  private readonly receipts = new Map<string, (reason: string) => void>();

  private writers = 0;

  /**
   * 一条发布 dispatch 开始：登记诚实失败回执 + 写者踏上页面。
   *
   * MUST 与 {@link settle} 严格配对，且调用点与随后的 `try { … } finally { settle() }`
   * 之间不得存在任何可抛出的语句——加了却进不去 finally，就是一次「浏览永久冻结」的砖。
   */
  begin(id: string, failReceipt: (reason: string) => void): void {
    this.receipts.set(id, failReceipt);
    this.writers++;
  }

  /** 这条 dispatch 真收敛：写者离开页面，回执登记一并注销。 */
  settle(id: string): void {
    this.receipts.delete(id);
    // 下溢保护不是防御性编程的装饰：计数一旦被压到负数，`writerOnPage` 就永远为假，
    // 那道闸等于不在——而它不在的时候没有任何症状，只有真机上偶发的页面互踩。
    if (this.writers > 0) this.writers--;
  }

  /**
   * 回收路径：把全部在途发布诚实判失败并注销回执登记。
   *
   * **MUST NOT 影响写者在场。** 发回执改变的是云端对这条发布的认知，改变不了页面上正在发生的事。
   */
  recycle(reason: string): void {
    for (const [, failReceipt] of this.receipts) failReceipt(reason);
    this.receipts.clear();
  }

  /** 页面上此刻是否还有发布写者。浏览恢复 / 冷待机 / 抢占判据一律读这个。 */
  get writerOnPage(): boolean {
    return this.writers > 0;
  }

  /** 尚未注销回执登记的在途发布数。只用于诊断，**不是**页面占用判据。 */
  get pendingReceipts(): number {
    return this.receipts.size;
  }
}
