import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');
const start = mainSource.indexOf("ipcMain.handle('ads:createEnv'");
const end = mainSource.indexOf("ipcMain.handle('ads:updateEnvProxy'", start);
const createBlock = mainSource.slice(start, end);

test('ads:createEnv: Facebook 批量平台门禁、整批解析与容量检查均早于运行时/写客户端', () => {
  assert.ok(start >= 0 && end > start, '应找到 ads:createEnv IPC 块');
  const platformGate = createBlock.indexOf("creationMode === 'batch' && platform !== 'facebook'");
  const plan = createBlock.indexOf('createFacebookBatchPlan({');
  const capacity = createBlock.indexOf('validateCreationCapacity({ configured, accountCap, requested })');
  const ensureRuntime = createBlock.indexOf('ensureAdsServiceOnce(null)');
  const writeClient = createBlock.indexOf('createAdsWriteApi(');
  assert.ok(platformGate >= 0 && platformGate < ensureRuntime, '非 Facebook 批量须在运行时探测前拒绝');
  assert.ok(plan >= 0 && plan < ensureRuntime, '整批账号/代理/模板计划须先形成');
  assert.ok(capacity >= 0 && capacity < ensureRuntime, '整批容量须在第一条写入前校验');
  assert.ok(ensureRuntime < writeClient, '运行时就绪后才建立写客户端');
});

test('ads:createEnv: 批量逐项使用计划中的随机模板与轮询代理，并保留部分失败回执', () => {
  assert.match(createBlock, /templateKey:\s*item\.templateKey/);
  assert.match(createBlock, /accountImport:\s*item\.accountImport/);
  assert.match(createBlock, /proxy:\s*item\.proxy/);
  assert.match(createBlock, /failedFacebookBatchReceipt\(created, i \+ 1,/);
  assert.match(createBlock, /createdCount:\s*created\.length/);
  assert.match(createBlock, /creationMode === 'single' && created\.length === 1 \? created\[0\]\.userId/);
});
