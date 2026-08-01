import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../../src/electron/preload.cjs', import.meta.url), 'utf8');
const renderer = readFileSync(new URL('../../src/electron/renderer/renderer.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../src/electron/renderer/index.html', import.meta.url), 'utf8');

test('统一运行策略只经具名 IPC 与固定 customer-auth 环境路径读写', () => {
  for (const channel of [
    'facebook-operation-policy:get',
    'facebook-operation-policy:set',
    'facebook-primary-surface:get',
    'facebook-primary-surface:set',
  ]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel}'`));
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel}'`));
  }
  const start = main.indexOf("ipcMain.handle('facebook-operation-policy:set'");
  const end = main.indexOf('// 旧规则模式 IPC', start);
  const block = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(block, /new Set\(\['envKey', 'expectedRevision', 'mode'\]\)/);
  assert.match(block, /new Set\(\['envKey'\]\)/);
  assert.match(block, /Number\.isInteger\(args\.expectedRevision\)/);
  assert.match(block, /\['persona', 'slow_start', 'rule', 'consumption'\]\.includes\(args\.mode\)/);
  assert.match(block, /`\/environments\/\$\{encodeURIComponent\(envKey\)\}\/facebook-operation-policy`/);
  assert.match(block, /body: \{ expectedRevision: args\.expectedRevision, mode: args\.mode \}/);
  assert.match(block, /facebook-primary-surface/);
  assert.match(block, /primarySurface: args\.primarySurface/);
  assert.doesNotMatch(
    block,
    /accountId|viewsPerLike|joinEveryNRounds|confirmedLikesPerJoin|confirmedJoinsPerComment/,
    'Edge 不得提交账号选择器或复制 Cloud 节奏数字',
  );
  assert.doesNotMatch(
    renderer,
    /\/environments\/[^'"`]*\/facebook-operation-policy/,
    'renderer 不得自行拼 customer-auth 路径',
  );
});

test('已建环境使用一个四选一模式和一个独立 Feed/Reels 选择', () => {
  const policy = html.indexOf('id="facebook-operation-policy-row"');
  const risk = html.indexOf('id="risk-recovery-row"');
  assert.ok(policy >= 0 && policy < risk);
  const block = html.slice(policy, risk);
  assert.match(block, /id="facebook-operation-mode-select"[\s\S]*value="persona"[\s\S]*value="slow_start"[\s\S]*value="rule"[\s\S]*value="consumption"/);
  assert.match(block, /id="facebook-primary-surface-select"[\s\S]*value="feed"[\s\S]*value="reels"/);

  const submitStart = renderer.indexOf('async function submitFacebookOperationMode');
  const submitEnd = renderer.indexOf('// 旧慢启动/规则写函数', submitStart);
  const submit = renderer.slice(submitStart, submitEnd);
  assert.ok(submitStart >= 0 && submitEnd > submitStart);
  assert.match(
    submit,
    /setFacebookOperationPolicy\(\{\s*envKey,\s*expectedRevision: http\.config\.policyRevision,\s*mode: requestedMode,/,
  );
  assert.match(submit, /normalizeFacebookOperationPolicyResponse\(res, envKey\)/);
  assert.match(submit, /selectedModeFromFacebookOperationPolicy\(config\) !== requestedMode/);
  assert.doesNotMatch(submit, /facebookOperationPolicyHttpByEnv\.delete\(envKey\)/);
  assert.doesNotMatch(
    submit,
    /setSlowStart|setFacebookRuleMode|localStorage|sessionStorage|viewsPerLike|confirmedLikesPerJoin/,
  );
});

test('已建环境写入期间只渲染最后确认态，目标模式只作为 pending 反馈', () => {
  const applyStart = renderer.indexOf('function applyFacebookOperationPolicyView');
  const applyEnd = renderer.indexOf('function renderFacebookOperationPolicy', applyStart);
  const apply = renderer.slice(applyStart, applyEnd);
  assert.ok(applyStart >= 0 && applyEnd > applyStart);
  assert.match(apply, /const selectedMode = selectedModeFromFacebookOperationPolicy\(config\)/);
  assert.doesNotMatch(apply, /pending\s*\?\s*pending\.mode/);
  assert.match(apply, /facebookOperationModeSelect\.value = selectedMode/);
  assert.match(apply, /facebookPrimarySurfaceSelect\.value = config\.primarySurface/);

  const fetchStart = renderer.indexOf('async function ensureFacebookOperationPolicyHttpFetch');
  const fetchEnd = renderer.indexOf('function facebookRuleModeError', fetchStart);
  const fetch = renderer.slice(fetchStart, fetchEnd);
  assert.match(fetch, /preserveConfirmed/);
  assert.match(fetch, /if \(next\.kind === 'ok' \|\| !retainExisting\)/);
});

test('创建环境四选一包含消费模式，主浏览入口默认 Reels 并独立提交', () => {
  const selectStart = html.indexOf('id="ads-fb-run-mode"');
  const selectEnd = html.indexOf('</select>', selectStart);
  const select = html.slice(selectStart, selectEnd);
  const normal = select.indexOf('value="normal"');
  const cold = select.indexOf('value="cold_start"');
  const rule = select.indexOf('value="rule"');
  const consumption = select.indexOf('value="consumption"');
  assert.ok(normal >= 0 && normal < cold && cold < rule && rule < consumption);
  const surfaceStart = html.indexOf('id="ads-fb-primary-surface"');
  const surfaceEnd = html.indexOf('</select>', surfaceStart);
  const surface = html.slice(surfaceStart, surfaceEnd);
  assert.match(surface, /value="reels" selected/);

  const finalizeStart = main.indexOf('async function finalizeCreatedEnvironmentAssignment');
  const finalizeEnd = main.indexOf('async function validateExistingClientSessionForStartup', finalizeStart);
  const finalize = main.slice(finalizeStart, finalizeEnd);
  assert.match(finalize, /facebookOperationMode: requestedOperationMode/);
  assert.match(finalize, /facebookPrimarySurface/);
  assert.match(finalize, /provisioningFacebookOperationPolicy\(response, envKey\)/);
  assert.match(finalize, /provisioningCommittedFacebookOperationPolicy\(response, envKey\)/);
  assert.match(finalize, /provisioningOperationModeMatches\(operationPolicy, requestedOperationMode\)/);
  assert.match(finalize, /provisioningPrimarySurfaceMatches\(operationPolicy, facebookPrimarySurface\)/);
  assert.doesNotMatch(
    finalize,
    /\{ slowStartEnabled: true \}|\{ facebookRuleModeEnabled: true \}|viewsPerLike|confirmedJoinsPerComment/,
  );
});

test('已提交 provisioning 的 current 真态恢复归属并加入本地 roster', () => {
  const recoveryStart = main.indexOf('async function finalizeCreatedEnvironmentFromCommittedCurrent');
  const finalizeStart = main.indexOf('async function finalizeCreatedEnvironmentAssignment');
  const recovery = main.slice(recoveryStart, finalizeStart);
  assert.ok(recoveryStart >= 0 && finalizeStart > recoveryStart);
  assert.match(recovery, /await refreshAllowedEnvironments\(\)/);
  assert.match(recovery, /allowedProfileIds\.add\(envKey\)/);
  assert.match(recovery, /addProvisionedEnvironmentToRoster\(result\)/);
  assert.match(recovery, /assignedToCurrentClient: true/);
  assert.match(recovery, /requiresAdminAssignment: false/);
  assert.match(recovery, /rosterJoinedByMain: true/);

  const finalizeEnd = main.indexOf('async function validateExistingClientSessionForStartup', finalizeStart);
  const finalize = main.slice(finalizeStart, finalizeEnd);
  assert.match(finalize, /provisioningCommittedFacebookOperationPolicy\(response, envKey\)/);
  assert.match(finalize, /operation_policy_refresh_unavailable|运行策略缓存刷新暂不可用/);
  assert.match(finalize, /configuredFlags\(operationModeConfirmed, primarySurfaceConfirmed, false\)/);
  assert.match(finalize, /finalizeCreatedEnvironmentFromCommittedCurrent\(/);
});
