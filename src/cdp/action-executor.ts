/**
 * 基于 CDP 的 ActionExecutor 实现。
 *
 * 定位层选中元素后，执行层负责把原子操作（click / input / scroll）落到真实页面。
 * ElementDescriptor.path 是 extractor 生成的结构路径（tag[n]/tag[n]…，不含混淆 class），
 * 这里把它转成 XPath，在浏览器侧通过 document.evaluate 重新定位元素并操作。
 *
 * 为什么在浏览器侧用 JS 执行而非 Input.dispatchMouseEvent 坐标点击：
 * - 结构路径定位天然对改版更稳，且无需读取布局坐标；
 * - 触发原生事件序列（focus/input/change）可覆盖大多数受控组件。
 * 后续如需真实硬件级事件，可在此切换到 Input.* 域。
 */

import type { ActionExecutor } from '../locating/engine.js';
import type { ActionRequest, ElementDescriptor } from '../locating/types.js';
import type { CdpClient } from './client.js';

interface EvaluateResult {
  result?: { type: string; value?: unknown };
  exceptionDetails?: { text: string };
}

/**
 * 把 extractor 的结构路径（如 "/html[1]/body[1]/button[2]" 或作用域相对的
 * "./div[1]/button[1]"）转换为 XPath。两者形态已基本是 XPath，这里做规范化。
 */
export function pathToXPath(path: string): string {
  // extractor.buildPath 产出的就是 /tag[n]/tag[n] 或 ./tag[n]…，与 XPath 语法兼容。
  return path;
}

/** 把字符串安全地嵌入到将被 eval 的 JS 字面量中 */
function jsString(s: string): string {
  return JSON.stringify(s);
}

export class CdpActionExecutor implements ActionExecutor {
  constructor(private readonly cdp: CdpClient) {}

  async execute(
    op: ActionRequest['op'],
    element: ElementDescriptor,
    value?: string,
  ): Promise<void> {
    const xpath = pathToXPath(element.scopePath ? joinScoped(element) : element.path);
    const expression = this.buildOpExpression(op, xpath, value);
    const res = await this.cdp.send<EvaluateResult>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`执行 ${op} 失败: ${res.exceptionDetails.text}`);
    }
    if (res.result?.value !== true) {
      throw new Error(`执行 ${op} 未命中目标元素（XPath: ${xpath}）`);
    }
  }

  /** 生成在浏览器侧定位 + 操作元素的自执行 JS，成功返回 true */
  private buildOpExpression(
    op: ActionRequest['op'],
    xpath: string,
    value?: string,
  ): string {
    const locate = `
      var el = document.evaluate(${jsString(xpath)}, document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (!el) return false;
    `;
    let action: string;
    switch (op) {
      case 'click':
        action = `el.scrollIntoView({block:'center'}); el.click(); return true;`;
        break;
      case 'input':
        action = `
          el.focus();
          var setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value');
          if (setter && setter.set) { setter.set.call(el, ${jsString(value ?? '')}); }
          else { el.value = ${jsString(value ?? '')}; }
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
          return true;
        `;
        break;
      case 'scroll':
        action = `el.scrollIntoView({block:'center', behavior:'instant'}); return true;`;
        break;
      default:
        action = `return false;`;
    }
    return `(function(){${locate}${action}})()`;
  }
}

/** 作用域相对路径与作用域容器路径拼接成绝对 XPath */
function joinScoped(el: ElementDescriptor): string {
  if (!el.scopePath) return el.path;
  const rel = el.path.startsWith('./') ? el.path.slice(1) : el.path;
  return el.scopePath + rel;
}
