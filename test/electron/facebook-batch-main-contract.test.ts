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

test('ads:createEnv: 运行方式与免审意图由归一门禁翻译，单建与批量共用同一份意图', () => {
  assert.doesNotMatch(
    createBlock,
    /const slowStartEnabled = platform === 'facebook'/,
    'Facebook 创建不得再写死慢启动意图',
  );
  assert.match(createBlock, /resolveFacebookCreationIntents\(\{ platform, opts \}\)/);
  assert.match(createBlock, /if \(!creationIntents\.ok\) return \{ ok: false, error: creationIntents\.error \}/);
  assert.equal((createBlock.match(
    /finalizeCreatedEnvironmentAssignment\(result, intent, \{\s*\.\.\.provisioningConfig,\s*proxyInput:/g,
  ) ?? []).length, 2, '无账号资料单建分支与账号导入/批量分支必须共用同一份归一意图');
  assert.match(mainSource, /\.\.\.\(requestedOperationMode \? \{ facebookOperationMode: requestedOperationMode \} : \{\}\)/);
  assert.doesNotMatch(
    mainSource.slice(
      mainSource.indexOf('async function finalizeCreatedEnvironmentAssignment'),
      mainSource.indexOf('async function validateExistingClientSessionForStartup'),
    ),
    /\{ slowStartEnabled: true \}|\{ facebookRuleModeEnabled: true \}/,
    '新创建链只能提交 unified operation mode，不能与旧布尔字段并写',
  );
  assert.match(mainSource, /\.\.\.\(autoApproveComments \? \{ commentApprovalMode: 'auto_approve_all' \} : \{\}\)/);
  assert.match(mainSource, /operationModeConfigured: finalized\.operationModeConfigured/);
  assert.match(mainSource, /slowStartConfigured: finalized\.slowStartConfigured/);
  assert.match(mainSource, /ruleModeConfigured: finalized\.ruleModeConfigured/);
  assert.match(mainSource, /consumptionModeConfigured: finalized\.consumptionModeConfigured/);
  assert.match(mainSource, /commentApprovalConfigured: finalized\.commentApprovalConfigured/);
  assert.match(createBlock, /created\.every\(\(item\) => item\[key\] === true\)/);
});

test('ads:createEnv: 平台与互斥门禁早于运行时探测与本地环境创建', () => {
  const intentGate = createBlock.indexOf('resolveFacebookCreationIntents(');
  const ensureRuntime = createBlock.indexOf('ensureAdsServiceOnce(null)');
  const firstIntentCall = createBlock.indexOf('createEnvironmentProvisioningIntent()');
  assert.ok(intentGate >= 0, '应有归一门禁');
  assert.ok(intentGate < ensureRuntime, '门禁须在指纹浏览器运行时探测前');
  assert.ok(intentGate < firstIntentCall, '门禁须在向云端申请归属意图前');
});

test('ads:createEnv: 批量逐项使用计划中的随机 OS family 与轮询代理，并保留部分失败回执', () => {
  assert.match(createBlock, /osFamilyKey:\s*item\.osFamilyKey/);
  assert.match(createBlock, /accountImport:\s*item\.accountImport/);
  assert.match(createBlock, /proxy:\s*item\.proxy/);
  assert.match(createBlock, /failedFacebookBatchReceipt\(created, i \+ 1,/);
  assert.match(createBlock, /createdCount:\s*created\.length/);
  assert.match(createBlock, /creationMode === 'single' && created\.length === 1 \? created\[0\]\.userId/);
});
