import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildFacebookSelectedPersona,
  requestFacebookSelectedPersonaFill,
} = require('../../src/electron/facebook-persona-auto-fill.cjs') as {
  buildFacebookSelectedPersona(selection: Record<string, unknown>): Record<string, unknown>;
  requestFacebookSelectedPersonaFill(opts: Record<string, unknown>): Promise<Record<string, unknown>>;
};

const main = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../src/electron/renderer/index.html', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../../src/electron/renderer/renderer.js', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../../src/electron/preload.cjs', import.meta.url), 'utf8');

const selection = {
  tone: '亲切接地气',
  writingLanguage: 'en',
  likeAffinity: 'like_more',
  contentPreferences: ['城市散步', '周末出游', '咖啡探店'],
  contentCategories: ['旅行', '美食'],
};

test('客户端按人工选择确定性构建一份完整 Facebook 人设，不依赖账号或模型', () => {
  const first = buildFacebookSelectedPersona(selection);
  const second = buildFacebookSelectedPersona(selection);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first, '相同选择必须生成逐字相同模板');
  const yaml = String(first.soulYaml);
  assert.match(yaml, /writing_language: "en"/);
  assert.match(yaml, /tone: "亲切接地气"/);
  assert.match(yaml, /- "城市散步"/);
  assert.match(yaml, /like_affinity: "like_more"/);
  for (const forbidden of ['accountId', 'envKey', 'facebook_auto_v1', 'diversitySeed']) {
    assert.equal(yaml.includes(forbidden), false);
  }
});

test('批量模板缺少任何人工必选项都 fail-closed', () => {
  assert.equal(buildFacebookSelectedPersona({ ...selection, tone: '' }).reason, 'tone_required');
  assert.equal(buildFacebookSelectedPersona({ ...selection, writingLanguage: '' }).reason, 'writing_language_required');
  assert.equal(buildFacebookSelectedPersona({ ...selection, likeAffinity: 'forced' }).reason, 'like_affinity_invalid');
  assert.equal(buildFacebookSelectedPersona({ ...selection, contentPreferences: [] }).reason, 'content_preferences_required');
});

test('确认请求只提交 platform+soulYaml，幂等重试不泄漏目标、凭据或独立语言', async () => {
  const built = buildFacebookSelectedPersona(selection);
  const calls: Array<{ pathname: string; options: Record<string, unknown> }> = [];
  const result = await requestFacebookSelectedPersonaFill({
    request: async (pathname: string, options: Record<string, unknown>) => {
      calls.push({ pathname, options });
      return calls.length === 1 ? { ok: false, status: 503 } : { ok: true, status: 201 };
    },
    token: 'customer-secret-token',
    idempotencyKey: 'selected-safe-key',
    soulYaml: built.soulYaml,
  });
  assert.equal(result.accepted, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options.body, { platform: 'facebook', soulYaml: built.soulYaml });
  assert.deepEqual(calls.map((call) => call.options.idempotencyKey), ['selected-safe-key', 'selected-safe-key']);
  const bodyWire = JSON.stringify(calls[0].options.body);
  for (const forbidden of ['accountId', 'accountIds', 'envKey', 'envKeys', 'strategy', 'writingLanguage', 'customer-secret-token', 'cookie', 'password']) {
    assert.equal(bodyWire.includes(forbidden), false, `请求体不得包含 ${forbidden}`);
  }
});

test('批量创建彻底移除人设能力；FB 筛选入口只打开人设浮层并使用具名安全 IPC', () => {
  assert.doesNotMatch(html, /ads-fb-persona-auto-fill|创建后由云端自动补齐|本批发言语言/);
  assert.doesNotMatch(renderer, /facebookPersonaAutoFill|personaAutoFillAccepted|personaAutoFillWarning/);
  assert.doesNotMatch(main, /withFacebookPersonaAutoFillReceipt|fb-batch-persona|personaAutoFillAccepted/);

  assert.match(html, /id="rail-facebook-persona-submit"[^>]*>批量设置人设</);
  assert.doesNotMatch(html, /id="rail-facebook-persona-language"/);
  assert.match(renderer, /railFacebookPersonaSubmit\?\.addEventListener\('click', \(\) => openFacebookBulkPersona\(\)\)/);
  assert.match(renderer, /personaBulkFillMode[\s\S]*facebookPersonaTemplatePreview/);
  assert.match(renderer, /facebookPersonaFillSelected\(personaDraftYaml\)/);
  assert.match(preload, /facebookPersonaTemplatePreview:[^\n]*persona:preview-facebook-template/);
  assert.match(preload, /facebookPersonaFillSelected:[^\n]*persona:fill-facebook-selected/);

  const start = main.indexOf("ipcMain.handle('persona:preview-facebook-template'");
  const end = main.indexOf("ipcMain.handle('browser:openAdsDownload'", start);
  assert.ok(start >= 0 && end > start);
  const handlers = main.slice(start, end);
  assert.match(handlers, /buildFacebookSelectedPersona/);
  assert.match(handlers, /requestFacebookSelectedPersonaFill/);
  assert.match(handlers, /idempotencyKey:\s*`fb-selected-persona-\$\{crypto\.randomUUID\(\)\}`/);
  for (const forbidden of ['accountId', 'accountIds', 'envKey', 'envKeys', 'writingLanguage']) {
    assert.equal(handlers.includes(forbidden), false, `批量 IPC 不得接受 ${forbidden}`);
  }
});
