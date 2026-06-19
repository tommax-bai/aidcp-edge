/**
 * 通知未读监测体：后台盯「消息」入口的未读标记（红点/计数）。
 *
 * 复用 BackgroundWatcher 的循环/容错/翻转/启停/心跳，只提供"如何探测一次未读"（probe）。
 * 语义（与验证码监测相反）：
 *  - 软中断 + fail-open：漏一条评论代价小，误触发巡视会打断浏览；故探测失败按 sticky 保持上次，
 *    且 MUST NOT 把未读重置为 false（那会静默丢失真通知）——sticky 正好满足"保持上次"。
 *  - 状态 = 是否有未读（boolean）。未读计数仅作信号附带参考，不参与翻转判定（count 3→5 仍是"有"，不重复触发）。
 *  - epoch：每次"无→有"翻转单调 +1，作云端去重键（不随计数变）。由上层在 onTransition(false→true) 时取 nextEpoch()。
 *
 * 选择器为 best-effort，待真机校准（同项目其它抽取器做法）。
 */
import type { BrowseCdp } from './cdp-util.js';
import { evalRaw } from './cdp-util.js';
import { BackgroundWatcher, type BackgroundWatcherOptions } from './background-watcher.js';

/** 「消息」未读探测 JS：返回 {unread, count}。选择器 best-effort，待真机校准。 */
export function buildNotificationBadgeJs(): string {
  return `(function(){
    // 思路：找通知入口（href 含 /notification，或文案"消息"），看其内/邻近是否有可见未读标记(红点/计数)。
    var sels = [
      'a[href*="/notification"] [class*="count"]',
      'a[href*="/notification"] [class*="badge"]',
      'a[href*="/notification"] [class*="dot"]',
      'a[href*="/notification"] [class*="red"]',
      '[class*="notification"] [class*="badge"]',
      '[class*="message"] [class*="badge"]',
      '.reds-badge'
    ];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (!el) continue;
      var visible = el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
      if (!visible) continue;
      var t = (el.textContent || '').trim();
      var n = parseInt(t.replace(/[^0-9]/g, ''), 10);
      return JSON.stringify({ unread: true, count: isNaN(n) ? 0 : n });
    }
    return JSON.stringify({ unread: false, count: 0 });
  })()`;
}

export class CdpNotificationMonitor extends BackgroundWatcher<boolean> {
  private readonly cdp: BrowseCdp;
  private readonly js: string;
  private _epoch = 0;
  private _lastCount = 0;

  constructor(cdp: BrowseCdp, options: Pick<BackgroundWatcherOptions, 'pollMs' | 'setTimer' | 'clearTimer' | 'logger' | 'clock'> = {}) {
    super(false, {
      pollMs: options.pollMs,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      logger: options.logger,
      clock: options.clock,
      // sticky：探测失败保持上次未读态，绝不把"有未读"误清为"无"（不丢真通知）。
      onProbeError: 'sticky',
      label: 'notification',
    });
    this.cdp = cdp;
    this.js = buildNotificationBadgeJs();
  }

  protected async probe(): Promise<boolean> {
    const raw = await evalRaw<string>(this.cdp, this.js);
    const info = typeof raw === 'string' ? JSON.parse(raw) : { unread: false, count: 0 };
    this._lastCount = Number(info?.count) || 0;
    return !!info?.unread;
  }

  /** 当前未读计数（仅信号附带参考）。 */
  get lastCount(): number {
    return this._lastCount;
  }

  /** 取下一个 epoch（在"无→有"翻转时调用一次；每波未读得唯一、稳定的 epoch）。 */
  nextEpoch(): number {
    return ++this._epoch;
  }
}
