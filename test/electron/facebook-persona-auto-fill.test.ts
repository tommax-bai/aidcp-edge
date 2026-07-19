import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeFacebookPersonaAutoFillOptions,
  requestFacebookPersonaAutoFill,
} = require('../../src/electron/facebook-persona-auto-fill.cjs') as {
  normalizeFacebookPersonaAutoFillOptions(opts: unknown):
    { ok: true; enabled: boolean; writingLanguage?: string } | { ok: false; error: string };
  requestFacebookPersonaAutoFill(opts: Record<string, unknown>): Promise<Record<string, unknown>>;
};

const main = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../src/electron/renderer/index.html', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../../src/electron/renderer/renderer.js', import.meta.url), 'utf8');

test('批量人设能力默认开启并要求受控语言；显式关闭后不提交', () => {
  assert.deepEqual(normalizeFacebookPersonaAutoFillOptions({}), { ok: true, enabled: true, writingLanguage: 'zh-CN' });
  assert.deepEqual(normalizeFacebookPersonaAutoFillOptions({ facebookPersonaAutoFill: false }), { ok: true, enabled: false });
  assert.deepEqual(
    normalizeFacebookPersonaAutoFillOptions({ facebookPersonaWritingLanguage: 'vi' }),
    { ok: true, enabled: true, writingLanguage: 'vi' },
  );
  assert.equal(normalizeFacebookPersonaAutoFillOptions({ facebookPersonaWritingLanguage: 'fr' }).ok, false);
});

test('请求只提交 platform/strategy/writingLanguage，幂等重试不泄漏账号、环境或导入密文', async () => {
  const calls: Array<{ pathname: string; options: Record<string, unknown> }> = [];
  const request = async (pathname: string, options: Record<string, unknown>) => {
    calls.push({ pathname, options });
    return calls.length === 1
      ? { ok: false, status: 503, data: { error: 'temporary' } }
      : { ok: true, status: 201, data: { data: { runId: 'run-1' } } };
  };
  const result = await requestFacebookPersonaAutoFill({
    request,
    token: 'customer-secret-token',
    idempotencyKey: 'batch-key-1',
    writingLanguage: 'en',
    createdItems: [{ userId: 'env-secret-id', assignedToCurrentClient: true, requiresAdminAssignment: false }],
  });
  assert.equal(result.accepted, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.pathname), ['/persona-auto-fill/runs', '/persona-auto-fill/runs']);
  assert.deepEqual(calls.map((call) => call.options.idempotencyKey), ['batch-key-1', 'batch-key-1']);
  assert.deepEqual(calls[0].options.body, {
    platform: 'facebook', strategy: 'facebook_auto_v1', writingLanguage: 'en',
  });
  const bodyWire = JSON.stringify(calls[0].options.body);
  for (const forbidden of ['accountId', 'envKey', 'env-secret-id', 'customer-secret-token', 'cookie', 'password']) {
    assert.equal(bodyWire.includes(forbidden), false, `请求体不得包含 ${forbidden}`);
  }
});

test('没有权威归属环境时不调用 Cloud；创建回执与人设受理状态保持分离', async () => {
  let calls = 0;
  const result = await requestFacebookPersonaAutoFill({
    request: async () => { calls += 1; return { ok: true, status: 201 }; },
    token: 'token',
    idempotencyKey: 'batch-key-1',
    writingLanguage: 'zh-CN',
    createdItems: [{ userId: 'local-only', assignedToCurrentClient: false, requiresAdminAssignment: true }],
  });
  assert.equal(calls, 0);
  assert.equal(result.accepted, false);
  assert.match(String(result.warning), /没有完成 Cloud 权威归属/);
  assert.match(main, /personaAutoFillAccepted:\s*outcome\.accepted === true/);
  assert.match(main, /return withFacebookPersonaAutoFillReceipt\(receipt, personaAutoFill, personaAutoFillIdempotencyKey\)/);
  assert.match(main, /failedFacebookBatchReceipt[\s\S]*withFacebookPersonaAutoFillReceipt/);
});

test('部分创建只要有一个已权威归属就提交一次；Cloud 失败只形成独立警告', async () => {
  let calls = 0;
  const result = await requestFacebookPersonaAutoFill({
    request: async () => {
      calls += 1;
      return { ok: false, status: 422, data: { error: 'validation_failed' } };
    },
    token: 'token',
    idempotencyKey: 'partial-batch-key',
    writingLanguage: 'vi',
    createdItems: [
      { userId: 'assigned', assignedToCurrentClient: true, requiresAdminAssignment: false },
      { userId: 'local-only', assignedToCurrentClient: false, requiresAdminAssignment: true },
    ],
  });
  assert.equal(calls, 1, '具名 4xx 不盲重试');
  assert.equal(result.accepted, false);
  assert.equal(result.attempted, true);
  assert.match(String(result.warning), /环境已创建，但云端未受理人设自动补齐/);
  assert.match(main, /if \(!config \|\| !config\.enabled/,
    '显式关闭时主进程直接返回创建回执，不调用 customer-auth');
});

test('UI 只在 Facebook 批量模式显示：默认勾选、单一语言选择，无弹窗或跳转', () => {
  assert.match(html, /id="ads-fb-persona-auto-fill" type="checkbox" checked/);
  assert.match(html, /创建后由云端自动补齐未设置人设/);
  assert.match(html, /id="ads-fb-persona-language"/);
  assert.match(renderer, /adsFbPersonaAutoFillWrap\?\.classList\.toggle\('hidden', !batch\)/);
  assert.match(renderer, /facebookPersonaAutoFill:\s*settingsUi\.adsFbPersonaAutoFill\?\.checked !== false/);
  assert.match(renderer, /facebookPersonaWritingLanguage:\s*settingsUi\.adsFbPersonaLanguage\?\.value \|\| 'zh-CN'/);
  assert.doesNotMatch(renderer, /personaAutoFill[^\n]*(open|modal|popup|navigate)/i);
});
