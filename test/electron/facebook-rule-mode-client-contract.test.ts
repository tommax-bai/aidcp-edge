import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../../src/electron/preload.cjs', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../../src/electron/renderer/renderer.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../src/electron/renderer/index.html', import.meta.url), 'utf8');

test('规则模式只经具名 IPC 和固定 customer-auth 环境路径读写', () => {
  for (const channel of ['facebook-rule-mode:get', 'facebook-rule-mode:set']) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel}'`));
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel}'`));
  }
  const start = main.indexOf("ipcMain.handle('facebook-rule-mode:set'");
  const end = main.indexOf('// Facebook 环境风险真态读', start);
  const block = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /new Set\(\['envKey', 'enabled'\]\)/);
  assert.match(block, /new Set\(\['envKey'\]\)/);
  assert.match(block, /typeof args\.enabled !== 'boolean'/);
  assert.match(block, /`\/environments\/\$\{encodeURIComponent\(envKey\)\}\/facebook-rule-mode`/);
  assert.match(block, /method: 'PUT'/);
  assert.match(block, /method: 'GET'/);
  assert.match(block, /body: \{ enabled: args\.enabled \}/);
  assert.doesNotMatch(block, /accountId|definitionId|definitionVersion|threshold|authorization|token/);
  assert.doesNotMatch(renderer, /\/environments\/[^'"`]*\/facebook-rule-mode/,
    'renderer 不得自行拼客户 API 路径');
});

test('规则模式静态行紧邻慢启动且文案不把配置开启冒充运行中', () => {
  const slow = html.indexOf('id="slow-start-row"');
  const rule = html.indexOf('id="facebook-rule-mode-row"');
  const risk = html.indexOf('id="risk-recovery-row"');
  assert.ok(slow >= 0 && slow < rule && rule < risk, '规则模式应在慢启动之后、解除受限之前');
  const block = html.slice(rule, risk);
  assert.match(block, /id="facebook-rule-mode-toggle"/);
  assert.match(block, /开启后按 Cloud 固定规则配置运行/);
  assert.match(block, /慢启动开启时由慢启动优先，规则模式暂停/);
  assert.doesNotMatch(block, /规则模式正在运行|运行中/);
});

test('renderer 的规则模式提交只传 envKey + enabled，成功只认完整同环境回执', () => {
  const start = renderer.indexOf('async function submitFacebookRuleMode');
  const end = renderer.indexOf('fields.quotaToggle', start);
  const block = renderer.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /setFacebookRuleMode\(\{ envKey, enabled \}\)/);
  assert.match(block, /normalizeFacebookRuleModeResponse\(res, envKey\)/);
  assert.match(block, /current\.envKey === envKey/);
  assert.doesNotMatch(block, /accountId|definitionId|definitionVersion|localStorage|sessionStorage|setInterval/);
});
