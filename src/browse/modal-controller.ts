/**
 * Modal（笔记详情弹层）控制：检测打开状态、等待稳定、关闭。
 *
 * 小红书 explore 页点开卡片会弹出详情 modal（.note-detail-mask / [class*=note-detail]
 * 等）。这里用 CDP Runtime.evaluate 在真实页面判断该容器是否存在/可见，
 * 关闭则优先点遮罩层、兜底按 ESC。
 */

import type { BrowseCdp } from './cdp-util.js';
import { evalRaw, pressEscape } from './cdp-util.js';
import { XHS_NOTE_MODAL_SELECTOR } from '../flows/anchors.js';

export interface ModalController {
  /** 检测当前是否有 modal 打开 */
  isModalOpen(): Promise<boolean>;
  /** 关闭当前 modal（点遮罩层或按 ESC） */
  closeModal(): Promise<void>;
  /** 等待 modal 完全打开（DOM 稳定）；返回是否打开 */
  waitForModal(timeout?: number): Promise<boolean>;
}

export interface ModalControllerOptions {
  /** modal 容器选择器（默认复用 XHS_NOTE_MODAL_SELECTOR） */
  selector?: string;
  /** waitForModal 轮询间隔（毫秒，默认 200） */
  pollIntervalMs?: number;
  /** waitForModal 默认超时（毫秒，默认 5000） */
  defaultTimeoutMs?: number;
  /** 注入 sleep（测试用） */
  sleep?: (ms: number) => Promise<void>;
  /** 注入时钟（测试用，默认 Date.now） */
  clock?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 生成"容器是否存在且可见"的判定 JS（返回 boolean） */
function buildIsOpenJs(selector: string): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style = window.getComputedStyle ? window.getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return true;
  })()`;
}

/** 点击遮罩层关闭的 JS（命中并点击返回 true，否则 false） */
function buildCloseByMaskJs(): string {
  return `(function(){
    var closeSel = '.close, [class*="close"], .note-detail-mask';
    var btn = document.querySelector('[class*="note-detail"] .close, [class*="close-circle"], .close-mask-dark');
    if (btn) { btn.click(); return true; }
    var mask = document.querySelector('.note-detail-mask, [class*="mask"]');
    if (mask) { mask.click(); return true; }
    return false;
  })()`;
}

/** 基于 CDP 的 ModalController 实现 */
export class CdpModalController implements ModalController {
  private readonly selector: string;
  private readonly pollIntervalMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => number;

  constructor(
    private readonly cdp: BrowseCdp,
    options: ModalControllerOptions = {},
  ) {
    this.selector = options.selector ?? XHS_NOTE_MODAL_SELECTOR;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
    this.sleep = options.sleep ?? defaultSleep;
    this.clock = options.clock ?? Date.now;
  }

  async isModalOpen(): Promise<boolean> {
    return (await evalRaw<boolean>(this.cdp, buildIsOpenJs(this.selector))) === true;
  }

  async waitForModal(timeout?: number): Promise<boolean> {
    const deadline = this.clock() + (timeout ?? this.defaultTimeoutMs);
    // 至少检查一次，再轮询直到超时。
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (await this.isModalOpen()) return true;
      if (this.clock() >= deadline) return false;
      await this.sleep(this.pollIntervalMs);
    }
  }

  async closeModal(): Promise<void> {
    const clicked = await evalRaw<boolean>(this.cdp, buildCloseByMaskJs());
    if (clicked !== true) {
      // 兜底：按 ESC 关闭
      await pressEscape(this.cdp);
    }
  }
}
