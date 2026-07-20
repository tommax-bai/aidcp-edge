import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (relativePath: string) => readFileSync(join(here, '../../src/electron', relativePath), 'utf8');
const main = readSrc('main.cjs');
const preload = readSrc('preload.cjs');
const renderer = readSrc('renderer/renderer.js');

function handlerBlock(source: string, name: string): string {
  const start = source.indexOf(`ipcMain.handle('${name}'`);
  if (start < 0) return '';
  const next = source.indexOf('ipcMain.handle(', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

test('人工昵称只通过具名 IPC 写本地和收窄 Cloud endpoint，不暴露任意设置写能力', () => {
  assert.match(
    preload,
    /saveEnvironmentNickname:\s*\(args\)\s*=>\s*ipcRenderer\.invoke\('fleet:setManualNickname', args\)/,
  );
  const block = handlerBlock(main, 'fleet:setManualNickname');
  assert.ok(block, 'fleet:setManualNickname handler 必须存在');
  assert.match(block, /raw && raw\.profileId/);
  assert.match(block, /raw && raw\.nickname/);
  assert.match(block, /clientAuthFetch\(`\/environments\/\$\{encodeURIComponent\(profileId\)\}\/operator-alias`/);
  assert.match(block, /body: \{ alias: nickname \|\| null \}/, '空内容必须清除云端运营别名');
  assert.doesNotMatch(block, /raw.*accountId|saveSettings\(raw\)/, 'renderer 不得选择账号或提交任意设置');
});

test('主进程先本地 pending、再 Cloud 确认，任一步失败恢复原花名册', () => {
  const block = handlerBlock(main, 'fleet:setManualNickname');
  const saveAt = block.indexOf('saveSettings({ environments: nextEnvironments })');
  const cloudAt = block.indexOf('clientAuthFetch(`/environments/');
  const restoreAt = block.indexOf('saveSettings({ environments: previousEnvironments })', cloudAt);
  assert.ok(saveAt >= 0 && saveAt < cloudAt, '本地 pending 必须在第一次 Cloud await 前可见');
  assert.ok(cloudAt < restoreAt, 'Cloud 失败必须把本地花名册恢复到原快照');
  assert.match(block, /return \{ ok: false, error: saved\.error/);
  assert.match(block, /cloudRollback/);
  assert.match(block, /localRollback/);
  assert.match(block, /syncBrowserPersonaNotice\(renamedHandle, true\)/, '成功后浏览器内人设横幅也要立即刷新昵称');
  assert.match(block, /return \{ ok: true, environment: confirmedEnvironment \}/);
});

test('renderer 在昵称持久化前乐观显示，失败时恢复旧名称与来源', () => {
  const start = renderer.indexOf('function beginRailNameEdit');
  const end = renderer.indexOf('// 环境头像三态', start);
  const block = renderer.slice(start, end);
  assert.ok(block, '昵称编辑实现块必须存在');
  assert.ok(
    block.indexOf('manualNicknamePendingEnvIds.add') < block.indexOf('await window.aidcpEdge.saveEnvironmentNickname'),
    'pending 与乐观名称必须在第一次 await 前生效',
  );
  assert.match(block, /Object\.assign\(currentMember, previousMember\)/);
  assert.match(block, /delete currentMember\.nameSource/);
  assert.match(block, /昵称保存失败，已恢复/);
  assert.match(block, /nickname \? `正在保存人工昵称/);
  assert.match(block, /正在清除人工昵称并恢复系统昵称/);
  assert.doesNotMatch(block, /persistRoster\(/, '昵称不得再走失败后保留内存值的通用 settings 保存链');
});

test('旧人工昵称在客户会话恢复后有界补同步，失败保留本地并标明 unsynced', () => {
  const start = main.indexOf('function syncUnsyncedManualAliases');
  const end = main.indexOf('function createLoginWindow', start);
  const block = main.slice(start, end);
  assert.match(block, /nameSource === 'manual'/);
  assert.match(block, /nameSyncState !== 'synced'/);
  assert.match(block, /\.slice\(0, 20\)/, '单轮补同步数量必须有界');
  assert.match(block, /timeoutMs: 5000/, '每个 Cloud 请求必须有界');
  assert.match(block, /result\.response\.ok \? 'synced' : 'unsynced'/);
  assert.match(main, /syncEnvHandles\(\);\n\s*void syncUnsyncedManualAliases\(\);/);
});
