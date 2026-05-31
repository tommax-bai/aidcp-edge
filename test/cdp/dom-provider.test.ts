import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CdpDomProvider, CdpActionExecutor } from '../../src/cdp/index.js';
import type { CdpClient } from '../../src/cdp/index.js';
import { extractInteractiveElements } from '../../src/locating/index.js';

/** 假 CdpClient：仅实现 send，按 method 返回预设 */
function fakeCdp(handler: (method: string, params: Record<string, unknown>) => unknown): CdpClient {
  return {
    send: async (method: string, params: Record<string, unknown> = {}) => handler(method, params),
  } as unknown as CdpClient;
}

const PAGE_HTML =
  '<!DOCTYPE html><html><body>' +
  '<button aria-label="点赞" data-id="like1">赞</button>' +
  '<input type="text" placeholder="搜索" />' +
  '</body></html>';

test('CdpDomProvider 把页面 HTML 快照解析成可抽取的 Document', async () => {
  const cdp = fakeCdp((method) => {
    assert.equal(method, 'Runtime.evaluate');
    return { result: { type: 'string', value: PAGE_HTML } };
  });
  const provider = new CdpDomProvider(cdp);
  const root = await provider.getRoot();
  const els = extractInteractiveElements(root);
  assert.equal(els.length, 2);
  const like = els.find((e) => e.attributes['data-id'] === 'like1');
  assert.equal(like?.text, '点赞');
});

test('CdpDomProvider 在 evaluate 异常时抛错', async () => {
  const cdp = fakeCdp(() => ({ exceptionDetails: { text: 'eval boom' } }));
  const provider = new CdpDomProvider(cdp);
  await assert.rejects(provider.getRoot(), /eval boom/);
});

test('CdpActionExecutor 用 XPath 表达式驱动点击并校验命中', async () => {
  let sentExpr = '';
  const cdp = fakeCdp((method, params) => {
    assert.equal(method, 'Runtime.evaluate');
    sentExpr = String(params.expression);
    return { result: { type: 'boolean', value: true } };
  });
  const executor = new CdpActionExecutor(cdp);
  await executor.execute('click', {
    index: 0,
    role: 'button',
    tag: 'button',
    text: '赞',
    attributes: { 'data-id': 'like1' },
    clickable: true,
    path: '/html[1]/body[1]/button[1]',
  });
  assert.match(sentExpr, /document\.evaluate/);
  assert.match(sentExpr, /el\.click\(\)/);
});

test('CdpActionExecutor 在元素未命中（返回非 true）时抛错', async () => {
  const cdp = fakeCdp(() => ({ result: { type: 'boolean', value: false } }));
  const executor = new CdpActionExecutor(cdp);
  await assert.rejects(
    executor.execute('click', {
      index: 0,
      role: 'button',
      tag: 'button',
      text: 'x',
      attributes: {},
      clickable: true,
      path: '/html[1]/body[1]/button[9]',
    }),
    /未命中目标元素/,
  );
});
