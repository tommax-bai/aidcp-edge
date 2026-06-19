/**
 * 监测体清单：统一启停一组后台监测体。
 *
 * 每个监测体在登记时绑定各自的翻转回调（不同监测体上报不同消息，故回调不统一）；
 * 清单只负责"全部启动 / 全部停止"，新增监测体登记一行、关停不漏。刻意保持极薄——
 * 2-3 个监测体不需要插件框架 / 事件总线（业界模式分析的 YAGNI 结论）。
 */
export interface SupervisableWatcher<S> {
  start(onTransition?: (from: S, to: S) => void): void;
  stop(): void;
}

export class WatcherSupervisor {
  private readonly starters: Array<() => void> = [];
  private readonly stoppers: Array<() => void> = [];

  /** 登记一个监测体 + 其翻转回调（类型在登记处绑定，整体异构但每条安全）。 */
  register<S>(watcher: SupervisableWatcher<S>, onTransition?: (from: S, to: S) => void): void {
    this.starters.push(() => watcher.start(onTransition));
    this.stoppers.push(() => watcher.stop());
  }

  startAll(): void {
    for (const start of this.starters) start();
  }

  stopAll(): void {
    for (const stop of this.stoppers) stop();
  }
}
