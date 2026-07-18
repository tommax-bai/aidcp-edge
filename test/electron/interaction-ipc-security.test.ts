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
  'interaction:sync', 'interaction:test-reset', 'interaction:auth:reopen', 'interaction:browser:control', 'interaction:reads:cancel',
  'interaction:browser:open-local', 'interaction:read-controls:update', 'interaction:notify',
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
  assert.match(main, /interaction:test-reset[\s\S]*body: \{ channel \},[\s\S]*idempotencyKey/, '测试重置只允许单渠道并必须带幂等键');
  assert.match(main, /interaction:auth:reopen[\s\S]*idempotencyKey/, '重新登录动作必须带幂等键');
  assert.match(main, /interaction:browser:control[\s\S]*body: \{ action \},[\s\S]*idempotencyKey/, '浏览器显隐只允许 open\/close 且必须带幂等键');
  assert.match(main, /\/interactions\/browser/, '浏览器控制路径由 main 固定组装');
  const localOpenHandler = main.slice(
    main.indexOf("ipcMain.handle('interaction:browser:open-local'"),
    main.indexOf("ipcMain.handle('interaction:read-controls:update'"),
  );
  assert.match(localOpenHandler, /interactionArgs\(raw, new Set\(\['envKey'\]\)\)/, '本机打开只允许 renderer 提交 envKey');
  assert.match(localOpenHandler, /allowedProfileIds\.has\(envKey\)[\s\S]*allowedEnvironmentPlatforms\.get\(envKey\) !== 'wechat_channels'/,
    '本机打开必须重新校验当前客户可见的视频号范围');
  assert.match(localOpenHandler, /candidate\.profileId === envKey[\s\S]*normalizePlatform\(candidate\.platform\) === 'wechat_channels'/,
    '本机打开必须精确命中本地视频号 profile，不能回落当前选中环境');
  assert.match(localOpenHandler, /ensureAdsServiceOnce\(null\)[\s\S]*ensureKernelOnce\(kernelVersion, service\.cliEntry, null\)[\s\S]*adsApi\.openProfileForInspection/,
    '本机打开只准备本地运行时和 profile，不把 handle 状态冒充引擎启动');
  const executableLocalOpenHandler = localOpenHandler.split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(executableLocalOpenHandler, /interactionCustomerRequest|clientSession\.token|startEdge|queueStartEnv|resumeEdge|selectedHandle/,
    '本机打开不得经过 Cloud、启动/恢复引擎或回落其他环境');
  assert.match(main, /interaction:read-controls:update[\s\S]*method: 'PUT',[\s\S]*body: \{ expectedVersion, commentsReadEnabled, dmReadEnabled \}/, '收取开关只能写入两个读取字段');
  assert.match(main, /interaction:notify[\s\S]*allowedProfileIds\.has\(envKey\)[\s\S]*allowedEnvironmentPlatforms\.get\(envKey\) !== 'wechat_channels'/, '系统提醒必须再次校验当前客户的视频号环境范围');
  const detailHandler = main.slice(main.indexOf("ipcMain.handle('interaction:detail'"), main.indexOf("ipcMain.handle('interaction:draft:update'"));
  assert.match(detailHandler, /interactionLimit\(args\.limit\)/, '详情页仍在本地限制 renderer 传入的 limit');
  assert.match(detailHandler, /interactionQuery\(\{ cursor \}, new Set\(\['cursor'\]\)\)/, 'Cloud 详情契约只允许 cursor，不能透传本地 limit');
  assert.doesNotMatch(detailHandler, /interactionQuery\(\{ cursor, limit \}/, '详情请求不得发送 Cloud 不接受的 limit 参数');
  const clientAuthFetch = main.slice(main.indexOf('async function clientAuthFetch'), main.indexOf('// ── 视频号 InteractionWorkspace'));
  assert.match(clientAuthFetch, /readBoundedJsonResponse\(res\)/, 'customer-auth 响应必须走有界 reader');
  assert.doesNotMatch(clientAuthFetch, /res\.json\(/, '不得用 res.json() 无界聚合响应体');
  assert.match(clientAuthFetch, /code: 'WECHAT_SCHEMA_CHANGED'[\s\S]*CUSTOMER_AUTH_RESPONSE_TOO_LARGE/, '过大响应必须返回结构化 schema error');
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
