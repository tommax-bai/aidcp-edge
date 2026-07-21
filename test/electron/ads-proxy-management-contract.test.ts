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
  const plan = block.indexOf('createProxyReassignmentPlan({');
  const scope = block.indexOf('await proxyTargetScope(');
  const active = block.indexOf('plan.plan.findIndex((item) => proxyTargetActive(item.userId))');
  const writeClient = block.indexOf('createAdsWriteApi({');
  const firstWrite = block.indexOf('updateProfileProxy({');
  assert.ok(plan >= 0 && plan < scope);
  assert.ok(scope < active && active < writeClient);
  assert.ok(writeClient < firstWrite);
  assert.match(block, /executeProxyReassignmentPlan\(\{/, '使用可单测的逐项串行执行器');
  assert.match(block, /return proxyReassignmentFailure\(/, '任一失败立即返回部分回执');
  assert.match(block, /batchProxyUpdateError\(result\)/, '外部 AdsPower msg 经批量安全原因收窄后才进回执');
  assert.doesNotMatch(block, /Promise\.all/, '批量代理不并发扩大写入面');
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

test('renderer 以 Set 的勾选顺序提交明确 ID，不从 DOM 或重排后列表重建目标', () => {
  const start = renderer.indexOf('function selectedBatchProxyIds()');
  const end = renderer.indexOf('function setBatchProxyMsg', start);
  const block = renderer.slice(start, end);
  assert.match(block, /Array\.from\(batchProxySelectedIds\)/);
  assert.doesNotMatch(block, /querySelector|lastProfiles/);
});
