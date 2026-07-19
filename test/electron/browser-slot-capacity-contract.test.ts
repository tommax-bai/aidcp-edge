import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../../src/electron/main.cjs', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../../src/electron/renderer/renderer.js', import.meta.url), 'utf8');
const rendererHtml = readFileSync(new URL('../../src/electron/renderer/index.html', import.meta.url), 'utf8');

test('内存自动推算只在 Edge 外壳启动时采样一次，任务准入不再重读内存', () => {
  assert.equal(
    (mainSource.match(/fleet\.usableMemoryBytes\(\)/g) ?? []).length,
    1,
    '主进程只能在 STARTUP_USABLE_MEMORY_BYTES 初始化时读取一次可用内存',
  );
  assert.match(mainSource, /const STARTUP_USABLE_MEMORY_BYTES = fleet\.usableMemoryBytes\(\)/);

  const start = mainSource.indexOf('function admitBrowserSlot(');
  const end = mainSource.indexOf('// ── 等槽位队列', start);
  assert.ok(start >= 0 && end > start, '应找到浏览器执行准入函数');
  const block = mainSource.slice(start, end);
  assert.equal(block.includes('usableMemoryBytes'), false);
  assert.equal(block.includes('availableMemoryBytes'), false);
  assert.equal(block.includes('ramAdmission'), false);
  assert.match(block, /occupiedSlots\(\)/);
  assert.match(block, /slotCapacity\(\)/);
});

test('第二个设置是启动排队上限，且环境创建数量不参与容量判断', () => {
  assert.match(rendererHtml, /启动排队上限/);
  assert.doesNotMatch(rendererHtml, /最多挂载账号数/);
  assert.match(rendererSource, /maxQueuedStartLimit/);
  assert.doesNotMatch(rendererSource, /maxAccounts|账号上限/);

  const start = mainSource.indexOf("ipcMain.handle('ads:createEnv'");
  const end = mainSource.indexOf("ipcMain.handle('ads:updateEnvProxy'", start);
  assert.ok(start >= 0 && end > start, '应找到环境创建 IPC 块');
  const createBlock = mainSource.slice(start, end);
  assert.doesNotMatch(createBlock, /maxQueuedStarts|maxAccounts|validateCreationCapacity|挂载名额/);
});

