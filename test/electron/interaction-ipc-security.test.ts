import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '../../src/electron');
const main = readFileSync(join(electronDir, 'main.cjs'), 'utf8');
const preload = readFileSync(join(electronDir, 'preload.cjs'), 'utf8');
const renderer = readFileSync(join(electronDir, 'renderer/interaction-workspace.js'), 'utf8');

const namedChannels = [
  'interaction:list', 'interaction:detail', 'interaction:draft:update', 'interaction:approve',
  'interaction:regenerate', 'interaction:send', 'interaction:ignore', 'interaction:escalate',
  'interaction:sync', 'interaction:auth:reopen', 'interaction:reads:cancel',
];

test('preload 只暴露具名互动方法，不给 renderer 任意 URL / method / header / token 能力', () => {
  for (const channel of namedChannels) assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  const interactionBlock = preload.slice(preload.indexOf('// 视频号互动工作区'));
  const executableInteractionBlock = interactionBlock.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(executableInteractionBlock, /interactionFetch|fetch\s*:|\burl\b|authorization|cookie|jwt|headers\s*:/i);
  assert.doesNotMatch(renderer, /console\.(?:log|info|debug)|authorization|cookie|jwt/i, '互动 renderer 不记录完整消息，也不接触认证材料');
});

test('main 锁定 customer-auth 路径和方法，并对白名单参数与 envKey 双重校验', () => {
  for (const channel of namedChannels.filter((value) => value !== 'interaction:approve' && value !== 'interaction:regenerate')) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  }
  assert.match(main, /for \(const action of \['approve', 'regenerate'\]\)/);
  assert.match(main, /ipcMain\.handle\(`interaction:\$\{action\}`/);
  assert.match(main, /interactionArgs\(raw, new Set\(\[/, '每个 handler 必须声明参数白名单');
  assert.match(main, /responseEnvKey !== envKey/, 'Cloud 成功响应必须由 main 再校验 envKey');
  assert.match(main, /pathname: `\/environments\/\$\{encodeURIComponent\(envKey\)\}/, '路径由 main 从 envKey 组装');
  assert.match(main, /token: clientSession\.token/, 'customer-auth token 只在 main 注入');
  assert.match(main, /method: 'PUT',[\s\S]*body: \{ expectedVersion, finalText: args\.finalText \}/, '草稿写入锁定 PUT 与 CAS body');
  assert.match(main, /interaction:send[\s\S]*body: \{ expectedVersion \},[\s\S]*idempotencyKey/, '发送必须同时带 CAS 与幂等键');
  assert.match(main, /interaction:sync[\s\S]*idempotencyKey/, '同步必须带幂等键');
  assert.match(main, /interaction:auth:reopen[\s\S]*idempotencyKey/, '重新登录动作必须带幂等键');
});

test('环境切换取消读取、renderer 丢弃迟到响应且写操作防重复点击', () => {
  assert.match(main, /new AbortController\(\)/);
  assert.match(main, /controller\.abort\(\)/);
  assert.match(renderer, /capturedEpoch === epoch && selectedEnvKey\(\) === envKey/);
  assert.match(renderer, /if \(env && api\.interactionCancelReads\)/);
  assert.match(renderer, /if \(!job \|\| state\.actionBusy/);
  assert.match(renderer, /const payload = \{ envKey, expectedVersion \}/);
  assert.match(renderer, /job\.state === 'ambiguous'[\s\S]*不会自动重复发送/);
  assert.match(renderer, /job\.state === 'queued'[\s\S]*不等于平台发送完成/);
});
