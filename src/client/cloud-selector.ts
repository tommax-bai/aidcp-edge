/**
 * 云端代理的元素选择器（边缘侧）。
 *
 * 边缘抽取出作用域内可交互元素清单后，把"做选择题"委托给云端文本 LLM
 * （select.request → select.response），从而把模型留在云端、边缘保持轻量。
 *
 * 实现 locating 层的 ElementSelector 接口，可直接注入 LocatingEngine。
 */

import type { ElementSelector, SelectionResult } from '../locating/selector.js';
import type { ElementDescriptor } from '../locating/types.js';
import type { RemoteElement, SelectResponsePayload } from '../comm/protocol.js';
import type { EdgeClient } from './edge-client.js';

/** 把边缘的 ElementDescriptor 投影成跨网传输的 RemoteElement */
export function toRemoteElement(el: ElementDescriptor): RemoteElement {
  return {
    index: el.index,
    role: el.role,
    tag: el.tag,
    text: el.text,
    attributes: el.attributes,
  };
}

/**
 * 边缘等待云端选元素的超时（毫秒）。change raise-model-call-timeouts-for-thinking-models：
 * MUST 大于云端单次模型调用天花板（180s），否则边缘先放弃、把一次尚在进行的合法 thinking 选择误判为 llm_error。
 * 取 200s 留余量（v1 兼容路径、低频，硬编码即可，无需 env）。
 */
const SELECT_TIMEOUT_MS = 200_000;

/** 通过云端 select.request 选元素的选择器 */
export class CloudElementSelector implements ElementSelector {
  constructor(private readonly client: EdgeClient) {}

  async select(goal: string, elements: ElementDescriptor[]): Promise<SelectionResult> {
    if (elements.length === 0) {
      return { index: null, reason: 'empty_element_list' };
    }
    let payload: SelectResponsePayload;
    try {
      const res = await this.client.request('select.request', {
        goal,
        elements: elements.map(toRemoteElement),
      }, SELECT_TIMEOUT_MS);
      payload = res.payload as SelectResponsePayload;
    } catch (err) {
      return { index: null, reason: `llm_error:${(err as Error).message}` };
    }
    if (payload.index === null || payload.index === undefined) {
      return { index: null, reason: payload.reason || 'cloud_no_match' };
    }
    const element = elements.find((e) => e.index === payload.index);
    if (!element) {
      return { index: null, reason: `index_out_of_range:${payload.index}` };
    }
    return { index: payload.index, element, reason: payload.reason || 'cloud_selected' };
  }
}
