/**
 * 文本 LLM 元素选择（缓存缺口时的"做选择题"路径）。
 *
 * 把作用域内的可交互元素清单格式化成编号列表，交豆包/Qwen 文本模型选出目标编号。
 * 关键防护：
 * - 强约束输出为编号（或 -1 表示无），并**校验编号在范围内**，防 LLM 幻觉越界。
 * - 选择器只产出"选哪个元素"，不直接操作，便于上层加后置校验。
 */

import type { ElementDescriptor } from './types.js';

/** 可插拔的 LLM 客户端（接火山豆包/阿里 Qwen 文本模型） */
export interface LlmClient {
  /** 输入提示词，返回模型纯文本输出 */
  complete(prompt: string): Promise<string>;
}

export interface SelectionResult {
  /** 选中的元素 index；无合适项为 null */
  index: number | null;
  /** 选中的元素 */
  element?: ElementDescriptor;
  reason: string;
}

export interface ElementSelector {
  select(goal: string, elements: ElementDescriptor[]): Promise<SelectionResult>;
}

/** 把元素清单渲染为给 LLM 的编号列表 */
export function renderElementList(elements: ElementDescriptor[]): string {
  return elements
    .map((el) => {
      const attrs = Object.entries(el.attributes)
        .filter(([k]) => k !== 'value')
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      const text = el.text ? ` "${el.text}"` : '';
      return `[${el.index}] <${el.tag} role=${el.role}${text}${attrs ? ' ' + attrs : ''}>`;
    })
    .join('\n');
}

export function buildSelectionPrompt(goal: string, elements: ElementDescriptor[]): string {
  return [
    '你是页面元素定位助手。下面是当前页面（或当前作用域）内的可交互元素清单。',
    '请从清单中选出最符合目标的**唯一**元素编号。',
    '只输出一个整数编号；如果没有任何元素符合目标，输出 -1。不要输出其他文字。',
    '',
    `目标：${goal}`,
    '',
    '元素清单：',
    renderElementList(elements),
    '',
    '编号：',
  ].join('\n');
}

/** 从模型输出中解析整数编号 */
export function parseIndex(raw: string): number | null {
  const m = raw.match(/-?\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  if (Number.isNaN(n)) return null;
  return n;
}

/** 基于文本 LLM 的元素选择器 */
export class LlmElementSelector implements ElementSelector {
  constructor(private readonly llm: LlmClient) {}

  async select(goal: string, elements: ElementDescriptor[]): Promise<SelectionResult> {
    if (elements.length === 0) {
      return { index: null, reason: 'empty_element_list' };
    }
    const prompt = buildSelectionPrompt(goal, elements);
    let raw: string;
    try {
      raw = await this.llm.complete(prompt);
    } catch (err) {
      return { index: null, reason: `llm_error:${(err as Error).message}` };
    }
    const n = parseIndex(raw);
    if (n === null) {
      return { index: null, reason: `unparsable_output:${raw.slice(0, 40)}` };
    }
    if (n < 0) {
      return { index: null, reason: 'llm_no_match' };
    }
    // 防幻觉：编号必须落在清单范围内
    const element = elements.find((e) => e.index === n);
    if (!element) {
      return { index: null, reason: `index_out_of_range:${n}` };
    }
    return { index: n, element, reason: 'llm_selected' };
  }
}
