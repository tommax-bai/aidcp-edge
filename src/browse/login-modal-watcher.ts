/**
 * 登录弹窗检测角色（出现/消失驱动）。
 *
 * 小红书在登录态缺失 / 过期 / 触发风控时会弹出登录浮层（扫码登录 / 手机号登录…）。
 * 一旦弹出，继续滚动 feed、点开卡片等操作既无意义又徒增风控特征，应当**暂停**，
 * 直到用户完成登录、弹窗消失再恢复（见 BrowseSession.waitWhileLoginModalOpen）。
 *
 * 检测口径（与项目反混淆理念一致——只认人类可读、跨改版稳定的语义片段，不锁混淆 class）：
 *  - 在 overlay / mask / dialog / [class*="login"] 等候选容器里找**可见**元素；
 *  - 其文本命中登录浮层特征短语（扫码登录 / 手机号登录 / 验证码登录 / 新用户登录 / 安全登录）。
 *
 * 关键防误报（避免看笔记时被误暂停）：
 *  - 排除「笔记详情容器」(XHS_NOTE_MODAL_SELECTOR)——它的 class 含 mask/modal 片段会被候选选择器
 *    命中，而其 textContent 含正文+评论，评论里出现"登录"等字样会造成误判；
 *  - 短语只用长且特异的登录页签文案，**不含** "登录后"（"登录后查看更多"等内联 CTA 与评论都含它）。
 *
 * 这样既不依赖 cookie（web_session 是 httpOnly，页面读不到），也不会误命中笔记详情/评论。
 */

import type { BrowseCdp } from './cdp-util.js';
import { evalRaw } from './cdp-util.js';
import { XHS_NOTE_MODAL_SELECTOR } from '../flows/anchors.js';

export interface LoginModalWatcher {
  /** 当前是否有登录弹窗可见 */
  isOpen(): Promise<boolean>;
}

export interface LoginModalWatcherOptions {
  /** 候选容器选择器（在其中找可见 + 命中登录短语的元素） */
  containerSelectors?: string[];
  /** 登录浮层特征短语（命中任一即判定为登录弹窗） */
  phrases?: string[];
  /** 注入随 isOpen 出错时的兜底（默认出错按"未弹出"处理，避免误暂停） */
  onError?: (err: Error) => void;
}

/** 登录浮层候选容器：遮罩 / 对话框 / 含 login 的容器（容忍混淆 class 共存）。 */
export const DEFAULT_LOGIN_CONTAINER_SELECTORS = [
  '[class*="login"]',
  '[class*="mask"]',
  '[class*="modal"]',
  '[role="dialog"]',
  '[aria-modal="true"]',
];

/**
 * 登录浮层特征短语。
 * 只用长且特异的登录页签文案：避免命中导航栏里恒存在的单字"登录"按钮，
 * 也避免命中评论 / 内联 CTA 里的"登录后…"（故不含"登录后"）。
 */
export const DEFAULT_LOGIN_PHRASES = [
  '扫码登录',
  '手机号登录',
  '验证码登录',
  '新用户登录',
  '安全登录',
];

/**
 * 需要从候选里排除的容器：笔记详情弹层/容器。
 * 其 class 含 mask/modal 片段会被候选选择器命中，正文+评论里的"登录"字样会造成误判，
 * 故凡落在该容器内（含其本身）的候选一律跳过。
 */
export const LOGIN_EXCLUDE_SELECTOR = XHS_NOTE_MODAL_SELECTOR;

/** 生成"是否存在可见且命中登录短语的容器"的判定 JS（返回 boolean）。 */
export function buildLoginModalOpenJs(
  selectors: string[],
  phrases: string[],
  excludeSelector = LOGIN_EXCLUDE_SELECTOR,
): string {
  const sel = selectors.join(', ');
  return `(function(){
    var PHRASES = ${JSON.stringify(phrases)};
    var EXCLUDE = ${JSON.stringify(excludeSelector)};
    var nodes = document.querySelectorAll(${JSON.stringify(sel)});
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      // 跳过笔记详情容器内（含自身）的候选：其文本含正文/评论，"登录"字样会误判。
      if (EXCLUDE && el.closest && el.closest(EXCLUDE)) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0.05)) continue;
      var text = (el.textContent || '').replace(/\\s+/g, '');
      for (var j = 0; j < PHRASES.length; j++) {
        if (text.indexOf(PHRASES[j]) >= 0) return true;
      }
    }
    return false;
  })()`;
}

/** 基于 CDP 的登录弹窗检测实现 */
export class CdpLoginModalWatcher implements LoginModalWatcher {
  private readonly js: string;
  private readonly onError?: (err: Error) => void;

  constructor(
    private readonly cdp: BrowseCdp,
    options: LoginModalWatcherOptions = {},
  ) {
    const selectors = options.containerSelectors ?? DEFAULT_LOGIN_CONTAINER_SELECTORS;
    const phrases = options.phrases ?? DEFAULT_LOGIN_PHRASES;
    this.js = buildLoginModalOpenJs(selectors, phrases);
    this.onError = options.onError;
  }

  async isOpen(): Promise<boolean> {
    try {
      return (await evalRaw<boolean>(this.cdp, this.js)) === true;
    } catch (err) {
      // 探测失败不应误暂停浏览；交给调用方记录后按"未弹出"处理。
      this.onError?.(err as Error);
      return false;
    }
  }
}
