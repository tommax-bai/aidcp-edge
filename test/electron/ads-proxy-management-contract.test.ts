import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../../src/electron/preload.cjs', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../../src/electron/renderer/renderer.js', import.meta.url), 'utf8');
const writeApi = readFileSync(new URL('../../src/electron/ads-write-api.cjs', import.meta.url), 'utf8');

function handlerBlock(source: string, name: string): string {
  const start = source.indexOf(`ipcMain.handle('${name}'`);
  if (start < 0) return '';
  const next = source.indexOf('ipcMain.handle(', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

test('preload 只暴露具名代理解析、单项更新和批量更新 IPC', () => {
  assert.match(preload, /adsParseProxyLines:\s*\(input\)\s*=>\s*ipcRenderer\.invoke\('ads:parseProxyLines', input\)/);
  assert.match(preload, /adsUpdateEnvProxy:\s*\(opts\)\s*=>\s*ipcRenderer\.invoke\('ads:updateEnvProxy', opts\)/);
  assert.match(preload, /adsUpdateEnvProxies:\s*\(opts\)\s*=>\s*ipcRenderer\.invoke\('ads:updateEnvProxies', opts\)/);
  assert.match(preload, /onEnvProxyBatchProgress:\s*\(callback\)\s*=>\s*\{[\s\S]*ipcRenderer\.on\('ads:envProxyBatchProgress', listener\)[\s\S]*removeListener\('ads:envProxyBatchProgress', listener\)/);
});

test('AdsPower 代理写边界只构造 user_id + user_proxy_config 两键 body', () => {
  const start = writeApi.indexOf('async function updateProfileProxy');
  const end = writeApi.indexOf('async function renameProfile', start);
  const block = writeApi.slice(start, end);
  assert.match(block, /post\('user\/update',\s*\{\s*user_id:\s*String\(userId\),\s*user_proxy_config:\s*proxyConfig\s*\}/);
  assert.doesNotMatch(block, /\.\.\.|fingerprint|remark|group_id/);
});

test('ads:updateEnvProxies 在任何写入前完成整批计划、客户范围和运行状态复核', () => {
  const block = handlerBlock(main, 'ads:updateEnvProxies');
  assert.ok(block);
  const request = block.indexOf('batchProxyProgressRequestId(opts)');
  const plan = block.indexOf('createProxyReassignmentPlan({');
  const scope = block.indexOf('await proxyTargetScope(');
  const active = block.indexOf('plan.plan.findIndex((item) => proxyTargetActive(item.userId))');
  const writeClient = block.indexOf('createAdsWriteApi({');
  const firstWrite = block.indexOf('updateProfileProxy({');
  assert.ok(request >= 0 && request < plan, '一次性请求标识在计划和写入前校验');
  assert.ok(plan >= 0 && plan < scope);
  assert.ok(scope < active && active < writeClient);
  assert.ok(writeClient < firstWrite);
  assert.match(block, /executeProxyReassignmentPlan\(\{/, '使用可单测的逐项串行执行器');
  assert.match(block, /return proxyReassignmentFailure\(/, '任一失败立即返回部分回执');
  assert.match(block, /batchProxyUpdateError\(result\)/, '外部 AdsPower msg 经批量安全原因收窄后才进回执');
  assert.match(block, /onProgress:\s*\(\{ completedCount, totalCount \}\)\s*=>\s*\{[\s\S]*emitBatchProxyProgress\(event, requestId, completedCount, totalCount\)/);
  assert.doesNotMatch(block, /Promise\.all/, '批量代理不并发扩大写入面');
});

test('批量代理进度事件只携带请求标识与真实计数', () => {
  const start = main.indexOf('function emitBatchProxyProgress');
  const end = main.indexOf('function invalidateProxyEvidence', start);
  const block = main.slice(start, end);
  assert.match(block, /sender\.send\('ads:envProxyBatchProgress',\s*\{ requestId, completedCount, totalCount \}\)/);
  assert.doesNotMatch(block, /userId|proxyText|proxyPassword|updatedUserIds/);
});

test('单项与批量代理写入都重新拉取客户可见范围并拒绝已知运行目标', () => {
  const scopeStart = main.indexOf('async function proxyTargetScope');
  const scopeEnd = main.indexOf('function proxyTargetActive', scopeStart);
  const scopeBlock = main.slice(scopeStart, scopeEnd);
  assert.match(scopeBlock, /await refreshAllowedEnvironments\(\)/);
  assert.match(scopeBlock, /validateProxyTargetScope\(\{[\s\S]*allowedProfileIds,/);
  for (const name of ['ads:updateEnvProxy', 'ads:updateEnvProxies']) {
    const block = handlerBlock(main, name);
    assert.match(block, /await proxyTargetScope\(/);
    assert.match(block, /proxyTargetActive\(/);
    assert.ok(
      block.indexOf('adsProxyWriteInFlight = true') < block.indexOf('await proxyTargetScope('),
      `${name} 必须在首个 await 前占有单飞锁`,
    );
    assert.match(block, /finally\s*\{\s*adsProxyWriteInFlight = false;/);
  }
});

test('创建仍把用户代理传给 AdsPower，成功后把同一原代理提交 Cloud 权威', () => {
  const block = handlerBlock(main, 'ads:createEnv');
  assert.match(block, /proxy: opts && opts\.proxy,\s*\/\/ 原始表单输入/);
  const singleCreate = block.indexOf('createEnvironmentWithGroupRecovery({');
  const singleAuthority = block.indexOf('finalizeCreatedEnvironmentAssignment(result, intent, {');
  assert.ok(singleCreate >= 0 && singleCreate < singleAuthority);
  assert.match(block, /proxy:\s*item\.proxy/);
  assert.match(block, /proxyInput:\s*item\.proxy/);
  assert.doesNotMatch(
    block.slice(singleCreate, singleAuthority),
    /relayPort|127\.0\.0\.1|proxyAuthorityPayload/,
    '创建请求阶段不得把用户代理替换成 GOST',
  );
  const finalizeStart = main.indexOf('async function finalizeCreatedEnvironmentAssignment');
  const finalizeEnd = main.indexOf('async function validateExistingClientSessionForStartup', finalizeStart);
  const finalize = main.slice(finalizeStart, finalizeEnd);
  assert.match(finalize, /cloudAuthorityForProxyInput\(proxyInput\)/);
  assert.match(finalize, /proxyAuthority:\s*proxyAuthority\.authority/);
});

test('代理编辑先 CAS 更新 Cloud 权威，再更新 AdsPower 执行副本', () => {
  const single = handlerBlock(main, 'ads:updateEnvProxy');
  assert.ok(single.indexOf('saveCloudProxyAuthorityForEdit(') < single.indexOf('updateProfileProxy({'));
  assert.match(single, /cloudSaved:\s*true/);
  assert.doesNotMatch(single, /proxyAuthorityStore\.(save|remove)/);

  const batch = handlerBlock(main, 'ads:updateEnvProxies');
  assert.ok(batch.indexOf('saveCloudProxyAuthorityForEdit(') < batch.indexOf('updateProfileProxy({'));
  assert.match(batch, /updateProfileProxy\(\{ userId: item\.userId, proxyConfig: norm\.proxyConfig \}/);
  assert.match(batch, /partialApplied:\s*true/);
});

test('精确代理编辑仅从 AdsPower 识别 no_proxy，配置代理仍读取 Cloud 权威', () => {
  const block = handlerBlock(main, 'ads:getEnvProxy');
  assert.match(block, /await readAuthoritativeProfileProxy\(userId\)/);
  assert.match(block, /error:\s*proxyPreflightFailureText\(authority\.reason\)/);
  const bypassStart = main.indexOf('async function readAdsNoProxyAuthority');
  const bypassEnd = main.indexOf('async function writeCloudProxyAuthority', bypassStart);
  const bypass = main.slice(bypassStart, bypassEnd);
  assert.match(bypass, /getProfileProxyConfig/);
  assert.match(bypass, /adsNoProxyAuthorityView\(result,\s*id\)/);
  assert.doesNotMatch(bypass, /proxyHost|proxyPort|proxyUser|proxyPassword|proxy_host|proxy_port|proxy_user|proxy_password/);
});

test('环境列表以原代理权威覆盖 live GOST 摘要，但不批量投影认证字段', () => {
  const list = handlerBlock(main, 'ads:listProfiles');
  assert.match(list, /await Promise\.all\(result\.profiles\.map\(projectAuthoritativeProxySummary\)\)/);
  const start = main.indexOf('async function projectAuthoritativeProxySummary');
  const end = main.indexOf('async function ensureProfileProxyAuthority', start);
  const projection = main.slice(start, end);
  assert.match(projection, /profile\.proxyConfig\s*&&\s*profile\.proxyConfig\.noProxy === true\)\s*return profile/);
  assert.match(projection, /allowMigration:\s*false/);
  assert.match(projection, /allowAdsNoProxyBypass:\s*false/);
  assert.match(projection, /proxyType: cfg\.proxy_type/);
  assert.match(projection, /proxyHost: cfg\.proxy_host/);
  assert.match(projection, /proxyUser: ''/);
  assert.doesNotMatch(projection, /proxy_password|proxyPassword/);
});

test('renderer 以 Set 的勾选顺序提交明确 ID，不从 DOM 或重排后列表重建目标', () => {
  const start = renderer.indexOf('function selectedBatchProxyIds()');
  const end = renderer.indexOf('function setBatchProxyMsg', start);
  const block = renderer.slice(start, end);
  assert.match(block, /Array\.from\(batchProxySelectedIds\)/);
  assert.doesNotMatch(block, /querySelector|lastProfiles/);
});
