import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

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

// ── 事实过期（TTL 到点）不得让已推出的横幅闪一下 ──────────────────────────────────────────────
//
// 真实的 syncBrowserPersonaNotice 连同规则模式事实缓存整段从 main.cjs 里取出来跑（main.cjs 是 Electron
// 主进程入口，整体 require 不进来），只把它的外部依赖打桩。断言看的是**真正写给受控页的横幅指令序列**。
function loadPersonaNoticeSync(cloudEnabled: boolean) {
  const require_ = createRequire(import.meta.url);
  const { browserPersonaNoticeForStatus, browserPersonaNoticeKey } =
    require_('../../src/electron/persona-notice.cjs');
  const block = main.slice(
    main.indexOf('// 人设横幅判定宽限期'),
    main.indexOf('function sendBrowserParkingCommand'),
  );
  assert.ok(block.length > 0, '未能从 main.cjs 取到人设横幅那一段');

  const writes: boolean[] = [];      // 真正下发到受控页的每一条 browser.personaNotice
  const state = { reads: 0, enabled: cloudEnabled };
  const envs = new Map();
  const factory = new Function(
    'browserPersonaNoticeForStatus', 'browserPersonaNoticeKey', 'personaApplicable',
    'normalizePlatform', 'writeBrowserControlCommand', 'interactionCustomerRequest', 'envs',
    `${block}\n return { syncBrowserPersonaNotice, facebookRuleModeFacts };`,
  ) as (...args: unknown[]) => { syncBrowserPersonaNotice: (h: unknown) => void; facebookRuleModeFacts: Map<string, { at: number }> };
  const api = factory(
    browserPersonaNoticeForStatus, browserPersonaNoticeKey, () => true,
    (p: unknown) => String(p || '').toLowerCase(),
    (_h: unknown, _type: string, payload: { active: boolean }) => { writes.push(payload.active); return { ok: true }; },
    async () => {
      state.reads += 1;
      return { ok: true, data: { data: { envKey: 'env-1', facebookRuleMode: { enabled: state.enabled } } } };
    },
    envs,
  );
  const handle = {
    browserParkingReady: true, child: {}, removed: false,
    profileId: 'env-1', platform: 'facebook', envId: 'e1',
    personaNoticeReadySince: Date.now() - 60_000, // 人设宽限早已过
    browserPersonaNoticeState: null,
    status: { auth: 'logged in', cloud: 'connected', personaBound: false },
  };
  envs.set('e1', handle);
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 10)); };
  const expire = () => { api.facebookRuleModeFacts.get('env-1')!.at = Date.now() - 61_000; };
  return { ...api, handle, writes, state, settle, expire };
}

test('规则模式事实过期只在后台复读，绝不把已推出的补人设横幅撤下再推（不闪）', async () => {
  const t = loadPersonaNoticeSync(false); // 云端：规则模式关闭 → 横幅本就该一直挂着
  t.syncBrowserPersonaNotice(t.handle);
  await t.settle();
  assert.deepEqual(t.writes, [false, true], '首读期间先按住一次，读回来后推出横幅');

  const mark = t.writes.length;
  for (let round = 0; round < 3; round++) { t.expire(); t.syncBrowserPersonaNotice(t.handle); await t.settle(); }
  assert.deepEqual(t.writes.slice(mark), [],
    'TTL 到点必须沿用上次读到的结论继续呈现；清空判据会让横幅每分钟撤下再推一次');
  assert.ok(t.state.reads > 1, '不闪不等于不复读：过期后仍要发权威读，否则规则模式改了也看不见');
});

test('规则模式事实过期仍会复读：在别处关掉规则模式后，补人设横幅必须回得来', async () => {
  const t = loadPersonaNoticeSync(true); // 云端：规则模式开启 → 横幅静默
  t.syncBrowserPersonaNotice(t.handle);
  await t.settle();
  assert.ok(!t.writes.includes(true), '规则模式开启期间绝不推补人设横幅');

  t.state.enabled = false; // 运营在 Console 关掉规则模式
  t.expire();
  t.syncBrowserPersonaNotice(t.handle);
  await t.settle();
  assert.ok(t.writes.includes(true),
    '沿用旧事实不得变成永不复读——否则规则模式关掉之后横幅再也回不来');
});
