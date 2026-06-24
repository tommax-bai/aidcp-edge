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

/**
 * 共享结构判据片段（**单一真相，杜绝 6.5.3 那类 reds-/badge 宽选择器假阳性再漂移**）。
 *
 * 返回一段 JS 源码，注入后定义局部函数 `__realBadgeIn(scope, numericOnly)`：在 scope 内找
 * 「图标 svg 之外、非 `reds-icon`、可见」的真实角标元素，返回 `{unread, count}`。
 *  - `numericOnly=false`：第一个符合的可见元素即算未读（**入口角标容器**用——容器里只有图标 + 条件渲染的角标、
 *    无文字标签，故无数字红点也能正确算未读、count 仅附带）。
 *  - `numericOnly=true`：仅认**纯数字**角标（**通知首页 per-tab 计数**用——scope 是分类 tab、内含「评论和@」等
 *    文字标签，必须收紧，否则标签会被当成角标 → 假阳性。无数字红点的 tab 待真机校准 item(a) 据真实 DOM 补锚点；
 *    校准前宁可漏报 0 也绝不靠宽 class 猜 1）。
 *
 * 复用方：本文件 buildNotificationBadgeJs（入口探测）+ browse-session.openNotificationsHome（首页 per-tab 计数）。
 */
export function realBadgeScanFnJs(): string {
  return `function __realBadgeIn(scope, numericOnly){
    if (!scope) return { unread: false, count: 0 };
    var all = scope.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest && el.closest('svg')) continue; // 跳过图标 svg 及其内部（use 等结构件，常驻）
      var cls = '';
      try { cls = String(el.className && el.className.baseVal != null ? el.className.baseVal : (el.className || '')); } catch (e) {}
      if (/reds-icon/.test(cls)) continue; // 跳过图标类（小红书=RED，设计系统前缀 reds-，常驻）
      var visible = el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
      if (!visible) continue; // 条件未渲染/隐藏的角标不算
      var t = (el.textContent || '').trim();
      if (numericOnly) {
        // 角标只可能是 1-3 位数字（≤999；「99+」含 + 不匹配，自然落到无数字红点→0）且为叶子节点。
        // 排除多位时间戳 / 子计数 / 含数字子文本的包裹被误当角标（NM-3 部分硬化）。残留风险——真实 tab 内若有
        // 「短数字叶子时间戳」或多 category 标签拼接的容器泄漏（NM-2）——待真机校准 item(a) 据真实 DOM 收口。
        if (!/^[0-9]{1,3}$/.test(t)) continue;
        if (el.children && el.children.length > 0) continue;
        return { unread: true, count: parseInt(t, 10) };
      }
      var n = parseInt(t.replace(/[^0-9]/g, ''), 10);
      return { unread: true, count: isNaN(n) ? 0 : n }; // 找到真实可见角标 ⇒ 有未读
    }
    return { unread: false, count: 0 };
  }`;
}

export function buildNotificationBadgeJs(): string {
  return `(function(){
    ${realBadgeScanFnJs()}
    var entry = document.querySelector('a[href*="/notification"]') || document.querySelector('a[href*="/notice"]');
    if (!entry) return JSON.stringify({ unread: false, count: 0 });
    // 角标容器（包住图标 + 条件渲染的角标，不含"通知"文字标签）。无容器则保守判无（待真机重校，而非误报）。
    var container = entry.querySelector('[class*="badge"]');
    if (!container) return JSON.stringify({ unread: false, count: 0 });
    return JSON.stringify(__realBadgeIn(container, false));
  })()`;
}

/**
 * 通知首页 **per-tab 未读计数**探测 JS：返回 `{ comments, likes, follows }`，喂给云端分诊定优先级。
 *
 * 复用 realBadgeScanFnJs 的结构判据（numericOnly=true），仅作用在真实分类 tab 内、只认纯数字角标。
 * **绝不**沿用旧 `[class*="badge"]/[class*="red"]` 宽选择器 + `isNaN→1`——那正是 6.5.3 在入口探测点名删掉的
 * 假阳性源（命中常驻 reds-icon/badge-container），会让没未读也每类报「1」→ 无谓进各子分类、优先级失真。
 *
 * 真机校准（2026-06-24，活页面 CDP dump）：真实分类 tab = `div.reds-tab-item.tab-item`，结构
 *   `div.reds-tab-item > div.badge-container > span(标签文字) + div(角标数字)`（无未读时角标位是空注释槽 `<!---->`）。
 * **tab 范围收到 `[class*="tab-item"]`**：只命中三个真实叶子 tab，排除同样含 `[class*="tab"]` 的包裹容器
 *   （`reds-tabs-list` / `sticky-tab` / `tabs-content-container`，其拼接文本会把一类角标泄漏给另一类 = 复审 NM-2）。
 * 角标为 `.badge-container` 内标签 span 之外的数字叶子 div → `__realBadgeIn(tab,true)` 正好命中；
 * 真机双向验证：赞和收藏有真实未读→likes:1，看一眼清除后→0，清空账号三类全 0（无 phantom）。
 */
export function buildNotificationHomeJs(): string {
  return `(function(){
    ${realBadgeScanFnJs()}
    function tabUnread(labelRe){
      var tabs = document.querySelectorAll('[class*="tab-item"]');
      for (var i = 0; i < tabs.length; i++) {
        var tab = tabs[i];
        var label = (tab.textContent || '').trim();
        if (label.length > 12 || !labelRe.test(label)) continue;
        var r = __realBadgeIn(tab, true);
        if (r.unread) return r.count; // 仅在该 tab 内见到纯数字角标才计数；否则保守 0
      }
      return 0;
    }
    return JSON.stringify({ comments: tabUnread(/评论|@/), likes: tabUnread(/赞|收藏/), follows: tabUnread(/关注|粉丝/) });
  })()`;
}

/**
 * 「评论和@」列表原始项抽取 JS：返回 `[{kind, fromUser, content, noteTitle?, itemKey?}]`。
 *
 * 真机校准（2026-06-24，活页面 CDP dump）——真实行结构：
 *   `div.tabs-content-container > div.container`（每条一行，共 ~20 条）
 *     `a.user-avatar[href=/user/profile/]`（头像，文本空）
 *     `div.main > div.info > div.user-info > a`（**昵称**，无 class，own-text=昵称）
 *     `span`（动作标签：评论了你的笔记 / 回复了你的评论 / 提到了你）
 *     `span.interaction-time`（时间：「2天前」或日期「05-15」，**独立元素、不在正文里**）
 *     `div.interaction-content`（**正文**；回复型另有 `div.quote-info`=被引原评论，不取）
 *   行内**只有 profile 链、无 per-comment permalink**（赞类行带 `note-id` 属性、评论类无）。
 *
 * 据此换掉旧猜测选择器（旧 `[class*="item"]` 命中 23 个 `avatar-item` 头像→垃圾行；旧 `[class*="user"]`
 * 先命中空文本的 `a.user-avatar`→昵称抽空）。内容质量保障（6.5.4）：
 *  - **code-point 安全截断**：绝不按 UTF-16 劈裂 emoji 代理对（否则飞书尾部乱码 U+FFFD）；超长补省略号。
 *  - **正文缺失发空串**：绝不回退整行 textContent（避免飞书 blob）；空串由云端非空过滤丢弃 = 诚实无正文。
 *  - **itemKey 取 note-id 属性 或 非 profile 链**：profile 链 per-user 会把同人多评论去重键撞成一个 → 折叠丢失；
 *    都没有则留空（评论类即如此），交云端回退到 用户名|正文 去重键（正文已不含时间、跨巡视稳定）。
 */
export function buildNotificationItemsJs(): string {
  return `(function(){
    function cut(s,n){ s=(s||'').trim(); var a=Array.from(s); return a.length>n ? a.slice(0,n).join('')+'…' : s; }
    var out = [];
    var items = document.querySelectorAll('.tabs-content-container > .container');
    for (var i=0;i<items.length && out.length<50;i++){
      var it = items[i];
      var actionEl = it.querySelector('.info span, .user-info ~ span, span'); // 动作标签 span（评论了/回复了/提到了你）
      var actionText = (actionEl && actionEl.textContent || '').trim();
      var isMention = /提到了你|@/.test(actionText);
      var isComment = /评论|回复/.test(actionText);
      if(!isMention && !isComment) continue; // 非评论/@/提及（结构异常行）跳过
      var userEl = it.querySelector('.user-info a'); // 昵称（避开空文本的 a.user-avatar）
      var contentEl = it.querySelector('.interaction-content'); // 正文（不含时间、不取 quote-info）
      var key = it.getAttribute('note-id') || '';
      if(!key){ var links = it.querySelectorAll('a[href]'); for (var k=0;k<links.length;k++){ var h=links[k].getAttribute('href')||''; if(h && h.indexOf('/user/profile/')<0){ key=h; break; } } }
      out.push({
        kind: isMention ? 'mention' : 'comment',
        fromUser: cut(userEl && userEl.textContent || '', 40),
        content: cut(contentEl && contentEl.textContent || '', 200),
        itemKey: key ? key.slice(0,120) : undefined
      });
    }
    return JSON.stringify(out);
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
