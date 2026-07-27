import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');
const start = mainSource.indexOf("ipcMain.handle('ads:createEnv'");
const end = mainSource.indexOf("ipcMain.handle('ads:updateEnvProxy'", start);
const createBlock = mainSource.slice(start, end);

test('ads:createEnv: Facebook 批量平台门禁与整批解析早于运行时/写客户端，环境创建不受运行容量限制', () => {
  assert.ok(start >= 0 && end > start, '应找到 ads:createEnv IPC 块');
  const platformGate = createBlock.indexOf("creationMode === 'batch' && platform !== 'facebook'");
  const plan = createBlock.indexOf('createFacebookBatchPlan({');
  const ensureRuntime = createBlock.indexOf('ensureAdsServiceOnce(null)');
  const writeClient = createBlock.indexOf('createAdsWriteApi(');
  assert.ok(platformGate >= 0 && platformGate < ensureRuntime, '非 Facebook 批量须在运行时探测前拒绝');
  assert.ok(plan >= 0 && plan < ensureRuntime, '整批账号/代理/操作系统计划须先形成');
  assert.equal(createBlock.includes('validateCreationCapacity('), false, '不得拿浏览器并发/启动排队限制环境创建');
  assert.equal(createBlock.includes('最大挂载账号数'), false, '创建路径不得保留旧的挂载硬上限');
  assert.ok(ensureRuntime < writeClient, '运行时就绪后才建立写客户端');
});

test('ads:createEnv: Facebook 单建与批量都请求慢启动，XHS/视频号不提交该概念', () => {
  assert.match(createBlock, /const slowStartEnabled = platform === 'facebook'/);
  assert.equal((createBlock.match(
    /finalizeCreatedEnvironmentAssignment\(result, intent, \{\s*slowStartEnabled,\s*proxyInput:/g,
  ) ?? []).length, 2, '无账号资料单建分支与账号导入/批量分支必须共用 Facebook 默认值');
  assert.match(mainSource, /\.\.\.\(slowStartEnabled \? \{ slowStartEnabled: true \} : \{\}\)/);
  assert.match(mainSource, /slowStartConfigured: finalized\.slowStartConfigured/);
  assert.match(createBlock, /created\.every\(\(item\) => item\.slowStartConfigured === true\)/);
});

test('ads:createEnv: 批量逐项使用计划中的随机 OS family 与轮询代理，并保留部分失败回执', () => {
  assert.match(createBlock, /osFamilyKey:\s*item\.osFamilyKey/);
  assert.match(createBlock, /accountImport:\s*item\.accountImport/);
  assert.match(createBlock, /proxy:\s*item\.proxy/);
  assert.match(createBlock, /failedFacebookBatchReceipt\(created, i \+ 1,/);
  assert.match(createBlock, /createdCount:\s*created\.length/);
  assert.match(createBlock, /creationMode === 'single' && created\.length === 1 \? created\[0\]\.userId/);
});
