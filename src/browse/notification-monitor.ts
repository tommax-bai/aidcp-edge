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

/**
 * 「消息」未读探测 JS：返回 {unread, count}。
 *
 * 真机校准（2026-06-23）：通知入口真实结构为
 *   <a href="/notification"><div class="badge-container"><svg class="reds-icon">…</svg><!----></div><span>通知</span></a>
 * 其中 `badge-container` 与 `reds-icon` 图标**常驻**；未读角标是 Vue 条件渲染进 `badge-container` 的子元素
 * （无未读时是空注释槽 `<!---->`）。旧版用 `[class*="badge"]`/`[class*="red"]` 宽选择器会命中常驻的
 * `badge-container`/`reds-icon`（小红书品牌即 RED，设计系统类名前缀 `reds-`），故几乎永远判「有未读」→ 没通知也反复跳通知页。
 *
 * 新判据（结构化、类名无关）：未读 = 通知入口的角标容器里，存在**图标 svg 之外的、可见的真实角标元素**。
 * 空槽（仅图标）= 无未读。既消除假阳性，又不漏真角标（红点无数字也算未读，count 仅附带）。
 */
export function buildNotificationBadgeJs(): string {
  return `(function(){
    var entry = document.querySelector('a[href*="/notification"]') || document.querySelector('a[href*="/notice"]');
    if (!entry) return JSON.stringify({ unread: false, count: 0 });
    // 角标容器（包住图标 + 条件渲染的角标，不含"通知"文字标签）。无容器则保守判无（待真机重校，而非误报）。
    var container = entry.querySelector('[class*="badge"]');
    if (!container) return JSON.stringify({ unread: false, count: 0 });
    var all = container.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest && el.closest('svg')) continue; // 跳过通知图标 svg 及其内部（use 等结构件，常驻）
      var cls = '';
      try { cls = String(el.className && el.className.baseVal != null ? el.className.baseVal : (el.className || '')); } catch (e) {}
      if (/reds-icon/.test(cls)) continue; // 跳过图标类
      var visible = el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
      if (!visible) continue; // 条件未渲染/隐藏的角标不算
      var t = (el.textContent || '').trim();
      var n = parseInt(t.replace(/[^0-9]/g, ''), 10);
      return JSON.stringify({ unread: true, count: isNaN(n) ? 0 : n }); // 找到真实可见角标 ⇒ 有未读
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
