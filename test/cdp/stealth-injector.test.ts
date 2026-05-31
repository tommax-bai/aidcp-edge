import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CdpStealthInjector,
  buildStealthScript,
  injectStealth,
} from '../../src/cdp/index.js';
import type { StealthCdp } from '../../src/cdp/index.js';

/** 记录所有 send 调用（method + params），按 method 返回预设。 */
function recordingCdp(
  responder: (method: string) => unknown = () => ({ identifier: 'script-1' }),
): { cdp: StealthCdp; calls: { method: string; params: Record<string, unknown> }[] } {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return responder(method);
    },
  } as unknown as StealthCdp;
  return { cdp, calls };
}

// ---------------- buildStealthScript：脚本内容 ----------------

test('buildStealthScript 产出一个可立即执行的 IIFE 字符串', () => {
  const src = buildStealthScript();
  assert.equal(typeof src, 'string');
  assert.ok(src.startsWith('('), '应为 (fn)() 形式');
  assert.ok(src.trim().endsWith(')();'), '应是立即执行函数');
});

test('buildStealthScript 覆盖 §1.1 navigator.webdriver 清除', () => {
  const src = buildStealthScript();
  assert.match(src, /webdriver/);
  // get 返回 undefined（构建工具可能把 undefined 转写为 void 0）
  assert.match(src, /get:[^,]*=>\s*(undefined|void 0)/);
});

test('buildStealthScript 覆盖 §1.2 删除 cdc_ / $cdc_ 残留变量', () => {
  const src = buildStealthScript();
  assert.match(src, /cdc_/);
  assert.match(src, /\$cdc_/);
  assert.match(src, /delete /);
});

test('buildStealthScript 覆盖 navigator.languages 补齐为 zh-CN', () => {
  const src = buildStealthScript();
  assert.match(src, /languages/);
  assert.match(src, /zh-CN/);
});

test('buildStealthScript 覆盖 navigator.plugins 补齐非空插件列表', () => {
  const src = buildStealthScript();
  assert.match(src, /plugins/);
  assert.match(src, /PDF Viewer/);
});

test('buildStealthScript 覆盖 permissions.query Notification 返回非 denied', () => {
  const src = buildStealthScript();
  assert.match(src, /permissions/);
  assert.match(src, /notifications/);
  // denied 应被改写为 prompt（构建工具可能用单/双引号）
  assert.match(src, /["']prompt["']/);
});

test('buildStealthScript 覆盖 window.chrome 对象结构（runtime/app/csi/loadTimes）', () => {
  const src = buildStealthScript();
  assert.match(src, /chrome\.runtime/);
  assert.match(src, /chrome\.app/);
  assert.match(src, /csi/);
  assert.match(src, /loadTimes/);
});

test('buildStealthScript 覆盖 §4.3 console.debug 绕过', () => {
  const src = buildStealthScript();
  assert.match(src, /console/);
  assert.match(src, /debug/);
});

test('buildStealthScript 覆盖 §4.3 Function.prototype.toString 原生伪装', () => {
  const src = buildStealthScript();
  assert.match(src, /Function\.prototype/);
  assert.match(src, /\[native code\]/);
});

// ---------------- CdpStealthInjector：调用顺序与参数 ----------------

test('inject 先 Page.enable 再 addScriptToEvaluateOnNewDocument（顺序正确）', async () => {
  const { cdp, calls } = recordingCdp();
  const injector = new CdpStealthInjector();
  await injector.inject(cdp);

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.method, 'Page.enable');
  assert.equal(calls[1]!.method, 'Page.addScriptToEvaluateOnNewDocument');
});

test('inject 注入的 source 即 buildStealthScript 的产出', async () => {
  const { cdp, calls } = recordingCdp();
  await new CdpStealthInjector().inject(cdp);

  const addCall = calls.find((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument');
  assert.ok(addCall);
  assert.equal(addCall!.params.source, buildStealthScript());
});

test('inject 可注入自定义脚本源（scriptSource 覆盖）', async () => {
  const { cdp, calls } = recordingCdp();
  await new CdpStealthInjector({ scriptSource: 'custom();' }).inject(cdp);

  const addCall = calls.find((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument');
  assert.equal(addCall!.params.source, 'custom();');
});

test('inject enablePageDomain=false 时不调用 Page.enable', async () => {
  const { cdp, calls } = recordingCdp();
  await new CdpStealthInjector({ enablePageDomain: false }).inject(cdp);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'Page.addScriptToEvaluateOnNewDocument');
});

test('inject 记录返回的 identifier 到 lastIdentifier', async () => {
  const { cdp } = recordingCdp(() => ({ identifier: 'abc-123' }));
  const injector = new CdpStealthInjector();
  await injector.inject(cdp);
  assert.equal(injector.lastIdentifier, 'abc-123');
});

test('inject 即使 Page.enable 抛错也不阻塞注入', async () => {
  const calls: string[] = [];
  const cdp = {
    send: async (method: string) => {
      calls.push(method);
      if (method === 'Page.enable') throw new Error('already enabled');
      return { identifier: 'x' };
    },
  } as unknown as StealthCdp;
  await new CdpStealthInjector().inject(cdp);
  // Page.enable 抛错被吞，但 addScript 仍被调用
  assert.ok(calls.includes('Page.addScriptToEvaluateOnNewDocument'));
});

test('injectStealth 便捷函数用默认配置注入', async () => {
  const { cdp, calls } = recordingCdp();
  await injectStealth(cdp);
  assert.equal(calls[0]!.method, 'Page.enable');
  assert.equal(calls[1]!.method, 'Page.addScriptToEvaluateOnNewDocument');
});
