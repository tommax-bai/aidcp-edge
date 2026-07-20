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

test('人工昵称只通过具名本地 IPC 保存，不暴露 Cloud 或任意设置写能力', () => {
  assert.match(
    preload,
    /saveEnvironmentNickname:\s*\(args\)\s*=>\s*ipcRenderer\.invoke\('fleet:setManualNickname', args\)/,
  );
  const block = handlerBlock(main, 'fleet:setManualNickname');
  assert.ok(block, 'fleet:setManualNickname handler 必须存在');
  assert.match(block, /raw && raw\.profileId/);
  assert.match(block, /raw && raw\.nickname/);
  assert.doesNotMatch(block, /clientAuthFetch|fetch\(|https?:\/\//, '人工昵称是 Edge 本地花名册字段，不伪装成云端更新');
});

test('主进程昵称保存失败恢复旧 settings，成功后才同步 handle 与 fleet', () => {
  const block = handlerBlock(main, 'fleet:setManualNickname');
  const snapshotAt = block.indexOf('const previousSettings = settings');
  const saveAt = block.indexOf('saveSettings({ environments: nextEnvironments })');
  const failureAt = block.indexOf('if (!saved.ok)');
  const restoreAt = block.indexOf('settings = previousSettings');
  const syncAt = block.indexOf('syncEnvHandles()');
  assert.ok(snapshotAt >= 0 && snapshotAt < saveAt, '写入前必须保留旧 settings');
  assert.ok(saveAt < failureAt && failureAt < restoreAt, '写盘失败分支必须恢复旧 settings');
  assert.ok(restoreAt < syncAt, 'handle/fleet 同步只能发生在失败回滚分支之后的成功路径');
  assert.match(block, /return \{ ok: false, error: saved\.error/);
  assert.match(block, /syncBrowserPersonaNotice\(renamedHandle, true\)/, '成功后浏览器内人设横幅也要立即刷新昵称');
  assert.match(block, /return \{ ok: true, environment: nextEnvironment \}/);
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
  assert.match(block, /currentMember\.name = previousName/);
  assert.match(block, /delete currentMember\.nameSource/);
  assert.match(block, /人工昵称保存失败，已恢复/);
  assert.doesNotMatch(block, /persistRoster\(/, '昵称不得再走失败后保留内存值的通用 settings 保存链');
});
