import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const main = readFileSync(join(electronDir, 'main.cjs'), 'utf8');
const preload = readFileSync(join(electronDir, 'preload.cjs'), 'utf8');
const require = createRequire(import.meta.url);
const {
  MAX_PERSONA_KEYWORD_SELECTIONS,
  MAX_PERSONA_KEYWORD_LENGTH,
  validatePersonaKeywordSelections,
} = require('../../src/electron/persona-request-validation.cjs') as {
  MAX_PERSONA_KEYWORD_SELECTIONS: number;
  MAX_PERSONA_KEYWORD_LENGTH: number;
  validatePersonaKeywordSelections: (value: unknown) => { ok: boolean; reason?: string };
};

test('人设 preload 只暴露三个具名环境方法，不暴露 URL、token 或 accountId', () => {
  assert.match(preload, /personaGet: \(envId\) => ipcRenderer\.invoke\('persona:get', envId\)/);
  assert.match(preload, /personaGenerate: \(envId, opts\) => ipcRenderer\.invoke\('persona:generate', envId, opts\)/);
  assert.match(preload, /personaPersist: \(envId, opts\) => ipcRenderer\.invoke\('persona:persist', envId, opts\)/);
  const personaBlock = preload.slice(preload.indexOf('// 账号人设'), preload.indexOf('notify:'));
  assert.doesNotMatch(personaBlock, /\burl\b|authorization|headers|token|accountId/i);
});

test('人设 IPC 固定 customer-auth 路径与方法，停止状态不经过环境 core', () => {
  const personaBlock = main.slice(
    main.indexOf('// 账号人设（change offline-account-persona-management）'),
    main.indexOf("ipcMain.handle('publish:approval'"),
  );
  for (const channel of ['persona:get', 'persona:generate', 'persona:persist']) {
    assert.match(personaBlock, new RegExp(`ipcMain\\.handle\\('${channel.replace(':', '\\:')}'`));
  }
  assert.match(personaBlock, /interactionId\(handle\.profileId, 'envKey'\)/, 'main 必须把本地 envId 权威换成 profileId/envKey');
  assert.match(personaBlock, /requestedEnvId \? envs\.get\(requestedEnvId\) : selectedHandle\(\)/,
    '显式 envId 必须精确命中，未知值不得回落当前环境');
  assert.match(personaBlock, /\/environments\/\$\{encodeURIComponent\(envKey\)\}\/persona`/);
  assert.match(personaBlock, /\/persona\/draft`[\s\S]*method: 'POST'/);
  assert.match(personaBlock, /persona:persist[\s\S]*method: 'PUT'/);
  assert.match(personaBlock, /timeoutMs: 200000/, '只有 AI 草稿生成使用 200 秒超时');
  assert.doesNotMatch(personaBlock, /sendPersonaCommand|\.child\b|queueStartEnv|startEdge|resumeEdge/, '人设读写不得依赖 core/浏览器运行');
});

test('视频号人设能力为不适用，旧 IPC fail-closed 返回 not_applicable', () => {
  const personaBlock = main.slice(
    main.indexOf('// 账号人设（change offline-account-persona-management）'),
    main.indexOf("ipcMain.handle('publish:approval'"),
  );
  assert.match(personaBlock, /if \(!personaApplicable\(handle\)\)/);
  assert.match(personaBlock, /error\.code = 'not_applicable'/);
  assert.match(personaBlock, /error && error\.code === 'not_applicable' \? 'not_applicable' : 'invalid_request'/);
});

test('人设 IPC 本地白名单、幂等键和体积上限保持 fail-closed', () => {
  const personaBlock = main.slice(
    main.indexOf('// 账号人设（change offline-account-persona-management）'),
    main.indexOf("ipcMain.handle('publish:approval'"),
  );
  assert.match(personaBlock, /new Set\(\['keywordSelections', 'writingLanguage', 'idempotencyKey'\]\)/);
  assert.match(personaBlock, /interactionIdempotencyKey\(args\.idempotencyKey\)/);
  assert.match(personaBlock, /validatePersonaKeywordSelections\(args\.keywordSelections\)/);
  assert.match(main, /require\('\.\/persona-request-validation\.cjs'\)/);
  assert.match(personaBlock, /new Set\(\['soulYaml'\]\)/);
  assert.match(personaBlock, /Buffer\.byteLength\(args\.soulYaml, 'utf8'\) > 32 \* 1024/);
  const fetchBlock = main.slice(main.indexOf('async function clientAuthFetch'), main.indexOf('const CONTROL_BOOTSTRAP_REASON_ZH'));
  assert.match(fetchBlock, /timeoutMs = 12000/);
  assert.match(fetchBlock, /timeoutMs <= 200000/);
});

test('人设 IPC 允许展开后的正常关键词载荷，并在发 HTTP 前拒绝超过 64 项或单项 40 字', () => {
  assert.equal(MAX_PERSONA_KEYWORD_SELECTIONS, 64);
  assert.equal(MAX_PERSONA_KEYWORD_LENGTH, 40);
  assert.deepEqual(validatePersonaKeywordSelections(Array.from({ length: 50 }, (_, i) => `keyword-${i}`)), { ok: true });
  assert.deepEqual(validatePersonaKeywordSelections(Array.from({ length: 64 }, (_, i) => `keyword-${i}`)), { ok: true });
  assert.equal(validatePersonaKeywordSelections(Array.from({ length: 65 }, (_, i) => `keyword-${i}`)).reason, 'input_too_large');
  assert.equal(validatePersonaKeywordSelections(['x'.repeat(41)]).reason, 'input_too_large');
  assert.equal(validatePersonaKeywordSelections(['valid', 1]).reason, 'invalid_request');
});
