/**
 * 基于 CDP 的 DomProvider 实现。
 *
 * 定位层引擎（src/locating/engine.ts）需要一个能返回当前页面 DOM 根的 DomProvider。
 * 真实边缘环境下，DOM 来自浏览器；这里通过 CDP `Runtime.evaluate` 取页面
 * 序列化后的 HTML（documentElement.outerHTML），再用 jsdom 在 Node 侧解析成
 * 标准 Document，使得既有 extractor / matcher（作用于通用 DOM）无需改动即可复用。
 *
 * 设计取舍：
 * - 用 outerHTML 快照而非 DOM.getDocument 树，是为了直接复用既有 DOM-first 抽取逻辑；
 *   抽取/匹配是纯函数，快照足够（一次操作周期内 DOM 稳定）。
 * - jsdom 无布局，可见性判定走 best-effort（与单测一致），真实可见性可后续接 CDP 增强。
 */

import { JSDOM } from 'jsdom';
import type { DomProvider } from '../locating/engine.js';
import type { CdpClient } from './client.js';

export interface CdpDomProviderOptions {
  /** 取 HTML 的 JS 表达式，默认整页 documentElement.outerHTML */
  htmlExpression?: string;
}

interface EvaluateResult {
  result?: { type: string; value?: unknown };
  exceptionDetails?: { text: string };
}

/** 从真实页面拿 DOM 快照的 DomProvider */
export class CdpDomProvider implements DomProvider {
  private readonly htmlExpression: string;

  constructor(
    private readonly cdp: CdpClient,
    options: CdpDomProviderOptions = {},
  ) {
    this.htmlExpression =
      options.htmlExpression ?? 'document.documentElement.outerHTML';
  }

  /** 拉取一次页面 HTML 快照并解析为 Document */
  async getRoot(): Promise<Document> {
    const html = await this.fetchHtml();
    const dom = new JSDOM(html);
    return dom.window.document;
  }

  /** 通过 Runtime.evaluate 取页面 HTML 字符串 */
  private async fetchHtml(): Promise<string> {
    const res = await this.cdp.send<EvaluateResult>('Runtime.evaluate', {
      expression: this.htmlExpression,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Runtime.evaluate 失败: ${res.exceptionDetails.text}`);
    }
    const value = res.result?.value;
    if (typeof value !== 'string') {
      throw new Error('Runtime.evaluate 未返回 HTML 字符串');
    }
    return value;
  }
}
