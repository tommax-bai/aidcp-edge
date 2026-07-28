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

// ── change facebook-rule-mode-without-persona：受控页补人设横幅的规则模式判据 ──

const personaNotice = readFileSync(new URL('../../src/electron/persona-notice.cjs', import.meta.url), 'utf8');

test('受控页横幅的规则模式判据只来自云端权威现读，读不到即 fail-closed', () => {
  const start = main.indexOf('const FACEBOOK_RULE_MODE_FACT_TTL_MS');
  const end = main.indexOf('function sendBrowserParkingCommand', start);
  const block = main.slice(start, end);
  assert.ok(start >= 0 && end > start, '规则模式横幅判据应与人设横幅同处一段');
  // 事实只能来自与规则模式开关行同一条 env-scoped customer-auth 读；MUST NOT 由本地状态推断。
  assert.match(block, /interactionCustomerRequest\(\{/);
  assert.match(block, /`\/environments\/\$\{encodeURIComponent\(envKey\)\}\/facebook-rule-mode`/);
  assert.match(block, /method: 'GET'/);
  assert.doesNotMatch(block, /accountId|AIDCP_PLATFORM|process\.env/);
  // 缓存有限时长：规则模式关掉之后横幅必须能回来，不得永久静默。
  assert.match(block, /Date\.now\(\) - fact\.at < FACEBOOK_RULE_MODE_FACT_TTL_MS/);
  // 读失败也落成一条已知结论（enabled=null），下一轮按未启用处理 → 横幅照旧推出。
  assert.match(block, /\{ enabled: null, at: Date\.now\(\) \}/);
  // 只对确认为 Facebook 的环境成立。
  assert.match(block, /normalizePlatform\(handle\.platform\) === 'facebook'/);
  // 并发到达的等待方必须共用在途那次读的 Promise。若在途时返回一个已完成的空 Promise，等待方的续跳会在
  // 事实仍未知时立刻再等一次 → 微任务自旋把事件循环饿死，那次读反而永远回不来（横幅从此永久静默）。
  assert.match(block, /const inFlight = facebookRuleModeFactReads\.get\(envKey\);/);
  assert.match(block, /if \(inFlight\) return inFlight;/);
});

test('人设横幅纯逻辑只在平台确认为 Facebook 且配置确为已开启时静默', () => {
  assert.match(personaNotice, /facebookRuleMode\.platform === 'facebook'/);
  assert.match(personaNotice, /facebookRuleMode\.enabled === true/);
  // 三态判例不得被这条例外冲掉：横幅仍只由云端权威的「未绑」触发。
  assert.match(personaNotice, /current\.personaBound === false/);
  assert.doesNotMatch(personaNotice, /personaBound !== true/);
});
