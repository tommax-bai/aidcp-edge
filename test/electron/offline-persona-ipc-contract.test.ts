import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const main = readFileSync(join(electronDir, 'main.cjs'), 'utf8');
const preload = readFileSync(join(electronDir, 'preload.cjs'), 'utf8');

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

test('人设 IPC 本地白名单、幂等键和体积上限保持 fail-closed', () => {
  const personaBlock = main.slice(
    main.indexOf('// 账号人设（change offline-account-persona-management）'),
    main.indexOf("ipcMain.handle('publish:approval'"),
  );
  assert.match(personaBlock, /new Set\(\['keywordSelections', 'writingLanguage', 'idempotencyKey'\]\)/);
  assert.match(personaBlock, /interactionIdempotencyKey\(args\.idempotencyKey\)/);
  assert.match(personaBlock, /args\.keywordSelections\.length > 24/);
  assert.match(personaBlock, /value\.length > 40/);
  assert.match(personaBlock, /new Set\(\['soulYaml'\]\)/);
  assert.match(personaBlock, /Buffer\.byteLength\(args\.soulYaml, 'utf8'\) > 32 \* 1024/);
  const fetchBlock = main.slice(main.indexOf('async function clientAuthFetch'), main.indexOf('const CONTROL_BOOTSTRAP_REASON_ZH'));
  assert.match(fetchBlock, /timeoutMs = 12000/);
  assert.match(fetchBlock, /timeoutMs <= 200000/);
});
